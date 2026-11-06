-- =====================================================================
-- 1.6 : le gérant principal ne tient pas de caisse
-- =====================================================================
-- Demande : « Si je suis gérant principal, je ne peux que ouvrir les caisses
-- des autres. Je ne peux pas saisir d'opération, de vente, rien du tout. »
-- * le propriétaire (gérant principal) ne peut tenir aucune caisse ni vendre ;
-- * celui qui ouvre une caisse ne peut pas être celui qui la tient
--   (séparation des tâches : un responsable ne s'ouvre pas sa propre caisse).
-- Les caisses encore ouvertes à son nom se clôturent normalement.

create or replace function prive.peut_tenir_caisse(p_org uuid, p_user uuid, p_caisse uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.membres m
    join public.caisses c on c.id = p_caisse and c.organisation_id = p_org and c.actif
    where m.organisation_id = p_org and m.user_id = p_user and m.actif
      and m.role_code <> 'proprietaire'
      and prive.permission_du_membre(m, 'caisse.creer')
      and (m.tous_magasins
           or exists (select 1 from public.membre_magasins mm where mm.membre_id = m.id and mm.magasin_id = c.magasin_id))
      and (not exists (select 1 from public.membre_caisses mc where mc.membre_id = m.id)
           or exists (select 1 from public.membre_caisses mc where mc.membre_id = m.id and mc.caisse_id = p_caisse)))
$$;

-- Ouverture : jamais pour soi-même.
do $$
declare
  v_def text := pg_get_functiondef('public.ouvrir_session(uuid, uuid, bigint, uuid, jsonb)'::regprocedure);
  v_ancre text := '  perform prive.exiger(v_fond >= 0, ''Fond de caisse invalide'');';
begin
  if position(v_ancre in v_def) = 0 then raise exception 'ouvrir_session : ancre introuvable'; end if;
  execute replace(v_def, v_ancre,
    '  perform prive.exiger(v_caissier <> auth.uid(),
    ''Le gérant principal ne tient pas de caisse : ouvrez-la pour la personne qui va vendre'');
' || v_ancre);
end $$;
-- Message plus clair quand la personne choisie est le gérant principal lui-même.
do $$
declare
  v_def text := pg_get_functiondef('public.ouvrir_session(uuid, uuid, bigint, uuid, jsonb)'::regprocedure);
  v_ancre text := 'case when v_caissier = auth.uid() then ''Cette caisse ne vous est pas attribuée''';
begin
  if position(v_ancre in v_def) = 0 then raise exception 'ouvrir_session (message) : ancre introuvable'; end if;
  execute replace(v_def, v_ancre,
    'case when v_caissier = auth.uid() then ''Le gérant principal ne tient pas de caisse : ouvrez-la pour la personne qui va vendre''');
end $$;

-- Vente : jamais par le gérant principal ; jamais dans la caisse d'un autre.
create or replace function prive.tg_vente_caissier() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if auth.uid() is null then return new; end if;
  if (prive.membre_courant(new.organisation_id)).role_code = 'proprietaire' then
    raise exception 'Le gérant principal ne vend pas : la vente se fait dans la caisse du caissier' using errcode = 'P0001';
  end if;
  select caissier_id into v from public.sessions_caisse where id = new.session_id;
  if v is not null and v <> auth.uid() then
    raise exception 'Cette caisse est tenue par une autre personne : vous ne pouvez pas y vendre' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- mes_caisses : « peut_vendre » faux pour le gérant principal ; il n'apparaît pas parmi les caissiers.
do $$
declare
  v_def text := pg_get_functiondef('public.mes_caisses(uuid)'::regprocedure);
begin
  if position('v_vend boolean := prive.a_permission(p_org, ''caisse.creer'');' in v_def) = 0
     or position('where mb.organisation_id = p_org and mb.actif and prive.peut_tenir_caisse' in v_def) = 0 then
    raise exception 'mes_caisses : ancre introuvable';
  end if;
  v_def := replace(v_def, 'v_vend boolean := prive.a_permission(p_org, ''caisse.creer'');',
    'v_vend boolean := prive.a_permission(p_org, ''caisse.creer'') and coalesce((prive.membre_courant(p_org)).role_code, '''') <> ''proprietaire'';');
  v_def := replace(v_def, 'where mb.organisation_id = p_org and mb.actif and prive.peut_tenir_caisse',
    'where mb.organisation_id = p_org and mb.actif and mb.user_id <> auth.uid() and prive.peut_tenir_caisse');
  execute v_def;
end $$;
