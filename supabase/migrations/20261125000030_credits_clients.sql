-- 3.3 — Crédits clients structurés.
-- * Un dossier de crédit liste les articles remis au client ; la durée de paiement
--   et la date d'échéance se déduisent l'une de l'autre.
-- * Le responsable confie le suivi du dossier à une caissière (ou le garde) :
--   elle voit ses dossiers, encaisse à sa caisse, relance et note les démarches.
-- * Une procédure de recouvrement par paliers de retard (relance amiable, seconde
--   relance, mise en demeure, contentieux) guide le suivi et peut bloquer les
--   nouveaux crédits d'un client trop en retard.
-- * La validation sort les articles du stock et crée la créance (411 / 701 en
--   comptabilité, comme toute vente à crédit).

-- ---------------------------------------------------------------------
-- 1. Procédure de recouvrement de l'entreprise
-- ---------------------------------------------------------------------

create table public.procedures_credit (
  organisation_id uuid primary key references public.organisations(id),
  jours_rappel    smallint not null default 3 check (jours_rappel between 0 and 30),
  palier_1        smallint not null default 1,
  palier_2        smallint not null default 15,
  palier_3        smallint not null default 30,
  palier_4        smallint not null default 60,
  blocage_palier  smallint not null default 3 check (blocage_palier between 1 and 5), -- 5 : jamais bloquer
  updated_at      timestamptz not null default now(),
  check (palier_1 >= 1 and palier_1 < palier_2 and palier_2 < palier_3 and palier_3 < palier_4 and palier_4 <= 365)
);

