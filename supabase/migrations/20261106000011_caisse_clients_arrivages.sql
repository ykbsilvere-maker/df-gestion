-- =====================================================================
-- v0.10 — Caisse (code personnel, dépenses, sorties et apports du tiroir,
-- historique des clôtures), arrivages annoncés puis comptés, clients et
-- créances (balance âgée, relances, encaissements), devis et proformas,
-- proposition d'approvisionnement, tableau de bord, photos privées.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Code personnel de caisse (PIN de 4 à 6 chiffres)
-- Stocké dans le schéma privé (jamais lisible par l'application) : sel + empreinte SHA-256.
-- 5 essais manqués bloquent le code 5 minutes.
-- ---------------------------------------------------------------------

create table prive.codes_caisse (
  membre_id     uuid primary key references public.membres(id) on delete cascade,
  sel           text not null,
  empreinte     text not null,
  essais        smallint not null default 0,
  bloque_jusqu  timestamptz,
  defini_le     timestamptz not null default now()
);

create function prive.empreinte_code(p_sel text, p_code text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_sel || ':' || p_code, 'UTF8')), 'hex')
$$;

create function public.definir_code_caisse(p_org uuid, p_code text, p_ancien text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  m public.membres := prive.membre_courant(p_org);
  c prive.codes_caisse;
  v_sel text := replace(gen_random_uuid()::text, '-', '');
begin
  perform prive.exiger(m.id is not null, 'Accès refusé');
  perform prive.exiger(p_code ~ '^[0-9]{4,6}$', 'Le code doit faire 4 à 6 chiffres');
  perform prive.exiger(p_code !~ '^(\d)\1+$' and p_code not in ('1234','12345','123456','0123','4321','654321'),
                       'Code trop simple : évitez les suites et les chiffres répétés');
  select * into c from prive.codes_caisse where membre_id = m.id;
  if found then
    perform prive.exiger(p_ancien is not null and prive.empreinte_code(c.sel, p_ancien) = c.empreinte,
                         'Ancien code incorrect');
  end if;
  insert into prive.codes_caisse (membre_id, sel, empreinte)
  values (m.id, v_sel, prive.empreinte_code(v_sel, p_code))
  on conflict (membre_id) do update set sel = excluded.sel, empreinte = excluded.empreinte, essais = 0,
                                        bloque_jusqu = null, defini_le = now();
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
  values (p_org, auth.uid(), 'code_caisse.definir', 'membres', m.id::text);
end $$;

create function public.verifier_code_caisse(p_org uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.membres := prive.membre_courant(p_org);
  c prive.codes_caisse;
begin
  perform prive.exiger(m.id is not null, 'Accès refusé');
  select * into c from prive.codes_caisse where membre_id = m.id for update;
  if not found then return jsonb_build_object('ok', false, 'sans_code', true); end if;
  if c.bloque_jusqu is not null and c.bloque_jusqu > now() then
    return jsonb_build_object('ok', false, 'bloque_jusqu', c.bloque_jusqu);
  end if;
  if prive.empreinte_code(c.sel, coalesce(p_code, '')) = c.empreinte then
    update prive.codes_caisse set essais = 0, bloque_jusqu = null where membre_id = m.id;
    return jsonb_build_object('ok', true);
  end if;
  update prive.codes_caisse
     set essais = case when essais + 1 >= 5 then 0 else essais + 1 end,
         bloque_jusqu = case when essais + 1 >= 5 then now() + interval '5 minutes' end
   where membre_id = m.id
  returning * into c;
  return jsonb_build_object('ok', false, 'essais_restants', case when c.bloque_jusqu is null then 5 - c.essais else 0 end,
                            'bloque_jusqu', c.bloque_jusqu);
end $$;

create function public.etat_code_caisse(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from prive.codes_caisse c where c.membre_id = (prive.membre_courant(p_org)).id)
$$;

create function public.reinitialiser_code_caisse(p_membre uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare cible public.membres := prive.charger_membre_cible(p_membre, 'utilisateurs.modifier');
begin
  delete from prive.codes_caisse where membre_id = cible.id;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
  values (cible.organisation_id, auth.uid(), 'code_caisse.reinitialiser', 'membres', cible.id::text);
end $$;

-- ---------------------------------------------------------------------
-- 2. Tiroir-caisse : dépenses, sorties (versements) et apports pendant la session
-- Ils passent par les dépenses (budget) et les virements (trésorerie), reliés à la session.
-- ---------------------------------------------------------------------

alter table public.depenses add column session_id uuid references public.sessions_caisse(id);
alter table public.virements add column session_id uuid references public.sessions_caisse(id);
create index depenses_session_idx on public.depenses (session_id) where session_id is not null;
create index virements_session_idx on public.virements (session_id) where session_id is not null;

-- Compte de trésorerie du tiroir d'une caisse : le sien s'il existe, sinon celui des espèces.
create function prive.compte_tiroir(p_org uuid, p_caisse uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select id from public.comptes_tresorerie where organisation_id = p_org and caisse_id = p_caisse and actif order by ordre limit 1),
    (select compte_id from public.moyens_paiement where organisation_id = p_org and nature = 'especes' and actif order by ordre limit 1))
$$;

create or replace function prive.calculer_totaux_session(p_session uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with s as (select * from public.sessions_caisse where id = p_session),
       v as (select * from public.ventes where session_id = p_session),
       r as (select rg.* from public.reglements rg join v on v.id = rg.vente_id
              where v.statut = 'validee' and rg.statut = 'enregistre'),
       mv as (
         select 'depense' type, d.montant from public.depenses d where d.session_id = p_session and d.statut = 'enregistree'
         union all
         select case when vi.compte_source_id = prive.compte_tiroir(vi.organisation_id, (select caisse_id from s))
                     then 'sortie' else 'apport' end, vi.montant + case when vi.compte_source_id =
                       prive.compte_tiroir(vi.organisation_id, (select caisse_id from s)) then vi.frais else 0 end
         from public.virements vi where vi.session_id = p_session and vi.statut <> 'annule')
  select jsonb_build_object(
    'nombre_ventes', (select count(*) from v where statut = 'validee'),
    'total_ventes', (select coalesce(sum(total), 0) from v where statut = 'validee'),
    'total_remises', (select coalesce(sum(total_remises), 0) from v where statut = 'validee'),
    'nombre_annulations', (select count(*) from v where statut = 'annulee'),
    'total_annulations', (select coalesce(sum(total), 0) from v where statut = 'annulee'),
    'ventes_hors_ligne', (select count(*) from v where origine = 'hors_ligne'),
    'ventes_apres_cloture', (select count(*) from v where apres_cloture),
    'panier_moyen', (select coalesce(round(avg(total)), 0) from v where statut = 'validee'),
    'fond_initial', (select fond_initial from s),
    'especes_encaissees', (select coalesce(sum(montant), 0) from r where nature = 'especes' and sens = 'encaissement'),
    'depenses_caisse', (select coalesce(sum(montant), 0) from mv where type = 'depense'),
    'sorties_caisse', (select coalesce(sum(montant), 0) from mv where type = 'sortie'),
    'apports_caisse', (select coalesce(sum(montant), 0) from mv where type = 'apport'),
    'especes_attendues', (select fond_initial from s)
                         + (select coalesce(sum(montant), 0) from r where nature = 'especes' and sens = 'encaissement')
                         - (select coalesce(sum(montant), 0) from mv where type in ('depense','sortie'))
                         + (select coalesce(sum(montant), 0) from mv where type = 'apport'),
    'rendus_autres_moyens', (select coalesce(sum(montant), 0) from r where sens = 'rendu'),
    'par_moyen', coalesce((
      select jsonb_agg(jsonb_build_object('libelle', libelle, 'nature', nature, 'montant', net, 'encaisse', encaisse,
                                          'rendu', rendu, 'nombre', nb) order by net desc)
      from (select libelle, nature,
                   coalesce(sum(montant) filter (where sens = 'encaissement'), 0) encaisse,
                   coalesce(sum(montant) filter (where sens = 'rendu'), 0) rendu,
                   coalesce(sum(case when sens = 'rendu' then -montant else montant end), 0) net,
                   count(*) filter (where sens = 'encaissement') nb
            from r group by libelle, nature) x
    ), '[]'::jsonb),
    'calcule_le', now()
  )
$$;

create function public.mouvement_caisse(
  p_session uuid, p_type text, p_montant bigint, p_motif text,
  p_poste uuid default null, p_compte uuid default null, p_reference text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.sessions_caisse;
  v_tiroir uuid;
  v_poste uuid := p_poste;
  v_id uuid;
begin
  select * into s from public.sessions_caisse where id = p_session for update;
  perform prive.exiger(found, 'Session introuvable');
  perform prive.exiger(s.statut = 'ouverte', 'La caisse est clôturée');
  perform prive.exiger(prive.acces_caisse(s.organisation_id, s.caisse_id) and prive.a_permission(s.organisation_id, 'caisse.creer')
                       and (s.ouverte_par = auth.uid() or prive.a_permission(s.organisation_id, 'caisse.cloturer')),
                       'Seule la personne qui tient la caisse ou un responsable peut sortir de l''argent du tiroir');
  perform prive.exiger(p_type in ('depense','sortie','apport'), 'Type de mouvement inconnu');
  perform prive.exiger(coalesce(p_montant, 0) > 0, 'Montant invalide');
  perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Indiquez le motif');
  v_tiroir := prive.compte_tiroir(s.organisation_id, s.caisse_id);
  perform prive.exiger(v_tiroir is not null, 'Aucun compte de trésorerie pour les espèces');
  if p_type = 'depense' then
    if v_poste is null then
      select id into v_poste from public.postes_budget
       where organisation_id = s.organisation_id and actif and prive.normaliser(libelle) = prive.normaliser('Imprévus');
    end if;
    perform prive.exiger(exists (select 1 from public.postes_budget where id = v_poste and organisation_id = s.organisation_id),
                         'Poste de dépense inconnu');
    insert into public.depenses (organisation_id, date_depense, poste_id, compte_id, montant, libelle, reference, session_id)
    values (s.organisation_id, current_date, v_poste, v_tiroir, p_montant, btrim(p_motif), nullif(btrim(p_reference), ''), s.id)
    returning id into v_id;
  else
    perform prive.exiger(p_compte is not null and p_compte <> v_tiroir
                         and exists (select 1 from public.comptes_tresorerie where id = p_compte and organisation_id = s.organisation_id and actif),
                         case when p_type = 'sortie' then 'Choisissez où va l''argent (caisse centrale, banque…)'
                              else 'Choisissez d''où vient l''argent' end);
    insert into public.virements (organisation_id, date_virement, compte_source_id, compte_destination_id, montant,
                                  reference, note, statut, valide_par, valide_le, session_id)
    values (s.organisation_id, current_date,
            case when p_type = 'sortie' then v_tiroir else p_compte end,
            case when p_type = 'sortie' then p_compte else v_tiroir end,
            p_montant, nullif(btrim(p_reference), ''), btrim(p_motif), 'valide', auth.uid(), now(), s.id)
    returning id into v_id;
  end if;
  return v_id;
end $$;

-- Listes utiles au tiroir (sans soldes) : comptes de destination et postes de dépense.
create function public.options_caisse(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'caisse.creer'), 'Accès refusé');
  return jsonb_build_object(
    'comptes', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'nom', nom, 'type', type) order by ordre, nom)
                          from public.comptes_tresorerie where organisation_id = p_org and actif), '[]'::jsonb),
    'postes', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'libelle', libelle) order by ordre, libelle)
                         from public.postes_budget where organisation_id = p_org and actif), '[]'::jsonb));
