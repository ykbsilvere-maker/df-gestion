-- =====================================================================
-- v1.0 — Rentabilité (module 6) et surstock / soldes (module 7)
-- Aide à la gestion : les états financiers officiels restent à faire valider par un expert-comptable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Valeur du stock à une date (coût moyen pondéré des mouvements)
-- ---------------------------------------------------------------------

create function prive.valeur_stock(p_org uuid, p_au timestamptz) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(m.valeur), 0)::bigint from public.mouvements_stock m
  where m.organisation_id = p_org and m.created_at < p_au
$$;

-- Indicateurs d'un mois : ventes, coût des ventes, achats, charges par compte SYSCOHADA.
create function prive.indicateurs_mois(p_org uuid, p_mois date)
returns table (ca bigint, cout_ventes bigint, achats bigint, frais_achats bigint, stock_debut bigint, stock_fin bigint,
               charges_reelles bigint, charges_prevues bigint, budget_valide boolean, nb_tickets bigint)
language sql stable security definer set search_path = '' as $$
  with bornes as (
    select (date_trunc('month', p_mois)::timestamp at time zone 'Africa/Abidjan') debut,
           ((date_trunc('month', p_mois) + interval '1 month')::timestamp at time zone 'Africa/Abidjan') fin,
           date_trunc('month', p_mois)::date m0, (date_trunc('month', p_mois) + interval '1 month')::date m1
  ),
  v as (select v.* from public.ventes v, bornes b
         where v.organisation_id = p_org and v.statut = 'validee' and v.date_vente >= b.debut and v.date_vente < b.fin)
  select
    (select coalesce(sum(total), 0) from v)::bigint,
    (select coalesce(round(sum(l.quantite * coalesce(l.cout_unitaire, 0))), 0) from public.ventes_lignes l join v on v.id = l.vente_id)::bigint,
    (select coalesce(round(sum(rl.quantite * rl.prix_unitaire)), 0) from public.receptions r join public.receptions_lignes rl on rl.reception_id = r.id, bornes b
      where r.organisation_id = p_org and r.statut = 'validee' and r.date_reception >= b.m0 and r.date_reception < b.m1)::bigint,
    (select coalesce(sum(r.frais_approche), 0) from public.receptions r, bornes b
      where r.organisation_id = p_org and r.statut = 'validee' and r.date_reception >= b.m0 and r.date_reception < b.m1)::bigint,
    prive.valeur_stock(p_org, (select debut from bornes)),
    prive.valeur_stock(p_org, least((select fin from bornes), now())),
    (select coalesce(sum(d.montant), 0) from public.depenses d, bornes b
      where d.organisation_id = p_org and d.statut = 'enregistree' and d.date_depense >= b.m0 and d.date_depense < b.m1)::bigint,
    (select coalesce(sum(bl.montant), 0) from public.budgets bu join public.budgets_lignes bl on bl.budget_id = bu.id, bornes b
      where bu.organisation_id = p_org and bu.mois = b.m0 and bu.statut = 'valide')::bigint,
    exists (select 1 from public.budgets bu, bornes b where bu.organisation_id = p_org and bu.mois = b.m0 and bu.statut = 'valide'),
    (select count(*) from v)
$$;

