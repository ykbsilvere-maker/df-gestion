-- =====================================================================
-- v1.1 — Comptabilité et bilan (module 9), plan SYSCOHADA révisé.
-- Les écritures des opérations sont générées automatiquement, mois par mois, tant que le mois
-- est ouvert ; la clôture les fige. Une correction passe ensuite par une écriture d'extourne.
-- Aide à la gestion : les états financiers officiels restent à valider par un expert-comptable.
-- =====================================================================

-- Compte comptable de chaque compte de trésorerie (ajustable par l'expert-comptable).
alter table public.comptes_tresorerie add column compte_comptable text
  check (compte_comptable is null or compte_comptable ~ '^[0-9]{2,8}$');
update public.comptes_tresorerie set compte_comptable = case type
  when 'caisse' then '5711' when 'caisse_centrale' then '5712' when 'banque' then '5211'
  when 'mobile_money' then '551' else '5800' end;
create function prive.tg_compte_comptable_tresorerie() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.compte_comptable is null then
    new.compte_comptable := case new.type when 'caisse' then '5711' when 'caisse_centrale' then '5712'
      when 'banque' then '5211' when 'mobile_money' then '551' else '5800' end;
  end if;
  return new;
end $$;
create trigger comptes_tresorerie_compte_comptable before insert on public.comptes_tresorerie
  for each row execute function prive.tg_compte_comptable_tresorerie();
grant update (compte_comptable) on public.comptes_tresorerie to authenticated;

create table public.plan_comptable (
  organisation_id uuid not null references public.organisations(id),
  numero          text not null check (numero ~ '^[0-9]{1,8}$'),
  libelle         text not null check (length(btrim(libelle)) between 2 and 120),
  primary key (organisation_id, numero)
);

create function prive.creer_plan_comptable(p_org uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.plan_comptable (organisation_id, numero, libelle)
  select p_org, n, l from (values
    ('101', 'Capital social'), ('121', 'Report à nouveau créditeur'), ('129', 'Report à nouveau débiteur'),
    ('131', 'Résultat net : bénéfice'), ('139', 'Résultat net : perte'), ('162', 'Emprunts auprès des établissements de crédit'),
    ('21', 'Immobilisations incorporelles'), ('24', 'Matériel, mobilier et actifs biologiques'), ('245', 'Matériel de transport'),
    ('284', 'Amortissements du matériel'), ('31', 'Marchandises'),
    ('401', 'Fournisseurs'), ('411', 'Clients'), ('421', 'Personnel, avances et acomptes'), ('431', 'Sécurité sociale (CNPS)'),
    ('4431', 'TVA facturée sur ventes'), ('4452', 'TVA récupérable sur achats'), ('447', 'État, impôts retenus à la source'),
    ('471', 'Débiteurs et créditeurs divers (attente)'),
    ('5211', 'Banque'), ('551', 'Monnaie électronique (Mobile Money)'), ('5711', 'Caisse (tiroirs)'), ('5712', 'Caisse centrale'),
    ('5800', 'Autres trésoreries'), ('585', 'Virements de fonds'),
    ('601', 'Achats de marchandises'), ('6015', 'Frais sur achats (transport, manutention, douane)'), ('6031', 'Variation des stocks de marchandises'),
    ('6051', 'Fournitures non stockables — eau'), ('6052', 'Fournitures non stockables — électricité'),
    ('618', 'Autres frais de transport'), ('622', 'Locations et charges locatives'), ('624', 'Entretien, réparations et maintenance'),
    ('627', 'Publicité, publications, relations publiques'), ('628', 'Frais de télécommunications'), ('631', 'Frais bancaires et Mobile Money'),
    ('64', 'Impôts et taxes'), ('658', 'Charges diverses'), ('661', 'Rémunérations directes versées au personnel'),
    ('664', 'Charges sociales'), ('67', 'Frais financiers'), ('681', 'Dotations aux amortissements d''exploitation'),
    ('701', 'Ventes de marchandises'), ('758', 'Produits divers'), ('77', 'Revenus financiers'), ('89', 'Impôts sur le résultat')
  ) v(n, l)
  on conflict do nothing
$$;
create function prive.tg_plan_par_defaut() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.creer_plan_comptable(new.id);
  return new;
end $$;
create trigger organisations_plan_comptable after insert on public.organisations
  for each row execute function prive.tg_plan_par_defaut();
do $$ begin perform prive.creer_plan_comptable(id) from public.organisations; end $$;

create table public.periodes_comptables (
  organisation_id uuid not null references public.organisations(id),
  mois            date not null check (extract(day from mois) = 1),
  cloturee_le     timestamptz not null default now(),
  cloturee_par    uuid default auth.uid(),
  primary key (organisation_id, mois)
);

create table public.ecritures (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  mois            date not null,
  date_ecriture   date not null,
  journal         text not null check (journal in ('VT','AC','TR','OD','AN')),
  numero          text not null,
  libelle         text not null,
  piece           text,
  piece_type      text,
  piece_id        uuid,
  automatique     boolean not null default true,
  extourne_de     uuid references public.ecritures(id),
  justificatif    text check (justificatif is null or length(justificatif) <= 300),
  cree_par        uuid,
  created_at      timestamptz not null default now()
);
create index ecritures_org_mois_idx on public.ecritures (organisation_id, mois, journal);

create table public.ecritures_lignes (
  id              bigint generated always as identity primary key,
  organisation_id uuid not null,
  ecriture_id     uuid not null references public.ecritures(id) on delete cascade,
  compte          text not null check (compte ~ '^[0-9]{1,8}$'),
  libelle         text,
  debit           bigint not null default 0 check (debit >= 0),
  credit          bigint not null default 0 check (credit >= 0),
  check ((debit = 0) <> (credit = 0))
);
create index ecritures_lignes_ecriture_idx on public.ecritures_lignes (ecriture_id);
create index ecritures_lignes_compte_idx on public.ecritures_lignes (organisation_id, compte);

-- Une écriture des mois clôturés ne se modifie plus.
create function prive.tg_ecriture_figee() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := coalesce(old.organisation_id, new.organisation_id);
        v_mois date := coalesce(old.mois, new.mois);
begin
  if exists (select 1 from public.periodes_comptables where organisation_id = v_org and mois = v_mois) then
    raise exception 'Mois clôturé : corrigez par une écriture d''extourne' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
create trigger ecritures_figees before update or delete on public.ecritures
  for each row execute function prive.tg_ecriture_figee();

-- Ajoute une écriture équilibrée (lignes : [{compte, debit, credit, libelle}], montants nuls ignorés).
create function prive.ajouter_ecriture(
  p_org uuid, p_date date, p_journal text, p_libelle text, p_lignes jsonb,
  p_piece text default null, p_piece_type text default null, p_piece_id uuid default null,
  p_automatique boolean default true, p_justificatif text default null, p_extourne_de uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_debit bigint;
  v_credit bigint;
  v_mois date := date_trunc('month', p_date)::date;
begin
  select coalesce(sum(coalesce((l ->> 'debit')::bigint, 0)), 0), coalesce(sum(coalesce((l ->> 'credit')::bigint, 0)), 0)
    into v_debit, v_credit from jsonb_array_elements(p_lignes) l;
  if v_debit = 0 and v_credit = 0 then return null; end if;
  perform prive.exiger(v_debit = v_credit, format('Écriture déséquilibrée : débit %s, crédit %s', v_debit, v_credit));
  insert into public.ecritures (organisation_id, mois, date_ecriture, journal, numero, libelle, piece, piece_type, piece_id,
                                automatique, justificatif, extourne_de, cree_par)
  values (p_org, v_mois, p_date, p_journal,
          p_journal || '-' || to_char(v_mois, 'YYYYMM') || '-' || lpad(prive.prochain_numero(p_org, 'ecr_' || p_journal || to_char(v_mois, 'YYYYMM'))::text, 5, '0'),
          left(p_libelle, 200), p_piece, p_piece_type, p_piece_id, p_automatique, p_justificatif, p_extourne_de,
          case when p_automatique then null else auth.uid() end)
  returning id into v_id;
  -- Débits et crédits d'un même compte sont compensés ligne par ligne.
  insert into public.ecritures_lignes (organisation_id, ecriture_id, compte, libelle, debit, credit)
  select p_org, v_id, compte, max(libelle), greatest(sum(d) - sum(c), 0), greatest(sum(c) - sum(d), 0)
  from (select l ->> 'compte' compte, l ->> 'libelle' libelle,
               coalesce((l ->> 'debit')::bigint, 0) d, coalesce((l ->> 'credit')::bigint, 0) c
          from jsonb_array_elements(p_lignes) l) x
  group by compte
  having sum(d) <> sum(c);
  return v_id;
end $$;

create function prive.compte_de(p_compte_tresorerie uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select compte_comptable from public.comptes_tresorerie where id = p_compte_tresorerie), '471')
$$;

-- Génère les écritures automatiques d'un mois ouvert (efface puis recrée celles déjà générées).
create function prive.generer_ecritures(p_org uuid, p_mois date) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_m0 date := date_trunc('month', p_mois)::date;
  v_m1 date := (date_trunc('month', p_mois) + interval '1 month')::date;
  v_tva boolean;
  r record;
  v_lignes jsonb;
  v_stock_debut bigint;
  v_stock_fin bigint;
  v_cloture_prec timestamptz;
begin
  if exists (select 1 from public.periodes_comptables where organisation_id = p_org and mois = v_m0) then return; end if;
  if v_m0 > current_date then return; end if;
  delete from public.ecritures where organisation_id = p_org and mois = v_m0 and automatique;
  select regime_fiscal in ('rsi','rni') into v_tva from public.organisations where id = p_org;

  -- 1. Ventes de la caisse : une écriture par jour et par magasin.
  for r in
    select (v.date_vente at time zone 'Africa/Abidjan')::date jour, v.magasin_id, m.nom magasin, array_agg(v.id) ventes
    from public.ventes v join public.magasins m on m.id = v.magasin_id
    where v.organisation_id = p_org and v.statut = 'validee'
      and (v.date_vente at time zone 'Africa/Abidjan')::date >= v_m0 and (v.date_vente at time zone 'Africa/Abidjan')::date < v_m1
    group by 1, 2, 3
  loop
    select coalesce(jsonb_agg(x), '[]'::jsonb) into v_lignes from (
      -- Encaissements par compte de trésorerie (la monnaie rendue par un autre moyen le diminue).
      select jsonb_build_object('compte', z.compte, 'debit', greatest(z.net, 0), 'credit', greatest(-z.net, 0)) x
      from (select prive.compte_de(coalesce(
                     case when rg.nature = 'especes' then (select ct.id from public.comptes_tresorerie ct
                            where ct.organisation_id = p_org and ct.caisse_id = v.caisse_id and ct.actif order by ct.ordre limit 1) end,
                     mp.compte_id)) compte,
                   sum(case when rg.sens = 'rendu' then -rg.montant else rg.montant end)::bigint net
              from public.reglements rg join public.ventes v on v.id = rg.vente_id
              join public.moyens_paiement mp on mp.id = rg.moyen_id
             where rg.vente_id = any(r.ventes) and rg.statut = 'enregistre'
             group by 1) z
      union all
      -- Ventes hors taxes et TVA facturée (régimes RSI / RNI).
      select jsonb_build_object('compte', '701', 'credit',
               sum(case when v_tva and l.taux_tva > 0 then round(l.montant / (1 + l.taux_tva / 100)) else l.montant end)::bigint)
      from public.ventes_lignes l where l.vente_id = any(r.ventes)
      union all
      select jsonb_build_object('compte', '4431', 'credit',
               sum(l.montant - round(l.montant / (1 + l.taux_tva / 100)))::bigint)
      from public.ventes_lignes l where l.vente_id = any(r.ventes) and v_tva and l.taux_tva > 0
      having count(*) > 0
    ) t;
    perform prive.ajouter_ecriture(p_org, r.jour, 'VT', 'Ventes du jour · ' || r.magasin, v_lignes, null, 'ventes_jour', null);
  end loop;

  -- Ventes annulées après la clôture de leur mois : extourne dans le mois de l'annulation.
  for r in
    select v.id, v.numero, v.total, (v.annulee_le at time zone 'Africa/Abidjan')::date jour
    from public.ventes v
    join public.periodes_comptables pc on pc.organisation_id = v.organisation_id
      and pc.mois = date_trunc('month', v.date_vente at time zone 'Africa/Abidjan')::date and v.annulee_le > pc.cloturee_le
    where v.organisation_id = p_org and v.statut = 'annulee'
      and (v.annulee_le at time zone 'Africa/Abidjan')::date >= v_m0 and (v.annulee_le at time zone 'Africa/Abidjan')::date < v_m1
  loop
    select coalesce(jsonb_agg(jsonb_build_object('compte', prive.compte_de(mp.compte_id),
             'credit', case when rg.sens = 'rendu' then 0 else rg.montant end, 'debit', case when rg.sens = 'rendu' then rg.montant else 0 end)), '[]'::jsonb)
           || jsonb_build_array(jsonb_build_object('compte', '701', 'debit', r.total))
      into v_lignes
    from public.reglements rg join public.moyens_paiement mp on mp.id = rg.moyen_id where rg.vente_id = r.id;
    perform prive.ajouter_ecriture(p_org, r.jour, 'VT', 'Annulation du ticket ' || r.numero, v_lignes, r.numero, 'vente', r.id);
  end loop;

  -- 2. Ventes à crédit (créances clients).
  for r in
    select c.*, cl.nom from public.creances c join public.clients cl on cl.id = c.client_id
    where c.organisation_id = p_org and c.statut = 'ouverte' and c.date_creance >= v_m0 and c.date_creance < v_m1
  loop
    perform prive.ajouter_ecriture(p_org, r.date_creance, 'VT', 'Vente à crédit · ' || r.nom || coalesce(' · ' || r.libelle, ''),
      jsonb_build_array(jsonb_build_object('compte', '411', 'debit', r.montant, 'libelle', r.nom),
                        jsonb_build_object('compte', '701', 'credit', r.montant)), r.piece, 'creance', r.id);
  end loop;
  for r in
    select e.*, cl.nom from public.encaissements_creances e join public.clients cl on cl.id = e.client_id
    where e.organisation_id = p_org and e.statut = 'enregistre' and e.date_encaissement >= v_m0 and e.date_encaissement < v_m1
  loop
    perform prive.ajouter_ecriture(p_org, r.date_encaissement, 'TR', 'Règlement client · ' || r.nom,
      jsonb_build_array(jsonb_build_object('compte', prive.compte_de(r.compte_id), 'debit', r.montant),
                        jsonb_build_object('compte', '411', 'credit', r.montant, 'libelle', r.nom)), r.reference, 'encaissement', r.id);
  end loop;

  -- 3. Achats de marchandises et frais d'approche.
  for r in
    select rc.*, f.nom fournisseur,
           (select coalesce(round(sum(quantite * prix_unitaire)), 0) from public.receptions_lignes where reception_id = rc.id)::bigint valeur
    from public.receptions rc left join public.fournisseurs f on f.id = rc.fournisseur_id
    where rc.organisation_id = p_org and rc.statut = 'validee' and rc.date_reception >= v_m0 and rc.date_reception < v_m1
  loop
    select jsonb_build_array(jsonb_build_object('compte', '601', 'debit', r.valeur),
                             jsonb_build_object('compte', '401', 'credit', r.valeur, 'libelle', coalesce(r.fournisseur, 'Fournisseur')))
           || coalesce((select jsonb_agg(x) from (
                select jsonb_build_object('compte', '6015', 'debit', rf.montant) x from public.receptions_frais rf where rf.reception_id = r.id
                union all
                select jsonb_build_object('compte', case when rf.compte_id is null then '401' else prive.compte_de(rf.compte_id) end, 'credit', rf.montant)
                from public.receptions_frais rf where rf.reception_id = r.id) t), '[]'::jsonb)
           || case when r.frais_approche > 0 and not exists (select 1 from public.receptions_frais where reception_id = r.id)
                   then jsonb_build_array(jsonb_build_object('compte', '6015', 'debit', r.frais_approche),
                                          jsonb_build_object('compte', '401', 'credit', r.frais_approche))
                   else '[]'::jsonb end
      into v_lignes;
    perform prive.ajouter_ecriture(p_org, r.date_reception, 'AC', 'Achat ' || r.numero || coalesce(' · ' || r.fournisseur, ''),
      v_lignes, coalesce(r.reference, r.numero), 'reception', r.id);
  end loop;

  -- 4. Paiements des fournisseurs.
  for r in
    select pf.*, f.nom from public.paiements_fournisseurs pf left join public.fournisseurs f on f.id = pf.fournisseur_id
    where pf.organisation_id = p_org and pf.statut = 'enregistre' and pf.date_paiement >= v_m0 and pf.date_paiement < v_m1
  loop
    perform prive.ajouter_ecriture(p_org, r.date_paiement, 'TR', 'Paiement fournisseur · ' || coalesce(r.nom, '—'),
      jsonb_build_array(jsonb_build_object('compte', '401', 'debit', r.montant, 'libelle', r.nom),
                        jsonb_build_object('compte', case when r.compte_id is null then '471' else prive.compte_de(r.compte_id) end, 'credit', r.montant)),
      r.reference, 'paiement_fournisseur', r.id);
  end loop;

  -- 5. Dépenses du budget (et du tiroir-caisse).
  for r in
    select d.*, p.libelle poste, coalesce(p.compte_syscohada, '658') compte_charge
    from public.depenses d join public.postes_budget p on p.id = d.poste_id
    where d.organisation_id = p_org and d.statut = 'enregistree' and d.date_depense >= v_m0 and d.date_depense < v_m1
  loop
    perform prive.ajouter_ecriture(p_org, r.date_depense, 'TR', r.poste || coalesce(' · ' || r.libelle, ''),
      jsonb_build_array(jsonb_build_object('compte', r.compte_charge, 'debit', r.montant),
                        jsonb_build_object('compte', prive.compte_de(r.compte_id), 'credit', r.montant)),
      r.reference, 'depense', r.id);
  end loop;

  -- 6. Virements entre comptes (via 585) et frais de transfert.
  for r in
    select vi.*, cs.nom source, cd.nom destination from public.virements vi
    join public.comptes_tresorerie cs on cs.id = vi.compte_source_id
    join public.comptes_tresorerie cd on cd.id = vi.compte_destination_id
    where vi.organisation_id = p_org and vi.statut = 'valide' and vi.date_virement >= v_m0 and vi.date_virement < v_m1
  loop
    perform prive.ajouter_ecriture(p_org, r.date_virement, 'TR', 'Virement ' || r.source || ' → ' || r.destination,
      jsonb_build_array(jsonb_build_object('compte', '585', 'debit', r.montant),
                        jsonb_build_object('compte', prive.compte_de(r.compte_source_id), 'credit', r.montant + r.frais),
                        jsonb_build_object('compte', prive.compte_de(r.compte_destination_id), 'debit', r.montant),
                        jsonb_build_object('compte', '585', 'credit', r.montant),
                        jsonb_build_object('compte', '631', 'debit', r.frais)),
      r.reference, 'virement', r.id);
  end loop;

  -- 7. Écarts de rapprochement.
  for r in
    select ra.*, c.nom from public.rapprochements ra join public.comptes_tresorerie c on c.id = ra.compte_id
    where ra.organisation_id = p_org and ra.ecart <> 0 and ra.date_rapprochement >= v_m0 and ra.date_rapprochement < v_m1
  loop
    perform prive.ajouter_ecriture(p_org, r.date_rapprochement, 'OD', 'Écart de rapprochement · ' || r.nom || coalesce(' · ' || r.justification, ''),
      case when r.ecart > 0
           then jsonb_build_array(jsonb_build_object('compte', prive.compte_de(r.compte_id), 'debit', r.ecart),
                                  jsonb_build_object('compte', '758', 'credit', r.ecart))
           else jsonb_build_array(jsonb_build_object('compte', '658', 'debit', -r.ecart),
                                  jsonb_build_object('compte', prive.compte_de(r.compte_id), 'credit', -r.ecart)) end,
      null, 'rapprochement', r.id);
  end loop;

  -- 8. À-nouveaux : soldes d'ouverture des comptes de trésorerie.
  for r in
    select c.* from public.comptes_tresorerie c
    where c.organisation_id = p_org and c.solde_initial <> 0 and c.date_ouverture >= v_m0 and c.date_ouverture < v_m1
  loop
    perform prive.ajouter_ecriture(p_org, r.date_ouverture, 'AN', 'Solde d''ouverture · ' || r.nom,
      case when r.solde_initial > 0
           then jsonb_build_array(jsonb_build_object('compte', r.compte_comptable, 'debit', r.solde_initial),
                                  jsonb_build_object('compte', '121', 'credit', r.solde_initial))
           else jsonb_build_array(jsonb_build_object('compte', '129', 'debit', -r.solde_initial),
                                  jsonb_build_object('compte', r.compte_comptable, 'credit', -r.solde_initial)) end,
      null, 'ouverture', r.id);
  end loop;

  -- 9. Fin de mois : variation de stock (6031 / 31) au coût moyen pondéré.
  v_stock_debut := prive.valeur_stock(p_org, (v_m0::timestamp at time zone 'Africa/Abidjan'));
  v_stock_fin := prive.valeur_stock(p_org, least((v_m1::timestamp at time zone 'Africa/Abidjan'), now()));
  if v_stock_fin <> v_stock_debut then
    perform prive.ajouter_ecriture(p_org, least(v_m1 - 1, current_date), 'OD', 'Variation de stock de marchandises',
      case when v_stock_fin > v_stock_debut
           then jsonb_build_array(jsonb_build_object('compte', '31', 'debit', v_stock_fin - v_stock_debut),
                                  jsonb_build_object('compte', '6031', 'credit', v_stock_fin - v_stock_debut))
           else jsonb_build_array(jsonb_build_object('compte', '6031', 'debit', v_stock_debut - v_stock_fin),
                                  jsonb_build_object('compte', '31', 'credit', v_stock_debut - v_stock_fin)) end,
      null, 'variation_stock', null);
  end if;
end $$;

-- Génère les mois ouverts d'une période (au plus 24 mois).
create function prive.generer_periode(p_org uuid, p_debut date, p_fin date) returns void
language plpgsql security definer set search_path = '' as $$
declare m date;
begin
  for m in select generate_series(date_trunc('month', greatest(p_debut, p_fin - 730))::date,
                                  date_trunc('month', least(p_fin, current_date))::date, interval '1 month')::date loop
    perform prive.generer_ecritures(p_org, m);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- États : journal, grand livre, balance, bilan simplifié
-- ---------------------------------------------------------------------

create function public.journal_comptable(p_org uuid, p_debut date, p_fin date, p_journal text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'comptabilite.consulter'), 'Droit « comptabilite.consulter » requis');
  perform prive.generer_periode(p_org, p_debut, p_fin);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', e.id, 'numero', e.numero, 'date_ecriture', e.date_ecriture, 'journal', e.journal, 'libelle', e.libelle,
             'piece', e.piece, 'automatique', e.automatique, 'extourne_de', e.extourne_de, 'justificatif', e.justificatif,
             'cloturee', pc.mois is not null,
             'lignes', (select jsonb_agg(jsonb_build_object('compte', l.compte, 'intitule', pl.libelle, 'libelle', l.libelle,
                                                            'debit', l.debit, 'credit', l.credit) order by l.debit desc, l.compte)
                          from public.ecritures_lignes l
                          left join public.plan_comptable pl on pl.organisation_id = p_org and pl.numero = l.compte
                         where l.ecriture_id = e.id)) order by e.date_ecriture, e.journal, e.numero)
    from public.ecritures e
    left join public.periodes_comptables pc on pc.organisation_id = e.organisation_id and pc.mois = e.mois
    where e.organisation_id = p_org and e.date_ecriture between p_debut and p_fin
      and (p_journal is null or e.journal = p_journal)), '[]'::jsonb);
