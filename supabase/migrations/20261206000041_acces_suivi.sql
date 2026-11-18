-- v3.14 — Accès réservés (appareils approuvés + clés d'accès personnelles) et suivi exact des commandes en ligne.
--
-- A. Commandes en ligne
--    * Seule la gérante principale (droit « boutique.administrer », propriétaire par défaut) affecte les
--      commandes, ou la personne à qui ELLE a donné le droit « boutique.affecter ».
--    * Chaque manipulation d'une commande (reçue, affectée, acceptée, prête, envoyée, livrée, encaissée,
--      paiement vérifié, annulée…) est inscrite au journal d'audit par un déclencheur : rien ne peut y échapper.
--    * La gérante est prévenue de chacune de ces activités (fil « activites_commandes »).
--
-- B. Accès
--    * Appareils approuvés (réglage de l'entreprise) : une connexion depuis un appareil inconnu reste fermée
--      tant que la gérante principale (ou l'administrateur général) ne l'a pas approuvée, ou que la personne
--      n'a pas saisi une clé d'accès personnelle valide. Le contrôle est fait par la base elle-même
--      (prive.membre_courant), pour chaque lecture et chaque opération.
--    * Clés d'accès personnelles (DFG-XXXX-XX) : à usage unique, avec date d'expiration, annulables ; elles
--      ouvrent la création d'un compte (personne invitée) et/ou un nouvel appareil. Seule l'empreinte est gardée.

-- ============================================================================================
-- A. Affectation réservée à la gérante principale
-- ============================================================================================
create or replace function prive.peut_affecter(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select prive.a_permission(p_org, 'boutique.administrer') or prive.a_permission(p_org, 'boutique.affecter')
$$;

create or replace function public.affecteurs_commandes(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.administrer'), 'Réservé à la gérante principale');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', m.user_id, 'nom', coalesce(nullif(btrim(pr.nom_complet), ''), pr.email, 'Membre'), 'role', m.role_code,
             'gerante', prive.permission_du_membre(m, 'boutique.administrer'),
             'affecteur', prive.permission_du_membre(m, 'boutique.affecter'),
             'moi', m.user_id = auth.uid())
           order by prive.permission_du_membre(m, 'boutique.administrer') desc, coalesce(nullif(btrim(pr.nom_complet), ''), pr.email))
      from public.membres m left join public.profils pr on pr.id = m.user_id
     where m.organisation_id = p_org and m.actif and prive.permission_du_membre(m, 'boutique.consulter')), '[]'::jsonb);
end $$;

create or replace function public.affecteur_definir(p_org uuid, p_user uuid, p_actif boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare m public.membres;
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.administrer'), 'Seule la gérante principale peut désigner qui affecte les commandes');
  select * into m from public.membres where organisation_id = p_org and user_id = p_user and actif;
  perform prive.exiger(found, 'Membre introuvable');
  perform prive.exiger(not prive.permission_du_membre(m, 'boutique.administrer'), 'Cette personne est gérante principale : elle affecte déjà');
  if coalesce(p_actif, false) then
    insert into public.membre_permissions (organisation_id, membre_id, permission_code, accorde)
    values (p_org, m.id, 'boutique.affecter', true)
    on conflict (membre_id, permission_code) do update set accorde = true;
  else
    delete from public.membre_permissions where membre_id = m.id and permission_code = 'boutique.affecter';
  end if;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), case when p_actif then 'boutique.affecteur_ajoute' else 'boutique.affecteur_retire' end,
          'membres', m.id::text,
          jsonb_build_object('user_id', p_user,
                             'nom', (select coalesce(nullif(btrim(nom_complet), ''), email) from public.profils where id = p_user)));
  return public.affecteurs_commandes(p_org);
end $$;

-- Message clair quand quelqu'un d'autre essaie d'affecter.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.affecter_commande_web(uuid,uuid)'::regprocedure);
  if position('found and prive.peut_affecter(c.organisation_id), ''Droit « boutique.valider » requis''' in d) > 0 then
    d := replace(d, 'found and prive.peut_affecter(c.organisation_id), ''Droit « boutique.valider » requis''',
      'found and prive.peut_affecter(c.organisation_id), ''Seule la gérante principale (ou la personne qu''''elle a désignée) affecte les commandes''');
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
  perform prive.exiger(prive.peut_affecter(p_org), 'Seule la gérante principale (ou la personne qu''elle a désignée) affecte les commandes');
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

