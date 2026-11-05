-- =====================================================================
-- v0.9 — Pilotage : droits alignés sur le cahier des charges,
-- fournisseurs et coût de revient (module 4), budget du mois (module 5),
-- trésorerie (module 8).
--
-- Aucun mouvement n'est déclenché sur Wave, Orange Money ou la banque :
-- l'application enregistre ce qui a été fait, avec sa référence.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Droits : nouveaux modules et règles du cahier des charges
-- ---------------------------------------------------------------------

insert into public.permissions (code, module, action)
select m || '.' || a, m, a
from unnest(array['budget','tresorerie','rentabilite','promotions']) m
cross join unnest(array['consulter','creer','modifier','valider','annuler','supprimer',
                        'exporter','cloturer','administrer']) a
on conflict do nothing;

insert into public.role_permissions (role_code, permission_code)
select 'proprietaire', code from public.permissions
where module in ('budget','tresorerie','rentabilite','promotions')
on conflict do nothing;
insert into public.role_permissions (role_code, permission_code)
select 'auditeur', code from public.permissions
where module in ('budget','tresorerie','rentabilite','promotions') and action = 'consulter'
on conflict do nothing;
insert into public.role_permissions (role_code, permission_code)
select 'comptable', code from public.permissions
where code in ('budget.consulter','tresorerie.consulter','rentabilite.consulter')
on conflict do nothing;

-- Le caissier et le vendeur n'ont plus l'écran Stock (valeurs et coûts) :
-- le stock disponible reste visible en caisse par le droit catalogue.
delete from public.role_permissions
where role_code in ('caissier','vendeur') and permission_code = 'stock.consulter';

-- Changer un prix de vente : droit « catalogue.valider ».
create function prive.tg_controle_prix_vente() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.prix_vente is distinct from old.prix_vente and auth.uid() is not null
     and not prive.a_permission(new.organisation_id, 'catalogue.valider') then
    raise exception 'Droit « catalogue.valider » requis pour changer un prix de vente'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger produits_controle_prix before update of prix_vente on public.produits
  for each row execute function prive.tg_controle_prix_vente();

-- Coûts et marges de l'extraction des ventes : droit « rapports.valider »
-- (niveau « Valider » du module Extraction des ventes).
do $$
declare d text;
begin
  select pg_get_functiondef('public.extraction_ventes(uuid, date, date, text, text, uuid, uuid, uuid, uuid, boolean)'::regprocedure) into d;
  d := replace(d, 'v_marges := prive.a_permission(p_org, ''comptabilite.consulter'');',
                  'v_marges := prive.a_permission(p_org, ''rapports.valider'');');
  execute d;
end $$;

-- ---------------------------------------------------------------------
-- 2. Trésorerie : comptes
-- ---------------------------------------------------------------------

create table public.comptes_tresorerie (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  nom             text not null check (length(btrim(nom)) between 2 and 60),
  type            text not null check (type in ('caisse','caisse_centrale','mobile_money','banque','autre')),
  -- Tiroir d'une caisse précise : ses ventes en espèces y arrivent.
  caisse_id       uuid,
  numero          text check (numero is null or length(numero) <= 40),
  solde_initial   bigint not null default 0,
  date_ouverture  date not null default current_date,
  actif           boolean not null default true,
  ordre           smallint not null default 100,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, caisse_id) references public.caisses(organisation_id, id)
);
create unique index comptes_tresorerie_nom on public.comptes_tresorerie (organisation_id, prive.normaliser(nom));

-- Chaque moyen de paiement alimente un compte (plusieurs moyens peuvent alimenter le même, ex. carte et virement → banque).
alter table public.moyens_paiement add column compte_id uuid;
alter table public.moyens_paiement add constraint moyens_paiement_compte_fk
  foreign key (organisation_id, compte_id) references public.comptes_tresorerie(organisation_id, id);

create function prive.lier_moyens_aux_comptes(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_caisse uuid;
  v_banque uuid;
  m record;
  v_compte uuid;
begin
  select id into v_caisse from public.comptes_tresorerie
   where organisation_id = p_org and type = 'caisse' and caisse_id is null order by ordre, created_at limit 1;
  if v_caisse is null then
    insert into public.comptes_tresorerie (organisation_id, nom, type, ordre)
    values (p_org, 'Caisse (espèces)', 'caisse', 1) returning id into v_caisse;
  end if;
  select id into v_banque from public.comptes_tresorerie
   where organisation_id = p_org and type = 'banque' order by ordre, created_at limit 1;
  if v_banque is null then
    insert into public.comptes_tresorerie (organisation_id, nom, type, ordre)
    values (p_org, 'Banque', 'banque', 20) returning id into v_banque;
  end if;
  for m in select * from public.moyens_paiement where organisation_id = p_org and compte_id is null order by ordre loop
    if m.nature = 'especes' then
      v_compte := v_caisse;
    elsif m.nature = 'mobile' then
      select id into v_compte from public.comptes_tresorerie
       where organisation_id = p_org and prive.normaliser(nom) = prive.normaliser(m.libelle);
      if v_compte is null then
        insert into public.comptes_tresorerie (organisation_id, nom, type, ordre)
        values (p_org, m.libelle, 'mobile_money', 10 + m.ordre) returning id into v_compte;
      end if;
    else
      v_compte := v_banque;
    end if;
    update public.moyens_paiement set compte_id = v_compte where id = m.id;
  end loop;
end $$;

create function prive.tg_moyen_vers_compte() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.compte_id is null then
    perform prive.lier_moyens_aux_comptes(new.organisation_id);
  end if;
  return new;
end $$;
create trigger moyens_paiement_compte after insert on public.moyens_paiement
  for each row execute function prive.tg_moyen_vers_compte();

do $$ begin perform prive.lier_moyens_aux_comptes(id) from public.organisations; end $$;

-- Virements entre comptes (versement de la caisse à la banque, Wave → banque…).
create table public.virements (
  id                     uuid primary key default gen_random_uuid(),
  organisation_id        uuid not null references public.organisations(id),
  date_virement          date not null default current_date,
  compte_source_id       uuid not null,
  compte_destination_id  uuid not null,
  montant                bigint not null check (montant > 0),
  frais                  bigint not null default 0 check (frais >= 0),
  reference              text check (reference is null or length(reference) <= 60),
  note                   text check (note is null or length(note) <= 300),
  statut                 text not null default 'en_attente' check (statut in ('en_attente','valide','annule')),
  cree_par               uuid default auth.uid(),
  valide_par             uuid,
  valide_le              timestamptz,
  motif_annulation       text check (motif_annulation is null or length(motif_annulation) <= 300),
  created_at             timestamptz not null default now(),
  check (compte_source_id <> compte_destination_id),
  foreign key (organisation_id, compte_source_id) references public.comptes_tresorerie(organisation_id, id),
  foreign key (organisation_id, compte_destination_id) references public.comptes_tresorerie(organisation_id, id)
);
create index virements_org_idx on public.virements (organisation_id, date_virement desc);

-- Rapprochement : solde constaté (relevé, comptage) face au solde calculé. L'écart, justifié, devient un ajustement.
create table public.rapprochements (
  id                 uuid primary key default gen_random_uuid(),
  organisation_id    uuid not null references public.organisations(id),
  compte_id          uuid not null,
  date_rapprochement date not null,
  solde_calcule      bigint not null,
  solde_constate     bigint not null,
  ecart              bigint generated always as (solde_constate - solde_calcule) stored,
  justification      text check (justification is null or length(justification) <= 300),
  cree_par           uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  foreign key (organisation_id, compte_id) references public.comptes_tresorerie(organisation_id, id)
);
create index rapprochements_compte_idx on public.rapprochements (compte_id, date_rapprochement desc);

-- ---------------------------------------------------------------------
-- 3. Achats : frais détaillés, répartition, paiement, dettes fournisseurs
-- ---------------------------------------------------------------------

alter table public.receptions
  add column repartition text not null default 'valeur' check (repartition in ('valeur','quantite','poids')),
  add column reglement text not null default 'comptant' check (reglement in ('comptant','credit')),
  add column echeance date,
  add column compte_paiement_id uuid;
alter table public.receptions add constraint receptions_compte_paiement_fk
  foreign key (organisation_id, compte_paiement_id) references public.comptes_tresorerie(organisation_id, id);
alter table public.receptions_lignes add column poids numeric(14,3) check (poids is null or poids >= 0);

create table public.receptions_frais (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  reception_id    uuid not null,
  nature          text not null check (nature in ('transport','manutention','douane','taxes','autres')),
  libelle         text check (libelle is null or length(libelle) <= 80),
  montant         bigint not null check (montant > 0),
  compte_id       uuid,
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, reception_id) references public.receptions(organisation_id, id) on delete cascade,
  foreign key (organisation_id, compte_id) references public.comptes_tresorerie(organisation_id, id)
);
create index receptions_frais_idx on public.receptions_frais (reception_id);

