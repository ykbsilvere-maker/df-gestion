-- =====================================================================
-- v0.7 — Monnaie de chaque entreprise
--   * XOF (franc CFA UEMOA) par défaut ; autres monnaies proposées : XAF, EUR,
--     USD, GBP, GNF, MAD, GHS, NGN ;
--   * les montants restent des entiers dans la plus petite unité de la monnaie
--     (1 XOF, 1 centime d'euro…) : aucune colonne ne change de type ;
--   * la monnaie se choisit à la création et peut être changée tant qu'aucun
--     article ni aucune opération n'est enregistré (sinon les prix seraient
--     relus dans une autre monnaie) ;
--   * la console de l'administrateur général indique la monnaie de chaque
--     entreprise (pas de total mélangeant deux monnaies).
-- =====================================================================

alter table public.organisations
  add constraint organisations_devise_check
  check (devise in ('XOF', 'XAF', 'EUR', 'USD', 'GBP', 'GNF', 'MAD', 'GHS', 'NGN'));

grant update (devise) on public.organisations to authenticated;

-- Vrai dès qu'un montant a été enregistré dans la monnaie actuelle.
create function prive.devise_verrouillee(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.produits where organisation_id = p_org)
      or exists (select 1 from public.sessions_caisse where organisation_id = p_org)
      or exists (select 1 from public.ventes where organisation_id = p_org)
      or exists (select 1 from public.receptions where organisation_id = p_org)
      or exists (select 1 from public.mouvements_stock where organisation_id = p_org)
$$;

create function prive.controle_devise() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.devise is distinct from old.devise then
    perform prive.exiger(not prive.devise_verrouillee(old.id),
      'La monnaie ne peut plus être changée : des articles ou des opérations sont déjà enregistrés dans '
      || old.devise || '.');
  end if;
  return new;
end $$;

create trigger organisations_devise
  before update of devise on public.organisations
  for each row execute function prive.controle_devise();

-- Pour l'écran Personnalisation : la liste des monnaies est-elle encore modifiable ?
create function public.devise_modifiable(p_org uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.est_membre(p_org), 'Accès refusé');
  return not prive.devise_verrouillee(p_org);
end $$;

-- ---------------------------------------------------------------------
-- Entreprises visibles : la monnaie est renvoyée avec chacune (l'application
-- l'applique dès l'ouverture, avant même le chargement de la fiche).
-- ---------------------------------------------------------------------
drop function public.mes_organisations();
create function public.mes_organisations()
returns table (
  organisation_id uuid,
  nom text,
  membre_id uuid,
  role_code text,
  role_libelle text,
  tous_magasins boolean,
  permissions text[],
  devise text
)
language sql stable security definer set search_path = '' as $$
  with miennes as (
    select o.id, o.nom, m.id as membre_id, m.role_code, r.libelle,
           (m.tous_magasins or m.role_code = 'proprietaire') as tous, prive.permissions_effectives(m.id) as droits,
           o.devise::text as devise
    from public.membres m
    join public.organisations o on o.id = m.organisation_id and o.actif
    join public.roles r on r.code = m.role_code
    where m.user_id = auth.uid() and m.actif
  )
  select * from (
    select * from miennes
    union all
    select o.id,
           case when o.actif then o.nom else o.nom || ' (suspendue)' end,
           null::uuid, 'admin_general', 'Administrateur général (consultation)', true,
           array(select p.code from public.permissions p where p.action in ('consulter', 'exporter') order by p.code),
           o.devise::text
    from public.organisations o
    where prive.est_admin_general() and o.id not in (select id from miennes)
  ) x
  order by 2
$$;

