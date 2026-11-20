-- v3.19 — Tout passe par le robot Telegram « DF Gestion »
-- * Les notifications des commandes en ligne (nouvelle commande, affectation, acceptée, prête,
--   en livraison, livrée/encaissée, annulée) arrivent sur le même Telegram que les codes OTP.
--   Sans Telegram relié au robot, l'ancienne alerte (CallMeBot) reste utilisée si elle existe.
-- * Un Telegram peut être relié « pour les notifications seulement », sans code OTP (caissières).
-- * Les commandes en ligne ne s'affectent qu'aux caissiers (ni la gérante principale, ni les autres rôles).
-- * « en caisse » : une caisse ouverte par la gérante POUR une caissière compte comme la caisse de la caissière.

-- ---------------------------------------------------------------- Telegram sans code OTP
alter table prive.otp_membres add column if not exists otp boolean not null default true;

create or replace function prive.otp_exige(p_org uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from prive.otp_membres where organisation_id = p_org and user_id = p_user and actif and otp
                   and (chat_id is not null or telegram is not null))
$$;

drop function if exists public.otp_lien(uuid, uuid, text);
create function public.otp_lien(p_org uuid, p_user uuid default null, p_email text default null, p_otp boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r prive.telegram_robot;
  v_code text := replace(gen_random_uuid()::text, '-', '');
begin
  p_user := prive.otp_cible(p_org, p_user, p_email);
  select * into r from prive.telegram_robot;
  perform prive.exiger(r.nom_utilisateur is not null, 'Le robot Telegram n''est pas encore configuré (Administration)');
  insert into prive.otp_membres (organisation_id, user_id, actif, otp, modifie_par, liaison_code, liaison_expire)
  values (p_org, p_user, true, coalesce(p_otp, true), auth.uid(), v_code, now() + interval '7 days')
  on conflict (organisation_id, user_id) do update
    set liaison_code = excluded.liaison_code, liaison_expire = excluded.liaison_expire, actif = true, otp = excluded.otp,
        modifie_par = auth.uid(), modifie_le = now();
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), 'otp.lien_cree', 'membres', p_user::text,
          jsonb_build_object('nom', prive.nom_de(p_user), 'otp', coalesce(p_otp, true)));
  return jsonb_build_object('lien', 'https://t.me/' || r.nom_utilisateur || '?start=' || v_code, 'robot', '@' || r.nom_utilisateur,
                            'expire_le', now() + interval '7 days');
end $$;
revoke all on function public.otp_lien(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.otp_lien(uuid, uuid, text, boolean) to authenticated;

-- Garder le Telegram relié mais activer / retirer seulement le code OTP.
create or replace function public.otp_basculer(p_org uuid, p_user uuid, p_otp boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  p_user := prive.otp_cible(p_org, p_user, null);
  update prive.otp_membres set otp = coalesce(p_otp, true), modifie_par = auth.uid(), modifie_le = now()
   where organisation_id = p_org and user_id = p_user;
  perform prive.exiger(found, 'Aucun Telegram relié pour cette personne');
  if p_otp and p_user = auth.uid() and prive.session_courante() is not null then
    insert into prive.sessions_otp (session_id, organisation_id, user_id, via)
    values (prive.session_courante(), p_org, auth.uid(), 'activation')
    on conflict (session_id, organisation_id) do update set verifie_le = now(), vu_le = now(), via = excluded.via;
  end if;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), case when p_otp then 'otp.configure' else 'otp.desactive' end, 'membres', p_user::text,
          jsonb_build_object('nom', prive.nom_de(p_user), 'notifications', true));
  return public.otp_liste(p_org);
end $$;
revoke all on function public.otp_basculer(uuid, uuid, boolean) from public, anon;
grant execute on function public.otp_basculer(uuid, uuid, boolean) to authenticated;

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
            'actif', o.actif and o.otp and (o.chat_id is not null or o.telegram is not null),
            'otp', o.otp, 'notifications', o.actif and o.chat_id is not null,
            'en_attente_liaison', o.chat_id is null and o.telegram is null and o.liaison_code is not null and o.liaison_expire > now(),
            'modifie_le', o.modifie_le, 'email', lower(u.email)))
          from prive.otp_membres o join auth.users u on u.id = o.user_id where o.organisation_id = p_org), '{}'::jsonb);
end $$;

-- ---------------------------------------------------------------- Envoi d'une notification
-- Par le robot si la personne y est reliée, sinon par son alerte CallMeBot si elle en a une.
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
begin
  if p_user is null then return; end if;
  select * into r from prive.telegram_robot;
  select * into o from prive.otp_membres where organisation_id = p_org and user_id = p_user and actif and chat_id is not null;
  if r.jeton is not null and o.chat_id is not null then
    begin
      execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 8000)'
        using 'https://api.telegram.org/bot' || r.jeton || '/sendMessage',
              jsonb_build_object('chat_id', o.chat_id, 'text', p_texte, 'disable_web_page_preview', true),
              jsonb_build_object('Content-Type', 'application/json');
    exception when others then
      raise warning 'Robot Telegram : %', sqlerrm;
    end;
    return;
  end if;
  select * into a from prive.alertes_whatsapp where organisation_id = p_org and user_id = p_user and actif;
  if found then perform prive.envoyer_alerte(a, p_texte); end if;
end $$;