end $$;

-- Journal de la session : ventes, remboursements (annulations) et mouvements du tiroir.
create function public.journal_session(p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.sessions_caisse;
begin
  select * into s from public.sessions_caisse where id = p_session;
  perform prive.exiger(found and (prive.peut_voir_ventes(s.organisation_id, s.magasin_id)
                                  or prive.acces_caisse(s.organisation_id, s.caisse_id)), 'Session introuvable');
  return jsonb_build_object(
    'session', jsonb_build_object('id', s.id, 'statut', s.statut, 'ouverte_le', s.ouverte_le, 'cloturee_le', s.cloturee_le,
                                  'numero_z', s.numero_z, 'fond_initial', s.fond_initial),
    'totaux', case when s.statut = 'cloturee' then s.totaux else prive.calculer_totaux_session(s.id) end,
    'ventes', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', v.id, 'numero', v.numero, 'date_vente', v.date_vente, 'total', v.total, 'statut', v.statut,
                 'client', v.client_nom, 'motif_annulation', v.motif_annulation, 'annulee_le', v.annulee_le,
                 'paiement', (select string_agg(distinct r.libelle, ' + ') from public.reglements r
                               where r.vente_id = v.id and r.statut = 'enregistre' and r.sens = 'encaissement'))
                 order by v.date_vente desc)
               from public.ventes v where v.session_id = s.id), '[]'::jsonb),
    'mouvements', coalesce((select jsonb_agg(x order by x ->> 'cree_le' desc) from (
                   select jsonb_build_object('type', 'depense', 'montant', d.montant, 'motif', d.libelle, 'poste', p.libelle,
                                             'statut', d.statut, 'cree_le', d.created_at) x
                   from public.depenses d left join public.postes_budget p on p.id = d.poste_id where d.session_id = s.id
                   union all
                   select jsonb_build_object('type', case when vi.compte_source_id = prive.compte_tiroir(vi.organisation_id, s.caisse_id)
                                                          then 'sortie' else 'apport' end,
                                             'montant', vi.montant, 'motif', vi.note,
                                             'compte', case when vi.compte_source_id = prive.compte_tiroir(vi.organisation_id, s.caisse_id)
                                                            then cd.nom else cs.nom end,
                                             'statut', vi.statut, 'cree_le', vi.created_at)
                   from public.virements vi
                   join public.comptes_tresorerie cs on cs.id = vi.compte_source_id
                   join public.comptes_tresorerie cd on cd.id = vi.compte_destination_id
                   where vi.session_id = s.id) t), '[]'::jsonb));
