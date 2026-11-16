-- =====================================================================
-- v3.5 — DF Marché : les boutiques DF Gestion en ligne, sur un même site.
--
--   * Vitrine de chaque boutique : présentation, photos, localisation, contact,
--     horaires, numéros Wave / Orange Money / MTN / Moov de la boutique.
--   * Catalogue en ligne : les produits publiés, avec le prix (solde compris) et le
--     stock disponible lus en direct dans DF Gestion.
--   * Commandes : le client choisit sa boutique, remplit son panier, choisit la
--     livraison (zone, adresse, heure) ou le retrait, puis le paiement :
--       - à la livraison ;
--       - ou directement sur le numéro Mobile Money de la boutique : il indique le
--         numéro qui a payé et joint la capture du paiement.
--     Aucun paiement ne transite par DF Marché et aucun code secret n'est demandé.
--   * La boutique confirme, prépare, livre ; à la livraison, la commande est
--     encaissée dans une caisse ouverte (vente normale : stock, reçu, comptabilité).
--   * Avis : seul un client dont la commande a été livrée peut noter les produits.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Droits et module « boutique »
-- ---------------------------------------------------------------------

insert into public.permissions (code, module, action)
select 'boutique.' || a, 'boutique', a
from unnest(array['consulter','creer','modifier','valider','annuler','supprimer','exporter','cloturer','administrer']) a
on conflict do nothing;

insert into public.role_permissions (role_code, permission_code)
select r, 'boutique.' || a
from (values ('proprietaire', array['consulter','creer','modifier','valider','annuler','supprimer','exporter','cloturer']),
             ('gerant_magasin', array['consulter','creer','modifier','valider','annuler','exporter']),
             ('responsable_caisse', array['consulter','valider']),
             ('caissier', array['consulter']),
             ('vendeur', array['consulter']),
             ('auditeur', array['consulter'])) x(r, actions),
     unnest(x.actions) a
on conflict do nothing;

alter table public.organisations drop constraint organisations_modules_ck;
alter table public.organisations add constraint organisations_modules_ck check (
  modules_desactives <@ array['stock','achats','fournisseurs','budget','tresorerie','rentabilite','promotions','comptabilite','boutique']::text[]
  and modules_bloques <@ modules_desactives);

do $$
declare d text := pg_get_functiondef('prive.normaliser_modules(text[])'::regprocedure);
  a text := 'array[''stock'',''achats'',''fournisseurs'',''budget'',''tresorerie'',''rentabilite'',''promotions'',''comptabilite'']::text[]';
begin
  if position(a in d) = 0 then raise exception 'normaliser_modules : liste introuvable'; end if;
  execute replace(d, a, 'array[''stock'',''achats'',''fournisseurs'',''budget'',''tresorerie'',''rentabilite'',''promotions'',''comptabilite'',''boutique'']::text[]');
end $$;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------

create table public.vitrines (
  organisation_id    uuid primary key references public.organisations(id),
  slug               text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  publiee            boolean not null default false,
  magasin_id         uuid not null,
  nom                text not null check (length(btrim(nom)) between 2 and 80),
  activite           text check (activite is null or length(activite) <= 60),
  slogan             text check (slogan is null or length(slogan) <= 140),
  description        text check (description is null or length(description) <= 2000),
  telephone          text check (telephone is null or telephone ~ '^[0-9 +]{8,20}$'),
  whatsapp           text check (whatsapp is null or whatsapp ~ '^[0-9 +]{8,20}$'),
  email              text check (email is null or length(email) <= 120),
  ville              text check (ville is null or length(ville) <= 60),
  commune            text check (commune is null or length(commune) <= 60),
  adresse            text check (adresse is null or length(adresse) <= 200),
  latitude           numeric(9,6) check (latitude is null or latitude between -90 and 90),
  longitude          numeric(9,6) check (longitude is null or longitude between -180 and 180),
  horaires           text check (horaires is null or length(horaires) <= 300),
  photos             text[] not null default '{}' check (cardinality(photos) <= 6),
  -- Paiement : à la livraison et/ou directement sur les numéros de la boutique.
  paiement_livraison boolean not null default true,
  numero_wave        text check (numero_wave is null or numero_wave ~ '^[0-9 +]{8,20}$'),
  numero_orange      text check (numero_orange is null or numero_orange ~ '^[0-9 +]{8,20}$'),
  numero_mtn         text check (numero_mtn is null or numero_mtn ~ '^[0-9 +]{8,20}$'),
  numero_moov        text check (numero_moov is null or numero_moov ~ '^[0-9 +]{8,20}$'),
  beneficiaire       text check (beneficiaire is null or length(beneficiaire) <= 80),
  -- Remise de la commande.
  retrait            boolean not null default true,
  livraison          boolean not null default true,
  delai_preparation  smallint not null default 2 check (delai_preparation between 0 and 168),
  commande_minimum   bigint not null default 0 check (commande_minimum >= 0),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (organisation_id, magasin_id) references public.magasins(organisation_id, id),
  check (paiement_livraison or numero_wave is not null or numero_orange is not null or numero_mtn is not null or numero_moov is not null),
  check (retrait or livraison)
);

create table public.zones_livraison (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  nom             text not null check (length(btrim(nom)) between 2 and 60),
  frais           bigint not null default 0 check (frais >= 0),
  delai           text check (delai is null or length(delai) <= 60),
  actif           boolean not null default true,
  ordre           smallint not null default 100,
  unique (organisation_id, id)
);
create unique index zones_livraison_nom on public.zones_livraison (organisation_id, lower(btrim(nom)));

alter table public.produits
  add column en_ligne boolean not null default false,
  add column description_web text check (description_web is null or length(description_web) <= 3000);
create index produits_en_ligne_idx on public.produits (organisation_id) where en_ligne;

create table public.commandes_web (
  id                 uuid primary key default gen_random_uuid(),
  organisation_id    uuid not null references public.organisations(id),
  magasin_id         uuid not null,
  numero             text not null,
  code_suivi         text not null unique,
  client_nom         text not null check (length(btrim(client_nom)) between 2 and 80),
  client_telephone   text not null check (client_telephone ~ '^[0-9 +]{8,20}$'),
  client_email       text check (client_email is null or length(client_email) <= 120),
  mode               text not null check (mode in ('livraison','retrait')),
  zone_id            uuid,
  zone_nom           text,
  adresse            text check (adresse is null or length(adresse) <= 200),
  repere             text check (repere is null or length(repere) <= 200),
  latitude           numeric(9,6),
  longitude          numeric(9,6),
  souhaite_le        timestamptz,
  note               text check (note is null or length(note) <= 500),
  sous_total         bigint not null default 0,
  frais_livraison    bigint not null default 0,
  total              bigint not null default 0,
  paiement           text not null check (paiement in ('livraison','wave','orange_money','mtn','moov')),
  numero_payeur      text check (numero_payeur is null or numero_payeur ~ '^[0-9 +]{8,20}$'),
  reference_paiement text check (reference_paiement is null or length(reference_paiement) <= 60),
  justificatif_path  text,
  paiement_statut    text not null default 'a_verifier'
                     check (paiement_statut in ('a_la_livraison','a_verifier','confirme','refuse')),
  statut             text not null default 'nouvelle'
                     check (statut in ('nouvelle','confirmee','prete','en_livraison','livree','annulee')),
  motif              text check (motif is null or length(motif) <= 300),
  vente_id           uuid,
  traitee_par        uuid,
  created_at         timestamptz not null default now(),
  confirmee_le       timestamptz,
  prete_le           timestamptz,
  expediee_le        timestamptz,
  livree_le          timestamptz,
  annulee_le         timestamptz,
  unique (organisation_id, numero),
  unique (organisation_id, id),
  foreign key (organisation_id, magasin_id) references public.magasins(organisation_id, id),
  check (mode = 'retrait' or adresse is not null)
);
create index commandes_web_org_idx on public.commandes_web (organisation_id, statut, created_at desc);
create index commandes_web_tel_idx on public.commandes_web (client_telephone, created_at desc);