-- Paramètres en vigueur (ceux de l'entreprise, sinon les valeurs par défaut).
create function prive.procedure_credit(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.procedures_credit;
begin
  select * into p from public.procedures_credit where organisation_id = p_org;
  if not found then
    p.organisation_id := p_org; p.jours_rappel := 3; p.palier_1 := 1; p.palier_2 := 15;
    p.palier_3 := 30; p.palier_4 := 60; p.blocage_palier := 3;
  end if;
  return jsonb_build_object('jours_rappel', p.jours_rappel, 'palier_1', p.palier_1, 'palier_2', p.palier_2,
                            'palier_3', p.palier_3, 'palier_4', p.palier_4, 'blocage_palier', p.blocage_palier);
end $$;

-- Étape de la procédure pour un retard donné : 0 = à jour, 1 à 4 = paliers franchis.
create function prive.etape_retard(p_proc jsonb, p_jours int) returns smallint
language sql immutable set search_path = '' as $$
  select case
    when coalesce(p_jours, 0) >= (p_proc ->> 'palier_4')::int then 4
    when coalesce(p_jours, 0) >= (p_proc ->> 'palier_3')::int then 3
    when coalesce(p_jours, 0) >= (p_proc ->> 'palier_2')::int then 2
    when coalesce(p_jours, 0) >= (p_proc ->> 'palier_1')::int then 1
    else 0 end::smallint
$$;

-- ---------------------------------------------------------------------
-- 2. Dossiers de crédit et leurs articles
-- ---------------------------------------------------------------------

create table public.credits (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations(id),
  magasin_id       uuid not null,
  numero           text,
  client_id        uuid not null,
  date_credit      date not null default prive.aujourdhui(),
  duree_jours      smallint not null default 30 check (duree_jours between 0 and 365),
  echeance         date not null,
  total            bigint not null default 0 check (total >= 0),
  total_remises    bigint not null default 0 check (total_remises >= 0),
  statut           text not null default 'brouillon' check (statut in ('brouillon','valide','annule')),
  responsable_id   uuid references auth.users(id),
  note             text check (note is null or length(note) <= 500),
  motif_exception  text check (motif_exception is null or length(motif_exception) <= 300),
  creance_id       uuid references public.creances(id),
  cree_par         uuid default auth.uid(),
  valide_par       uuid,
  valide_le        timestamptz,
  annule_par       uuid,
  annule_le        timestamptz,
  motif_annulation text check (motif_annulation is null or length(motif_annulation) <= 300),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, numero),
  check (echeance = date_credit + duree_jours),
  foreign key (organisation_id, magasin_id) references public.magasins(organisation_id, id),
  foreign key (organisation_id, client_id) references public.clients(organisation_id, id)
);
create index credits_client_idx on public.credits (organisation_id, client_id);
create index credits_responsable_idx on public.credits (organisation_id, responsable_id) where statut = 'valide';

create table public.credits_lignes (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  credit_id       uuid not null references public.credits(id) on delete cascade,
  produit_id      uuid not null,
  designation     text not null check (length(btrim(designation)) between 1 and 160),
  quantite        numeric(14,3) not null check (quantite > 0),
  prix_unitaire   bigint not null check (prix_unitaire >= 0),
  remise          bigint not null default 0 check (remise >= 0),
  cout_unitaire   numeric(14,4),
  ordre           smallint not null default 0,
  foreign key (organisation_id, produit_id) references public.produits(organisation_id, id)
);
create index credits_lignes_credit_idx on public.credits_lignes (credit_id, ordre);

-- Numéro lisible : CR-000001.
create function prive.tg_numero_credit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.numero is null then
    new.numero := 'CR-' || lpad(prive.prochain_numero(new.organisation_id, 'credit')::text, 6, '0');
  end if;
  return new;
end $$;
create trigger credits_numero before insert on public.credits
  for each row execute function prive.tg_numero_credit();

-- Lien de la créance (et de son responsable) vers le dossier ; encaissement fait à une caisse.
alter table public.creances add column credit_id uuid references public.credits(id);
alter table public.creances add column responsable_id uuid references auth.users(id);
alter table public.encaissements_creances add column session_id uuid references public.sessions_caisse(id);
create index encaissements_session_idx on public.encaissements_creances (session_id) where session_id is not null;

-- Les relances vont désormais jusqu'au contentieux (palier 4).
alter table public.relances drop constraint if exists relances_niveau_check;
alter table public.relances add constraint relances_niveau_check check (niveau between 1 and 4);

-- Journal du suivi : lettres, appels, visites, promesses de paiement…
create table public.credits_suivi (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  credit_id       uuid not null references public.credits(id),
  action          text not null check (action in ('rappel','relance','appel','visite','message','promesse','note')),
  niveau          smallint not null default 0 check (niveau between 0 and 4),
  note            text check (note is null or length(note) <= 500),
  date_promesse   date,
  montant_promis  bigint check (montant_promis is null or montant_promis > 0),
  reste_du        bigint not null default 0,
  jours_retard    int not null default 0,
  cree_par        uuid default auth.uid(),
  created_at      timestamptz not null default now()
);
create index credits_suivi_credit_idx on public.credits_suivi (credit_id, created_at desc);

-- ---------------------------------------------------------------------
-- 3. Règles d'accès
-- ---------------------------------------------------------------------

-- Voit tous les dossiers : la trésorerie ou les responsables des ventes.
create function prive.voit_tous_credits(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select prive.a_permission(p_org, 'tresorerie.consulter') or prive.a_permission(p_org, 'ventes.valider')
$$;

-- Accès à un dossier : tout voir (et le magasin), ou en être le responsable du suivi.
create function prive.acces_credit(c public.credits) returns boolean
language sql stable security definer set search_path = '' as $$
  select prive.est_membre(c.organisation_id)
     and ((prive.voit_tous_credits(c.organisation_id) and prive.acces_magasin(c.organisation_id, c.magasin_id))
          or (c.responsable_id = auth.uid() and c.statut = 'valide'))
$$;

-- Une personne peut suivre un dossier : membre actif ayant accès au magasin.
create function prive.peut_suivre(p_org uuid, p_magasin uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.membres m
    where m.organisation_id = p_org and m.user_id = p_user and m.actif
      and (m.role_code = 'proprietaire' or m.tous_magasins
           or exists (select 1 from public.membre_magasins mm where mm.membre_id = m.id and mm.magasin_id = p_magasin)))
$$;

alter table public.procedures_credit enable row level security;
alter table public.credits enable row level security;
alter table public.credits_lignes enable row level security;
alter table public.credits_suivi enable row level security;
create policy lecture on public.procedures_credit for select to authenticated using (prive.est_membre(organisation_id));
create policy lecture on public.credits for select to authenticated using (prive.acces_credit(credits));
create policy lecture on public.credits_lignes for select to authenticated
  using (exists (select 1 from public.credits c where c.id = credit_id));
create policy lecture on public.credits_suivi for select to authenticated
  using (exists (select 1 from public.credits c where c.id = credit_id));
revoke all on public.procedures_credit, public.credits, public.credits_lignes, public.credits_suivi from anon, authenticated;
grant select on public.procedures_credit, public.credits, public.credits_lignes, public.credits_suivi to authenticated;

do $$
declare t text;
begin
  execute 'create trigger credits_updated_at before update on public.credits
           for each row execute function prive.tg_maj_updated_at()';
  foreach t in array array['procedures_credit','credits','credits_suivi'] loop
    execute format('create trigger %I after insert or update or delete on public.%I
                    for each row execute function prive.tg_audit()', t || '_audit', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Procédure : lecture et réglage
-- ---------------------------------------------------------------------

create function public.procedure_credit(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.est_membre(p_org), 'Accès refusé');
  return prive.procedure_credit(p_org);
end $$;

create function public.regler_procedure_credit(p_org uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v1 int := (p ->> 'palier_1')::int;
  v2 int := (p ->> 'palier_2')::int;
  v3 int := (p ->> 'palier_3')::int;
  v4 int := (p ->> 'palier_4')::int;
begin
  perform prive.exiger(prive.a_permission(p_org, 'ventes.valider') and prive.a_permission(p_org, 'clients.modifier'),
                       'Seul un responsable peut régler la procédure de recouvrement');
  perform prive.exiger(v1 >= 1 and v1 < v2 and v2 < v3 and v3 < v4 and v4 <= 365,
                       'Les paliers doivent se suivre : 1re relance < 2e relance < mise en demeure < contentieux (365 jours au plus)');
  insert into public.procedures_credit (organisation_id, jours_rappel, palier_1, palier_2, palier_3, palier_4, blocage_palier)
  values (p_org, coalesce((p ->> 'jours_rappel')::int, 3), v1, v2, v3, v4, coalesce((p ->> 'blocage_palier')::int, 3))
  on conflict (organisation_id) do update
     set jours_rappel = excluded.jours_rappel, palier_1 = excluded.palier_1, palier_2 = excluded.palier_2,
         palier_3 = excluded.palier_3, palier_4 = excluded.palier_4, blocage_palier = excluded.blocage_palier,
         updated_at = now();
  return prive.procedure_credit(p_org);
end $$;

-- Personnes à qui confier le suivi d'un dossier du magasin.
create function public.personnes_suivi_credit(p_org uuid, p_magasin uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'ventes.valider'), 'Accès refusé');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', m.user_id, 'nom', coalesce(nullif(btrim(pr.nom_complet), ''), pr.email, 'Sans nom'),
                                        'role', r.libelle) order by (m.user_id = auth.uid()) desc, r.ordre, pr.nom_complet)
    from public.membres m
    join public.roles r on r.code = m.role_code
    left join public.profils pr on pr.id = m.user_id
    where m.organisation_id = p_org and m.actif
      and m.role_code in ('proprietaire','gerant_magasin','responsable_caisse','caissier','vendeur','comptable')
      and prive.peut_suivre(p_org, p_magasin, m.user_id)), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 5. Préparer, valider, confier, annuler un dossier
