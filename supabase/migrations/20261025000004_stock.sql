-- =====================================================================
-- Migration 004 : stock
--   * fournisseurs (fiche simple ; dettes et paiements viendront avec les tiers) ;
--   * lots et dates de péremption ;
--   * registre des mouvements de stock, en insertion seule : aucun solde
--     n'est modifié autrement que par un mouvement traçable ;
--   * soldes par magasin et produit, valorisés au coût moyen pondéré (CMP) ;
--   * réceptions (brouillon puis validation, frais d'approche répartis) ;
--   * transferts entre magasins ; sorties et ajustements motivés ;
--   * inventaires physiques ; alertes ; état du stock.
-- Quantités en numeric(14,3) (kg, litres) ; montants en FCFA.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Fournisseurs
-- ---------------------------------------------------------------------

create table public.fournisseurs (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  nom             text not null check (length(btrim(nom)) between 2 and 120),
  telephone       text check (telephone is null or length(telephone) <= 40),
  email           text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  adresse         text check (adresse is null or length(adresse) <= 200),
  ncc             text check (ncc is null or length(ncc) <= 20),
  note            text check (note is null or length(note) <= 500),
  actif           boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, id)
);
create unique index fournisseurs_nom_unique on public.fournisseurs (organisation_id, prive.normaliser(nom));

-- ---------------------------------------------------------------------
-- Lots
-- ---------------------------------------------------------------------

create table public.lots (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  produit_id      uuid not null,
  numero          text not null default '' check (length(numero) <= 40),
  date_peremption date,
  created_at      timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, produit_id) references public.produits(organisation_id, id)
);
create unique index lots_unique on public.lots (produit_id, numero, coalesce(date_peremption, 'infinity'::date));

-- ---------------------------------------------------------------------
-- Registre des mouvements et soldes
-- ---------------------------------------------------------------------

create table public.mouvements_stock (
  id              bigint generated always as identity primary key,
  organisation_id uuid not null,
  magasin_id      uuid not null,
  produit_id      uuid not null,
  lot_id          uuid,
  type            text not null check (type in (
                    'reception','retour_client','transfert_entree','ajustement_plus','inventaire_plus',
                    'vente','retour_fournisseur','transfert_sortie','ajustement_moins','inventaire_moins',
                    'perte','casse','vol','avarie','peremption','consommation')),
  quantite        numeric(14,3) not null check (quantite <> 0),
  cout_unitaire   numeric(14,4) not null default 0 check (cout_unitaire >= 0),
  valeur          bigint not null default 0,
  quantite_apres  numeric(14,3),
  piece_type      text,
  piece_id        uuid,
  motif           text check (motif is null or length(motif) <= 300),
  cree_par        uuid,
  created_at      timestamptz not null default now(),
  cle_idempotence uuid,
  foreign key (organisation_id, magasin_id) references public.magasins(organisation_id, id),
  foreign key (organisation_id, produit_id) references public.produits(organisation_id, id),
  foreign key (organisation_id, lot_id) references public.lots(organisation_id, id),
  unique (organisation_id, cle_idempotence),
  -- Le sens de la quantité découle du type : une entrée est positive, une sortie négative.
  check (
    (type in ('reception','retour_client','transfert_entree','ajustement_plus','inventaire_plus') and quantite > 0)
    or (type not in ('reception','retour_client','transfert_entree','ajustement_plus','inventaire_plus') and quantite < 0)
  )
);
create index mouvements_produit_idx on public.mouvements_stock (organisation_id, produit_id, created_at desc);
create index mouvements_magasin_idx on public.mouvements_stock (organisation_id, magasin_id, created_at desc);
create index mouvements_piece_idx on public.mouvements_stock (piece_type, piece_id);

create table public.stocks (
  organisation_id uuid not null,
  magasin_id      uuid not null,
  produit_id      uuid not null,
  quantite        numeric(14,3) not null default 0,
  cout_moyen      numeric(14,4) not null default 0,
  derniere_entree timestamptz,
  derniere_sortie timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (magasin_id, produit_id),
  foreign key (organisation_id, magasin_id) references public.magasins(organisation_id, id),
  foreign key (organisation_id, produit_id) references public.produits(organisation_id, id)
);
create index stocks_org_idx on public.stocks (organisation_id, produit_id);

create table public.stocks_lots (
  organisation_id uuid not null,
  magasin_id      uuid not null,
  lot_id          uuid not null,
  produit_id      uuid not null,
  quantite        numeric(14,3) not null default 0,
  primary key (magasin_id, lot_id),
  foreign key (organisation_id, magasin_id) references public.magasins(organisation_id, id),
  foreign key (organisation_id, lot_id) references public.lots(organisation_id, id)
);

-- Seul point de mise à jour des soldes : chaque mouvement inséré.
-- Entrée : nouveau CMP = (Q × CMP + q × coût) / (Q + q) ; sortie : valorisée au CMP courant.
create function prive.tg_appliquer_mouvement() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  s public.stocks;
  nouveau_cmp numeric(14,4);