-- ---------------------------------------------------------------- Notifications des commandes
create or replace function prive.alerter_commande_web()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.commandes_web;
  u uuid;
  v_txt text;
  v_qui text;
begin
  select * into c from public.commandes_web where id = new.id;
  if not found then return null; end if;

  if tg_op = 'INSERT' then
    for u in
      select m.user_id from public.membres m
       where m.organisation_id = new.organisation_id and m.actif
         and (prive.permission_du_membre(m, 'boutique.administrer') or prive.permission_du_membre(m, 'boutique.affecter'))
    loop
      perform prive.notifier(new.organisation_id, u,
        '🛍️ Nouvelle commande en ligne : ' || prive.texte_commande(c) || E'\nOuvrez DF Gestion pour l''affecter à une caissière.');
    end loop;
    return null;
  end if;

  -- Affectation : la caissière choisie.
  if new.caissier_id is not null and new.caissier_id is distinct from old.caissier_id then
    perform prive.notifier(new.organisation_id, new.caissier_id,
      '🧺 Commande affectée à vous : ' || prive.texte_commande(c) || E'\nOuvrez DF Gestion et touchez « Accepter », puis rassemblez les articles.');
  end if;

  -- Suivi pour la gérante principale (et la personne qui a affecté) : chaque étape.
  v_qui := coalesce(prive.nom_de(new.caissier_id), 'La caissière');
  v_txt := null;
  if new.prise_en_charge_le is not null and old.prise_en_charge_le is null then
    v_txt := '✅ ' || v_qui || ' a accepté la commande ' || c.numero || '.';
  end if;
  if new.statut is distinct from old.statut then
    v_txt := case new.statut
      when 'prete' then '📦 Commande prête : ' || prive.texte_commande(c)
                        || case when new.mode = 'livraison' then E'\nConfirmez l''envoi dans DF Gestion.' else E'\nLe client peut venir la retirer.' end
      when 'en_livraison' then '🛵 Commande partie en livraison : ' || c.numero || '.'
      when 'livree' then '🎉 Commande ' || c.numero || case when new.mode = 'livraison' then ' livrée' else ' remise au client' end
                         || ' et encaissée (' || replace(to_char(c.total, 'FM999G999G999'), ',', ' ') || ' FCFA).'
      when 'annulee' then '❌ Commande ' || c.numero || ' annulée' || coalesce(' : ' || nullif(btrim(c.motif), ''), '') || '.'
      else v_txt end;
  end if;
  if v_txt is not null then
    for u in
      select distinct x.user_id from (
        select m.user_id from public.membres m
         where m.organisation_id = new.organisation_id and m.actif and prive.permission_du_membre(m, 'boutique.administrer')
        union select new.affectee_par) x
       where x.user_id is not null and x.user_id is distinct from auth.uid() and x.user_id is distinct from new.caissier_id
    loop
      perform prive.notifier(new.organisation_id, u, v_txt);
    end loop;
  end if;
  return null;
end $$;

drop trigger if exists commandes_web_alerte_affectation on public.commandes_web;
drop trigger if exists commandes_web_alerte_prete on public.commandes_web;
drop trigger if exists commandes_web_alerte_suivi on public.commandes_web;
create trigger commandes_web_alerte_suivi after update of statut, caissier_id, prise_en_charge_le on public.commandes_web
  for each row execute function prive.alerter_commande_web();

-- ---------------------------------------------------------------- Affecter seulement aux caissiers
create or replace function public.caissiers_commande(p_org uuid, p_magasin uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform prive.exiger(prive.peut_affecter(p_org), 'Droit « boutique.valider » requis');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', m.user_id, 'nom', coalesce(nullif(btrim(pr.nom_complet), ''), pr.email, 'Membre'), 'role', m.role_code,
             'en_caisse', exists (select 1 from public.sessions_caisse s where s.organisation_id = p_org and s.magasin_id = p_magasin
                                    and s.statut = 'ouverte' and coalesce(s.caissier_id, s.ouverte_par) = m.user_id),
             'en_cours', (select count(*) from public.commandes_web c where c.organisation_id = p_org and c.caissier_id = m.user_id
                            and c.vente_id is null and c.statut not in ('livree','annulee')))
           order by 4 desc, 2)
      from public.membres m left join public.profils pr on pr.id = m.user_id
     where m.organisation_id = p_org and m.actif and m.role_code in ('caissier', 'responsable_caisse')
       and prive.peut_encaisser_magasin(p_org, m.user_id, p_magasin)), '[]'::jsonb);
end $$;

do $$
declare d text;
begin
  d := pg_get_functiondef('public.affecter_commande_web(uuid,uuid)'::regprocedure);
  if position('seulement aux caissiers' in d) = 0 then
    d := replace(d, $r$'Cette personne ne peut pas encaisser dans ce magasin');$r$,
      $r$'Cette personne ne peut pas encaisser dans ce magasin');
  perform prive.exiger(p_caissier is null or exists (select 1 from public.membres m where m.organisation_id = c.organisation_id
                         and m.user_id = p_caissier and m.actif and m.role_code in ('caissier', 'responsable_caisse')),
                       'Les commandes s''affectent seulement aux caissiers');$r$);
    if position('seulement aux caissiers' in d) = 0 then raise exception 'affecter_commande_web : ancre introuvable'; end if;
    execute d;
  end if;
end $$;
