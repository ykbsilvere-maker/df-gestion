-- 3.2 — Tableau de bord sur un intervalle choisi (du … au …), en plus de Jour / Semaine / Mois / Année.
-- Même contenu que tableau_de_bord ; la comparaison porte sur la période de même durée juste avant.
create function public.tableau_de_bord_intervalle(p_org uuid, p_du date, p_au date, p_magasin uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_debut timestamp := p_du::timestamp;
  v_fin timestamp := (p_au + 1)::timestamp;
  v_prec_debut timestamp;
  v_pas text;
  v_unite interval;
  v_marges boolean := prive.a_permission(p_org, 'rapports.valider');
  r jsonb;
begin
  perform prive.exiger(prive.a_permission(p_org, 'rapports.consulter') or prive.a_permission(p_org, 'ventes.exporter'),
                       'Droit « rapports.consulter » requis');
  perform prive.exiger(p_du is not null and p_au is not null and p_du <= p_au, 'Choisissez une date de début antérieure à la date de fin');
  perform prive.exiger(p_au - p_du <= 3660, 'Intervalle limité à dix ans');
  v_prec_debut := v_debut - (v_fin - v_debut);
  -- Barres : par heure sur un jour, par jour jusqu'à 2 mois, par semaine jusqu'à 6 mois, sinon par mois.
  v_pas := case when p_au = p_du then 'hour' when p_au - p_du <= 62 then 'day' when p_au - p_du <= 186 then 'week' else 'month' end;
  v_unite := case v_pas when 'hour' then interval '1 hour' when 'day' then interval '1 day' when 'week' then interval '1 week' else interval '1 month' end;

  with v as (
    select v.*, (v.date_vente at time zone 'Africa/Abidjan') heure_locale from public.ventes v
    where v.organisation_id = p_org and v.statut = 'validee'
      and v.date_vente >= (v_prec_debut at time zone 'Africa/Abidjan') and v.date_vente < (v_fin at time zone 'Africa/Abidjan')
      and (p_magasin is null or v.magasin_id = p_magasin) and prive.acces_magasin(p_org, v.magasin_id)
  ),
  cour as (select * from v where heure_locale >= v_debut),
  prec as (select * from v where heure_locale < v_debut)
  select jsonb_build_object(
    'periode', 'intervalle', 'pas', v_pas, 'debut', v_debut, 'fin', v_fin, 'du', p_du, 'au', p_au,
    'ca', (select coalesce(sum(total), 0) from cour),
    'ca_precedent', (select coalesce(sum(total), 0) from prec),
    'tickets', (select count(*) from cour),
    'tickets_precedent', (select count(*) from prec),
    'panier_moyen', (select coalesce(round(avg(total)), 0) from cour),
    'marge', case when v_marges then (select coalesce(round(sum(l.montant - l.quantite * coalesce(l.cout_unitaire, 0))), 0)
                                         from public.ventes_lignes l join cour on cour.id = l.vente_id) end,
    'serie', coalesce((
      select jsonb_agg(jsonb_build_object('debut', g.t, 'ca', coalesce(s.ca, 0), 'tickets', coalesce(s.n, 0)) order by g.t)
      from generate_series(date_trunc(v_pas, v_debut), v_fin - interval '1 second', v_unite) g(t)
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

revoke all on function public.tableau_de_bord_intervalle(uuid, date, date, uuid) from public, anon;
grant execute on function public.tableau_de_bord_intervalle(uuid, date, date, uuid) to authenticated;