-- ---------------------------------------------------------------------
-- Création d'entreprise : choix de la monnaie (XOF par défaut)
-- ---------------------------------------------------------------------
drop function public.creer_organisation(text, text, text, text, text, text, text);
create function public.creer_organisation(
  p_nom text,
  p_ncc text default null,
  p_regime_fiscal text default 'non_precise',
  p_telephone text default null,
  p_adresse text default null,
  p_ville text default null,
  p_nom_magasin text default 'Magasin principal',
  p_devise text default 'XOF'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_mag uuid;
begin
  perform prive.exiger(v_uid is not null, 'Connexion requise');
  perform prive.exiger(prive.peut_creer_entreprise(),
    'La création d''entreprise est réservée à l''administrateur général : demandez-lui votre accès');
  insert into public.profils (id, email)
  select v_uid, lower(u.email) from auth.users u where u.id = v_uid
  on conflict (id) do nothing;

  insert into public.organisations (nom, ncc, regime_fiscal, telephone, adresse, ville, devise, cree_par)
  values (btrim(p_nom), nullif(btrim(p_ncc), ''), coalesce(p_regime_fiscal, 'non_precise'),
          p_telephone, p_adresse, p_ville, upper(coalesce(nullif(btrim(p_devise), ''), 'XOF')), v_uid)
  returning id into v_org;

  insert into public.membres (organisation_id, user_id, role_code, tous_magasins)
  values (v_org, v_uid, 'proprietaire', true);

  insert into public.magasins (organisation_id, code, nom, adresse, ville, telephone)
  values (v_org, 'MAG01', coalesce(nullif(btrim(p_nom_magasin), ''), 'Magasin principal'),
          p_adresse, p_ville, p_telephone)
  returning id into v_mag;

  insert into public.caisses (organisation_id, magasin_id, code, nom)
  values (v_org, v_mag, 'CAISSE01', 'Caisse 1');

  return v_org;
end $$;

drop function public.admin_creer_entreprise(text, text, text, text, text, text, text, text);
create function public.admin_creer_entreprise(
  p_nom text,
  p_gerant_email text,
  p_ncc text default null,
  p_regime_fiscal text default 'non_precise',
  p_telephone text default null,
  p_adresse text default null,
  p_ville text default null,
  p_nom_magasin text default 'Magasin principal',
  p_devise text default 'XOF'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_mag uuid;
begin
  perform prive.exiger(prive.est_admin_general(), 'Réservé à l''administrateur général');
  perform prive.exiger(length(btrim(coalesce(p_nom, ''))) >= 2, 'Nom de l''entreprise requis');
  insert into public.organisations (nom, ncc, regime_fiscal, telephone, adresse, ville, devise, cree_par)
  values (btrim(p_nom), nullif(btrim(p_ncc), ''), coalesce(p_regime_fiscal, 'non_precise'),
          nullif(btrim(p_telephone), ''), nullif(btrim(p_adresse), ''), nullif(btrim(p_ville), ''),
          upper(coalesce(nullif(btrim(p_devise), ''), 'XOF')), auth.uid())
  returning id into v_org;

  insert into public.magasins (organisation_id, code, nom, adresse, ville, telephone)
  values (v_org, 'MAG01', coalesce(nullif(btrim(p_nom_magasin), ''), 'Magasin principal'),
          nullif(btrim(p_adresse), ''), nullif(btrim(p_ville), ''), nullif(btrim(p_telephone), ''))
  returning id into v_mag;
  insert into public.caisses (organisation_id, magasin_id, code, nom)
  values (v_org, v_mag, 'CAISSE01', 'Caisse 1');

  perform prive.inviter_gerant(v_org, p_gerant_email);
  return v_org;
end $$;

-- Console : chaque entreprise avec sa monnaie (les totaux ne se mélangent pas).
drop function public.admin_tableau_de_bord();
create function public.admin_tableau_de_bord()
returns table (
  organisation_id uuid,
  nom text,
  ville text,
  telephone text,
  actif boolean,
  creee_le timestamptz,
  magasins int,
  caisses int,
  caisses_ouvertes int,
  utilisateurs int,
  gerants jsonb,
  gerants_en_attente text[],
  ventes_jour bigint,
  tickets_jour bigint,
  ventes_mois bigint,
  derniere_activite timestamptz,
  devise text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_jour date := (now() at time zone 'Africa/Abidjan')::date;
begin
  perform prive.exiger(prive.est_admin_general(), 'Réservé à l''administrateur général');
  return query
  select o.id, o.nom, o.ville, o.telephone, o.actif, o.created_at,
    (select count(*) from public.magasins g where g.organisation_id = o.id and g.actif)::int,
    (select count(*) from public.caisses c where c.organisation_id = o.id and c.actif)::int,
    (select count(*) from public.sessions_caisse s where s.organisation_id = o.id and s.statut = 'ouverte')::int,
    (select count(*) from public.membres m where m.organisation_id = o.id and m.actif)::int,
    coalesce((select jsonb_agg(jsonb_build_object('nom', p.nom_complet, 'email', p.email,
                                                  'derniere_connexion', m.derniere_connexion)
                               order by m.created_at)
              from public.membres m join public.profils p on p.id = m.user_id
              where m.organisation_id = o.id and m.actif and m.role_code = 'proprietaire'), '[]'::jsonb),
    array(select i.email from public.invitations i
          where i.organisation_id = o.id and i.statut = 'en_attente' and i.role_code = 'proprietaire'
          order by i.created_at),
    (select coalesce(sum(v.total), 0)::bigint from public.ventes v
      where v.organisation_id = o.id and v.statut = 'validee'
        and (v.date_vente at time zone 'Africa/Abidjan')::date = v_jour),
    (select count(*) from public.ventes v
      where v.organisation_id = o.id and v.statut = 'validee'
        and (v.date_vente at time zone 'Africa/Abidjan')::date = v_jour),
    (select coalesce(sum(v.total), 0)::bigint from public.ventes v
      where v.organisation_id = o.id and v.statut = 'validee'
        and (v.date_vente at time zone 'Africa/Abidjan')::date >= date_trunc('month', v_jour)::date),
    (select max(j.created_at) from public.journal_audit j where j.organisation_id = o.id),
    o.devise::text
  from public.organisations o
  order by o.actif desc, o.nom;
end $$;

-- ---------------------------------------------------------------------
-- Droits d'exécution
-- ---------------------------------------------------------------------
revoke all on function
  public.mes_organisations(),
  public.creer_organisation(text, text, text, text, text, text, text, text),
  public.admin_creer_entreprise(text, text, text, text, text, text, text, text, text),
  public.admin_tableau_de_bord(),
  public.devise_modifiable(uuid)
from public, anon, authenticated;

grant execute on function
  public.mes_organisations(),
  public.creer_organisation(text, text, text, text, text, text, text, text),
  public.admin_creer_entreprise(text, text, text, text, text, text, text, text, text),
  public.admin_tableau_de_bord(),
  public.devise_modifiable(uuid)
to authenticated;

revoke all on function prive.devise_verrouillee(uuid), prive.controle_devise() from public;