-- Charges du mois par poste : le réel, et à défaut (poste encore sans dépense) le budget validé.
create function prive.charges_mois(p_org uuid, p_mois date)
returns table (poste_id uuid, libelle text, compte text, reel bigint, prevu bigint, retenu bigint, estime boolean)
language sql stable security definer set search_path = '' as $$
  with m as (select date_trunc('month', p_mois)::date m0, (date_trunc('month', p_mois) + interval '1 month')::date m1),
  b as (select bl.poste_id, bl.montant from public.budgets bu join public.budgets_lignes bl on bl.budget_id = bu.id, m
         where bu.organisation_id = p_org and bu.mois = m.m0 and bu.statut = 'valide'),
  d as (select de.poste_id, sum(de.montant) montant from public.depenses de, m
         where de.organisation_id = p_org and de.statut = 'enregistree' and de.date_depense >= m.m0 and de.date_depense < m.m1
         group by de.poste_id)
  select p.id, p.libelle, coalesce(p.compte_syscohada, ''),
         coalesce(d.montant, 0)::bigint, coalesce(b.montant, 0)::bigint,
         case when coalesce(d.montant, 0) > 0 then d.montant
              when (select m1 from m) > current_date then coalesce(b.montant, 0) else 0 end::bigint,
         coalesce(d.montant, 0) = 0 and coalesce(b.montant, 0) > 0 and (select m1 from m) > current_date
  from public.postes_budget p
  left join b on b.poste_id = p.id
  left join d on d.poste_id = p.id
  where p.organisation_id = p_org and (d.montant > 0 or b.montant > 0)
$$;