-- ============================================================================================
-- A bis. Journal systématique de chaque manipulation d'une commande en ligne
-- ============================================================================================
create or replace function prive.nom_de(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(btrim(nom_complet), ''), email) from public.profils where id = p_user
$$;

create or replace function prive.journaliser_commande_web()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  qui uuid := auth.uid();
  base jsonb := jsonb_build_object('numero', new.numero, 'client', new.client_nom, 'mode', new.mode, 'total', new.total,
                                   'par', prive.nom_de(auth.uid()));
  statut_compte boolean := true;
  procedure_action text;
begin
  if tg_op = 'INSERT' then
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
    values (new.organisation_id, qui, 'commande_web.recue', 'commandes_web', new.id::text,
            base || jsonb_build_object('paiement', new.paiement, 'par', 'Client du site'));
    return null;
  end if;

  if new.caissier_id is distinct from old.caissier_id then
    procedure_action := case when old.caissier_id is null then 'commande_web.affectee'
                             when new.caissier_id is null then 'commande_web.desaffectee'
                             else 'commande_web.reaffectee' end;
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, avant, apres, contexte)
    values (new.organisation_id, qui, procedure_action, 'commandes_web', new.id::text,
            jsonb_build_object('caissier_id', old.caissier_id, 'statut', old.statut),
            jsonb_build_object('caissier_id', new.caissier_id, 'statut', new.statut),
            base || jsonb_build_object('caissiere', prive.nom_de(new.caissier_id), 'ancienne', prive.nom_de(old.caissier_id)));
    -- « nouvelle → confirmée » fait partie de l'affectation : pas de ligne en double.
    if old.statut = 'nouvelle' and new.statut = 'confirmee' then statut_compte := false; end if;
  end if;

  if new.prise_en_charge_le is not null and old.prise_en_charge_le is null then
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
    values (new.organisation_id, qui, 'commande_web.acceptee', 'commandes_web', new.id::text,
            base || jsonb_build_object('caissiere', prive.nom_de(new.caissier_id)));
  end if;

  if new.statut is distinct from old.statut and statut_compte then
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, avant, apres, contexte)
    values (new.organisation_id, qui, 'commande_web.' || new.statut, 'commandes_web', new.id::text,
            jsonb_build_object('statut', old.statut), jsonb_build_object('statut', new.statut),
            base || jsonb_build_object('caissiere', prive.nom_de(new.caissier_id), 'motif', new.motif));
  end if;

  if new.paiement_statut is distinct from old.paiement_statut then
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, avant, apres, contexte)
    values (new.organisation_id, qui, 'commande_web.paiement_' || new.paiement_statut, 'commandes_web', new.id::text,
            jsonb_build_object('paiement_statut', old.paiement_statut), jsonb_build_object('paiement_statut', new.paiement_statut),
            base || jsonb_build_object('paiement', new.paiement));
  end if;

  if new.vente_id is not null and old.vente_id is null then
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
    values (new.organisation_id, qui, 'commande_web.encaissee', 'commandes_web', new.id::text,
            base || jsonb_build_object('caissiere', prive.nom_de(new.caissier_id),
                                       'ticket', (select numero from public.ventes where id = new.vente_id),
                                       'encaisse', (select total from public.ventes where id = new.vente_id)));
  end if;
  return null;
end $$;

drop trigger if exists commandes_web_journal on public.commandes_web;
create trigger commandes_web_journal after insert or update on public.commandes_web
  for each row execute function prive.journaliser_commande_web();

