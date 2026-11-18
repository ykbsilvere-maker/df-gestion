-- v3.16 — Robot Telegram « DF Gestion » (nom et logo personnalisés) et OTP après 2 h d'inactivité.
--
-- * L'administrateur crée son robot avec @BotFather et colle le jeton dans Administration : il est
--   gardé ici, côté serveur, et n'est JAMAIS renvoyé à un écran. La fonction « telegram » règle le nom,
--   la description, le logo et le webhook du robot.
-- * Chaque personne reçoit un lien d'activation (t.me/<robot>?start=<code>) : en touchant « Démarrer »,
--   son Telegram est relié (chat_id) et c'est le robot DF Gestion qui lui envoie ses codes OTP.
-- * Une connexion validée par OTP se referme après 2 heures sans activité : un nouveau code est demandé.

create table if not exists prive.telegram_robot (
  id boolean primary key default true check (id),
  jeton text not null,
  nom_utilisateur text not null,
  nom text,
  secret text not null,
  configure_par uuid,
  configure_le timestamptz not null default now()
);

alter table prive.otp_membres alter column telegram drop not null;
alter table prive.otp_membres add column if not exists chat_id bigint;
alter table prive.otp_membres add column if not exists nom_telegram text;
alter table prive.otp_membres add column if not exists liaison_code text;
alter table prive.otp_membres add column if not exists liaison_expire timestamptz;
create unique index if not exists otp_membres_liaison on prive.otp_membres (liaison_code) where liaison_code is not null;

alter table prive.sessions_otp add column if not exists vu_le timestamptz not null default now();

-- Le code n'est exigé que si la personne a un moyen de le recevoir (Telegram relié ou nom CallMeBot).
create or replace function prive.otp_exige(p_org uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from prive.otp_membres where organisation_id = p_org and user_id = p_user and actif
                   and (chat_id is not null or telegram is not null))
$$;

-- Session ouverte par OTP : valable tant qu'il y a de l'activité (2 heures sans activité = nouveau code).
create or replace function prive.session_otp_ok(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from prive.sessions_otp where session_id = prive.session_courante()
                  and organisation_id = p_org and user_id = auth.uid() and vu_le > now() - interval '2 hours')
$$;

-- Signe de vie de l'application (toutes les quelques minutes quand la personne travaille).
create or replace function public.otp_activite(p_org uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  update prive.sessions_otp set vu_le = now()
   where session_id = prive.session_courante() and organisation_id = p_org and user_id = auth.uid()
     and vu_le > now() - interval '2 hours'
  returning true
$$;

-- Envoi du message : par le robot DF Gestion si la personne est reliée, sinon par CallMeBot.
create or replace function prive.envoyer_code(o prive.otp_membres, p_texte_html text, p_texte_brut text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  r prive.telegram_robot;
  i bigint;
begin
  select * into r from prive.telegram_robot;
  if r.jeton is not null and o.chat_id is not null then
    begin
      execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 8000)' into i
        using 'https://api.telegram.org/bot' || r.jeton || '/sendMessage',
              jsonb_build_object('chat_id', o.chat_id, 'text', p_texte_html, 'parse_mode', 'HTML'),
              jsonb_build_object('Content-Type', 'application/json');
      return i;
    exception when others then
      raise warning 'Robot Telegram : %', sqlerrm;
      return null;
    end;
  end if;
  if o.telegram is not null then return prive.envoyer_telegram(o.telegram, p_texte_brut); end if;
  return null;
end $$;

create or replace function public.otp_envoyer(p_org uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o prive.otp_membres;
  b bytea := uuid_send(gen_random_uuid());
  v_code text;
  v_req bigint;
  s uuid := prive.session_courante();
begin
  select * into o from prive.otp_membres where organisation_id = p_org and user_id = auth.uid() and actif
     and (chat_id is not null or telegram is not null);
  perform prive.exiger(o.user_id is not null, 'Aucun code OTP n''est demandé pour ce compte');
  perform prive.exiger(s is not null, 'Session inconnue : reconnectez-vous');
  if prive.session_otp_ok(p_org) then return jsonb_build_object('statut', 'verifie'); end if;
  perform prive.exiger(not exists (select 1 from prive.otp_codes where user_id = auth.uid() and envoye_le > now() - interval '30 seconds'),
                       'Patientez 30 secondes avant de demander un nouveau code');
  perform prive.exiger((select count(*) from prive.otp_codes where user_id = auth.uid() and envoye_le > now() - interval '15 minutes') < 5,
                       'Trop de codes demandés : réessayez dans un quart d''heure');
  v_code := lpad(((((get_byte(b, 0)::bigint << 24) | (get_byte(b, 1) << 16) | (get_byte(b, 2) << 8) | get_byte(b, 3)) % 1000000))::text, 6, '0');
  v_req := prive.envoyer_code(o,
    '🔐 <b>Code OTP : ' || left(v_code, 3) || ' ' || right(v_code, 3) || E'</b>\nValable 2 minutes. Ne le communiquez à personne.',
    '🔐 DF Gestion — code OTP : ' || left(v_code, 3) || ' ' || right(v_code, 3) || E'\nValable 2 minutes. Ne le communiquez à personne.');
  insert into prive.otp_codes (organisation_id, user_id, session_id, code_hash, expire_le, requete)
  values (p_org, auth.uid(), s, prive.hash_jeton(s::text || ':' || v_code), now() + interval '2 minutes', v_req);
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), 'otp.envoye', 'membres', auth.uid()::text,
          jsonb_build_object('nom', prive.nom_de(auth.uid()), 'telegram', coalesce(o.nom_telegram, prive.masquer_telegram(o.telegram)),
                             'canal', case when o.chat_id is not null then 'robot' else 'callmebot' end));
  return jsonb_build_object('statut', 'envoye', 'expire_le', now() + interval '2 minutes', 'envoi_ok', v_req is not null);
