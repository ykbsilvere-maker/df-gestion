-- v3.15 — Code de connexion par Telegram (« double vérification », comme un jeton).
--
-- La gérante principale crée l'accès de la personne (mot de passe provisoire ou code d'entrée) et
-- renseigne son contact Telegram. Dès lors, à CHAQUE connexion, après le mot de passe, DF Gestion
-- envoie un code à 6 chiffres sur Telegram (robot CallMeBot) ; sans ce code la session reste fermée :
-- la base refuse toute donnée (prive.membre_courant). Code valable 2 minutes (nouveau code possible
-- après 30 secondes), 5 essais. Une session vérifiée reste ouverte 12 heures au plus ; toute nouvelle
-- connexion (après une déconnexion, même 1 heure plus tard) redemande un code.
-- Secours : la gérante principale (ou l'administrateur général) peut autoriser la connexion d'un toucher.
-- Tout est inscrit au journal d'audit. Seule l'empreinte du code est gardée.

create table if not exists prive.otp_membres (
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  telegram text not null,
  actif boolean not null default true,
  modifie_par uuid,
  modifie_le timestamptz not null default now(),
  primary key (organisation_id, user_id)
);

create table if not exists prive.otp_codes (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  user_id uuid not null,
  session_id uuid not null,
  code_hash text not null,
  envoye_le timestamptz not null default now(),
  expire_le timestamptz not null,
  essais integer not null default 0,
  valide_le timestamptz,
  requete bigint
);
create index if not exists otp_codes_session on prive.otp_codes (session_id, organisation_id, envoye_le desc);
create index if not exists otp_codes_user on prive.otp_codes (user_id, envoye_le desc);

create table if not exists prive.sessions_otp (
  session_id uuid not null,
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  user_id uuid not null,
  via text not null check (via in ('telegram', 'gerante', 'activation')),
  verifie_le timestamptz not null default now(),
  primary key (session_id, organisation_id)
);

create or replace function prive.otp_exige(p_org uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from prive.otp_membres where organisation_id = p_org and user_id = p_user and actif)
$$;

create or replace function prive.session_otp_ok(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from prive.sessions_otp where session_id = prive.session_courante()
                  and organisation_id = p_org and user_id = auth.uid() and verifie_le > now() - interval '12 hours')
$$;

-- Le verrou : appareil approuvé (si exigé) ET code Telegram vérifié (si la personne en a un).
create or replace function prive.membre_courant(p_org uuid)
returns public.membres
language sql
stable
security definer
set search_path = ''
as $$
  select m.*
  from public.membres m
  join public.organisations o on o.id = m.organisation_id and o.actif
  where m.organisation_id = p_org and m.user_id = auth.uid() and m.actif
    and (not o.appareils_exiges or prive.session_approuvee(p_org))
    and (not prive.otp_exige(p_org, auth.uid()) or prive.session_otp_ok(p_org))
$$;

create or replace function prive.envoyer_telegram(p_user text, p_texte text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare i bigint;
begin
  execute 'select net.http_get(url := $1, params := $2, timeout_milliseconds := 8000)' into i
    using 'https://api.callmebot.com/text.php', jsonb_build_object('user', p_user, 'text', p_texte);
  return i;
exception when others then
  raise warning 'Telegram non envoyé : %', sqlerrm;
  return null;
end $$;

create or replace function prive.masquer_telegram(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select case when length(p) <= 4 then p else left(p, 3) || repeat('•', greatest(length(p) - 5, 1)) || right(p, 2) end $$;

-- La gérante renseigne (ou retire) le Telegram d'une personne de l'équipe.
-- p_email : pour un accès que la gérante vient de créer (la personne n'est pas encore rattachée :
-- elle le sera à sa première connexion, qui demandera déjà le code).
create or replace function public.otp_configurer(p_org uuid, p_user uuid, p_telegram text, p_actif boolean default true,
                                                p_email text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tg text := nullif(regexp_replace(btrim(coalesce(p_telegram, '')), '^@*', ''), '');
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  perform prive.exiger(prive.peut_approuver(p_org), 'Réservé à la gérante principale');
  if p_user is null and v_email <> '' then
    select id into p_user from auth.users where lower(email) = v_email;
    perform prive.exiger(p_user is not null and exists (select 1 from public.invitations i where i.organisation_id = p_org
                           and lower(i.email) = v_email and i.statut = 'en_attente'), 'Accès introuvable pour cette adresse');
  else
    perform prive.exiger(exists (select 1 from public.membres where organisation_id = p_org and user_id = p_user and actif), 'Membre introuvable');
  end if;
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
  -- Activer son propre code ne doit pas fermer la session en cours.
  if p_user = auth.uid() and prive.session_courante() is not null then
    insert into prive.sessions_otp (session_id, organisation_id, user_id, via)
    values (prive.session_courante(), p_org, auth.uid(), 'activation')
    on conflict (session_id, organisation_id) do update set verifie_le = now(), via = excluded.via;
  end if;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), 'otp.configure', 'membres', p_user::text,
          jsonb_build_object('nom', prive.nom_de(p_user), 'telegram', prive.masquer_telegram('@' || v_tg)));
  return public.otp_liste(p_org);
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
  return coalesce((select jsonb_object_agg(o.user_id, jsonb_build_object('telegram', o.telegram, 'actif', o.actif, 'modifie_le', o.modifie_le))
                     from prive.otp_membres o where o.organisation_id = p_org), '{}'::jsonb);
end $$;

-- Où en est la session courante de la personne connectée.
create or replace function public.otp_etat(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o prive.otp_membres;
  c prive.otp_codes;
  r jsonb;
begin
  select * into o from prive.otp_membres where organisation_id = p_org and user_id = auth.uid() and actif;
  if o.user_id is null then return jsonb_build_object('exige', false); end if;
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
  return jsonb_build_object('exige', true, 'verifie', false, 'telegram', prive.masquer_telegram(o.telegram),
                            'envoye_le', c.envoye_le, 'expire_le', c.expire_le, 'envoi', r);
end $$;

-- Envoie un nouveau code sur Telegram (limité : 1 toutes les 30 s, 5 par quart d'heure).
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
  select * into o from prive.otp_membres where organisation_id = p_org and user_id = auth.uid() and actif;
  perform prive.exiger(o.user_id is not null, 'Aucun code Telegram n''est demandé pour ce compte');
  perform prive.exiger(s is not null, 'Session inconnue : reconnectez-vous');
  if prive.session_otp_ok(p_org) then return jsonb_build_object('statut', 'verifie'); end if;
  perform prive.exiger(not exists (select 1 from prive.otp_codes where user_id = auth.uid() and envoye_le > now() - interval '30 seconds'),
                       'Patientez 30 secondes avant de demander un nouveau code');
  perform prive.exiger((select count(*) from prive.otp_codes where user_id = auth.uid() and envoye_le > now() - interval '15 minutes') < 5,
                       'Trop de codes demandés : réessayez dans un quart d''heure, ou demandez à la gérante d''autoriser la connexion');
  v_code := lpad(((((get_byte(b, 0)::bigint << 24) | (get_byte(b, 1) << 16) | (get_byte(b, 2) << 8) | get_byte(b, 3)) % 1000000))::text, 6, '0');
  v_req := prive.envoyer_telegram(o.telegram,
    '🔐 DF Gestion — votre code de connexion : ' || left(v_code, 3) || ' ' || right(v_code, 3) ||
    E'\nValable 2 minutes. Ne le donnez à personne, même à la gérante.');
  insert into prive.otp_codes (organisation_id, user_id, session_id, code_hash, expire_le, requete)
  values (p_org, auth.uid(), s, prive.hash_jeton(s::text || ':' || v_code), now() + interval '2 minutes', v_req);
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), 'otp.envoye', 'membres', auth.uid()::text,
          jsonb_build_object('nom', prive.nom_de(auth.uid()), 'telegram', prive.masquer_telegram(o.telegram)));
  return jsonb_build_object('statut', 'envoye', 'telegram', prive.masquer_telegram(o.telegram), 'expire_le', now() + interval '2 minutes',
                            'envoi_ok', v_req is not null);
end $$;

-- Vérifie le code saisi : ouvre la session s'il est juste.
create or replace function public.otp_verifier(p_org uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c prive.otp_codes;
  s uuid := prive.session_courante();
  v_code text := regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g');
begin
  perform prive.exiger(s is not null, 'Session inconnue : reconnectez-vous');
  if prive.session_otp_ok(p_org) then return jsonb_build_object('statut', 'verifie'); end if;
  select * into c from prive.otp_codes where session_id = s and organisation_id = p_org and user_id = auth.uid()
     and valide_le is null order by envoye_le desc limit 1 for update;
  if c.id is null or c.expire_le < now() then
    return jsonb_build_object('statut', 'expire', 'message', 'Code expiré : demandez un nouveau code.');
  end if;
  if c.essais >= 5 then
    return jsonb_build_object('statut', 'bloque', 'message', 'Trop d''essais : demandez un nouveau code.');
  end if;
  if c.code_hash <> prive.hash_jeton(s::text || ':' || v_code) then
    update prive.otp_codes set essais = essais + 1 where id = c.id;
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
    values (p_org, auth.uid(), 'otp.echec', 'membres', auth.uid()::text,
            jsonb_build_object('nom', prive.nom_de(auth.uid()), 'essai', c.essais + 1));
    return jsonb_build_object('statut', 'faux', 'restants', 4 - c.essais,
                              'message', 'Code incorrect' || case when c.essais >= 4 then ' : demandez un nouveau code.' else '.' end);
  end if;
  update prive.otp_codes set valide_le = now() where id = c.id;
  insert into prive.sessions_otp (session_id, organisation_id, user_id, via) values (s, p_org, auth.uid(), 'telegram')
  on conflict (session_id, organisation_id) do update set verifie_le = now(), via = excluded.via;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), 'otp.verifie', 'membres', auth.uid()::text, jsonb_build_object('nom', prive.nom_de(auth.uid())));
  return jsonb_build_object('statut', 'verifie');
end $$;

-- Secours : la gérante autorise la connexion en attente (Telegram indisponible, téléphone perdu…).
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
  insert into prive.sessions_otp (session_id, organisation_id, user_id, via) values (c.session_id, c.organisation_id, c.user_id, 'gerante')
  on conflict (session_id, organisation_id) do update set verifie_le = now(), via = excluded.via;
  update prive.otp_codes set valide_le = coalesce(valide_le, now()) where id = c.id;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (c.organisation_id, auth.uid(), 'otp.autorise_par_gerante', 'membres', c.user_id::text,
          jsonb_build_object('nom', prive.nom_de(c.user_id)));
end $$;

revoke execute on function public.otp_configurer(uuid, uuid, text, boolean, text), public.otp_liste(uuid), public.otp_etat(uuid),
  public.otp_envoyer(uuid), public.otp_verifier(uuid, text), public.otp_autoriser(uuid) from public, anon;
grant execute on function public.otp_configurer(uuid, uuid, text, boolean, text), public.otp_liste(uuid), public.otp_etat(uuid),
  public.otp_envoyer(uuid), public.otp_verifier(uuid, text), public.otp_autoriser(uuid) to authenticated;

-- Alertes de la gérante : connexions qui attendent leur code (pour autoriser en secours).
do $$
declare d text;
begin
  d := pg_get_functiondef('prive.attente_pour(uuid,uuid)'::regprocedure);
  if position('connexions_en_attente' in d) = 0 then
    if position('    ''derniere'', (select max(created_at) from c where c.statut = ''nouvelle''),' in d) = 0 then
      raise exception 'attente_pour : ancre introuvable';
    end if;
    d := replace(d, '    ''derniere'', (select max(created_at) from c where c.statut = ''nouvelle''),',
      '    ''connexions_en_attente'', case when d.approbatrice then coalesce((select jsonb_agg(jsonb_build_object(' || chr(10) ||
      '        ''id'', k.id, ''nom'', prive.nom_de(k.user_id), ''envoye_le'', k.envoye_le) order by k.envoye_le)' || chr(10) ||
      '        from prive.otp_codes k where k.organisation_id = p_org and k.valide_le is null and k.expire_le > now()' || chr(10) ||
      '          and k.user_id <> p_user' || chr(10) ||
      '          and not exists (select 1 from prive.sessions_otp x where x.session_id = k.session_id and x.organisation_id = k.organisation_id and x.verifie_le > now() - interval ''12 hours'')' || chr(10) ||
      '          and k.envoye_le = (select max(k2.envoye_le) from prive.otp_codes k2 where k2.session_id = k.session_id)), ''[]''::jsonb) else ''[]''::jsonb end,' || chr(10) ||
      '    ''derniere'', (select max(created_at) from c where c.statut = ''nouvelle''),');
    execute d;
  end if;
end $$;