end $$;

-- Historique des clôtures : la caissière voit les siennes, un responsable celles du magasin.
create function public.historique_clotures(p_org uuid, p_caisse uuid default null, p_limite int default 60) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_tout boolean := prive.a_permission(p_org, 'caisse.cloturer') or prive.a_permission(p_org, 'rapports.consulter');
begin
  perform prive.exiger(prive.a_permission(p_org, 'caisse.consulter') or prive.a_permission(p_org, 'caisse.creer'), 'Accès refusé');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'caisse', c.nom, 'numero_z', s.numero_z, 'ouverte_le', s.ouverte_le, 'cloturee_le', s.cloturee_le,
             'caissier', pr.nom_complet, 'total_ventes', s.totaux ->> 'total_ventes', 'nombre_ventes', s.totaux ->> 'nombre_ventes',
             'especes_attendues', s.especes_attendues, 'especes_comptees', s.especes_comptees, 'ecart', s.ecart,
             'motif_ecart', s.motif_ecart) order by s.cloturee_le desc)
    from (select * from public.sessions_caisse s
           where s.organisation_id = p_org and s.statut = 'cloturee'
             and (p_caisse is null or s.caisse_id = p_caisse)
             and prive.acces_magasin(p_org, s.magasin_id)
             and (v_tout or s.ouverte_par = auth.uid())
           order by s.cloturee_le desc limit greatest(1, least(p_limite, 500))) s
    join public.caisses c on c.id = s.caisse_id
    left join public.profils pr on pr.id = s.ouverte_par), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 3. Arrivages : le gérant annonce, le chargé du stock compte, l'application montre les écarts
-- ---------------------------------------------------------------------

alter table public.receptions
  add column annoncee boolean not null default false,
  add column annonce_par uuid,
  add column annonce_le timestamptz,
  add column ecarts_controle jsonb;
alter table public.receptions_lignes
  add column quantite_attendue numeric(14,3),
  add column prix_attendu bigint,
  add column quantite_comptee numeric(14,3) check (quantite_comptee is null or quantite_comptee >= 0);

create function public.annoncer_reception(p_reception uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.receptions;
begin
  select * into r from public.receptions where id = p_reception for update;
  perform prive.exiger(found, 'Réception introuvable');
  perform prive.exiger(prive.peut_reception(r.organisation_id, r.magasin_id, 'creer'), 'Droit insuffisant');
  perform prive.exiger(r.statut = 'brouillon', 'Seul un brouillon peut être annoncé');
  perform prive.exiger(exists (select 1 from public.receptions_lignes where reception_id = r.id), 'Ajoutez les produits attendus');
  update public.receptions_lignes set quantite_attendue = quantite, prix_attendu = prix_unitaire, quantite_comptee = null
   where reception_id = r.id;
  update public.receptions set annoncee = true, annonce_par = auth.uid(), annonce_le = now() where id = r.id;
end $$;

-- Validation : pour un arrivage annoncé, la quantité retenue est la quantité comptée (écarts gardés).
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

  if r.annoncee then
    perform prive.exiger(not exists (select 1 from public.receptions_lignes where reception_id = r.id and quantite_comptee is null),
                         'Comptage incomplet : indiquez la quantité comptée de chaque ligne (0 si l''article manque)');
    update public.receptions set ecarts_controle = (
      select coalesce(jsonb_agg(jsonb_build_object(
               'produit_id', rl.produit_id, 'designation', p.designation,
               'attendu', rl.quantite_attendue, 'compte', rl.quantite_comptee,
               'ecart', rl.quantite_comptee - coalesce(rl.quantite_attendue, 0),
               'prix_attendu', rl.prix_attendu, 'prix', rl.prix_unitaire) order by p.designation), '[]'::jsonb)
      from public.receptions_lignes rl join public.produits p on p.id = rl.produit_id
      where rl.reception_id = r.id
        and (rl.quantite_comptee is distinct from rl.quantite_attendue or rl.prix_attendu is distinct from rl.prix_unitaire))
    where id = r.id;
    delete from public.receptions_lignes where reception_id = r.id and quantite_comptee = 0;
    update public.receptions_lignes set quantite = quantite_comptee
     where reception_id = r.id and quantite is distinct from quantite_comptee;
  end if;

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
  if r.reglement = 'comptant' and total_valeur > 0 then
    insert into public.paiements_fournisseurs (organisation_id, fournisseur_id, reception_id, date_paiement,
                                               montant, compte_id, reference, note)
    values (r.organisation_id, r.fournisseur_id, r.id, r.date_reception, round(total_valeur)::bigint,
            r.compte_paiement_id, r.reference, 'Paiement comptant de la réception ' || r.numero);
  end if;
  return r.numero;
end $$;

-- ---------------------------------------------------------------------
-- 4. Clients et créances
-- ---------------------------------------------------------------------

create table public.clients (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  nom             text not null check (length(btrim(nom)) between 2 and 120),
  telephone       text check (telephone is null or length(telephone) <= 40),
  email           text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  adresse         text check (adresse is null or length(adresse) <= 200),
  contact         text check (contact is null or length(contact) <= 120),
  ncc             text check (ncc is null or length(ncc) <= 20),
  plafond_credit  bigint check (plafond_credit is null or plafond_credit >= 0),
  delai_paiement  smallint not null default 30 check (delai_paiement between 0 and 365),
  note            text check (note is null or length(note) <= 500),
  actif           boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, id)
);
create unique index clients_nom_unique on public.clients (organisation_id, prive.normaliser(nom));