create function public.compte_exploitation(p_org uuid, p_mois date default current_date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_mois date := date_trunc('month', p_mois)::date;
  i record;
  v_charges bigint;
  v_charges_detail jsonb;
  v_marge bigint;
  v_taux numeric;
  v_seuil bigint;
  v_point_mort date;
  v_jours_restants int;
  v_evolution jsonb;
  v_sig jsonb;
  c record;
  x_achats_autres bigint := 0; x_personnel bigint := 0; x_dotations bigint := 0; x_financier bigint := 0;
  x_hao bigint := 0; x_impot bigint := 0; x_impots_taxes bigint := 0;
  v_variation bigint;
  xa bigint; xc bigint; xd bigint; xe bigint; xf bigint; xg bigint; xi bigint;
begin
  perform prive.exiger(prive.a_permission(p_org, 'rentabilite.consulter'), 'Droit « rentabilite.consulter » requis');
  select * into i from prive.indicateurs_mois(p_org, v_mois);
  select coalesce(sum(retenu), 0),
         coalesce(jsonb_agg(jsonb_build_object('libelle', libelle, 'compte', compte, 'reel', reel, 'prevu', prevu,
                                               'retenu', retenu, 'estime', estime) order by retenu desc), '[]'::jsonb)
    into v_charges, v_charges_detail from prive.charges_mois(p_org, v_mois);
  v_marge := i.ca - i.cout_ventes;
  v_taux := case when i.ca > 0 then v_marge::numeric / i.ca end;
  v_seuil := case when v_taux > 0 then ceil(v_charges / v_taux) end;

  -- Point mort : premier jour où la marge cumulée couvre les charges du mois.
  select d into v_point_mort from (
    select d, sum(marge_jour) over (order by d) cumul
    from (select (v.date_vente at time zone 'Africa/Abidjan')::date d,
                 sum(v.total) - sum(coalesce(k.cout, 0)) marge_jour
            from public.ventes v
            left join lateral (select sum(l.quantite * coalesce(l.cout_unitaire, 0)) cout from public.ventes_lignes l where l.vente_id = v.id) k on true
           where v.organisation_id = p_org and v.statut = 'validee'
             and (v.date_vente at time zone 'Africa/Abidjan')::date >= v_mois
             and (v.date_vente at time zone 'Africa/Abidjan')::date < (v_mois + interval '1 month')::date
           group by 1) j
  ) x where cumul >= v_charges and v_charges > 0 order by d limit 1;
  v_jours_restants := greatest(0, ((v_mois + interval '1 month')::date - greatest(current_date, v_mois)));

  -- Soldes intermédiaires de gestion (SYSCOHADA révisé), d'après les comptes des postes de charges.
  for c in select * from prive.charges_mois(p_org, v_mois) loop
    if c.compte like '66%' then x_personnel := x_personnel + c.retenu;
    elsif c.compte like '64%' then x_impots_taxes := x_impots_taxes + c.retenu;
    elsif c.compte like '68%' or c.compte like '69%' and c.compte not like '695%' then x_dotations := x_dotations + c.retenu;
    elsif c.compte like '67%' then x_financier := x_financier + c.retenu;
    elsif c.compte like '8%' then x_hao := x_hao + c.retenu;
    elsif c.compte like '695%' or c.compte like '89%' then x_impot := x_impot + c.retenu;
    else x_achats_autres := x_achats_autres + c.retenu;
    end if;
  end loop;
  v_variation := i.stock_debut - i.stock_fin;           -- 6031 : stock initial − stock final
  xa := i.ca - (i.achats + i.frais_achats) - v_variation; -- 701 − 601 (frais d'approche inclus) ± 6031
  xc := xa - x_achats_autres - x_impots_taxes;
  xd := xc - x_personnel;
  xe := xd - x_dotations;
  xf := 0 - x_financier;
  xg := xe + xf;
  xi := xg - x_hao - x_impot;
  v_sig := jsonb_build_array(
    jsonb_build_object('repere', 'XA', 'libelle', 'Marge commerciale', 'montant', xa,
                       'detail', jsonb_build_object('ventes_701', i.ca, 'achats_601', i.achats + i.frais_achats, 'variation_stock_6031', v_variation)),
    jsonb_build_object('repere', 'XB', 'libelle', 'Chiffre d''affaires', 'montant', i.ca),
    jsonb_build_object('repere', 'XC', 'libelle', 'Valeur ajoutée', 'montant', xc,
                       'detail', jsonb_build_object('services_exterieurs_autres_achats', x_achats_autres, 'impots_taxes_64', x_impots_taxes)),
    jsonb_build_object('repere', 'XD', 'libelle', 'Excédent brut d''exploitation', 'montant', xd,
                       'detail', jsonb_build_object('charges_personnel_66', x_personnel)),
    jsonb_build_object('repere', 'XE', 'libelle', 'Résultat d''exploitation', 'montant', xe,
                       'detail', jsonb_build_object('dotations_68', x_dotations)),
    jsonb_build_object('repere', 'XF', 'libelle', 'Résultat financier', 'montant', xf,
                       'detail', jsonb_build_object('frais_financiers_67', x_financier)),
    jsonb_build_object('repere', 'XG', 'libelle', 'Résultat des activités ordinaires', 'montant', xg),
    jsonb_build_object('repere', 'XH', 'libelle', 'Résultat hors activités ordinaires', 'montant', -x_hao),
    jsonb_build_object('repere', 'XI', 'libelle', 'Résultat net', 'montant', xi,
                       'detail', jsonb_build_object('impot_resultat', x_impot)));

  -- Évolution sur 12 mois.
  select jsonb_agg(jsonb_build_object('mois', m, 'ca', ind.ca, 'marge', ind.ca - ind.cout_ventes,
                                      'taux_marge', case when ind.ca > 0 then round(100.0 * (ind.ca - ind.cout_ventes) / ind.ca, 1) end,
                                      'charges', ch.total, 'resultat', ind.ca - ind.cout_ventes - ch.total) order by m)
    into v_evolution
  from generate_series(v_mois - interval '11 months', v_mois, interval '1 month') g(m0)
  cross join lateral (select g.m0::date m) mm
  cross join lateral prive.indicateurs_mois(p_org, mm.m) ind
  cross join lateral (select coalesce(sum(retenu), 0) total from prive.charges_mois(p_org, mm.m)) ch;

  return jsonb_build_object(
    'mois', v_mois,
    'chiffre_affaires', i.ca, 'cout_ventes', i.cout_ventes, 'marge', v_marge,
    'taux_marge', case when v_taux is not null then round(100 * v_taux, 1) end,
    'charges', v_charges, 'charges_detail', v_charges_detail, 'budget_valide', i.budget_valide,
    'resultat', v_marge - v_charges,
    'seuil_rentabilite', v_seuil,
    'point_mort', v_point_mort,
    'reste_a_vendre', case when v_seuil is not null then greatest(v_seuil - i.ca, 0) end,
    'par_jour_restant', case when v_seuil is not null and v_jours_restants > 0 then ceil(greatest(v_seuil - i.ca, 0)::numeric / v_jours_restants) end,
    'jours_restants', v_jours_restants,
    'tickets', i.nb_tickets,
    'sig', v_sig,
    'evolution', coalesce(v_evolution, '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- 2. Surstock et soldes
-- ---------------------------------------------------------------------

create table public.parametres_soldes (
  organisation_id      uuid primary key references public.organisations(id),
  surstock_jours       smallint not null default 90 check (surstock_jours between 15 and 720),
  surstock_fort_jours  smallint not null default 180 check (surstock_fort_jours between 30 and 1000),
  dormant_jours        smallint not null default 60 check (dormant_jours between 15 and 720),
  peremption_jours     smallint not null default 30 check (peremption_jours between 1 and 365),
  taux_stockage_mois   numeric(5,2) not null default 2 check (taux_stockage_mois between 0 and 20),
  remise_surstock      numeric(5,2) not null default 10 check (remise_surstock between 0 and 90),
  remise_surstock_fort numeric(5,2) not null default 25 check (remise_surstock_fort between 0 and 90),
  updated_at           timestamptz not null default now()
);

create table public.promotions (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations(id),
  produit_id       uuid not null,
  prix_promo       bigint not null check (prix_promo >= 0),
  prix_normal      bigint not null,
  cout_reference   bigint,
  date_debut       date not null,
  date_fin         date not null,
  motif            text check (motif is null or length(motif) <= 300),
  sous_cout_motif  text check (sous_cout_motif is null or length(sous_cout_motif) <= 300),
  statut           text not null default 'proposee' check (statut in ('proposee','active','annulee')),
  cree_par         uuid default auth.uid(),
  valide_par       uuid,
  valide_le        timestamptz,
  created_at       timestamptz not null default now(),
  check (date_fin >= date_debut),
  check (prix_promo < prix_normal),
  foreign key (organisation_id, produit_id) references public.produits(organisation_id, id)
);
create index promotions_produit_idx on public.promotions (organisation_id, produit_id, date_debut, date_fin);

-- Prix promotionnel en vigueur pour un produit à une date (le plus bas si plusieurs).
create function prive.prix_promo(p_org uuid, p_produit uuid, p_jour date default (now() at time zone 'Africa/Abidjan')::date)
returns bigint
language sql stable security definer set search_path = '' as $$
  select min(prix_promo) from public.promotions
  where organisation_id = p_org and produit_id = p_produit and statut = 'active'
    and p_jour between date_debut and date_fin
$$;
grant execute on function prive.prix_promo(uuid, uuid, date) to authenticated;

-- La caisse applique le prix de la promotion automatiquement.
create or replace function public.catalogue_caisse(p_org uuid, p_magasin uuid)
returns table (id uuid, code text, designation text, unite text, prix_vente bigint, taux_tva numeric,
               codes_barres text[], quantite_stock numeric)
language sql stable set search_path = '' as $$
  select p.id, p.code, p.designation, p.unite, coalesce(prive.prix_promo(p_org, p.id), p.prix_vente), p.taux_tva,
         coalesce((select array_agg(cb.code) from public.codes_barres cb where cb.produit_id = p.id), '{}'),
         coalesce((select s.quantite from public.stocks s where s.produit_id = p.id and s.magasin_id = p_magasin), 0)
  from public.produits p
  where p.organisation_id = p_org and p.statut = 'actif'
  order by p.designation
$$;

-- Le serveur accepte le prix de la promotion du jour de la vente.
do $$
declare d text;
begin
  select pg_get_functiondef('public.enregistrer_vente(jsonb)'::regprocedure) into d;
  if position('v_prix = p.prix_vente or' in d) = 0 then
    raise exception 'enregistrer_vente : point de contrôle du prix introuvable';
  end if;
  d := replace(d, 'v_prix = p.prix_vente or',
               'v_prix = p.prix_vente or v_prix = prive.prix_promo(v_org, p.id, (least(coalesce((p_vente ->> ''date_vente'')::timestamptz, now()), now()) at time zone ''Africa/Abidjan'')::date) or');
  execute d;
end $$;

create function public.analyse_surstock(p_org uuid, p_magasin uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  pr public.parametres_soldes;
  v_lignes jsonb;
  v_marges boolean := prive.a_permission(p_org, 'rapports.valider') or prive.a_permission(p_org, 'promotions.consulter');
begin
  perform prive.exiger(prive.a_permission(p_org, 'promotions.consulter'), 'Droit « promotions.consulter » requis');
  select * into pr from public.parametres_soldes where organisation_id = p_org;
  if not found then pr := row(p_org, 90, 180, 60, 30, 2, 10, 25, now())::public.parametres_soldes; end if;

  with st as (
    select s.produit_id, sum(s.quantite) quantite,
           case when sum(s.quantite) > 0 then sum(s.quantite * s.cout_moyen) / sum(s.quantite) else max(s.cout_moyen) end cmp,
           max(s.derniere_sortie) derniere_sortie, max(s.derniere_entree) derniere_entree
    from public.stocks s
    where s.organisation_id = p_org and (p_magasin is null or s.magasin_id = p_magasin) and prive.acces_magasin(p_org, s.magasin_id)
    group by s.produit_id having sum(s.quantite) > 0
  ),
  v30 as (
    select l.produit_id, sum(l.quantite) qte from public.ventes_lignes l join public.ventes v on v.id = l.vente_id
    where v.organisation_id = p_org and v.statut = 'validee' and v.date_vente >= now() - interval '30 days'
      and (p_magasin is null or v.magasin_id = p_magasin)
    group by l.produit_id
  ),
  -- Âge moyen du stock restant : on suppose que restent les entrées les plus récentes (premier entré, premier sorti).
  entrees as (
    select m.produit_id, m.created_at, m.quantite,
           sum(m.quantite) over (partition by m.produit_id order by m.created_at desc rows unbounded preceding) cumul
    from public.mouvements_stock m
    where m.organisation_id = p_org and m.quantite > 0 and (p_magasin is null or m.magasin_id = p_magasin)
  ),
  age as (
    select e.produit_id,
           sum(least(e.quantite, greatest(st.quantite - (e.cumul - e.quantite), 0)) * extract(epoch from now() - e.created_at) / 86400)
             / nullif(sum(least(e.quantite, greatest(st.quantite - (e.cumul - e.quantite), 0))), 0) jours
    from entrees e join st on st.produit_id = e.produit_id
    where e.cumul - e.quantite < st.quantite
    group by e.produit_id
  ),
  peremption as (
    select sl.produit_id, min(lo.date_peremption) date_peremption, sum(sl.quantite) quantite
    from public.stocks_lots sl join public.lots lo on lo.id = sl.lot_id
    where sl.organisation_id = p_org and sl.quantite > 0 and lo.date_peremption is not null
      and lo.date_peremption <= current_date + pr.peremption_jours
      and (p_magasin is null or sl.magasin_id = p_magasin)
    group by sl.produit_id
  ),
  -- Semaines de l'année où l'article s'est le mieux vendu (historique complet).
  saisons as (
    select produit_id, array_agg(semaine order by qte desc) semaines from (
      select l.produit_id, extract(week from v.date_vente at time zone 'Africa/Abidjan')::int semaine, sum(l.quantite) qte,
             row_number() over (partition by l.produit_id order by sum(l.quantite) desc) rang
      from public.ventes_lignes l join public.ventes v on v.id = l.vente_id
      where v.organisation_id = p_org and v.statut = 'validee'
      group by l.produit_id, 2
    ) x where rang <= 3 group by produit_id
  ),
  base as (
    select p.id, p.code, p.designation, p.prix_vente, p.seuil_max, p.photo_path,
           st.quantite stock, round(st.cmp)::bigint cout, round(st.quantite * st.cmp)::bigint valeur,
           coalesce(v30.qte, 0) vendu_30j,
           case when coalesce(v30.qte, 0) > 0 then round(st.quantite / (v30.qte / 30.0)) end couverture_jours,
           round(coalesce(age.jours, extract(epoch from now() - st.derniere_entree) / 86400))::int age_moyen_jours,
           case when st.derniere_sortie is null then null else (current_date - (st.derniere_sortie at time zone 'Africa/Abidjan')::date) end jours_sans_vente,
           pe.date_peremption, pe.quantite quantite_perissable,
           round(st.quantite * st.cmp * pr.taux_stockage_mois / 100)::bigint cout_stockage_mois,
           sa.semaines,
           (select prix_promo from public.promotions pm where pm.produit_id = p.id and pm.statut = 'active'
              and current_date between pm.date_debut and pm.date_fin order by prix_promo limit 1) promo_en_cours
    from st join public.produits p on p.id = st.produit_id
    left join v30 on v30.produit_id = p.id
    left join age on age.produit_id = p.id
    left join peremption pe on pe.produit_id = p.id
    left join saisons sa on sa.produit_id = p.id
    where p.organisation_id = p_org and p.statut <> 'arrete'
  ),
  classe as (
    select b.*,
           case when b.date_peremption is not null then 'peremption'
                when coalesce(b.jours_sans_vente, b.age_moyen_jours) >= pr.dormant_jours and b.vendu_30j = 0 then 'dormant'
                when b.couverture_jours > pr.surstock_fort_jours then 'surstock_fort'
                when b.couverture_jours > pr.surstock_jours or (b.seuil_max is not null and b.stock > b.seuil_max) then 'surstock'
                else 'normal' end situation
    from base b
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'code', c.code, 'designation', c.designation, 'photo_path', c.photo_path,
           'stock', c.stock, 'valeur', c.valeur, 'cout', case when v_marges then c.cout end,
           'prix_vente', c.prix_vente, 'vendu_30j', c.vendu_30j, 'couverture_jours', c.couverture_jours,
           'age_moyen_jours', c.age_moyen_jours, 'jours_sans_vente', c.jours_sans_vente,
           'date_peremption', c.date_peremption, 'quantite_perissable', c.quantite_perissable,
           'cout_stockage_mois', c.cout_stockage_mois, 'situation', c.situation, 'promo_en_cours', c.promo_en_cours,
           'semaines_fortes', c.semaines,
           'remise_proposee', r.remise,
           'prix_propose', r.prix,
           'plancher_atteint', r.prix <= c.cout,
           'proposition', case c.situation
               when 'peremption' then 'Péremption proche : remise jusqu''au coût de revient'
               when 'dormant' then 'Article dormant : remise de 20 à 30 % ou lot « 2 achetés, 1 offert »'
               when 'surstock_fort' then 'Plus de ' || pr.surstock_fort_jours || ' jours de stock : remise de 20 à 30 %, lot « 2 achetés, 1 offert »'
               when 'surstock' then 'Surstock : remise de ' || pr.remise_surstock || ' % ou mise en avant en caisse'
               else null end)
           order by case c.situation when 'peremption' then 1 when 'dormant' then 2 when 'surstock_fort' then 3 when 'surstock' then 4 else 5 end,
                    c.valeur desc), '[]'::jsonb)
    into v_lignes
  from classe c
  cross join lateral (
    select remise, greatest(round(c.prix_vente * (1 - remise / 100) / 5) * 5, c.cout)::bigint prix from (
      select case c.situation
               when 'peremption' then greatest(0, round(100.0 * (c.prix_vente - c.cout) / nullif(c.prix_vente, 0)))
               when 'dormant' then pr.remise_surstock_fort
               when 'surstock_fort' then pr.remise_surstock_fort
               when 'surstock' then pr.remise_surstock
               else 0 end::numeric remise) z
  ) r
  where c.situation <> 'normal';

  return jsonb_build_object('parametres', to_jsonb(pr), 'lignes', v_lignes,
    'totaux', jsonb_build_object(
      'valeur_immobilisee', (select coalesce(sum((e ->> 'valeur')::bigint), 0) from jsonb_array_elements(v_lignes) e),
      'cout_stockage_mois', (select coalesce(sum((e ->> 'cout_stockage_mois')::bigint), 0) from jsonb_array_elements(v_lignes) e),
      'articles', jsonb_array_length(v_lignes)));
end $$;

create function public.enregistrer_parametres_soldes(p_org uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'promotions.valider'), 'Droit « promotions.valider » requis');
  insert into public.parametres_soldes (organisation_id, surstock_jours, surstock_fort_jours, dormant_jours, peremption_jours,
                                        taux_stockage_mois, remise_surstock, remise_surstock_fort)
  values (p_org, coalesce((p ->> 'surstock_jours')::smallint, 90), coalesce((p ->> 'surstock_fort_jours')::smallint, 180),
          coalesce((p ->> 'dormant_jours')::smallint, 60), coalesce((p ->> 'peremption_jours')::smallint, 30),
          coalesce((p ->> 'taux_stockage_mois')::numeric, 2), coalesce((p ->> 'remise_surstock')::numeric, 10),
          coalesce((p ->> 'remise_surstock_fort')::numeric, 25))
  on conflict (organisation_id) do update set
    surstock_jours = excluded.surstock_jours, surstock_fort_jours = excluded.surstock_fort_jours,
    dormant_jours = excluded.dormant_jours, peremption_jours = excluded.peremption_jours,
    taux_stockage_mois = excluded.taux_stockage_mois, remise_surstock = excluded.remise_surstock,
    remise_surstock_fort = excluded.remise_surstock_fort, updated_at = now();
end $$;

create function public.creer_promotion(
  p_org uuid, p_produit uuid, p_prix bigint, p_debut date, p_fin date, p_motif text default null, p_sous_cout_motif text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.produits;
  v_cout bigint;
  v_valide boolean := prive.a_permission(p_org, 'promotions.valider');
  v_id uuid;
begin
  perform prive.exiger(prive.a_permission(p_org, 'promotions.creer'), 'Droit « promotions.creer » requis');
  select * into p from public.produits where id = p_produit and organisation_id = p_org;
  perform prive.exiger(found, 'Produit introuvable');
  perform prive.exiger(p_prix >= 0 and p_prix < p.prix_vente, 'Le prix de solde doit être inférieur au prix actuel');
  perform prive.exiger(p_debut is not null and p_fin is not null and p_fin >= p_debut, 'Dates invalides');
  select round(case when sum(s.quantite) > 0 then sum(s.quantite * s.cout_moyen) / sum(s.quantite) else max(s.cout_moyen) end)::bigint
    into v_cout from public.stocks s where s.produit_id = p.id;
  -- Prix plancher : jamais sous le coût de revient, sauf décision du propriétaire avec motif.
  if v_cout is not null and p_prix < v_cout then
    perform prive.exiger(v_valide and length(btrim(coalesce(p_sous_cout_motif, ''))) >= 3,
                         format('Prix sous le coût de revient (%s) : seul le propriétaire peut le décider, avec un motif', v_cout));
  end if;
  insert into public.promotions (organisation_id, produit_id, prix_promo, prix_normal, cout_reference, date_debut, date_fin,
                                 motif, sous_cout_motif, statut, valide_par, valide_le)
  values (p_org, p.id, p_prix, p.prix_vente, v_cout, p_debut, p_fin, nullif(btrim(p_motif), ''), nullif(btrim(p_sous_cout_motif), ''),
          case when v_valide then 'active' else 'proposee' end, case when v_valide then auth.uid() end, case when v_valide then now() end)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'statut', case when v_valide then 'active' else 'proposee' end);
end $$;

create function public.changer_statut_promotion(p_promotion uuid, p_statut text) returns void
language plpgsql security definer set search_path = '' as $$
declare pm public.promotions;
begin
  select * into pm from public.promotions where id = p_promotion for update;
  perform prive.exiger(found, 'Promotion introuvable');
  perform prive.exiger(prive.a_permission(pm.organisation_id, 'promotions.valider'), 'Droit « promotions.valider » requis');
  perform prive.exiger(p_statut in ('active','annulee'), 'Statut inconnu');
  perform prive.exiger(pm.statut <> 'annulee', 'Promotion déjà annulée');
  update public.promotions set statut = p_statut,
         valide_par = case when p_statut = 'active' then auth.uid() else valide_par end,
         valide_le = case when p_statut = 'active' then now() else valide_le end
   where id = pm.id;
end $$;

-- Bilan : ventes pendant la promotion face à la même durée juste avant.
create function public.bilan_promotions(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'promotions.consulter'), 'Droit « promotions.consulter » requis');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', pm.id, 'produit_id', pm.produit_id, 'designation', p.designation, 'prix_promo', pm.prix_promo,
             'prix_normal', pm.prix_normal, 'cout_reference', pm.cout_reference, 'date_debut', pm.date_debut,
             'date_fin', pm.date_fin, 'statut', pm.statut, 'motif', pm.motif, 'sous_cout_motif', pm.sous_cout_motif,
             'qte_pendant', k.pendant, 'qte_avant', k.avant, 'ca_pendant', k.ca_pendant,
             'en_cours', current_date between pm.date_debut and pm.date_fin) order by pm.date_debut desc)
    from public.promotions pm
    join public.produits p on p.id = pm.produit_id
    cross join lateral (
      select coalesce(sum(l.quantite) filter (where d between pm.date_debut and least(pm.date_fin, current_date)), 0) pendant,
             coalesce(sum(l.quantite) filter (where d >= pm.date_debut - (least(pm.date_fin, current_date) - pm.date_debut + 1)
                                                and d < pm.date_debut), 0) avant,
             coalesce(sum(l.montant) filter (where d between pm.date_debut and least(pm.date_fin, current_date)), 0) ca_pendant
      from public.ventes_lignes l
      join public.ventes v on v.id = l.vente_id and v.statut = 'validee'
      cross join lateral (select (v.date_vente at time zone 'Africa/Abidjan')::date d) dd
      where l.produit_id = pm.produit_id and v.organisation_id = p_org
    ) k
    where pm.organisation_id = p_org), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 3. Journal, RLS, privilèges
