-- =====================================================================
-- v0.8 — Extraction des ventes et habilitations par module
--
-- 1. public.extraction_ventes : ventes sur une période, par ticket, par
--    produit, par période (jour / semaine / mois) ou par moyen de paiement.
--    Coût d'achat et marge renvoyés seulement à qui a « comptabilite.consulter ».
-- 2. public.definir_permissions_membre : applique d'un coup l'ensemble des
--    droits voulus pour un membre (grille par module), en ne gardant comme
--    exceptions individuelles que les écarts avec le rôle.
-- =====================================================================

-- Ventes retenues par les filtres, limitées aux magasins de la personne.
create function prive.ventes_filtrees(
  p_org uuid, p_debut date, p_fin date, p_magasin uuid, p_caisse uuid,
  p_caissier uuid, p_produit uuid, p_inclure_annulees boolean
) returns setof public.ventes
language sql stable security definer set search_path = '' as $$
  -- La Côte d'Ivoire est à UTC+0 toute l'année.
  select v.* from public.ventes v
  where v.organisation_id = p_org
    and v.date_vente >= (p_debut::timestamp at time zone 'Africa/Abidjan')
    and v.date_vente <  ((p_fin + 1)::timestamp at time zone 'Africa/Abidjan')
    and (p_inclure_annulees or v.statut = 'validee')
    and (p_magasin is null or v.magasin_id = p_magasin)
    and (p_caisse is null or v.caisse_id = p_caisse)
    and (p_caissier is null or v.caissier_id = p_caissier)
    and prive.acces_magasin(p_org, v.magasin_id)
    and (p_produit is null or exists (
          select 1 from public.ventes_lignes l where l.vente_id = v.id and l.produit_id = p_produit))
$$;