-- Le total des frais détaillés devient les frais d'approche de la réception.
create function prive.tg_total_frais() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_reception uuid := coalesce(new.reception_id, old.reception_id);
begin
  update public.receptions
     set frais_approche = (select coalesce(sum(montant), 0) from public.receptions_frais where reception_id = v_reception)
   where id = v_reception and statut = 'brouillon';
  return null;
end $$;
create trigger receptions_frais_total after insert or update or delete on public.receptions_frais
  for each row execute function prive.tg_total_frais();

create table public.paiements_fournisseurs (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  fournisseur_id  uuid,
  reception_id    uuid,
  date_paiement   date not null default current_date,
  montant         bigint not null check (montant > 0),
  compte_id       uuid,
  reference       text check (reference is null or length(reference) <= 60),
  note            text check (note is null or length(note) <= 300),
  statut          text not null default 'enregistre' check (statut in ('enregistre','annule')),
  cree_par        uuid default auth.uid(),
  motif_annulation text check (motif_annulation is null or length(motif_annulation) <= 300),
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, fournisseur_id) references public.fournisseurs(organisation_id, id),
  foreign key (organisation_id, reception_id) references public.receptions(organisation_id, id),
  foreign key (organisation_id, compte_id) references public.comptes_tresorerie(organisation_id, id)
);
create index paiements_fournisseurs_idx on public.paiements_fournisseurs (organisation_id, fournisseur_id);
create index paiements_fournisseurs_reception_idx on public.paiements_fournisseurs (reception_id);

-- Les réceptions déjà validées avant la v0.9 sont considérées comme payées comptant.
insert into public.paiements_fournisseurs (organisation_id, fournisseur_id, reception_id, date_paiement, montant, note, cree_par)
select r.organisation_id, r.fournisseur_id, r.id, r.date_reception, round(t.valeur)::bigint,
       'Reprise v0.9 : réception antérieure considérée comme payée', r.valide_par
from public.receptions r
join lateral (select sum(quantite * prix_unitaire) valeur from public.receptions_lignes where reception_id = r.id) t on true
where r.statut = 'validee' and t.valeur > 0;