-- ---------------------------------------------------------------------

-- Enregistre (crée ou remplace) un dossier en brouillon avec ses articles.
-- p : { id?, organisation_id, magasin_id, client_id, duree_jours?, echeance?, responsable_id?, note?,
--       lignes: [{ produit_id, quantite, prix_unitaire?, remise? }] }
-- La durée et l'échéance se déduisent l'une de l'autre ; l'échéance choisie l'emporte.
create function public.enregistrer_credit(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (p ->> 'organisation_id')::uuid;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_mag uuid := (p ->> 'magasin_id')::uuid;
  v_client uuid := (p ->> 'client_id')::uuid;
  v_date date := prive.aujourdhui();
  v_duree int;
  v_resp uuid := coalesce(nullif(p ->> 'responsable_id', '')::uuid, auth.uid());
  cl public.clients;
  c public.credits;
  l jsonb;
  pr public.produits;
  v_q numeric;
  v_prix bigint;
  v_remise bigint;
  v_ordre int := 0;
begin
  perform prive.exiger(prive.a_permission(v_org, 'ventes.valider'), 'Seul un responsable peut préparer un crédit');
  perform prive.exiger(v_mag is not null and prive.acces_magasin(v_org, v_mag), 'Magasin non autorisé');
  select * into cl from public.clients where id = v_client and organisation_id = v_org;
  perform prive.exiger(found, 'Choisissez le client');
  perform prive.exiger(cl.actif, 'Ce client est désactivé');
  perform prive.exiger(jsonb_typeof(p -> 'lignes') = 'array' and jsonb_array_length(p -> 'lignes') > 0,
                       'Ajoutez au moins un article');

  v_duree := coalesce((nullif(p ->> 'echeance', '')::date - v_date), nullif(p ->> 'duree_jours', '')::int, cl.delai_paiement);
  perform prive.exiger(v_duree between 0 and 365, 'La durée de paiement va de 0 à 365 jours (échéance à partir d''aujourd''hui)');
  perform prive.exiger(prive.peut_suivre(v_org, v_mag, v_resp), 'La personne chargée du suivi doit avoir accès à ce magasin');

  if v_id is null then
    insert into public.credits (organisation_id, magasin_id, client_id, date_credit, duree_jours, echeance, responsable_id, note)
    values (v_org, v_mag, v_client, v_date, v_duree, v_date + v_duree, v_resp, nullif(btrim(p ->> 'note'), ''))
    returning * into c;
  else
    select * into c from public.credits where id = v_id and organisation_id = v_org for update;
    perform prive.exiger(found, 'Dossier introuvable');
    perform prive.exiger(c.statut = 'brouillon', 'Ce dossier est déjà validé : il ne se modifie plus');
    perform prive.exiger(prive.acces_magasin(v_org, c.magasin_id), 'Magasin non autorisé');
    update public.credits
       set magasin_id = v_mag, client_id = v_client, date_credit = v_date, duree_jours = v_duree, echeance = v_date + v_duree,
           responsable_id = v_resp, note = nullif(btrim(p ->> 'note'), '')
     where id = c.id returning * into c;
    delete from public.credits_lignes where credit_id = c.id;
  end if;

  for l in select * from jsonb_array_elements(p -> 'lignes') loop
    select * into pr from public.produits where id = (l ->> 'produit_id')::uuid and organisation_id = v_org;
    perform prive.exiger(found, 'Article introuvable');
    v_q := (l ->> 'quantite')::numeric;
    perform prive.exiger(v_q > 0, format('Quantité invalide pour « %s »', pr.designation));
    v_prix := coalesce(nullif(l ->> 'prix_unitaire', '')::bigint, pr.prix_vente::bigint);
    v_remise := coalesce(nullif(l ->> 'remise', '')::bigint, 0);
    perform prive.exiger(v_prix >= 0 and v_remise >= 0 and v_remise <= round(v_q * v_prix),
                         format('Prix ou remise invalide pour « %s »', pr.designation));
    insert into public.credits_lignes (organisation_id, credit_id, produit_id, designation, quantite, prix_unitaire, remise, ordre)
    values (v_org, c.id, pr.id, pr.designation, v_q, v_prix, v_remise, v_ordre);
    v_ordre := v_ordre + 1;
  end loop;

  update public.credits
     set total = (select coalesce(sum(round(quantite * prix_unitaire) - remise), 0) from public.credits_lignes where credit_id = c.id),
         total_remises = (select coalesce(sum(remise), 0) from public.credits_lignes where credit_id = c.id)
   where id = c.id;
  return c.id;
end $$;

-- Sortie de stock d'un article remis à crédit (lots à péremption la plus proche d'abord).
create function prive.sortir_stock_credit(p_org uuid, p_magasin uuid, p_produit uuid, p_quantite numeric, p_credit uuid)
returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  reste numeric := p_quantite;
  l record;
  prise numeric;
  m public.mouvements_stock;
  valeur_totale numeric := 0;
