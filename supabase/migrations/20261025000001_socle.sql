-- =====================================================================
-- Le Décodeur Financier — Gestion commerciale
-- Migration 001 : socle multi-entreprises, magasins, caisses,
-- utilisateurs, rôles, permissions, invitations et journal d'audit.
--
-- Principes :
--   * chaque ligne métier porte organisation_id, protégé par RLS ;
--   * les droits sont vérifiés en base (jamais seulement dans l'interface) ;
--   * les écritures sensibles passent par des fonctions RPC auditées ;
--   * le journal d'audit est en insertion seule.
-- =====================================================================

create extension if not exists pgcrypto;

create schema if not exists prive;
revoke all on schema prive from public;

-- ---------------------------------------------------------------------
-- Référentiels globaux : rôles et permissions
-- ---------------------------------------------------------------------

create table public.roles (
  code     text primary key,
  libelle  text not null,
  ordre    smallint not null
);

create table public.permissions (
  code     text primary key,
  module   text not null,
  action   text not null,
  unique (module, action)
);

create table public.role_permissions (
  role_code       text not null references public.roles(code) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  primary key (role_code, permission_code)
);

insert into public.roles (code, libelle, ordre) values
  ('proprietaire',       'Propriétaire / administrateur principal', 1),
  ('gerant_magasin',     'Gérant de magasin',                       2),
  ('responsable_caisse', 'Responsable de caisse',                   3),
  ('caissier',           'Caissier',                                4),
  ('vendeur',            'Vendeur',                                 5),
  ('gestionnaire_stock', 'Gestionnaire de stock',                   6),
  ('responsable_achats', 'Responsable des achats',                  7),
  ('comptable',          'Comptable',                               8),
  ('auditeur',           'Auditeur (consultation)',                 9);

insert into public.permissions (code, module, action)
select m || '.' || a, m, a
from unnest(array['administration','magasins','utilisateurs','audit','catalogue','stock',
                  'achats','caisse','ventes','clients','fournisseurs','rapports','comptabilite']) m
cross join unnest(array['consulter','creer','modifier','valider','annuler','supprimer',
                        'exporter','cloturer','administrer']) a;

-- '*' = toutes les actions du module sauf « administrer ».
with matrice(role_code, module, actions) as (values
  ('gerant_magasin', 'magasins',     array['consulter','modifier']),
  ('gerant_magasin', 'utilisateurs', array['consulter','creer','modifier']),
  ('gerant_magasin', 'audit',        array['consulter']),
  ('gerant_magasin', 'catalogue',    array['*']),
  ('gerant_magasin', 'stock',        array['*']),
  ('gerant_magasin', 'achats',       array['*']),
  ('gerant_magasin', 'caisse',       array['*']),
  ('gerant_magasin', 'ventes',       array['*']),
  ('gerant_magasin', 'clients',      array['*']),
  ('gerant_magasin', 'fournisseurs', array['*']),
  ('gerant_magasin', 'rapports',     array['*']),
  ('gerant_magasin', 'comptabilite', array['consulter']),

  ('responsable_caisse', 'caisse',    array['*']),
  ('responsable_caisse', 'ventes',    array['consulter','creer','valider','annuler']),
  ('responsable_caisse', 'clients',   array['consulter','creer']),
  ('responsable_caisse', 'catalogue', array['consulter']),
  ('responsable_caisse', 'stock',     array['consulter']),
  ('responsable_caisse', 'rapports',  array['consulter']),

  ('caissier', 'caisse',    array['consulter','creer']),
  ('caissier', 'ventes',    array['consulter','creer']),
  ('caissier', 'clients',   array['consulter','creer']),
  ('caissier', 'catalogue', array['consulter']),
  ('caissier', 'stock',     array['consulter']),

  ('vendeur', 'ventes',    array['consulter','creer']),
  ('vendeur', 'clients',   array['consulter','creer']),
  ('vendeur', 'catalogue', array['consulter']),
  ('vendeur', 'stock',     array['consulter']),

  ('gestionnaire_stock', 'catalogue',    array['*']),
  ('gestionnaire_stock', 'stock',        array['*']),
  ('gestionnaire_stock', 'achats',       array['consulter']),
  ('gestionnaire_stock', 'fournisseurs', array['consulter']),
  ('gestionnaire_stock', 'rapports',     array['consulter']),

  ('responsable_achats', 'achats',       array['*']),
  ('responsable_achats', 'fournisseurs', array['*']),
  ('responsable_achats', 'catalogue',    array['consulter','modifier']),
  ('responsable_achats', 'stock',        array['consulter']),
  ('responsable_achats', 'rapports',     array['consulter']),

  ('comptable', 'comptabilite', array['*']),
  ('comptable', 'rapports',     array['*']),
  ('comptable', 'audit',        array['consulter']),
  ('comptable', 'clients',      array['consulter']),
  ('comptable', 'fournisseurs', array['consulter']),
  ('comptable', 'ventes',       array['consulter']),
  ('comptable', 'achats',       array['consulter']),
  ('comptable', 'caisse',       array['consulter']),
  ('comptable', 'stock',        array['consulter'])
)
insert into public.role_permissions (role_code, permission_code)
select distinct mx.role_code, p.code
from matrice mx
join public.permissions p
  on p.module = mx.module
 and (p.action = any(mx.actions) or ('*' = any(mx.actions) and p.action <> 'administrer'));

-- Propriétaire : toutes les permissions. Auditeur : consultation de tout.
insert into public.role_permissions (role_code, permission_code)
select 'proprietaire', code from public.permissions;
insert into public.role_permissions (role_code, permission_code)
select 'auditeur', code from public.permissions where action = 'consulter';

-- ---------------------------------------------------------------------
-- Entreprises, magasins, caisses
-- ---------------------------------------------------------------------

create table public.organisations (
  id            uuid primary key default gen_random_uuid(),
  nom           text not null check (length(btrim(nom)) between 2 and 120),
  ncc           text check (ncc is null or ncc ~ '^[0-9A-Za-z]{1,20}$'),
  regime_fiscal text not null default 'non_precise'
                check (regime_fiscal in ('entreprenant','micro','rsi','rni','non_precise')),
  telephone     text,
  adresse       text,
  ville         text,
  devise        char(3) not null default 'XOF',
  actif         boolean not null default true,
  cree_par      uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.magasins (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  code            text not null check (code ~ '^[A-Z0-9_-]{2,20}$'),
  nom             text not null check (length(btrim(nom)) between 2 and 120),
  adresse         text,
  ville           text,
  telephone       text,
  actif           boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, code),
  unique (organisation_id, id)
);

create table public.caisses (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  magasin_id      uuid not null,
  code            text not null check (code ~ '^[A-Z0-9_-]{2,20}$'),
  nom             text not null check (length(btrim(nom)) between 2 and 120),
  actif           boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- La caisse appartient forcément à un magasin de la même entreprise.
  foreign key (organisation_id, magasin_id) references public.magasins(organisation_id, id),
  unique (magasin_id, code),
  unique (organisation_id, id)
);

-- ---------------------------------------------------------------------
-- Utilisateurs : profils, appartenance aux entreprises, droits
-- ---------------------------------------------------------------------

create table public.profils (
  id          uuid primary key references auth.users(id) on delete cascade,
  nom_complet text,
  telephone   text,
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.membres (
  id                  uuid primary key default gen_random_uuid(),
  organisation_id     uuid not null references public.organisations(id),
  user_id             uuid not null references auth.users(id),
  role_code           text not null references public.roles(code),
  tous_magasins       boolean not null default false,
  actif               boolean not null default true,
  motif_desactivation text,
  desactive_le        timestamptz,
  desactive_par       uuid references auth.users(id),
  derniere_connexion  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organisation_id, user_id),
  unique (organisation_id, id)
);
create index membres_user_idx on public.membres(user_id);

create table public.membre_magasins (
  organisation_id uuid not null,
  membre_id       uuid not null,
  magasin_id      uuid not null,
  primary key (membre_id, magasin_id),
  foreign key (organisation_id, membre_id)  references public.membres(organisation_id, id) on delete cascade,
  foreign key (organisation_id, magasin_id) references public.magasins(organisation_id, id)
);

create table public.membre_caisses (
  organisation_id uuid not null,
  membre_id       uuid not null,
  caisse_id       uuid not null,
  primary key (membre_id, caisse_id),
  foreign key (organisation_id, membre_id) references public.membres(organisation_id, id) on delete cascade,
  foreign key (organisation_id, caisse_id) references public.caisses(organisation_id, id)
);

-- Ajustement individuel : accorde=true ajoute un droit, accorde=false le retire.
create table public.membre_permissions (
  organisation_id uuid not null,
  membre_id       uuid not null,
  permission_code text not null references public.permissions(code),
  accorde         boolean not null,
  primary key (membre_id, permission_code),
  foreign key (organisation_id, membre_id) references public.membres(organisation_id, id) on delete cascade
);

create table public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  email           text not null check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role_code       text not null references public.roles(code),
  tous_magasins   boolean not null default false,
  magasins        uuid[] not null default '{}',
  caisses         uuid[] not null default '{}',
  statut          text not null default 'en_attente' check (statut in ('en_attente','acceptee','annulee')),
  invite_par      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  traitee_le      timestamptz
);
create unique index invitations_unique_en_attente
  on public.invitations(organisation_id, email) where statut = 'en_attente';
