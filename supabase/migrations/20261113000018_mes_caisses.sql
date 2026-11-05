-- =====================================================================
-- 1.4 : « Ouvrir une caisse » — les caisses que la personne peut ouvrir
-- =====================================================================
-- Renvoie les caisses actives visibles par la personne, avec pour chacune :
-- accessible (elle peut l'ouvrir), la raison sinon, et la session ouverte
-- (par qui, depuis quand, est-ce la sienne). L'écran de caisse ne propose
-- plus de caisse qui serait ensuite refusée.

create function public.mes_caisses(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_peut boolean := prive.a_permission(p_org, 'caisse.creer');
begin
  perform prive.exiger(prive.est_membre(p_org), 'Accès refusé');
  return jsonb_build_object(
    'peut_ouvrir', v_peut,
    'caisses', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'code', c.code, 'nom', c.nom, 'magasin_id', c.magasin_id, 'magasin_nom', m.nom,
               'accessible', v_peut and prive.acces_caisse(p_org, c.id),
               'raison', case when not v_peut then 'droit'
                              when not prive.acces_magasin(p_org, c.magasin_id) then 'magasin'
                              when not prive.acces_caisse(p_org, c.id) then 'caisse' end,
               'session', (select jsonb_build_object('id', s.id, 'ouverte_le', s.ouverte_le, 'mienne', s.ouverte_par = auth.uid(),
                                                     'par', coalesce(nullif(btrim(pr.nom_complet), ''), 'un collègue'))
                             from public.sessions_caisse s left join public.profils pr on pr.id = s.ouverte_par
                            where s.caisse_id = c.id and s.statut = 'ouverte' limit 1))
             order by c.code)
      from public.caisses c join public.magasins m on m.id = c.magasin_id
      where c.organisation_id = p_org and c.actif
        and (prive.acces_magasin(p_org, c.magasin_id) or prive.acces_caisse(p_org, c.id)
             or prive.a_permission(p_org, 'magasins.consulter'))), '[]'::jsonb));
end $$;

revoke all on function public.mes_caisses(uuid) from public, anon;
grant execute on function public.mes_caisses(uuid) to authenticated;