end $$;

-- Vérification : la session est ouverte et son activité démarre.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.otp_verifier(uuid,text)'::regprocedure);
  if position('vu_le = now()' in d) = 0 then
    d := replace(d, 'on conflict (session_id, organisation_id) do update set verifie_le = now(), via = excluded.via;',
                    'on conflict (session_id, organisation_id) do update set verifie_le = now(), vu_le = now(), via = excluded.via;');
    execute d;
  end if;
  d := pg_get_functiondef('public.otp_autoriser(uuid)'::regprocedure);
  if position('vu_le = now()' in d) = 0 then
    d := replace(d, 'on conflict (session_id, organisation_id) do update set verifie_le = now(), via = excluded.via;',
                    'on conflict (session_id, organisation_id) do update set verifie_le = now(), vu_le = now(), via = excluded.via;');
    execute d;
  end if;
  d := pg_get_functiondef('public.otp_configurer(uuid,uuid,text,boolean,text)'::regprocedure);
  if position('vu_le = now()' in d) = 0 then
    d := replace(d, 'on conflict (session_id, organisation_id) do update set verifie_le = now(), via = excluded.via;',
                    'on conflict (session_id, organisation_id) do update set verifie_le = now(), vu_le = now(), via = excluded.via;');
    execute d;
  end if;
end $$;