begin
  for l in
    select sl.lot_id, sl.quantite from public.stocks_lots sl join public.lots lo on lo.id = sl.lot_id
    where sl.magasin_id = p_magasin and sl.produit_id = p_produit and sl.quantite > 0
    order by lo.date_peremption nulls last, lo.created_at
    for update of sl
  loop
    exit when reste <= 0;
    prise := least(reste, l.quantite);
    insert into public.mouvements_stock (organisation_id, magasin_id, produit_id, lot_id, type, quantite, piece_type, piece_id, motif)
    values (p_org, p_magasin, p_produit, l.lot_id, 'vente', -prise, 'credit', p_credit, 'Vente à crédit') returning * into m;
    valeur_totale := valeur_totale + m.cout_unitaire * prise;
    reste := reste - prise;
  end loop;
  if reste > 0 then
    insert into public.mouvements_stock (organisation_id, magasin_id, produit_id, type, quantite, piece_type, piece_id, motif)
    values (p_org, p_magasin, p_produit, 'vente', -reste, 'credit', p_credit, 'Vente à crédit') returning * into m;
    valeur_totale := valeur_totale + m.cout_unitaire * reste;
  end if;
  return round(valeur_totale / p_quantite, 4);
end $$;

-- Valide un dossier : contrôle du plafond et des retards, sortie du stock, créance ouverte.
-- Un dépassement du plafond ou un client bloqué par la procédure exige un motif.
create function public.valider_credit(p_credit uuid, p_motif text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.credits;
  cl public.clients;
  v_proc jsonb;
  v_encours bigint;
  v_retard int;
  v_etape smallint;
  v_motif text := nullif(btrim(coalesce(p_motif, '')), '');
  v_creance uuid;
  v_duree int;
  r record;
  v_dispo numeric;
  v_cout numeric;
  n int;
begin
  select * into c from public.credits where id = p_credit for update;
  perform prive.exiger(found, 'Dossier introuvable');
  perform prive.exiger(prive.a_permission(c.organisation_id, 'ventes.valider') and prive.acces_magasin(c.organisation_id, c.magasin_id),
                       'Seul un responsable peut accorder un crédit');
  perform prive.exiger(c.statut = 'brouillon', 'Ce dossier est déjà validé ou annulé');
  perform prive.exiger_journee(c.organisation_id);
  select count(*) into n from public.credits_lignes where credit_id = c.id;
  perform prive.exiger(n > 0 and c.total > 0, 'Le dossier ne contient aucun article à facturer');
  select * into cl from public.clients where id = c.client_id;
  perform prive.exiger(cl.actif, 'Ce client est désactivé');

  -- L'échéance choisie est gardée ; la durée est recalculée depuis aujourd'hui.
  v_duree := c.echeance - prive.aujourdhui();
  perform prive.exiger(v_duree >= 0, 'L''échéance est déjà passée : choisissez une nouvelle date de paiement');

  v_proc := prive.procedure_credit(c.organisation_id);
  select coalesce(sum(reste), 0), coalesce(max(jours_retard) filter (where reste > 0), 0)
    into v_encours, v_retard
    from prive.restes_creances(c.organisation_id) where client_id = c.client_id;
  if cl.plafond_credit is not null and v_encours + c.total > cl.plafond_credit then
    perform prive.exiger(length(coalesce(v_motif, '')) >= 3,
      format('Plafond dépassé : le client doit déjà %s F ; avec ce crédit (%s F) il devrait %s F pour un plafond de %s F. '
             'Indiquez un motif pour accorder quand même.', v_encours, c.total, v_encours + c.total, cl.plafond_credit));
  end if;
  v_etape := prive.etape_retard(v_proc, v_retard);
  if v_etape > 0 and v_etape >= (v_proc ->> 'blocage_palier')::int then
    perform prive.exiger(length(coalesce(v_motif, '')) >= 3,
      format('Ce client a %s jours de retard de paiement : la procédure bloque les nouveaux crédits. '
             'Indiquez un motif pour accorder quand même.', v_retard));
  end if;

  -- Stock disponible dans le magasin, article par article.
  for r in
    select l.produit_id, max(l.designation) designation, sum(l.quantite) quantite
    from public.credits_lignes l where l.credit_id = c.id group by l.produit_id
  loop
    select coalesce((select quantite from public.stocks where magasin_id = c.magasin_id and produit_id = r.produit_id), 0)
      into v_dispo;
    perform prive.exiger(v_dispo >= r.quantite,
      format('Stock insuffisant pour « %s » : %s disponible(s), %s demandé(s)', r.designation, trim_scale(v_dispo), trim_scale(r.quantite)));
  end loop;
  for r in select * from public.credits_lignes where credit_id = c.id order by ordre loop
    v_cout := prive.sortir_stock_credit(c.organisation_id, c.magasin_id, r.produit_id, r.quantite, c.id);
    update public.credits_lignes set cout_unitaire = v_cout where id = r.id;
  end loop;

  insert into public.creances (organisation_id, client_id, date_creance, echeance, montant, libelle, piece, credit_id, responsable_id)
  values (c.organisation_id, c.client_id, prive.aujourdhui(), c.echeance, c.total,
          'Crédit ' || c.numero || ' · ' || n || case when n > 1 then ' articles' else ' article' end,
          c.numero, c.id, c.responsable_id)
  returning id into v_creance;

  update public.credits
     set statut = 'valide', date_credit = prive.aujourdhui(), duree_jours = v_duree, valide_par = auth.uid(), valide_le = now(),
         creance_id = v_creance, motif_exception = v_motif
   where id = c.id;
  return jsonb_build_object('numero', c.numero, 'creance_id', v_creance, 'echeance', c.echeance, 'total', c.total);
end $$;

-- Confie (ou reprend) le suivi d'un dossier.
create function public.confier_credit(p_credit uuid, p_responsable uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.credits;
begin
  select * into c from public.credits where id = p_credit for update;
  perform prive.exiger(found, 'Dossier introuvable');
  perform prive.exiger(prive.a_permission(c.organisation_id, 'ventes.valider') and prive.acces_magasin(c.organisation_id, c.magasin_id),
                       'Seul un responsable peut confier un dossier');
  perform prive.exiger(c.statut <> 'annule', 'Dossier annulé');
  perform prive.exiger(p_responsable is not null and prive.peut_suivre(c.organisation_id, c.magasin_id, p_responsable),
                       'Cette personne n''a pas accès à ce magasin');
  update public.credits set responsable_id = p_responsable where id = c.id;
  if c.creance_id is not null then
    update public.creances set responsable_id = p_responsable where id = c.creance_id;
  end if;
end $$;

-- Annule un dossier. Validé : seulement sans règlement ; les articles reviennent en stock.
create function public.annuler_credit(p_credit uuid, p_motif text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.credits;
  r record;
begin
  select * into c from public.credits where id = p_credit for update;
  perform prive.exiger(found, 'Dossier introuvable');
  perform prive.exiger(c.statut <> 'annule', 'Dossier déjà annulé');
  perform prive.exiger(prive.acces_magasin(c.organisation_id, c.magasin_id)
                       and prive.a_permission(c.organisation_id, case when c.statut = 'brouillon' then 'ventes.valider' else 'ventes.annuler' end),
                       'Droit d''annulation requis');
  perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Un motif est obligatoire');
  if c.statut = 'valide' then
    perform prive.exiger_journee(c.organisation_id);
    perform prive.exiger(not exists (select 1 from public.encaissements_creances
                                     where creance_id = c.creance_id and statut = 'enregistre'),
                         'Des règlements ont été reçus : annulez-les d''abord');
    for r in select * from public.credits_lignes where credit_id = c.id loop
      insert into public.mouvements_stock (organisation_id, magasin_id, produit_id, type, quantite, cout_unitaire,
                                           piece_type, piece_id, motif)
      values (c.organisation_id, c.magasin_id, r.produit_id, 'retour_client', r.quantite, coalesce(r.cout_unitaire, 0),
              'credit', c.id, 'Annulation du crédit ' || c.numero);
    end loop;
    perform set_config('app.motif', btrim(p_motif), true);
    update public.creances set statut = 'annulee', motif_annulation = btrim(p_motif) where id = c.creance_id;
  end if;
  perform set_config('app.motif', btrim(p_motif), true);
  update public.credits set statut = 'annule', annule_par = auth.uid(), annule_le = now(), motif_annulation = btrim(p_motif)
   where id = c.id;
  perform set_config('app.motif', '', true);
end $$;

-- ---------------------------------------------------------------------
-- 6. Encaisser et suivre
-- ---------------------------------------------------------------------

-- Règlement d'un dossier. À la caisse (p_session) : espèces dans le tiroir, autres moyens sur
-- leur compte. Hors caisse : réservé à la trésorerie, sur le compte choisi.
create function public.encaisser_credit(
  p_credit uuid, p_montant bigint, p_moyen uuid default null, p_session uuid default null,
  p_compte uuid default null, p_reference text default null, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.credits;
  s public.sessions_caisse;
  mp public.moyens_paiement;
  v_reste bigint;
  v_compte uuid;
  v_id uuid;
begin
  select * into c from public.credits where id = p_credit;
  perform prive.exiger(found and prive.acces_credit(c), 'Dossier introuvable');
  perform prive.exiger(c.statut = 'valide', 'Ce dossier n''est pas un crédit en cours');
  perform prive.exiger(prive.a_permission(c.organisation_id, 'tresorerie.creer') or c.responsable_id = auth.uid(),
                       'Seule la personne chargée du suivi ou la trésorerie peut encaisser ce crédit');
  select reste into v_reste from prive.restes_creances(c.organisation_id) where creance_id = c.creance_id;
  perform prive.exiger(coalesce(v_reste, 0) > 0, 'Ce crédit est déjà soldé');
  perform prive.exiger(coalesce(p_montant, 0) > 0, 'Montant invalide');
  perform prive.exiger(p_montant <= v_reste, format('Le reste dû sur ce crédit est de %s F', v_reste));
  if p_moyen is not null then
    select * into mp from public.moyens_paiement where id = p_moyen and organisation_id = c.organisation_id and actif;
    perform prive.exiger(found, 'Moyen de paiement inconnu');
    perform prive.exiger(not mp.reference_obligatoire or length(btrim(coalesce(p_reference, ''))) > 0,
                         format('Indiquez la référence de la transaction %s', mp.libelle));
  end if;

  if p_session is not null then
    select * into s from public.sessions_caisse where id = p_session;
    perform prive.exiger(found and s.organisation_id = c.organisation_id, 'Caisse introuvable');
    perform prive.exiger(s.statut = 'ouverte', 'La caisse est clôturée');
    perform prive.exiger(coalesce(s.caissier_id, s.ouverte_par) = auth.uid() or prive.a_permission(c.organisation_id, 'caisse.cloturer'),
                         'Encaissez à votre propre caisse');
    perform prive.exiger(mp.id is not null, 'Choisissez le moyen de paiement');
    v_compte := case when mp.nature = 'especes' then prive.compte_tiroir(c.organisation_id, s.caisse_id) else mp.compte_id end;
    perform prive.exiger(v_compte is not null, format('Aucun compte de trésorerie n''est rattaché à %s', mp.libelle));
  else
    perform prive.exiger(prive.a_permission(c.organisation_id, 'tresorerie.creer'),
                         'Encaissez ce crédit depuis votre caisse ouverte');
    v_compte := coalesce(p_compte, mp.compte_id);
    perform prive.exiger(exists (select 1 from public.comptes_tresorerie where id = v_compte and organisation_id = c.organisation_id and actif),
                         'Choisissez le compte qui reçoit l''argent');
  end if;

  insert into public.encaissements_creances (organisation_id, client_id, creance_id, date_encaissement, montant, compte_id,
                                             reference, note, session_id)
  values (c.organisation_id, c.client_id, c.creance_id, prive.aujourdhui(), p_montant, v_compte,
          nullif(btrim(p_reference), ''), coalesce(nullif(btrim(p_note), ''), 'Crédit ' || c.numero), s.id)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'reste', v_reste - p_montant, 'numero', c.numero);
end $$;

-- Note une démarche de suivi. Une relance (niveau 1 à 4) est aussi inscrite au compte du client.
create function public.suivre_credit(
  p_credit uuid, p_action text, p_niveau smallint default 0, p_note text default null,
  p_date_promesse date default null, p_montant_promis bigint default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.credits;
  v_reste bigint;
  v_retard int;
  v_du bigint;
  v_echu bigint;
begin
  select * into c from public.credits where id = p_credit;
  perform prive.exiger(found and prive.acces_credit(c), 'Dossier introuvable');
  perform prive.exiger(c.statut = 'valide', 'Ce dossier n''est pas un crédit en cours');
  perform prive.exiger(prive.a_permission(c.organisation_id, 'tresorerie.creer') or prive.a_permission(c.organisation_id, 'ventes.valider')
                       or c.responsable_id = auth.uid(), 'Seule la personne chargée du suivi peut noter une démarche');
  perform prive.exiger(p_action in ('rappel','relance','appel','visite','message','promesse','note'), 'Démarche inconnue');
  perform prive.exiger(p_action <> 'relance' or coalesce(p_niveau, 0) between 1 and 4, 'Niveau de relance : 1 à 4');
  perform prive.exiger(p_action <> 'promesse' or p_date_promesse >= prive.aujourdhui(), 'Indiquez la date promise (aujourd''hui ou plus tard)');
  select reste, jours_retard into v_reste, v_retard from prive.restes_creances(c.organisation_id) where creance_id = c.creance_id;
  insert into public.credits_suivi (organisation_id, credit_id, action, niveau, note, date_promesse, montant_promis, reste_du, jours_retard)
  values (c.organisation_id, c.id, p_action, case when p_action = 'relance' then p_niveau else 0 end,
          nullif(btrim(p_note), ''), case when p_action = 'promesse' then p_date_promesse end,
          case when p_action = 'promesse' then p_montant_promis end, coalesce(v_reste, 0), coalesce(v_retard, 0));
  if p_action = 'relance' then
    select coalesce(sum(reste), 0), coalesce(sum(reste) filter (where jours_retard > 0), 0) into v_du, v_echu
      from prive.restes_creances(c.organisation_id) where client_id = c.client_id;
    insert into public.relances (organisation_id, client_id, niveau, montant_du, montant_echu)
    values (c.organisation_id, c.client_id, p_niveau, v_du, v_echu);
  end if;
  return jsonb_build_object('reste', coalesce(v_reste, 0), 'jours_retard', coalesce(v_retard, 0));
end $$;

-- ---------------------------------------------------------------------
-- 7. Lecture : liste et fiche d'un dossier
-- ---------------------------------------------------------------------

create function prive.etat_credit(c public.credits, p_proc jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  with r as (select reste, jours_retard from prive.restes_creances(c.organisation_id) where creance_id = c.creance_id),
       d as (select action, niveau, created_at, date_promesse from public.credits_suivi
              where credit_id = c.id order by created_at desc limit 1)
  select jsonb_build_object(
    'reste', case when c.statut = 'valide' then coalesce((select reste from r), 0) else c.total end,
    'paye', case when c.statut = 'valide' then c.total - coalesce((select reste from r), 0) else 0 end,
    'jours_retard', case when c.statut = 'valide' and coalesce((select reste from r), 0) > 0
                         then coalesce((select jours_retard from r), 0) else 0 end,
    'jours_restants', c.echeance - prive.aujourdhui(),
    'etape', case when c.statut = 'valide' and coalesce((select reste from r), 0) > 0
                  then prive.etape_retard(p_proc, (select jours_retard from r)) else 0 end,
    'derniere_action', (select to_jsonb(d) from d),
    'promesse', (select max(date_promesse) from public.credits_suivi s
                  where s.credit_id = c.id and s.action = 'promesse' and s.date_promesse >= prive.aujourdhui()))
$$;

create function public.credits_liste(p_org uuid, p_magasin uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_proc jsonb := prive.procedure_credit(p_org);
begin
  perform prive.exiger(prive.est_membre(p_org), 'Accès refusé');
  return jsonb_build_object(
    'procedure', v_proc,
    'tout_voir', prive.voit_tous_credits(p_org),
    'dossiers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'numero', c.numero, 'statut', c.statut, 'client_id', c.client_id, 'client', cl.nom,
               'telephone', cl.telephone, 'magasin', mg.nom, 'magasin_id', c.magasin_id, 'date_credit', c.date_credit,
               'duree_jours', c.duree_jours, 'echeance', c.echeance, 'total', c.total,
               'responsable_id', c.responsable_id,
               'responsable', coalesce(nullif(btrim(pr.nom_complet), ''), pr.email),
               'articles', (select count(*) from public.credits_lignes l where l.credit_id = c.id),
               'moi', c.responsable_id = auth.uid()) || prive.etat_credit(c, v_proc)
             order by (c.statut = 'brouillon') desc, c.echeance, c.created_at)
      from public.credits c
      join public.clients cl on cl.id = c.client_id
      join public.magasins mg on mg.id = c.magasin_id
      left join public.profils pr on pr.id = c.responsable_id
      where c.organisation_id = p_org and c.statut <> 'annule'
        and (p_magasin is null or c.magasin_id = p_magasin)
        and prive.acces_credit(c)), '[]'::jsonb));
end $$;

create function public.credit_detail(p_credit uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.credits;
  v_proc jsonb;
begin
  select * into c from public.credits where id = p_credit;
  perform prive.exiger(found and prive.acces_credit(c), 'Dossier introuvable');
  v_proc := prive.procedure_credit(c.organisation_id);
  return jsonb_build_object(
    'dossier', to_jsonb(c) || prive.etat_credit(c, v_proc)
               || jsonb_build_object('magasin', (select nom from public.magasins where id = c.magasin_id),
                                     'responsable', (select coalesce(nullif(btrim(nom_complet), ''), email) from public.profils where id = c.responsable_id),
                                     'cree_par_nom', (select coalesce(nullif(btrim(nom_complet), ''), email) from public.profils where id = c.cree_par),
                                     'moi', c.responsable_id = auth.uid()),
    'client', (select jsonb_build_object('id', cl.id, 'nom', cl.nom, 'telephone', cl.telephone, 'email', cl.email,
                                         'adresse', cl.adresse, 'contact', cl.contact, 'ncc', cl.ncc,
                                         'plafond_credit', cl.plafond_credit, 'delai_paiement', cl.delai_paiement,
                                         'encours', (select coalesce(sum(reste), 0) from prive.restes_creances(c.organisation_id) where client_id = cl.id))
               from public.clients cl where cl.id = c.client_id),
    'procedure', v_proc,
    'lignes', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'produit_id', l.produit_id, 'designation', l.designation,
                                                            'quantite', l.quantite, 'prix_unitaire', l.prix_unitaire, 'remise', l.remise,
                                                            'montant', round(l.quantite * l.prix_unitaire) - l.remise) order by l.ordre)
                        from public.credits_lignes l where l.credit_id = c.id), '[]'::jsonb),
    'encaissements', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'date', e.date_encaissement, 'montant', e.montant,
                                                                   'compte', ct.nom, 'reference', e.reference, 'statut', e.statut,
                                                                   'a_la_caisse', e.session_id is not null,
                                                                   'par', (select coalesce(nullif(btrim(nom_complet), ''), email) from public.profils where id = e.cree_par))
                                                order by e.created_at desc)
                               from public.encaissements_creances e join public.comptes_tresorerie ct on ct.id = e.compte_id
                               where c.creance_id is not null and e.creance_id = c.creance_id), '[]'::jsonb),
    'suivi', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'action', s.action, 'niveau', s.niveau, 'note', s.note,
                                                           'date_promesse', s.date_promesse, 'montant_promis', s.montant_promis,
                                                           'reste_du', s.reste_du, 'jours_retard', s.jours_retard, 'le', s.created_at,
                                                           'par', (select coalesce(nullif(btrim(nom_complet), ''), email) from public.profils where id = s.cree_par))
                                        order by s.created_at desc)
                       from public.credits_suivi s where s.credit_id = c.id), '[]'::jsonb));