create table public.creances (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations(id),
  client_id        uuid not null,
  date_creance     date not null default current_date,
  echeance         date not null,
  montant          bigint not null check (montant > 0),
  libelle          text check (libelle is null or length(libelle) <= 160),
  piece            text check (piece is null or length(piece) <= 60),
  vente_id         uuid,
  statut           text not null default 'ouverte' check (statut in ('ouverte','annulee')),
  motif_annulation text check (motif_annulation is null or length(motif_annulation) <= 300),
  cree_par         uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  check (echeance >= date_creance),
  foreign key (organisation_id, client_id) references public.clients(organisation_id, id)
);
create index creances_client_idx on public.creances (organisation_id, client_id, date_creance);

create table public.encaissements_creances (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations(id),
  client_id         uuid not null,
  creance_id        uuid references public.creances(id),
  date_encaissement date not null default current_date,
  montant           bigint not null check (montant > 0),
  compte_id         uuid not null,
  reference         text check (reference is null or length(reference) <= 60),
  note              text check (note is null or length(note) <= 300),
  statut            text not null default 'enregistre' check (statut in ('enregistre','annule')),
  motif_annulation  text check (motif_annulation is null or length(motif_annulation) <= 300),
  cree_par          uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  foreign key (organisation_id, client_id) references public.clients(organisation_id, id),
  foreign key (organisation_id, compte_id) references public.comptes_tresorerie(organisation_id, id)
);
create index encaissements_client_idx on public.encaissements_creances (organisation_id, client_id);

create table public.relances (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  client_id       uuid not null,
  niveau          smallint not null check (niveau between 1 and 3),
  date_relance    date not null default current_date,
  montant_du      bigint not null,
  montant_echu    bigint not null,
  cree_par        uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, client_id) references public.clients(organisation_id, id)
);

-- Reste dû par créance : paiements rattachés d'abord, puis paiements libres imputés aux plus anciennes (FIFO).
create function prive.restes_creances(p_org uuid, p_au date default current_date)
returns table (creance_id uuid, client_id uuid, date_creance date, echeance date, montant bigint, libelle text,
               piece text, reste bigint, jours_retard int)
language sql stable security definer set search_path = '' as $$
  with c as (
    select cr.*, cr.montant - coalesce((select sum(e.montant) from public.encaissements_creances e
                                         where e.creance_id = cr.id and e.statut = 'enregistre'
                                           and e.date_encaissement <= p_au), 0) reste_lie
    from public.creances cr
    where cr.organisation_id = p_org and cr.statut = 'ouverte' and cr.date_creance <= p_au
  ),
  libres as (
    select e.client_id, sum(e.montant) total from public.encaissements_creances e
    where e.organisation_id = p_org and e.creance_id is null and e.statut = 'enregistre' and e.date_encaissement <= p_au
    group by e.client_id
  ),
  cumul as (
    select c.*, greatest(c.reste_lie, 0) r0,
           sum(greatest(c.reste_lie, 0)) over (partition by c.client_id order by c.date_creance, c.created_at) cum
    from c
  )
  select cu.id, cu.client_id, cu.date_creance, cu.echeance, cu.montant, cu.libelle, cu.piece,
         (cu.r0 - least(cu.r0, greatest(coalesce(l.total, 0) - (cu.cum - cu.r0), 0)))::bigint,
         greatest(p_au - cu.echeance, 0)
  from cumul cu left join libres l on l.client_id = cu.client_id
$$;

create function public.balance_agee(p_org uuid, p_au date default current_date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'tresorerie.consulter'), 'Droit « tresorerie.consulter » requis');
  return jsonb_build_object('au', p_au, 'clients', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.total desc) from (
      select cl.id, cl.nom, cl.telephone, cl.plafond_credit,
             coalesce(sum(r.reste), 0)::bigint total,
             coalesce(sum(r.reste) filter (where r.jours_retard = 0), 0)::bigint non_echu,
             coalesce(sum(r.reste) filter (where r.jours_retard between 1 and 30), 0)::bigint j30,
             coalesce(sum(r.reste) filter (where r.jours_retard between 31 and 60), 0)::bigint j60,
             coalesce(sum(r.reste) filter (where r.jours_retard between 61 and 90), 0)::bigint j90,
             coalesce(sum(r.reste) filter (where r.jours_retard > 90), 0)::bigint plus90,
             max(r.jours_retard) filter (where r.reste > 0) retard_max,
             (select max(re.date_relance) from public.relances re where re.client_id = cl.id) derniere_relance,
             (select max(re.niveau) from public.relances re where re.client_id = cl.id
                and re.date_relance > current_date - 60) niveau_relance
      from public.clients cl
      join prive.restes_creances(p_org, p_au) r on r.client_id = cl.id and r.reste > 0
      where cl.organisation_id = p_org
      group by cl.id
    ) x), '[]'::jsonb));
end $$;

create function public.releve_client(p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare cl public.clients;
begin
  select * into cl from public.clients where id = p_client;
  perform prive.exiger(found, 'Client introuvable');
  perform prive.exiger(prive.a_permission(cl.organisation_id, 'tresorerie.consulter'), 'Droit « tresorerie.consulter » requis');
  return jsonb_build_object(
    'client', to_jsonb(cl),
    'creances', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', cr.id, 'date_creance', cr.date_creance, 'echeance', cr.echeance, 'montant', cr.montant,
                  'libelle', cr.libelle, 'piece', cr.piece, 'statut', cr.statut, 'motif_annulation', cr.motif_annulation,
                  'reste', coalesce(r.reste, 0), 'jours_retard', coalesce(r.jours_retard, 0)) order by cr.date_creance desc)
                from public.creances cr left join prive.restes_creances(cl.organisation_id) r on r.creance_id = cr.id
                where cr.client_id = cl.id), '[]'::jsonb),
    'encaissements', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', e.id, 'date_encaissement', e.date_encaissement, 'montant', e.montant, 'compte', c.nom,
                  'reference', e.reference, 'statut', e.statut, 'piece', cr.piece) order by e.date_encaissement desc)
                from public.encaissements_creances e
                join public.comptes_tresorerie c on c.id = e.compte_id
                left join public.creances cr on cr.id = e.creance_id
                where e.client_id = cl.id), '[]'::jsonb),
    'relances', coalesce((select jsonb_agg(jsonb_build_object('niveau', re.niveau, 'date_relance', re.date_relance,
                  'montant_du', re.montant_du) order by re.date_relance desc)
                from public.relances re where re.client_id = cl.id), '[]'::jsonb),
    'solde', coalesce((select sum(reste) from prive.restes_creances(cl.organisation_id) where client_id = cl.id), 0),
    'echu', coalesce((select sum(reste) from prive.restes_creances(cl.organisation_id) where client_id = cl.id and jours_retard > 0), 0));
