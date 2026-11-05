-- =====================================================================
-- 1.2 : connexion des employés par code entreprise + matricule
-- =====================================================================
-- Chaque entreprise reçoit un code d'accès court et fixe (ex. AWAB27).
-- Un employé se connecte avec ce code, son matricule et son code secret.
-- Supabase Auth exigeant une adresse, la base en fabrique une, technique,
-- jamais montrée ni utilisée pour écrire : <matricule>.<code>@acces.dfgestion.app
-- Le gérant principal garde son adresse e-mail.

alter table public.organisations add column code_acces text;

create function prive.generer_code_acces(p_nom text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_base text := upper(regexp_replace(translate(lower(coalesce(p_nom, '')),
                   'àâäáãåçéèêëíìîïñóòôöõúùûüýÿœæ', 'aaaaaaceeeeiiiinooooouuuuyyoa'), '[^a-z]', '', 'g'));
  v_code text;
  i int := 0;
begin
  v_base := rpad(left(v_base, 4), 4, 'X');
  loop
    v_code := v_base || lpad((floor(random() * 100))::int::text, 2, '0');
    exit when not exists (select 1 from public.organisations where code_acces = v_code);
    i := i + 1;
    if i > 50 then v_code := v_base || lpad((floor(random() * 10000))::int::text, 4, '0'); exit; end if;
  end loop;
  return v_code;
end $$;

update public.organisations set code_acces = prive.generer_code_acces(nom) where code_acces is null;
alter table public.organisations alter column code_acces set not null;
alter table public.organisations add constraint organisations_code_acces_ck check (code_acces ~ '^[A-Z0-9]{4,10}$');
create unique index organisations_code_acces_idx on public.organisations (code_acces);

create function prive.tg_code_acces() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.code_acces is null then new.code_acces := prive.generer_code_acces(new.nom); end if;
  elsif new.code_acces is distinct from old.code_acces then
    -- Les identifiants des employés en dépendent : le code ne change jamais.
    raise exception 'Le code d''accès de l''entreprise ne peut pas être modifié';
  end if;
  return new;
end $$;
create trigger organisations_code_acces before insert or update of code_acces on public.organisations
  for each row execute function prive.tg_code_acces();

-- Identifiant technique d'un employé.
create function prive.email_employe(p_code text, p_matricule text) returns text
language sql immutable set search_path = '' as $$
  select lower(btrim(p_matricule)) || '.' || lower(btrim(p_code)) || '@acces.dfgestion.app'
$$;

create function public.acces_employes(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.est_membre(p_org), 'Accès refusé');
  return jsonb_build_object(
    'code_acces', (select code_acces from public.organisations where id = p_org),
    'domaine', 'acces.dfgestion.app',
    'matricule_suivant', (
      select lpad((coalesce(max(nullif(regexp_replace(split_part(x.email, '.', 1), '\D', '', 'g'), '')::int), 0) + 1)::text, 4, '0')
      from (select i.email from public.invitations i where i.organisation_id = p_org
            union all
            select u.email::text from public.membres m join auth.users u on u.id = m.user_id where m.organisation_id = p_org) x
      where x.email like '%@acces.dfgestion.app' and split_part(x.email, '.', 1) ~ '^\d{1,8}$'));
end $$;

-- Inviter un employé par matricule (mêmes contrôles que inviter_membre, qui est appelé).
create function public.inviter_employe(
  p_org uuid, p_matricule text, p_role text, p_tous_magasins boolean, p_magasins uuid[], p_caisses uuid[]
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
  v_email text;
begin
  perform prive.exiger(btrim(coalesce(p_matricule, '')) ~ '^[A-Za-z0-9-]{1,12}$',
                       'Matricule : 1 à 12 lettres ou chiffres (tiret permis), sans espace ni accent');
  perform prive.exiger(p_role <> 'proprietaire', 'Le propriétaire se connecte avec son adresse e-mail');
  select code_acces into v_code from public.organisations where id = p_org;
  perform prive.exiger(v_code is not null, 'Entreprise introuvable');
  v_email := prive.email_employe(v_code, p_matricule);
  perform prive.exiger(not exists (select 1 from auth.users where lower(email) = v_email),
                       'Ce matricule est déjà utilisé dans l''entreprise');
  perform public.inviter_membre(p_org, v_email, p_role, p_tous_magasins, p_magasins, p_caisses);
  return v_email;
end $$;

revoke all on function prive.generer_code_acces(text), prive.tg_code_acces(), prive.email_employe(text, text) from public, anon, authenticated;
revoke all on function public.acces_employes(uuid), public.inviter_employe(uuid, text, text, boolean, uuid[], uuid[]) from public, anon;
grant execute on function public.acces_employes(uuid), public.inviter_employe(uuid, text, text, boolean, uuid[], uuid[]) to authenticated;
