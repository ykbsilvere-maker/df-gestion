-- v3.18 — Sécurité des accès
-- * Code OTP : une connexion se referme après 4 heures sans activité ; la personne ressaisit ses
--   accès (identifiant + mot de passe, ou code d'entrée) puis le code OTP reçu sur Telegram.
-- * Le code OTP du gérant principal n'est activé, changé ou retiré que par l'administrateur général ;
--   celui des employés reste géré par la gérante principale.
-- * Mot de passe et code d'entrée à changer tous les 30 jours.

-- ---------------------------------------------------------------- OTP : 4 heures d'inactivité
create or replace function prive.session_otp_ok(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from prive.sessions_otp where session_id = prive.session_courante()
                  and organisation_id = p_org and user_id = auth.uid() and vu_le > now() - interval '4 hours')
$$;

create or replace function public.otp_activite(p_org uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  update prive.sessions_otp set vu_le = now()
   where session_id = prive.session_courante() and organisation_id = p_org and user_id = auth.uid()
     and vu_le > now() - interval '4 hours'
  returning true
$$;

-- « expiree » : cette connexion avait été validée mais 4 heures sont passées sans activité :
-- l'application referme la session et la personne ressaisit tous ses accès.
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
  if exists (select 1 from prive.sessions_otp where session_id = prive.session_courante()
              and organisation_id = p_org and user_id = auth.uid()) then
    return jsonb_build_object('exige', true, 'verifie', false, 'expiree', true);
  end if;
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

-- ---------------------------------------------------------------- Qui gère le code OTP de qui
-- Résout la personne visée (membre actif, ou accès créé en attente de première connexion) et
-- réserve le gérant principal à l'administrateur général.
create or replace function prive.otp_cible(p_org uuid, p_user uuid, p_email text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_gerant boolean;
begin
  perform prive.exiger(prive.peut_approuver(p_org), 'Réservé à la gérante principale');
  if p_user is null and v_email <> '' then
    select id into p_user from auth.users where lower(email) = v_email;
  end if;
  perform prive.exiger(p_user is not null, 'Accès introuvable');
  select lower(email) into v_email from auth.users where id = p_user;
  perform prive.exiger(
    exists (select 1 from public.membres where organisation_id = p_org and user_id = p_user and actif)
    or exists (select 1 from public.invitations i where i.organisation_id = p_org and lower(i.email) = v_email and i.statut = 'en_attente'),
    'Membre introuvable');
  v_gerant := exists (select 1 from public.membres where organisation_id = p_org and user_id = p_user and actif and role_code = 'proprietaire')
           or exists (select 1 from public.invitations i where i.organisation_id = p_org and lower(i.email) = v_email
                        and i.statut = 'en_attente' and i.role_code = 'proprietaire');
  perform prive.exiger(not v_gerant or prive.est_admin_general(),
    'Le code OTP du gérant principal est géré par l''administrateur général');
  return p_user;
end $$;

create or replace function public.otp_configurer(p_org uuid, p_user uuid, p_telegram text, p_actif boolean default true,
                                                p_email text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tg text := nullif(regexp_replace(btrim(coalesce(p_telegram, '')), '^@*', ''), '');
begin
  p_user := prive.otp_cible(p_org, p_user, p_email);
  if v_tg is null or not coalesce(p_actif, true) then
    delete from prive.otp_membres where organisation_id = p_org and user_id = p_user;
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
    values (p_org, auth.uid(), 'otp.desactive', 'membres', p_user::text, jsonb_build_object('nom', prive.nom_de(p_user)));
    return public.otp_liste(p_org);
  end if;
  perform prive.exiger(v_tg ~ '^[A-Za-z0-9_]{5,32}$', 'Nom Telegram invalide : 5 à 32 lettres, chiffres ou _ (ex. @awa_kone)');
  insert into prive.otp_membres (organisation_id, user_id, telegram, actif, modifie_par)
  values (p_org, p_user, '@' || v_tg, true, auth.uid())
  on conflict (organisation_id, user_id) do update
    set telegram = excluded.telegram, actif = true, modifie_par = auth.uid(), modifie_le = now();
  if p_user = auth.uid() and prive.session_courante() is not null then
    insert into prive.sessions_otp (session_id, organisation_id, user_id, via)
    values (prive.session_courante(), p_org, auth.uid(), 'activation')
    on conflict (session_id, organisation_id) do update set verifie_le = now(), vu_le = now(), via = excluded.via;
  end if;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), 'otp.configure', 'membres', p_user::text,
          jsonb_build_object('nom', prive.nom_de(p_user), 'telegram', prive.masquer_telegram('@' || v_tg)));
  return public.otp_liste(p_org);
end $$;

create or replace function public.otp_lien(p_org uuid, p_user uuid default null, p_email text default null)
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

create or replace function public.otp_autoriser(p_code_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare c prive.otp_codes;
begin
  select * into c from prive.otp_codes where id = p_code_id;
  perform prive.exiger(found, 'Demande introuvable');
  perform prive.exiger(prive.peut_approuver(c.organisation_id), 'Réservé à la gérante principale');
  perform prive.exiger(c.user_id <> auth.uid() or prive.est_admin_general(), 'Vous ne pouvez pas autoriser votre propre connexion');
  perform prive.exiger(prive.est_admin_general() or not exists (select 1 from public.membres where organisation_id = c.organisation_id
                         and user_id = c.user_id and actif and role_code = 'proprietaire'),
    'La connexion du gérant principal ne peut être autorisée que par l''administrateur général');
  insert into prive.sessions_otp (session_id, organisation_id, user_id, via) values (c.session_id, c.organisation_id, c.user_id, 'gerante')
  on conflict (session_id, organisation_id) do update set verifie_le = now(), vu_le = now(), via = excluded.via;
  update prive.otp_codes set valide_le = coalesce(valide_le, now()) where id = c.id;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (c.organisation_id, auth.uid(), 'otp.autorise_par_gerante', 'membres', c.user_id::text,
          jsonb_build_object('nom', prive.nom_de(c.user_id)));
end $$;

-- La liste donne aussi l'identifiant (l'administrateur ne connaît que l'adresse du gérant).
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
            'modifie_le', o.modifie_le, 'email', lower(u.email)))
          from prive.otp_membres o join auth.users u on u.id = o.user_id where o.organisation_id = p_org), '{}'::jsonb);
