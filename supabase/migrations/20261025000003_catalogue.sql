-- =====================================================================
-- Migration 003 : catalogue et codes-barres
--   * catégories (sous-catégories possibles) ;
--   * produits : code interne automatique, prix en FCFA entiers, TVA, seuils ;
--   * plusieurs codes-barres par produit, uniques dans l'entreprise ;
--   * génération de codes EAN-13 internes (préfixe 20, réservé par GS1
--     à l'usage interne des magasins) pour les articles sans code ;
--   * historique automatique des prix ; recherche par code ou par nom.
-- =====================================================================

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- Normalisation pour la recherche : minuscules, sans accents.
create function prive.normaliser(p text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(p, '')))
$$;

-- Compteurs par entreprise (codes internes, codes-barres générés).
create table public.compteurs (
  organisation_id uuid not null references public.organisations(id),
  nom             text not null,
  valeur          bigint not null default 0,
  primary key (organisation_id, nom)
);
alter table public.compteurs enable row level security;
revoke all on public.compteurs from anon, authenticated;

create function prive.prochain_numero(p_org uuid, p_nom text) returns bigint
language sql security definer set search_path = '' as $$
  insert into public.compteurs (organisation_id, nom, valeur) values (p_org, p_nom, 1)
  on conflict (organisation_id, nom) do update set valeur = public.compteurs.valeur + 1
  returning valeur
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table public.categories (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  parent_id       uuid,
  nom             text not null check (length(btrim(nom)) between 1 and 80),
  actif           boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, parent_id) references public.categories(organisation_id, id),
  check (parent_id is null or parent_id <> id)
);
create unique index categories_nom_unique
  on public.categories (organisation_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), prive.normaliser(nom));

create table public.produits (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  code            text not null check (code ~ '^[A-Za-z0-9_.-]{1,30}$'),
  designation     text not null check (length(btrim(designation)) between 2 and 160),
  categorie_id    uuid,
  marque          text check (marque is null or length(marque) <= 80),
  unite           text not null default 'pièce' check (length(btrim(unite)) between 1 and 20),
  -- Prix de vente affiché au client (TTC), en FCFA entiers.
  prix_vente      bigint not null default 0 check (prix_vente >= 0),
  -- Prix d'achat de référence ; le coût réel viendra des réceptions (phase stock).
  prix_achat      bigint check (prix_achat is null or prix_achat >= 0),
  taux_tva        numeric(5,2) not null default 0 check (taux_tva in (0, 9, 18)),
  seuil_min       integer check (seuil_min is null or seuil_min >= 0),
  seuil_max       integer check (seuil_max is null or seuil_max >= 0),
  gere_peremption boolean not null default false,
  photo_path      text check (photo_path is null or length(photo_path) <= 300),
  statut          text not null default 'actif' check (statut in ('actif','suspendu','arrete')),
  cree_par        uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, code),
  unique (organisation_id, id),
  foreign key (organisation_id, categorie_id) references public.categories(organisation_id, id),
  check (seuil_max is null or seuil_min is null or seuil_max >= seuil_min)
);
create index produits_recherche_idx on public.produits
  using gin (prive.normaliser(designation) extensions.gin_trgm_ops);
create index produits_categorie_idx on public.produits (organisation_id, categorie_id);

create table public.codes_barres (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  produit_id      uuid not null,
  code            text not null check (code ~ '^[A-Za-z0-9.-]{3,40}$'),
  genere          boolean not null default false,
  created_at      timestamptz not null default now(),
  -- Un même code ne peut désigner qu'un seul produit dans l'entreprise.
  unique (organisation_id, code),
  foreign key (organisation_id, produit_id) references public.produits(organisation_id, id) on delete cascade
);
create index codes_barres_produit_idx on public.codes_barres (produit_id);

create table public.prix_historique (
  id              bigint generated always as identity primary key,
  organisation_id uuid not null,
  produit_id      uuid not null,
  prix_vente      bigint not null,
  prix_achat      bigint,
  modifie_par     uuid,
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, produit_id) references public.produits(organisation_id, id)
);
create index prix_historique_produit_idx on public.prix_historique (produit_id, created_at desc);

-- ---------------------------------------------------------------------
-- Déclencheurs
-- ---------------------------------------------------------------------