create table public.commandes_web_lignes (
  organisation_id uuid not null,
  commande_id     uuid not null references public.commandes_web(id) on delete cascade,
  ligne           smallint not null,
  produit_id      uuid not null,
  designation     text not null,
  quantite        numeric(14,3) not null check (quantite > 0),
  prix_unitaire   bigint not null check (prix_unitaire >= 0),
  prix_normal     bigint not null,
  montant         bigint not null,
  primary key (commande_id, ligne),
  foreign key (organisation_id, produit_id) references public.produits(organisation_id, id)
);
create index commandes_web_lignes_produit on public.commandes_web_lignes (produit_id);

create table public.avis_produits (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  produit_id      uuid not null,
  commande_id     uuid not null references public.commandes_web(id) on delete cascade,
  note            smallint not null check (note between 1 and 5),
  commentaire     text check (commentaire is null or length(commentaire) <= 600),
  auteur          text not null,
  masque          boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (commande_id, produit_id),
  foreign key (organisation_id, produit_id) references public.produits(organisation_id, id)
);
create index avis_produits_produit on public.avis_produits (produit_id) where not masque;

-- ---------------------------------------------------------------------
-- 3. Outils internes
-- ---------------------------------------------------------------------

create function prive.jour_abidjan() returns date
language sql stable as $$ select (now() at time zone 'Africa/Abidjan')::date $$;

-- Produit visible sur DF Marché : publié, actif, dans une vitrine publiée d'une entreprise active
-- dont le module « boutique » n'est pas retiré.
create function prive.produit_public(p public.produits) returns boolean
language sql stable security definer set search_path = '' as $$
  select p.en_ligne and p.statut = 'actif' and exists (
    select 1 from public.vitrines v join public.organisations o on o.id = v.organisation_id
     where v.organisation_id = p.organisation_id and v.publiee and o.actif
       and not ('boutique' = any (o.modules_desactives)))
$$;

-- Quantité encore réservée par des commandes en cours (ni livrées, ni annulées).
create function prive.quantite_reservee(p_magasin uuid, p_produit uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.quantite), 0)
    from public.commandes_web_lignes l join public.commandes_web c on c.id = l.commande_id
   where c.magasin_id = p_magasin and l.produit_id = p_produit
     and c.statut in ('nouvelle','confirmee','prete','en_livraison')
$$;

create function prive.disponible_en_ligne(p_magasin uuid, p_produit uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select greatest(0, coalesce((select quantite from public.stocks where magasin_id = p_magasin and produit_id = p_produit), 0)
                     - prive.quantite_reservee(p_magasin, p_produit))
$$;

-- Fiche publique d'un produit (pour les listes).
create function prive.produit_marche(p public.produits, v public.vitrines) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'designation', p.designation, 'marque', p.marque, 'unite', p.unite, 'photo', p.photo_path,
    'categorie', (select c.nom from public.categories c where c.id = p.categorie_id),
    'prix', coalesce(pr.prix_promo, p.prix_vente), 'prix_normal', p.prix_vente,
    'solde_fin', pr.date_fin,
    'disponible', prive.disponible_en_ligne(v.magasin_id, p.id),
    'boutique', jsonb_build_object('slug', v.slug, 'nom', v.nom, 'commune', v.commune, 'ville', v.ville),
    'note', (select round(avg(a.note), 1) from public.avis_produits a where a.produit_id = p.id and not a.masque),
    'avis', (select count(*) from public.avis_produits a where a.produit_id = p.id and not a.masque),
    'commandes', (select count(distinct l.commande_id) from public.commandes_web_lignes l
                    join public.commandes_web c on c.id = l.commande_id
                   where l.produit_id = p.id and c.statut <> 'annulee'))
  from (select min(prix_promo) prix_promo, min(date_fin) date_fin from public.promotions
         where organisation_id = p.organisation_id and produit_id = p.id and statut = 'active'
           and prive.jour_abidjan() between date_debut and date_fin) pr
$$;

create function prive.vitrine_publique(v public.vitrines) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'slug', v.slug, 'nom', v.nom, 'activite', v.activite, 'slogan', v.slogan, 'description', v.description,
    'telephone', v.telephone, 'whatsapp', v.whatsapp, 'email', v.email, 'ville', v.ville, 'commune', v.commune,
    'adresse', v.adresse, 'latitude', v.latitude, 'longitude', v.longitude, 'horaires', v.horaires, 'photos', v.photos,
    'logo', o.logo_path, 'couleur', o.couleur,
    'paiement_livraison', v.paiement_livraison, 'numero_wave', v.numero_wave, 'numero_orange', v.numero_orange,
    'numero_mtn', v.numero_mtn, 'numero_moov', v.numero_moov, 'beneficiaire', coalesce(v.beneficiaire, v.nom),
    'retrait', v.retrait, 'livraison', v.livraison, 'delai_preparation', v.delai_preparation,
    'commande_minimum', v.commande_minimum,
    'produits', (select count(*) from public.produits p where p.organisation_id = v.organisation_id and p.en_ligne and p.statut = 'actif'),
    'commandes', (select count(*) from public.commandes_web c where c.organisation_id = v.organisation_id and c.statut = 'livree'),
    'note', (select round(avg(a.note), 1) from public.avis_produits a where a.organisation_id = v.organisation_id and not a.masque),
    'avis', (select count(*) from public.avis_produits a where a.organisation_id = v.organisation_id and not a.masque),
    'zones', coalesce((select jsonb_agg(jsonb_build_object('id', z.id, 'nom', z.nom, 'frais', z.frais, 'delai', z.delai) order by z.ordre, z.nom)
                         from public.zones_livraison z where z.organisation_id = v.organisation_id and z.actif), '[]'::jsonb))
  from public.organisations o where o.id = v.organisation_id
$$;

create function prive.vitrine_ouverte(p_slug text) returns public.vitrines
language plpgsql stable security definer set search_path = '' as $$
declare v public.vitrines;
begin
  select vt.* into v from public.vitrines vt join public.organisations o on o.id = vt.organisation_id
   where vt.slug = lower(btrim(p_slug)) and vt.publiee and o.actif and not ('boutique' = any (o.modules_desactives));
  if not found then raise exception 'Boutique introuvable' using errcode = 'P0001'; end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- 4. Site public (anonyme)
-- ---------------------------------------------------------------------