create index invitations_email_idx on public.invitations(email) where statut = 'en_attente';

-- ---------------------------------------------------------------------
-- Journal d'audit (insertion seule)
-- ---------------------------------------------------------------------

create table public.journal_audit (
  id              bigint generated always as identity primary key,
  organisation_id uuid references public.organisations(id),
  user_id         uuid,
  action          text not null,
  objet_type      text,
  objet_id        text,
  avant           jsonb,
  apres           jsonb,
  contexte        jsonb,
  created_at      timestamptz not null default now()
);
create index journal_audit_org_date_idx on public.journal_audit(organisation_id, created_at desc);
create index journal_audit_user_idx on public.journal_audit(organisation_id, user_id, created_at desc);

create function prive.tg_audit_immuable() returns trigger
language plpgsql as $$
begin
  raise exception 'Le journal d''audit ne peut être ni modifié ni supprimé'
    using errcode = 'P0001';
end $$;

create trigger journal_audit_pas_de_modification
  before update or delete on public.journal_audit
  for each row execute function prive.tg_audit_immuable();
create trigger journal_audit_pas_de_vidage
  before truncate on public.journal_audit
  for each statement execute function prive.tg_audit_immuable();

-- ---------------------------------------------------------------------
-- Fonctions d'autorisation (utilisées par les politiques RLS)
-- ---------------------------------------------------------------------