-- Code interne automatique P00001, P00002… si l'utilisateur n'en donne pas.
create function prive.tg_produit_code() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.code is null or btrim(new.code) = '' then
    loop
      new.code := 'P' || lpad(prive.prochain_numero(new.organisation_id, 'produit')::text, 5, '0');
      exit when not exists (select 1 from public.produits
                             where organisation_id = new.organisation_id and code = new.code);
    end loop;
  else
    new.code := upper(btrim(new.code));
  end if;
  new.designation := btrim(new.designation);
  if tg_op = 'INSERT' then new.cree_par := auth.uid(); end if;
  return new;
end $$;

create trigger produits_code before insert or update of code, designation on public.produits
  for each row execute function prive.tg_produit_code();

create function prive.tg_prix_historique() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.prix_vente is distinct from old.prix_vente
     or new.prix_achat is distinct from old.prix_achat then
    insert into public.prix_historique (organisation_id, produit_id, prix_vente, prix_achat, modifie_par)
    values (new.organisation_id, new.id, new.prix_vente, new.prix_achat, auth.uid());
  end if;
  return new;
end $$;

create trigger produits_prix_historique after insert or update on public.produits
  for each row execute function prive.tg_prix_historique();

create trigger categories_updated_at before update on public.categories
  for each row execute function prive.tg_maj_updated_at();
create trigger produits_updated_at before update on public.produits
  for each row execute function prive.tg_maj_updated_at();

create trigger categories_audit after insert or update or delete on public.categories
  for each row execute function prive.tg_audit();
create trigger produits_audit after insert or update or delete on public.produits
  for each row execute function prive.tg_audit();
create trigger codes_barres_audit after insert or update or delete on public.codes_barres
  for each row execute function prive.tg_audit();

create function prive.tg_code_barres_normaliser() returns trigger
language plpgsql as $$
begin
  new.code := upper(regexp_replace(new.code, '\s', '', 'g'));
  return new;
end $$;
create trigger codes_barres_normaliser before insert or update on public.codes_barres
  for each row execute function prive.tg_code_barres_normaliser();

-- ---------------------------------------------------------------------
-- RLS et privilèges
-- ---------------------------------------------------------------------

alter table public.categories      enable row level security;
alter table public.produits        enable row level security;
alter table public.codes_barres    enable row level security;
alter table public.prix_historique enable row level security;

create policy lecture on public.categories for select to authenticated
  using (prive.a_permission(organisation_id, 'catalogue.consulter'));
create policy creation on public.categories for insert to authenticated
  with check (prive.a_permission(organisation_id, 'catalogue.creer'));
create policy modification on public.categories for update to authenticated
  using (prive.a_permission(organisation_id, 'catalogue.modifier'))
  with check (prive.a_permission(organisation_id, 'catalogue.modifier'));

create policy lecture on public.produits for select to authenticated
  using (prive.a_permission(organisation_id, 'catalogue.consulter'));
create policy creation on public.produits for insert to authenticated
  with check (prive.a_permission(organisation_id, 'catalogue.creer'));
create policy modification on public.produits for update to authenticated
  using (prive.a_permission(organisation_id, 'catalogue.modifier'))
  with check (prive.a_permission(organisation_id, 'catalogue.modifier'));

create policy lecture on public.codes_barres for select to authenticated
  using (prive.a_permission(organisation_id, 'catalogue.consulter'));
create policy creation on public.codes_barres for insert to authenticated
  with check (prive.a_permission(organisation_id, 'catalogue.modifier')
              or prive.a_permission(organisation_id, 'catalogue.creer'));
create policy suppression on public.codes_barres for delete to authenticated
  using (prive.a_permission(organisation_id, 'catalogue.modifier'));

create policy lecture on public.prix_historique for select to authenticated
  using (prive.a_permission(organisation_id, 'catalogue.consulter'));

revoke all on public.categories, public.produits, public.codes_barres, public.prix_historique
  from anon, authenticated;
grant select on public.categories, public.produits, public.codes_barres, public.prix_historique to authenticated;
grant insert (organisation_id, parent_id, nom) on public.categories to authenticated;
grant update (parent_id, nom, actif) on public.categories to authenticated;
grant insert (organisation_id, code, designation, categorie_id, marque, unite, prix_vente, prix_achat,
              taux_tva, seuil_min, seuil_max, gere_peremption, photo_path)
  on public.produits to authenticated;
grant update (code, designation, categorie_id, marque, unite, prix_vente, prix_achat, taux_tva,
              seuil_min, seuil_max, gere_peremption, photo_path, statut)
  on public.produits to authenticated;