-- Validation : répartition des frais au choix (valeur, quantité, poids) et paiement comptant ou à crédit.
create or replace function public.valider_reception(p_reception uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.receptions;
  l record;
  total_valeur numeric;
  total_quantite numeric;
  total_poids numeric;
  v_frais numeric;
  cout numeric(14,4);
  v_lot uuid;
begin
  select * into r from public.receptions where id = p_reception for update;
  perform prive.exiger(found, 'Réception introuvable');
  perform prive.exiger(prive.peut_reception(r.organisation_id, r.magasin_id, 'valider'),
                       'Droit « stock.valider » requis pour valider une réception');
  if r.statut = 'validee' then return r.numero; end if;
  perform prive.exiger(r.statut = 'brouillon', 'Cette réception est annulée');
  perform prive.exiger(r.reglement = 'comptant' or r.fournisseur_id is not null,
                       'Un achat à crédit doit indiquer le fournisseur');

  select coalesce(sum(quantite * prix_unitaire), 0), coalesce(sum(quantite), 0), coalesce(sum(poids), 0)
    into total_valeur, total_quantite, total_poids
    from public.receptions_lignes where reception_id = r.id;
  perform prive.exiger(total_quantite > 0, 'La réception ne contient aucune ligne');
  v_frais := r.frais_approche;
  if r.repartition = 'poids' and v_frais > 0 then
    perform prive.exiger(not exists (select 1 from public.receptions_lignes
                                      where reception_id = r.id and coalesce(poids, 0) <= 0),
                         'Répartition au poids : indiquez le poids de chaque ligne');
  end if;

  for l in
    select rl.*, p.gere_peremption, p.designation
    from public.receptions_lignes rl join public.produits p on p.id = rl.produit_id
    where rl.reception_id = r.id order by rl.created_at
  loop
    if l.gere_peremption and l.date_peremption is null then
      raise exception 'Date de péremption obligatoire pour « % »', l.designation using errcode = 'P0001';
    end if;
    cout := l.prix_unitaire + case
      when v_frais = 0 then 0
      when r.repartition = 'quantite' then v_frais / total_quantite
      when r.repartition = 'poids' then v_frais * l.poids / total_poids / l.quantite
      when total_valeur > 0 then v_frais * l.prix_unitaire / total_valeur
      else v_frais / total_quantite
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

  -- Achat comptant : le paiement du fournisseur est enregistré tout de suite.
  if r.reglement = 'comptant' and total_valeur > 0 then
    insert into public.paiements_fournisseurs (organisation_id, fournisseur_id, reception_id, date_paiement,
                                               montant, compte_id, reference, note)
    values (r.organisation_id, r.fournisseur_id, r.id, r.date_reception, round(total_valeur)::bigint,
            r.compte_paiement_id, r.reference, 'Paiement comptant de la réception ' || r.numero);
  end if;
  return r.numero;
end $$;

-- Reste dû par réception validée.
create function prive.dettes_receptions(p_org uuid)
returns table (reception_id uuid, fournisseur_id uuid, numero text, date_reception date, echeance date,
               montant bigint, paye bigint, reste bigint)
language sql stable security definer set search_path = '' as $$
  select r.id, r.fournisseur_id, r.numero, r.date_reception, r.echeance,
         round(v.valeur)::bigint,
         coalesce(p.paye, 0)::bigint,
         greatest(round(v.valeur)::bigint - coalesce(p.paye, 0), 0)::bigint
  from public.receptions r
  join lateral (select coalesce(sum(quantite * prix_unitaire), 0) valeur
                  from public.receptions_lignes where reception_id = r.id) v on true
  left join lateral (select sum(montant) paye from public.paiements_fournisseurs pf
                      where pf.reception_id = r.id and pf.statut = 'enregistre') p on true
  where r.organisation_id = p_org and r.statut = 'validee'
$$;

create function public.situation_fournisseurs(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'fournisseurs.consulter') or prive.a_permission(p_org, 'achats.consulter'),
                       'Droit « fournisseurs.consulter » requis');
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.reste_du desc, x.nom)
    from (
      select f.id, f.nom, f.telephone, f.actif,
             count(d.reception_id) achats,
             coalesce(sum(d.montant), 0)::bigint total_achats,
             (coalesce((select sum(pf.montant) from public.paiements_fournisseurs pf
                         where pf.fournisseur_id = f.id and pf.statut = 'enregistre'), 0))::bigint total_paye,
             greatest(coalesce(sum(d.montant), 0)
               - coalesce((select sum(pf.montant) from public.paiements_fournisseurs pf
                            where pf.fournisseur_id = f.id and pf.statut = 'enregistre'), 0), 0)::bigint reste_du,
             min(d.echeance) filter (where d.reste > 0) prochaine_echeance,
             max(d.date_reception) dernier_achat
      from public.fournisseurs f
      left join prive.dettes_receptions(p_org) d on d.fournisseur_id = f.id
      where f.organisation_id = p_org
      group by f.id
    ) x), '[]'::jsonb);
end $$;

-- Historique d'un fournisseur : achats (avec reste dû), paiements, prix payés par produit.
create function public.historique_fournisseur(p_fournisseur uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  select organisation_id into v_org from public.fournisseurs where id = p_fournisseur;
  perform prive.exiger(v_org is not null, 'Fournisseur introuvable');
  perform prive.exiger(prive.a_permission(v_org, 'fournisseurs.consulter') or prive.a_permission(v_org, 'achats.consulter'),
                       'Droit « fournisseurs.consulter » requis');
  return jsonb_build_object(
    'achats', coalesce((select jsonb_agg(to_jsonb(d) order by d.date_reception desc)
                          from prive.dettes_receptions(v_org) d where d.fournisseur_id = p_fournisseur), '[]'::jsonb),
    'paiements', coalesce((select jsonb_agg(jsonb_build_object(
                             'id', pf.id, 'date_paiement', pf.date_paiement, 'montant', pf.montant, 'statut', pf.statut,
                             'reference', pf.reference, 'note', pf.note, 'compte', c.nom,
                             'reception', r.numero) order by pf.date_paiement desc, pf.created_at desc)
                           from public.paiements_fournisseurs pf
                           left join public.comptes_tresorerie c on c.id = pf.compte_id
                           left join public.receptions r on r.id = pf.reception_id
                           where pf.fournisseur_id = p_fournisseur), '[]'::jsonb),
    'prix', coalesce((select jsonb_agg(to_jsonb(x) order by x.designation, x.date_reception desc) from (
                        select p.designation, r.date_reception, r.numero, rl.quantite, rl.prix_unitaire, rl.cout_unitaire
                        from public.receptions_lignes rl
                        join public.receptions r on r.id = rl.reception_id and r.statut = 'validee'
                        join public.produits p on p.id = rl.produit_id
                        where r.fournisseur_id = p_fournisseur
                        order by r.date_reception desc limit 300) x), '[]'::jsonb)
  );
end $$;

create function public.payer_fournisseur(
  p_org uuid, p_fournisseur uuid, p_reception uuid, p_montant bigint, p_compte uuid,
  p_date date default current_date, p_reference text default null, p_note text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_reste bigint;
begin
  perform prive.exiger(prive.a_permission(p_org, 'fournisseurs.creer') or prive.a_permission(p_org, 'achats.creer'),
                       'Droit « fournisseurs.creer » requis');
  perform prive.exiger(coalesce(p_montant, 0) > 0, 'Montant invalide');
  perform prive.exiger(exists (select 1 from public.fournisseurs where id = p_fournisseur and organisation_id = p_org),
                       'Fournisseur introuvable');
  perform prive.exiger(exists (select 1 from public.comptes_tresorerie where id = p_compte and organisation_id = p_org and actif),
                       'Choisissez le compte qui a payé');
  if p_reception is not null then
    select reste into v_reste from prive.dettes_receptions(p_org) where reception_id = p_reception and fournisseur_id = p_fournisseur;
    perform prive.exiger(v_reste is not null, 'Réception introuvable pour ce fournisseur');
    perform prive.exiger(p_montant <= v_reste, format('Le reste dû sur cette réception est de %s', v_reste));
  end if;
  insert into public.paiements_fournisseurs (organisation_id, fournisseur_id, reception_id, date_paiement, montant,
                                             compte_id, reference, note)
  values (p_org, p_fournisseur, p_reception, coalesce(p_date, current_date), p_montant, p_compte,
          nullif(btrim(p_reference), ''), nullif(btrim(p_note), ''))
  returning id into v_id;
  return v_id;
end $$;

create function public.annuler_paiement_fournisseur(p_paiement uuid, p_motif text) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.paiements_fournisseurs;
begin
  select * into v from public.paiements_fournisseurs where id = p_paiement for update;
  perform prive.exiger(found, 'Paiement introuvable');
  perform prive.exiger(prive.a_permission(v.organisation_id, 'fournisseurs.modifier') or prive.a_permission(v.organisation_id, 'achats.modifier'),
                       'Droit « fournisseurs.modifier » requis');
  perform prive.exiger(v.statut = 'enregistre', 'Paiement déjà annulé');
  perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Un motif est obligatoire');
  perform set_config('app.motif', btrim(p_motif), true);
  update public.paiements_fournisseurs set statut = 'annule', motif_annulation = btrim(p_motif) where id = p_paiement;
  perform set_config('app.motif', '', true);
end $$;

-- Coût de revient par produit : dernier coût de revient d'achat, coût moyen du stock, prix de vente.
create function public.couts_de_revient(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'fournisseurs.consulter') or prive.a_permission(p_org, 'rapports.valider')
                       or prive.a_permission(p_org, 'stock.valider'),
                       'Droit « fournisseurs.consulter » requis');
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.designation)
    from (
      select p.id, p.code, p.designation, p.prix_vente, p.prix_achat,
             s.quantite stock,
             round(s.cout_moyen)::bigint cout_moyen,
             round(d.cout_unitaire)::bigint dernier_cout,
             d.prix_unitaire dernier_prix_achat,
             d.date_reception derniere_reception,
             d.fournisseur
      from public.produits p
      left join lateral (
        select sum(st.quantite) quantite,
               case when sum(st.quantite) > 0 then sum(st.quantite * st.cout_moyen) / sum(st.quantite)
                    else max(st.cout_moyen) end cout_moyen
        from public.stocks st where st.produit_id = p.id and prive.acces_magasin(p_org, st.magasin_id)
      ) s on true
      left join lateral (
        select rl.cout_unitaire, rl.prix_unitaire, r.date_reception, f.nom fournisseur
        from public.receptions_lignes rl
        join public.receptions r on r.id = rl.reception_id and r.statut = 'validee'
        left join public.fournisseurs f on f.id = r.fournisseur_id
        where rl.produit_id = p.id
        order by r.valide_le desc nulls last, rl.created_at desc limit 1
      ) d on true
      where p.organisation_id = p_org and p.statut <> 'arrete'
    ) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 4. Budget du mois