-- État pour l'écran de saisie (sans détail du canal).
create or replace function public.otp_etat(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c prive.otp_codes;
  r jsonb;
begin
  if not prive.otp_exige(p_org, auth.uid()) then return jsonb_build_object('exige', false); end if;
  if prive.session_otp_ok(p_org) then return jsonb_build_object('exige', true, 'verifie', true); end if;
  select * into c from prive.otp_codes where session_id = prive.session_courante() and organisation_id = p_org
   order by envoye_le desc limit 1;
  if c.requete is not null then
    begin
      execute 'select jsonb_build_object(''recu'', true, ''statut'', status_code, ''erreur'', error_msg,
                 ''texte'', left(btrim(regexp_replace(regexp_replace(coalesce(content, ''''), ''<[^>]*>'', '' '', ''g''), ''\s+'', '' '', ''g'')), 200))
                 from net._http_response where id = $1' into r using c.requete;
    exception when others then r := null;
    end;
  end if;
  return jsonb_build_object('exige', true, 'verifie', false, 'envoye_le', c.envoye_le, 'expire_le', c.expire_le, 'envoi', r);
end $$;

-- La gérante (ou l'administrateur) crée le lien d'activation Telegram d'une personne.
create or replace function public.otp_lien(p_org uuid, p_user uuid default null, p_email text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r prive.telegram_robot;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_code text := replace(gen_random_uuid()::text, '-', '');
begin
  perform prive.exiger(prive.peut_approuver(p_org), 'Réservé à la gérante principale');
  select * into r from prive.telegram_robot;
  perform prive.exiger(r.nom_utilisateur is not null, 'Le robot Telegram n''est pas encore configuré (Administration)');
  if p_user is null and v_email <> '' then
    select id into p_user from auth.users where lower(email) = v_email;
    perform prive.exiger(p_user is not null and exists (select 1 from public.invitations i where i.organisation_id = p_org
                           and lower(i.email) = v_email and i.statut = 'en_attente'), 'Accès introuvable pour cette adresse');
  else
    perform prive.exiger(exists (select 1 from public.membres where organisation_id = p_org and user_id = p_user and actif), 'Membre introuvable');
  end if;
  insert into prive.otp_membres (organisation_id, user_id, actif, modifie_par, liaison_code, liaison_expire)
  values (p_org, p_user, true, auth.uid(), v_code, now() + interval '7 days')
  on conflict (organisation_id, user_id) do update
    set liaison_code = excluded.liaison_code, liaison_expire = excluded.liaison_expire, actif = true,
        modifie_par = auth.uid(), modifie_le = now();
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), 'otp.lien_cree', 'membres', p_user::text, jsonb_build_object('nom', prive.nom_de(p_user)));
  return jsonb_build_object('lien', 'https://t.me/' || r.nom_utilisateur || '?start=' || v_code, 'robot', '@' || r.nom_utilisateur,
                            'expire_le', now() + interval '7 days');
end $$;

create or replace function public.otp_liste(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform prive.exiger(prive.peut_approuver(p_org), 'Réservé à la gérante principale');
  return coalesce((select jsonb_object_agg(o.user_id, jsonb_build_object(
            'telegram', coalesce(o.nom_telegram, o.telegram), 'relie', o.chat_id is not null or o.telegram is not null,
            'actif', o.actif and (o.chat_id is not null or o.telegram is not null),
            'en_attente_liaison', o.chat_id is null and o.telegram is null and o.liaison_code is not null and o.liaison_expire > now(),
            'modifie_le', o.modifie_le))
          from prive.otp_membres o where o.organisation_id = p_org), '{}'::jsonb);
end $$;

-- Robot : état visible par la gérante et l'administrateur (jamais le jeton).
create or replace function public.telegram_robot_etat()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select jsonb_build_object('configure', true, 'robot', '@' || nom_utilisateur, 'nom', nom, 'le', configure_le)
                     from prive.telegram_robot), jsonb_build_object('configure', false))
$$;

-- Réservés à la fonction serveur « telegram » (clé de service).
create or replace function public.telegram_robot_enregistrer(p_jeton text, p_nom_utilisateur text, p_nom text, p_secret text, p_par uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into prive.telegram_robot (id, jeton, nom_utilisateur, nom, secret, configure_par)
  values (true, p_jeton, p_nom_utilisateur, p_nom, p_secret, p_par)
  on conflict (id) do update set jeton = excluded.jeton, nom_utilisateur = excluded.nom_utilisateur, nom = excluded.nom,
                                secret = excluded.secret, configure_par = excluded.configure_par, configure_le = now();
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (null, p_par, 'otp.robot_configure', 'plateforme', 'telegram', jsonb_build_object('robot', '@' || p_nom_utilisateur, 'nom', p_nom));
end $$;

create or replace function public.telegram_robot_interne()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('jeton', jeton, 'secret', secret, 'nom', nom, 'robot', nom_utilisateur) from prive.telegram_robot
$$;

create or replace function public.telegram_est_admin(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select exists (select 1 from prive.admins_generaux where user_id = p_user) $$;

-- « /start <code> » reçu par le robot : relie ce Telegram à la personne.
create or replace function public.telegram_relier(p_code text, p_chat_id bigint, p_nom_telegram text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare o prive.otp_membres;
begin
  select * into o from prive.otp_membres where liaison_code = p_code and liaison_expire > now() for update;
  if o.user_id is null then return jsonb_build_object('ok', false); end if;
  update prive.otp_membres
     set chat_id = p_chat_id, nom_telegram = left(nullif(btrim(p_nom_telegram), ''), 64), liaison_code = null, liaison_expire = null,
         actif = true, modifie_le = now()
   where organisation_id = o.organisation_id and user_id = o.user_id;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (o.organisation_id, o.user_id, 'otp.telegram_relie', 'membres', o.user_id::text,
          jsonb_build_object('nom', prive.nom_de(o.user_id), 'telegram', p_nom_telegram));
  return jsonb_build_object('ok', true, 'nom', prive.nom_de(o.user_id),
                            'entreprise', (select nom from public.organisations where id = o.organisation_id));
end $$;

revoke execute on function public.telegram_robot_enregistrer(text, text, text, text, uuid), public.telegram_robot_interne(),
  public.telegram_est_admin(uuid), public.telegram_relier(text, bigint, text) from public, anon, authenticated;
grant execute on function public.telegram_robot_enregistrer(text, text, text, text, uuid), public.telegram_robot_interne(),
  public.telegram_est_admin(uuid), public.telegram_relier(text, bigint, text) to service_role;
revoke execute on function public.otp_activite(uuid), public.otp_lien(uuid, uuid, text), public.telegram_robot_etat() from public, anon;
grant execute on function public.otp_activite(uuid), public.otp_lien(uuid, uuid, text), public.telegram_robot_etat() to authenticated;