end $$;

create function public.enregistrer_creance(
  p_org uuid, p_client uuid, p_montant bigint, p_date date default current_date, p_echeance date default null,
  p_libelle text default null, p_piece text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  cl public.clients;
  v_id uuid;
begin
  perform prive.exiger(prive.a_permission(p_org, 'tresorerie.creer'), 'Droit « tresorerie.creer » requis');
  select * into cl from public.clients where id = p_client and organisation_id = p_org;
  perform prive.exiger(found, 'Client introuvable');
  perform prive.exiger(coalesce(p_montant, 0) > 0, 'Montant invalide');
  insert into public.creances (organisation_id, client_id, date_creance, echeance, montant, libelle, piece)
  values (p_org, p_client, coalesce(p_date, current_date),
          coalesce(p_echeance, coalesce(p_date, current_date) + cl.delai_paiement),
          p_montant, nullif(btrim(p_libelle), ''), nullif(btrim(p_piece), ''))
  returning id into v_id;
  return v_id;
end $$;

create function public.encaisser_creance(
  p_org uuid, p_client uuid, p_creance uuid, p_montant bigint, p_compte uuid,
  p_date date default current_date, p_reference text default null, p_note text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_reste bigint;
  v_solde bigint;
begin
  perform prive.exiger(prive.a_permission(p_org, 'tresorerie.creer'), 'Droit « tresorerie.creer » requis');
  perform prive.exiger(coalesce(p_montant, 0) > 0, 'Montant invalide');
  perform prive.exiger(exists (select 1 from public.comptes_tresorerie where id = p_compte and organisation_id = p_org and actif),
                       'Choisissez le compte qui reçoit l''argent');
  select coalesce(sum(reste), 0) into v_solde from prive.restes_creances(p_org) where client_id = p_client;
  perform prive.exiger(p_montant <= v_solde, format('Le client ne doit que %s', v_solde));
  if p_creance is not null then
    select reste into v_reste from prive.restes_creances(p_org) where creance_id = p_creance and client_id = p_client;
    perform prive.exiger(v_reste is not null, 'Créance introuvable pour ce client');
    perform prive.exiger(p_montant <= v_reste, format('Le reste dû sur cette créance est de %s', v_reste));
  end if;
  insert into public.encaissements_creances (organisation_id, client_id, creance_id, date_encaissement, montant, compte_id,
                                             reference, note)
  values (p_org, p_client, p_creance, coalesce(p_date, current_date), p_montant, p_compte,
          nullif(btrim(p_reference), ''), nullif(btrim(p_note), ''))
  returning id into v_id;
  return v_id;
end $$;

create function public.annuler_creance(p_creance uuid, p_motif text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.creances;
begin
  select * into c from public.creances where id = p_creance for update;
  perform prive.exiger(found, 'Créance introuvable');
  perform prive.exiger(prive.a_permission(c.organisation_id, 'tresorerie.valider'), 'Droit « tresorerie.valider » requis');
  perform prive.exiger(c.statut = 'ouverte', 'Créance déjà annulée');
  perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Un motif est obligatoire');
  perform prive.exiger(not exists (select 1 from public.encaissements_creances where creance_id = c.id and statut = 'enregistre'),
                       'Annulez d''abord les encaissements de cette créance');
  perform set_config('app.motif', btrim(p_motif), true);
  update public.creances set statut = 'annulee', motif_annulation = btrim(p_motif) where id = c.id;
  perform set_config('app.motif', '', true);
end $$;

create function public.annuler_encaissement(p_encaissement uuid, p_motif text) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.encaissements_creances;
begin
  select * into e from public.encaissements_creances where id = p_encaissement for update;
  perform prive.exiger(found, 'Encaissement introuvable');
  perform prive.exiger(prive.a_permission(e.organisation_id, 'tresorerie.valider'), 'Droit « tresorerie.valider » requis');
  perform prive.exiger(e.statut = 'enregistre', 'Encaissement déjà annulé');
  perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Un motif est obligatoire');
  perform set_config('app.motif', btrim(p_motif), true);
  update public.encaissements_creances set statut = 'annule', motif_annulation = btrim(p_motif) where id = e.id;
  perform set_config('app.motif', '', true);
end $$;

create function public.enregistrer_relance(p_client uuid, p_niveau smallint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cl public.clients;
  v_du bigint;
  v_echu bigint;
begin
  select * into cl from public.clients where id = p_client;
  perform prive.exiger(found, 'Client introuvable');
  perform prive.exiger(prive.a_permission(cl.organisation_id, 'tresorerie.creer'), 'Droit « tresorerie.creer » requis');
  perform prive.exiger(p_niveau between 1 and 3, 'Niveau de relance : 1, 2 ou 3');
  select coalesce(sum(reste), 0), coalesce(sum(reste) filter (where jours_retard > 0), 0) into v_du, v_echu
    from prive.restes_creances(cl.organisation_id) where client_id = cl.id;
  perform prive.exiger(v_echu > 0, 'Ce client n''a aucune somme échue');
  insert into public.relances (organisation_id, client_id, niveau, montant_du, montant_echu)
  values (cl.organisation_id, cl.id, p_niveau, v_du, v_echu);
  return jsonb_build_object('montant_du', v_du, 'montant_echu', v_echu);
end $$;

-- Les encaissements de créances entrent dans la trésorerie.
do $$
declare d text;
begin
  select pg_get_functiondef('prive.flux_tresorerie(uuid)'::regprocedure) into d;
  if position('ra.date_rapprochement, ''ajustement'',' in d) = 0 then
    raise exception 'flux_tresorerie : point d''insertion introuvable';
  end if;
  d := replace(d, '  union all
  select ra.compte_id, ra.date_rapprochement, ''ajustement'',', '  union all
  select e.compte_id, e.date_encaissement, ''encaissement_client'', ''Règlement '' || cl.nom || coalesce('' · '' || e.reference, ''''),
         e.montant, ''encaissement'', e.id
  from public.encaissements_creances e join public.clients cl on cl.id = e.client_id
  where e.organisation_id = p_org and e.statut = ''enregistre''
  union all
  select ra.compte_id, ra.date_rapprochement, ''ajustement'',');
  execute d;
end $$;

-- ---------------------------------------------------------------------
-- 5. Devis et factures proforma
-- ---------------------------------------------------------------------

create table public.devis (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  magasin_id      uuid not null,
  type            text not null default 'devis' check (type in ('devis','proforma')),
  numero          text,
  client_id       uuid,
  client_nom      text check (client_nom is null or length(client_nom) <= 120),
  client_contact  text check (client_contact is null or length(client_contact) <= 200),
  date_devis      date not null default current_date,
  validite        date not null default (current_date + 30),
  statut          text not null default 'brouillon' check (statut in ('brouillon','envoye','accepte','refuse','converti')),
  conditions      text check (conditions is null or length(conditions) <= 600),
  note            text check (note is null or length(note) <= 500),
  total           bigint not null default 0,
  total_remises   bigint not null default 0,
  vente_id        uuid,
  cree_par        uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, numero),
  foreign key (organisation_id, magasin_id) references public.magasins(organisation_id, id),
  foreign key (organisation_id, client_id) references public.clients(organisation_id, id)
);

create table public.devis_lignes (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  devis_id        uuid not null,
  produit_id      uuid,
  designation     text not null check (length(btrim(designation)) between 1 and 160),
  quantite        numeric(14,3) not null check (quantite > 0),
  prix_unitaire   bigint not null check (prix_unitaire >= 0),
  remise          bigint not null default 0 check (remise >= 0),
  ordre           smallint not null default 0,
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, devis_id) references public.devis(organisation_id, id) on delete cascade,
  foreign key (organisation_id, produit_id) references public.produits(organisation_id, id)
);
create index devis_lignes_idx on public.devis_lignes (devis_id);

create function prive.tg_numero_devis() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.numero is null then
    new.numero := case when new.type = 'proforma' then 'PF-' else 'D-' end
                  || lpad(prive.prochain_numero(new.organisation_id, 'devis_' || new.type)::text, 6, '0');
  end if;
  return new;
end $$;
create trigger devis_numero before insert on public.devis for each row execute function prive.tg_numero_devis();

-- Les totaux sont toujours recalculés : jamais saisis.
create function prive.tg_totaux_devis() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_devis uuid := coalesce(new.devis_id, old.devis_id);
begin
  update public.devis d
     set total = coalesce((select sum(round(l.quantite * l.prix_unitaire) - l.remise) from public.devis_lignes l where l.devis_id = d.id), 0),
         total_remises = coalesce((select sum(l.remise) from public.devis_lignes l where l.devis_id = d.id), 0)
   where d.id = v_devis;
  return null;
end $$;
create trigger devis_lignes_totaux after insert or update or delete on public.devis_lignes
  for each row execute function prive.tg_totaux_devis();

create function prive.devis_modifiable(p_devis uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.devis d where d.id = p_devis and d.statut in ('brouillon','envoye')
                   and prive.a_permission(d.organisation_id, 'ventes.valider') and prive.acces_magasin(d.organisation_id, d.magasin_id))
$$;

create function public.changer_statut_devis(p_devis uuid, p_statut text, p_vente uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.devis;
begin
  select * into d from public.devis where id = p_devis for update;
  perform prive.exiger(found, 'Devis introuvable');
  perform prive.exiger(prive.a_permission(d.organisation_id, 'ventes.valider'), 'Droit « ventes.valider » requis');
  perform prive.exiger(p_statut in ('brouillon','envoye','accepte','refuse','converti'), 'Statut inconnu');
  perform prive.exiger(d.statut <> 'converti', 'Ce devis est déjà transformé en vente');
  update public.devis set statut = p_statut, vente_id = coalesce(p_vente, vente_id) where id = d.id;
end $$;

-- ---------------------------------------------------------------------
-- 6. Proposition d'approvisionnement
-- Rythme de vente des N derniers jours, classement ABC (80 % / 95 % du chiffre d'affaires),
-- quantité pour tenir la couverture voulue, dernier prix et fournisseur ; trésorerie en regard.
-- ---------------------------------------------------------------------

create function public.proposition_approvisionnement(
  p_org uuid, p_magasin uuid default null, p_jours_analyse int default 30, p_jours_couverture int default 30
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_debut timestamptz := now() - make_interval(days => greatest(7, least(p_jours_analyse, 365)));
  v_lignes jsonb;
begin
  perform prive.exiger(prive.a_permission(p_org, 'achats.creer') or prive.a_permission(p_org, 'stock.creer')
                       or prive.a_permission(p_org, 'fournisseurs.consulter'), 'Accès refusé');
  with ventes as (
    select l.produit_id, sum(l.quantite) qte, sum(l.montant) ca,
           sum(l.montant - l.quantite * coalesce(l.cout_unitaire, 0)) marge
    from public.ventes_lignes l join public.ventes v on v.id = l.vente_id
    where v.organisation_id = p_org and v.statut = 'validee' and v.date_vente >= v_debut
      and (p_magasin is null or v.magasin_id = p_magasin) and prive.acces_magasin(p_org, v.magasin_id)
    group by l.produit_id
  ),
  abc as (
    select produit_id, qte, ca, marge,
           sum(ca) over (order by ca desc, produit_id) / nullif(sum(ca) over (), 0) part_cumulee
    from ventes
  ),
  base as (
    select p.id, p.code, p.designation, p.unite, p.seuil_min, p.seuil_max, p.prix_vente,
           coalesce(st.quantite, 0) stock,
           coalesce(a.qte, 0) vendu, coalesce(a.ca, 0) ca, coalesce(a.marge, 0) marge,
           coalesce(a.qte, 0) / greatest(7, least(p_jours_analyse, 365))::numeric rythme,
           case when a.part_cumulee is null then 'C' when a.part_cumulee <= 0.8 then 'A' when a.part_cumulee <= 0.95 then 'B' else 'C' end classe,
           d.prix_unitaire dernier_prix, coalesce(round(d.cout_unitaire), p.prix_achat) cout, d.fournisseur_id, f.nom fournisseur
    from public.produits p
    left join lateral (select sum(s.quantite) quantite from public.stocks s
                        where s.produit_id = p.id and (p_magasin is null or s.magasin_id = p_magasin)
                          and prive.acces_magasin(p_org, s.magasin_id)) st on true
    left join abc a on a.produit_id = p.id
    left join lateral (select rl.prix_unitaire, rl.cout_unitaire, r.fournisseur_id
                         from public.receptions_lignes rl join public.receptions r on r.id = rl.reception_id and r.statut = 'validee'
                        where rl.produit_id = p.id order by r.valide_le desc nulls last limit 1) d on true
    left join public.fournisseurs f on f.id = d.fournisseur_id
    where p.organisation_id = p_org and p.statut = 'actif'
  )
  select coalesce(jsonb_agg(to_jsonb(x) order by x.priorite, x.ca desc), '[]'::jsonb) into v_lignes from (
    select b.*,
           case when b.rythme > 0 then round(b.stock / b.rythme) end couverture_jours,
           greatest(0, ceil(greatest(b.rythme * p_jours_couverture, coalesce(b.seuil_min, 0))
                             - b.stock))::numeric quantite_proposee,
           case when b.stock <= 0 and b.vendu > 0 then 1
                when b.classe = 'A' then 2
                when b.seuil_min is not null and b.stock < b.seuil_min then 2
                when b.classe = 'B' then 3 else 4 end priorite
    from base b
    where b.vendu > 0 or (b.seuil_min is not null and b.stock < b.seuil_min)
  ) x where x.quantite_proposee > 0;

  return jsonb_build_object(
    'jours_analyse', p_jours_analyse, 'jours_couverture', p_jours_couverture,
    'lignes', v_lignes,
    'tresorerie', case when prive.a_permission(p_org, 'tresorerie.consulter') then public.tresorerie(p_org) end);
end $$;

-- ---------------------------------------------------------------------
-- 7. Tableau de bord : chiffre d'affaires sur la période choisie, comparaison, séries, répartitions
-- ---------------------------------------------------------------------

create function public.tableau_de_bord(p_org uuid, p_periode text default 'mois', p_magasin uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_maintenant timestamp := now() at time zone 'Africa/Abidjan';
  v_debut timestamp;
  v_fin timestamp;
  v_prec_debut timestamp;
  v_pas text;
  v_unite interval;
  v_marges boolean := prive.a_permission(p_org, 'rapports.valider');
  r jsonb;
begin
  perform prive.exiger(prive.a_permission(p_org, 'rapports.consulter') or prive.a_permission(p_org, 'ventes.exporter'),
                       'Droit « rapports.consulter » requis');
  perform prive.exiger(p_periode in ('jour','semaine','mois','annee'), 'Période inconnue');
  v_debut := date_trunc(case p_periode when 'jour' then 'day' when 'semaine' then 'week' when 'mois' then 'month' else 'year' end, v_maintenant);
  v_unite := case p_periode when 'jour' then interval '1 day' when 'semaine' then interval '1 week'
                            when 'mois' then interval '1 month' else interval '1 year' end;
  v_fin := v_debut + v_unite;
  v_prec_debut := v_debut - v_unite;
  v_pas := case p_periode when 'jour' then 'hour' when 'annee' then 'month' else 'day' end;

  with v as (
    select v.*, (v.date_vente at time zone 'Africa/Abidjan') heure_locale from public.ventes v
    where v.organisation_id = p_org and v.statut = 'validee'
      and v.date_vente >= (v_prec_debut at time zone 'Africa/Abidjan') and v.date_vente < (v_fin at time zone 'Africa/Abidjan')
      and (p_magasin is null or v.magasin_id = p_magasin) and prive.acces_magasin(p_org, v.magasin_id)
  ),
  cour as (select * from v where heure_locale >= v_debut),
  prec as (select * from v where heure_locale < v_debut
             -- comparaison à date égale : même durée écoulée dans la période précédente
             and heure_locale < v_prec_debut + (v_maintenant - v_debut))
  select jsonb_build_object(
    'periode', p_periode, 'debut', v_debut, 'fin', v_fin,
    'ca', (select coalesce(sum(total), 0) from cour),
    'ca_precedent', (select coalesce(sum(total), 0) from prec),
    'tickets', (select count(*) from cour),
    'tickets_precedent', (select count(*) from prec),
    'panier_moyen', (select coalesce(round(avg(total)), 0) from cour),
    'marge', case when v_marges then (select coalesce(round(sum(l.montant - l.quantite * coalesce(l.cout_unitaire, 0))), 0)
                                         from public.ventes_lignes l join cour on cour.id = l.vente_id) end,
    'serie', coalesce((
      select jsonb_agg(jsonb_build_object('debut', g.t, 'ca', coalesce(s.ca, 0), 'tickets', coalesce(s.n, 0)) order by g.t)
      from generate_series(v_debut, v_fin - case v_pas when 'hour' then interval '1 hour' when 'month' then interval '1 month' else interval '1 day' end,
                           case v_pas when 'hour' then interval '1 hour' when 'month' then interval '1 month' else interval '1 day' end) g(t)
      left join (select date_trunc(v_pas, heure_locale) t, sum(total) ca, count(*) n from cour group by 1) s on s.t = g.t), '[]'::jsonb),
    'paiements', coalesce((
      select jsonb_agg(jsonb_build_object('libelle', libelle, 'montant', net) order by net desc)
      from (select rg.libelle, sum(case when rg.sens = 'rendu' then -rg.montant else rg.montant end) net
              from public.reglements rg join cour on cour.id = rg.vente_id
             where rg.statut = 'enregistre' group by rg.libelle) x where net > 0), '[]'::jsonb),
    'top_produits', coalesce((
      select jsonb_agg(jsonb_build_object('designation', designation, 'quantite', qte, 'ca', ca) order by ca desc)
      from (select max(l.designation) designation, sum(l.quantite) qte, sum(l.montant) ca
              from public.ventes_lignes l join cour on cour.id = l.vente_id
             group by l.produit_id order by sum(l.montant) desc limit 6) x), '[]'::jsonb),
    'dernieres_ventes', coalesce((
      select jsonb_agg(jsonb_build_object('numero', numero, 'date_vente', date_vente, 'total', total, 'client', client_nom,
                                          'caissier', (select nom_complet from public.profils where id = caissier_id)) order by date_vente desc)
      from (select * from cour order by date_vente desc limit 6) x), '[]'::jsonb),
    'alertes_stock', (select count(*) from public.alertes_stock(p_org, p_magasin) a where a.niveau in ('critique','alerte')),
    'clients_creances', case when prive.a_permission(p_org, 'tresorerie.consulter')
                             then (select count(distinct client_id) from prive.restes_creances(p_org) where reste > 0) end,
    'creances_echues', case when prive.a_permission(p_org, 'tresorerie.consulter')
                            then (select coalesce(sum(reste), 0) from prive.restes_creances(p_org) where reste > 0 and jours_retard > 0) end,
    'calcule_le', now()
  ) into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- 8. Photos des produits : visibles seulement dans l'application (espace privé)
-- ---------------------------------------------------------------------

update storage.buckets set public = false, file_size_limit = 1048576 where id = 'produits';

-- ---------------------------------------------------------------------
-- 9. Journal, RLS, privilèges
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['clients','devis'] loop
    execute format('create trigger %I before update on public.%I
                    for each row execute function prive.tg_maj_updated_at()', t || '_updated_at', t);
  end loop;
  foreach t in array array['clients','creances','encaissements_creances','relances','devis'] loop
    execute format('create trigger %I after insert or update or delete on public.%I
                    for each row execute function prive.tg_audit()', t || '_audit', t);
  end loop;
end $$;

alter table public.clients enable row level security;
alter table public.creances enable row level security;
alter table public.encaissements_creances enable row level security;
alter table public.relances enable row level security;
alter table public.devis enable row level security;
alter table public.devis_lignes enable row level security;

create policy lecture on public.clients for select to authenticated
  using (prive.a_permission(organisation_id, 'clients.consulter') or prive.a_permission(organisation_id, 'tresorerie.consulter')
         or prive.a_permission(organisation_id, 'ventes.valider'));
create policy creation on public.clients for insert to authenticated
  with check (prive.a_permission(organisation_id, 'clients.creer') or prive.a_permission(organisation_id, 'tresorerie.creer'));
create policy modification on public.clients for update to authenticated
  using (prive.a_permission(organisation_id, 'clients.modifier') or prive.a_permission(organisation_id, 'tresorerie.creer'))
  with check (prive.a_permission(organisation_id, 'clients.modifier') or prive.a_permission(organisation_id, 'tresorerie.creer'));
create policy lecture on public.creances for select to authenticated
  using (prive.a_permission(organisation_id, 'tresorerie.consulter'));
create policy lecture on public.encaissements_creances for select to authenticated
  using (prive.a_permission(organisation_id, 'tresorerie.consulter'));
create policy lecture on public.relances for select to authenticated
  using (prive.a_permission(organisation_id, 'tresorerie.consulter'));

create policy lecture on public.devis for select to authenticated
  using (prive.acces_magasin(organisation_id, magasin_id)
         and (prive.a_permission(organisation_id, 'ventes.valider') or prive.a_permission(organisation_id, 'rapports.consulter')));
create policy creation on public.devis for insert to authenticated
  with check (statut = 'brouillon' and prive.a_permission(organisation_id, 'ventes.valider') and prive.acces_magasin(organisation_id, magasin_id));
create policy modification on public.devis for update to authenticated
  using (prive.devis_modifiable(id)) with check (prive.a_permission(organisation_id, 'ventes.valider'));
create policy lecture on public.devis_lignes for select to authenticated
  using (exists (select 1 from public.devis d where d.id = devis_id));
create policy creation on public.devis_lignes for insert to authenticated with check (prive.devis_modifiable(devis_id));
create policy modification on public.devis_lignes for update to authenticated
  using (prive.devis_modifiable(devis_id)) with check (prive.devis_modifiable(devis_id));
create policy suppression on public.devis_lignes for delete to authenticated using (prive.devis_modifiable(devis_id));

revoke all on public.clients, public.creances, public.encaissements_creances, public.relances, public.devis, public.devis_lignes
  from anon, authenticated;
grant select on public.clients, public.creances, public.encaissements_creances, public.relances, public.devis, public.devis_lignes
  to authenticated;
grant insert (organisation_id, nom, telephone, email, adresse, contact, ncc, plafond_credit, delai_paiement, note)
  on public.clients to authenticated;
grant update (nom, telephone, email, adresse, contact, ncc, plafond_credit, delai_paiement, note, actif)
  on public.clients to authenticated;
grant insert (organisation_id, magasin_id, type, client_id, client_nom, client_contact, date_devis, validite, conditions, note)
  on public.devis to authenticated;
grant update (type, client_id, client_nom, client_contact, date_devis, validite, conditions, note) on public.devis to authenticated;
grant insert (organisation_id, devis_id, produit_id, designation, quantite, prix_unitaire, remise, ordre)
  on public.devis_lignes to authenticated;
grant update (designation, quantite, prix_unitaire, remise, ordre) on public.devis_lignes to authenticated;
grant delete on public.devis_lignes to authenticated;
grant insert (quantite_comptee) on public.receptions_lignes to authenticated;
grant update (quantite_comptee) on public.receptions_lignes to authenticated;

revoke all on function
  prive.empreinte_code(text, text), prive.compte_tiroir(uuid, uuid), prive.restes_creances(uuid, date),
  prive.tg_numero_devis(), prive.tg_totaux_devis()
from public, anon, authenticated;
revoke all on function prive.devis_modifiable(uuid) from public, anon;
grant execute on function prive.devis_modifiable(uuid) to authenticated;

revoke all on function
  public.definir_code_caisse(uuid, text, text), public.verifier_code_caisse(uuid, text), public.etat_code_caisse(uuid),
  public.reinitialiser_code_caisse(uuid), public.mouvement_caisse(uuid, text, bigint, text, uuid, uuid, text),
  public.journal_session(uuid), public.historique_clotures(uuid, uuid, int), public.annoncer_reception(uuid), public.options_caisse(uuid),
  public.balance_agee(uuid, date), public.releve_client(uuid),
  public.enregistrer_creance(uuid, uuid, bigint, date, date, text, text),
  public.encaisser_creance(uuid, uuid, uuid, bigint, uuid, date, text, text),
  public.annuler_creance(uuid, text), public.annuler_encaissement(uuid, text), public.enregistrer_relance(uuid, smallint),
  public.changer_statut_devis(uuid, text, uuid), public.proposition_approvisionnement(uuid, uuid, int, int),
  public.tableau_de_bord(uuid, text, uuid)
from public, anon;
grant execute on function
  public.definir_code_caisse(uuid, text, text), public.verifier_code_caisse(uuid, text), public.etat_code_caisse(uuid),
  public.reinitialiser_code_caisse(uuid), public.mouvement_caisse(uuid, text, bigint, text, uuid, uuid, text),
  public.journal_session(uuid), public.historique_clotures(uuid, uuid, int), public.annoncer_reception(uuid), public.options_caisse(uuid),
  public.balance_agee(uuid, date), public.releve_client(uuid),
  public.enregistrer_creance(uuid, uuid, bigint, date, date, text, text),
  public.encaisser_creance(uuid, uuid, uuid, bigint, uuid, date, text, text),
  public.annuler_creance(uuid, text), public.annuler_encaissement(uuid, text), public.enregistrer_relance(uuid, smallint),
  public.changer_statut_devis(uuid, text, uuid), public.proposition_approvisionnement(uuid, uuid, int, int),
  public.tableau_de_bord(uuid, text, uuid)
to authenticated;