-- ---------------------------------------------------------------------

create table public.postes_budget (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations(id),
  libelle          text not null check (length(btrim(libelle)) between 2 and 60),
  compte_syscohada text check (compte_syscohada is null or compte_syscohada ~ '^[0-9]{2,8}$'),
  nature           text not null default 'variable' check (nature in ('fixe','variable')),
  ordre            smallint not null default 100,
  actif            boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organisation_id, id)
);
create unique index postes_budget_libelle on public.postes_budget (organisation_id, prive.normaliser(libelle));

create function prive.creer_postes_par_defaut(p_org uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.postes_budget (organisation_id, libelle, compte_syscohada, nature, ordre)
  values (p_org, 'Salaires', '661', 'fixe', 1),
         (p_org, 'Loyer', '622', 'fixe', 2),
         (p_org, 'Électricité (CIE)', '6052', 'variable', 3),
         (p_org, 'Eau (SODECI)', '6051', 'variable', 4),
         (p_org, 'Téléphone et internet', '628', 'variable', 5),
         (p_org, 'Transport', '618', 'variable', 6),
         (p_org, 'Entretien et réparations', '624', 'variable', 7),
         (p_org, 'Impôts et taxes', '64', 'variable', 8),
         (p_org, 'Frais bancaires et Mobile Money', '631', 'variable', 9),
         (p_org, 'Publicité', '627', 'variable', 10),
         (p_org, 'Imprévus', '658', 'variable', 11)
  on conflict do nothing
$$;

create function prive.tg_pilotage_par_defaut() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.creer_postes_par_defaut(new.id);
  return new;
end $$;
create trigger organisations_postes_budget after insert on public.organisations
  for each row execute function prive.tg_pilotage_par_defaut();

do $$ begin perform prive.creer_postes_par_defaut(id) from public.organisations; end $$;

create table public.budgets (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  mois            date not null check (extract(day from mois) = 1),
  statut          text not null default 'brouillon' check (statut in ('brouillon','valide')),
  version         int not null default 1,
  valide_par      uuid,
  valide_le       timestamptz,
  motif_revision  text check (motif_revision is null or length(motif_revision) <= 300),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, mois),
  unique (organisation_id, id)
);

create table public.budgets_lignes (
  organisation_id uuid not null,
  budget_id       uuid not null,
  poste_id        uuid not null,
  montant         bigint not null default 0 check (montant >= 0),
  primary key (budget_id, poste_id),
  foreign key (organisation_id, budget_id) references public.budgets(organisation_id, id) on delete cascade,
  foreign key (organisation_id, poste_id) references public.postes_budget(organisation_id, id)
);

create table public.depenses (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations(id),
  date_depense     date not null default current_date,
  poste_id         uuid not null,
  compte_id        uuid not null,
  montant          bigint not null check (montant > 0),
  libelle          text check (libelle is null or length(libelle) <= 120),
  beneficiaire     text check (beneficiaire is null or length(beneficiaire) <= 80),
  reference        text check (reference is null or length(reference) <= 60),
  justificatif_path text,
  statut           text not null default 'enregistree' check (statut in ('enregistree','annulee')),
  motif_annulation text check (motif_annulation is null or length(motif_annulation) <= 300),
  cree_par         uuid default auth.uid(),
  annulee_par      uuid,
  annulee_le       timestamptz,
  created_at       timestamptz not null default now(),
  foreign key (organisation_id, poste_id) references public.postes_budget(organisation_id, id),
  foreign key (organisation_id, compte_id) references public.comptes_tresorerie(organisation_id, id)
);
create index depenses_org_idx on public.depenses (organisation_id, date_depense desc);