end $$;

-- Situation d'un client au moment d'accorder un crédit : encours, retard, plafond, blocage.
create function public.situation_client_credit(p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  cl public.clients;
  v_proc jsonb;
  v_encours bigint;
  v_echu bigint;
  v_retard int;
  v_etape smallint;
begin
  select * into cl from public.clients where id = p_client;
  perform prive.exiger(found and (prive.a_permission(cl.organisation_id, 'ventes.valider')
                                  or prive.a_permission(cl.organisation_id, 'tresorerie.consulter')), 'Client introuvable');
  v_proc := prive.procedure_credit(cl.organisation_id);
  select coalesce(sum(reste), 0), coalesce(sum(reste) filter (where jours_retard > 0), 0),
         coalesce(max(jours_retard) filter (where reste > 0), 0)
    into v_encours, v_echu, v_retard
    from prive.restes_creances(cl.organisation_id) where client_id = cl.id;
  v_etape := prive.etape_retard(v_proc, v_retard);
  return jsonb_build_object('plafond', cl.plafond_credit, 'delai', cl.delai_paiement, 'encours', v_encours, 'echu', v_echu,
                            'retard', v_retard, 'etape', v_etape,
                            'bloque', v_etape > 0 and v_etape >= (v_proc ->> 'blocage_palier')::int,
                            'disponible', case when cl.plafond_credit is null then null else greatest(cl.plafond_credit - v_encours, 0) end);
end $$;

-- ---------------------------------------------------------------------
-- 8. Caisse : les règlements de crédits en espèces entrent dans le tiroir
-- ---------------------------------------------------------------------

do $$
declare
  v_def text := pg_get_functiondef('prive.calculer_totaux_session(uuid)'::regprocedure);
  a1 text := 'from public.virements vi where vi.session_id = p_session and vi.statut <> ''annule'')';
  a2 text := '                         + (select coalesce(sum(montant), 0) from mv where type = ''apport''),';
  a3 text := '''calcule_le'', now()';
begin
  if position(a1 in v_def) = 0 or position(a2 in v_def) = 0 or position(a3 in v_def) = 0 then
    raise exception 'calculer_totaux_session : ancre introuvable';
  end if;
  v_def := replace(v_def, a1,
    'from public.virements vi where vi.session_id = p_session and vi.statut <> ''annule''
         union all
         select ''credit'', e.montant from public.encaissements_creances e
          where e.session_id = p_session and e.statut = ''enregistre''
            and e.compte_id = prive.compte_tiroir(e.organisation_id, (select caisse_id from s)))');
  v_def := replace(v_def, a2,
    '                         + (select coalesce(sum(montant), 0) from mv where type in (''apport'', ''credit'')),');
  v_def := replace(v_def, a3,
    '''credits_especes'', (select coalesce(sum(montant), 0) from mv where type = ''credit''),
    ''credits_encaisses'', (select coalesce(sum(e.montant), 0) from public.encaissements_creances e
                             where e.session_id = p_session and e.statut = ''enregistre''),
    ''calcule_le'', now()');
  execute v_def;
end $$;

-- Libellés lisibles dans le journal d'activité.
comment on table public.credits is 'Dossiers de crédit client (articles remis, échéance, responsable du suivi).';
