-- =====================================================================
-- 1.5 : la caisse est ouverte par un responsable, pour une personne précise
-- =====================================================================
-- Règles demandées :
-- * seul un responsable (droit « caisse.valider » : gérant, responsable de caisse,
--   propriétaire) ouvre une caisse, après comptage du fond (billetage), pour
--   lui-même ou pour un caissier ; un caissier ne peut pas ouvrir sa caisse seul ;
-- * on ne vend que dans SA caisse (sessions_caisse.caissier_id) : le gérant ouvre
--   et clôture les autres caisses, mais n'y vend pas et ne les « transfère » pas ;
-- * un caissier ne voit que ses ventes et ses sessions ; le responsable voit
--   toutes les ventes (rapports), mais l'écran de caisse ne montre que sa caisse.

alter table public.sessions_caisse
  add column caissier_id uuid references auth.users(id),
  add column billetage_ouverture jsonb;
update public.sessions_caisse set caissier_id = ouverte_par where caissier_id is null;
create index sessions_caissier_idx on public.sessions_caisse (caissier_id) where statut = 'ouverte';

-- Responsable : voit toutes les ventes de ses magasins.
create function prive.voit_toutes_ventes(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select prive.a_permission(p_org, 'caisse.valider') or prive.a_permission(p_org, 'ventes.valider')
      or prive.a_permission(p_org, 'rapports.consulter') or prive.a_permission(p_org, 'comptabilite.consulter')
$$;

-- Une personne (autre que soi) peut-elle tenir cette caisse ?
create function prive.peut_tenir_caisse(p_org uuid, p_user uuid, p_caisse uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.membres m
    join public.caisses c on c.id = p_caisse and c.organisation_id = p_org and c.actif
    where m.organisation_id = p_org and m.user_id = p_user and m.actif
      and prive.permission_du_membre(m, 'caisse.creer')
      and (m.role_code = 'proprietaire' or m.tous_magasins
           or exists (select 1 from public.membre_magasins mm where mm.membre_id = m.id and mm.magasin_id = c.magasin_id))
      and (m.role_code = 'proprietaire'
           or not exists (select 1 from public.membre_caisses mc where mc.membre_id = m.id)
           or exists (select 1 from public.membre_caisses mc where mc.membre_id = m.id and mc.caisse_id = p_caisse)))
$$;

-- Ouverture : par un responsable, pour une personne, avec le billetage du fond.
drop function public.ouvrir_session(uuid, uuid, bigint);
create function public.ouvrir_session(
  p_org uuid, p_caisse uuid, p_fond bigint default 0, p_caissier uuid default null, p_billetage jsonb default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.caisses;
  v_id uuid;
  v_caissier uuid := coalesce(p_caissier, auth.uid());
  v_fond bigint := coalesce(p_fond, 0);
  v_compte bigint;
  v_nom text;
begin
  select * into c from public.caisses where id = p_caisse and organisation_id = p_org;
  perform prive.exiger(found, 'Caisse introuvable');
  perform prive.exiger(prive.a_permission(p_org, 'caisse.valider'),
    'Seul un responsable (droit « caisse.valider ») ouvre une caisse : adressez-vous au gérant principal');
  perform prive.exiger(prive.acces_magasin(p_org, c.magasin_id) and c.actif, 'Cette caisse ne vous est pas attribuée');
  perform prive.exiger(prive.peut_tenir_caisse(p_org, v_caissier, p_caisse),
    case when v_caissier = auth.uid() then 'Cette caisse ne vous est pas attribuée'
         else 'Cette caisse n''est pas attribuée à cette personne (Utilisateurs → Magasins et caisses)' end);
  perform prive.exiger(v_fond >= 0, 'Fond de caisse invalide');
  if p_billetage is not null then
    select coalesce(sum((e ->> 'valeur')::bigint * (e ->> 'nombre')::bigint), 0) into v_compte
    from jsonb_array_elements(p_billetage) e where coalesce((e ->> 'nombre')::bigint, 0) > 0;
    perform prive.exiger(v_compte = v_fond, format('Le billetage (%s) ne correspond pas au fond saisi (%s)', v_compte, v_fond));
  end if;
  select id into v_id from public.sessions_caisse where caisse_id = p_caisse and statut = 'ouverte';
  perform prive.exiger(v_id is null, 'Cette caisse est déjà ouverte');
  select coalesce(nullif(btrim(nom_complet), ''), 'cette personne') into v_nom from public.profils where id = v_caissier;
  perform prive.exiger(not exists (select 1 from public.sessions_caisse where caissier_id = v_caissier and statut = 'ouverte'
                                     and organisation_id = p_org),
    format('%s tient déjà une autre caisse ouverte : clôturez-la d''abord', coalesce(v_nom, 'Cette personne')));
  insert into public.sessions_caisse (organisation_id, magasin_id, caisse_id, fond_initial, ouverte_par, caissier_id, billetage_ouverture)
  values (p_org, c.magasin_id, p_caisse, v_fond, auth.uid(), v_caissier, p_billetage)
  returning id into v_id;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, apres)
  values (p_org, auth.uid(), 'caisse.ouverture', 'sessions_caisse', v_id::text,
          jsonb_build_object('caisse', c.nom, 'caissier', v_nom, 'fond', v_fond, 'billetage', p_billetage));
  return v_id;
end $$;

-- On ne vend que dans sa propre caisse.
create function prive.tg_vente_caissier() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if auth.uid() is null then return new; end if;
  select caissier_id into v from public.sessions_caisse where id = new.session_id;
  if v is not null and v <> auth.uid() then
    raise exception 'Cette caisse est tenue par une autre personne : vous ne pouvez pas y vendre' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger ventes_caissier before insert on public.ventes
  for each row execute function prive.tg_vente_caissier();

-- « La personne qui tient la caisse » = le caissier de la session (et non celui qui l'a ouverte).
do $$
declare
  f text;
  v_def text;
begin
  foreach f in array array[
    'public.cloturer_session(uuid, bigint, jsonb, text)',
    'public.mouvement_caisse(uuid, text, bigint, text, uuid, uuid, text)',
    'public.historique_clotures(uuid, uuid, integer)'
  ] loop
    v_def := pg_get_functiondef(f::regprocedure);
    if position('s.ouverte_par = auth.uid()' in v_def) = 0 then
      raise exception '% : ancre introuvable', f;
    end if;
    v_def := replace(v_def, 's.ouverte_par = auth.uid()', 's.caissier_id = auth.uid()');
    v_def := replace(v_def, 'pr.id = s.ouverte_par', 'pr.id = s.caissier_id');
    execute v_def;
  end loop;
end $$;

-- Visibilité : un caissier ne voit que ses ventes et ses sessions.
drop policy lecture on public.sessions_caisse;
create policy lecture on public.sessions_caisse for select to authenticated
  using (prive.peut_voir_ventes(organisation_id, magasin_id)
         and (prive.voit_toutes_ventes(organisation_id) or caissier_id = auth.uid() or ouverte_par = auth.uid()));
drop policy lecture on public.ventes;
create policy lecture on public.ventes for select to authenticated
  using (prive.peut_voir_ventes(organisation_id, magasin_id)
         and (prive.voit_toutes_ventes(organisation_id) or caissier_id = auth.uid()));

-- Journal d'une session : réservé à son caissier ou à un responsable.
do $$
declare v_def text := pg_get_functiondef('public.journal_session(uuid)'::regprocedure);
  v_ancre text := 'perform prive.exiger(found and (prive.peut_voir_ventes(s.organisation_id, s.magasin_id)
                                  or prive.acces_caisse(s.organisation_id, s.caisse_id)), ''Session introuvable'');';
