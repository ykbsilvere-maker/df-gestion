-- v3.13 — Droit d'affecter les commandes en ligne, délégable par la gérante.
--
-- La gérante (droit « boutique.valider ») affecte les commandes. Elle peut aussi donner ce seul
-- droit à une caissière de confiance (« boutique.affecter ») : celle-ci est prévenue des
-- commandes à affecter et peut les confier, sans les autres pouvoirs de la gérante
-- (paiements, livraisons, vitrine). Le reste du circuit ne change pas.

insert into public.permissions (code, module, action) values ('boutique.affecter', 'boutique', 'affecter')
on conflict (code) do nothing;

create or replace function prive.peut_affecter(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select prive.a_permission(p_org, 'boutique.valider') or prive.a_permission(p_org, 'boutique.affecter')
$$;

-- Affecter : gérante ou personne désignée.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.affecter_commande_web(uuid,uuid)'::regprocedure);
  if position('prive.peut_affecter' in d) = 0 then
    if position('found and prive.a_permission(c.organisation_id, ''boutique.valider'')' in d) = 0 then
      raise exception 'affecter_commande_web : ancre introuvable';
    end if;
    d := replace(d, 'found and prive.a_permission(c.organisation_id, ''boutique.valider'')',
                    'found and prive.peut_affecter(c.organisation_id)');
    execute d;
  end if;
end $$;

create or replace function public.caissiers_commande(p_org uuid, p_magasin uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform prive.exiger(prive.peut_affecter(p_org), 'Droit « boutique.valider » requis');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', m.user_id, 'nom', coalesce(nullif(btrim(pr.nom_complet), ''), pr.email, 'Membre'), 'role', m.role_code,
             'en_caisse', exists (select 1 from public.sessions_caisse s where s.organisation_id = p_org and s.magasin_id = p_magasin
                                    and s.statut = 'ouverte' and s.ouverte_par = m.user_id),
             'en_cours', (select count(*) from public.commandes_web c where c.organisation_id = p_org and c.caissier_id = m.user_id
                            and c.vente_id is null and c.statut not in ('livree','annulee')))
           order by 4 desc, 2)
      from public.membres m left join public.profils pr on pr.id = m.user_id
     where m.organisation_id = p_org and m.actif and prive.peut_encaisser_magasin(p_org, m.user_id, p_magasin)), '[]'::jsonb);
end $$;

-- Ce que chacun doit voir : la personne désignée reçoit aussi « à affecter ».
create or replace function prive.attente_pour(p_org uuid, p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with m as (select * from public.membres where organisation_id = p_org and user_id = p_user and actif limit 1),
  d as (select m.*, prive.permission_du_membre(m, 'boutique.consulter') consulte,
               prive.permission_du_membre(m, 'boutique.valider') gerante,
               prive.permission_du_membre(m, 'boutique.valider') or prive.permission_du_membre(m, 'boutique.affecter') affecteur from m),
  c as (select w.* from public.commandes_web w, d
         where w.organisation_id = p_org and w.vente_id is null and d.consulte
           and (d.role_code = 'proprietaire' or d.tous_magasins
                or exists (select 1 from public.membre_magasins mm where mm.membre_id = d.id and mm.magasin_id = w.magasin_id)))
  select coalesce((select jsonb_build_object(
    'nombre', (select count(*) from c where c.caissier_id = p_user and c.statut in ('confirmee','prete','en_livraison')),
    'a_affecter', case when d.affecteur then (select count(*) from c where c.caissier_id is null and c.statut in ('nouvelle','confirmee','prete')) else 0 end,
    'en_attente', (select count(*) from c where c.caissier_id is null and c.statut in ('nouvelle','confirmee')),
    'a_accepter', (select count(*) from c where c.caissier_id = p_user and c.prise_en_charge_le is null
                                         and c.statut in ('confirmee','prete','en_livraison')),
    'a_accepter_liste', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'numero', c.numero, 'mode', c.mode,
                                                                      'client', c.client_nom) order by c.affectee_le)
                                  from c where c.caissier_id = p_user and c.prise_en_charge_le is null
                                           and c.statut in ('confirmee','prete','en_livraison')), '[]'::jsonb),
    'a_livrer', case when d.gerante then (select count(*) from c where c.mode = 'livraison' and c.statut = 'prete') else 0 end,
    'gerante', d.gerante,
    'affecteur', d.affecteur,
    'derniere', (select max(created_at) from c where c.statut = 'nouvelle'),
    'derniere_affectation', (select max(affectee_le) from c where c.caissier_id = p_user),
    'derniere_prete', case when d.gerante then (select max(prete_le) from c where c.mode = 'livraison' and c.statut = 'prete') end)
    from d where d.consulte),
    jsonb_build_object('nombre', 0, 'a_affecter', 0, 'en_attente', 0, 'a_accepter', 0, 'a_accepter_liste', '[]'::jsonb,
                       'a_livrer', 0, 'gerante', false, 'affecteur', false))
$$;

-- L'équipe et qui peut affecter (vue de la gérante).
create or replace function public.affecteurs_commandes(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.valider'), 'Droit « boutique.valider » requis');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', m.user_id, 'nom', coalesce(nullif(btrim(pr.nom_complet), ''), pr.email, 'Membre'), 'role', m.role_code,
             'gerante', prive.permission_du_membre(m, 'boutique.valider'),
             'affecteur', prive.permission_du_membre(m, 'boutique.affecter'),
             'moi', m.user_id = auth.uid())
           order by prive.permission_du_membre(m, 'boutique.valider') desc, coalesce(nullif(btrim(pr.nom_complet), ''), pr.email))
      from public.membres m left join public.profils pr on pr.id = m.user_id
     where m.organisation_id = p_org and m.actif and prive.permission_du_membre(m, 'boutique.consulter')), '[]'::jsonb);
end $$;

-- Donner ou retirer le droit d'affecter (la gérante seulement).
create or replace function public.affecteur_definir(p_org uuid, p_user uuid, p_actif boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare m public.membres;
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.valider'), 'Seule la gérante peut désigner qui affecte les commandes');
  select * into m from public.membres where organisation_id = p_org and user_id = p_user and actif;
  perform prive.exiger(found, 'Membre introuvable');
  perform prive.exiger(not prive.permission_du_membre(m, 'boutique.valider'), 'Cette personne gère déjà la boutique : elle affecte déjà');
  if coalesce(p_actif, false) then
    insert into public.membre_permissions (organisation_id, membre_id, permission_code, accorde)
    values (p_org, m.id, 'boutique.affecter', true)
    on conflict (membre_id, permission_code) do update set accorde = true;
  else
    delete from public.membre_permissions where membre_id = m.id and permission_code = 'boutique.affecter';
  end if;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), case when p_actif then 'boutique.affecteur_ajoute' else 'boutique.affecteur_retire' end,
          'membres', m.id::text, jsonb_build_object('user_id', p_user));
  return public.affecteurs_commandes(p_org);
end $$;

revoke execute on function public.affecteurs_commandes(uuid), public.affecteur_definir(uuid, uuid, boolean) from public, anon;
grant execute on function public.affecteurs_commandes(uuid), public.affecteur_definir(uuid, uuid, boolean) to authenticated;