begin
  insert into public.stocks (organisation_id, magasin_id, produit_id)
  values (new.organisation_id, new.magasin_id, new.produit_id)
  on conflict (magasin_id, produit_id) do nothing;
  select * into s from public.stocks
   where magasin_id = new.magasin_id and produit_id = new.produit_id for update;

  if new.quantite > 0 then
    if new.cout_unitaire = 0 then
      -- Entrée sans coût connu (ajustement, inventaire, retour) : au CMP, à défaut au dernier prix d'achat.
      new.cout_unitaire := coalesce(nullif(s.cout_moyen, 0),
        (select p.prix_achat from public.produits p where p.id = new.produit_id), 0);
    end if;
    if s.quantite <= 0 then
      nouveau_cmp := new.cout_unitaire;
    else
      nouveau_cmp := round((s.quantite * s.cout_moyen + new.quantite * new.cout_unitaire) / (s.quantite + new.quantite), 4);
    end if;
    update public.stocks
       set quantite = s.quantite + new.quantite, cout_moyen = nouveau_cmp,
           derniere_entree = now(), updated_at = now()
     where magasin_id = new.magasin_id and produit_id = new.produit_id;
  else
    new.cout_unitaire := s.cout_moyen;
    update public.stocks
       set quantite = s.quantite + new.quantite, derniere_sortie = now(), updated_at = now()
     where magasin_id = new.magasin_id and produit_id = new.produit_id;
  end if;

  new.valeur := round(new.quantite * new.cout_unitaire);
  new.quantite_apres := s.quantite + new.quantite;
  new.cree_par := coalesce(new.cree_par, auth.uid());

  if new.lot_id is not null then
    insert into public.stocks_lots (organisation_id, magasin_id, lot_id, produit_id, quantite)
    values (new.organisation_id, new.magasin_id, new.lot_id, new.produit_id, new.quantite)
    on conflict (magasin_id, lot_id) do update set quantite = public.stocks_lots.quantite + excluded.quantite;
  end if;
  return new;
end $$;

create trigger mouvements_appliquer before insert on public.mouvements_stock
  for each row execute function prive.tg_appliquer_mouvement();

create function prive.tg_mouvement_immuable() returns trigger
language plpgsql as $$
begin
  raise exception 'Un mouvement de stock ne peut être ni modifié ni supprimé : enregistrez un mouvement correctif'
    using errcode = 'P0001';
end $$;
create trigger mouvements_immuables before update or delete on public.mouvements_stock
  for each row execute function prive.tg_mouvement_immuable();
create trigger mouvements_pas_de_vidage before truncate on public.mouvements_stock
  for each statement execute function prive.tg_mouvement_immuable();

-- ---------------------------------------------------------------------
-- Pièces : réceptions, transferts, inventaires
-- ---------------------------------------------------------------------

create table public.receptions (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  magasin_id      uuid not null,
  fournisseur_id  uuid,
  numero          text,
  date_reception  date not null default current_date,
  reference       text check (reference is null or length(reference) <= 60),
  frais_approche  bigint not null default 0 check (frais_approche >= 0),
  note            text check (note is null or length(note) <= 500),
  statut          text not null default 'brouillon' check (statut in ('brouillon','validee','annulee')),
  cree_par        uuid,
  valide_par      uuid,
  valide_le       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, numero),
  foreign key (organisation_id, magasin_id) references public.magasins(organisation_id, id),
  foreign key (organisation_id, fournisseur_id) references public.fournisseurs(organisation_id, id)
);

create table public.receptions_lignes (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  reception_id    uuid not null,
  produit_id      uuid not null,
  quantite        numeric(14,3) not null check (quantite > 0),
  prix_unitaire   bigint not null check (prix_unitaire >= 0),
  numero_lot      text check (numero_lot is null or length(numero_lot) <= 40),
  date_peremption date,
  cout_unitaire   numeric(14,4),
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, reception_id) references public.receptions(organisation_id, id) on delete cascade,
  foreign key (organisation_id, produit_id) references public.produits(organisation_id, id)
);
create index receptions_lignes_idx on public.receptions_lignes (reception_id);

create table public.transferts (
  id                     uuid primary key default gen_random_uuid(),
  organisation_id        uuid not null references public.organisations(id),
  numero                 text not null,
  magasin_source_id      uuid not null,
  magasin_destination_id uuid not null,
  note                   text check (note is null or length(note) <= 500),
  cree_par               uuid,
  created_at             timestamptz not null default now(),
  cle_idempotence        uuid,
  unique (organisation_id, id),
  unique (organisation_id, numero),
  unique (organisation_id, cle_idempotence),
  foreign key (organisation_id, magasin_source_id) references public.magasins(organisation_id, id),
  foreign key (organisation_id, magasin_destination_id) references public.magasins(organisation_id, id),
  check (magasin_source_id <> magasin_destination_id)
);