create function public.extraction_ventes(
  p_org        uuid,
  p_debut      date,
  p_fin        date,
  p_vue        text default 'tickets',      -- tickets | produits | periodes | paiements
  p_frequence  text default 'jour',         -- jour | semaine | mois (vue periodes)
  p_magasin    uuid default null,
  p_caisse     uuid default null,
  p_caissier   uuid default null,
  p_produit    uuid default null,
  p_inclure_annulees boolean default false
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_marges boolean;
  v_lignes jsonb;
  v_totaux jsonb;
  v_trunc text;
begin
  perform prive.exiger(p_debut is not null and p_fin is not null and p_debut <= p_fin, 'Période invalide');
  perform prive.exiger(p_fin - p_debut <= 400, 'Période limitée à 400 jours');
  perform prive.exiger(p_vue in ('tickets','produits','periodes','paiements'), 'Vue inconnue');
  perform prive.exiger(p_frequence in ('jour','semaine','mois'), 'Fréquence inconnue');
  perform prive.exiger(
    prive.a_permission(p_org, 'ventes.exporter') or prive.a_permission(p_org, 'rapports.consulter'),
    'Droit « ventes.exporter » ou « rapports.consulter » requis');

  v_marges := prive.a_permission(p_org, 'comptabilite.consulter');
  v_trunc := case p_frequence when 'jour' then 'day' when 'semaine' then 'week' else 'month' end;

  if p_vue = 'tickets' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.date_vente), '[]'::jsonb) into v_lignes from (
      select v.numero, v.date_vente, m.nom magasin, c.nom caisse,
             coalesce(pr.nom_complet, '') caissier, coalesce(v.client_nom, '') client,
             (select coalesce(sum(l.quantite), 0) from public.ventes_lignes l where l.vente_id = v.id) articles,
             v.total_remises remises, v.total, v.statut, v.origine,
             (select string_agg(distinct r.libelle, ' + ') from public.reglements r
               where r.vente_id = v.id and r.statut = 'enregistre' and r.sens = 'encaissement') paiement,
             case when v_marges then k.cout end cout,
             case when v_marges then v.total - k.cout end marge
      from prive.ventes_filtrees(p_org, p_debut, p_fin, p_magasin, p_caisse, p_caissier, p_produit, p_inclure_annulees) v
      left join public.magasins m on m.id = v.magasin_id
      left join public.caisses c on c.id = v.caisse_id
      left join public.profils pr on pr.id = v.caissier_id
      left join lateral (select round(coalesce(sum(l.quantite * l.cout_unitaire), 0))::bigint cout
                           from public.ventes_lignes l where l.vente_id = v.id) k on true
      order by v.date_vente
      limit 20000
    ) x;

  elsif p_vue = 'produits' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.chiffre_affaires desc), '[]'::jsonb) into v_lignes from (
      select l.produit_id, max(l.designation) designation,
             coalesce(max(p.code), '') code,
             sum(l.quantite) quantite,
             count(distinct l.vente_id) tickets,
             round(sum(l.montant) / nullif(sum(l.quantite), 0))::bigint prix_moyen,
             sum(l.remise) remises,
             sum(l.montant) chiffre_affaires,
             case when v_marges then round(sum(l.quantite * coalesce(l.cout_unitaire, 0)))::bigint end cout,
             case when v_marges then (sum(l.montant) - round(sum(l.quantite * coalesce(l.cout_unitaire, 0))))::bigint end marge,
             case when v_marges then round(100.0 * (sum(l.montant) - sum(l.quantite * coalesce(l.cout_unitaire, 0)))
                                      / nullif(sum(l.montant), 0), 1) end taux_marge
      from public.ventes_lignes l
      join prive.ventes_filtrees(p_org, p_debut, p_fin, p_magasin, p_caisse, p_caissier, p_produit, false) v on v.id = l.vente_id
      left join public.produits p on p.id = l.produit_id
      where p_produit is null or l.produit_id = p_produit
      group by l.produit_id
    ) x;

  elsif p_vue = 'periodes' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.debut), '[]'::jsonb) into v_lignes from (
      select date_trunc(v_trunc, v.date_vente at time zone 'Africa/Abidjan')::date debut,
             count(*) filter (where v.statut = 'validee') tickets,
             coalesce(sum(v.total) filter (where v.statut = 'validee'), 0) chiffre_affaires,
             coalesce(sum(v.total_remises) filter (where v.statut = 'validee'), 0) remises,
             coalesce(round(avg(v.total) filter (where v.statut = 'validee')), 0)::bigint panier_moyen,
             count(*) filter (where v.statut = 'annulee') annulations,
             case when v_marges then coalesce(round(sum(k.cout) filter (where v.statut = 'validee')), 0)::bigint end cout,
             case when v_marges then (coalesce(sum(v.total) filter (where v.statut = 'validee'), 0)
                                   - coalesce(round(sum(k.cout) filter (where v.statut = 'validee')), 0))::bigint end marge
      from prive.ventes_filtrees(p_org, p_debut, p_fin, p_magasin, p_caisse, p_caissier, p_produit, p_inclure_annulees) v
      left join lateral (select sum(l.quantite * coalesce(l.cout_unitaire, 0)) cout
                           from public.ventes_lignes l where l.vente_id = v.id) k on true
      group by 1
    ) x;

  else -- paiements
    select coalesce(jsonb_agg(to_jsonb(x) order by x.net desc), '[]'::jsonb) into v_lignes from (
      select r.libelle moyen, r.nature,
             count(*) filter (where r.sens = 'encaissement') operations,
             coalesce(sum(r.montant) filter (where r.sens = 'encaissement'), 0) encaisse,
             coalesce(sum(r.montant) filter (where r.sens = 'rendu'), 0) rendu,
             coalesce(sum(case when r.sens = 'rendu' then -r.montant else r.montant end), 0) net
      from public.reglements r
      join prive.ventes_filtrees(p_org, p_debut, p_fin, p_magasin, p_caisse, p_caissier, p_produit, false) v on v.id = r.vente_id
      where r.statut = 'enregistre'
      group by r.libelle, r.nature
    ) x;
  end if;

  select jsonb_build_object(
    'tickets', count(*) filter (where v.statut = 'validee'),
    'chiffre_affaires', coalesce(sum(v.total) filter (where v.statut = 'validee'), 0),
    'remises', coalesce(sum(v.total_remises) filter (where v.statut = 'validee'), 0),
    'panier_moyen', coalesce(round(avg(v.total) filter (where v.statut = 'validee')), 0),
    'annulations', count(*) filter (where v.statut = 'annulee'),
    'total_annulations', coalesce(sum(v.total) filter (where v.statut = 'annulee'), 0),
    'cout', case when v_marges then coalesce(round(sum(k.cout) filter (where v.statut = 'validee')), 0) end,
    'marge', case when v_marges then coalesce(sum(v.total) filter (where v.statut = 'validee'), 0)
                                 - coalesce(round(sum(k.cout) filter (where v.statut = 'validee')), 0) end
  ) into v_totaux
  from prive.ventes_filtrees(p_org, p_debut, p_fin, p_magasin, p_caisse, p_caissier, p_produit, true) v
  left join lateral (select sum(l.quantite * coalesce(l.cout_unitaire, 0)) cout
                       from public.ventes_lignes l where l.vente_id = v.id) k on true;

  return jsonb_build_object(
    'vue', p_vue, 'frequence', p_frequence, 'debut', p_debut, 'fin', p_fin,
    'marges_visibles', v_marges, 'lignes', v_lignes, 'totaux', jsonb_strip_nulls(v_totaux),
    'tronque', p_vue = 'tickets' and jsonb_array_length(v_lignes) >= 20000,
    'calcule_le', now());