create function prive.vitrines_ouvertes() returns setof public.vitrines
language sql stable security definer set search_path = '' as $$
  select vt.* from public.vitrines vt join public.organisations o on o.id = vt.organisation_id
   where vt.publiee and o.actif and not ('boutique' = any (o.modules_desactives))
$$;

-- Page d'accueil : soldes en cours (bannières), boutiques, nouveautés, meilleures ventes.
create function public.marche_accueil() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'soldes', coalesce((
      select jsonb_agg(x.f order by x.remise desc) from (
        select distinct on (pm.produit_id) prive.produit_marche(p0, v0) f,
               (pm.prix_normal - pm.prix_promo)::numeric / nullif(pm.prix_normal, 0) remise
          from public.promotions pm
          join public.produits p0 on p0.id = pm.produit_id and p0.en_ligne and p0.statut = 'actif'
          join prive.vitrines_ouvertes() v0 on v0.organisation_id = pm.organisation_id
         where pm.statut = 'active' and prive.jour_abidjan() between pm.date_debut and pm.date_fin
         order by pm.produit_id, pm.prix_promo
         limit 40) x), '[]'::jsonb),
    'boutiques', coalesce((select jsonb_agg(prive.vitrine_publique(v) - 'zones' - 'description' order by v.nom)
                             from prive.vitrines_ouvertes() v), '[]'::jsonb),
    'nouveautes', coalesce((select jsonb_agg(x.f order by x.created_at desc) from (
                              select prive.produit_marche(p0, v0) f, p0.created_at
                                from public.produits p0 join prive.vitrines_ouvertes() v0 on v0.organisation_id = p0.organisation_id
                               where p0.en_ligne and p0.statut = 'actif' order by p0.created_at desc limit 12) x), '[]'::jsonb),
    'populaires', coalesce((select jsonb_agg(prive.produit_marche(p0, v0) order by x.n desc)
                              from (select l.produit_id, count(distinct l.commande_id) n from public.commandes_web_lignes l
                                      join public.commandes_web c on c.id = l.commande_id and c.statut <> 'annulee'
                                     group by l.produit_id order by 2 desc limit 12) x
                              join public.produits p0 on p0.id = x.produit_id and p0.en_ligne and p0.statut = 'actif'
                              join prive.vitrines_ouvertes() v0 on v0.organisation_id = p0.organisation_id), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(distinct c.nom)
                              from public.produits p0 join prive.vitrines_ouvertes() v0 on v0.organisation_id = p0.organisation_id
                              join public.categories c on c.id = p0.categorie_id
                             where p0.en_ligne and p0.statut = 'actif'), '[]'::jsonb),
    'activites', coalesce((select jsonb_agg(distinct v.activite) from prive.vitrines_ouvertes() v where v.activite is not null), '[]'::jsonb))
$$;

-- Recherche dans tout le marché ou dans une boutique.
create function public.marche_produits(p_texte text default null, p_boutique text default null, p_categorie text default null,
                                       p_soldes boolean default false, p_tri text default 'pertinence',
                                       p_limite int default 48, p_decalage int default 0) returns jsonb
language sql stable security definer set search_path = '' as $$
  with f as (select prive.produit_marche(p, v) j, p.created_at, p.designation
               from public.produits p join prive.vitrines_ouvertes() v on v.organisation_id = p.organisation_id
               left join public.categories c on c.id = p.categorie_id
              where p.en_ligne and p.statut = 'actif'
                and (p_boutique is null or v.slug = lower(p_boutique))
                and (p_texte is null or btrim(p_texte) = ''
                     or prive.normaliser(p.designation || ' ' || coalesce(p.marque, '') || ' ' || coalesce(c.nom, '') || ' ' || v.nom)
                        like '%' || prive.normaliser(btrim(p_texte)) || '%')
                and (p_categorie is null or c.nom = p_categorie)),
       g as (select * from f where not p_soldes or (j ->> 'prix')::bigint < (j ->> 'prix_normal')::bigint)
  select jsonb_build_object(
    'total', (select count(*) from g),
    'produits', coalesce((select jsonb_agg(x.j) from (
       select j from g
        order by case when p_tri = 'prix_croissant' then (j ->> 'prix')::bigint end asc nulls last,
                 case when p_tri = 'prix_decroissant' then (j ->> 'prix')::bigint end desc nulls last,
                 case when p_tri = 'nouveautes' then created_at end desc nulls last,
                 ((j ->> 'disponible')::numeric > 0) desc, (j ->> 'commandes')::int desc, designation
        limit least(greatest(p_limite, 1), 96) offset greatest(p_decalage, 0)) x), '[]'::jsonb))
$$;

