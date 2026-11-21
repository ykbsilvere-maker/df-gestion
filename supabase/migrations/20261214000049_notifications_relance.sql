-- v3.22 — Notifications Telegram fiables : chaque message est gardé et renvoyé s'il n'est pas parti.
-- Constat (21/11, W-000037) : l'appel au robot a expiré pendant la connexion à Telegram (« handshake », 8 s) ;
-- pg_net ne réessaie pas, la gérante n'a donc rien reçu. Désormais : délai de 15 s, et une tâche planifiée
-- (chaque minute) renvoie les messages non partis, jusqu'à 5 essais. Personne n'a besoin d'être connecté.

create table if not exists prive.notifications_envoi (
  id              bigserial primary key,
  organisation_id uuid not null,
  user_id         uuid not null,
  chat_id         bigint not null,
  texte           text not null,
  requete         bigint,
  essais          smallint not null default 0,
  statut          text not null default 'envoi' check (statut in ('envoi', 'ok', 'echec')),
  erreur          text,
  cree_le         timestamptz not null default now(),
  maj_le          timestamptz not null default now()
);
create index if not exists notifications_envoi_attente on prive.notifications_envoi (statut, maj_le) where statut = 'envoi';
revoke all on table prive.notifications_envoi from public, anon, authenticated;

-- Un essai d'envoi (appel asynchrone : la réponse est lue plus tard par prive.relancer_notifications).
create or replace function prive.envoyer_notification(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  n prive.notifications_envoi;
  r prive.telegram_robot;
  v_req bigint;
begin
  select * into n from prive.notifications_envoi where id = p_id;
  select * into r from prive.telegram_robot;
  if n.id is null or r.jeton is null then return; end if;
  begin
    execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 15000)'
      into v_req
      using 'https://api.telegram.org/bot' || r.jeton || '/sendMessage',
            jsonb_build_object('chat_id', n.chat_id, 'text', n.texte, 'disable_web_page_preview', true),
            jsonb_build_object('Content-Type', 'application/json');
  exception when others then
    v_req := null;
  end;
  update prive.notifications_envoi set requete = v_req, essais = essais + 1, maj_le = now() where id = p_id;
end $$;

create or replace function prive.notifier(p_org uuid, p_user uuid, p_texte text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r prive.telegram_robot;
  o prive.otp_membres;
  a prive.alertes_whatsapp;
  v_id bigint;
begin
  if p_user is null then return; end if;
  select * into r from prive.telegram_robot;
  select * into o from prive.otp_membres where organisation_id = p_org and user_id = p_user and actif and chat_id is not null;
  if r.jeton is not null and o.chat_id is not null then
    insert into prive.notifications_envoi (organisation_id, user_id, chat_id, texte)
    values (p_org, p_user, o.chat_id, p_texte) returning id into v_id;
    perform prive.envoyer_notification(v_id);
    return;
  end if;
  select * into a from prive.alertes_whatsapp where organisation_id = p_org and user_id = p_user and actif;
  if found then perform prive.envoyer_alerte(a, p_texte); end if;
end $$;

-- Lue chaque minute : messages partis (ok), à renvoyer, ou abandonnés après 5 essais.
create or replace function prive.relancer_notifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n prive.notifications_envoi;
  v_statut int;
  v_err text;
  v_vu boolean;
  v_relances int := 0;
begin
  for n in select * from prive.notifications_envoi where statut = 'envoi' and maj_le < now() - interval '20 seconds'
            order by id limit 200 for update skip locked
  loop
    v_statut := null; v_err := null; v_vu := false;
    if n.requete is not null then
      begin
        execute 'select true, status_code, error_msg from net._http_response where id = $1' into v_vu, v_statut, v_err using n.requete;
      exception when others then v_vu := false;
      end;
    end if;
    if coalesce(v_vu, false) and v_statut = 200 then
      update prive.notifications_envoi set statut = 'ok', erreur = null, maj_le = now() where id = n.id;
    elsif coalesce(v_vu, false) and v_statut between 400 and 499 and v_statut <> 429 then
      -- Refus définitif de Telegram (ex. la personne a bloqué le robot) : inutile d'insister.
      update prive.notifications_envoi set statut = 'echec', erreur = 'HTTP ' || v_statut, maj_le = now() where id = n.id;
    elsif not coalesce(v_vu, false) and n.requete is not null and n.maj_le > now() - interval '2 minutes' then
      null; -- réponse pas encore arrivée : on attend
    elsif n.essais >= 5 then
      update prive.notifications_envoi set statut = 'echec', erreur = coalesce(v_err, 'HTTP ' || v_statut, 'sans réponse'), maj_le = now() where id = n.id;
    else
      update prive.notifications_envoi set erreur = coalesce(v_err, 'HTTP ' || v_statut, 'sans réponse') where id = n.id;
      perform prive.envoyer_notification(n.id);
      v_relances := v_relances + 1;
    end if;
  end loop;
  delete from prive.notifications_envoi where cree_le < now() - interval '14 days';
  return v_relances;
end $$;

-- Tâche planifiée chaque minute (extension pg_cron de Supabase).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    execute $c$select cron.schedule('dfg-relance-telegram', '* * * * *', 'select prive.relancer_notifications()')$c$;
  end if;
exception when others then
  raise warning 'Tâche planifiée non créée : %', sqlerrm;
end $$;