end $$;

create function public.balance_comptable(p_org uuid, p_debut date, p_fin date) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'comptabilite.consulter'), 'Droit « comptabilite.consulter » requis');
  perform prive.generer_periode(p_org, p_debut - 730, p_fin);
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.compte) from (
      select l.compte, coalesce(max(pl.libelle), 'Compte ' || l.compte) intitule,
             coalesce(sum(l.debit - l.credit) filter (where e.date_ecriture < p_debut), 0)::bigint solde_initial,
             coalesce(sum(l.debit) filter (where e.date_ecriture between p_debut and p_fin), 0)::bigint debit,
             coalesce(sum(l.credit) filter (where e.date_ecriture between p_debut and p_fin), 0)::bigint credit,
             coalesce(sum(l.debit - l.credit) filter (where e.date_ecriture <= p_fin), 0)::bigint solde_final
      from public.ecritures_lignes l
      join public.ecritures e on e.id = l.ecriture_id
      left join public.plan_comptable pl on pl.organisation_id = p_org and pl.numero = l.compte
      where l.organisation_id = p_org and e.date_ecriture <= p_fin
      group by l.compte
    ) x), '[]'::jsonb);
end $$;

create function public.grand_livre(p_org uuid, p_debut date, p_fin date, p_compte text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'comptabilite.consulter'), 'Droit « comptabilite.consulter » requis');
  perform prive.generer_periode(p_org, p_debut - 730, p_fin);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'compte', c.compte, 'intitule', coalesce(pl.libelle, 'Compte ' || c.compte),
             'solde_initial', (select coalesce(sum(l.debit - l.credit), 0) from public.ecritures_lignes l join public.ecritures e on e.id = l.ecriture_id
                                where l.organisation_id = p_org and l.compte = c.compte and e.date_ecriture < p_debut),
             'mouvements', (select jsonb_agg(jsonb_build_object('date', e.date_ecriture, 'numero', e.numero, 'journal', e.journal,
                                                                'libelle', coalesce(l.libelle, e.libelle), 'piece', e.piece,
                                                                'debit', l.debit, 'credit', l.credit) order by e.date_ecriture, e.numero)
                              from public.ecritures_lignes l join public.ecritures e on e.id = l.ecriture_id
                             where l.organisation_id = p_org and l.compte = c.compte and e.date_ecriture between p_debut and p_fin))
           order by c.compte)
    from (select distinct l.compte from public.ecritures_lignes l join public.ecritures e on e.id = l.ecriture_id
           where l.organisation_id = p_org and e.date_ecriture between p_debut and p_fin
             and (p_compte is null or l.compte like p_compte || '%')) c
    left join public.plan_comptable pl on pl.organisation_id = p_org and pl.numero = c.compte), '[]'::jsonb);