create table public.inventaires (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  magasin_id      uuid not null,
  numero          text not null,
  categorie_id    uuid,
  note            text check (note is null or length(note) <= 500),
  statut          text not null default 'en_cours' check (statut in ('en_cours','valide','annule')),
  cree_par        uuid,
  valide_par      uuid,
  valide_le       timestamptz,
  ecart_valeur    bigint,
  created_at      timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, numero),
  foreign key (organisation_id, magasin_id) references public.magasins(organisation_id, id),
  foreign key (organisation_id, categorie_id) references public.categories(organisation_id, id)
);
-- Un seul inventaire ouvert à la fois par magasin.
create unique index inventaires_un_ouvert on public.inventaires (magasin_id) where statut = 'en_cours';

create table public.inventaires_lignes (
  organisation_id    uuid not null,
  inventaire_id      uuid not null,
  produit_id         uuid not null,
  quantite_theorique numeric(14,3) not null default 0,
  quantite_comptee   numeric(14,3) check (quantite_comptee is null or quantite_comptee >= 0),
  quantite_systeme   numeric(14,3),
  ecart              numeric(14,3),
  ecart_valeur       bigint,
  compte_par         uuid,
  compte_le          timestamptz,
  primary key (inventaire_id, produit_id),
  foreign key (organisation_id, inventaire_id) references public.inventaires(organisation_id, id) on delete cascade,
  foreign key (organisation_id, produit_id) references public.produits(organisation_id, id)
);

-- Numéros de pièces : R-000001, TR-000001, INV-000001.
create function prive.tg_numero_reception() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.numero := 'R-' || lpad(prive.prochain_numero(new.organisation_id, 'reception')::text, 6, '0');
  new.cree_par := auth.uid();
  return new;
end $$;
create trigger receptions_numero before insert on public.receptions
  for each row execute function prive.tg_numero_reception();

create trigger fournisseurs_updated_at before update on public.fournisseurs
  for each row execute function prive.tg_maj_updated_at();
create trigger receptions_updated_at before update on public.receptions
  for each row execute function prive.tg_maj_updated_at();

create trigger fournisseurs_audit after insert or update or delete on public.fournisseurs
  for each row execute function prive.tg_audit();
create trigger receptions_audit after insert or update on public.receptions
  for each row execute function prive.tg_audit();
create trigger transferts_audit after insert on public.transferts
  for each row execute function prive.tg_audit();
create trigger inventaires_audit after insert or update on public.inventaires
  for each row execute function prive.tg_audit();

-- ---------------------------------------------------------------------
-- Fonctions d'autorisation propres au stock
-- ---------------------------------------------------------------------

create function prive.peut_stock(p_org uuid, p_magasin uuid, p_action text) returns boolean
language sql stable security definer set search_path = '' as $$
  select prive.a_permission(p_org, 'stock.' || p_action) and prive.acces_magasin(p_org, p_magasin)
$$;

