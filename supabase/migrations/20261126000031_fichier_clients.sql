-- 3.4 — Fichier clients et créances réunis dans « Crédits clients ».
-- * Client particulier (personne physique) ou entreprise ; pour un particulier, NCC et RCCM
--   seulement s'il en a ; pièce d'identité facultative.
-- * Le gérant (droit ventes.valider) consulte la balance âgée, les relevés et enregistre
--   les créances existantes, sans droit sur la trésorerie.
-- * Exemples de test : clients et crédits marqués « exemple », sans effet sur le stock, la
--   trésorerie ni la comptabilité, supprimables d'un clic.
-- * Bilan : créances clients séparées des autres créances, avec leur ancienneté.

-- ---------------------------------------------------------------------
-- 1. Fichier clients
-- ---------------------------------------------------------------------
alter table public.clients
  add column type_client text not null default 'entreprise' check (type_client in ('particulier','entreprise')),
  add column rccm text check (rccm is null or length(rccm) <= 40),
  add column piece_identite text check (piece_identite is null or length(piece_identite) <= 60),
  add column exemple boolean not null default false;
alter table public.creances add column exemple boolean not null default false;
-- Saisie du fichier clients depuis l'application (le marqueur « exemple » reste réservé au serveur).
grant insert (type_client, rccm, piece_identite) on public.clients to authenticated;
grant update (type_client, rccm, piece_identite) on public.clients to authenticated;
alter table public.credits add column exemple boolean not null default false;

-- ---------------------------------------------------------------------
-- 2. Le gérant lit et tient les créances clients
-- ---------------------------------------------------------------------
do $$
declare
  f text;
  v_def text;
  v_nouv text;
begin
  foreach f in array array['public.balance_agee(uuid,date)', 'public.releve_client(uuid)', 'public.enregistrer_creance(uuid,uuid,bigint,date,date,text,text)',
                           'public.enregistrer_relance(uuid,smallint)'] loop
    v_def := pg_get_functiondef(f::regprocedure);
    v_nouv := regexp_replace(v_def, 'prive\.a_permission\(([a-z_.]+), ''tresorerie\.(consulter|creer)''\)',
                             '(prive.a_permission(\1, ''tresorerie.\2'') or prive.a_permission(\1, ''ventes.valider''))', 'g');
    if v_nouv = v_def then raise exception '% : contrôle de droit introuvable', f; end if;
    execute v_nouv;
  end loop;
  -- Le relevé indique le dossier de crédit de chaque créance.
  v_def := pg_get_functiondef('public.releve_client(uuid)'::regprocedure);
  if position('''reste'', coalesce(r.reste, 0), ''jours_retard''' in v_def) = 0 then raise exception 'releve_client : ancre introuvable'; end if;
  execute replace(v_def, '''reste'', coalesce(r.reste, 0), ''jours_retard''',
                  '''credit_id'', cr.credit_id, ''reste'', coalesce(r.reste, 0), ''jours_retard''');
end $$;

drop policy lecture on public.creances;
create policy lecture on public.creances for select to authenticated
  using (prive.a_permission(organisation_id, 'tresorerie.consulter') or prive.a_permission(organisation_id, 'ventes.valider'));
drop policy lecture on public.relances;
create policy lecture on public.relances for select to authenticated
  using (prive.a_permission(organisation_id, 'tresorerie.consulter') or prive.a_permission(organisation_id, 'ventes.valider'));