create function public.marche_boutique(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.vitrines := prive.vitrine_ouverte(p_slug);
begin
  return prive.vitrine_publique(v) || jsonb_build_object(
    'categories', coalesce((select jsonb_agg(distinct c.nom) from public.produits p join public.categories c on c.id = p.categorie_id
                             where p.organisation_id = v.organisation_id and p.en_ligne and p.statut = 'actif'), '[]'::jsonb),
    'derniers_avis', coalesce((select jsonb_agg(jsonb_build_object('auteur', a.auteur, 'note', a.note, 'commentaire', a.commentaire,
                                                                   'date', a.created_at, 'produit', p.designation) order by a.created_at desc)
                                 from (select * from public.avis_produits where organisation_id = v.organisation_id and not masque
                                        order by created_at desc limit 6) a
                                 join public.produits p on p.id = a.produit_id), '[]'::jsonb));
end $$;

create function public.marche_produit(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p public.produits;
  v public.vitrines;
begin
  select * into p from public.produits where id = p_id;
  if not found or not prive.produit_public(p) then raise exception 'Produit introuvable' using errcode = 'P0001'; end if;
  select * into v from public.vitrines where organisation_id = p.organisation_id;
  return prive.produit_marche(p, v) || jsonb_build_object(
    'description', p.description_web, 'code', p.code,
    'vitrine', prive.vitrine_publique(v) - 'description',
    'avis_liste', coalesce((select jsonb_agg(jsonb_build_object('auteur', a.auteur, 'note', a.note, 'commentaire', a.commentaire,
                                                                'date', a.created_at) order by a.created_at desc)
                              from public.avis_produits a where a.produit_id = p.id and not a.masque), '[]'::jsonb),
    'similaires', coalesce((select jsonb_agg(prive.produit_marche(s, v)) from (
                              select * from public.produits s
                               where s.organisation_id = p.organisation_id and s.en_ligne and s.statut = 'actif' and s.id <> p.id
                               order by (s.categorie_id is not distinct from p.categorie_id) desc, s.created_at desc limit 8) s), '[]'::jsonb));
end $$;

-- Passer une commande. Les prix, les frais et la disponibilité sont recalculés ici :
-- rien de ce que le navigateur envoie n'est pris pour argent comptant.
--   p = { boutique, client_nom, client_telephone, client_email, mode, zone_id, adresse, repere,
--         latitude, longitude, souhaite_le, note, paiement, numero_payeur, reference_paiement,
--         lignes: [{ produit_id, quantite }] }
create function public.passer_commande(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.vitrines;
  z public.zones_livraison;
  c public.commandes_web;
  l jsonb;
  pr public.produits;
  n smallint := 0;
  v_q numeric;
  v_prix bigint;
  v_dispo numeric;
  v_sous_total bigint := 0;
  v_mode text := p ->> 'mode';
  v_paiement text := p ->> 'paiement';
  v_tel text := regexp_replace(coalesce(p ->> 'client_telephone', ''), '[^0-9+]', '', 'g');
  v_numero text;
  v_code text;
  v_souhaite timestamptz := nullif(p ->> 'souhaite_le', '')::timestamptz;
begin
  v := prive.vitrine_ouverte(p ->> 'boutique');
  perform prive.exiger(length(btrim(coalesce(p ->> 'client_nom', ''))) between 2 and 80, 'Indiquez votre nom');
  perform prive.exiger(length(v_tel) between 8 and 15, 'Indiquez un numéro de téléphone valide');
  perform prive.exiger(v_mode in ('livraison','retrait'), 'Choisissez la livraison ou le retrait en boutique');
  perform prive.exiger(v_mode <> 'livraison' or v.livraison, 'Cette boutique ne livre pas : choisissez le retrait');
  perform prive.exiger(v_mode <> 'retrait' or v.retrait, 'Cette boutique ne propose que la livraison');
  perform prive.exiger(v_paiement in ('livraison','wave','orange_money','mtn','moov'), 'Choisissez un moyen de paiement');
  perform prive.exiger(v_paiement <> 'livraison' or v.paiement_livraison, 'Cette boutique demande le paiement à la commande');
  perform prive.exiger(case v_paiement when 'wave' then v.numero_wave when 'orange_money' then v.numero_orange
                                       when 'mtn' then v.numero_mtn when 'moov' then v.numero_moov else 'ok' end is not null,
                       'Ce moyen de paiement n''est pas proposé par la boutique');
  perform prive.exiger(v_paiement = 'livraison' or length(regexp_replace(coalesce(p ->> 'numero_payeur', ''), '[^0-9]', '', 'g')) >= 8,
                       'Indiquez le numéro qui a effectué le paiement');
  perform prive.exiger(v_souhaite is null or v_souhaite > now() - interval '1 hour', 'L''heure souhaitée est déjà passée');
  perform prive.exiger(v_souhaite is null or v_souhaite < now() + interval '30 days', 'Date souhaitée trop lointaine');
  -- Garde-fou contre les abus : 5 commandes en attente au plus par numéro et par boutique.
  perform prive.exiger((select count(*) from public.commandes_web
                         where organisation_id = v.organisation_id and client_telephone = v_tel
                           and statut = 'nouvelle' and created_at > now() - interval '1 day') < 5,
                       'Vous avez déjà plusieurs commandes en attente dans cette boutique : elle vous contactera');
  perform prive.exiger(jsonb_array_length(coalesce(p -> 'lignes', '[]')) between 1 and 40, 'Votre panier est vide');

  if v_mode = 'livraison' then
    select * into z from public.zones_livraison
     where id = (p ->> 'zone_id')::uuid and organisation_id = v.organisation_id and actif;
    perform prive.exiger(found, 'Choisissez votre zone de livraison');
    perform prive.exiger(length(btrim(coalesce(p ->> 'adresse', ''))) >= 3, 'Indiquez l''adresse de livraison');
  end if;

  v_numero := 'W-' || lpad(prive.prochain_numero(v.organisation_id, 'commande_web')::text, 6, '0');
  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when length(v_code) = 8 and not exists (select 1 from public.commandes_web where code_suivi = v_code);
  end loop;

  insert into public.commandes_web (organisation_id, magasin_id, numero, code_suivi, client_nom, client_telephone, client_email,
                                    mode, zone_id, zone_nom, adresse, repere, latitude, longitude, souhaite_le, note,
                                    paiement, numero_payeur, reference_paiement, paiement_statut)
  values (v.organisation_id, v.magasin_id, v_numero, v_code, btrim(p ->> 'client_nom'), v_tel, nullif(btrim(p ->> 'client_email'), ''),
          v_mode, z.id, z.nom, nullif(btrim(p ->> 'adresse'), ''), nullif(btrim(p ->> 'repere'), ''),
          nullif(p ->> 'latitude', '')::numeric, nullif(p ->> 'longitude', '')::numeric, v_souhaite, nullif(btrim(p ->> 'note'), ''),
          v_paiement, nullif(regexp_replace(coalesce(p ->> 'numero_payeur', ''), '[^0-9+]', '', 'g'), ''),
          nullif(btrim(p ->> 'reference_paiement'), ''),
          case when v_paiement = 'livraison' then 'a_la_livraison' else 'a_verifier' end)
  returning * into c;

  for l in select * from jsonb_array_elements(p -> 'lignes') loop
    select * into pr from public.produits where id = (l ->> 'produit_id')::uuid and organisation_id = v.organisation_id for update;
    perform prive.exiger(found and prive.produit_public(pr), 'Un article du panier n''est plus en vente');
    v_q := (l ->> 'quantite')::numeric;
    perform prive.exiger(v_q > 0 and v_q <= 1000 and (v_q = trunc(v_q) or pr.unite not in ('pièce','piece')), 'Quantité invalide');
    v_dispo := prive.disponible_en_ligne(v.magasin_id, pr.id);
    perform prive.exiger(v_q <= v_dispo,
      case when v_dispo <= 0 then format('« %s » est en rupture de stock', pr.designation)
           else format('Il ne reste que %s « %s »', trim(to_char(v_dispo, 'FM999G999D###')), pr.designation) end);
    v_prix := coalesce(prive.prix_promo(v.organisation_id, pr.id, prive.jour_abidjan()), pr.prix_vente);
    perform prive.exiger(v_prix > 0, format('« %s » n''a pas de prix', pr.designation));
    n := n + 1;
    insert into public.commandes_web_lignes (organisation_id, commande_id, ligne, produit_id, designation, quantite,
                                             prix_unitaire, prix_normal, montant)
    values (v.organisation_id, c.id, n, pr.id, pr.designation, v_q, v_prix, pr.prix_vente, round(v_q * v_prix));
    v_sous_total := v_sous_total + round(v_q * v_prix);
  end loop;
  perform prive.exiger(v_sous_total >= v.commande_minimum,
                       format('Commande minimum de %s F dans cette boutique', v.commande_minimum));

  update public.commandes_web
     set sous_total = v_sous_total, frais_livraison = coalesce(z.frais, 0), total = v_sous_total + coalesce(z.frais, 0)
   where id = c.id returning * into c;

  return jsonb_build_object('id', c.id, 'numero', c.numero, 'code_suivi', c.code_suivi, 'sous_total', c.sous_total,
                            'frais_livraison', c.frais_livraison, 'total', c.total,
                            'boutique', jsonb_build_object('nom', v.nom, 'whatsapp', coalesce(v.whatsapp, v.telephone),
                                                           'telephone', v.telephone, 'slug', v.slug));
end $$;

-- Suivi d'une commande avec son code (communiqué au client).
create function public.marche_suivi(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.commandes_web;
  v public.vitrines;
begin
  select * into c from public.commandes_web where code_suivi = upper(btrim(p_code));
  if not found then raise exception 'Aucune commande avec ce code' using errcode = 'P0001'; end if;
  select * into v from public.vitrines where organisation_id = c.organisation_id;
  return jsonb_build_object(
    'id', c.id, 'numero', c.numero, 'code_suivi', c.code_suivi, 'statut', c.statut, 'paiement', c.paiement,
    'paiement_statut', c.paiement_statut, 'mode', c.mode, 'zone', c.zone_nom, 'adresse', c.adresse, 'souhaite_le', c.souhaite_le,
    'client_nom', c.client_nom, 'sous_total', c.sous_total, 'frais_livraison', c.frais_livraison, 'total', c.total,
    'justificatif', c.justificatif_path is not null, 'motif', c.motif,
    'dates', jsonb_build_object('passee', c.created_at, 'confirmee', c.confirmee_le, 'prete', c.prete_le,
                                'expediee', c.expediee_le, 'livree', c.livree_le, 'annulee', c.annulee_le),
    'boutique', jsonb_build_object('nom', v.nom, 'slug', v.slug, 'telephone', v.telephone, 'whatsapp', coalesce(v.whatsapp, v.telephone),
                                   'adresse', v.adresse, 'commune', v.commune, 'beneficiaire', coalesce(v.beneficiaire, v.nom),
                                   'numero_paiement', case c.paiement when 'wave' then v.numero_wave when 'orange_money' then v.numero_orange
                                                                      when 'mtn' then v.numero_mtn when 'moov' then v.numero_moov end),
    'lignes', (select jsonb_agg(jsonb_build_object('produit_id', l.produit_id, 'designation', l.designation, 'quantite', l.quantite,
                                                   'prix_unitaire', l.prix_unitaire, 'montant', l.montant,
                                                   'avis', (select a.note from public.avis_produits a
                                                             where a.commande_id = c.id and a.produit_id = l.produit_id)) order by l.ligne)
                 from public.commandes_web_lignes l where l.commande_id = c.id));
end $$;

-- Capture du paiement : déposée par le client (espace « justificatifs », dossier = identifiant de la commande),
-- puis rattachée à la commande.
create function public.joindre_justificatif(p_code text, p_chemin text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.commandes_web;
begin
  select * into c from public.commandes_web where code_suivi = upper(btrim(p_code)) for update;
  perform prive.exiger(found, 'Aucune commande avec ce code');
  perform prive.exiger(c.statut not in ('livree','annulee') and c.paiement <> 'livraison', 'Cette commande n''attend pas de justificatif');
  perform prive.exiger(split_part(p_chemin, '/', 1) = c.id::text and p_chemin !~ '\.\.', 'Fichier invalide');
  perform prive.exiger(exists (select 1 from storage.objects where bucket_id = 'justificatifs' and name = p_chemin),
                       'Le fichier n''a pas été reçu');
  update public.commandes_web set justificatif_path = p_chemin,
         paiement_statut = case when paiement_statut = 'refuse' then 'a_verifier' else paiement_statut end
   where id = c.id;
end $$;

-- Avis : seulement après livraison, une fois par produit commandé.
create function public.deposer_avis(p_code text, p_produit uuid, p_note int, p_commentaire text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.commandes_web;
begin
  select * into c from public.commandes_web where code_suivi = upper(btrim(p_code));
  perform prive.exiger(found, 'Aucune commande avec ce code');
  perform prive.exiger(c.statut = 'livree', 'Vous pourrez donner votre avis une fois la commande reçue');
  perform prive.exiger(exists (select 1 from public.commandes_web_lignes where commande_id = c.id and produit_id = p_produit),
                       'Ce produit ne fait pas partie de la commande');
  perform prive.exiger(p_note between 1 and 5, 'Note de 1 à 5 étoiles');
  insert into public.avis_produits (organisation_id, produit_id, commande_id, note, commentaire, auteur)
  values (c.organisation_id, p_produit, c.id, p_note, nullif(left(btrim(coalesce(p_commentaire, '')), 600), ''),
          -- Prénom et initiale seulement : « Awa K. »
          initcap(split_part(btrim(c.client_nom), ' ', 1))
            || coalesce(' ' || upper(left(nullif(split_part(btrim(c.client_nom), ' ', 2), ''), 1)) || '.', ''))
  on conflict (commande_id, produit_id) do update set note = excluded.note, commentaire = excluded.commentaire, created_at = now();
end $$;

-- ---------------------------------------------------------------------
-- 5. Espaces de fichiers : couvertures de vitrine (public), justificatifs (privé),
--    photos des produits publiés lisibles par tous.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vitrines', 'vitrines', true, 1048576, array['image/png','image/jpeg','image/webp']),
       ('justificatifs', 'justificatifs', false, 2097152, array['image/png','image/jpeg','image/webp','application/pdf'])
on conflict (id) do nothing;

create function prive.photo_publique(p_nom text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.produits p where p.photo_path = p_nom and prive.produit_public(p))
$$;
create function prive.justificatif_attendu(p_nom text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.commandes_web c
                  where c.id::text = split_part(p_nom, '/', 1) and c.paiement <> 'livraison'
                    and c.statut not in ('livree','annulee') and c.created_at > now() - interval '3 days')
$$;
create function prive.organisation_commande(p_nom text) returns uuid
language sql stable security definer set search_path = '' as $$
  select c.organisation_id from public.commandes_web c where c.id::text = split_part(p_nom, '/', 1)
$$;
grant execute on function prive.photo_publique(text), prive.justificatif_attendu(text), prive.organisation_commande(text)
  to anon, authenticated;

create policy df_photos_marche on storage.objects for select to anon, authenticated
  using (bucket_id = 'produits' and prive.photo_publique(name));
create policy df_vitrines_ecriture on storage.objects for insert to authenticated
  with check (bucket_id = 'vitrines' and prive.a_permission(prive.organisation_du_chemin(name), 'boutique.modifier'));
create policy df_vitrines_modification on storage.objects for update to authenticated
  using (bucket_id = 'vitrines' and prive.a_permission(prive.organisation_du_chemin(name), 'boutique.modifier'));
create policy df_vitrines_suppression on storage.objects for delete to authenticated
  using (bucket_id = 'vitrines' and prive.a_permission(prive.organisation_du_chemin(name), 'boutique.modifier'));
create policy df_justificatifs_depot on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'justificatifs' and prive.justificatif_attendu(name));
create policy df_justificatifs_lecture on storage.objects for select to authenticated
  using (bucket_id = 'justificatifs' and prive.a_permission(prive.organisation_commande(name), 'boutique.consulter'));

-- ---------------------------------------------------------------------
-- 6. Côté boutique (DF Gestion)
-- ---------------------------------------------------------------------

create function public.vitrine_lire(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.vitrines;
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.consulter'), 'Droit « boutique.consulter » requis');
  select * into v from public.vitrines where organisation_id = p_org;
  return jsonb_build_object(
    'vitrine', case when found then to_jsonb(v) end,
    'zones', coalesce((select jsonb_agg(to_jsonb(z) order by z.ordre, z.nom) from public.zones_livraison z where z.organisation_id = p_org), '[]'::jsonb),
    'produits', (select jsonb_build_object('publies', count(*) filter (where en_ligne and statut = 'actif'),
                                           'actifs', count(*) filter (where statut = 'actif'),
                                           'sans_photo', count(*) filter (where en_ligne and statut = 'actif' and photo_path is null))
                   from public.produits where organisation_id = p_org),
    'slug_propose', coalesce(v.slug, (select left(trim(both '-' from regexp_replace(lower(extensions.unaccent(o.nom)), '[^a-z0-9]+', '-', 'g')), 40)
                                        from public.organisations o where o.id = p_org)));
end $$;

create function public.vitrine_enregistrer(p_org uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.vitrines;
  v_slug text := lower(btrim(coalesce(p ->> 'slug', '')));
  num text;
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.modifier'), 'Droit « boutique.modifier » requis');
  perform prive.exiger(v_slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$',
                       'Adresse de la boutique : 3 à 40 lettres minuscules, chiffres ou tirets');
  perform prive.exiger(not exists (select 1 from public.vitrines where slug = v_slug and organisation_id <> p_org),
                       'Cette adresse est déjà prise par une autre boutique');
  perform prive.exiger(exists (select 1 from public.magasins where id = (p ->> 'magasin_id')::uuid and organisation_id = p_org and actif),
                       'Choisissez le magasin qui prépare les commandes');
  insert into public.vitrines (organisation_id, slug, publiee, magasin_id, nom, activite, slogan, description, telephone, whatsapp, email,
                               ville, commune, adresse, latitude, longitude, horaires, photos, paiement_livraison,
                               numero_wave, numero_orange, numero_mtn, numero_moov, beneficiaire, retrait, livraison,
                               delai_preparation, commande_minimum)
  select p_org, v_slug, coalesce((p ->> 'publiee')::boolean, false), (p ->> 'magasin_id')::uuid, btrim(p ->> 'nom'),
         nullif(btrim(p ->> 'activite'), ''), nullif(btrim(p ->> 'slogan'), ''), nullif(btrim(p ->> 'description'), ''),
         nullif(btrim(p ->> 'telephone'), ''), nullif(btrim(p ->> 'whatsapp'), ''), nullif(btrim(p ->> 'email'), ''),
         nullif(btrim(p ->> 'ville'), ''), nullif(btrim(p ->> 'commune'), ''), nullif(btrim(p ->> 'adresse'), ''),
         nullif(p ->> 'latitude', '')::numeric, nullif(p ->> 'longitude', '')::numeric, nullif(btrim(p ->> 'horaires'), ''),
         coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'photos') x
                    where prive.organisation_du_chemin(x) = p_org), '{}'),
         coalesce((p ->> 'paiement_livraison')::boolean, true),
         nullif(btrim(p ->> 'numero_wave'), ''), nullif(btrim(p ->> 'numero_orange'), ''),
         nullif(btrim(p ->> 'numero_mtn'), ''), nullif(btrim(p ->> 'numero_moov'), ''), nullif(btrim(p ->> 'beneficiaire'), ''),
         coalesce((p ->> 'retrait')::boolean, true), coalesce((p ->> 'livraison')::boolean, true),
         coalesce((p ->> 'delai_preparation')::smallint, 2), coalesce((p ->> 'commande_minimum')::bigint, 0)
  on conflict (organisation_id) do update set
    slug = excluded.slug, publiee = excluded.publiee, magasin_id = excluded.magasin_id, nom = excluded.nom, activite = excluded.activite,
    slogan = excluded.slogan, description = excluded.description, telephone = excluded.telephone, whatsapp = excluded.whatsapp,
    email = excluded.email, ville = excluded.ville, commune = excluded.commune, adresse = excluded.adresse,
    latitude = excluded.latitude, longitude = excluded.longitude, horaires = excluded.horaires, photos = excluded.photos,
    paiement_livraison = excluded.paiement_livraison, numero_wave = excluded.numero_wave, numero_orange = excluded.numero_orange,
    numero_mtn = excluded.numero_mtn, numero_moov = excluded.numero_moov, beneficiaire = excluded.beneficiaire,
    retrait = excluded.retrait, livraison = excluded.livraison, delai_preparation = excluded.delai_preparation,
    commande_minimum = excluded.commande_minimum, updated_at = now()
  returning * into v;
  perform prive.exiger(not v.publiee or v.telephone is not null or v.whatsapp is not null,
                       'Indiquez un téléphone ou un WhatsApp avant de publier la boutique');
  perform prive.exiger(not v.publiee or not v.livraison
                       or exists (select 1 from public.zones_livraison where organisation_id = p_org and actif),
                       'Ajoutez au moins une zone de livraison, ou proposez seulement le retrait');
  return to_jsonb(v);
end $$;

create function public.zone_livraison_enregistrer(p_org uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.modifier'), 'Droit « boutique.modifier » requis');
  if p ->> 'id' is null then
    insert into public.zones_livraison (organisation_id, nom, frais, delai, actif, ordre)
    values (p_org, btrim(p ->> 'nom'), coalesce((p ->> 'frais')::bigint, 0), nullif(btrim(p ->> 'delai'), ''),
            coalesce((p ->> 'actif')::boolean, true), coalesce((p ->> 'ordre')::smallint, 100))
    returning id into v_id;
  else
    update public.zones_livraison set nom = btrim(p ->> 'nom'), frais = coalesce((p ->> 'frais')::bigint, 0),
           delai = nullif(btrim(p ->> 'delai'), ''), actif = coalesce((p ->> 'actif')::boolean, true)
     where id = (p ->> 'id')::uuid and organisation_id = p_org returning id into v_id;
    perform prive.exiger(v_id is not null, 'Zone introuvable');
  end if;
  return v_id;
end $$;

-- Produits à publier : liste avec stock du magasin de la vitrine.
create function public.vitrine_produits(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_mag uuid := (select magasin_id from public.vitrines where organisation_id = p_org);
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.consulter'), 'Droit « boutique.consulter » requis');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'code', p.code, 'designation', p.designation, 'categorie', c.nom, 'prix_vente', p.prix_vente,
      'prix', coalesce(prive.prix_promo(p_org, p.id, prive.jour_abidjan()), p.prix_vente),
      'photo', p.photo_path, 'en_ligne', p.en_ligne, 'description_web', p.description_web,
      'stock', coalesce((select s.quantite from public.stocks s where s.magasin_id = v_mag and s.produit_id = p.id), 0),
      'disponible', case when v_mag is null then 0 else prive.disponible_en_ligne(v_mag, p.id) end,
      'commandes', (select count(distinct l.commande_id) from public.commandes_web_lignes l join public.commandes_web cw on cw.id = l.commande_id
                     where l.produit_id = p.id and cw.statut <> 'annulee'))
      order by p.en_ligne desc, p.designation)
    from public.produits p left join public.categories c on c.id = p.categorie_id
   where p.organisation_id = p_org and p.statut = 'actif'), '[]'::jsonb);
end $$;

create function public.publier_produits(p_org uuid, p_produits uuid[], p_en_ligne boolean) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.modifier'), 'Droit « boutique.modifier » requis');
  update public.produits set en_ligne = p_en_ligne
   where organisation_id = p_org and id = any (p_produits) and (not p_en_ligne or statut = 'actif');
  get diagnostics n = row_count;
  return n;
end $$;

create function public.description_produit_web(p_produit uuid, p_texte text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select organisation_id from public.produits where id = p_produit);
begin
  perform prive.exiger(v_org is not null and prive.a_permission(v_org, 'boutique.modifier'), 'Droit « boutique.modifier » requis');
  update public.produits set description_web = nullif(btrim(p_texte), '') where id = p_produit;
end $$;

-- Liste des commandes reçues.
create function public.commandes_web_liste(p_org uuid, p_statut text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.consulter'), 'Droit « boutique.consulter » requis');
  return jsonb_build_object(
    'compteurs', (select jsonb_object_agg(statut, n) from (select statut, count(*) n from public.commandes_web
                                                          where organisation_id = p_org group by statut) x),
    'a_verifier', (select count(*) from public.commandes_web where organisation_id = p_org and paiement_statut = 'a_verifier'
                     and statut not in ('annulee','livree')),
    'commandes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'numero', c.numero, 'client_nom', c.client_nom, 'client_telephone', c.client_telephone, 'mode', c.mode,
        'zone', c.zone_nom, 'souhaite_le', c.souhaite_le, 'total', c.total, 'paiement', c.paiement, 'paiement_statut', c.paiement_statut,
        'justificatif', c.justificatif_path is not null, 'statut', c.statut, 'created_at', c.created_at,
        'articles', (select coalesce(sum(quantite), 0) from public.commandes_web_lignes where commande_id = c.id))
        order by case c.statut when 'nouvelle' then 0 when 'confirmee' then 1 when 'prete' then 2 when 'en_livraison' then 3 else 4 end,
                 c.created_at desc)
      from (select * from public.commandes_web where organisation_id = p_org
              and (p_statut is null or statut = p_statut
                   or (p_statut = 'en_cours' and statut in ('nouvelle','confirmee','prete','en_livraison')))
             order by created_at desc limit 300) c), '[]'::jsonb));