-- Fil des activités pour la gérante (et la personne qui affecte) : tout ce qui suit une commande.
create or replace function public.activites_commandes(p_org uuid, p_apres bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_dernier bigint;
begin
  perform prive.exiger(prive.peut_affecter(p_org), 'Réservé à la gérante principale');
  select max(id) into v_dernier from public.journal_audit where organisation_id = p_org and action like 'commande_web.%';
  if p_apres is null then
    return jsonb_build_object('dernier', coalesce(v_dernier, 0), 'evenements', '[]'::jsonb);
  end if;
  return jsonb_build_object('dernier', coalesce(v_dernier, p_apres), 'evenements', coalesce((
    select jsonb_agg(jsonb_build_object('id', j.id, 'action', j.action, 'le', j.created_at, 'objet_id', j.objet_id,
                                        'moi', j.user_id = auth.uid(), 'contexte', j.contexte) order by j.id)
      from (select * from public.journal_audit
             where organisation_id = p_org and action like 'commande_web.%' and id > p_apres
             order by id limit 30) j), '[]'::jsonb));
end $$;

revoke execute on function public.activites_commandes(uuid, bigint) from public, anon;
grant execute on function public.activites_commandes(uuid, bigint) to authenticated;

-- ============================================================================================
-- B. Appareils approuvés
-- ============================================================================================
alter table public.organisations add column if not exists appareils_exiges boolean not null default false;

create table if not exists prive.appareils_acces (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  jeton_hash text not null,
  libelle text,
  statut text not null default 'en_attente' check (statut in ('en_attente', 'approuve', 'refuse', 'revoque')),
  via text check (via in ('gerante', 'cle', 'automatique', 'administrateur')),
  demande_le timestamptz not null default now(),
  decide_par uuid,
  decide_le timestamptz,
  vu_le timestamptz,
  unique (organisation_id, user_id, jeton_hash)
);
create index if not exists appareils_acces_attente on prive.appareils_acces (organisation_id) where statut = 'en_attente';

create table if not exists prive.sessions_approuvees (
  session_id uuid not null,
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  user_id uuid not null,
  appareil_id uuid not null references prive.appareils_acces(id) on delete cascade,
  approuvee_le timestamptz not null default now(),
  primary key (session_id, organisation_id)
);

create or replace function prive.session_courante()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id', '')::uuid
$$;

create or replace function prive.session_approuvee(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from prive.sessions_approuvees s join prive.appareils_acces a on a.id = s.appareil_id
                  where s.session_id = prive.session_courante() and s.organisation_id = p_org
                    and s.user_id = auth.uid() and a.statut = 'approuve')
$$;

-- Le verrou : sans appareil approuvé (quand l'entreprise l'exige), la personne n'est membre de rien.
create or replace function prive.membre_courant(p_org uuid)
returns public.membres
language sql
stable
security definer
set search_path = ''
as $$
  select m.*
  from public.membres m
  join public.organisations o on o.id = m.organisation_id and o.actif
  where m.organisation_id = p_org and m.user_id = auth.uid() and m.actif
    and (not o.appareils_exiges or prive.session_approuvee(p_org))
$$;

-- Qui approuve : la gérante principale (droit « utilisateurs.administrer ») ou l'administrateur général.
create or replace function prive.peut_approuver(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select prive.a_permission(p_org, 'utilisateurs.administrer') or prive.est_admin_general()
$$;

create or replace function prive.hash_jeton(p_jeton text)
returns text
language sql
immutable
set search_path = ''
as $$ select encode(sha256(convert_to(coalesce(p_jeton, ''), 'UTF8')), 'hex') $$;

create or replace function prive.approuver_session(a prive.appareils_acces)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if prive.session_courante() is not null and a.user_id = auth.uid() then
    insert into prive.sessions_approuvees (session_id, organisation_id, user_id, appareil_id)
    values (prive.session_courante(), a.organisation_id, a.user_id, a.id)
    on conflict (session_id, organisation_id) do update set appareil_id = excluded.appareil_id, approuvee_le = now();
  end if;
end $$;

-- Appelé à chaque ouverture de l'application : ouvre la session si l'appareil est approuvé.
create or replace function public.appareil_ouvrir(p_org uuid, p_jeton text, p_libelle text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.membres;
  o public.organisations;
  a prive.appareils_acces;
  h text := prive.hash_jeton(p_jeton);
begin
  perform prive.exiger(length(coalesce(p_jeton, '')) between 32 and 128, 'Jeton d''appareil invalide');
  select * into o from public.organisations where id = p_org and actif;
  select * into m from public.membres where organisation_id = p_org and user_id = auth.uid() and actif;
  if o.id is null or m.id is null then
    return jsonb_build_object('statut', case when prive.est_admin_general() then 'libre' else 'inconnu' end);
  end if;
  select * into a from prive.appareils_acces where organisation_id = p_org and user_id = auth.uid() and jeton_hash = h;
  if a.id is null then
    insert into prive.appareils_acces (organisation_id, user_id, jeton_hash, libelle, statut, via, decide_le)
    values (p_org, auth.uid(), h, left(p_libelle, 120),
            case when o.appareils_exiges then 'en_attente' else 'approuve' end,
            case when o.appareils_exiges then null else 'automatique' end,
            case when o.appareils_exiges then null else now() end)
    returning * into a;
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
    values (p_org, auth.uid(), case when o.appareils_exiges then 'appareil.demande' else 'appareil.enregistre' end,
            'appareils', a.id::text, jsonb_build_object('appareil', a.libelle, 'nom', prive.nom_de(auth.uid())));
  else
    update prive.appareils_acces set vu_le = now(), libelle = coalesce(left(p_libelle, 120), libelle) where id = a.id returning * into a;
  end if;
  if a.statut = 'approuve' then
    perform prive.approuver_session(a);
  end if;
  return jsonb_build_object('statut', case when a.statut = 'approuve' then 'approuve' when not o.appareils_exiges then 'libre' else a.statut end,
                            'exige', o.appareils_exiges, 'appareil_id', a.id, 'demande_le', a.demande_le);
end $$;

-- Liste des appareils (gérante principale / administrateur général).
create or replace function public.appareils_liste(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform prive.exiger(prive.peut_approuver(p_org), 'Réservé à la gérante principale');
  return jsonb_build_object(
    'exige', (select appareils_exiges from public.organisations where id = p_org),
    'session_approuvee', prive.session_approuvee(p_org),
    'appareils', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'user_id', a.user_id, 'nom', prive.nom_de(a.user_id), 'libelle', a.libelle, 'statut', a.statut, 'via', a.via,
        'demande_le', a.demande_le, 'decide_le', a.decide_le, 'decide_par', prive.nom_de(a.decide_par), 'vu_le', a.vu_le,
        'moi', a.user_id = auth.uid(),
        'courant', exists (select 1 from prive.sessions_approuvees s where s.appareil_id = a.id and s.session_id = prive.session_courante()))
        order by (a.statut = 'en_attente') desc, coalesce(a.vu_le, a.demande_le) desc)
      from prive.appareils_acces a where a.organisation_id = p_org), '[]'::jsonb));
