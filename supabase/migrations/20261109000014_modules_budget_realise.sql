-- =====================================================================
-- v1.1 (suite) : modules choisis à la création ; budget prévu / réalisé
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Modules optionnels : désactiver un module retire tous ses droits,
--    à tout le monde, propriétaire compris (menus, écrans et base).
-- ---------------------------------------------------------------------
-- modules_bloques : non souscrits, fixés par l'administrateur général (Décodeur Financier) ;
-- modules_desactives : retirés (comprend toujours les bloqués), le propriétaire choisit parmi les souscrits.
alter table public.organisations
  add column modules_desactives text[] not null default '{}',
  add column modules_bloques text[] not null default '{}';
alter table public.organisations add constraint organisations_modules_ck check (
  modules_desactives <@ array['stock','achats','fournisseurs','budget','tresorerie','rentabilite','promotions','comptabilite']::text[]
  and modules_bloques <@ modules_desactives);

create function prive.module_actif(p_org uuid, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.organisations o
                      where o.id = p_org and split_part(p_permission, '.', 1) = any (o.modules_desactives))
$$;

create or replace function prive.permission_du_membre(p_membre public.membres, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_membre.id is not null and p_membre.actif and prive.module_actif(p_membre.organisation_id, p_permission) and (
    p_membre.role_code = 'proprietaire'
    or coalesce(
         (select mp.accorde from public.membre_permissions mp
           where mp.membre_id = p_membre.id and mp.permission_code = p_permission),
         exists (select 1 from public.role_permissions rp
                  where rp.role_code = p_membre.role_code and rp.permission_code = p_permission)
       )
  )
$$;

create or replace function prive.a_permission(p_org uuid, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(prive.permission_du_membre(prive.membre_courant(p_org), p_permission), false)
      or (split_part(p_permission, '.', 2) in ('consulter', 'exporter')
          and prive.est_admin_general()
          and prive.module_actif(p_org, p_permission)
          and exists (select 1 from public.organisations where id = p_org))
$$;

-- L'administrateur général ne voit, lui aussi, que les modules actifs.
do $$
declare
  v_def text := pg_get_functiondef('public.mes_organisations()'::regprocedure);
  v_ancre text := 'where p.action in (''consulter'', ''exporter'') order by p.code';
begin
  if position(v_ancre in v_def) = 0 then
    raise exception 'mes_organisations : ancre introuvable';
  end if;
  execute replace(v_def, v_ancre,
    'where p.action in (''consulter'', ''exporter'') and prive.module_actif(o.id, p.code) order by p.code');
end $$;

create function public.modules_organisation(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.organisations;
begin
  perform prive.exiger(prive.est_membre(p_org), 'Accès refusé');
  select * into o from public.organisations where id = p_org;
  return jsonb_build_object(
    'desactives', to_jsonb(o.modules_desactives),
    'bloques', to_jsonb(o.modules_bloques),
    'admin', prive.est_admin_general(),
    'modifiable', (prive.membre_courant(p_org)).role_code = 'proprietaire' or prive.est_admin_general());
end $$;

create function prive.normaliser_modules(p text[]) returns text[]
language plpgsql immutable set search_path = '' as $$
declare v text[];
begin
  select coalesce(array_agg(distinct btrim(m) order by btrim(m)), '{}') into v
  from unnest(coalesce(p, '{}')) m where btrim(m) <> '';
  -- Sans stock, pas d'arrivages.
  if 'stock' = any (v) and not 'achats' = any (v) then
    v := array(select unnest(v || array['achats']) order by 1);
  end if;
  if not v <@ array['stock','achats','fournisseurs','budget','tresorerie','rentabilite','promotions','comptabilite']::text[] then
    raise exception 'Module inconnu ou obligatoire (caisse, catalogue, ventes, clients et administration restent toujours actifs)';
  end if;
  return v;
end $$;

-- Le propriétaire choisit ses modules parmi ceux souscrits ; l'administrateur général fixe en plus
-- les modules souscrits (p_bloques = non souscrits). p_desactives null : on garde les choix du propriétaire.
create function public.definir_modules(p_org uuid, p_desactives text[], p_bloques text[] default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.organisations;
  v_bloques text[];
  v_des text[];
begin
  perform prive.exiger((prive.membre_courant(p_org)).role_code = 'proprietaire' or prive.est_admin_general(),
                       'Seul le propriétaire choisit les modules de l''entreprise');
  perform prive.exiger(p_bloques is null or prive.est_admin_general(),
                       'Seul l''administrateur général fixe les modules souscrits');
  select * into o from public.organisations where id = p_org for update;
  perform prive.exiger(found, 'Entreprise introuvable');
  v_bloques := case when p_bloques is null then o.modules_bloques else prive.normaliser_modules(p_bloques) end;
  if p_desactives is null then
    -- Les modules qui redeviennent souscrits sont activés ; les autres choix restent.
    v_des := array(select unnest(o.modules_desactives) except select unnest(o.modules_bloques));
  else
    v_des := prive.normaliser_modules(p_desactives);
    perform prive.exiger(p_bloques is not null or o.modules_bloques <@ v_des,
                         'Ce module n''est pas souscrit : contactez Décodeur Financier pour l''ajouter');
  end if;
  v_des := prive.normaliser_modules(v_des || v_bloques);
  update public.organisations set modules_desactives = v_des, modules_bloques = v_bloques where id = p_org;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, avant, apres)
  values (p_org, auth.uid(), 'administration.modules', 'organisations', p_org::text,
          jsonb_build_object('desactives', o.modules_desactives, 'bloques', o.modules_bloques),
          jsonb_build_object('desactives', v_des, 'bloques', v_bloques));
  return jsonb_build_object('desactives', to_jsonb(v_des), 'bloques', to_jsonb(v_bloques));
end $$;

-- ---------------------------------------------------------------------
-- 2. Budget : date de réalisation prévue par poste, suivi prévu / réalisé
-- ---------------------------------------------------------------------
alter table public.budgets_lignes
  add column date_prevue date,
  add column commentaire text check (commentaire is null or length(commentaire) <= 200);

create or replace function public.enregistrer_budget(p_org uuid, p_mois date, p_lignes jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_mois date := date_trunc('month', p_mois)::date;
  b public.budgets;
  l jsonb;
  v_date date;
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
    v_date := nullif(l ->> 'date_prevue', '')::date;
    perform prive.exiger(v_date is null or (v_date >= v_mois and v_date < (v_mois + interval '1 month')::date),
                         'La date prévue doit tomber dans le mois du budget');
    insert into public.budgets_lignes (organisation_id, budget_id, poste_id, montant, date_prevue, commentaire)
    values (p_org, b.id, (l ->> 'poste_id')::uuid, coalesce((l ->> 'montant')::bigint, 0), v_date,
            nullif(btrim(coalesce(l ->> 'commentaire', '')), ''))
    on conflict (budget_id, poste_id) do update
      set montant = excluded.montant, date_prevue = excluded.date_prevue, commentaire = excluded.commentaire
    where (public.budgets_lignes.montant, public.budgets_lignes.date_prevue, public.budgets_lignes.commentaire)
          is distinct from (excluded.montant, excluded.date_prevue, excluded.commentaire);
  end loop;
  update public.budgets set updated_at = now() where id = b.id;
  return b.id;
end $$;

-- Statut de réalisation d'un poste :
--   realise      : dépensé, sans dépasser le prévu
--   depasse      : dépensé au-delà du prévu
--   hors_budget  : dépensé sans rien de prévu
--   en_cours     : une partie dépensée, le mois n'est pas fini
--   en_retard    : rien de dépensé alors que la date prévue est passée (mois en cours)
--   non_realise  : rien de dépensé et le mois est terminé
--   a_venir      : rien de dépensé, la date prévue n'est pas encore passée
create function prive.statut_realisation(p_prevu bigint, p_reel bigint, p_date_prevue date, p_mois date, p_jour date)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_prevu = 0 and p_reel = 0 then 'sans_objet'
    when p_prevu = 0 then 'hors_budget'
    when p_reel > p_prevu then 'depasse'
    when p_reel > 0 and (p_reel = p_prevu or p_jour >= (p_mois + interval '1 month')::date) then 'realise'
    when p_reel > 0 then 'en_cours'
    when p_jour >= (p_mois + interval '1 month')::date then 'non_realise'
    when p_date_prevue is not null and p_date_prevue < p_jour then 'en_retard'
    else 'a_venir' end
$$;

create or replace function public.suivi_budget(p_org uuid, p_mois date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_mois date := date_trunc('month', p_mois)::date;
  v_jour date := (now() at time zone 'Africa/Abidjan')::date;
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
           greatest(coalesce(d.reel, 0) - coalesce(bl.montant, 0), 0) depassement,
           case when coalesce(bl.montant, 0) > 0 then round(100.0 * coalesce(d.reel, 0) / bl.montant, 1) end taux,
           case when coalesce(d.reel, 0) > 0 and coalesce(bl.montant, 0) = 0 then 'hors_budget'
                when coalesce(bl.montant, 0) > 0 and d.reel >= bl.montant then 'depasse'
                when coalesce(bl.montant, 0) > 0 and d.reel >= 0.8 * bl.montant then 'attention'
                else 'ok' end alerte,
           bl.date_prevue, bl.commentaire,
           d.premiere date_realisation, d.derniere derniere_depense, coalesce(d.nb, 0) nb_depenses,
           case when d.premiere is not null and bl.date_prevue is not null then d.premiere - bl.date_prevue end jours_decalage,
           prive.statut_realisation(coalesce(bl.montant, 0), coalesce(d.reel, 0), bl.date_prevue, v_mois, v_jour) statut,
           coalesce(d.detail, '[]'::jsonb) depenses
    from public.postes_budget p
    left join public.budgets_lignes bl on bl.poste_id = p.id and bl.budget_id = b.id
    left join lateral (
      select sum(de.montant)::bigint reel, min(de.date_depense) premiere, max(de.date_depense) derniere, count(*)::int nb,
             jsonb_agg(jsonb_build_object('id', de.id, 'date', de.date_depense, 'montant', de.montant, 'libelle', de.libelle,
                                          'beneficiaire', de.beneficiaire, 'reference', de.reference) order by de.date_depense) detail
      from public.depenses de
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
    'totaux', (select jsonb_build_object(
                 'prevu', coalesce(sum((e ->> 'prevu')::bigint), 0),
                 'reel', coalesce(sum((e ->> 'reel')::bigint), 0),
                 'depassement', coalesce(sum((e ->> 'depassement')::bigint), 0),
                 'postes_prevus', count(*) filter (where (e ->> 'prevu')::bigint > 0),
                 'realises', count(*) filter (where e ->> 'statut' in ('realise', 'depasse')),
                 'depasses', count(*) filter (where e ->> 'statut' in ('depasse', 'hors_budget')),
                 'en_retard', count(*) filter (where e ->> 'statut' in ('en_retard', 'non_realise')),
                 'a_venir', count(*) filter (where e ->> 'statut' in ('a_venir', 'en_cours')))
                 from jsonb_array_elements(v_lignes) e));
end $$;

-- Bilan sur une année : prévu / réalisé par mois et par poste.
create function public.bilan_budget(p_org uuid, p_annee int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_debut date := make_date(p_annee, 1, 1);
  v_jour date := (now() at time zone 'Africa/Abidjan')::date;
begin
  perform prive.exiger(prive.a_permission(p_org, 'budget.consulter'), 'Droit « budget.consulter » requis');
  return jsonb_build_object(
    'annee', p_annee,
    'mois', (
      select jsonb_agg(jsonb_build_object(
               'mois', g.m,
               'statut_budget', b.statut,
               'prevu', coalesce((select sum(bl.montant) from public.budgets_lignes bl where bl.budget_id = b.id), 0),
               'reel', coalesce((select sum(de.montant) from public.depenses de
                                  where de.organisation_id = p_org and de.statut = 'enregistree'
                                    and de.date_depense >= g.m and de.date_depense < (g.m + interval '1 month')::date), 0),
               'depassement', coalesce((select sum(greatest(r.reel - r.prevu, 0)) from (
                                select coalesce(bl.montant, 0) prevu, coalesce(sum(de.montant), 0) reel
                                from public.postes_budget p
                                left join public.budgets_lignes bl on bl.poste_id = p.id and bl.budget_id = b.id
                                left join public.depenses de on de.poste_id = p.id and de.statut = 'enregistree'
                                     and de.date_depense >= g.m and de.date_depense < (g.m + interval '1 month')::date
                                where p.organisation_id = p_org
                                group by p.id, bl.montant) r), 0))
             order by g.m)
      from (select generate_series(v_debut, make_date(p_annee, 12, 1), interval '1 month')::date m) g
      left join public.budgets b on b.organisation_id = p_org and b.mois = g.m),
    'postes', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.ordre, x.libelle) from (
        select p.id poste_id, p.libelle, p.ordre,
               coalesce(sum(r.prevu), 0)::bigint prevu, coalesce(sum(r.reel), 0)::bigint reel,
               coalesce(sum(greatest(r.reel - r.prevu, 0)), 0)::bigint depassement,
               count(*) filter (where r.statut in ('realise', 'depasse'))::int mois_realises,
               count(*) filter (where r.statut in ('depasse', 'hors_budget'))::int mois_depasses,
               count(*) filter (where r.statut in ('non_realise', 'en_retard'))::int mois_non_realises
        from public.postes_budget p
        cross join lateral (
          select g.m, coalesce(bl.montant, 0) prevu,
                 coalesce((select sum(de.montant) from public.depenses de where de.poste_id = p.id and de.statut = 'enregistree'
                            and de.date_depense >= g.m and de.date_depense < (g.m + interval '1 month')::date), 0) reel,
                 prive.statut_realisation(coalesce(bl.montant, 0),
                   coalesce((select sum(de.montant) from public.depenses de where de.poste_id = p.id and de.statut = 'enregistree'
                              and de.date_depense >= g.m and de.date_depense < (g.m + interval '1 month')::date), 0)::bigint,
                   bl.date_prevue, g.m, v_jour) statut
          from (select generate_series(v_debut, least(make_date(p_annee, 12, 1), date_trunc('month', v_jour)::date), interval '1 month')::date m) g
          left join public.budgets b on b.organisation_id = p_org and b.mois = g.m
          left join public.budgets_lignes bl on bl.budget_id = b.id and bl.poste_id = p.id
        ) r
        where p.organisation_id = p_org
        group by p.id, p.libelle, p.ordre
        having coalesce(sum(r.prevu), 0) > 0 or coalesce(sum(r.reel), 0) > 0
      ) x), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- Privilèges
-- ---------------------------------------------------------------------
revoke all on function prive.module_actif(uuid, text), prive.statut_realisation(bigint, bigint, date, date, date), prive.normaliser_modules(text[]) from public;
grant execute on function prive.module_actif(uuid, text), prive.statut_realisation(bigint, bigint, date, date, date) to authenticated;
revoke all on function public.modules_organisation(uuid), public.definir_modules(uuid, text[], text[]), public.bilan_budget(uuid, int) from public, anon;
grant execute on function public.modules_organisation(uuid), public.definir_modules(uuid, text[], text[]), public.bilan_budget(uuid, int) to authenticated;