create function public.enregistrer_budget(p_org uuid, p_mois date, p_lignes jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_mois date := date_trunc('month', p_mois)::date;
  b public.budgets;
  l jsonb;
begin
  perform prive.exiger(prive.a_permission(p_org, 'budget.creer'), 'Droit « budget.creer » requis');
  select * into b from public.budgets where organisation_id = p_org and mois = v_mois for update;
  if not found then
    insert into public.budgets (organisation_id, mois) values (p_org, v_mois) returning * into b;
  end if;
  perform prive.exiger(b.statut = 'brouillon', 'Ce budget est validé : faites une révision pour le modifier');
  for l in select * from jsonb_array_elements(coalesce(p_lignes, '[]'::jsonb)) loop
    perform prive.exiger(exists (select 1 from public.postes_budget where id = (l ->> 'poste_id')::uuid and organisation_id = p_org),
                         'Poste de budget inconnu');
    perform prive.exiger(coalesce((l ->> 'montant')::bigint, 0) >= 0, 'Montant négatif');
    insert into public.budgets_lignes (organisation_id, budget_id, poste_id, montant)
    values (p_org, b.id, (l ->> 'poste_id')::uuid, coalesce((l ->> 'montant')::bigint, 0))
    on conflict (budget_id, poste_id) do update set montant = excluded.montant
    where public.budgets_lignes.montant is distinct from excluded.montant;
  end loop;
  update public.budgets set updated_at = now() where id = b.id;
  return b.id;
end $$;

create function public.valider_budget(p_budget uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.budgets;
begin
  select * into b from public.budgets where id = p_budget for update;
  perform prive.exiger(found, 'Budget introuvable');
  perform prive.exiger(prive.a_permission(b.organisation_id, 'budget.valider'), 'Droit « budget.valider » requis');
  perform prive.exiger(b.statut = 'brouillon', 'Ce budget est déjà validé');
  update public.budgets set statut = 'valide', valide_par = auth.uid(), valide_le = now() where id = b.id;
end $$;

create function public.reviser_budget(p_budget uuid, p_motif text) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.budgets;
begin
  select * into b from public.budgets where id = p_budget for update;
  perform prive.exiger(found, 'Budget introuvable');
  perform prive.exiger(prive.a_permission(b.organisation_id, 'budget.valider'), 'Droit « budget.valider » requis');
  perform prive.exiger(b.statut = 'valide', 'Ce budget n''est pas validé');
  perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Indiquez le motif de la révision');
  perform set_config('app.motif', btrim(p_motif), true);
  update public.budgets
     set statut = 'brouillon', version = version + 1, motif_revision = btrim(p_motif), valide_par = null, valide_le = null
   where id = b.id;
  perform set_config('app.motif', '', true);
end $$;

create function public.enregistrer_depense(
  p_org uuid, p_date date, p_poste uuid, p_compte uuid, p_montant bigint,
  p_libelle text default null, p_beneficiaire text default null, p_reference text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform prive.exiger(prive.a_permission(p_org, 'budget.creer'), 'Droit « budget.creer » requis');
  perform prive.exiger(coalesce(p_montant, 0) > 0, 'Montant invalide');
  perform prive.exiger(exists (select 1 from public.postes_budget where id = p_poste and organisation_id = p_org), 'Poste inconnu');
  perform prive.exiger(exists (select 1 from public.comptes_tresorerie where id = p_compte and organisation_id = p_org and actif),
                       'Choisissez le compte qui a payé');
  insert into public.depenses (organisation_id, date_depense, poste_id, compte_id, montant, libelle, beneficiaire, reference)
  values (p_org, coalesce(p_date, current_date), p_poste, p_compte, p_montant,
          nullif(btrim(p_libelle), ''), nullif(btrim(p_beneficiaire), ''), nullif(btrim(p_reference), ''))
  returning id into v_id;
  return v_id;
end $$;

create function public.annuler_depense(p_depense uuid, p_motif text) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.depenses;
begin
  select * into d from public.depenses where id = p_depense for update;
  perform prive.exiger(found, 'Dépense introuvable');
  perform prive.exiger(prive.a_permission(d.organisation_id, 'budget.valider'), 'Droit « budget.valider » requis');
  perform prive.exiger(d.statut = 'enregistree', 'Dépense déjà annulée');
  perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Un motif est obligatoire');
  perform set_config('app.motif', btrim(p_motif), true);
  update public.depenses set statut = 'annulee', motif_annulation = btrim(p_motif), annulee_par = auth.uid(), annulee_le = now()
   where id = d.id;
  perform set_config('app.motif', '', true);
end $$;

-- Suivi du mois : prévu, réel, écart et taux de consommation par poste (alerte à 80 % puis 100 %).
create function public.suivi_budget(p_org uuid, p_mois date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_mois date := date_trunc('month', p_mois)::date;
  b public.budgets;
  v_lignes jsonb;
begin
  perform prive.exiger(prive.a_permission(p_org, 'budget.consulter'), 'Droit « budget.consulter » requis');
  select * into b from public.budgets where organisation_id = p_org and mois = v_mois;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.ordre, x.libelle), '[]'::jsonb) into v_lignes from (
    select p.id poste_id, p.libelle, p.compte_syscohada, p.nature, p.ordre, p.actif,
           coalesce(bl.montant, 0) prevu,
           coalesce(d.reel, 0) reel,
           coalesce(bl.montant, 0) - coalesce(d.reel, 0) ecart,
           case when coalesce(bl.montant, 0) > 0 then round(100.0 * coalesce(d.reel, 0) / bl.montant, 1) end taux,
           case when coalesce(d.reel, 0) > 0 and coalesce(bl.montant, 0) = 0 then 'hors_budget'
                when coalesce(bl.montant, 0) > 0 and d.reel >= bl.montant then 'depasse'
                when coalesce(bl.montant, 0) > 0 and d.reel >= 0.8 * bl.montant then 'attention'
                else 'ok' end alerte
    from public.postes_budget p
    left join public.budgets_lignes bl on bl.poste_id = p.id and bl.budget_id = b.id
    left join lateral (select sum(montant) reel from public.depenses de
                        where de.poste_id = p.id and de.statut = 'enregistree'
                          and de.date_depense >= v_mois and de.date_depense < (v_mois + interval '1 month')::date) d on true
    where p.organisation_id = p_org and (p.actif or bl.montant > 0 or d.reel > 0)
  ) x;
  return jsonb_build_object(
    'mois', v_mois,
    'budget', case when b.id is null then null else jsonb_build_object(
      'id', b.id, 'statut', b.statut, 'version', b.version, 'valide_le', b.valide_le,
      'motif_revision', b.motif_revision) end,
    'lignes', v_lignes,
    'totaux', (select jsonb_build_object('prevu', coalesce(sum((e ->> 'prevu')::bigint), 0),
                                         'reel', coalesce(sum((e ->> 'reel')::bigint), 0))
                 from jsonb_array_elements(v_lignes) e));
end $$;

-- ---------------------------------------------------------------------
-- 5. Trésorerie : flux, soldes, liquidité
-- ---------------------------------------------------------------------

-- Tous les flux d'argent, signés (+ entrée, − sortie), par compte.
create function prive.flux_tresorerie(p_org uuid)
returns table (compte_id uuid, date_flux date, nature text, libelle text, montant bigint, piece_type text, piece_id uuid)
language sql stable security definer set search_path = '' as $$
  -- Ventes : chaque règlement alimente le compte de son moyen ; les espèces vont au tiroir de la caisse s'il a son compte.
  select coalesce(case when rg.nature = 'especes'
                       then (select ct.id from public.comptes_tresorerie ct
                              where ct.organisation_id = p_org and ct.caisse_id = v.caisse_id and ct.actif
                              order by ct.ordre limit 1) end,
                  mp.compte_id),
         (v.date_vente at time zone 'Africa/Abidjan')::date,
         case when rg.sens = 'rendu' then 'rendu' else 'vente' end,
         'Ticket ' || v.numero || ' · ' || rg.libelle,
         case when rg.sens = 'rendu' then -rg.montant else rg.montant end,
         'vente', v.id
  from public.reglements rg
  join public.ventes v on v.id = rg.vente_id and v.statut = 'validee'
  join public.moyens_paiement mp on mp.id = rg.moyen_id
  where rg.organisation_id = p_org and rg.statut = 'enregistre'
  union all
  select d.compte_id, d.date_depense, 'depense', coalesce(p.libelle, 'Dépense') || coalesce(' · ' || d.libelle, ''),
         -d.montant, 'depense', d.id
  from public.depenses d left join public.postes_budget p on p.id = d.poste_id
  where d.organisation_id = p_org and d.statut = 'enregistree'
  union all
  select pf.compte_id, pf.date_paiement, 'fournisseur',
         'Paiement ' || coalesce(f.nom, 'fournisseur') || coalesce(' · ' || r.numero, ''),
         -pf.montant, 'paiement_fournisseur', pf.id
  from public.paiements_fournisseurs pf
  left join public.fournisseurs f on f.id = pf.fournisseur_id
  left join public.receptions r on r.id = pf.reception_id
  where pf.organisation_id = p_org and pf.statut = 'enregistre' and pf.compte_id is not null
  union all
  select rf.compte_id, r.date_reception, 'frais_achat', 'Frais ' || rf.nature || ' · ' || r.numero,
         -rf.montant, 'reception', r.id
  from public.receptions_frais rf join public.receptions r on r.id = rf.reception_id and r.statut = 'validee'
  where rf.organisation_id = p_org and rf.compte_id is not null
  union all
  select vi.compte_source_id, vi.date_virement, 'virement_sortant',
         'Virement vers ' || cd.nom || case when vi.frais > 0 then ' (frais ' || vi.frais || ')' else '' end,
         -(vi.montant + vi.frais), 'virement', vi.id
  from public.virements vi join public.comptes_tresorerie cd on cd.id = vi.compte_destination_id
  where vi.organisation_id = p_org and vi.statut = 'valide'
  union all
  select vi.compte_destination_id, vi.date_virement, 'virement_entrant', 'Virement depuis ' || cs.nom,
         vi.montant, 'virement', vi.id
  from public.virements vi join public.comptes_tresorerie cs on cs.id = vi.compte_source_id
  where vi.organisation_id = p_org and vi.statut = 'valide'
  union all
  select ra.compte_id, ra.date_rapprochement, 'ajustement',
         'Écart de rapprochement' || coalesce(' · ' || ra.justification, ''), ra.ecart, 'rapprochement', ra.id
  from public.rapprochements ra
  where ra.organisation_id = p_org and ra.ecart <> 0
$$;

create function prive.solde_compte(p_compte uuid, p_au date default null) returns bigint
language sql stable security definer set search_path = '' as $$
  select c.solde_initial + coalesce((
    select sum(f.montant) from prive.flux_tresorerie(c.organisation_id) f
    where f.compte_id = c.id and f.date_flux >= c.date_ouverture and (p_au is null or f.date_flux <= p_au)), 0)::bigint
  from public.comptes_tresorerie c where c.id = p_compte
$$;

create function public.tresorerie(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_comptes jsonb;
  v_total bigint;
  v_dettes bigint;
  v_budget_restant bigint;
  v_debut_mois date := date_trunc('month', current_date)::date;
begin
  perform prive.exiger(prive.a_permission(p_org, 'tresorerie.consulter'), 'Droit « tresorerie.consulter » requis');

  with f as (select * from prive.flux_tresorerie(p_org)),
  c as (
    select ct.*,
           ct.solde_initial + coalesce((select sum(f.montant) from f where f.compte_id = ct.id and f.date_flux >= ct.date_ouverture), 0) solde,
           coalesce((select sum(f.montant) from f where f.compte_id = ct.id and f.montant > 0
                       and f.date_flux >= greatest(ct.date_ouverture, v_debut_mois)), 0) entrees_mois,
           coalesce((select -sum(f.montant) from f where f.compte_id = ct.id and f.montant < 0
                       and f.date_flux >= greatest(ct.date_ouverture, v_debut_mois)), 0) sorties_mois,
           (select jsonb_build_object('date', ra.date_rapprochement, 'ecart', ra.ecart)
              from public.rapprochements ra where ra.compte_id = ct.id
              order by ra.date_rapprochement desc, ra.created_at desc limit 1) dernier_rapprochement
    from public.comptes_tresorerie ct where ct.organisation_id = p_org
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'nom', nom, 'type', type, 'caisse_id', caisse_id, 'numero', numero,
           'solde_initial', solde_initial, 'date_ouverture', date_ouverture, 'actif', actif, 'ordre', ordre,
           'solde', solde, 'entrees_mois', entrees_mois, 'sorties_mois', sorties_mois,
           'dernier_rapprochement', dernier_rapprochement) order by ordre, nom), '[]'::jsonb),
         coalesce(sum(solde) filter (where actif), 0)
    into v_comptes, v_total from c;

  -- Dettes fournisseurs à payer dans les 30 jours (ou sans échéance).
  select coalesce(sum(d.reste), 0) into v_dettes from prive.dettes_receptions(p_org) d
   where d.reste > 0 and (d.echeance is null or d.echeance <= current_date + 30);

  -- Budget restant du mois : prévu non encore dépensé, poste par poste.
  select coalesce(sum(greatest(bl.montant - coalesce(dep.reel, 0), 0)), 0) into v_budget_restant
  from public.budgets b
  join public.budgets_lignes bl on bl.budget_id = b.id
  left join lateral (select sum(montant) reel from public.depenses de
                      where de.poste_id = bl.poste_id and de.statut = 'enregistree'
                        and de.date_depense >= v_debut_mois and de.date_depense < (v_debut_mois + interval '1 month')::date) dep on true
  where b.organisation_id = p_org and b.mois = v_debut_mois;

  return jsonb_build_object(
    'comptes', v_comptes,
    'total', v_total,
    'dettes_30_jours', v_dettes,
    'budget_restant', v_budget_restant,
    'liquidite', v_total - v_dettes - v_budget_restant,
    'virements_en_attente', (select count(*) from public.virements where organisation_id = p_org and statut = 'en_attente'),
    'calcule_le', now());
end $$;

create function public.mouvements_tresorerie(p_compte uuid, p_debut date, p_fin date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.comptes_tresorerie;
begin
  select * into c from public.comptes_tresorerie where id = p_compte;
  perform prive.exiger(found, 'Compte introuvable');
  perform prive.exiger(prive.a_permission(c.organisation_id, 'tresorerie.consulter'), 'Droit « tresorerie.consulter » requis');
  perform prive.exiger(p_debut <= p_fin and p_fin - p_debut <= 400, 'Période invalide');
  return jsonb_build_object(
    'solde_debut', prive.solde_compte(p_compte, p_debut - 1),
    'solde_fin', prive.solde_compte(p_compte, p_fin),
    'mouvements', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.date_flux, x.nature)
      from (
        -- Les ventes d'un même jour sont regroupées en une ligne par nature pour rester lisibles.
        select y.date_flux, y.nature, y.libelle, sum(y.montant)::bigint montant, y.piece_type, y.piece_id,
               count(*) operations
        from (
          select f.date_flux, f.nature,
                 case when f.piece_type = 'vente'
                      then 'Ventes du jour' || case when f.nature = 'rendu' then ' (monnaie rendue)' else '' end
                      else f.libelle end libelle,
                 f.montant,
                 case when f.piece_type = 'vente' then null else f.piece_type end piece_type,
                 case when f.piece_type = 'vente' then null else f.piece_id end piece_id
          from prive.flux_tresorerie(c.organisation_id) f
          where f.compte_id = p_compte and f.date_flux >= greatest(c.date_ouverture, p_debut) and f.date_flux <= p_fin
        ) y
        group by y.date_flux, y.nature, y.libelle, y.piece_type, y.piece_id
      ) x), '[]'::jsonb));