end $$;

create or replace function public.appareil_decider(p_id uuid, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare a prive.appareils_acces;
begin
  select * into a from prive.appareils_acces where id = p_id for update;
  perform prive.exiger(found, 'Appareil introuvable');
  perform prive.exiger(prive.peut_approuver(a.organisation_id), 'Réservé à la gérante principale');
  perform prive.exiger(p_decision in ('approuve', 'refuse', 'revoque'), 'Décision inconnue');
  perform prive.exiger(not (p_decision = 'revoque' and exists (select 1 from prive.sessions_approuvees s
                             where s.appareil_id = a.id and s.session_id = prive.session_courante())),
                       'Vous ne pouvez pas retirer l''appareil que vous utilisez en ce moment');
  update prive.appareils_acces
     set statut = p_decision, decide_par = auth.uid(), decide_le = now(),
         via = case when p_decision = 'approuve' then case when prive.est_admin_general() and not prive.a_permission(a.organisation_id, 'utilisateurs.administrer')
                                                           then 'administrateur' else 'gerante' end else via end
   where id = a.id;
  if p_decision <> 'approuve' then
    delete from prive.sessions_approuvees where appareil_id = a.id;
  end if;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (a.organisation_id, auth.uid(), 'appareil.' || case p_decision when 'approuve' then 'approuve' when 'refuse' then 'refuse' else 'revoque' end,
          'appareils', a.id::text, jsonb_build_object('appareil', a.libelle, 'nom', prive.nom_de(a.user_id)));
  return public.appareils_liste(a.organisation_id);
end $$;

-- Activer / désactiver l'exigence (depuis un appareil déjà approuvé, pour ne pas s'enfermer dehors).
create or replace function public.appareils_exiger(p_org uuid, p_exiger boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'utilisateurs.administrer'), 'Réservé à la gérante principale');
  if coalesce(p_exiger, false) then
    perform prive.exiger(prive.session_approuvee(p_org),
      'Ouvrez d''abord DF Gestion sur cet appareil après la mise à jour (il sera reconnu), puis réessayez');
  end if;
  update public.organisations set appareils_exiges = coalesce(p_exiger, false) where id = p_org;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), case when p_exiger then 'appareil.exigence_activee' else 'appareil.exigence_desactivee' end,
          'organisations', p_org::text, '{}'::jsonb);
  return public.appareils_liste(p_org);