-- Les réceptions relèvent aussi des achats.
create function prive.peut_reception(p_org uuid, p_magasin uuid, p_action text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (prive.a_permission(p_org, 'stock.' || p_action) or prive.a_permission(p_org, 'achats.' || p_action))
     and prive.acces_magasin(p_org, p_magasin)
$$;

create function prive.reception_brouillon_modifiable(p_reception uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.receptions r
                  where r.id = p_reception and r.statut = 'brouillon'
                    and prive.peut_reception(r.organisation_id, r.magasin_id, 'creer'))
$$;

-- ---------------------------------------------------------------------
-- RLS et privilèges
-- ---------------------------------------------------------------------

alter table public.fournisseurs       enable row level security;
alter table public.lots               enable row level security;
alter table public.mouvements_stock   enable row level security;
alter table public.stocks             enable row level security;
alter table public.stocks_lots        enable row level security;
alter table public.receptions         enable row level security;
alter table public.receptions_lignes  enable row level security;
alter table public.transferts         enable row level security;
alter table public.inventaires        enable row level security;
alter table public.inventaires_lignes enable row level security;

create policy lecture on public.fournisseurs for select to authenticated
  using (prive.a_permission(organisation_id, 'fournisseurs.consulter')
         or prive.a_permission(organisation_id, 'stock.consulter')
         or prive.a_permission(organisation_id, 'achats.consulter'));
create policy creation on public.fournisseurs for insert to authenticated
  with check (prive.a_permission(organisation_id, 'fournisseurs.creer')
              or prive.a_permission(organisation_id, 'stock.creer')
              or prive.a_permission(organisation_id, 'achats.creer'));
create policy modification on public.fournisseurs for update to authenticated
  using (prive.a_permission(organisation_id, 'fournisseurs.modifier') or prive.a_permission(organisation_id, 'achats.modifier'))
  with check (prive.a_permission(organisation_id, 'fournisseurs.modifier') or prive.a_permission(organisation_id, 'achats.modifier'));

create policy lecture on public.lots for select to authenticated
  using (prive.a_permission(organisation_id, 'stock.consulter') or prive.a_permission(organisation_id, 'catalogue.consulter'));

create policy lecture on public.mouvements_stock for select to authenticated
  using (prive.peut_stock(organisation_id, magasin_id, 'consulter'));
create policy lecture on public.stocks for select to authenticated
  using (prive.acces_magasin(organisation_id, magasin_id)
         and (prive.a_permission(organisation_id, 'stock.consulter') or prive.a_permission(organisation_id, 'catalogue.consulter')));
create policy lecture on public.stocks_lots for select to authenticated
  using (prive.acces_magasin(organisation_id, magasin_id)
         and (prive.a_permission(organisation_id, 'stock.consulter') or prive.a_permission(organisation_id, 'catalogue.consulter')));

create policy lecture on public.receptions for select to authenticated
  using (prive.peut_reception(organisation_id, magasin_id, 'consulter'));
create policy creation on public.receptions for insert to authenticated
  with check (statut = 'brouillon' and prive.peut_reception(organisation_id, magasin_id, 'creer'));
create policy modification on public.receptions for update to authenticated
  using (statut = 'brouillon' and prive.peut_reception(organisation_id, magasin_id, 'creer'))
  with check (statut = 'brouillon' and prive.peut_reception(organisation_id, magasin_id, 'creer'));

create policy lecture on public.receptions_lignes for select to authenticated
  using (exists (select 1 from public.receptions r where r.id = reception_id));
create policy creation on public.receptions_lignes for insert to authenticated
  with check (prive.reception_brouillon_modifiable(reception_id));
create policy modification on public.receptions_lignes for update to authenticated
  using (prive.reception_brouillon_modifiable(reception_id))
  with check (prive.reception_brouillon_modifiable(reception_id));
create policy suppression on public.receptions_lignes for delete to authenticated
  using (prive.reception_brouillon_modifiable(reception_id));

create policy lecture on public.transferts for select to authenticated
  using (prive.a_permission(organisation_id, 'stock.consulter')
         and (prive.acces_magasin(organisation_id, magasin_source_id) or prive.acces_magasin(organisation_id, magasin_destination_id)));

create policy lecture on public.inventaires for select to authenticated
  using (prive.peut_stock(organisation_id, magasin_id, 'consulter'));
create policy lecture on public.inventaires_lignes for select to authenticated
  using (exists (select 1 from public.inventaires i where i.id = inventaire_id));

revoke all on public.fournisseurs, public.lots, public.mouvements_stock, public.stocks, public.stocks_lots,
  public.receptions, public.receptions_lignes, public.transferts, public.inventaires, public.inventaires_lignes
  from anon, authenticated;
grant select on public.fournisseurs, public.lots, public.mouvements_stock, public.stocks, public.stocks_lots,
  public.receptions, public.receptions_lignes, public.transferts, public.inventaires, public.inventaires_lignes
  to authenticated;
grant insert (organisation_id, nom, telephone, email, adresse, ncc, note) on public.fournisseurs to authenticated;
grant update (nom, telephone, email, adresse, ncc, note, actif) on public.fournisseurs to authenticated;
grant insert (organisation_id, magasin_id, fournisseur_id, date_reception, reference, frais_approche, note)
  on public.receptions to authenticated;
grant update (magasin_id, fournisseur_id, date_reception, reference, frais_approche, note) on public.receptions to authenticated;
grant insert (organisation_id, reception_id, produit_id, quantite, prix_unitaire, numero_lot, date_peremption)
  on public.receptions_lignes to authenticated;
grant update (quantite, prix_unitaire, numero_lot, date_peremption) on public.receptions_lignes to authenticated;
grant delete on public.receptions_lignes to authenticated;

-- ---------------------------------------------------------------------
-- Fonctions RPC
-- ---------------------------------------------------------------------

create function prive.lot_pour(p_org uuid, p_produit uuid, p_numero text, p_date date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if coalesce(btrim(p_numero), '') = '' and p_date is null then return null; end if;
  select id into v from public.lots
   where produit_id = p_produit and numero = coalesce(btrim(p_numero), '')
     and coalesce(date_peremption, 'infinity'::date) = coalesce(p_date, 'infinity'::date);
  if v is null then
    insert into public.lots (organisation_id, produit_id, numero, date_peremption)
    values (p_org, p_produit, coalesce(btrim(p_numero), ''), p_date)
    returning id into v;
  end if;
  return v;
end $$;

-- Verrouille la ligne de solde : deux sorties simultanées ne peuvent pas vendre le même stock.
create function prive.verifier_disponible(p_magasin uuid, p_produit uuid, p_lot uuid, p_quantite numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare
  dispo numeric;
  nom text;
begin
  perform 1 from public.stocks where magasin_id = p_magasin and produit_id = p_produit for update;
  if p_lot is not null then
    select coalesce(max(quantite), 0) into dispo from public.stocks_lots
     where magasin_id = p_magasin and lot_id = p_lot for update;
  else
    select coalesce(max(quantite), 0) into dispo from public.stocks
     where magasin_id = p_magasin and produit_id = p_produit;
  end if;
  if dispo < p_quantite then
    select designation into nom from public.produits where id = p_produit;
    raise exception 'Stock insuffisant pour « % » : % disponible(s), % demandé(s)',
      nom, trim(to_char(dispo, 'FM999999990.###')), trim(to_char(p_quantite, 'FM999999990.###'))
      using errcode = 'P0001';
  end if;
end $$;

-- Valide une réception : répartit les frais d'approche au prorata de la valeur des lignes,
-- crée les mouvements d'entrée et met à jour le dernier prix d'achat des produits.
-- Une seconde validation (double clic, nouvel envoi) est sans effet.
create function public.valider_reception(p_reception uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.receptions;
  l record;
  total_valeur numeric;
  total_quantite numeric;
  cout numeric(14,4);
  v_lot uuid;
begin
  select * into r from public.receptions where id = p_reception for update;
  perform prive.exiger(found, 'Réception introuvable');
  perform prive.exiger(prive.peut_reception(r.organisation_id, r.magasin_id, 'valider'),
                       'Droit « stock.valider » requis pour valider une réception');
  if r.statut = 'validee' then return r.numero; end if;
  perform prive.exiger(r.statut = 'brouillon', 'Cette réception est annulée');

  select coalesce(sum(quantite * prix_unitaire), 0), coalesce(sum(quantite), 0)
    into total_valeur, total_quantite
    from public.receptions_lignes where reception_id = r.id;
  perform prive.exiger(total_quantite > 0, 'La réception ne contient aucune ligne');

  for l in
    select rl.*, p.gere_peremption, p.designation
    from public.receptions_lignes rl join public.produits p on p.id = rl.produit_id
    where rl.reception_id = r.id order by rl.created_at
  loop
    if l.gere_peremption and l.date_peremption is null then
      raise exception 'Date de péremption obligatoire pour « % »', l.designation using errcode = 'P0001';
    end if;
    cout := l.prix_unitaire + case
      when r.frais_approche = 0 then 0
      when total_valeur > 0 then r.frais_approche * l.prix_unitaire / total_valeur
      else r.frais_approche / total_quantite
    end;
    v_lot := prive.lot_pour(r.organisation_id, l.produit_id, l.numero_lot, l.date_peremption);
    insert into public.mouvements_stock (organisation_id, magasin_id, produit_id, lot_id, type, quantite,
                                         cout_unitaire, piece_type, piece_id)
    values (r.organisation_id, r.magasin_id, l.produit_id, v_lot, 'reception', l.quantite,
            round(cout, 4), 'reception', r.id);
    update public.receptions_lignes set cout_unitaire = round(cout, 4) where id = l.id;
    update public.produits set prix_achat = l.prix_unitaire
     where id = l.produit_id and prix_achat is distinct from l.prix_unitaire;
  end loop;

  update public.receptions set statut = 'validee', valide_par = auth.uid(), valide_le = now() where id = r.id;
  return r.numero;
end $$;

create function public.annuler_reception(p_reception uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.receptions;
begin
  select * into r from public.receptions where id = p_reception for update;
  perform prive.exiger(found, 'Réception introuvable');
  perform prive.exiger(prive.peut_reception(r.organisation_id, r.magasin_id, 'creer'), 'Droit insuffisant');
  perform prive.exiger(r.statut = 'brouillon',
    'Une réception validée ne s''annule pas : enregistrez un retour fournisseur ou un ajustement');
  update public.receptions set statut = 'annulee' where id = r.id;
end $$;

-- Transfert immédiat entre deux magasins : sortie au CMP de la source, entrée au même coût.
-- p_lignes : [{"produit_id": "...", "quantite": 2, "lot_id": null}, ...]
create function public.transferer_stock(p_org uuid, p_source uuid, p_destination uuid, p_lignes jsonb,
                                        p_note text default null, p_cle uuid default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_numero text;
  l jsonb;
  q numeric;
  v_lot uuid;
  sortie public.mouvements_stock;
begin
  perform prive.exiger(prive.peut_stock(p_org, p_source, 'modifier') and prive.acces_magasin(p_org, p_destination),
                       'Droit « stock.modifier » et accès aux deux magasins requis');
  if p_cle is not null then
    select numero into v_numero from public.transferts where organisation_id = p_org and cle_idempotence = p_cle;
    if found then return v_numero; end if;
  end if;
  perform prive.exiger(jsonb_array_length(coalesce(p_lignes, '[]')) > 0, 'Aucune ligne à transférer');

  v_numero := 'TR-' || lpad(prive.prochain_numero(p_org, 'transfert')::text, 6, '0');
  insert into public.transferts (organisation_id, numero, magasin_source_id, magasin_destination_id, note, cree_par, cle_idempotence)
  values (p_org, v_numero, p_source, p_destination, nullif(btrim(p_note), ''), auth.uid(), p_cle)
  returning id into v_id;

  for l in select * from jsonb_array_elements(p_lignes) loop
    q := (l ->> 'quantite')::numeric;
    v_lot := nullif(l ->> 'lot_id', '')::uuid;
    perform prive.exiger(q > 0, 'Quantité invalide');
    perform prive.verifier_disponible(p_source, (l ->> 'produit_id')::uuid, v_lot, q);
    insert into public.mouvements_stock (organisation_id, magasin_id, produit_id, lot_id, type, quantite, piece_type, piece_id)
    values (p_org, p_source, (l ->> 'produit_id')::uuid, v_lot, 'transfert_sortie', -q, 'transfert', v_id)
    returning * into sortie;
    insert into public.mouvements_stock (organisation_id, magasin_id, produit_id, lot_id, type, quantite, cout_unitaire, piece_type, piece_id)
    values (p_org, p_destination, sortie.produit_id, v_lot, 'transfert_entree', q, sortie.cout_unitaire, 'transfert', v_id);
  end loop;
  return v_numero;
end $$;

-- Sortie ou ajustement manuel, toujours motivé. Les ajustements exigent le droit de validation.
create function public.enregistrer_mouvement_manuel(p_org uuid, p_magasin uuid, p_produit uuid, p_type text,
                                                    p_quantite numeric, p_motif text, p_lot uuid default null,
                                                    p_cle uuid default null) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
  signe int;
begin
  perform prive.exiger(p_type in ('perte','casse','vol','avarie','peremption','consommation','ajustement_plus','ajustement_moins'),
                       'Type de mouvement non autorisé');
  perform prive.exiger(prive.peut_stock(p_org, p_magasin,
                         case when p_type like 'ajustement%' then 'valider' else 'modifier' end),
                       case when p_type like 'ajustement%' then 'Droit « stock.valider » requis pour un ajustement'
                            else 'Droit « stock.modifier » requis' end);
  perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Un motif est obligatoire');
  perform prive.exiger(p_quantite > 0, 'La quantité doit être positive');
  perform prive.exiger(exists (select 1 from public.produits where id = p_produit and organisation_id = p_org), 'Produit inconnu');
  if p_cle is not null then
    select id into v_id from public.mouvements_stock where organisation_id = p_org and cle_idempotence = p_cle;
    if found then return v_id; end if;
  end if;
  signe := case when p_type = 'ajustement_plus' then 1 else -1 end;
  if signe < 0 then perform prive.verifier_disponible(p_magasin, p_produit, p_lot, p_quantite); end if;

  insert into public.mouvements_stock (organisation_id, magasin_id, produit_id, lot_id, type, quantite, motif, cle_idempotence)
  values (p_org, p_magasin, p_produit, p_lot, p_type, signe * p_quantite, btrim(p_motif), p_cle)
  returning id into v_id;

  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), 'stock.' || p_type, 'mouvements_stock', v_id::text,
          jsonb_build_object('motif', btrim(p_motif), 'produit_id', p_produit, 'magasin_id', p_magasin,
                             'quantite', signe * p_quantite));
  return v_id;
end $$;

-- Inventaire : ouverture (liste des produits et quantités du moment), comptage, validation.
create function public.ouvrir_inventaire(p_org uuid, p_magasin uuid, p_categorie uuid default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform prive.exiger(prive.peut_stock(p_org, p_magasin, 'creer'), 'Droit « stock.creer » requis');
  perform prive.exiger(not exists (select 1 from public.inventaires where magasin_id = p_magasin and statut = 'en_cours'),
                       'Un inventaire est déjà en cours pour ce magasin');
  insert into public.inventaires (organisation_id, magasin_id, numero, categorie_id, note, cree_par)
  values (p_org, p_magasin, 'INV-' || lpad(prive.prochain_numero(p_org, 'inventaire')::text, 6, '0'),
          p_categorie, nullif(btrim(p_note), ''), auth.uid())
  returning id into v_id;
  insert into public.inventaires_lignes (organisation_id, inventaire_id, produit_id, quantite_theorique)
  select p_org, v_id, p.id, coalesce(s.quantite, 0)
  from public.produits p
  left join public.stocks s on s.produit_id = p.id and s.magasin_id = p_magasin
  where p.organisation_id = p_org
    and (p.statut <> 'arrete' or coalesce(s.quantite, 0) <> 0)
    and (p_categorie is null or p.categorie_id = p_categorie
         or p.categorie_id in (select c.id from public.categories c where c.parent_id = p_categorie));
  return v_id;
end $$;

-- Saisie d'un comptage. p_ajouter = true : la quantité s'ajoute (comptage au scan, article par article).
create function public.compter_inventaire(p_inventaire uuid, p_produit uuid, p_quantite numeric, p_ajouter boolean default false)
returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  i public.inventaires;
  nouvelle numeric;
begin
  select * into i from public.inventaires where id = p_inventaire;
  perform prive.exiger(found and i.statut = 'en_cours', 'Inventaire introuvable ou clôturé');
  perform prive.exiger(prive.peut_stock(i.organisation_id, i.magasin_id, 'creer'), 'Droit « stock.creer » requis');
  perform prive.exiger(exists (select 1 from public.produits where id = p_produit and organisation_id = i.organisation_id),
                       'Produit inconnu');
  insert into public.inventaires_lignes (organisation_id, inventaire_id, produit_id, quantite_theorique, quantite_comptee, compte_par, compte_le)
  values (i.organisation_id, i.id, p_produit,
          coalesce((select quantite from public.stocks where magasin_id = i.magasin_id and produit_id = p_produit), 0),
          greatest(p_quantite, 0), auth.uid(), now())
  on conflict (inventaire_id, produit_id) do update
    set quantite_comptee = greatest(case when p_ajouter then coalesce(public.inventaires_lignes.quantite_comptee, 0) + p_quantite
                                         else p_quantite end, 0),
        compte_par = auth.uid(), compte_le = now()
  returning quantite_comptee into nouvelle;
  return nouvelle;
end $$;

-- Validation : l'écart est calculé par rapport au stock au moment de la validation
-- (les ventes faites pendant le comptage sont ainsi prises en compte). Les produits non comptés
-- ne sont pas ajustés.
create function public.valider_inventaire(p_inventaire uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  i public.inventaires;
  l record;
  v_systeme numeric;
  v_ecart numeric;
  m public.mouvements_stock;
  total bigint := 0;
begin
  select * into i from public.inventaires where id = p_inventaire for update;
  perform prive.exiger(found, 'Inventaire introuvable');
  perform prive.exiger(prive.peut_stock(i.organisation_id, i.magasin_id, 'valider'), 'Droit « stock.valider » requis');
  if i.statut = 'valide' then return i.ecart_valeur; end if;
  perform prive.exiger(i.statut = 'en_cours', 'Cet inventaire est annulé');

  for l in select * from public.inventaires_lignes where inventaire_id = i.id and quantite_comptee is not null loop
    v_systeme := coalesce((select quantite from public.stocks where magasin_id = i.magasin_id and produit_id = l.produit_id), 0);
    v_ecart := l.quantite_comptee - v_systeme;
    if v_ecart <> 0 then
      insert into public.mouvements_stock (organisation_id, magasin_id, produit_id, type, quantite, motif, piece_type, piece_id)
      values (i.organisation_id, i.magasin_id, l.produit_id,
              case when v_ecart > 0 then 'inventaire_plus' else 'inventaire_moins' end, v_ecart,
              'Inventaire ' || i.numero, 'inventaire', i.id)
      returning * into m;
      total := total + m.valeur;
    end if;
    update public.inventaires_lignes
       set quantite_systeme = v_systeme, ecart = v_ecart, ecart_valeur = case when v_ecart <> 0 then m.valeur else 0 end
     where inventaire_id = i.id and produit_id = l.produit_id;
  end loop;

  update public.inventaires set statut = 'valide', valide_par = auth.uid(), valide_le = now(), ecart_valeur = total
   where id = i.id;
  return total;
end $$;

create function public.annuler_inventaire(p_inventaire uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.inventaires;
begin
  select * into i from public.inventaires where id = p_inventaire for update;
  perform prive.exiger(found and i.statut = 'en_cours', 'Inventaire introuvable ou clôturé');
  perform prive.exiger(prive.peut_stock(i.organisation_id, i.magasin_id, 'creer'), 'Droit « stock.creer » requis');
  update public.inventaires set statut = 'annule' where id = i.id;
end $$;

-- État du stock : un magasin, ou la somme des magasins accessibles (CMP pondéré).
-- Fonction « invoker » : les règles RLS de l'appelant s'appliquent.
create function public.etat_stock(p_org uuid, p_magasin uuid default null)
returns table (
  produit_id uuid, code text, designation text, unite text, categorie_id uuid, statut text,
  seuil_min integer, seuil_max integer, prix_vente bigint,
  quantite numeric, cout_moyen numeric, valeur bigint, derniere_sortie timestamptz
)
language sql stable set search_path = '' as $$
  select p.id, p.code, p.designation, p.unite, p.categorie_id, p.statut, p.seuil_min, p.seuil_max, p.prix_vente,
         coalesce(sum(s.quantite), 0),
         case when coalesce(sum(s.quantite), 0) > 0
              then round(sum(greatest(s.quantite, 0) * s.cout_moyen) / nullif(sum(greatest(s.quantite, 0)), 0), 2)
              else coalesce(max(s.cout_moyen), 0) end,
         round(coalesce(sum(greatest(s.quantite, 0) * s.cout_moyen), 0))::bigint,
         max(s.derniere_sortie)
  from public.produits p
  left join public.stocks s on s.produit_id = p.id and (p_magasin is null or s.magasin_id = p_magasin)
  where p.organisation_id = p_org
  group by p.id
  order by p.designation
$$;

-- Alertes : rupture, sous le minimum, au-dessus du maximum, stock négatif,
-- lots périmés ou périmant sous 30 jours, stock dormant (aucune sortie depuis 60 jours).
create function public.alertes_stock(p_org uuid, p_magasin uuid default null)
returns table (niveau text, type text, produit_id uuid, designation text, magasin_id uuid,
               quantite numeric, seuil integer, date_reference date, detail text)
language sql stable set search_path = '' as $$
  with soldes as (
    select s.magasin_id, s.produit_id, s.quantite, s.derniere_entree, s.derniere_sortie,
           p.designation, p.seuil_min, p.seuil_max, p.statut
    from public.stocks s join public.produits p on p.id = s.produit_id
    where s.organisation_id = p_org and (p_magasin is null or s.magasin_id = p_magasin)
  ),
  sans_stock as (
    -- Produits actifs à seuil minimum jamais entrés dans un magasin : rupture également.
    select m.id as magasin_id, p.id as produit_id, p.designation, p.seuil_min
    from public.produits p cross join public.magasins m
    where p.organisation_id = p_org and m.organisation_id = p_org and m.actif and p.statut = 'actif'
      and p.seuil_min is not null and (p_magasin is null or m.id = p_magasin)
      and not exists (select 1 from public.stocks s where s.magasin_id = m.id and s.produit_id = p.id)
      and prive.acces_magasin(p_org, m.id)
  )
  select 'critique', 'negatif', produit_id, designation, magasin_id, quantite, null::int, null::date,
         'Stock négatif : ventes supérieures au stock enregistré, à régulariser'
    from soldes where quantite < 0
  union all
  select 'critique', 'rupture', produit_id, designation, magasin_id, quantite, seuil_min, null,
         'Rupture de stock'
    from soldes where quantite = 0 and statut = 'actif' and (seuil_min is not null or derniere_sortie is not null)
  union all
  select 'critique', 'rupture', produit_id, designation, magasin_id, 0, seuil_min, null, 'Rupture de stock'
    from sans_stock
  union all
  select 'attention', 'sous_minimum', produit_id, designation, magasin_id, quantite, seuil_min, null,
         'Sous le stock minimum : réapprovisionner'
    from soldes where quantite > 0 and seuil_min is not null and quantite <= seuil_min
  union all
  select 'info', 'surstock', produit_id, designation, magasin_id, quantite, seuil_max, null,
         'Au-dessus du stock maximum'
    from soldes where seuil_max is not null and quantite > seuil_max
  union all
  select case when l.date_peremption < current_date then 'critique' else 'attention' end,
         case when l.date_peremption < current_date then 'perime' else 'peremption_proche' end,
         sl.produit_id, p.designation, sl.magasin_id, sl.quantite, null, l.date_peremption,
         case when l.date_peremption < current_date then 'Lot périmé : retirer de la vente'
              else 'Péremption dans moins de 30 jours' end
    from public.stocks_lots sl
    join public.lots l on l.id = sl.lot_id
    join public.produits p on p.id = sl.produit_id
   where sl.organisation_id = p_org and (p_magasin is null or sl.magasin_id = p_magasin)
     and sl.quantite > 0 and l.date_peremption is not null and l.date_peremption < current_date + 30
  union all
  select 'info', 'dormant', produit_id, designation, magasin_id, quantite, null,
         coalesce(derniere_sortie, derniere_entree)::date, 'Aucune sortie depuis plus de 60 jours'
    from soldes
   where quantite > 0 and coalesce(derniere_sortie, derniere_entree) < now() - interval '60 days'
$$;

revoke all on function
  public.valider_reception(uuid), public.annuler_reception(uuid),
  public.transferer_stock(uuid, uuid, uuid, jsonb, text, uuid),
  public.enregistrer_mouvement_manuel(uuid, uuid, uuid, text, numeric, text, uuid, uuid),
  public.ouvrir_inventaire(uuid, uuid, uuid, text), public.compter_inventaire(uuid, uuid, numeric, boolean),
  public.valider_inventaire(uuid), public.annuler_inventaire(uuid),
  public.etat_stock(uuid, uuid), public.alertes_stock(uuid, uuid)
from public, anon;
grant execute on function
  public.valider_reception(uuid), public.annuler_reception(uuid),
  public.transferer_stock(uuid, uuid, uuid, jsonb, text, uuid),
  public.enregistrer_mouvement_manuel(uuid, uuid, uuid, text, numeric, text, uuid, uuid),
  public.ouvrir_inventaire(uuid, uuid, uuid, text), public.compter_inventaire(uuid, uuid, numeric, boolean),
  public.valider_inventaire(uuid), public.annuler_inventaire(uuid),
  public.etat_stock(uuid, uuid), public.alertes_stock(uuid, uuid)
to authenticated;

revoke all on all functions in schema prive from public;
grant execute on function prive.peut_stock(uuid, uuid, text), prive.peut_reception(uuid, uuid, text),
  prive.reception_brouillon_modifiable(uuid) to authenticated;