end $$;

-- ---------------------------------------------------------------- Changement tous les 30 jours
create table if not exists prive.mots_de_passe (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  change_le timestamptz not null default now()
);
revoke all on table prive.mots_de_passe from public, anon, authenticated;

-- Le compteur part d'aujourd'hui pour les comptes existants (premier changement dans 30 jours).
insert into prive.mots_de_passe (user_id, change_le)
select id, now() from auth.users on conflict (user_id) do nothing;

create or replace function prive.tg_mot_de_passe_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.encrypted_password is distinct from old.encrypted_password then
    insert into prive.mots_de_passe (user_id, change_le) values (new.id, now())
    on conflict (user_id) do update set change_le = now();
  end if;
  return new;
end $$;

drop trigger if exists sur_changement_mot_de_passe on auth.users;
create trigger sur_changement_mot_de_passe
  after insert or update of encrypted_password on auth.users
  for each row execute function prive.tg_mot_de_passe_change();

-- Mon mot de passe a-t-il plus de 30 jours ? (comptes par e-mail ou identifiant ; les employés
-- par matricule ont leur code d'entrée, suivi à part.)
create or replace function public.mon_mot_de_passe()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'change_le', m.change_le,
    'expire', not (lower(u.email) like '%@acces.dfgestion.app') and coalesce(m.change_le, u.created_at, now()) < now() - interval '30 days')
  from auth.users u left join prive.mots_de_passe m on m.user_id = u.id
  where u.id = auth.uid()
$$;
revoke all on function public.mon_mot_de_passe() from public, anon;
grant execute on function public.mon_mot_de_passe() to authenticated;

-- Code d'entrée de plus de 30 jours : traité comme provisoire (la personne en choisit un nouveau).
create or replace function public.mon_pin() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('defini', c.user_id is not null,
                            'provisoire', coalesce(c.provisoire or c.defini_le < now() - interval '30 days', false),
                            'expire', coalesce(not c.provisoire and c.defini_le < now() - interval '30 days', false))
  from (select 1) x left join prive.pins_acces c on c.user_id = auth.uid()
$$;

do $$
declare d text;
begin
  d := pg_get_functiondef('prive.controler_pin(uuid,text)'::regprocedure);
  if position('30 days' in d) = 0 then
    d := replace(d, $r$jsonb_build_object('ok', true, 'provisoire', c.provisoire)$r$,
                    $r$jsonb_build_object('ok', true, 'provisoire', c.provisoire or c.defini_le < now() - interval '30 days')$r$);
    if position('30 days' in d) = 0 then raise exception 'controler_pin : ancre introuvable'; end if;
    execute d;
  end if;
end $$;

-- Nouveau code d'entrée : différent de l'ancien ; l'ancien n'est pas redemandé quand le code
-- est provisoire ou a plus de 30 jours (la personne vient de le saisir pour se connecter).
create or replace function public.changer_mon_pin(p_nouveau text, p_ancien text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c prive.pins_acces;
begin
  perform prive.exiger(auth.uid() is not null, 'Connexion requise');
  select * into c from prive.pins_acces where user_id = auth.uid();
  if found then
    if not c.provisoire and c.defini_le >= now() - interval '30 days' then
      perform prive.exiger(p_ancien is not null and prive.empreinte_code(c.sel, p_ancien) = c.empreinte, 'Ancien code incorrect');
    end if;
    perform prive.exiger(prive.empreinte_code(c.sel, coalesce(p_nouveau, '')) <> c.empreinte, 'Choisissez un code différent de l''ancien');
  end if;
  perform prive.enregistrer_pin(auth.uid(), p_nouveau, false);
end $$;