end $$;

-- ============================================================================================
-- B bis. Clés d'accès personnelles
-- ============================================================================================
-- organisation_id vide : clé « plateforme » remise par l'administrateur général à un futur gérant
-- (création de compte puis demande d'ouverture d'entreprise).
create table if not exists prive.cles_acces (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid references public.organisations(id) on delete cascade,
  cle_hash text not null unique,
  indice text not null,
  pour_nom text,
  pour_email text,
  user_id uuid,
  cree_par uuid,
  cree_le timestamptz not null default now(),
  expire_le timestamptz not null,
  utilisee_par uuid,
  utilisee_le timestamptz,
  appareil_le timestamptz,
  annulee_par uuid,
  annulee_le timestamptz
);

create table if not exists prive.essais_cles (
  user_id uuid,
  email text,
  le timestamptz not null default now()
);
create index if not exists essais_cles_user on prive.essais_cles (user_id, le);
create index if not exists essais_cles_email on prive.essais_cles (email, le);

create or replace function prive.normaliser_cle(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;

-- Crée une clé ; renvoie la clé en clair UNE seule fois.
create or replace function public.cle_acces_creer(p_org uuid, p_pour_nom text default null, p_pour_email text default null,
                                                 p_user uuid default null, p_jours integer default 7)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  b bytea := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  brut text := '';
  i integer;
  c prive.cles_acces;
  v_email text := nullif(lower(btrim(coalesce(p_pour_email, ''))), '');
begin
  perform prive.exiger(prive.peut_approuver(p_org), 'Réservé à la gérante principale');
  perform prive.exiger(coalesce(p_jours, 7) between 1 and 90, 'Validité : de 1 à 90 jours');
  perform prive.exiger(v_email is null or v_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$', 'Adresse e-mail invalide');
  if p_user is not null then
    perform prive.exiger(exists (select 1 from public.membres where organisation_id = p_org and user_id = p_user and actif), 'Membre introuvable');
  end if;
  for i in 0..5 loop
    brut := brut || substr(alphabet, (get_byte(b, i) % length(alphabet)) + 1, 1);
  end loop;
  insert into prive.cles_acces (organisation_id, cle_hash, indice, pour_nom, pour_email, user_id, cree_par, expire_le)
  values (p_org, prive.hash_jeton('DFG' || brut), right(brut, 2),
          coalesce(nullif(btrim(p_pour_nom), ''), prive.nom_de(p_user), v_email), v_email, p_user, auth.uid(),
          now() + make_interval(days => coalesce(p_jours, 7)))
  returning * into c;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), 'cle_acces.creee', 'cles_acces', c.id::text,
          jsonb_build_object('pour', c.pour_nom, 'email', c.pour_email, 'expire_le', c.expire_le, 'indice', c.indice));
  return jsonb_build_object('id', c.id, 'cle', 'DFG-' || substr(brut, 1, 4) || '-' || substr(brut, 5, 2), 'expire_le', c.expire_le,
                            'pour', c.pour_nom);
end $$;

create or replace function public.cles_acces_liste(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform prive.exiger(prive.peut_approuver(p_org), 'Réservé à la gérante principale');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'indice', c.indice, 'pour', c.pour_nom, 'email', c.pour_email, 'cree_le', c.cree_le, 'cree_par', prive.nom_de(c.cree_par),
      'expire_le', c.expire_le, 'utilisee_le', coalesce(c.utilisee_le, c.appareil_le), 'utilisee_par', prive.nom_de(c.utilisee_par),
      'annulee_le', c.annulee_le, 'annulee_par', prive.nom_de(c.annulee_par),
      'statut', case when c.annulee_le is not null then 'annulee'
                     when c.appareil_le is not null or (c.utilisee_le is not null and c.pour_email is null) then 'utilisee'
                     when c.expire_le < now() then 'expiree'
                     when c.utilisee_le is not null then 'compte_cree'
                     else 'active' end)
      order by c.cree_le desc)
    from prive.cles_acces c where c.organisation_id is not distinct from p_org), '[]'::jsonb);