end $$;

-- ---------------------------------------------------------------------
-- Grille d'habilitations : on donne l'ensemble des droits voulus.
-- Pour chaque droit dont l'état change, l'appelant doit lui-même l'avoir
-- (même règle que definir_permission_membre). Les droits identiques au
-- rôle redeviennent « par défaut » (aucune exception enregistrée).
-- ---------------------------------------------------------------------
create function public.definir_permissions_membre(p_membre uuid, p_permissions text[])
returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  cible public.membres := prive.charger_membre_cible(p_membre, 'utilisateurs.modifier');
  v_code text;
  v_voulu boolean;
  v_role boolean;
  v_actuel boolean;
  v_inconnu text;
begin
  perform prive.exiger(cible.role_code <> 'proprietaire', 'Un propriétaire a toujours tous les droits');
  select x into v_inconnu from unnest(coalesce(p_permissions, '{}')) x
   where not exists (select 1 from public.permissions p where p.code = x) limit 1;
  perform prive.exiger(v_inconnu is null, format('Permission inconnue : %s', v_inconnu));

  for v_code in select code from public.permissions order by code loop
    v_voulu := v_code = any(coalesce(p_permissions, '{}'));
    v_actuel := prive.permission_du_membre(cible, v_code);
    if v_voulu is distinct from v_actuel then
      perform prive.exiger(prive.a_permission(cible.organisation_id, v_code),
                           format('Vous ne pouvez pas déléguer un droit que vous n''avez pas : %s', v_code));
    end if;
    v_role := exists (select 1 from public.role_permissions rp
                       where rp.role_code = cible.role_code and rp.permission_code = v_code);
    if v_voulu = v_role then
      delete from public.membre_permissions where membre_id = cible.id and permission_code = v_code;
    else
      insert into public.membre_permissions (organisation_id, membre_id, permission_code, accorde)
      values (cible.organisation_id, cible.id, v_code, v_voulu)
      on conflict (membre_id, permission_code) do update set accorde = excluded.accorde
      where public.membre_permissions.accorde is distinct from excluded.accorde;
    end if;
  end loop;

  return prive.permissions_effectives(cible.id);
end $$;

revoke all on function prive.ventes_filtrees(uuid, date, date, uuid, uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.extraction_ventes(uuid, date, date, text, text, uuid, uuid, uuid, uuid, boolean) from public, anon;
revoke all on function public.definir_permissions_membre(uuid, text[]) from public, anon;
grant execute on function public.extraction_ventes(uuid, date, date, text, text, uuid, uuid, uuid, uuid, boolean) to authenticated;
grant execute on function public.definir_permissions_membre(uuid, text[]) to authenticated;
