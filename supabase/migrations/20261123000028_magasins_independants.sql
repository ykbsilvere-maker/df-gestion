-- 3.0 — Gestion indépendante de chaque magasin, avec une vue d'ensemble de l'entreprise.
-- Chaque compte de trésorerie et chaque dépense peut être rattaché à un magasin
-- (sans magasin = commun à l'entreprise : siège, banque partagée…).

alter table public.comptes_tresorerie add column magasin_id uuid;
alter table public.comptes_tresorerie add constraint comptes_tresorerie_magasin_fk
  foreign key (organisation_id, magasin_id) references public.magasins (organisation_id, id);
alter table public.depenses add column magasin_id uuid;
alter table public.depenses add constraint depenses_magasin_fk
  foreign key (organisation_id, magasin_id) references public.magasins (organisation_id, id);
create index depenses_magasin_idx on public.depenses (organisation_id, magasin_id, date_depense);

-- Existant : le compte d'une caisse appartient au magasin de cette caisse ; une dépense suit son compte.
update public.comptes_tresorerie c set magasin_id = k.magasin_id
  from public.caisses k where k.id = c.caisse_id and c.magasin_id is null;
update public.depenses d set magasin_id = c.magasin_id
  from public.comptes_tresorerie c where c.id = d.compte_id and d.magasin_id is null and c.magasin_id is not null;

create function prive.tg_compte_magasin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.magasin_id is null and new.caisse_id is not null then
    new.magasin_id := (select magasin_id from public.caisses where id = new.caisse_id);
  end if;
  return new;
end $$;
create trigger compte_magasin before insert on public.comptes_tresorerie
  for each row execute function prive.tg_compte_magasin();

create function prive.tg_depense_magasin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.magasin_id is null then
    new.magasin_id := (select magasin_id from public.comptes_tresorerie where id = new.compte_id);
  end if;
  return new;
end $$;
create trigger depense_magasin before insert on public.depenses
  for each row execute function prive.tg_depense_magasin();

-- Rattacher un compte à un magasin (null = commun). Ses dépenses non rattachées le suivent.
create function public.rattacher_compte(p_compte uuid, p_magasin uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.comptes_tresorerie;
begin
  select * into c from public.comptes_tresorerie where id = p_compte;
  perform prive.exiger(found and prive.a_permission(c.organisation_id, 'tresorerie.modifier'), 'Droit « tresorerie.modifier » requis');
  perform prive.exiger(c.caisse_id is null, 'Le compte d''une caisse suit le magasin de sa caisse');
  perform prive.exiger(p_magasin is null or exists (select 1 from public.magasins where id = p_magasin and organisation_id = c.organisation_id),
                       'Magasin inconnu');
  update public.comptes_tresorerie set magasin_id = p_magasin, updated_at = now() where id = p_compte;
  update public.depenses set magasin_id = p_magasin
   where compte_id = p_compte and magasin_id is not distinct from c.magasin_id;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, apres)
  values (c.organisation_id, auth.uid(), 'compte.rattache', 'compte', p_compte::text,
          jsonb_build_object('nom', c.nom, 'magasin', (select nom from public.magasins where id = p_magasin)));
end $$;

-- Corriger le magasin d'une dépense (null = charge commune).
create function public.rattacher_depense(p_depense uuid, p_magasin uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.depenses;
begin
  select * into d from public.depenses where id = p_depense;
  perform prive.exiger(found and prive.a_permission(d.organisation_id, 'tresorerie.modifier'), 'Droit « tresorerie.modifier » requis');
  perform prive.exiger(p_magasin is null or exists (select 1 from public.magasins where id = p_magasin and organisation_id = d.organisation_id),
                       'Magasin inconnu');
  update public.depenses set magasin_id = p_magasin where id = p_depense;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, apres)
  values (d.organisation_id, auth.uid(), 'depense.rattachee', 'depense', p_depense::text,
          jsonb_build_object('libelle', d.libelle, 'magasin', (select nom from public.magasins where id = p_magasin)));
end $$;

-- Vue d'ensemble : les magasins côte à côte pour un mois, les charges communes et le total.
create function public.vue_ensemble(p_org uuid, p_mois date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_jour date := prive.aujourdhui();
  v_mois date := date_trunc('month', coalesce(p_mois, prive.aujourdhui()))::date;
  v_fin date := (date_trunc('month', coalesce(p_mois, prive.aujourdhui())) + interval '1 month')::date;
  v_magasins jsonb;
  v_commun bigint;
begin
  perform prive.exiger(prive.a_permission(p_org, 'rentabilite.consulter'), 'Droit « rentabilite.consulter » requis');
  with m as (
    select g.id, g.nom from public.magasins g
     where g.organisation_id = p_org and g.actif and prive.acces_magasin(p_org, g.id)
  ), v as (
    select v.magasin_id, (v.date_vente at time zone 'Africa/Abidjan')::date jour, v.total,
           coalesce((select sum(l.quantite * coalesce(l.cout_unitaire, 0)) from public.ventes_lignes l where l.vente_id = v.id), 0) cout
      from public.ventes v
     where v.organisation_id = p_org and v.statut = 'validee'
       and v.date_vente >= (v_mois::timestamp at time zone 'Africa/Abidjan')
       and v.date_vente < (v_fin::timestamp at time zone 'Africa/Abidjan')
  ), lignes as (
    select m.id, m.nom,
      coalesce((select sum(total) from v where v.magasin_id = m.id and v.jour = v_jour), 0) ventes_jour,
      (select count(*) from v where v.magasin_id = m.id and v.jour = v_jour) tickets_jour,
      coalesce((select sum(total) from v where v.magasin_id = m.id), 0) ventes_mois,
      (select count(*) from v where v.magasin_id = m.id) tickets_mois,
      coalesce((select round(sum(cout)) from v where v.magasin_id = m.id), 0)::bigint cout_ventes,
      coalesce((select sum(d.montant) from public.depenses d
                 where d.organisation_id = p_org and d.magasin_id = m.id and d.statut = 'enregistree'
                   and d.date_depense >= v_mois and d.date_depense < v_fin), 0) charges,
      coalesce((select round(sum(s.quantite * s.cout_moyen)) from public.stocks s where s.magasin_id = m.id and s.quantite > 0), 0)::bigint valeur_stock,
      (select count(*) from public.stocks s join public.produits p on p.id = s.produit_id
        where s.magasin_id = m.id and p.statut = 'actif' and (s.quantite <= 0 or (p.seuil_min is not null and s.quantite <= p.seuil_min))) ruptures,
      coalesce((select sum(sc.ecart) from public.sessions_caisse sc
                 where sc.magasin_id = m.id and sc.cloturee_le >= (v_mois::timestamp at time zone 'Africa/Abidjan')
                   and sc.cloturee_le < (v_fin::timestamp at time zone 'Africa/Abidjan')), 0) ecarts,
      (select count(*) from public.sessions_caisse sc where sc.magasin_id = m.id and sc.statut = 'ouverte') caisses_ouvertes
    from m
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'nom', nom, 'ventes_jour', ventes_jour, 'tickets_jour', tickets_jour,
           'ventes_mois', ventes_mois, 'tickets_mois', tickets_mois, 'cout_ventes', cout_ventes,
           'marge', ventes_mois - cout_ventes, 'charges', charges, 'resultat', ventes_mois - cout_ventes - charges,
           'valeur_stock', valeur_stock, 'ruptures', ruptures, 'ecarts', ecarts, 'caisses_ouvertes', caisses_ouvertes)
           order by ventes_mois desc, nom), '[]'::jsonb)
    into v_magasins from lignes;
  -- Charges communes (sans magasin) : visibles de ceux qui voient toute l'entreprise.
  select coalesce(sum(d.montant), 0) into v_commun from public.depenses d
   where d.organisation_id = p_org and d.magasin_id is null and d.statut = 'enregistree'
     and d.date_depense >= v_mois and d.date_depense < v_fin
     and ((prive.membre_courant(p_org)).role_code = 'proprietaire' or (prive.membre_courant(p_org)).tous_magasins);
  return jsonb_build_object('mois', v_mois, 'aujourdhui', v_jour, 'magasins', v_magasins, 'charges_communes', v_commun);
end $$;

revoke all on function public.rattacher_compte(uuid, uuid), public.rattacher_depense(uuid, uuid), public.vue_ensemble(uuid, date) from public, anon;
grant execute on function public.rattacher_compte(uuid, uuid), public.rattacher_depense(uuid, uuid), public.vue_ensemble(uuid, date) to authenticated;