begin
  if position(v_ancre in v_def) = 0 then raise exception 'journal_session : ancre introuvable'; end if;
  execute replace(v_def, v_ancre,
    'perform prive.exiger(found and (prive.voit_toutes_ventes(s.organisation_id) or s.caissier_id = auth.uid()), ''Session introuvable'');');
end $$;

-- Les caisses de la personne, avec qui tient chaque caisse ouverte et, pour un responsable,
-- les personnes à qui il peut ouvrir chaque caisse.
create or replace function public.mes_caisses(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_resp boolean := prive.a_permission(p_org, 'caisse.valider');
  v_vend boolean := prive.a_permission(p_org, 'caisse.creer');
begin
  perform prive.exiger(prive.est_membre(p_org), 'Accès refusé');
  return jsonb_build_object(
    'peut_ouvrir', v_resp,
    'peut_vendre', v_vend,
    'responsable', v_resp,
    'caisses', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'code', c.code, 'nom', c.nom, 'magasin_id', c.magasin_id, 'magasin_nom', m.nom,
               'accessible', v_vend and prive.acces_caisse(p_org, c.id),
               'raison', case when not v_vend then 'droit'
                              when not prive.acces_magasin(p_org, c.magasin_id) then 'magasin'
                              when not prive.acces_caisse(p_org, c.id) then 'caisse' end,
               'session', (select jsonb_build_object('id', s.id, 'ouverte_le', s.ouverte_le,
                                                     'mienne', s.caissier_id = auth.uid(),
                                                     'par', coalesce(nullif(btrim(pc.nom_complet), ''), 'un collègue'),
                                                     'ouverte_par', coalesce(nullif(btrim(po.nom_complet), ''), 'un responsable'),
                                                     'fond', s.fond_initial)
                             from public.sessions_caisse s
                             left join public.profils pc on pc.id = s.caissier_id
                             left join public.profils po on po.id = s.ouverte_par
                            where s.caisse_id = c.id and s.statut = 'ouverte' limit 1),
               'caissiers', case when v_resp and prive.acces_magasin(p_org, c.magasin_id) then coalesce((
                   select jsonb_agg(jsonb_build_object('user_id', mb.user_id,
                                                       'nom', coalesce(nullif(btrim(pr.nom_complet), ''), 'Sans nom'),
                                                       'moi', mb.user_id = auth.uid()) order by mb.user_id <> auth.uid(), pr.nom_complet)
                   from public.membres mb left join public.profils pr on pr.id = mb.user_id
                   where mb.organisation_id = p_org and mb.actif and prive.peut_tenir_caisse(p_org, mb.user_id, c.id)), '[]'::jsonb)
                 else '[]'::jsonb end)
             order by c.code)
      from public.caisses c join public.magasins m on m.id = c.magasin_id
      where c.organisation_id = p_org and c.actif
        and (prive.acces_caisse(p_org, c.id) or (v_resp and prive.acces_magasin(p_org, c.magasin_id)))), '[]'::jsonb));
end $$;

revoke all on function prive.voit_toutes_ventes(uuid), prive.peut_tenir_caisse(uuid, uuid, uuid), prive.tg_vente_caissier() from public, anon;
grant execute on function prive.voit_toutes_ventes(uuid), prive.peut_tenir_caisse(uuid, uuid, uuid) to authenticated;
revoke all on function public.ouvrir_session(uuid, uuid, bigint, uuid, jsonb) from public, anon;
grant execute on function public.ouvrir_session(uuid, uuid, bigint, uuid, jsonb) to authenticated;
