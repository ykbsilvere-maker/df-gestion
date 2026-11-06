-- 1.7 — Le gérant principal suit les ventes en cours de chaque caisse
-- (solde, nombre de ventes, part de chaque caissier) et tire un rapport X
-- provisoire avec les produits vendus. Un caissier ne lit que sa propre session.

-- Totaux de session : ajout du détail des produits vendus.
do $$
declare v_def text := pg_get_functiondef('prive.calculer_totaux_session(uuid)'::regprocedure);
  v_ancre text := '''calcule_le'', now()';
begin
  if position(v_ancre in v_def) = 0 then raise exception 'calculer_totaux_session : ancre introuvable'; end if;
  execute replace(v_def, v_ancre,
    '''par_produit'', coalesce((
      select jsonb_agg(jsonb_build_object(''designation'', designation, ''quantite'', quantite, ''montant'', montant)
                       order by montant desc, designation)
      from (select vl.designation, sum(vl.quantite) quantite, sum(vl.montant) montant
              from public.ventes_lignes vl join v on v.id = vl.vente_id
             where v.statut = ''validee''
             group by vl.designation) p
    ), ''[]''::jsonb),
    ''calcule_le'', now()');
end $$;

-- Rapport d'une session : son caissier, la personne qui l'a ouverte, ou un responsable.
do $$
declare v_def text := pg_get_functiondef('public.rapport_session(uuid)'::regprocedure);
  v_ancre text := 'perform prive.exiger(found and prive.peut_voir_ventes(s.organisation_id, s.magasin_id), ''Session introuvable'');';
begin
  if position(v_ancre in v_def) = 0 then raise exception 'rapport_session : ancre introuvable'; end if;
  execute replace(v_def, v_ancre,
    'perform prive.exiger(found and prive.peut_voir_ventes(s.organisation_id, s.magasin_id)
                       and (prive.voit_toutes_ventes(s.organisation_id) or s.caissier_id = auth.uid() or s.ouverte_par = auth.uid()),
                       ''Session introuvable'');');
end $$;

-- Caisses du jour : solde des ventes en cours, visible des responsables seulement.
do $$
declare v_def text := pg_get_functiondef('public.mes_caisses(uuid)'::regprocedure);
  v_ancre text := '''fond'', s.fond_initial)';
begin
  if position(v_ancre in v_def) = 0 then raise exception 'mes_caisses : ancre introuvable'; end if;
  execute replace(v_def, v_ancre,
    '''fond'', s.fond_initial,
                                                     ''ventes'', case when prive.voit_toutes_ventes(p_org) then (
                                                       select jsonb_build_object(''total'', coalesce(sum(vt.total), 0), ''nombre'', count(*))
                                                         from public.ventes vt where vt.session_id = s.id and vt.statut = ''validee'') end)');
end $$;