grant insert (organisation_id, produit_id, code) on public.codes_barres to authenticated;
grant delete on public.codes_barres to authenticated;

-- ---------------------------------------------------------------------
-- Fonctions RPC
-- ---------------------------------------------------------------------

-- Chiffre de contrôle EAN-13 pour 12 chiffres.
create function public.cle_ean13(p_douze text) returns text
language sql immutable set search_path = '' as $$
  select ((10 - (sum(substr(p_douze, i, 1)::int * case when i % 2 = 0 then 3 else 1 end) % 10)) % 10)::text
  from generate_series(1, 12) i
$$;

create function public.ean13_valide(p_code text) returns boolean
language sql immutable set search_path = '' as $$
  select p_code ~ '^[0-9]{13}$' and public.cle_ean13(left(p_code, 12)) = right(p_code, 1)
$$;

-- Crée et attache un code-barres EAN-13 interne (20 + 10 chiffres + clé) à un produit.
create function public.generer_code_barres(p_produit uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_douze text;
  v_code text;
begin
  select organisation_id into v_org from public.produits where id = p_produit;
  perform prive.exiger(v_org is not null, 'Produit introuvable');
  perform prive.exiger(prive.a_permission(v_org, 'catalogue.modifier') or prive.a_permission(v_org, 'catalogue.creer'),
                       'Droit « catalogue.modifier » requis');
  loop
    v_douze := '20' || lpad(prive.prochain_numero(v_org, 'ean_interne')::text, 10, '0');
    v_code := v_douze || public.cle_ean13(v_douze);
    exit when not exists (select 1 from public.codes_barres where organisation_id = v_org and code = v_code);
  end loop;
  insert into public.codes_barres (organisation_id, produit_id, code, genere)
  values (v_org, p_produit, v_code, true);
  return v_code;
end $$;

-- Recherche pour la caisse et le catalogue : un code-barres ou un code interne exact
-- passe en premier, puis les désignations contenant tous les mots saisis.
-- Fonction « invoker » : les règles RLS de l'appelant s'appliquent.
create function public.rechercher_produits(p_org uuid, p_terme text, p_limite int default 20,
                                           p_inclure_inactifs boolean default false)
returns table (
  id uuid,
  code text,
  designation text,
  marque text,
  unite text,
  prix_vente bigint,
  statut text,
  categorie_id uuid,
  codes_barres text[],
  pertinence int
)
language sql stable set search_path = '' as $$
  with terme as (
    select btrim(coalesce(p_terme, '')) as brut,
           upper(regexp_replace(coalesce(p_terme, ''), '\s', '', 'g')) as compact,
           array_remove(string_to_array(prive.normaliser(btrim(coalesce(p_terme, ''))), ' '), '') as mots
  ),
  candidats as (
    select p.*,
           case
             when exists (select 1 from public.codes_barres cb, terme t
                           where cb.produit_id = p.id and cb.code = t.compact) then 0
             when p.code = (select compact from terme) then 1
             when prive.normaliser(p.designation) like (select prive.normaliser(brut) from terme) || '%' then 2
             else 3
           end as rang
    from public.produits p, terme t
    where p.organisation_id = p_org
      and (p_inclure_inactifs or p.statut = 'actif')
      and (
        t.brut = ''
        or exists (select 1 from public.codes_barres cb where cb.produit_id = p.id and cb.code = t.compact)
        or p.code = t.compact
        or (select bool_and(prive.normaliser(p.designation || ' ' || coalesce(p.marque, '')) like '%' || m || '%')
              from unnest(t.mots) m)
      )
  )
  select c.id, c.code, c.designation, c.marque, c.unite, c.prix_vente, c.statut, c.categorie_id,
         coalesce((select array_agg(cb.code order by cb.created_at) from public.codes_barres cb where cb.produit_id = c.id), '{}'),
         c.rang
  from candidats c
  order by c.rang, c.designation
  limit greatest(1, least(coalesce(p_limite, 20), 200))
$$;

revoke all on function public.generer_code_barres(uuid), public.rechercher_produits(uuid, text, int, boolean)
  from public, anon;
grant execute on function public.generer_code_barres(uuid), public.rechercher_produits(uuid, text, int, boolean)
  to authenticated;
grant execute on function public.cle_ean13(text), public.ean13_valide(text) to authenticated;

revoke all on all functions in schema prive from public;
grant execute on function prive.normaliser(text) to authenticated;