end $$;

create function public.commande_web_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.commandes_web;
begin
  select * into c from public.commandes_web where id = p_id;
  perform prive.exiger(found and prive.a_permission(c.organisation_id, 'boutique.consulter'), 'Commande introuvable');
  return to_jsonb(c) || jsonb_build_object(
    'lignes', (select jsonb_agg(jsonb_build_object('produit_id', l.produit_id, 'designation', l.designation, 'quantite', l.quantite,
                                                   'prix_unitaire', l.prix_unitaire, 'prix_normal', l.prix_normal, 'montant', l.montant,
                                                   'stock', coalesce((select s.quantite from public.stocks s
                                                                       where s.magasin_id = c.magasin_id and s.produit_id = l.produit_id), 0))
                                order by l.ligne) from public.commandes_web_lignes l where l.commande_id = c.id),
    'vente', (select jsonb_build_object('id', ve.id, 'numero', ve.numero) from public.ventes ve where ve.id = c.vente_id),
    'commandes_client', (select count(*) from public.commandes_web where organisation_id = c.organisation_id
                           and client_telephone = c.client_telephone and statut = 'livree'),
    'numero_boutique', (select case c.paiement when 'wave' then v.numero_wave when 'orange_money' then v.numero_orange
                                                when 'mtn' then v.numero_mtn when 'moov' then v.numero_moov end
                          from public.vitrines v where v.organisation_id = c.organisation_id));