end $$;

create or replace function public.cle_acces_annuler(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare c prive.cles_acces;
begin
  select * into c from prive.cles_acces where id = p_id for update;
  perform prive.exiger(found, 'Clé introuvable');
  perform prive.exiger(prive.peut_approuver(c.organisation_id), 'Réservé à la gérante principale');
  update prive.cles_acces set annulee_par = auth.uid(), annulee_le = coalesce(annulee_le, now()) where id = c.id;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (c.organisation_id, auth.uid(), 'cle_acces.annulee', 'cles_acces', c.id::text, jsonb_build_object('pour', c.pour_nom, 'indice', c.indice));
  return public.cles_acces_liste(c.organisation_id);
end $$;

-- Ouvrir un nouvel appareil avec une clé personnelle.
create or replace function public.appareil_debloquer(p_org uuid, p_jeton text, p_cle text, p_libelle text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.membres;
  c prive.cles_acces;
  a prive.appareils_acces;
  h text := prive.hash_jeton(p_jeton);
  v_cle text := prive.normaliser_cle(p_cle);
begin
  select * into m from public.membres where organisation_id = p_org and user_id = auth.uid() and actif;
  perform prive.exiger(found, 'Vous n''êtes pas membre de cette entreprise');
  perform prive.exiger((select count(*) from prive.essais_cles where user_id = auth.uid() and le > now() - interval '1 hour') < 5,
                       'Trop d''essais : réessayez dans une heure ou demandez à la gérante d''approuver l''appareil');
  select * into c from prive.cles_acces
   where organisation_id = p_org and cle_hash = prive.hash_jeton(v_cle) for update;
  if c.id is null or c.annulee_le is not null or c.expire_le < now() or c.appareil_le is not null
     or not (coalesce(c.user_id, c.utilisee_par, auth.uid()) = auth.uid())
     or (c.pour_email is not null and c.pour_email <> lower((select email from auth.users where id = auth.uid()))
         and coalesce(c.user_id, c.utilisee_par) is distinct from auth.uid()) then
    insert into prive.essais_cles (user_id) values (auth.uid());
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, contexte)
    values (p_org, auth.uid(), 'cle_acces.refusee', 'cles_acces', jsonb_build_object('appareil', left(p_libelle, 120)));
    -- L'essai raté doit rester compté : on ne lève pas d'erreur (qui annulerait l'enregistrement).
    return jsonb_build_object('statut', 'cle_invalide',
                              'message', 'Clé invalide, expirée, déjà utilisée ou destinée à une autre personne');
  end if;
  insert into prive.appareils_acces (organisation_id, user_id, jeton_hash, libelle, statut, via, decide_par, decide_le)
  values (p_org, auth.uid(), h, left(p_libelle, 120), 'approuve', 'cle', auth.uid(), now())
  on conflict (organisation_id, user_id, jeton_hash) do update
    set statut = 'approuve', via = 'cle', decide_par = auth.uid(), decide_le = now(), vu_le = now()
  returning * into a;
  update prive.cles_acces set appareil_le = now(), utilisee_par = coalesce(utilisee_par, auth.uid()),
                              utilisee_le = coalesce(utilisee_le, now()), user_id = coalesce(user_id, auth.uid())
   where id = c.id;
  perform prive.approuver_session(a);
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (p_org, auth.uid(), 'appareil.approuve_par_cle', 'appareils', a.id::text,
          jsonb_build_object('appareil', a.libelle, 'nom', prive.nom_de(auth.uid()), 'indice', c.indice));
  return jsonb_build_object('statut', 'approuve');
end $$;

-- Création de compte (fonction « inscription », clé de service seulement) : une clé est exigée
-- dès que l'inscription libre est fermée.
create or replace function public.cle_inscription_verifier(p_cle text, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c prive.cles_acces;
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not exists (select 1 from prive.admins_generaux) or (select inscription_libre from prive.plateforme) then
    return jsonb_build_object('ok', true);
  end if;
  if (select count(*) from prive.essais_cles where email = v_email and le > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('ok', false, 'message', 'Trop d''essais : réessayez dans une heure.');
  end if;
  select * into c from prive.cles_acces where cle_hash = prive.hash_jeton(prive.normaliser_cle(p_cle));
  if c.id is null or c.annulee_le is not null or c.expire_le < now() or c.utilisee_le is not null
     or (c.pour_email is not null and c.pour_email <> v_email) or c.user_id is not null then
    insert into prive.essais_cles (email) values (v_email);
    return jsonb_build_object('ok', false, 'message',
      'Clé d''accès invalide, expirée ou déjà utilisée. Demandez votre clé personnelle à la gérante.');
  end if;
  return jsonb_build_object('ok', true, 'cle_id', c.id);
end $$;

create or replace function public.cle_inscription_utiliser(p_cle_id uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare c prive.cles_acces;
begin
  update prive.cles_acces set utilisee_par = p_user, utilisee_le = now()
   where id = p_cle_id and utilisee_le is null returning * into c;
  if c.id is not null then
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
    values (c.organisation_id, p_user, 'cle_acces.compte_cree', 'cles_acces', c.id::text,
            jsonb_build_object('pour', c.pour_nom, 'email', c.pour_email, 'indice', c.indice));
  end if;
end $$;

revoke execute on function public.cle_inscription_verifier(text, text), public.cle_inscription_utiliser(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cle_inscription_verifier(text, text), public.cle_inscription_utiliser(uuid, uuid) to service_role;

revoke execute on function public.appareil_ouvrir(uuid, text, text), public.appareils_liste(uuid), public.appareil_decider(uuid, text),
  public.appareils_exiger(uuid, boolean), public.cle_acces_creer(uuid, text, text, uuid, integer), public.cles_acces_liste(uuid),
  public.cle_acces_annuler(uuid), public.appareil_debloquer(uuid, text, text, text) from public, anon;
grant execute on function public.appareil_ouvrir(uuid, text, text), public.appareils_liste(uuid), public.appareil_decider(uuid, text),
  public.appareils_exiger(uuid, boolean), public.cle_acces_creer(uuid, text, text, uuid, integer), public.cles_acces_liste(uuid),
  public.cle_acces_annuler(uuid), public.appareil_debloquer(uuid, text, text, text) to authenticated;

-- ============================================================================================
-- C. Alertes : « à affecter » pour la gérante principale (ou la personne désignée),
--    appareils en attente pour la gérante principale.
-- ============================================================================================
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
               prive.permission_du_membre(m, 'boutique.administrer') or prive.permission_du_membre(m, 'boutique.affecter') affecteur,
               prive.permission_du_membre(m, 'utilisateurs.administrer') approbatrice from m),
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
    'appareils_en_attente', case when d.approbatrice then
        (select count(*) from prive.appareils_acces a where a.organisation_id = p_org and a.statut = 'en_attente') else 0 end,
    'appareils_liste', case when d.approbatrice then coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'nom', prive.nom_de(a.user_id), 'libelle', a.libelle, 'demande_le', a.demande_le) order by a.demande_le)
        from prive.appareils_acces a where a.organisation_id = p_org and a.statut = 'en_attente'), '[]'::jsonb) else '[]'::jsonb end,
    'derniere', (select max(created_at) from c where c.statut = 'nouvelle'),
    'derniere_affectation', (select max(affectee_le) from c where c.caissier_id = p_user),
    'derniere_prete', case when d.gerante then (select max(prete_le) from c where c.mode = 'livraison' and c.statut = 'prete') end)
    from d where d.consulte or d.approbatrice),
    jsonb_build_object('nombre', 0, 'a_affecter', 0, 'en_attente', 0, 'a_accepter', 0, 'a_accepter_liste', '[]'::jsonb,
                       'a_livrer', 0, 'gerante', false, 'affecteur', false, 'appareils_en_attente', 0, 'appareils_liste', '[]'::jsonb))
$$;

-- Les compteurs ne sont donnés qu'à un membre dont la session est ouverte (appareil approuvé si exigé).
create or replace function public.commandes_caisse_attente(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when (prive.membre_courant(p_org)).id is not null then prive.attente_pour(p_org, auth.uid()) end
$$;
