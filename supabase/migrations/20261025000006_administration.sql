-- =====================================================================
-- Migration 006 : administration générale de la plateforme
--   * administrateur général : voit toutes les entreprises (lecture seule),
--     crée les entreprises clientes et l'accès de leur gérant principal,
--     suspend ou réactive une entreprise ;
--   * plateforme fermée par défaut : une fois l'administrateur désigné,
--     seul lui crée des entreprises (sauf s'il ouvre l'inscription libre) ;
--   * contrôles utilisés par la fonction serveur « comptes » (création
--     d'accès avec mot de passe provisoire, réinitialisation).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tables de la plateforme (schéma prive : inaccessibles directement)
-- ---------------------------------------------------------------------

create table prive.admins_generaux (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  ajoute_le  timestamptz not null default now(),
  ajoute_par uuid
);

create table prive.plateforme (
  id                boolean primary key default true check (id),
  inscription_libre boolean not null default false,
  modifie_le        timestamptz not null default now()
);
insert into prive.plateforme default values;

-- Couleur de la marque Le Décodeur Financier (noir), proposée et appliquée par défaut.
alter table public.organisations drop constraint organisations_couleur_check;
alter table public.organisations add constraint organisations_couleur_check
  check (couleur in ('decodeur','foret','ocean','terre','prune','ardoise','nuit'));
alter table public.organisations alter column couleur set default 'decodeur';

-- ---------------------------------------------------------------------
-- Autorisations
-- ---------------------------------------------------------------------

create function prive.est_admin_general() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
     and exists (select 1 from prive.admins_generaux where user_id = auth.uid())
$$;

-- Création d'entreprise : l'administrateur général, ou tout le monde tant
-- qu'aucun administrateur n'est désigné (première installation) ou si
-- l'inscription libre est ouverte.
create function prive.peut_creer_entreprise() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    prive.est_admin_general()
    or not exists (select 1 from prive.admins_generaux)
    or (select inscription_libre from prive.plateforme)
  )
$$;