end $$;

-- Nombre de commandes à traiter (pastille du menu, alerte).
create function public.commandes_web_a_traiter(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when prive.a_permission(p_org, 'boutique.consulter') then jsonb_build_object(
    'nouvelles', (select count(*) from public.commandes_web where organisation_id = p_org and statut = 'nouvelle'),
    'derniere', (select max(created_at) from public.commandes_web where organisation_id = p_org))
  else jsonb_build_object('nouvelles', 0) end
$$;

-- Avancement : nouvelle → confirmée → prête → en livraison ; annulation possible avant la livraison.
-- La livraison se termine par l'encaissement (encaisser_commande_web).
create function public.avancer_commande_web(p_id uuid, p_statut text, p_motif text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.commandes_web;
begin
  select * into c from public.commandes_web where id = p_id for update;
  perform prive.exiger(found and prive.a_permission(c.organisation_id, 'boutique.valider'), 'Droit « boutique.valider » requis');
  perform prive.exiger(prive.acces_magasin(c.organisation_id, c.magasin_id), 'Cette commande concerne un autre magasin');
  perform prive.exiger(c.statut not in ('livree','annulee'), 'Cette commande est terminée');
  if p_statut = 'annulee' then
    perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Indiquez le motif de l''annulation (il sera visible par le client)');
    update public.commandes_web set statut = 'annulee', motif = btrim(p_motif), annulee_le = now(), traitee_par = auth.uid()
     where id = p_id returning * into c;
  else
    perform prive.exiger(
      (c.statut = 'nouvelle' and p_statut = 'confirmee') or (c.statut = 'confirmee' and p_statut = 'prete')
      or (c.statut = 'prete' and p_statut = 'en_livraison' and c.mode = 'livraison'),
      'Étape non permise');
    perform prive.exiger(p_statut <> 'en_livraison' or c.paiement_statut in ('confirme','a_la_livraison'),
                         'Vérifiez d''abord le paiement reçu');
    update public.commandes_web set statut = p_statut, traitee_par = auth.uid(),
           confirmee_le = case when p_statut = 'confirmee' then now() else confirmee_le end,
           prete_le = case when p_statut = 'prete' then now() else prete_le end,
           expediee_le = case when p_statut = 'en_livraison' then now() else expediee_le end
     where id = p_id returning * into c;
  end if;
  return to_jsonb(c);
end $$;

-- Paiement direct (Wave, Orange Money…) : la boutique vérifie sur son téléphone et confirme ou refuse.
create function public.verifier_paiement_commande(p_id uuid, p_recu boolean, p_motif text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.commandes_web;
begin
  select * into c from public.commandes_web where id = p_id for update;
  perform prive.exiger(found and prive.a_permission(c.organisation_id, 'boutique.valider'), 'Droit « boutique.valider » requis');
  perform prive.exiger(c.paiement <> 'livraison', 'Paiement prévu à la livraison');
  perform prive.exiger(c.statut not in ('livree','annulee'), 'Cette commande est terminée');
  perform prive.exiger(p_recu or length(btrim(coalesce(p_motif, ''))) >= 3, 'Indiquez ce qui ne va pas (visible par le client)');
  update public.commandes_web set paiement_statut = case when p_recu then 'confirme' else 'refuse' end,
         motif = case when p_recu then motif else btrim(p_motif) end, traitee_par = auth.uid()
   where id = p_id returning * into c;
  return to_jsonb(c);
end $$;

-- Remise au client : la commande devient une vente dans la caisse ouverte de la personne qui encaisse
-- (stock, reçu, comptabilité).
-- Les frais de livraison ne sont pas une marchandise : ils restent sur la commande.
create function public.encaisser_commande_web(p_id uuid, p_session uuid, p_moyen uuid default null, p_reference text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.commandes_web;
  s public.sessions_caisse;
  v_moyen uuid := p_moyen;
  v_vente uuid := gen_random_uuid();
  v_lignes jsonb;
  r jsonb;
begin
  select * into c from public.commandes_web where id = p_id for update;
  -- À la caisse : la personne qui tient la caisse encaisse (droit « boutique.consulter » + vente).
  perform prive.exiger(found and prive.a_permission(c.organisation_id, 'boutique.consulter'), 'Droit « boutique.consulter » requis');
  perform prive.exiger(c.statut in ('confirmee','prete','en_livraison'), 'Confirmez la commande avant de la remettre');
  perform prive.exiger(c.vente_id is null, 'Commande déjà encaissée');
  perform prive.exiger(c.paiement = 'livraison' or c.paiement_statut = 'confirme', 'Le paiement n''est pas encore confirmé');
  select * into s from public.sessions_caisse where id = p_session and organisation_id = c.organisation_id;
  perform prive.exiger(found and s.statut = 'ouverte', 'Ouvrez une caisse pour encaisser la commande');
  perform prive.exiger(s.magasin_id = c.magasin_id, 'La caisse doit être celle du magasin de la commande');
  if v_moyen is null then
    select id into v_moyen from public.moyens_paiement
     where organisation_id = c.organisation_id and actif
       and code = case c.paiement when 'wave' then 'wave' when 'orange_money' then 'orange_money' when 'mtn' then 'mtn_momo'
                                  when 'moov' then 'moov_money' else 'especes' end;
  end if;
  perform prive.exiger(v_moyen is not null, 'Choisissez le moyen de règlement');

  -- Prix de la commande : catalogue ou solde encore valable ; sinon le prix du catalogue avec une remise.
  select jsonb_agg(jsonb_build_object(
           'produit_id', l.produit_id, 'quantite', l.quantite,
           'prix_unitaire', case when l.prix_unitaire = p.prix_vente
                                   or l.prix_unitaire = prive.prix_promo(c.organisation_id, p.id, prive.jour_abidjan())
                                 then l.prix_unitaire else p.prix_vente end,
           'remise', case when l.prix_unitaire = p.prix_vente
                            or l.prix_unitaire = prive.prix_promo(c.organisation_id, p.id, prive.jour_abidjan())
                          then 0 else greatest(0, round(l.quantite * p.prix_vente) - l.montant) end) order by l.ligne)
    into v_lignes
    from public.commandes_web_lignes l join public.produits p on p.id = l.produit_id
   where l.commande_id = c.id;

  r := public.enregistrer_vente(jsonb_build_object(
         'id', v_vente, 'organisation_id', c.organisation_id, 'session_id', s.id, 'caisse_id', s.caisse_id,
         'origine', 'en_ligne', 'client_nom', c.client_nom || ' (' || c.numero || ')',
         'lignes', v_lignes,
         'reglements', jsonb_build_array(jsonb_build_object(
            'moyen_id', v_moyen, 'montant', c.sous_total,
            'reference', coalesce(nullif(btrim(p_reference), ''), c.reference_paiement, c.numero_payeur, c.numero)))));
  update public.commandes_web set vente_id = v_vente, statut = 'livree', livree_le = now(), traitee_par = auth.uid(),
         paiement_statut = 'confirme'
   where id = c.id;
  return r;
end $$;

create function public.masquer_avis(p_avis uuid, p_masque boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select organisation_id from public.avis_produits where id = p_avis);
begin
  perform prive.exiger(v_org is not null and prive.a_permission(v_org, 'boutique.valider'), 'Droit « boutique.valider » requis');
  update public.avis_produits set masque = p_masque where id = p_avis;
end $$;

-- ---------------------------------------------------------------------
-- 7. Sécurité : RLS et privilèges
-- ---------------------------------------------------------------------

alter table public.vitrines enable row level security;
alter table public.zones_livraison enable row level security;
alter table public.commandes_web enable row level security;
alter table public.commandes_web_lignes enable row level security;
alter table public.avis_produits enable row level security;

create policy lecture on public.vitrines for select to authenticated using (prive.est_membre(organisation_id));
create policy lecture on public.zones_livraison for select to authenticated using (prive.est_membre(organisation_id));
create policy lecture on public.commandes_web for select to authenticated
  using (prive.a_permission(organisation_id, 'boutique.consulter'));
create policy lecture on public.commandes_web_lignes for select to authenticated
  using (prive.a_permission(organisation_id, 'boutique.consulter'));
create policy lecture on public.avis_produits for select to authenticated
  using (prive.a_permission(organisation_id, 'boutique.consulter'));

revoke all on public.vitrines, public.zones_livraison, public.commandes_web, public.commandes_web_lignes, public.avis_produits
  from anon, authenticated;
grant select on public.vitrines, public.zones_livraison, public.commandes_web, public.commandes_web_lignes, public.avis_produits
  to authenticated;

revoke all on function
  prive.jour_abidjan(), prive.produit_public(public.produits), prive.quantite_reservee(uuid, uuid), prive.disponible_en_ligne(uuid, uuid),
  prive.produit_marche(public.produits, public.vitrines), prive.vitrine_publique(public.vitrines), prive.vitrine_ouverte(text),
  prive.vitrines_ouvertes()
from public, anon, authenticated;

revoke all on function
  public.marche_accueil(), public.marche_produits(text, text, text, boolean, text, int, int), public.marche_boutique(text),
  public.marche_produit(uuid), public.passer_commande(jsonb), public.marche_suivi(text), public.joindre_justificatif(text, text),
  public.deposer_avis(text, uuid, int, text)
from public;
grant execute on function
  public.marche_accueil(), public.marche_produits(text, text, text, boolean, text, int, int), public.marche_boutique(text),
  public.marche_produit(uuid), public.passer_commande(jsonb), public.marche_suivi(text), public.joindre_justificatif(text, text),
  public.deposer_avis(text, uuid, int, text)
to anon, authenticated;

revoke all on function
  public.vitrine_lire(uuid), public.vitrine_enregistrer(uuid, jsonb), public.zone_livraison_enregistrer(uuid, jsonb),
  public.vitrine_produits(uuid), public.publier_produits(uuid, uuid[], boolean), public.description_produit_web(uuid, text),
  public.commandes_web_liste(uuid, text), public.commande_web_detail(uuid), public.commandes_web_a_traiter(uuid),
  public.avancer_commande_web(uuid, text, text), public.verifier_paiement_commande(uuid, boolean, text),
  public.encaisser_commande_web(uuid, uuid, uuid, text), public.masquer_avis(uuid, boolean)
from public, anon;
grant execute on function
  public.vitrine_lire(uuid), public.vitrine_enregistrer(uuid, jsonb), public.zone_livraison_enregistrer(uuid, jsonb),
  public.vitrine_produits(uuid), public.publier_produits(uuid, uuid[], boolean), public.description_produit_web(uuid, text),
  public.commandes_web_liste(uuid, text), public.commande_web_detail(uuid), public.commandes_web_a_traiter(uuid),
  public.avancer_commande_web(uuid, text, text), public.verifier_paiement_commande(uuid, boolean, text),
  public.encaisser_commande_web(uuid, uuid, uuid, text), public.masquer_avis(uuid, boolean)
to authenticated;
