-- v3.21 — Zones de livraison : modifier et supprimer (journalisé).
-- Les commandes gardent le nom et les frais de leur zone : supprimer une zone ne change aucune commande passée.
create or replace function public.zone_livraison_supprimer(p_org uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare z public.zones_livraison;
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.modifier'), 'Droit « boutique.modifier » requis');
  delete from public.zones_livraison where id = p_id and organisation_id = p_org returning * into z;
  perform prive.exiger(z.id is not null, 'Zone introuvable');
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), 'boutique.zone_supprimee', 'zones_livraison', z.id::text,
          jsonb_build_object('nom', z.nom, 'frais', z.frais));
end $$;
revoke all on function public.zone_livraison_supprimer(uuid, uuid) from public, anon;
grant execute on function public.zone_livraison_supprimer(uuid, uuid) to authenticated;