-- L'administrateur général obtient la CONSULTATION (et l'export) de toute
-- entreprise ; jamais la création, la modification ni la vente.
create or replace function prive.a_permission(p_org uuid, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(prive.permission_du_membre(prive.membre_courant(p_org), p_permission), false)
      or (split_part(p_permission, '.', 2) in ('consulter', 'exporter')
          and prive.est_admin_general()
          and exists (select 1 from public.organisations where id = p_org))
$$;

create or replace function prive.est_membre(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (prive.membre_courant(p_org)).id is not null
      or (prive.est_admin_general() and exists (select 1 from public.organisations where id = p_org))
$$;

create or replace function prive.acces_magasin(p_org uuid, p_magasin uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with m as (select * from prive.membre_courant(p_org))
  select exists (
    select 1 from m
    where m.id is not null
      and (m.role_code = 'proprietaire' or m.tous_magasins
           or exists (select 1 from public.membre_magasins mm
                       where mm.membre_id = m.id and mm.magasin_id = p_magasin))
  ) or (prive.est_admin_general()
        and exists (select 1 from public.magasins where id = p_magasin and organisation_id = p_org))
$$;

-- ---------------------------------------------------------------------
-- Création d'entreprise (libre) : désormais soumise à la règle ci-dessus
-- ---------------------------------------------------------------------

create or replace function public.creer_organisation(
  p_nom text,
  p_ncc text default null,
  p_regime_fiscal text default 'non_precise',
  p_telephone text default null,
  p_adresse text default null,
  p_ville text default null,
  p_nom_magasin text default 'Magasin principal'
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

  insert into public.organisations (nom, ncc, regime_fiscal, telephone, adresse, ville, cree_par)
  values (btrim(p_nom), nullif(btrim(p_ncc), ''), coalesce(p_regime_fiscal, 'non_precise'),
          p_telephone, p_adresse, p_ville, v_uid)
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

-- ---------------------------------------------------------------------
-- Entreprises visibles : celles dont on est membre, plus toutes les autres
-- (en consultation) pour l'administrateur général.
-- ---------------------------------------------------------------------

create or replace function public.mes_organisations()
returns table (
  organisation_id uuid,
  nom text,
  membre_id uuid,
  role_code text,
  role_libelle text,
  tous_magasins boolean,
  permissions text[]
)
language sql stable security definer set search_path = '' as $$
  with miennes as (
    select o.id, o.nom, m.id as membre_id, m.role_code, r.libelle,
           (m.tous_magasins or m.role_code = 'proprietaire') as tous, prive.permissions_effectives(m.id) as droits
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
           array(select p.code from public.permissions p where p.action in ('consulter', 'exporter') order by p.code)
    from public.organisations o
    where prive.est_admin_general() and o.id not in (select id from miennes)
  ) x
  order by 2
$$;

-- ---------------------------------------------------------------------
-- Première installation : le premier compte qui le demande devient
-- administrateur général ; ensuite, seul l'administrateur de la base
-- (éditeur SQL de Supabase) peut en ajouter.
-- ---------------------------------------------------------------------

create function public.plateforme_info() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'admin_existe', exists (select 1 from prive.admins_generaux),
    'inscription_libre', (select inscription_libre from prive.plateforme),
    'je_suis_admin', prive.est_admin_general(),
    'creation_entreprise_possible', prive.peut_creer_entreprise()
  )
$$;

create function public.devenir_admin_general() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.exiger(auth.uid() is not null, 'Connexion requise');
  lock table prive.admins_generaux in exclusive mode;
  perform prive.exiger(not exists (select 1 from prive.admins_generaux),
    'Un administrateur général existe déjà sur cette installation');
  insert into prive.admins_generaux (user_id, ajoute_par) values (auth.uid(), auth.uid());
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
  values (null, auth.uid(), 'plateforme.admin_general', 'utilisateur', auth.uid()::text);
end $$;

-- À exécuter dans l'éditeur SQL de Supabase uniquement (jamais par l'application).
create function public.promouvoir_admin_general(p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(btrim(p_email));
  if v_user is null then
    raise exception 'Aucun compte avec l''adresse %', p_email;
  end if;
  insert into prive.admins_generaux (user_id) values (v_user) on conflict do nothing;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
  values (null, null, 'plateforme.admin_general', 'utilisateur', v_user::text);
end $$;

create function public.admin_definir_inscription_libre(p_libre boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.est_admin_general(), 'Réservé à l''administrateur général');
  update prive.plateforme set inscription_libre = coalesce(p_libre, false), modifie_le = now();
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, apres)
  values (null, auth.uid(), 'plateforme.inscription_libre', 'plateforme', jsonb_build_object('inscription_libre', p_libre));
end $$;

-- ---------------------------------------------------------------------
-- Entreprises clientes
-- ---------------------------------------------------------------------

-- Invite (ou rattache aussitôt s'il a déjà un compte) un gérant principal :
-- rôle propriétaire, tous les magasins.
create function prive.inviter_gerant(p_org uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(p_email));
  v_inv uuid;
  v_user uuid;
begin
  perform prive.exiger(v_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$', 'Adresse e-mail du gérant invalide');
  update public.invitations set statut = 'annulee', traitee_le = now()
   where organisation_id = p_org and email = v_email and statut = 'en_attente';
  insert into public.invitations (organisation_id, email, role_code, tous_magasins, invite_par)
  values (p_org, v_email, 'proprietaire', true, auth.uid())
  returning id into v_inv;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is not null then
    perform prive.accepter_invitation(v_inv, v_user);
  end if;
end $$;

create function public.admin_creer_entreprise(
  p_nom text,
  p_gerant_email text,
  p_ncc text default null,
  p_regime_fiscal text default 'non_precise',
  p_telephone text default null,
  p_adresse text default null,
  p_ville text default null,
  p_nom_magasin text default 'Magasin principal'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_mag uuid;
begin
  perform prive.exiger(prive.est_admin_general(), 'Réservé à l''administrateur général');
  perform prive.exiger(length(btrim(coalesce(p_nom, ''))) >= 2, 'Nom de l''entreprise requis');
  insert into public.organisations (nom, ncc, regime_fiscal, telephone, adresse, ville, cree_par)
  values (btrim(p_nom), nullif(btrim(p_ncc), ''), coalesce(p_regime_fiscal, 'non_precise'),
          nullif(btrim(p_telephone), ''), nullif(btrim(p_adresse), ''), nullif(btrim(p_ville), ''), auth.uid())
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

create function public.admin_ajouter_gerant(p_org uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.est_admin_general(), 'Réservé à l''administrateur général');
  perform prive.exiger(exists (select 1 from public.organisations where id = p_org), 'Entreprise introuvable');
  perform prive.inviter_gerant(p_org, p_email);
end $$;

create function public.admin_suspendre_entreprise(p_org uuid, p_motif text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.est_admin_general(), 'Réservé à l''administrateur général');
  perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Un motif de suspension est obligatoire');
  perform prive.exiger(exists (select 1 from public.organisations where id = p_org and actif),
                       'Entreprise introuvable ou déjà suspendue');
  perform set_config('app.motif', btrim(p_motif), true);
  update public.organisations set actif = false where id = p_org;
  perform set_config('app.motif', '', true);
end $$;

create function public.admin_reactiver_entreprise(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.est_admin_general(), 'Réservé à l''administrateur général');
  perform prive.exiger(exists (select 1 from public.organisations where id = p_org and not actif),
                       'Entreprise introuvable ou déjà active');
  update public.organisations set actif = true where id = p_org;
end $$;

-- Vue d'ensemble de toutes les entreprises (montants en FCFA, jour et mois d'Abidjan).
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
  derniere_activite timestamptz
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
    (select max(j.created_at) from public.journal_audit j where j.organisation_id = o.id)
  from public.organisations o
  order by o.actif desc, o.nom;
end $$;

-- ---------------------------------------------------------------------
-- Contrôles de la fonction serveur « comptes » (appelés avec le jeton de
-- la personne qui agit : c'est la base qui décide).
-- ---------------------------------------------------------------------

-- Créer l'accès d'une personne invitée : administrateur général, ou droit
-- « utilisateurs.creer » dans l'entreprise qui l'a invitée (un propriétaire
-- seulement pour un autre propriétaire).
create function public.controle_creation_compte(p_email text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(p_email));
  v_orgs uuid[];
begin
  if auth.uid() is null then
    return jsonb_build_object('statut', 'refuse', 'message', 'Connexion requise');
  end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then
    return jsonb_build_object('statut', 'existe',
      'message', 'Un compte existe déjà avec cette adresse : la personne se connecte avec son mot de passe ; elle est déjà rattachée.');
  end if;
  select array_agg(distinct i.organisation_id) into v_orgs
  from public.invitations i
  join public.organisations o on o.id = i.organisation_id
  where i.email = v_email and i.statut = 'en_attente'
    and (prive.est_admin_general()
         or (o.actif and prive.a_permission(i.organisation_id, 'utilisateurs.creer')
             and (i.role_code <> 'proprietaire'
                  or (prive.membre_courant(i.organisation_id)).role_code = 'proprietaire')));
  if v_orgs is null then
    return jsonb_build_object('statut', 'refuse',
      'message', 'Invitez d''abord cette personne (avec son rôle) avant de créer son accès');
  end if;
  return jsonb_build_object('statut', 'ok', 'organisations', to_jsonb(v_orgs));
end $$;

-- Réinitialiser le mot de passe : administrateur général (sauf un autre
-- administrateur), ou responsable ayant « utilisateurs.modifier » dans TOUTES
-- les entreprises dont la personne est membre.
create function public.controle_reinitialisation(p_email text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid;
  v_orgs uuid[];
begin
  if auth.uid() is null then
    return jsonb_build_object('statut', 'refuse', 'message', 'Connexion requise');
  end if;
  select id into v_user from auth.users where lower(email) = lower(btrim(p_email));
  if v_user is null then
    return jsonb_build_object('statut', 'refuse', 'message', 'Aucun compte avec cette adresse');
  end if;
  if v_user = auth.uid() then
    return jsonb_build_object('statut', 'refuse', 'message', 'Changez votre propre mot de passe depuis « Mon compte »');
  end if;
  if exists (select 1 from prive.admins_generaux where user_id = v_user) then
    return jsonb_build_object('statut', 'refuse', 'message', 'Le mot de passe d''un administrateur général ne se réinitialise pas ici');
  end if;
  select array_agg(m.organisation_id) into v_orgs from public.membres m where m.user_id = v_user;
  if not prive.est_admin_general() and (
       v_orgs is null
       or exists (select 1 from public.membres t
                  where t.user_id = v_user
                    and not (prive.a_permission(t.organisation_id, 'utilisateurs.modifier')
                             and (prive.membre_courant(t.organisation_id)).id is not null
                             and (t.role_code <> 'proprietaire'
                                  or (prive.membre_courant(t.organisation_id)).role_code = 'proprietaire')))) then
    return jsonb_build_object('statut', 'refuse',
      'message', 'Vous ne pouvez réinitialiser que le mot de passe d''une personne placée sous votre responsabilité');
  end if;
  return jsonb_build_object('statut', 'ok', 'user_id', v_user, 'organisations', coalesce(to_jsonb(v_orgs), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- Droits d'exécution
-- ---------------------------------------------------------------------

revoke all on function
  public.plateforme_info(), public.devenir_admin_general(), public.promouvoir_admin_general(text),
  public.admin_definir_inscription_libre(boolean),
  public.admin_creer_entreprise(text, text, text, text, text, text, text, text),
  public.admin_ajouter_gerant(uuid, text), public.admin_suspendre_entreprise(uuid, text),
  public.admin_reactiver_entreprise(uuid), public.admin_tableau_de_bord(),
  public.controle_creation_compte(text), public.controle_reinitialisation(text)
from public, anon, authenticated;

grant execute on function public.plateforme_info() to anon, authenticated;
grant execute on function
  public.devenir_admin_general(), public.admin_definir_inscription_libre(boolean),
  public.admin_creer_entreprise(text, text, text, text, text, text, text, text),
  public.admin_ajouter_gerant(uuid, text), public.admin_suspendre_entreprise(uuid, text),
  public.admin_reactiver_entreprise(uuid), public.admin_tableau_de_bord(),
  public.controle_creation_compte(text), public.controle_reinitialisation(text)
to authenticated;
-- promouvoir_admin_general : aucun droit pour l'application (éditeur SQL seulement).

revoke all on all functions in schema prive from public;
grant execute on function prive.est_admin_general(), prive.peut_creer_entreprise() to authenticated;
