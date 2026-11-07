-- 2.0 — Ouverture et clôture de la journée.
-- La date de la journée est celle du serveur à Abidjan (jamais celle d'un appareil).
-- Le gérant ouvre la journée, puis les caisses ; quand toutes les caisses sont clôturées,
-- il clôture la journée : plus aucune opération (caisse, stock, dépenses, encaissements,
-- paiements, virements, annulations) n'est acceptée jusqu'à la prochaine ouverture.
-- La règle s'applique dès qu'une entreprise a ouvert sa première journée.

create table public.journees (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  date_journee date not null,
  statut text not null default 'ouverte' check (statut in ('ouverte', 'cloturee')),
  ouverte_par uuid references auth.users (id) on delete set null,
  ouverte_le timestamptz not null default now(),
  cloturee_par uuid references auth.users (id) on delete set null,
  cloturee_le timestamptz,
  totaux jsonb,
  unique (organisation_id, date_journee),
  unique (organisation_id, id)
);
create unique index journees_une_ouverte on public.journees (organisation_id) where statut = 'ouverte';
alter table public.journees enable row level security;
create policy lecture on public.journees for select to authenticated using (prive.est_membre(organisation_id));
revoke insert, update, delete on table public.journees from anon, authenticated;

alter table public.sessions_caisse add column if not exists journee_id uuid;
alter table public.sessions_caisse
  add constraint sessions_caisse_journee_fk foreign key (organisation_id, journee_id)
  references public.journees (organisation_id, id);

create function prive.aujourdhui() returns date
language sql stable set search_path = '' as $$ select (now() at time zone 'Africa/Abidjan')::date $$;

-- Garde-fou commun : l'entreprise suit les journées et aucune n'est ouverte → refus.
create function prive.exiger_journee(p_org uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid;
begin
  select id into v_id from public.journees where organisation_id = p_org and statut = 'ouverte';
  if v_id is null and exists (select 1 from public.journees where organisation_id = p_org) then
    raise exception 'La journée est clôturée : le gérant doit ouvrir la journée avant toute nouvelle opération.'
      using errcode = 'P0001';
  end if;
  return v_id;
end $$;

create function prive.tg_exiger_journee() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n jsonb := to_jsonb(new);  -- lecture générique : toutes les tables n'ont pas les mêmes colonnes
begin
  if tg_table_name = 'mouvements_stock' and n ->> 'type' in ('vente', 'retour_client') then
    return new; -- ventes (même synchronisées plus tard) et retours : couverts par la caisse
  end if;
  if tg_table_name = 'ventes' and (n ->> 'statut') is distinct from 'annulee' then
    return new; -- une vente vit dans une session de caisse, elle-même ouverte dans la journée
  end if;
  if tg_op = 'UPDATE' and tg_table_name <> 'ventes' and (n ->> 'statut') is not distinct from (to_jsonb(old) ->> 'statut') then
    return new;
  end if;
  perform prive.exiger_journee(new.organisation_id);
  return new;
end $$;

create trigger journee_operation before insert on public.mouvements_stock
  for each row execute function prive.tg_exiger_journee();
create trigger journee_annulation before update of statut on public.ventes
  for each row execute function prive.tg_exiger_journee();
create trigger journee_operation before insert or update of statut on public.depenses
  for each row execute function prive.tg_exiger_journee();
create trigger journee_operation before insert or update of statut on public.encaissements_creances
  for each row execute function prive.tg_exiger_journee();
create trigger journee_operation before insert or update of statut on public.paiements_fournisseurs
  for each row execute function prive.tg_exiger_journee();
create trigger journee_operation before insert or update of statut on public.virements
  for each row execute function prive.tg_exiger_journee();
create trigger journee_operation before insert or update of statut on public.receptions
  for each row execute function prive.tg_exiger_journee();
create trigger journee_operation before insert or update of statut on public.inventaires
  for each row execute function prive.tg_exiger_journee();
create trigger journee_operation before insert on public.transferts
  for each row execute function prive.tg_exiger_journee();

-- Une caisse ne s'ouvre que dans une journée ouverte, et y reste rattachée.
create function prive.tg_session_journee() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.journee_id := prive.exiger_journee(new.organisation_id);
  return new;
end $$;
create trigger journee_session before insert on public.sessions_caisse
  for each row execute function prive.tg_session_journee();

create function prive.fiche_journee(j public.journees) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', j.id, 'date', j.date_journee, 'statut', j.statut,
    'ouverte_le', j.ouverte_le, 'ouverte_par', (select nom_complet from public.profils where id = j.ouverte_par),
    'cloturee_le', j.cloturee_le, 'cloturee_par', (select nom_complet from public.profils where id = j.cloturee_par),
    'totaux', j.totaux)
$$;

-- État de la journée pour l'écran des caisses.
create function public.ma_journee(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o public.journees;
  d public.journees;
begin
  perform prive.exiger(prive.est_membre(p_org), 'Accès refusé');
  select * into o from public.journees where organisation_id = p_org and statut = 'ouverte';
  select * into d from public.journees where organisation_id = p_org order by date_journee desc limit 1;
  return jsonb_build_object(
    'aujourdhui', prive.aujourdhui(),
    'maintenant', now(),
    'suivie', d.id is not null,
    'ouverte', case when o.id is not null then prive.fiche_journee(o) end,
    'derniere', case when d.id is not null then prive.fiche_journee(d) end,
    'peut_gerer', prive.a_permission(p_org, 'caisse.valider'),
    'peut_rouvrir', (prive.membre_courant(p_org)).role_code = 'proprietaire',
    'caisses_ouvertes', coalesce((
      select jsonb_agg(c.code || ' (' || c.nom || ')' order by c.code)
        from public.sessions_caisse s join public.caisses c on c.id = s.caisse_id
       where s.organisation_id = p_org and s.statut = 'ouverte'), '[]'::jsonb),
    'historique', coalesce((
      select jsonb_agg(prive.fiche_journee(h) order by h.date_journee desc)
        from (select * from public.journees where organisation_id = p_org and statut = 'cloturee'
               order by date_journee desc limit 14) h), '[]'::jsonb));
end $$;

-- Ouvrir la journée d'aujourd'hui (ou la rouvrir, pour le gérant principal, si elle a été clôturée).
create function public.ouvrir_journee(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_jour date := prive.aujourdhui();
  o public.journees;
  j public.journees;
begin
  perform prive.exiger(prive.a_permission(p_org, 'caisse.valider'), 'Seul le gérant ouvre la journée');
  select * into o from public.journees where organisation_id = p_org and statut = 'ouverte' for update;
  if o.id is not null then
    perform prive.exiger(o.date_journee = v_jour,
      'La journée du ' || to_char(o.date_journee, 'DD/MM/YYYY') || ' n''a pas été clôturée : clôturez-la d''abord');
    return prive.fiche_journee(o);
  end if;
  select * into j from public.journees where organisation_id = p_org and date_journee = v_jour for update;
  if j.id is not null then
    perform prive.exiger((prive.membre_courant(p_org)).role_code = 'proprietaire',
      'La journée d''aujourd''hui est déjà clôturée : seul le gérant principal peut la rouvrir');
    update public.journees set statut = 'ouverte', cloturee_le = null, cloturee_par = null, totaux = null
     where id = j.id returning * into j;
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
    values (p_org, auth.uid(), 'journee.reouverte', 'journee', j.id::text);
  else
    insert into public.journees (organisation_id, date_journee, ouverte_par)
    values (p_org, v_jour, auth.uid()) returning * into j;
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
    values (p_org, auth.uid(), 'journee.ouverte', 'journee', j.id::text);
  end if;
  return prive.fiche_journee(j);
end $$;

-- Clôturer la journée ouverte : toutes les caisses doivent être clôturées.
create function public.cloturer_journee(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j public.journees;
  v_ouvertes text;
  v_totaux jsonb;
begin
  perform prive.exiger(prive.a_permission(p_org, 'caisse.valider'), 'Seul le gérant clôture la journée');
  select * into j from public.journees where organisation_id = p_org and statut = 'ouverte' for update;
  perform prive.exiger(j.id is not null, 'Aucune journée ouverte');
  select string_agg(c.code, ', ' order by c.code) into v_ouvertes
    from public.sessions_caisse s join public.caisses c on c.id = s.caisse_id
   where s.organisation_id = p_org and s.statut = 'ouverte';
  perform prive.exiger(v_ouvertes is null, 'Clôturez d''abord les caisses encore ouvertes : ' || coalesce(v_ouvertes, ''));
  with s as (select * from public.sessions_caisse where organisation_id = p_org and journee_id = j.id),
       v as (select v.* from public.ventes v join s on s.id = v.session_id)
  select jsonb_build_object(
    'caisses', (select count(*) from s),
    'nombre_ventes', (select count(*) from v where statut = 'validee'),
    'total_ventes', (select coalesce(sum(total), 0) from v where statut = 'validee'),
    'nombre_annulations', (select count(*) from v where statut = 'annulee'),
    'ecart', (select coalesce(sum(ecart), 0) from s),
    'par_moyen', coalesce((
      select jsonb_agg(jsonb_build_object('libelle', libelle, 'montant', montant) order by montant desc)
        from (select r.libelle, sum(r.montant) montant
                from public.reglements r join v on v.id = r.vente_id and v.statut = 'validee'
               group by r.libelle) m), '[]'::jsonb))
    into v_totaux;
  update public.journees set statut = 'cloturee', cloturee_le = now(), cloturee_par = auth.uid(), totaux = v_totaux
   where id = j.id returning * into j;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, apres)
  values (p_org, auth.uid(), 'journee.cloturee', 'journee', j.id::text, v_totaux);
  return prive.fiche_journee(j);
end $$;

revoke all on function prive.exiger_journee(uuid), prive.fiche_journee(public.journees) from public, anon, authenticated;
revoke all on function public.ma_journee(uuid), public.ouvrir_journee(uuid), public.cloturer_journee(uuid) from public, anon;
grant execute on function public.ma_journee(uuid), public.ouvrir_journee(uuid), public.cloturer_journee(uuid) to authenticated;
