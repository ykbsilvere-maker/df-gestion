-- 1.8 — Le gérant principal se connecte aussi « comme sur Wave » sur n'importe quel appareil :
-- code établissement + matricule 0000 + son propre code d'entrée (choisi dans « Mon compte »).
-- 0000 est réservé : il désigne toujours le gérant principal (propriétaire) de l'établissement.

create or replace function public.connexion_pin(p_code text, p_matricule text, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.organisations;
  v_email text;
  v_user uuid;
  v_gerant boolean := btrim(coalesce(p_matricule, '')) = '0000';
  r jsonb;
  v_generique constant text := 'Code établissement, matricule ou code d''entrée incorrect.';
begin
  select * into o from public.organisations where code_acces = upper(btrim(coalesce(p_code, '')));
  if not found or btrim(coalesce(p_matricule, '')) !~ '^[A-Za-z0-9-]{1,12}$' then
    return jsonb_build_object('ok', false, 'message', v_generique);
  end if;
  if not o.actif then
    return jsonb_build_object('ok', false, 'message', 'Cet établissement est suspendu : contactez Décodeur Financier.');
  end if;
  if v_gerant then
    select u.id, lower(u.email) into v_user, v_email
      from public.membres m join auth.users u on u.id = m.user_id
     where m.organisation_id = o.id and m.role_code = 'proprietaire' and m.actif
     order by m.created_at
     limit 1;
  else
    v_email := prive.email_employe(o.code_acces, p_matricule);
    select id into v_user from auth.users where lower(email) = v_email;
  end if;
  if v_user is null then return jsonb_build_object('ok', false, 'message', v_generique); end if;
  if exists (select 1 from public.membres where user_id = v_user and organisation_id = o.id and not actif) then
    return jsonb_build_object('ok', false, 'message', 'Votre accès a été désactivé par votre gérant.');
  end if;
  r := prive.controler_pin(v_user, p_pin);
  if (r ->> 'ok')::boolean then
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
    values (o.id, v_user, 'connexion.code_entree', 'utilisateur', case when v_gerant then 'gerant_principal' else v_email end);
    return r || jsonb_build_object('email', v_email);
  end if;
  if v_gerant and r ->> 'motif' = 'sans_code' then
    return jsonb_build_object('ok', false, 'motif', 'sans_code',
      'message', 'Créez d''abord votre code : connectez-vous avec votre e-mail, puis « Mon compte » → « Créer mon code ».');
  end if;
  if r ->> 'motif' = 'incorrect' and (r ->> 'essais_restants')::int <= 2 then
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
    values (o.id, v_user, 'connexion.code_entree_refuse', 'utilisateur', case when v_gerant then 'gerant_principal' else v_email end);
  end if;
  return r;
end $$;

revoke all on function public.connexion_pin(text, text, text) from public, anon, authenticated;
grant execute on function public.connexion_pin(text, text, text) to service_role;

-- 0000 ne peut pas être donné à un employé.
do $$
declare v_def text := pg_get_functiondef('public.inviter_employe(uuid, text, text, boolean, uuid[], uuid[])'::regprocedure);
  v_ancre text := 'perform prive.exiger(p_role <> ''proprietaire'', ''Le propriétaire se connecte avec son adresse e-mail'');';
begin
  if position(v_ancre in v_def) = 0 then raise exception 'inviter_employe : ancre introuvable'; end if;
  execute replace(v_def, v_ancre, v_ancre || '
  perform prive.exiger(btrim(p_matricule) <> ''0000'', ''Le matricule 0000 est réservé au gérant principal'');');
end $$;
