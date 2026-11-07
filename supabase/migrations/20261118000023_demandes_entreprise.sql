-- 1.9 — Commercialisation : une personne crée elle-même ses accès, remplit la fiche de son
-- entreprise et envoie une demande. L'administrateur général la valide (l'entreprise est
-- créée et la personne en devient le gérant principal), la refuse, ou l'ajourne en
-- demandant une correction. Les demandes ne se lisent et ne s'écrivent que par fonctions.

alter table public.organisations
  add column if not exists activite text check (activite is null or length(activite) <= 300),
  add column if not exists date_creation date;

create table public.demandes_entreprise (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  statut text not null default 'en_attente' check (statut in ('en_attente', 'ajournee', 'validee', 'refusee')),
  nom_entreprise text not null check (length(btrim(nom_entreprise)) between 2 and 120),
  activite text not null check (length(btrim(activite)) between 2 and 300),
  date_creation date,
  rccm text check (rccm is null or length(rccm) <= 40),
  ncc text check (ncc is null or length(ncc) <= 20),
  regime_fiscal text not null default 'non_precise'
    check (regime_fiscal in ('entreprenant', 'micro', 'rsi', 'rni', 'non_precise')),
  nom_gerant text not null check (length(btrim(nom_gerant)) between 2 and 120),
  telephone text not null check (length(btrim(telephone)) between 8 and 30),
  email_contact text check (email_contact is null or length(email_contact) <= 200),
  ville text check (ville is null or length(ville) <= 80),
  adresse text check (adresse is null or length(adresse) <= 200),
  devise text not null default 'XOF' check (devise ~ '^[A-Z]{3}$'),
  nom_magasin text not null default 'Magasin principal' check (length(btrim(nom_magasin)) between 2 and 80),
  modules_desactives text[] not null default '{}',
  logo text check (logo is null or (length(logo) <= 400000 and logo like 'data:image/%')),
  logo_transfere boolean not null default false,
  motif text check (motif is null or length(motif) <= 1000),
  organisation_id uuid references public.organisations (id) on delete set null,
  soumise_le timestamptz not null default now(),
  traitee_par uuid references auth.users (id) on delete set null,
  traitee_le timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index demandes_une_active on public.demandes_entreprise (user_id) where statut in ('en_attente', 'ajournee');
create index demandes_par_statut on public.demandes_entreprise (statut, soumise_le desc);
alter table public.demandes_entreprise enable row level security;
revoke all on table public.demandes_entreprise from public, anon, authenticated;

-- Fiche telle que la voit le demandeur ou l'administrateur.
create function prive.fiche_demande(d public.demandes_entreprise, p_logo boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', d.id, 'statut', d.statut, 'nom_entreprise', d.nom_entreprise, 'activite', d.activite,
    'date_creation', d.date_creation, 'rccm', d.rccm, 'ncc', d.ncc, 'regime_fiscal', d.regime_fiscal,
    'nom_gerant', d.nom_gerant, 'telephone', d.telephone, 'email_contact', d.email_contact,
    'ville', d.ville, 'adresse', d.adresse, 'devise', d.devise, 'nom_magasin', d.nom_magasin,
    'modules_desactives', to_jsonb(d.modules_desactives), 'a_logo', d.logo is not null,
    'logo', case when p_logo then d.logo end, 'motif', d.motif, 'organisation_id', d.organisation_id,
    'soumise_le', d.soumise_le, 'traitee_le', d.traitee_le)
$$;

-- Dernière demande de la personne connectée (avec le logo, pour la modifier ou le transférer).
create function public.ma_demande() returns jsonb
language sql stable security definer set search_path = '' as $$
  select prive.fiche_demande(d, not d.logo_transfere)
    from public.demandes_entreprise d
   where d.user_id = auth.uid()
   order by d.created_at desc
   limit 1
$$;

-- Envoi (ou renvoi après ajournement) de la demande.
create function public.soumettre_demande(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_txt text;
begin
  perform prive.exiger(auth.uid() is not null, 'Connexion requise');
  perform prive.exiger(not exists (select 1 from auth.users where id = auth.uid() and email like '%@acces.dfgestion.app'),
                       'Les accès employés ne peuvent pas créer d''entreprise');
  perform prive.exiger(length(btrim(coalesce(p ->> 'nom_entreprise', ''))) >= 2, 'Nom de l''entreprise requis');
  perform prive.exiger(length(btrim(coalesce(p ->> 'activite', ''))) >= 2, 'Indiquez l''activité de l''entreprise');
  perform prive.exiger(length(btrim(coalesce(p ->> 'nom_gerant', ''))) >= 2, 'Nom du gérant principal requis');
  perform prive.exiger(length(regexp_replace(coalesce(p ->> 'telephone', ''), '\D', '', 'g')) >= 8,
                       'Un numéro de téléphone joignable est requis');
  v_txt := p ->> 'logo';
  perform prive.exiger(v_txt is null or (v_txt like 'data:image/%' and length(v_txt) <= 400000),
                       'Logo trop lourd : choisissez une image plus petite');
  select id into v_id from public.demandes_entreprise
   where user_id = auth.uid() and statut in ('en_attente', 'ajournee') for update;
  if v_id is null then
    insert into public.demandes_entreprise (user_id, nom_entreprise, activite, nom_gerant, telephone)
    values (auth.uid(), btrim(p ->> 'nom_entreprise'), btrim(p ->> 'activite'), btrim(p ->> 'nom_gerant'), btrim(p ->> 'telephone'))
    returning id into v_id;
  end if;
  update public.demandes_entreprise set
    statut = 'en_attente',
    nom_entreprise = btrim(p ->> 'nom_entreprise'),
    activite = btrim(p ->> 'activite'),
    date_creation = nullif(p ->> 'date_creation', '')::date,
    rccm = nullif(btrim(coalesce(p ->> 'rccm', '')), ''),
    ncc = nullif(btrim(coalesce(p ->> 'ncc', '')), ''),
    regime_fiscal = coalesce(nullif(p ->> 'regime_fiscal', ''), 'non_precise'),
    nom_gerant = btrim(p ->> 'nom_gerant'),
    telephone = btrim(p ->> 'telephone'),
    email_contact = nullif(btrim(coalesce(p ->> 'email_contact', '')), ''),
    ville = nullif(btrim(coalesce(p ->> 'ville', '')), ''),
    adresse = nullif(btrim(coalesce(p ->> 'adresse', '')), ''),
    devise = upper(coalesce(nullif(btrim(p ->> 'devise'), ''), 'XOF')),
    nom_magasin = coalesce(nullif(btrim(p ->> 'nom_magasin'), ''), 'Magasin principal'),
    modules_desactives = coalesce(array(select jsonb_array_elements_text(p -> 'modules_desactives')), '{}'),
    logo = v_txt,
    logo_transfere = false,
    soumise_le = now(),
    updated_at = now()
  where id = v_id;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
  values (null, auth.uid(), 'demande.soumise', 'demande', v_id::text);
  return v_id;
end $$;

-- Le nouveau gérant a déposé le logo dans l'espace de son entreprise : on libère la copie.
create function public.demande_logo_transfere(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.demandes_entreprise set logo = null, logo_transfere = true, updated_at = now()
   where id = p_id and user_id = auth.uid() and statut = 'validee'
$$;

-- Console : toutes les demandes (sans les logos), les plus récentes d'abord.
create function public.admin_demandes() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.est_admin_general(), 'Réservé à l''administrateur général');
  return coalesce((
    select jsonb_agg(prive.fiche_demande(d, false) || jsonb_build_object('compte', u.email)
                     order by (d.statut in ('en_attente', 'ajournee')) desc, d.soumise_le desc)
      from public.demandes_entreprise d join auth.users u on u.id = d.user_id
  ), '[]'::jsonb);
end $$;

create function public.admin_demande(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  perform prive.exiger(prive.est_admin_general(), 'Réservé à l''administrateur général');
  select prive.fiche_demande(d, true) || jsonb_build_object('compte', u.email) into r
    from public.demandes_entreprise d join auth.users u on u.id = d.user_id where d.id = p_id;
  perform prive.exiger(r is not null, 'Demande introuvable');
  return r;
end $$;

-- Décision : valider (crée l'entreprise, la personne en devient gérant principal),
-- refuser ou ajourner (motif obligatoire, visible du demandeur).
create function public.admin_traiter_demande(p_id uuid, p_decision text, p_motif text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d public.demandes_entreprise;
  v_email text;
  v_org uuid;
  v_inv uuid;
begin
  perform prive.exiger(prive.est_admin_general(), 'Réservé à l''administrateur général');
  perform prive.exiger(p_decision in ('valider', 'refuser', 'ajourner'), 'Décision inconnue');
  select * into d from public.demandes_entreprise where id = p_id for update;
  perform prive.exiger(found, 'Demande introuvable');
  perform prive.exiger(d.statut in ('en_attente', 'ajournee'), 'Cette demande a déjà été traitée');

  if p_decision in ('refuser', 'ajourner') then
    perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3,
                         'Expliquez au demandeur la raison (ce qu''il doit corriger, ou pourquoi c''est refusé)');
    update public.demandes_entreprise
       set statut = case when p_decision = 'refuser' then 'refusee' else 'ajournee' end,
           motif = btrim(p_motif), traitee_par = auth.uid(), traitee_le = now(), updated_at = now()
     where id = p_id;
  else
    select lower(email) into v_email from auth.users where id = d.user_id;
    perform prive.exiger(v_email is not null, 'Le compte du demandeur n''existe plus');
    v_org := public.admin_creer_entreprise(d.nom_entreprise, v_email, d.ncc, d.regime_fiscal, d.telephone,
                                           d.adresse, d.ville, d.nom_magasin, d.devise);
    update public.organisations
       set rccm = d.rccm, activite = d.activite, date_creation = d.date_creation,
           email = coalesce(d.email_contact, v_email)
     where id = v_org;
    if cardinality(d.modules_desactives) > 0 then
      perform public.definir_modules(v_org, d.modules_desactives);
    end if;
    -- Le demandeur devient tout de suite gérant principal (pas d'attente d'acceptation).
    select id into v_inv from public.invitations
     where organisation_id = v_org and email = v_email and statut = 'en_attente' order by created_at desc limit 1;
    if v_inv is not null then
      perform prive.accepter_invitation(v_inv, d.user_id);
    end if;
    update public.profils set nom_complet = coalesce(nullif(btrim(nom_complet), ''), d.nom_gerant),
                              telephone = coalesce(nullif(btrim(telephone), ''), d.telephone)
     where id = d.user_id;
    update public.demandes_entreprise
       set statut = 'validee', organisation_id = v_org, motif = nullif(btrim(coalesce(p_motif, '')), ''),
           traitee_par = auth.uid(), traitee_le = now(), updated_at = now()
     where id = p_id;
  end if;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, apres)
  values (v_org, auth.uid(), 'demande.' || p_decision, 'demande', p_id::text,
          jsonb_build_object('entreprise', d.nom_entreprise, 'motif', p_motif));
  return jsonb_build_object('statut', case p_decision when 'valider' then 'validee' when 'refuser' then 'refusee' else 'ajournee' end,
                            'organisation_id', v_org);
end $$;

-- Nombre de demandes à traiter, pour la pastille de l'administrateur.
create or replace function public.plateforme_info() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'admin_existe', exists (select 1 from prive.admins_generaux),
    'inscription_libre', (select inscription_libre from prive.plateforme),
    'je_suis_admin', prive.est_admin_general(),
    'creation_entreprise_possible', prive.peut_creer_entreprise(),
    'demandes_en_attente', case when prive.est_admin_general()
      then (select count(*) from public.demandes_entreprise where statut = 'en_attente') end
  )
$$;

-- Garde-fou de l'inscription libre en ligne (appelé par la fonction serveur « inscription »).
create function public.quota_inscriptions() returns boolean
language sql stable security definer set search_path = '' as $$
  select count(*) < 40 from auth.users
   where created_at > now() - interval '1 hour' and email not like '%@acces.dfgestion.app'
$$;

revoke all on function prive.fiche_demande(public.demandes_entreprise, boolean) from public, anon, authenticated;
revoke all on function public.ma_demande(), public.soumettre_demande(jsonb), public.demande_logo_transfere(uuid),
  public.admin_demandes(), public.admin_demande(uuid), public.admin_traiter_demande(uuid, text, text),
  public.quota_inscriptions() from public, anon;
grant execute on function public.ma_demande(), public.soumettre_demande(jsonb), public.demande_logo_transfere(uuid),
  public.admin_demandes(), public.admin_demande(uuid), public.admin_traiter_demande(uuid, text, text) to authenticated;
revoke all on function public.quota_inscriptions() from authenticated;
grant execute on function public.quota_inscriptions() to service_role;
grant execute on function public.plateforme_info() to anon, authenticated;