create function prive.membre_courant(p_org uuid) returns public.membres
language sql stable security definer set search_path = '' as $$
  select m.*
  from public.membres m
  join public.organisations o on o.id = m.organisation_id and o.actif
  where m.organisation_id = p_org and m.user_id = auth.uid() and m.actif
$$;

create function prive.est_membre(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (prive.membre_courant(p_org)).id is not null
$$;

create function prive.permission_du_membre(p_membre public.membres, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_membre.id is not null and p_membre.actif and (
    p_membre.role_code = 'proprietaire'
    or coalesce(
         (select mp.accorde from public.membre_permissions mp
           where mp.membre_id = p_membre.id and mp.permission_code = p_permission),
         exists (select 1 from public.role_permissions rp
                  where rp.role_code = p_membre.role_code and rp.permission_code = p_permission)
       )
  )
$$;

create function prive.a_permission(p_org uuid, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(prive.permission_du_membre(prive.membre_courant(p_org), p_permission), false)
$$;

create function prive.acces_magasin(p_org uuid, p_magasin uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with m as (select * from prive.membre_courant(p_org))
  select exists (
    select 1 from m
    where m.id is not null
      and (m.role_code = 'proprietaire' or m.tous_magasins
           or exists (select 1 from public.membre_magasins mm
                       where mm.membre_id = m.id and mm.magasin_id = p_magasin))
  )
$$;

create function prive.permissions_effectives(p_membre_id uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(p.code order by p.code), '{}')
  from public.permissions p, public.membres m
  where m.id = p_membre_id
    and prive.permission_du_membre(m, p.code)
$$;

-- Un profil est visible par son titulaire et par les personnes habilitées
-- à consulter les utilisateurs d'une entreprise dont il est membre.
create function prive.peut_voir_profil(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user = auth.uid() or exists (
    select 1 from public.membres cible
    where cible.user_id = p_user
      and prive.a_permission(cible.organisation_id, 'utilisateurs.consulter')
  )
$$;

-- ---------------------------------------------------------------------
-- Déclencheurs : horodatage, audit, création de profil
-- ---------------------------------------------------------------------

create function prive.tg_maj_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create function prive.tg_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ligne jsonb := coalesce(to_jsonb(new), to_jsonb(old));
  v_org uuid;
  v_motif text := nullif(current_setting('app.motif', true), '');
begin
  v_org := case when tg_table_name = 'organisations' then (ligne ->> 'id')::uuid
                else (ligne ->> 'organisation_id')::uuid end;
  -- Une mise à jour qui ne change que l'horodatage technique n'est pas tracée
  -- (la connexion est déjà journalisée par enregistrer_connexion).
  if tg_op = 'UPDATE'
     and (to_jsonb(old) - 'updated_at' - 'derniere_connexion')
       = (to_jsonb(new) - 'updated_at' - 'derniere_connexion') then
    return new;
  end if;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, avant, apres, contexte)
  values (
    v_org,
    auth.uid(),
    tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    coalesce(ligne ->> 'id', ligne ->> 'membre_id'),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
    case when v_motif is not null then jsonb_build_object('motif', v_motif) end
  );
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['organisations','magasins','caisses','profils','membres'] loop
    execute format('create trigger %I before update on public.%I
                    for each row execute function prive.tg_maj_updated_at()', t || '_updated_at', t);
  end loop;
  foreach t in array array['organisations','magasins','caisses','membres','membre_magasins',
                           'membre_caisses','membre_permissions','invitations'] loop
    execute format('create trigger %I after insert or update or delete on public.%I
                    for each row execute function prive.tg_audit()', t || '_audit', t);
  end loop;
end $$;

create function prive.tg_nouvel_utilisateur() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profils (id, nom_complet, email)
  values (new.id, nullif(btrim(new.raw_user_meta_data ->> 'nom_complet'), ''), lower(new.email))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger sur_creation_utilisateur
  after insert on auth.users
  for each row execute function prive.tg_nouvel_utilisateur();

-- ---------------------------------------------------------------------
-- Sécurité au niveau des lignes (RLS)
-- ---------------------------------------------------------------------

alter table public.roles              enable row level security;
alter table public.permissions        enable row level security;
alter table public.role_permissions   enable row level security;
alter table public.organisations      enable row level security;
alter table public.magasins           enable row level security;
alter table public.caisses            enable row level security;
alter table public.profils            enable row level security;
alter table public.membres            enable row level security;
alter table public.membre_magasins    enable row level security;
alter table public.membre_caisses     enable row level security;
alter table public.membre_permissions enable row level security;
alter table public.invitations        enable row level security;
alter table public.journal_audit      enable row level security;

create policy referentiel_lecture on public.roles            for select to authenticated using (true);
create policy referentiel_lecture on public.permissions      for select to authenticated using (true);
create policy referentiel_lecture on public.role_permissions for select to authenticated using (true);

create policy lecture on public.organisations for select to authenticated
  using (prive.est_membre(id));
create policy modification on public.organisations for update to authenticated
  using (prive.a_permission(id, 'administration.modifier'))
  with check (prive.a_permission(id, 'administration.modifier'));

create policy lecture on public.magasins for select to authenticated
  using (prive.acces_magasin(organisation_id, id)
         or prive.a_permission(organisation_id, 'magasins.modifier')
         or prive.a_permission(organisation_id, 'utilisateurs.modifier'));
create policy creation on public.magasins for insert to authenticated
  with check (prive.a_permission(organisation_id, 'magasins.creer'));
create policy modification on public.magasins for update to authenticated
  using (prive.a_permission(organisation_id, 'magasins.modifier')
         and prive.acces_magasin(organisation_id, id))
  with check (prive.a_permission(organisation_id, 'magasins.modifier')
              and prive.acces_magasin(organisation_id, id));

create policy lecture on public.caisses for select to authenticated
  using (prive.acces_magasin(organisation_id, magasin_id)
         or prive.a_permission(organisation_id, 'magasins.modifier')
         or prive.a_permission(organisation_id, 'utilisateurs.modifier'));
create policy creation on public.caisses for insert to authenticated
  with check (prive.a_permission(organisation_id, 'magasins.creer')
              and prive.acces_magasin(organisation_id, magasin_id));
create policy modification on public.caisses for update to authenticated
  using (prive.a_permission(organisation_id, 'magasins.modifier')
         and prive.acces_magasin(organisation_id, magasin_id))
  with check (prive.a_permission(organisation_id, 'magasins.modifier')
              and prive.acces_magasin(organisation_id, magasin_id));

create policy lecture on public.profils for select to authenticated
  using (prive.peut_voir_profil(id));
create policy modification on public.profils for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy lecture on public.membres for select to authenticated
  using (user_id = auth.uid() or prive.a_permission(organisation_id, 'utilisateurs.consulter'));

create policy lecture on public.membre_magasins for select to authenticated
  using (prive.a_permission(organisation_id, 'utilisateurs.consulter')
         or membre_id = (prive.membre_courant(organisation_id)).id);
create policy lecture on public.membre_caisses for select to authenticated
  using (prive.a_permission(organisation_id, 'utilisateurs.consulter')
         or membre_id = (prive.membre_courant(organisation_id)).id);
create policy lecture on public.membre_permissions for select to authenticated
  using (prive.a_permission(organisation_id, 'utilisateurs.consulter')
         or membre_id = (prive.membre_courant(organisation_id)).id);

create policy lecture on public.invitations for select to authenticated
  using (prive.a_permission(organisation_id, 'utilisateurs.consulter'));

create policy lecture on public.journal_audit for select to authenticated
  using (prive.a_permission(organisation_id, 'audit.consulter'));

-- ---------------------------------------------------------------------
-- Privilèges : lecture filtrée par RLS, écritures limitées aux colonnes
-- autorisées ; tout le reste passe par les fonctions RPC.
-- ---------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
grant update (nom, ncc, regime_fiscal, telephone, adresse, ville) on public.organisations to authenticated;
grant insert (organisation_id, code, nom, adresse, ville, telephone) on public.magasins to authenticated;
grant update (code, nom, adresse, ville, telephone, actif) on public.magasins to authenticated;
grant insert (organisation_id, magasin_id, code, nom) on public.caisses to authenticated;
grant update (code, nom, actif) on public.caisses to authenticated;
grant update (nom_complet, telephone) on public.profils to authenticated;

grant usage on schema prive to authenticated;

-- ---------------------------------------------------------------------
-- Fonctions RPC (appelées par l'application)
-- ---------------------------------------------------------------------

create function prive.exiger(p_condition boolean, p_message text) returns void
language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception '%', p_message using errcode = '42501';
  end if;
end $$;

-- Vérifie qu'un appelant peut attribuer un périmètre (magasins, caisses).
create function prive.verifier_perimetre(p_org uuid, p_tous_magasins boolean, p_magasins uuid[], p_caisses uuid[])
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  appelant public.membres := prive.membre_courant(p_org);
  m uuid;
begin
  perform prive.exiger(appelant.id is not null, 'Vous n''êtes pas membre actif de cette entreprise');
  if p_tous_magasins and not (appelant.role_code = 'proprietaire' or appelant.tous_magasins) then
    raise exception 'Vous ne pouvez pas donner accès à tous les magasins' using errcode = '42501';
  end if;
  foreach m in array coalesce(p_magasins, '{}') loop
    perform prive.exiger(exists (select 1 from public.magasins where id = m and organisation_id = p_org),
                         'Magasin inconnu dans cette entreprise');
    perform prive.exiger(prive.acces_magasin(p_org, m),
                         'Vous ne pouvez attribuer que des magasins auxquels vous avez accès');
  end loop;
  foreach m in array coalesce(p_caisses, '{}') loop
    perform prive.exiger(exists (
      select 1 from public.caisses c
      where c.id = m and c.organisation_id = p_org
        and (p_tous_magasins or c.magasin_id = any(coalesce(p_magasins, '{}')))
    ), 'Chaque caisse doit appartenir à un magasin attribué');
  end loop;
end $$;

create function prive.appliquer_perimetre(p_org uuid, p_membre uuid, p_magasins uuid[], p_caisses uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.membre_magasins where membre_id = p_membre and magasin_id <> all(coalesce(p_magasins, '{}'));
  insert into public.membre_magasins (organisation_id, membre_id, magasin_id)
  select p_org, p_membre, x from unnest(coalesce(p_magasins, '{}')) x
  on conflict do nothing;
  delete from public.membre_caisses where membre_id = p_membre and caisse_id <> all(coalesce(p_caisses, '{}'));
  insert into public.membre_caisses (organisation_id, membre_id, caisse_id)
  select p_org, p_membre, x from unnest(coalesce(p_caisses, '{}')) x
  on conflict do nothing;
end $$;

create function prive.compter_proprietaires_actifs(p_org uuid) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.membres
  where organisation_id = p_org and role_code = 'proprietaire' and actif
$$;

-- Crée une entreprise, son premier magasin et sa première caisse ;
-- l'appelant en devient propriétaire.
create function public.creer_organisation(
  p_nom text,
  p_ncc text default null,
  p_regime_fiscal text default 'non_precise',
  p_telephone text default null,
  p_adresse text default null,
  p_ville text default null,
  p_nom_magasin text default 'Magasin principal'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_mag uuid;
begin
  perform prive.exiger(v_uid is not null, 'Connexion requise');
  insert into public.profils (id, email)
  select v_uid, lower(u.email) from auth.users u where u.id = v_uid
  on conflict (id) do nothing;

  insert into public.organisations (nom, ncc, regime_fiscal, telephone, adresse, ville, cree_par)
  values (btrim(p_nom), nullif(btrim(p_ncc), ''), coalesce(p_regime_fiscal, 'non_precise'),
          p_telephone, p_adresse, p_ville, v_uid)
  returning id into v_org;

  insert into public.membres (organisation_id, user_id, role_code, tous_magasins)
  values (v_org, v_uid, 'proprietaire', true);

  insert into public.magasins (organisation_id, code, nom, adresse, ville, telephone)
  values (v_org, 'MAG01', coalesce(nullif(btrim(p_nom_magasin), ''), 'Magasin principal'),
          p_adresse, p_ville, p_telephone)
  returning id into v_mag;

  insert into public.caisses (organisation_id, magasin_id, code, nom)
  values (v_org, v_mag, 'CAISSE01', 'Caisse 1');

  return v_org;
end $$;

-- Invite une personne par e-mail. Si elle a déjà un compte, elle est
-- rattachée immédiatement ; sinon à sa première connexion.
create function public.inviter_membre(
  p_org uuid,
  p_email text,
  p_role text,
  p_tous_magasins boolean default false,
  p_magasins uuid[] default '{}',
  p_caisses uuid[] default '{}'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  appelant public.membres := prive.membre_courant(p_org);
  v_email text := lower(btrim(p_email));
  v_inv uuid;
  v_user uuid;
begin
  perform prive.exiger(prive.a_permission(p_org, 'utilisateurs.creer'), 'Droit « utilisateurs.creer » requis');
  perform prive.exiger(exists (select 1 from public.roles where code = p_role), 'Rôle inconnu');
  perform prive.exiger(p_role <> 'proprietaire' or appelant.role_code = 'proprietaire',
                       'Seul un propriétaire peut nommer un autre propriétaire');
  perform prive.verifier_perimetre(p_org, coalesce(p_tous_magasins, false), p_magasins, p_caisses);
  perform prive.exiger(not exists (
    select 1 from public.membres m join auth.users u on u.id = m.user_id
    where m.organisation_id = p_org and lower(u.email) = v_email and m.actif
  ), 'Cette personne est déjà membre active de l''entreprise');

  update public.invitations set statut = 'annulee', traitee_le = now()
  where organisation_id = p_org and email = v_email and statut = 'en_attente';

  insert into public.invitations (organisation_id, email, role_code, tous_magasins, magasins, caisses, invite_par)
  values (p_org, v_email, p_role, coalesce(p_tous_magasins, false),
          coalesce(p_magasins, '{}'), coalesce(p_caisses, '{}'), auth.uid())
  returning id into v_inv;

  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is not null then
    perform prive.accepter_invitation(v_inv, v_user);
  end if;
  return v_inv;
end $$;

create function prive.accepter_invitation(p_invitation uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  inv public.invitations;
  v_membre uuid;
begin
  select * into inv from public.invitations where id = p_invitation and statut = 'en_attente' for update;
  if not found then return; end if;

  insert into public.profils (id, email)
  select p_user, lower(u.email) from auth.users u where u.id = p_user
  on conflict (id) do nothing;

  insert into public.membres (organisation_id, user_id, role_code, tous_magasins)
  values (inv.organisation_id, p_user, inv.role_code, inv.tous_magasins)
  on conflict (organisation_id, user_id) do update
    set role_code = excluded.role_code,
        tous_magasins = excluded.tous_magasins,
        actif = true,
        motif_desactivation = null,
        desactive_le = null,
        desactive_par = null
  returning id into v_membre;

  -- Ne garde que les magasins et caisses encore valides.
  perform prive.appliquer_perimetre(
    inv.organisation_id, v_membre,
    array(select x from unnest(inv.magasins) x
          where exists (select 1 from public.magasins mg where mg.id = x and mg.organisation_id = inv.organisation_id)),
    array(select x from unnest(inv.caisses) x
          where exists (select 1 from public.caisses c where c.id = x and c.organisation_id = inv.organisation_id))
  );

  update public.invitations set statut = 'acceptee', traitee_le = now() where id = inv.id;
end $$;

-- À appeler après chaque connexion : rattache les invitations en attente.
create function public.accepter_invitations() returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_inv uuid;
  n int := 0;
begin
  perform prive.exiger(v_uid is not null, 'Connexion requise');
  select lower(email) into v_email from auth.users where id = v_uid;
  for v_inv in
    select i.id from public.invitations i
    join public.organisations o on o.id = i.organisation_id and o.actif
    where i.email = v_email and i.statut = 'en_attente'
    order by i.created_at
  loop
    perform prive.accepter_invitation(v_inv, v_uid);
    n := n + 1;
  end loop;
  return n;
end $$;

create function public.annuler_invitation(p_invitation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select organisation_id into v_org from public.invitations where id = p_invitation and statut = 'en_attente';
  perform prive.exiger(v_org is not null, 'Invitation introuvable ou déjà traitée');
  perform prive.exiger(prive.a_permission(v_org, 'utilisateurs.modifier'), 'Droit « utilisateurs.modifier » requis');
  update public.invitations set statut = 'annulee', traitee_le = now() where id = p_invitation;
end $$;

-- Contrôles communs à toute action sur un membre existant.
create function prive.charger_membre_cible(p_membre uuid, p_permission text) returns public.membres
language plpgsql security definer set search_path = '' as $$
declare
  cible public.membres;
  appelant public.membres;
begin
  select * into cible from public.membres where id = p_membre for update;
  perform prive.exiger(found, 'Membre introuvable');
  appelant := prive.membre_courant(cible.organisation_id);
  perform prive.exiger(prive.permission_du_membre(appelant, p_permission),
                       format('Droit « %s » requis', p_permission));
  perform prive.exiger(cible.user_id <> auth.uid(), 'Vous ne pouvez pas modifier vos propres droits');
  perform prive.exiger(cible.role_code <> 'proprietaire' or appelant.role_code = 'proprietaire',
                       'Seul un propriétaire peut modifier un propriétaire');
  return cible;
end $$;

create function public.modifier_membre(
  p_membre uuid,
  p_role text,
  p_tous_magasins boolean,
  p_magasins uuid[] default '{}',
  p_caisses uuid[] default '{}'
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  cible public.membres := prive.charger_membre_cible(p_membre, 'utilisateurs.modifier');
  appelant public.membres := prive.membre_courant(cible.organisation_id);
begin
  perform prive.exiger(exists (select 1 from public.roles where code = p_role), 'Rôle inconnu');
  perform prive.exiger(p_role <> 'proprietaire' or appelant.role_code = 'proprietaire',
                       'Seul un propriétaire peut nommer un autre propriétaire');
  if cible.role_code = 'proprietaire' and p_role <> 'proprietaire' and cible.actif then
    perform prive.exiger(prive.compter_proprietaires_actifs(cible.organisation_id) > 1,
                         'L''entreprise doit garder au moins un propriétaire actif');
  end if;
  perform prive.verifier_perimetre(cible.organisation_id, coalesce(p_tous_magasins, false), p_magasins, p_caisses);

  update public.membres set role_code = p_role, tous_magasins = coalesce(p_tous_magasins, false)
  where id = cible.id;
  perform prive.appliquer_perimetre(cible.organisation_id, cible.id, p_magasins, p_caisses);
end $$;

-- Désactivation : l'accès aux données est coupé immédiatement par RLS,
-- l'historique de la personne est conservé.
create function public.desactiver_membre(p_membre uuid, p_motif text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  cible public.membres := prive.charger_membre_cible(p_membre, 'utilisateurs.modifier');
begin
  perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Un motif de désactivation est obligatoire');
  perform prive.exiger(cible.actif, 'Ce membre est déjà désactivé');
  if cible.role_code = 'proprietaire' then
    perform prive.exiger(prive.compter_proprietaires_actifs(cible.organisation_id) > 1,
                         'L''entreprise doit garder au moins un propriétaire actif');
  end if;
  perform set_config('app.motif', btrim(p_motif), true);
  update public.membres
     set actif = false, motif_desactivation = btrim(p_motif),
         desactive_le = now(), desactive_par = auth.uid()
   where id = cible.id;
  perform set_config('app.motif', '', true);
end $$;

create function public.reactiver_membre(p_membre uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  cible public.membres := prive.charger_membre_cible(p_membre, 'utilisateurs.modifier');
begin
  perform prive.exiger(not cible.actif, 'Ce membre est déjà actif');
  update public.membres
     set actif = true, motif_desactivation = null, desactive_le = null, desactive_par = null
   where id = cible.id;
end $$;

-- Ajoute (true), retire (false) ou remet par défaut (null) un droit individuel.
create function public.definir_permission_membre(p_membre uuid, p_permission text, p_accorde boolean)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  cible public.membres := prive.charger_membre_cible(p_membre, 'utilisateurs.modifier');
begin
  perform prive.exiger(exists (select 1 from public.permissions where code = p_permission), 'Permission inconnue');
  perform prive.exiger(prive.a_permission(cible.organisation_id, p_permission),
                       'Vous ne pouvez pas déléguer un droit que vous n''avez pas');
  if p_accorde is null then
    delete from public.membre_permissions where membre_id = cible.id and permission_code = p_permission;
  else
    insert into public.membre_permissions (organisation_id, membre_id, permission_code, accorde)
    values (cible.organisation_id, cible.id, p_permission, p_accorde)
    on conflict (membre_id, permission_code) do update set accorde = excluded.accorde;
  end if;
end $$;

-- Trace la connexion dans chaque entreprise dont l'utilisateur est membre actif.
create function public.enregistrer_connexion(p_appareil text default null, p_user_agent text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  perform prive.exiger(v_uid is not null, 'Connexion requise');
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  select m.organisation_id, v_uid, 'session.connexion', 'membres', m.id::text,
         jsonb_strip_nulls(jsonb_build_object('appareil', left(p_appareil, 120), 'navigateur', left(p_user_agent, 300)))
  from public.membres m where m.user_id = v_uid and m.actif;
  update public.membres set derniere_connexion = now() where user_id = v_uid and actif;
end $$;

create function public.enregistrer_deconnexion() returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
  select m.organisation_id, v_uid, 'session.deconnexion', 'membres', m.id::text
  from public.membres m where m.user_id = v_uid and m.actif;
end $$;

-- Entreprises accessibles à l'utilisateur, avec son rôle et ses droits effectifs.
create function public.mes_organisations()
returns table (
  organisation_id uuid,
  nom text,
  membre_id uuid,
  role_code text,
  role_libelle text,
  tous_magasins boolean,
  permissions text[]
)
language sql stable security definer set search_path = '' as $$
  select o.id, o.nom, m.id, m.role_code, r.libelle, (m.tous_magasins or m.role_code = 'proprietaire'),
         prive.permissions_effectives(m.id)
  from public.membres m
  join public.organisations o on o.id = m.organisation_id and o.actif
  join public.roles r on r.code = m.role_code
  where m.user_id = auth.uid() and m.actif
  order by o.nom
$$;

revoke all on function
  public.creer_organisation(text, text, text, text, text, text, text),
  public.inviter_membre(uuid, text, text, boolean, uuid[], uuid[]),
  public.accepter_invitations(),
  public.annuler_invitation(uuid),
  public.modifier_membre(uuid, text, boolean, uuid[], uuid[]),
  public.desactiver_membre(uuid, text),
  public.reactiver_membre(uuid),
  public.definir_permission_membre(uuid, text, boolean),
  public.enregistrer_connexion(text, text),
  public.enregistrer_deconnexion(),
  public.mes_organisations()
from public, anon;

grant execute on function
  public.creer_organisation(text, text, text, text, text, text, text),
  public.inviter_membre(uuid, text, text, boolean, uuid[], uuid[]),
  public.accepter_invitations(),
  public.annuler_invitation(uuid),
  public.modifier_membre(uuid, text, boolean, uuid[], uuid[]),
  public.desactiver_membre(uuid, text),
  public.reactiver_membre(uuid),
  public.definir_permission_membre(uuid, text, boolean),
  public.enregistrer_connexion(text, text),
  public.enregistrer_deconnexion(),
  public.mes_organisations()
to authenticated;

-- Fonctions internes : retirées à PUBLIC ; seules celles appelées par les
-- politiques RLS restent exécutables par les utilisateurs connectés.
revoke all on all functions in schema prive from public;
grant execute on function
  prive.membre_courant(uuid),
  prive.est_membre(uuid),
  prive.permission_du_membre(public.membres, text),
  prive.a_permission(uuid, text),
  prive.acces_magasin(uuid, uuid),
  prive.permissions_effectives(uuid),
  prive.peut_voir_profil(uuid)
to authenticated;