end $$;

create function public.saisir_virement(
  p_org uuid, p_source uuid, p_destination uuid, p_montant bigint, p_frais bigint default 0,
  p_date date default current_date, p_reference text default null, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_valide boolean := prive.a_permission(p_org, 'tresorerie.valider');
begin
  perform prive.exiger(prive.a_permission(p_org, 'tresorerie.creer'), 'Droit « tresorerie.creer » requis');
  perform prive.exiger(coalesce(p_montant, 0) > 0, 'Montant invalide');
  perform prive.exiger(coalesce(p_frais, 0) >= 0, 'Frais invalides');
  perform prive.exiger(p_source is distinct from p_destination, 'Choisissez deux comptes différents');
  perform prive.exiger((select count(*) from public.comptes_tresorerie
                         where organisation_id = p_org and actif and id in (p_source, p_destination)) = 2,
                       'Compte introuvable ou inactif');
  insert into public.virements (organisation_id, date_virement, compte_source_id, compte_destination_id, montant, frais,
                                reference, note, statut, valide_par, valide_le)
  values (p_org, coalesce(p_date, current_date), p_source, p_destination, p_montant, coalesce(p_frais, 0),
          nullif(btrim(p_reference), ''), nullif(btrim(p_note), ''),
          case when v_valide then 'valide' else 'en_attente' end,
          case when v_valide then auth.uid() end, case when v_valide then now() end)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'statut', case when v_valide then 'valide' else 'en_attente' end);
