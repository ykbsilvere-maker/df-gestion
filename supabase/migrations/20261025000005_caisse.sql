-- =====================================================================
-- Migration 005 : caisse et ventes
--   * moyens de règlement paramétrables par entreprise (traçabilité, sans API) ;
--   * sessions de caisse : ouverture avec fond, clôture avec billetage, rapport Z ;
--   * ventes idempotentes (identifiant créé par l'appareil : une vente rejouée
--     après une coupure réseau n'est jamais enregistrée deux fois) ;
--   * règlements multiples, monnaie rendue sur les espèces ;
--   * sortie de stock automatique, lots consommés par date de péremption (FEFO) ;
--   * annulation motivée qui remet en stock.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Moyens de règlement
-- ---------------------------------------------------------------------

create table public.moyens_paiement (
  id                    uuid primary key default gen_random_uuid(),
  organisation_id       uuid not null references public.organisations(id),
  code                  text not null check (code ~ '^[a-z0-9_]{2,30}$'),
  libelle               text not null check (length(btrim(libelle)) between 2 and 40),
  nature                text not null check (nature in ('especes','mobile','carte','virement','cheque','autre')),
  reference_obligatoire boolean not null default false,
  actif                 boolean not null default true,
  ordre                 smallint not null default 100,
  unique (organisation_id, code),
  unique (organisation_id, id)
);

create function prive.creer_moyens_par_defaut(p_org uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.moyens_paiement (organisation_id, code, libelle, nature, ordre)
  values (p_org, 'especes', 'Espèces', 'especes', 1),
         (p_org, 'wave', 'Wave', 'mobile', 2),
         (p_org, 'orange_money', 'Orange Money', 'mobile', 3),
         (p_org, 'mtn_momo', 'MTN MoMo', 'mobile', 4),
         (p_org, 'moov_money', 'Moov Money', 'mobile', 5),
         (p_org, 'carte', 'Carte bancaire', 'carte', 6),
         (p_org, 'virement', 'Virement', 'virement', 7),
         (p_org, 'cheque', 'Chèque', 'cheque', 8)
  on conflict (organisation_id, code) do nothing
$$;

do $$ begin perform prive.creer_moyens_par_defaut(id) from public.organisations; end $$;

create function prive.tg_moyens_par_defaut() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.creer_moyens_par_defaut(new.id);
  return new;
end $$;
create trigger organisations_moyens_par_defaut after insert on public.organisations
  for each row execute function prive.tg_moyens_par_defaut();

-- ---------------------------------------------------------------------
-- Sessions de caisse
-- ---------------------------------------------------------------------

create table public.sessions_caisse (
  id                 uuid primary key default gen_random_uuid(),
  organisation_id    uuid not null references public.organisations(id),
  magasin_id         uuid not null,
  caisse_id          uuid not null,
  statut             text not null default 'ouverte' check (statut in ('ouverte','cloturee')),
  fond_initial       bigint not null default 0 check (fond_initial >= 0),
  ouverte_par        uuid,
  ouverte_le         timestamptz not null default now(),
  cloturee_par       uuid,
  cloturee_le        timestamptz,
  numero_z           integer,
  especes_attendues  bigint,
  especes_comptees   bigint,
  ecart              bigint,
  motif_ecart        text check (motif_ecart is null or length(motif_ecart) <= 300),
  billetage          jsonb,
  totaux             jsonb,
  unique (organisation_id, id),
  foreign key (organisation_id, magasin_id) references public.magasins(organisation_id, id),
  foreign key (organisation_id, caisse_id) references public.caisses(organisation_id, id)
);
create unique index sessions_une_ouverte on public.sessions_caisse (caisse_id) where statut = 'ouverte';
create index sessions_caisse_idx on public.sessions_caisse (organisation_id, caisse_id, ouverte_le desc);

-- ---------------------------------------------------------------------
-- Ventes, lignes, règlements
-- ---------------------------------------------------------------------

create table public.ventes (
  id                    uuid primary key,          -- créé par l'appareil : clé d'idempotence
  organisation_id       uuid not null references public.organisations(id),
  magasin_id            uuid not null,
  caisse_id             uuid not null,
  session_id            uuid not null,
  numero                text not null,
  numero_local          text check (numero_local is null or length(numero_local) <= 40),
  date_vente            timestamptz not null,
  recue_le              timestamptz not null default now(),
  caissier_id           uuid,
  client_nom            text check (client_nom is null or length(client_nom) <= 120),
  total                 bigint not null check (total >= 0),
  total_remises         bigint not null default 0 check (total_remises >= 0),
  origine               text not null default 'en_ligne' check (origine in ('en_ligne','hors_ligne')),
  apres_cloture         boolean not null default false,
  statut                text not null default 'validee' check (statut in ('validee','annulee')),
  annulee_par           uuid,
  annulee_le            timestamptz,
  motif_annulation      text check (motif_annulation is null or length(motif_annulation) <= 300),
  reference_fne         text check (reference_fne is null or length(reference_fne) <= 80),
  unique (organisation_id, id),
  unique (organisation_id, numero),
  foreign key (organisation_id, magasin_id) references public.magasins(organisation_id, id),
  foreign key (organisation_id, caisse_id) references public.caisses(organisation_id, id),
  foreign key (organisation_id, session_id) references public.sessions_caisse(organisation_id, id)
);
create index ventes_session_idx on public.ventes (session_id, date_vente desc);
create index ventes_date_idx on public.ventes (organisation_id, date_vente desc);

create table public.ventes_lignes (
  organisation_id uuid not null,
  vente_id        uuid not null,
  ligne           smallint not null,
  produit_id      uuid not null,
  designation     text not null,
  quantite        numeric(14,3) not null check (quantite > 0),
  prix_unitaire   bigint not null check (prix_unitaire >= 0),
  remise          bigint not null default 0 check (remise >= 0),
  montant         bigint not null check (montant >= 0),
  taux_tva        numeric(5,2) not null default 0,
  cout_unitaire   numeric(14,4),
  primary key (vente_id, ligne),
  foreign key (organisation_id, vente_id) references public.ventes(organisation_id, id),
  foreign key (organisation_id, produit_id) references public.produits(organisation_id, id),
  check (remise <= quantite * prix_unitaire)
);
create index ventes_lignes_produit_idx on public.ventes_lignes (organisation_id, produit_id);

create table public.reglements (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  vente_id        uuid not null,
  moyen_id        uuid not null,
  nature          text not null,
  libelle         text not null,
  montant         bigint not null check (montant > 0),   -- part du total réglée par ce moyen
  montant_recu    bigint check (montant_recu is null or montant_recu >= montant),
  rendu           bigint not null default 0 check (rendu >= 0),
  reference       text check (reference is null or length(reference) <= 60),
  statut          text not null default 'enregistre' check (statut in ('enregistre','annule')),
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, vente_id) references public.ventes(organisation_id, id),
  foreign key (organisation_id, moyen_id) references public.moyens_paiement(organisation_id, id)
);
create index reglements_vente_idx on public.reglements (vente_id);

-- ---------------------------------------------------------------------
-- Autorisations
-- ---------------------------------------------------------------------

-- Accès à une caisse : magasin dans le périmètre et, si des caisses ont été
-- attribuées à la personne, caisse dans cette liste.
create function prive.acces_caisse(p_org uuid, p_caisse uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with m as (select * from prive.membre_courant(p_org)),
       c as (select * from public.caisses where id = p_caisse and organisation_id = p_org)
  select exists (
    select 1 from m, c
    where m.id is not null and c.actif
      and prive.acces_magasin(p_org, c.magasin_id)
      and (m.role_code = 'proprietaire'
           or not exists (select 1 from public.membre_caisses mc where mc.membre_id = m.id)
           or exists (select 1 from public.membre_caisses mc where mc.membre_id = m.id and mc.caisse_id = p_caisse))
  )
$$;

create function prive.peut_voir_ventes(p_org uuid, p_magasin uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select prive.acces_magasin(p_org, p_magasin)
     and (prive.a_permission(p_org, 'ventes.consulter') or prive.a_permission(p_org, 'caisse.consulter'))
$$;

alter table public.moyens_paiement enable row level security;
alter table public.sessions_caisse enable row level security;
alter table public.ventes          enable row level security;
alter table public.ventes_lignes   enable row level security;
alter table public.reglements      enable row level security;

create policy lecture on public.moyens_paiement for select to authenticated
  using (prive.est_membre(organisation_id));
create policy creation on public.moyens_paiement for insert to authenticated
  with check (prive.a_permission(organisation_id, 'caisse.administrer') or prive.a_permission(organisation_id, 'administration.modifier'));
create policy modification on public.moyens_paiement for update to authenticated
  using (prive.a_permission(organisation_id, 'caisse.administrer') or prive.a_permission(organisation_id, 'administration.modifier'))
  with check (prive.a_permission(organisation_id, 'caisse.administrer') or prive.a_permission(organisation_id, 'administration.modifier'));

create policy lecture on public.sessions_caisse for select to authenticated
  using (prive.peut_voir_ventes(organisation_id, magasin_id));
create policy lecture on public.ventes for select to authenticated
  using (prive.peut_voir_ventes(organisation_id, magasin_id));
create policy lecture on public.ventes_lignes for select to authenticated
  using (exists (select 1 from public.ventes v where v.id = vente_id));
create policy lecture on public.reglements for select to authenticated
  using (exists (select 1 from public.ventes v where v.id = vente_id));

revoke all on public.moyens_paiement, public.sessions_caisse, public.ventes, public.ventes_lignes, public.reglements
  from anon, authenticated;
grant select on public.moyens_paiement, public.sessions_caisse, public.ventes, public.ventes_lignes, public.reglements
  to authenticated;
grant insert (organisation_id, code, libelle, nature, reference_obligatoire, ordre) on public.moyens_paiement to authenticated;
grant update (libelle, reference_obligatoire, actif, ordre) on public.moyens_paiement to authenticated;

create trigger moyens_paiement_audit after insert or update on public.moyens_paiement
  for each row execute function prive.tg_audit();
create trigger sessions_caisse_audit after insert or update on public.sessions_caisse
  for each row execute function prive.tg_audit();

-- ---------------------------------------------------------------------
-- Sessions : ouverture, rapport, clôture
-- ---------------------------------------------------------------------

create function public.ouvrir_session(p_org uuid, p_caisse uuid, p_fond bigint default 0) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.caisses;
  v_id uuid;
begin
  select * into c from public.caisses where id = p_caisse and organisation_id = p_org;
  perform prive.exiger(found, 'Caisse introuvable');
  perform prive.exiger(prive.a_permission(p_org, 'caisse.creer'), 'Droit « caisse.creer » requis pour ouvrir une caisse');
  perform prive.exiger(prive.acces_caisse(p_org, p_caisse), 'Cette caisse ne vous est pas attribuée');
  perform prive.exiger(coalesce(p_fond, 0) >= 0, 'Fond de caisse invalide');
  select id into v_id from public.sessions_caisse where caisse_id = p_caisse and statut = 'ouverte';
  perform prive.exiger(v_id is null, 'Cette caisse est déjà ouverte');
  insert into public.sessions_caisse (organisation_id, magasin_id, caisse_id, fond_initial, ouverte_par)
  values (p_org, c.magasin_id, p_caisse, coalesce(p_fond, 0), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Totaux d'une session (rapport X à tout moment, figés dans le rapport Z).
create function prive.calculer_totaux_session(p_session uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with s as (select * from public.sessions_caisse where id = p_session),
       v as (select * from public.ventes where session_id = p_session),
       r as (select rg.* from public.reglements rg join v on v.id = rg.vente_id
              where v.statut = 'validee' and rg.statut = 'enregistre')
  select jsonb_build_object(
    'nombre_ventes', (select count(*) from v where statut = 'validee'),
    'total_ventes', (select coalesce(sum(total), 0) from v where statut = 'validee'),
    'total_remises', (select coalesce(sum(total_remises), 0) from v where statut = 'validee'),
    'nombre_annulations', (select count(*) from v where statut = 'annulee'),
    'total_annulations', (select coalesce(sum(total), 0) from v where statut = 'annulee'),
    'ventes_hors_ligne', (select count(*) from v where origine = 'hors_ligne'),
    'ventes_apres_cloture', (select count(*) from v where apres_cloture),
    'panier_moyen', (select coalesce(round(avg(total)), 0) from v where statut = 'validee'),
    'fond_initial', (select fond_initial from s),
    'especes_encaissees', (select coalesce(sum(montant), 0) from r where nature = 'especes'),
    'especes_attendues', (select fond_initial from s) + (select coalesce(sum(montant), 0) from r where nature = 'especes'),
    'par_moyen', coalesce((
      select jsonb_agg(jsonb_build_object('libelle', libelle, 'nature', nature, 'montant', total, 'nombre', nb) order by total desc)
      from (select libelle, nature, sum(montant) total, count(*) nb from r group by libelle, nature) x
    ), '[]'::jsonb),
    'calcule_le', now()
  )
$$;

create function public.rapport_session(p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.sessions_caisse;
begin
  select * into s from public.sessions_caisse where id = p_session;
  perform prive.exiger(found and prive.peut_voir_ventes(s.organisation_id, s.magasin_id), 'Session introuvable');
  if s.statut = 'cloturee' then
    return s.totaux || jsonb_build_object('numero_z', s.numero_z, 'especes_comptees', s.especes_comptees,
      'ecart', s.ecart, 'motif_ecart', s.motif_ecart, 'billetage', s.billetage, 'cloturee_le', s.cloturee_le,
      'ventes_apres_cloture', (select count(*) from public.ventes where session_id = s.id and apres_cloture));
  end if;
  return prive.calculer_totaux_session(p_session);
end $$;

-- Clôture : comptage des espèces (billetage), écart motivé, numéro Z séquentiel par caisse.
-- Possible par la personne qui a ouvert la session ou par un titulaire de « caisse.cloturer ».
create function public.cloturer_session(p_session uuid, p_especes_comptees bigint, p_billetage jsonb default null,
                                        p_motif_ecart text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.sessions_caisse;
  t jsonb;
  v_ecart bigint;
  v_z integer;
begin
  select * into s from public.sessions_caisse where id = p_session for update;
  perform prive.exiger(found, 'Session introuvable');
  perform prive.exiger(s.statut = 'ouverte', 'Cette session est déjà clôturée');
  perform prive.exiger(prive.acces_magasin(s.organisation_id, s.magasin_id)
                       and (s.ouverte_par = auth.uid() or prive.a_permission(s.organisation_id, 'caisse.cloturer')),
                       'Seule la personne qui a ouvert la caisse ou un responsable peut la clôturer');
  perform prive.exiger(p_especes_comptees is not null and p_especes_comptees >= 0, 'Indiquez les espèces comptées');
  t := prive.calculer_totaux_session(p_session);
  v_ecart := p_especes_comptees - (t ->> 'especes_attendues')::bigint;
  perform prive.exiger(v_ecart = 0 or length(btrim(coalesce(p_motif_ecart, ''))) >= 3,
                       'Un écart de caisse doit être justifié');
  v_z := prive.prochain_numero(s.organisation_id, 'z_' || s.caisse_id::text)::integer;
  perform set_config('app.motif', coalesce(btrim(p_motif_ecart), ''), true);
  update public.sessions_caisse
     set statut = 'cloturee', cloturee_par = auth.uid(), cloturee_le = now(), numero_z = v_z,
         especes_attendues = (t ->> 'especes_attendues')::bigint, especes_comptees = p_especes_comptees,
         ecart = v_ecart, motif_ecart = nullif(btrim(p_motif_ecart), ''), billetage = p_billetage, totaux = t
   where id = s.id;
  perform set_config('app.motif', '', true);
  return public.rapport_session(p_session);
end $$;

-- ---------------------------------------------------------------------
-- Ventes
-- ---------------------------------------------------------------------

-- Sortie de stock d'une ligne : lots à péremption la plus proche d'abord (FEFO),
-- le reste sans lot. Le stock peut devenir négatif (vente déjà faite au comptoir) :
-- l'alerte « stock négatif » le signale pour régularisation.
create function prive.sortir_stock_vente(p_org uuid, p_magasin uuid, p_produit uuid, p_quantite numeric, p_vente uuid)
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
    insert into public.mouvements_stock (organisation_id, magasin_id, produit_id, lot_id, type, quantite, piece_type, piece_id)
    values (p_org, p_magasin, p_produit, l.lot_id, 'vente', -prise, 'vente', p_vente) returning * into m;
    valeur_totale := valeur_totale + m.cout_unitaire * prise;
    reste := reste - prise;
  end loop;
  if reste > 0 then
    insert into public.mouvements_stock (organisation_id, magasin_id, produit_id, type, quantite, piece_type, piece_id)
    values (p_org, p_magasin, p_produit, 'vente', -reste, 'vente', p_vente) returning * into m;
    valeur_totale := valeur_totale + m.cout_unitaire * reste;
  end if;
  return round(valeur_totale / p_quantite, 4);
end $$;

-- Enregistre une vente complète. Idempotente : la même vente (même identifiant) renvoyée
-- plusieurs fois (double clic, synchronisation après coupure) n'est enregistrée qu'une fois.
-- p_vente : { id, organisation_id, caisse_id, session_id, date_vente, origine, numero_local, client_nom,
--             lignes: [{ produit_id, quantite, prix_unitaire, remise }],
--             reglements: [{ moyen_id, montant, montant_recu, reference }] }
create function public.enregistrer_vente(p_vente jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := (p_vente ->> 'id')::uuid;
  v_org uuid := (p_vente ->> 'organisation_id')::uuid;
  v_origine text := coalesce(p_vente ->> 'origine', 'en_ligne');
  existante public.ventes;
  s public.sessions_caisse;
  l jsonb;
  r jsonb;
  p public.produits;
  mp public.moyens_paiement;
  n smallint := 0;
  v_q numeric;
  v_prix bigint;
  v_remise bigint;
  v_montant bigint;
  v_total bigint := 0;
  v_remises bigint := 0;
  v_regle bigint := 0;
  v_recu bigint;
  v_numero text;
  v_cout numeric;
begin
  perform prive.exiger(v_id is not null and v_org is not null, 'Vente incomplète');

  select * into existante from public.ventes where id = v_id;
  if found then
    perform prive.exiger(existante.organisation_id = v_org and prive.peut_voir_ventes(v_org, existante.magasin_id),
                         'Vente introuvable');
    return jsonb_build_object('id', existante.id, 'numero', existante.numero, 'deja_enregistree', true);
  end if;

  select * into s from public.sessions_caisse
   where id = (p_vente ->> 'session_id')::uuid and organisation_id = v_org for update;
  perform prive.exiger(found, 'Session de caisse introuvable');
  perform prive.exiger(s.caisse_id = (p_vente ->> 'caisse_id')::uuid, 'La vente ne correspond pas à cette caisse');
  perform prive.exiger(prive.a_permission(v_org, 'ventes.creer'), 'Droit « ventes.creer » requis');
  perform prive.exiger(prive.acces_caisse(v_org, s.caisse_id), 'Cette caisse ne vous est pas attribuée');
  -- Une session clôturée n'accepte que les ventes faites hors connexion avant la clôture.
  perform prive.exiger(s.statut = 'ouverte' or v_origine = 'hors_ligne', 'La caisse est clôturée');
  perform prive.exiger(jsonb_array_length(coalesce(p_vente -> 'lignes', '[]')) > 0, 'La vente ne contient aucun article');
  perform prive.exiger(jsonb_array_length(coalesce(p_vente -> 'reglements', '[]')) > 0, 'Aucun règlement');

  v_numero := 'T-' || lpad(prive.prochain_numero(v_org, 'vente')::text, 6, '0');
  insert into public.ventes (id, organisation_id, magasin_id, caisse_id, session_id, numero, numero_local, date_vente,
                             caissier_id, client_nom, total, origine, apres_cloture)
  values (v_id, v_org, s.magasin_id, s.caisse_id, s.id, v_numero, nullif(p_vente ->> 'numero_local', ''),
          least(coalesce((p_vente ->> 'date_vente')::timestamptz, now()), now()),
          auth.uid(), nullif(btrim(p_vente ->> 'client_nom'), ''), 0, v_origine, s.statut = 'cloturee');

  for l in select * from jsonb_array_elements(p_vente -> 'lignes') loop
    n := n + 1;
    select * into p from public.produits where id = (l ->> 'produit_id')::uuid and organisation_id = v_org;
    perform prive.exiger(found, 'Produit inconnu');
    v_q := (l ->> 'quantite')::numeric;
    v_prix := coalesce((l ->> 'prix_unitaire')::bigint, p.prix_vente);
    v_remise := coalesce((l ->> 'remise')::bigint, 0);
    perform prive.exiger(v_q > 0, 'Quantité invalide');
    perform prive.exiger(v_prix >= 0 and v_remise >= 0 and v_remise <= round(v_q * v_prix), 'Remise invalide');
    -- Prix différent du catalogue : seulement hors connexion (catalogue de l'appareil) ou avec le droit de modifier.
    perform prive.exiger(v_prix = p.prix_vente or v_origine = 'hors_ligne' or prive.a_permission(v_org, 'ventes.modifier'),
                         format('Le prix de « %s » a changé : rechargez le catalogue', p.designation));
    perform prive.exiger(v_remise = 0 or prive.a_permission(v_org, 'ventes.valider'),
                         'Droit « ventes.valider » requis pour accorder une remise');
    v_montant := round(v_q * v_prix) - v_remise;
    v_cout := prive.sortir_stock_vente(v_org, s.magasin_id, p.id, v_q, v_id);
    insert into public.ventes_lignes (organisation_id, vente_id, ligne, produit_id, designation, quantite, prix_unitaire,
                                      remise, montant, taux_tva, cout_unitaire)
    values (v_org, v_id, n, p.id, p.designation, v_q, v_prix, v_remise, v_montant, p.taux_tva, v_cout);
    v_total := v_total + v_montant;
    v_remises := v_remises + v_remise;
  end loop;

  for r in select * from jsonb_array_elements(p_vente -> 'reglements') loop
    select * into mp from public.moyens_paiement where id = (r ->> 'moyen_id')::uuid and organisation_id = v_org;
    perform prive.exiger(found and (mp.actif or v_origine = 'hors_ligne'), 'Moyen de règlement inconnu ou désactivé');
    v_montant := (r ->> 'montant')::bigint;
    perform prive.exiger(v_montant > 0, 'Montant de règlement invalide');
    perform prive.exiger(not mp.reference_obligatoire or length(btrim(coalesce(r ->> 'reference', ''))) > 0,
                         format('Référence de transaction obligatoire pour %s', mp.libelle));
    v_recu := case when mp.nature = 'especes' then greatest(coalesce((r ->> 'montant_recu')::bigint, v_montant), v_montant) end;
    insert into public.reglements (organisation_id, vente_id, moyen_id, nature, libelle, montant, montant_recu, rendu, reference)
    values (v_org, v_id, mp.id, mp.nature, mp.libelle, v_montant, v_recu, coalesce(v_recu - v_montant, 0),
            nullif(btrim(r ->> 'reference'), ''));
    v_regle := v_regle + v_montant;
  end loop;

  perform prive.exiger(v_regle = v_total,
    format('Les règlements (%s F) ne correspondent pas au total de la vente (%s F)', v_regle, v_total));
  update public.ventes set total = v_total, total_remises = v_remises where id = v_id;
  return jsonb_build_object('id', v_id, 'numero', v_numero, 'total', v_total, 'deja_enregistree', false);
end $$;

-- Annulation d'une vente de la session en cours : les articles reviennent en stock
-- au coût de sortie, les règlements sont annulés, le motif est journalisé.
create function public.annuler_vente(p_vente uuid, p_motif text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.ventes;
  s public.sessions_caisse;
  m record;
begin
  select * into v from public.ventes where id = p_vente for update;
  perform prive.exiger(found, 'Vente introuvable');
  perform prive.exiger(prive.a_permission(v.organisation_id, 'ventes.annuler') and prive.acces_magasin(v.organisation_id, v.magasin_id),
                       'Droit « ventes.annuler » requis');
  perform prive.exiger(v.statut = 'validee', 'Cette vente est déjà annulée');
  perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Un motif d''annulation est obligatoire');
  select * into s from public.sessions_caisse where id = v.session_id;
  perform prive.exiger(s.statut = 'ouverte', 'La caisse de cette vente est clôturée : enregistrez un retour');

  for m in select * from public.mouvements_stock where piece_type = 'vente' and piece_id = v.id loop
    insert into public.mouvements_stock (organisation_id, magasin_id, produit_id, lot_id, type, quantite, cout_unitaire,
                                         motif, piece_type, piece_id)
    values (m.organisation_id, m.magasin_id, m.produit_id, m.lot_id, 'retour_client', -m.quantite, m.cout_unitaire,
            'Annulation ' || v.numero, 'vente', v.id);
  end loop;
  update public.reglements set statut = 'annule' where vente_id = v.id;
  update public.ventes set statut = 'annulee', annulee_par = auth.uid(), annulee_le = now(), motif_annulation = btrim(p_motif)
   where id = v.id;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (v.organisation_id, auth.uid(), 'ventes.annulation', 'ventes', v.id::text,
          jsonb_build_object('motif', btrim(p_motif), 'numero', v.numero, 'total', v.total));
end $$;

-- Catalogue de caisse : tout ce qu'il faut pour vendre, y compris hors connexion.
create function public.catalogue_caisse(p_org uuid, p_magasin uuid)
returns table (id uuid, code text, designation text, unite text, prix_vente bigint, taux_tva numeric,
               codes_barres text[], quantite_stock numeric)
language sql stable set search_path = '' as $$
  select p.id, p.code, p.designation, p.unite, p.prix_vente, p.taux_tva,
         coalesce((select array_agg(cb.code) from public.codes_barres cb where cb.produit_id = p.id), '{}'),
         coalesce((select s.quantite from public.stocks s where s.produit_id = p.id and s.magasin_id = p_magasin), 0)
  from public.produits p
  where p.organisation_id = p_org and p.statut = 'actif'
  order by p.designation
$$;

-- Chiffre d'affaires du jour (heure d'Abidjan) pour l'accueil.
create function public.ventes_du_jour(p_org uuid)
returns table (nombre bigint, total bigint)
language sql stable set search_path = '' as $$
  select count(*), coalesce(sum(total), 0)::bigint
  from public.ventes v
  where v.organisation_id = p_org and v.statut = 'validee'
    and (v.date_vente at time zone 'Africa/Abidjan')::date = (now() at time zone 'Africa/Abidjan')::date
$$;

revoke all on function
  public.ouvrir_session(uuid, uuid, bigint), public.rapport_session(uuid),
  public.cloturer_session(uuid, bigint, jsonb, text), public.enregistrer_vente(jsonb),
  public.annuler_vente(uuid, text), public.catalogue_caisse(uuid, uuid), public.ventes_du_jour(uuid)
from public, anon;
grant execute on function
  public.ouvrir_session(uuid, uuid, bigint), public.rapport_session(uuid),
  public.cloturer_session(uuid, bigint, jsonb, text), public.enregistrer_vente(jsonb),
  public.annuler_vente(uuid, text), public.catalogue_caisse(uuid, uuid), public.ventes_du_jour(uuid)
to authenticated;

revoke all on all functions in schema prive from public;
grant execute on function prive.acces_caisse(uuid, uuid), prive.peut_voir_ventes(uuid, uuid) to authenticated;