-- Balance âgée : type de client, étape de la procédure, exemples signalés.
create or replace function public.balance_agee(p_org uuid, p_au date default current_date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_proc jsonb := prive.procedure_credit(p_org);
begin
  perform prive.exiger(prive.a_permission(p_org, 'tresorerie.consulter') or prive.a_permission(p_org, 'ventes.valider'),
                       'Droit « tresorerie.consulter » ou « ventes.valider » requis');
  return jsonb_build_object('au', p_au, 'procedure', v_proc, 'clients', coalesce((
    select jsonb_agg(to_jsonb(x) || jsonb_build_object('etape', prive.etape_retard(v_proc, x.retard_max)) order by x.total desc) from (
      select cl.id, cl.nom, cl.telephone, cl.plafond_credit, cl.type_client, cl.exemple,
             coalesce(sum(r.reste), 0)::bigint total,
             coalesce(sum(r.reste) filter (where r.jours_retard = 0), 0)::bigint non_echu,
             coalesce(sum(r.reste) filter (where r.jours_retard between 1 and 30), 0)::bigint j30,
             coalesce(sum(r.reste) filter (where r.jours_retard between 31 and 60), 0)::bigint j60,
             coalesce(sum(r.reste) filter (where r.jours_retard between 61 and 90), 0)::bigint j90,
             coalesce(sum(r.reste) filter (where r.jours_retard > 90), 0)::bigint plus90,
             max(r.jours_retard) filter (where r.reste > 0) retard_max,
             count(*) filter (where r.reste > 0) pieces,
             (select max(re.date_relance) from public.relances re where re.client_id = cl.id) derniere_relance,
             (select max(re.niveau) from public.relances re where re.client_id = cl.id
                and re.date_relance > current_date - 60) niveau_relance
      from public.clients cl
      join prive.restes_creances(p_org, p_au) r on r.client_id = cl.id and r.reste > 0
      where cl.organisation_id = p_org
      group by cl.id
    ) x), '[]'::jsonb));
end $$;

-- Situation du fichier clients : encours et retard de chacun (pour la liste des clients).
create function public.fichier_clients(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_proc jsonb := prive.procedure_credit(p_org);
begin
  perform prive.exiger(prive.a_permission(p_org, 'clients.consulter') or prive.a_permission(p_org, 'tresorerie.consulter')
                       or prive.a_permission(p_org, 'ventes.valider'), 'Accès refusé');
  return coalesce((
    select jsonb_agg(to_jsonb(cl) - 'organisation_id' - 'created_at' - 'updated_at'
                     || jsonb_build_object('encours', coalesce(r.encours, 0), 'echu', coalesce(r.echu, 0),
                                           'retard', coalesce(r.retard, 0), 'etape', prive.etape_retard(v_proc, coalesce(r.retard, 0)),
                                           'dossiers', (select count(*) from public.credits c where c.client_id = cl.id and c.statut = 'valide'))
                     order by cl.exemple, cl.nom)
    from public.clients cl
    left join (select client_id, sum(reste) encours, sum(reste) filter (where jours_retard > 0) echu,
                      max(jours_retard) filter (where reste > 0) retard
                 from prive.restes_creances(p_org) group by client_id) r on r.client_id = cl.id
    where cl.organisation_id = p_org), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 3. Les exemples n'entrent ni en comptabilité ni en trésorerie
-- ---------------------------------------------------------------------
do $$
declare
  v_def text := pg_get_functiondef('prive.generer_ecritures(uuid,date)'::regprocedure);
  a1 text := 'where c.organisation_id = p_org and c.statut = ''ouverte'' and c.date_creance >= v_m0 and c.date_creance < v_m1';
  a2 text := 'where e.organisation_id = p_org and e.statut = ''enregistre'' and e.date_encaissement >= v_m0 and e.date_encaissement < v_m1';
begin
  if position(a1 in v_def) = 0 or position(a2 in v_def) = 0 then raise exception 'generer_ecritures : ancre introuvable'; end if;
  v_def := replace(v_def, a1, a1 || ' and not c.exemple and not cl.exemple');
  v_def := replace(v_def, a2, a2 || ' and not cl.exemple');
  execute v_def;
  v_def := pg_get_functiondef('prive.flux_tresorerie(uuid)'::regprocedure);
  a1 := 'from public.encaissements_creances e join public.clients cl on cl.id = e.client_id
  where e.organisation_id = p_org and e.statut = ''enregistre''';
  if position(a1 in v_def) = 0 then raise exception 'flux_tresorerie : ancre introuvable'; end if;
  execute replace(v_def, a1, a1 || ' and not cl.exemple');
end $$;

-- ---------------------------------------------------------------------
-- 4. Exemples de test : créer, supprimer
-- ---------------------------------------------------------------------
create function public.creer_exemples_credits(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_mag uuid;
  v_moi uuid := auth.uid();
  v_proc jsonb;
  cl1 uuid; cl2 uuid; cl3 uuid;
  prods uuid[];
  r record;
  v_credit uuid;
  v_creance uuid;
  v_total bigint;
  n int := 0;
begin
  perform prive.exiger(prive.a_permission(p_org, 'ventes.valider') and prive.a_permission(p_org, 'clients.creer'),
                       'Seul un responsable peut créer des exemples');
  perform prive.exiger(not exists (select 1 from public.clients where organisation_id = p_org and exemple),
                       'Des exemples existent déjà : supprimez-les avant d''en créer d''autres');
  select m.id into v_mag from public.magasins m
   where m.organisation_id = p_org and m.actif and prive.acces_magasin(p_org, m.id) order by m.code limit 1;
  perform prive.exiger(v_mag is not null, 'Aucun magasin accessible');
  select array_agg(id) into prods from (
    select id from public.produits where organisation_id = p_org and statut = 'actif' and prix_vente > 0 order by prix_vente desc limit 4) p;

  insert into public.clients (organisation_id, nom, telephone, adresse, contact, type_client, ncc, rccm, plafond_credit, delai_paiement, note, exemple)
  values (p_org, '[TEST] Restaurant Le Bon Goût', '07 00 00 00 01', 'Abobo Gare', 'M. Konan', 'entreprise', '2400001A', 'CI-ABJ-2024-B-0001', 500000, 30,
          'Client d''exemple pour essayer le module.', true) returning id into cl1;
  insert into public.clients (organisation_id, nom, telephone, adresse, type_client, piece_identite, plafond_credit, delai_paiement, note, exemple)
  values (p_org, '[TEST] Mme Adjoua Tanoh', '05 00 00 00 02', 'Yopougon Sicogi', 'particulier', 'CNI C0000000002', 150000, 15,
          'Cliente d''exemple (particulier sans NCC).', true) returning id into cl2;
  insert into public.clients (organisation_id, nom, telephone, adresse, contact, type_client, ncc, plafond_credit, delai_paiement, note, exemple)
  values (p_org, '[TEST] Maquis Chez Tantie', '01 00 00 00 03', 'Cocody Angré', 'Tantie Awa', 'particulier', '2400003C', 300000, 30,
          'Particulier avec NCC, client d''exemple.', true) returning id into cl3;

  -- Cinq crédits, du « à jour » au « contentieux », sans mouvement de stock.
  for r in select * from (values
      (cl1, -10, 30, 'Livraison hebdomadaire'),
      (cl2, -20, 15, null),
      (cl1, -50, 30, 'Commande de fin de mois'),
      (cl3, -75, 30, null),
      (cl3, -120, 45, 'Ancien crédit, client relancé')) v(client, ecart, duree, note)
  loop
    v_total := 0;
    insert into public.credits (organisation_id, magasin_id, client_id, date_credit, duree_jours, echeance, statut,
                                responsable_id, note, valide_par, valide_le, exemple)
    values (p_org, v_mag, r.client, prive.aujourdhui() + r.ecart, r.duree, prive.aujourdhui() + r.ecart + r.duree, 'valide',
            v_moi, r.note, v_moi, now(), true)
    returning id into v_credit;
    if prods is not null then
      insert into public.credits_lignes (organisation_id, credit_id, produit_id, designation, quantite, prix_unitaire, ordre)
      select p_org, v_credit, p.id, p.designation, 1 + (n + k) % 3, p.prix_vente::bigint, k
        from unnest(prods[1:1 + n % 3]) with ordinality u(pid, k) join public.produits p on p.id = u.pid;
      select coalesce(sum(round(quantite * prix_unitaire)), 0) into v_total from public.credits_lignes where credit_id = v_credit;
    end if;
    if coalesce(v_total, 0) = 0 then v_total := (n + 1) * 45000; end if;
    update public.credits set total = v_total where id = v_credit;
    insert into public.creances (organisation_id, client_id, date_creance, echeance, montant, libelle, piece, credit_id, responsable_id, exemple)
    select p_org, r.client, c.date_credit, c.echeance, v_total, 'Crédit ' || c.numero || ' (exemple)', c.numero, c.id, v_moi, true
      from public.credits c where c.id = v_credit
    returning id into v_creance;
    update public.credits set creance_id = v_creance where id = v_credit;
    n := n + 1;
  end loop;
  -- Une démarche déjà notée sur l'ancien crédit.
  insert into public.credits_suivi (organisation_id, credit_id, action, niveau, note, reste_du, jours_retard)
  select p_org, c.id, 'appel', 0, 'Client appelé : promet de passer à la boutique.', c.total, 30
    from public.credits c where c.organisation_id = p_org and c.exemple and c.client_id = cl3 order by c.date_credit limit 1;
  return jsonb_build_object('clients', 3, 'credits', n);
end $$;

create function public.supprimer_exemples_credits(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform prive.exiger(prive.a_permission(p_org, 'ventes.valider') and prive.a_permission(p_org, 'clients.creer'),
                       'Seul un responsable peut supprimer les exemples');
  select count(*) into n from public.clients where organisation_id = p_org and exemple;
  perform prive.exiger(n > 0, 'Aucun exemple à supprimer');
  perform prive.exiger(not exists (select 1 from public.credits c join public.clients cl on cl.id = c.client_id
                                   where c.organisation_id = p_org and not cl.exemple and c.exemple),
                       'Incohérence : un exemple est rattaché à un vrai client');
  delete from public.credits_suivi s using public.credits c where s.credit_id = c.id and c.organisation_id = p_org and c.exemple;
  delete from public.encaissements_creances e using public.clients cl
   where e.client_id = cl.id and cl.organisation_id = p_org and cl.exemple;
  update public.credits set creance_id = null where organisation_id = p_org and exemple;
  delete from public.creances cr using public.clients cl where cr.client_id = cl.id and cl.organisation_id = p_org and cl.exemple;
  delete from public.credits c using public.clients cl where c.client_id = cl.id and cl.organisation_id = p_org and cl.exemple;
  delete from public.relances re using public.clients cl where re.client_id = cl.id and cl.organisation_id = p_org and cl.exemple;
  delete from public.clients where organisation_id = p_org and exemple;
  return jsonb_build_object('clients', n);
end $$;

-- Un vrai crédit ne peut pas viser un client d'exemple (et inversement) : tout reste séparable.
create function prive.tg_credit_exemple() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.exemple := coalesce((select exemple from public.clients where id = new.client_id), false);
  return new;
end $$;
create trigger credits_exemple before insert on public.credits for each row execute function prive.tg_credit_exemple();
create trigger creances_exemple before insert on public.creances for each row execute function prive.tg_credit_exemple();

-- Un crédit d'exemple accordé ne sort pas de stock : on le refuse plutôt que de toucher au stock réel.
do $$
declare v_def text := pg_get_functiondef('public.valider_credit(uuid,text)'::regprocedure);
  a text := 'perform prive.exiger(c.statut = ''brouillon'', ''Ce dossier est déjà validé ou annulé'');';
begin
  if position(a in v_def) = 0 then raise exception 'valider_credit : ancre introuvable'; end if;
  execute replace(v_def, a, a || '
  perform prive.exiger(not c.exemple, ''Client d''''exemple : utilisez les crédits d''''exemple déjà créés, ou un vrai client'');');
end $$;

-- ---------------------------------------------------------------------
-- 5. Bilan : créances clients et leur ancienneté
-- ---------------------------------------------------------------------
create or replace function public.bilan_simplifie(p_org uuid, p_au date default current_date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s record;
  a_immo bigint := 0; a_stocks bigint := 0; a_clients bigint := 0; a_creances bigint := 0; a_treso bigint := 0;
  p_capitaux bigint := 0; p_resultat bigint := 0; p_dettes_fin bigint := 0; p_fournisseurs bigint := 0;
  p_fiscales bigint := 0; p_autres bigint := 0; p_treso bigint := 0;
  v_agee jsonb;
begin
  perform prive.exiger(prive.a_permission(p_org, 'comptabilite.consulter'), 'Droit « comptabilite.consulter » requis');
  perform prive.generer_periode(p_org, p_au - 730, p_au);
  for s in
    select l.compte, sum(l.debit - l.credit) solde
    from public.ecritures_lignes l join public.ecritures e on e.id = l.ecriture_id
    where l.organisation_id = p_org and e.date_ecriture <= p_au
    group by l.compte having sum(l.debit - l.credit) <> 0
  loop
    if s.compte ~ '^[67]' or s.compte ~ '^8' then p_resultat := p_resultat - s.solde;
    elsif s.compte ~ '^1[0-5]' then p_capitaux := p_capitaux - s.solde;
    elsif s.compte ~ '^1' then p_dettes_fin := p_dettes_fin - s.solde;
    elsif s.compte ~ '^2' then a_immo := a_immo + s.solde;
    elsif s.compte ~ '^3' then a_stocks := a_stocks + s.solde;
    elsif s.compte ~ '^4' then
      if s.solde > 0 and s.compte ~ '^41' then a_clients := a_clients + s.solde;
      elsif s.solde > 0 then a_creances := a_creances + s.solde;
      elsif s.compte ~ '^40' then p_fournisseurs := p_fournisseurs - s.solde;
      elsif s.compte ~ '^4[2-4]' then p_fiscales := p_fiscales - s.solde;
      else p_autres := p_autres - s.solde; end if;
    elsif s.compte ~ '^5' then
      if s.solde > 0 then a_treso := a_treso + s.solde; else p_treso := p_treso - s.solde; end if;
    end if;
  end loop;
  select jsonb_build_object(
           'non_echu', coalesce(sum(r.reste) filter (where r.jours_retard = 0), 0),
           'j30', coalesce(sum(r.reste) filter (where r.jours_retard between 1 and 30), 0),
           'j60', coalesce(sum(r.reste) filter (where r.jours_retard between 31 and 60), 0),
           'j90', coalesce(sum(r.reste) filter (where r.jours_retard between 61 and 90), 0),
           'plus90', coalesce(sum(r.reste) filter (where r.jours_retard > 90), 0),
           'total', coalesce(sum(r.reste), 0),
           'clients', count(distinct r.client_id) filter (where r.reste > 0))
    into v_agee
    from prive.restes_creances(p_org, p_au) r join public.clients cl on cl.id = r.client_id
   where not cl.exemple and r.reste > 0;
  return jsonb_build_object(
    'au', p_au,
    'actif', jsonb_build_object('immobilisations', a_immo, 'stocks', a_stocks, 'creances_clients', a_clients,
                                'creances', a_creances, 'tresorerie', a_treso,
                                'total', a_immo + a_stocks + a_clients + a_creances + a_treso),
    'passif', jsonb_build_object('capitaux_propres', p_capitaux, 'resultat', p_resultat, 'dettes_financieres', p_dettes_fin,
                                 'dettes_fournisseurs', p_fournisseurs, 'dettes_fiscales_sociales', p_fiscales,
                                 'autres_dettes', p_autres, 'tresorerie_passif', p_treso,
                                 'total', p_capitaux + p_resultat + p_dettes_fin + p_fournisseurs + p_fiscales + p_autres + p_treso),
    'balance_agee', v_agee);
end $$;