-- ---------------------------------------------------------------------

create trigger promotions_audit after insert or update or delete on public.promotions
  for each row execute function prive.tg_audit();
create trigger parametres_soldes_audit after insert or update on public.parametres_soldes
  for each row execute function prive.tg_audit();

alter table public.promotions enable row level security;
alter table public.parametres_soldes enable row level security;
create policy lecture on public.promotions for select to authenticated
  using (prive.a_permission(organisation_id, 'promotions.consulter') or prive.a_permission(organisation_id, 'caisse.creer'));
create policy lecture on public.parametres_soldes for select to authenticated
  using (prive.a_permission(organisation_id, 'promotions.consulter'));
revoke all on public.promotions, public.parametres_soldes from anon, authenticated;
grant select on public.promotions, public.parametres_soldes to authenticated;

revoke all on function prive.valeur_stock(uuid, timestamptz), prive.indicateurs_mois(uuid, date), prive.charges_mois(uuid, date)
  from public, anon, authenticated;
revoke all on function
  public.compte_exploitation(uuid, date), public.analyse_surstock(uuid, uuid), public.enregistrer_parametres_soldes(uuid, jsonb),
  public.creer_promotion(uuid, uuid, bigint, date, date, text, text), public.changer_statut_promotion(uuid, text),
  public.bilan_promotions(uuid)
from public, anon;
grant execute on function
  public.compte_exploitation(uuid, date), public.analyse_surstock(uuid, uuid), public.enregistrer_parametres_soldes(uuid, jsonb),
  public.creer_promotion(uuid, uuid, bigint, date, date, text, text), public.changer_statut_promotion(uuid, text),
  public.bilan_promotions(uuid)
to authenticated;