end $$;

create function public.bilan_simplifie(p_org uuid, p_au date default current_date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s record;
  a_immo bigint := 0; a_stocks bigint := 0; a_creances bigint := 0; a_treso bigint := 0;
  p_capitaux bigint := 0; p_resultat bigint := 0; p_dettes_fin bigint := 0; p_fournisseurs bigint := 0;
  p_fiscales bigint := 0; p_autres bigint := 0; p_treso bigint := 0;
begin
  perform prive.exiger(prive.a_permission(p_org, 'comptabilite.consulter'), 'Droit « comptabilite.consulter » requis');
  perform prive.generer_periode(p_org, p_au - 730, p_au);
  for s in
    select l.compte, sum(l.debit - l.credit) solde
    from public.ecritures_lignes l join public.ecritures e on e.id = l.ecriture_id
    where l.organisation_id = p_org and e.date_ecriture <= p_au
    group by l.compte having sum(l.debit - l.credit) <> 0
  loop
    if s.compte ~ '^[67]' or s.compte ~ '^8' then p_resultat := p_resultat - s.solde;
    elsif s.compte ~ '^1[0-5]' then p_capitaux := p_capitaux - s.solde;
    elsif s.compte ~ '^1' then p_dettes_fin := p_dettes_fin - s.solde;
    elsif s.compte ~ '^2' then a_immo := a_immo + s.solde;
    elsif s.compte ~ '^3' then a_stocks := a_stocks + s.solde;
    elsif s.compte ~ '^4' then
      if s.solde > 0 then a_creances := a_creances + s.solde;
      elsif s.compte ~ '^40' then p_fournisseurs := p_fournisseurs - s.solde;
      elsif s.compte ~ '^4[2-4]' then p_fiscales := p_fiscales - s.solde;
      else p_autres := p_autres - s.solde; end if;
    elsif s.compte ~ '^5' then
      if s.solde > 0 then a_treso := a_treso + s.solde; else p_treso := p_treso - s.solde; end if;
    end if;
  end loop;
  return jsonb_build_object(
    'au', p_au,
    'actif', jsonb_build_object('immobilisations', a_immo, 'stocks', a_stocks, 'creances', a_creances, 'tresorerie', a_treso,
                                'total', a_immo + a_stocks + a_creances + a_treso),
    'passif', jsonb_build_object('capitaux_propres', p_capitaux, 'resultat', p_resultat, 'dettes_financieres', p_dettes_fin,
                                 'dettes_fournisseurs', p_fournisseurs, 'dettes_fiscales_sociales', p_fiscales,
                                 'autres_dettes', p_autres, 'tresorerie_passif', p_treso,
                                 'total', p_capitaux + p_resultat + p_dettes_fin + p_fournisseurs + p_fiscales + p_autres + p_treso));
end $$;

-- ---------------------------------------------------------------------
-- Écritures manuelles, extourne, clôture
-- ---------------------------------------------------------------------

create function public.ecriture_manuelle(
  p_org uuid, p_date date, p_journal text, p_libelle text, p_lignes jsonb, p_piece text default null, p_justificatif text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform prive.exiger(prive.a_permission(p_org, 'comptabilite.creer'), 'Droit « comptabilite.creer » requis');
  perform prive.exiger(p_journal in ('OD','AN','TR','AC','VT'), 'Journal inconnu');
  perform prive.exiger(length(btrim(coalesce(p_libelle, ''))) >= 3, 'Indiquez le libellé');
  perform prive.exiger(length(btrim(coalesce(p_piece, ''))) >= 1, 'Indiquez la pièce justificative');
  perform prive.exiger(not exists (select 1 from public.periodes_comptables where organisation_id = p_org and mois = date_trunc('month', p_date)::date),
                       'Ce mois est clôturé');
  perform prive.exiger(jsonb_array_length(coalesce(p_lignes, '[]')) >= 2, 'Une écriture a au moins deux lignes');
  perform prive.exiger(not exists (select 1 from jsonb_array_elements(p_lignes) l where (l ->> 'compte') !~ '^[0-9]{1,8}$'), 'Numéro de compte invalide');
  v_id := prive.ajouter_ecriture(p_org, p_date, p_journal, btrim(p_libelle), p_lignes, btrim(p_piece), 'manuelle', null, false, nullif(btrim(p_justificatif), ''));
  perform prive.exiger(v_id is not null, 'Écriture vide');
  return v_id;
end $$;

create function public.extourner_ecriture(p_ecriture uuid, p_motif text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  e public.ecritures;
  v_date date := current_date;
  v_id uuid;
begin
  select * into e from public.ecritures where id = p_ecriture;
  perform prive.exiger(found, 'Écriture introuvable');
  perform prive.exiger(prive.a_permission(e.organisation_id, 'comptabilite.creer'), 'Droit « comptabilite.creer » requis');
  perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Indiquez le motif de l''extourne');
  perform prive.exiger(not exists (select 1 from public.ecritures where extourne_de = e.id), 'Écriture déjà extournée');
  perform prive.exiger(not exists (select 1 from public.periodes_comptables where organisation_id = e.organisation_id
                                    and mois = date_trunc('month', v_date)::date), 'Le mois courant est clôturé');
  v_id := prive.ajouter_ecriture(e.organisation_id, v_date, e.journal, 'Extourne ' || e.numero || ' · ' || btrim(p_motif),
    (select jsonb_agg(jsonb_build_object('compte', l.compte, 'debit', l.credit, 'credit', l.debit, 'libelle', l.libelle))
       from public.ecritures_lignes l where l.ecriture_id = e.id),
    e.numero, 'extourne', e.id, false, btrim(p_motif), e.id);
  return v_id;
end $$;

create function public.cloturer_mois_comptable(p_org uuid, p_mois date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_mois date := date_trunc('month', p_mois)::date;
  v_n int;
begin
  perform prive.exiger(prive.a_permission(p_org, 'comptabilite.cloturer'), 'Droit « comptabilite.cloturer » requis');
  perform prive.exiger(v_mois < date_trunc('month', current_date)::date, 'Seul un mois terminé peut être clôturé');
  perform prive.exiger(not exists (select 1 from public.periodes_comptables where organisation_id = p_org and mois = v_mois), 'Mois déjà clôturé');
  perform prive.generer_ecritures(p_org, v_mois);
  insert into public.periodes_comptables (organisation_id, mois) values (p_org, v_mois);
  select count(*) into v_n from public.ecritures where organisation_id = p_org and mois = v_mois;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, apres)
  values (p_org, auth.uid(), 'comptabilite.cloturer', 'periodes_comptables', v_mois::text, jsonb_build_object('ecritures', v_n));
  return jsonb_build_object('mois', v_mois, 'ecritures', v_n);
end $$;

create function public.periodes_comptables_etat(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'comptabilite.consulter'), 'Droit « comptabilite.consulter » requis');
  return coalesce((select jsonb_agg(jsonb_build_object('mois', g.m, 'cloturee', pc.mois is not null, 'cloturee_le', pc.cloturee_le,
                                                       'ecritures', (select count(*) from public.ecritures e where e.organisation_id = p_org and e.mois = g.m))
                                    order by g.m desc)
    from (select generate_series(date_trunc('month', current_date - 365)::date, date_trunc('month', current_date)::date, interval '1 month')::date m) g
    left join public.periodes_comptables pc on pc.organisation_id = p_org and pc.mois = g.m), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- RLS, privilèges
-- ---------------------------------------------------------------------

create trigger ecritures_audit after insert or update on public.ecritures
  for each row when (not new.automatique) execute function prive.tg_audit();
create trigger plan_comptable_audit after insert or update on public.plan_comptable
  for each row execute function prive.tg_audit();

alter table public.plan_comptable enable row level security;
alter table public.periodes_comptables enable row level security;
alter table public.ecritures enable row level security;
alter table public.ecritures_lignes enable row level security;
create policy lecture on public.plan_comptable for select to authenticated
  using (prive.a_permission(organisation_id, 'comptabilite.consulter'));
create policy creation on public.plan_comptable for insert to authenticated
  with check (prive.a_permission(organisation_id, 'comptabilite.creer'));
create policy modification on public.plan_comptable for update to authenticated
  using (prive.a_permission(organisation_id, 'comptabilite.creer')) with check (prive.a_permission(organisation_id, 'comptabilite.creer'));
create policy lecture on public.periodes_comptables for select to authenticated
  using (prive.a_permission(organisation_id, 'comptabilite.consulter'));
create policy lecture on public.ecritures for select to authenticated
  using (prive.a_permission(organisation_id, 'comptabilite.consulter'));
create policy lecture on public.ecritures_lignes for select to authenticated
  using (prive.a_permission(organisation_id, 'comptabilite.consulter'));
revoke all on public.plan_comptable, public.periodes_comptables, public.ecritures, public.ecritures_lignes from anon, authenticated;
grant select on public.plan_comptable, public.periodes_comptables, public.ecritures, public.ecritures_lignes to authenticated;
grant insert (organisation_id, numero, libelle) on public.plan_comptable to authenticated;
grant update (libelle) on public.plan_comptable to authenticated;

revoke all on function
  prive.tg_compte_comptable_tresorerie(), prive.creer_plan_comptable(uuid), prive.tg_plan_par_defaut(), prive.tg_ecriture_figee(),
  prive.ajouter_ecriture(uuid, date, text, text, jsonb, text, text, uuid, boolean, text, uuid), prive.compte_de(uuid),
  prive.generer_ecritures(uuid, date), prive.generer_periode(uuid, date, date)
from public, anon, authenticated;
revoke all on function
  public.journal_comptable(uuid, date, date, text), public.balance_comptable(uuid, date, date),
  public.grand_livre(uuid, date, date, text), public.bilan_simplifie(uuid, date),
  public.ecriture_manuelle(uuid, date, text, text, jsonb, text, text), public.extourner_ecriture(uuid, text),
  public.cloturer_mois_comptable(uuid, date), public.periodes_comptables_etat(uuid)
from public, anon;
grant execute on function
  public.journal_comptable(uuid, date, date, text), public.balance_comptable(uuid, date, date),
  public.grand_livre(uuid, date, date, text), public.bilan_simplifie(uuid, date),
  public.ecriture_manuelle(uuid, date, text, text, jsonb, text, text), public.extourner_ecriture(uuid, text),
  public.cloturer_mois_comptable(uuid, date), public.periodes_comptables_etat(uuid)
to authenticated;