end $$;

create function public.valider_virement(p_virement uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.virements;
begin
  select * into v from public.virements where id = p_virement for update;
  perform prive.exiger(found, 'Virement introuvable');
  perform prive.exiger(prive.a_permission(v.organisation_id, 'tresorerie.valider'), 'Droit « tresorerie.valider » requis');
  perform prive.exiger(v.statut = 'en_attente', 'Ce virement n''est pas en attente');
  update public.virements set statut = 'valide', valide_par = auth.uid(), valide_le = now() where id = v.id;
end $$;

create function public.annuler_virement(p_virement uuid, p_motif text) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.virements;
begin
  select * into v from public.virements where id = p_virement for update;
  perform prive.exiger(found, 'Virement introuvable');
  perform prive.exiger(prive.a_permission(v.organisation_id, 'tresorerie.valider'), 'Droit « tresorerie.valider » requis');
  perform prive.exiger(v.statut <> 'annule', 'Virement déjà annulé');
  perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Un motif est obligatoire');
  perform set_config('app.motif', btrim(p_motif), true);
  update public.virements set statut = 'annule', motif_annulation = btrim(p_motif) where id = v.id;
  perform set_config('app.motif', '', true);
end $$;

create function public.rapprocher_compte(p_compte uuid, p_date date, p_solde_constate bigint, p_justification text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.comptes_tresorerie;
  v_calcule bigint;
  r public.rapprochements;
begin
  select * into c from public.comptes_tresorerie where id = p_compte;
  perform prive.exiger(found, 'Compte introuvable');
  perform prive.exiger(prive.a_permission(c.organisation_id, 'tresorerie.valider'), 'Droit « tresorerie.valider » requis');
  perform prive.exiger(p_date is not null and p_date <= current_date, 'Date invalide');
  perform prive.exiger(p_solde_constate is not null, 'Indiquez le solde constaté');
  v_calcule := prive.solde_compte(p_compte, p_date);
  perform prive.exiger(p_solde_constate = v_calcule or length(btrim(coalesce(p_justification, ''))) >= 3,
                       format('Écart de %s : indiquez sa justification', p_solde_constate - v_calcule));
  insert into public.rapprochements (organisation_id, compte_id, date_rapprochement, solde_calcule, solde_constate, justification)
  values (c.organisation_id, c.id, p_date, v_calcule, p_solde_constate, nullif(btrim(p_justification), ''))
  returning * into r;
  return to_jsonb(r);
end $$;

-- ---------------------------------------------------------------------
-- 6. Journal d'audit, dates de mise à jour, RLS, privilèges
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['comptes_tresorerie','postes_budget','budgets'] loop
    execute format('create trigger %I before update on public.%I
                    for each row execute function prive.tg_maj_updated_at()', t || '_updated_at', t);
  end loop;
  foreach t in array array['comptes_tresorerie','virements','rapprochements','receptions_frais','paiements_fournisseurs',
                           'postes_budget','budgets','budgets_lignes','depenses'] loop
    execute format('create trigger %I after insert or update or delete on public.%I
                    for each row execute function prive.tg_audit()', t || '_audit', t);
  end loop;
end $$;

alter table public.comptes_tresorerie     enable row level security;
alter table public.virements              enable row level security;
alter table public.rapprochements         enable row level security;
alter table public.receptions_frais       enable row level security;
alter table public.paiements_fournisseurs enable row level security;
alter table public.postes_budget          enable row level security;
alter table public.budgets                enable row level security;
alter table public.budgets_lignes         enable row level security;
alter table public.depenses               enable row level security;

-- Liste des comptes : utile aussi à qui saisit une dépense ou paie un achat (choix du compte).
create policy lecture on public.comptes_tresorerie for select to authenticated
  using (prive.a_permission(organisation_id, 'tresorerie.consulter')
         or prive.a_permission(organisation_id, 'budget.creer')
         or prive.a_permission(organisation_id, 'fournisseurs.creer')
         or prive.a_permission(organisation_id, 'achats.creer')
         or prive.a_permission(organisation_id, 'stock.creer'));
create policy creation on public.comptes_tresorerie for insert to authenticated
  with check (prive.a_permission(organisation_id, 'tresorerie.modifier'));
create policy modification on public.comptes_tresorerie for update to authenticated
  using (prive.a_permission(organisation_id, 'tresorerie.modifier'))
  with check (prive.a_permission(organisation_id, 'tresorerie.modifier'));

create policy lecture on public.virements for select to authenticated
  using (prive.a_permission(organisation_id, 'tresorerie.consulter'));
create policy lecture on public.rapprochements for select to authenticated
  using (prive.a_permission(organisation_id, 'tresorerie.consulter'));

create policy lecture on public.receptions_frais for select to authenticated
  using (exists (select 1 from public.receptions r where r.id = reception_id));
create policy creation on public.receptions_frais for insert to authenticated
  with check (prive.reception_brouillon_modifiable(reception_id));
create policy modification on public.receptions_frais for update to authenticated
  using (prive.reception_brouillon_modifiable(reception_id))
  with check (prive.reception_brouillon_modifiable(reception_id));
create policy suppression on public.receptions_frais for delete to authenticated
  using (prive.reception_brouillon_modifiable(reception_id));

create policy lecture on public.paiements_fournisseurs for select to authenticated
  using (prive.a_permission(organisation_id, 'fournisseurs.consulter')
         or prive.a_permission(organisation_id, 'achats.consulter')
         or prive.a_permission(organisation_id, 'tresorerie.consulter'));

create policy lecture on public.postes_budget for select to authenticated
  using (prive.a_permission(organisation_id, 'budget.consulter'));
create policy creation on public.postes_budget for insert to authenticated
  with check (prive.a_permission(organisation_id, 'budget.modifier'));
create policy modification on public.postes_budget for update to authenticated
  using (prive.a_permission(organisation_id, 'budget.modifier'))
  with check (prive.a_permission(organisation_id, 'budget.modifier'));
create policy lecture on public.budgets for select to authenticated
  using (prive.a_permission(organisation_id, 'budget.consulter'));
create policy lecture on public.budgets_lignes for select to authenticated
  using (prive.a_permission(organisation_id, 'budget.consulter'));
create policy lecture on public.depenses for select to authenticated
  using (prive.a_permission(organisation_id, 'budget.consulter') or prive.a_permission(organisation_id, 'tresorerie.consulter'));

revoke all on public.comptes_tresorerie, public.virements, public.rapprochements, public.receptions_frais,
  public.paiements_fournisseurs, public.postes_budget, public.budgets, public.budgets_lignes, public.depenses
  from anon, authenticated;
grant select on public.comptes_tresorerie, public.virements, public.rapprochements, public.receptions_frais,
  public.paiements_fournisseurs, public.postes_budget, public.budgets, public.budgets_lignes, public.depenses
  to authenticated;
grant insert (organisation_id, nom, type, caisse_id, numero, solde_initial, date_ouverture, ordre)
  on public.comptes_tresorerie to authenticated;
grant update (nom, type, caisse_id, numero, solde_initial, date_ouverture, actif, ordre)
  on public.comptes_tresorerie to authenticated;
grant insert (organisation_id, reception_id, nature, libelle, montant, compte_id) on public.receptions_frais to authenticated;
grant update (nature, libelle, montant, compte_id) on public.receptions_frais to authenticated;
grant delete on public.receptions_frais to authenticated;
grant insert (organisation_id, libelle, compte_syscohada, nature, ordre) on public.postes_budget to authenticated;
grant update (libelle, compte_syscohada, nature, ordre, actif) on public.postes_budget to authenticated;
-- Nouveaux champs de la réception (brouillon) et du lien moyen → compte.
grant insert (repartition, reglement, echeance, compte_paiement_id) on public.receptions to authenticated;
grant update (repartition, reglement, echeance, compte_paiement_id) on public.receptions to authenticated;
grant insert (poids) on public.receptions_lignes to authenticated;
grant update (poids) on public.receptions_lignes to authenticated;
grant update (compte_id) on public.moyens_paiement to authenticated;

revoke all on function
  prive.tg_controle_prix_vente(), prive.lier_moyens_aux_comptes(uuid), prive.tg_moyen_vers_compte(),
  prive.tg_total_frais(), prive.dettes_receptions(uuid), prive.creer_postes_par_defaut(uuid),
  prive.tg_pilotage_par_defaut(), prive.flux_tresorerie(uuid), prive.solde_compte(uuid, date)
from public, anon, authenticated;

revoke all on function
  public.situation_fournisseurs(uuid), public.historique_fournisseur(uuid),
  public.payer_fournisseur(uuid, uuid, uuid, bigint, uuid, date, text, text),
  public.annuler_paiement_fournisseur(uuid, text), public.couts_de_revient(uuid),
  public.enregistrer_budget(uuid, date, jsonb), public.valider_budget(uuid), public.reviser_budget(uuid, text),
  public.enregistrer_depense(uuid, date, uuid, uuid, bigint, text, text, text), public.annuler_depense(uuid, text),
  public.suivi_budget(uuid, date), public.tresorerie(uuid), public.mouvements_tresorerie(uuid, date, date),
  public.saisir_virement(uuid, uuid, uuid, bigint, bigint, date, text, text), public.valider_virement(uuid),
  public.annuler_virement(uuid, text), public.rapprocher_compte(uuid, date, bigint, text)
from public, anon;
grant execute on function
  public.situation_fournisseurs(uuid), public.historique_fournisseur(uuid),
  public.payer_fournisseur(uuid, uuid, uuid, bigint, uuid, date, text, text),
  public.annuler_paiement_fournisseur(uuid, text), public.couts_de_revient(uuid),
  public.enregistrer_budget(uuid, date, jsonb), public.valider_budget(uuid), public.reviser_budget(uuid, text),
  public.enregistrer_depense(uuid, date, uuid, uuid, bigint, text, text, text), public.annuler_depense(uuid, text),
  public.suivi_budget(uuid, date), public.tresorerie(uuid), public.mouvements_tresorerie(uuid, date, date),
  public.saisir_virement(uuid, uuid, uuid, bigint, bigint, date, text, text), public.valider_virement(uuid),
  public.annuler_virement(uuid, text), public.rapprocher_compte(uuid, date, bigint, text)
to authenticated;
