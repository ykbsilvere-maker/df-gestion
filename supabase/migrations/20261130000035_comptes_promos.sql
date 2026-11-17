-- =====================================================================
-- v3.8 — Comptes clients sur DF Marché (historique, adresses, bons d'achat),
-- codes promo (pour tous ou pour un compte, partageables), paiement en espèces
-- avec la monnaie à préparer, moyens de paiement ajoutés avec logo et lien,
-- alerte de la caisse.
-- =====================================================================

-- Compte d'un client du site (connexion par e-mail ou téléphone + mot de passe).
create table public.clients_marche (
  id         uuid primary key references auth.users(id) on delete cascade,
  nom        text not null check (length(btrim(nom)) between 2 and 80),
  telephone  text check (telephone is null or telephone ~ '^[0-9+]{8,15}$'),
  adresse    text check (adresse is null or length(adresse) <= 200),
  repere     text check (repere is null or length(repere) <= 200),
  commune    text check (commune is null or length(commune) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.clients_marche enable row level security;
-- Aucun accès direct : tout passe par les fonctions ci-dessous.

alter table public.commandes_web
  add column compte_id uuid references public.clients_marche(id) on delete set null,
  add column code_promo text,
  add column remise bigint not null default 0 check (remise >= 0),
  add column especes_remis bigint check (especes_remis is null or especes_remis > 0);
create index commandes_web_compte_idx on public.commandes_web (compte_id, created_at desc) where compte_id is not null;

create table public.codes_promo (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations(id),
  code             text not null check (code ~ '^[A-Z0-9-]{3,20}$'),
  libelle          text check (libelle is null or length(libelle) <= 80),
  type             text not null check (type in ('pourcent','montant')),
  valeur           bigint not null check (valeur > 0),
  minimum          bigint not null default 0 check (minimum >= 0),
  debut            date,
  fin              date,
  max_utilisations integer check (max_utilisations is null or max_utilisations > 0),
  utilisations     integer not null default 0,
  compte_id        uuid references public.clients_marche(id) on delete cascade,
  visible          boolean not null default false,
  actif            boolean not null default true,
  cree_par         uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  unique (organisation_id, code),
  check (type <> 'pourcent' or valeur <= 90),
  check (fin is null or debut is null or fin >= debut)
);
alter table public.codes_promo enable row level security;
create policy lecture on public.codes_promo for select to authenticated using (prive.a_permission(organisation_id, 'boutique.consulter'));
grant select on public.codes_promo to authenticated;

create function prive.code_promo_valable(k public.codes_promo, p_compte uuid) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(k.actif
     and (k.debut is null or k.debut <= prive.jour_abidjan())
     and (k.fin is null or k.fin >= prive.jour_abidjan())
     and (k.max_utilisations is null or k.utilisations < k.max_utilisations)
     and (k.compte_id is null or k.compte_id = p_compte), false)
$$;

create function prive.code_promo_public(k public.codes_promo) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('code', k.code, 'libelle', k.libelle, 'type', k.type, 'valeur', k.valeur, 'minimum', k.minimum,
                            'fin', k.fin, 'personnel', k.compte_id is not null,
                            'boutique', (select jsonb_build_object('slug', v.slug, 'nom', v.nom) from public.vitrines v
                                          where v.organisation_id = k.organisation_id))
$$;

-- La caisse accepte la remise d'un code promo lors de l'encaissement d'une commande en ligne.
do $$
declare d text;
begin
  select pg_get_functiondef('public.enregistrer_vente(jsonb)'::regprocedure) into d;
  d := replace(d, 'perform prive.exiger(v_remise = 0 or prive.a_permission(v_org, ''ventes.valider''),',
                  'perform prive.exiger(v_remise = 0 or prive.a_permission(v_org, ''ventes.valider'') or current_setting(''df.remise_commande_web'', true) = ''on'',');
  if position('df.remise_commande_web' in d) = 0 then raise exception 'enregistrer_vente : contrôle de remise introuvable'; end if;
  execute d;
end $$;

-- ---------- Compte client (site) ----------
create function public.compte_marche() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'nom', c.nom, 'telephone', c.telephone, 'adresse', c.adresse, 'repere', c.repere,
                            'commune', c.commune, 'email', u.email, 'depuis', c.created_at,
                            'commandes', (select count(*) from public.commandes_web w where w.compte_id = c.id))
    from public.clients_marche c join auth.users u on u.id = c.id
   where c.id = auth.uid()
$$;

create function public.compte_marche_enregistrer(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tel text := nullif(regexp_replace(coalesce(p ->> 'telephone', ''), '[^0-9+]', '', 'g'), '');
begin
  perform prive.exiger(auth.uid() is not null, 'Connectez-vous d''abord');
  perform prive.exiger(length(btrim(coalesce(p ->> 'nom', ''))) between 2 and 80, 'Indiquez votre nom');
  insert into public.clients_marche (id, nom, telephone, adresse, repere, commune)
  values (auth.uid(), btrim(p ->> 'nom'), v_tel, nullif(btrim(p ->> 'adresse'), ''), nullif(btrim(p ->> 'repere'), ''),
          nullif(btrim(p ->> 'commune'), ''))
  on conflict (id) do update set nom = excluded.nom, telephone = excluded.telephone, adresse = excluded.adresse,
                                 repere = excluded.repere, commune = excluded.commune, updated_at = now();
  return public.compte_marche();
end $$;

create function public.mes_commandes_marche() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'numero', c.numero, 'code', c.code_suivi, 'boutique', v.nom, 'slug', v.slug, 'total', c.total, 'statut', c.statut,
           'paiement', c.paiement, 'paiement_statut', c.paiement_statut, 'date', c.created_at,
           'articles', (select count(*) from public.commandes_web_lignes l where l.commande_id = c.id)) order by c.created_at desc), '[]'::jsonb)
    from public.commandes_web c join public.vitrines v on v.organisation_id = c.organisation_id
   where c.compte_id = auth.uid() and auth.uid() is not null
$$;

-- Bons d'achat du client : codes qui lui sont réservés et codes affichés pour tous.
create function public.mes_bons_marche() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(prive.code_promo_public(k) order by k.compte_id is null, k.fin nulls last), '[]'::jsonb)
    from public.codes_promo k
   where prive.code_promo_valable(k, auth.uid())
     and ((auth.uid() is not null and k.compte_id = auth.uid()) or (k.compte_id is null and k.visible))
     and exists (select 1 from prive.vitrines_ouvertes() v where v.organisation_id = k.organisation_id)
$$;

-- Vérifier un code (panier, ou lien d'offre partagé).
create function public.marche_code_promo(p_boutique text, p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.vitrines; k public.codes_promo;
begin
  v := prive.vitrine_ouverte(p_boutique);
  select * into k from public.codes_promo where organisation_id = v.organisation_id and code = upper(btrim(p_code));
  if not found or not prive.code_promo_valable(k, (select id from public.clients_marche where id = auth.uid())) then
    raise exception '%', case when found and k.compte_id is not null and auth.uid() is null
                              then 'Ce code est réservé à un compte : connectez-vous pour l''utiliser'
                              else 'Ce code promo n''est pas valable' end using errcode = 'P0001';
  end if;
  return prive.code_promo_public(k);
end $$;

-- ---------- Codes promo (boutique) ----------
create function public.codes_promo_liste(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.consulter'), 'Droit « boutique.consulter » requis');
  return coalesce((select jsonb_agg(to_jsonb(k) || jsonb_build_object(
            'client', (select jsonb_build_object('nom', c.nom, 'telephone', c.telephone, 'email', u.email)
                         from public.clients_marche c join auth.users u on u.id = c.id where c.id = k.compte_id),
            'valable', prive.code_promo_valable(k, k.compte_id),
            'remises', (select coalesce(sum(w.remise), 0) from public.commandes_web w
                         where w.organisation_id = k.organisation_id and w.code_promo = k.code and w.statut <> 'annulee'))
          order by k.actif desc, k.created_at desc)
     from public.codes_promo k where k.organisation_id = p_org), '[]'::jsonb);
end $$;

create function public.code_promo_enregistrer(p_org uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k public.codes_promo;
  v_client text := nullif(btrim(coalesce(p ->> 'client', '')), '');
  v_compte uuid;
  v_code text := upper(btrim(coalesce(p ->> 'code', '')));
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.modifier'), 'Droit « boutique.modifier » requis');
  perform prive.exiger(v_code ~ '^[A-Z0-9-]{3,20}$', 'Code : 3 à 20 lettres, chiffres ou tirets');
  if v_client is not null then
    -- Le client est retrouvé par l'e-mail ou le téléphone de son compte DF Marché.
    select c.id into v_compte from public.clients_marche c join auth.users u on u.id = c.id
     where lower(u.email) = lower(v_client)
        or (length(regexp_replace(v_client, '[^0-9]', '', 'g')) >= 8
            and right(regexp_replace(coalesce(c.telephone, ''), '[^0-9]', '', 'g'), 10) = right(regexp_replace(v_client, '[^0-9]', '', 'g'), 10))
     limit 1;
    perform prive.exiger(v_compte is not null, 'Aucun compte client DF Marché avec cet e-mail ou ce téléphone');
  end if;
  if p ->> 'id' is not null then
    update public.codes_promo set code = v_code, libelle = nullif(btrim(p ->> 'libelle'), ''), type = p ->> 'type',
           valeur = (p ->> 'valeur')::bigint, minimum = coalesce((p ->> 'minimum')::bigint, 0),
           debut = nullif(p ->> 'debut', '')::date, fin = nullif(p ->> 'fin', '')::date,
           max_utilisations = nullif(p ->> 'max_utilisations', '')::integer, compte_id = v_compte,
           visible = coalesce((p ->> 'visible')::boolean, false), actif = coalesce((p ->> 'actif')::boolean, true)
     where id = (p ->> 'id')::uuid and organisation_id = p_org returning * into k;
    perform prive.exiger(found, 'Code introuvable');
  else
    perform prive.exiger(not exists (select 1 from public.codes_promo where organisation_id = p_org and code = v_code), 'Ce code existe déjà');
    insert into public.codes_promo (organisation_id, code, libelle, type, valeur, minimum, debut, fin, max_utilisations, compte_id, visible)
    values (p_org, v_code, nullif(btrim(p ->> 'libelle'), ''), p ->> 'type', (p ->> 'valeur')::bigint,
            coalesce((p ->> 'minimum')::bigint, 0), nullif(p ->> 'debut', '')::date, nullif(p ->> 'fin', '')::date,
            nullif(p ->> 'max_utilisations', '')::integer, v_compte, coalesce((p ->> 'visible')::boolean, false))
    returning * into k;
  end if;
  return to_jsonb(k);
end $$;

-- ---------- Alerte de la caisse : commandes à remettre ou à valider ----------
create function public.commandes_caisse_attente(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when prive.a_permission(p_org, 'boutique.consulter') then jsonb_build_object(
    'nombre', (select count(*) from public.commandes_web
                where organisation_id = p_org and vente_id is null
                  and (statut in ('confirmee','prete','en_livraison') or (statut = 'nouvelle' and mode = 'retrait'))
                  and prive.acces_magasin(organisation_id, magasin_id)),
    'derniere', (select max(created_at) from public.commandes_web where organisation_id = p_org and statut = 'nouvelle'))
  else jsonb_build_object('nombre', 0) end
$$;

create or replace function public.passer_commande(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.vitrines;
  z public.zones_livraison;
  c public.commandes_web;
  l jsonb;
  pr public.produits;
  n smallint := 0;
  v_q numeric;
  v_prix bigint;
  v_dispo numeric;
  v_sous_total bigint := 0;
  v_mode text := p ->> 'mode';
  v_paiement text := p ->> 'paiement';
  v_tel text := regexp_replace(coalesce(p ->> 'client_telephone', ''), '[^0-9+]', '', 'g');
  v_numero text;
  v_code text;
  v_souhaite timestamptz := nullif(p ->> 'souhaite_le', '')::timestamptz;
  v_autre jsonb;
  v_promo public.codes_promo;
  v_remise bigint := 0;
  v_especes bigint := nullif(p ->> 'especes_remis', '')::bigint;
  v_compte uuid := (select id from public.clients_marche where id = auth.uid());
begin
  v := prive.vitrine_ouverte(p ->> 'boutique');
  perform prive.exiger(length(btrim(coalesce(p ->> 'client_nom', ''))) between 2 and 80, 'Indiquez votre nom');
  perform prive.exiger(length(v_tel) between 8 and 15, 'Indiquez un numéro de téléphone valide');
  perform prive.exiger(v_mode in ('livraison','retrait'), 'Choisissez la livraison ou le retrait en boutique');
  perform prive.exiger(v_mode <> 'livraison' or v.livraison, 'Cette boutique ne livre pas : choisissez le retrait');
  perform prive.exiger(v_mode <> 'retrait' or v.retrait, 'Cette boutique ne propose que la livraison');
  perform prive.exiger(v_paiement in ('livraison','wave','orange_money','mtn','moov','djamo','autre'), 'Choisissez un moyen de paiement');
  if v_paiement = 'autre' then
    select x into v_autre from jsonb_array_elements(v.autres_paiements) x where x ->> 'id' = p ->> 'paiement_autre';
    perform prive.exiger(v_autre is not null, 'Ce moyen de paiement n''est pas proposé par la boutique');
  end if;
  perform prive.exiger(v_paiement <> 'livraison' or v.paiement_livraison, 'Cette boutique demande le paiement à la commande');
  perform prive.exiger(case v_paiement when 'wave' then v.numero_wave when 'orange_money' then v.numero_orange
                                       when 'mtn' then v.numero_mtn when 'moov' then v.numero_moov
                                       when 'djamo' then v.numero_djamo else 'ok' end is not null,
                       'Ce moyen de paiement n''est pas proposé par la boutique');
  perform prive.exiger(v_paiement = 'livraison' or length(regexp_replace(coalesce(p ->> 'numero_payeur', ''), '[^0-9]', '', 'g')) >= 8,
                       'Indiquez le numéro qui a effectué le paiement');
  perform prive.exiger(v_souhaite is null or v_souhaite > now() - interval '1 hour', 'L''heure souhaitée est déjà passée');
  perform prive.exiger(v_souhaite is null or v_souhaite < now() + interval '30 days', 'Date souhaitée trop lointaine');
  -- Garde-fou contre les abus : 5 commandes en attente au plus par numéro et par boutique.
  perform prive.exiger((select count(*) from public.commandes_web
                         where organisation_id = v.organisation_id and client_telephone = v_tel
                           and statut = 'nouvelle' and created_at > now() - interval '1 day') < 5,
                       'Vous avez déjà plusieurs commandes en attente dans cette boutique : elle vous contactera');
  perform prive.exiger(jsonb_array_length(coalesce(p -> 'lignes', '[]')) between 1 and 40, 'Votre panier est vide');

  if v_mode = 'livraison' then
    select * into z from public.zones_livraison
     where id = (p ->> 'zone_id')::uuid and organisation_id = v.organisation_id and actif;
    perform prive.exiger(found, 'Choisissez votre zone de livraison');
    perform prive.exiger(length(btrim(coalesce(p ->> 'adresse', ''))) >= 3, 'Indiquez l''adresse de livraison');
  end if;

  v_numero := 'W-' || lpad(prive.prochain_numero(v.organisation_id, 'commande_web')::text, 6, '0');
  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when length(v_code) = 8 and not exists (select 1 from public.commandes_web where code_suivi = v_code);
  end loop;

  insert into public.commandes_web (organisation_id, magasin_id, numero, code_suivi, client_nom, client_telephone, client_email,
                                    mode, zone_id, zone_nom, adresse, repere, latitude, longitude, souhaite_le, note,
                                    paiement, numero_payeur, reference_paiement, paiement_statut, paiement_libelle, paiement_numero, compte_id)
  values (v.organisation_id, v.magasin_id, v_numero, v_code, btrim(p ->> 'client_nom'), v_tel, nullif(btrim(p ->> 'client_email'), ''),
          v_mode, z.id, z.nom, nullif(btrim(p ->> 'adresse'), ''), nullif(btrim(p ->> 'repere'), ''),
          nullif(p ->> 'latitude', '')::numeric, nullif(p ->> 'longitude', '')::numeric, v_souhaite, nullif(btrim(p ->> 'note'), ''),
          v_paiement, nullif(regexp_replace(coalesce(p ->> 'numero_payeur', ''), '[^0-9+]', '', 'g'), ''),
          nullif(btrim(p ->> 'reference_paiement'), ''),
          case when v_paiement = 'livraison' then 'a_la_livraison' else 'a_verifier' end,
          v_autre ->> 'libelle', nullif(v_autre ->> 'numero', ''), v_compte)
  returning * into c;

  for l in select * from jsonb_array_elements(p -> 'lignes') loop
    select * into pr from public.produits where id = (l ->> 'produit_id')::uuid and organisation_id = v.organisation_id for update;
    perform prive.exiger(found and prive.produit_public(pr), 'Un article du panier n''est plus en vente');
    v_q := (l ->> 'quantite')::numeric;
    perform prive.exiger(v_q > 0 and v_q <= 1000 and (v_q = trunc(v_q) or pr.unite not in ('pièce','piece')), 'Quantité invalide');
    v_dispo := prive.disponible_en_ligne(v.magasin_id, pr.id);
    perform prive.exiger(v_q <= v_dispo,
      case when v_dispo <= 0 then format('« %s » est en rupture de stock', pr.designation)
           else format('Il ne reste que %s « %s »', trim(to_char(v_dispo, 'FM999G999D###')), pr.designation) end);
    v_prix := coalesce(prive.prix_promo(v.organisation_id, pr.id, prive.jour_abidjan()), pr.prix_vente);
    perform prive.exiger(v_prix > 0, format('« %s » n''a pas de prix', pr.designation));
    n := n + 1;
    insert into public.commandes_web_lignes (organisation_id, commande_id, ligne, produit_id, designation, quantite,
                                             prix_unitaire, prix_normal, montant)
    values (v.organisation_id, c.id, n, pr.id, pr.designation, v_q, v_prix, pr.prix_vente, round(v_q * v_prix));
    v_sous_total := v_sous_total + round(v_q * v_prix);
  end loop;
  perform prive.exiger(v_sous_total >= v.commande_minimum,
                       format('Commande minimum de %s F dans cette boutique', v.commande_minimum));

  -- Code promo : pour tout le monde, ou réservé au compte client connecté.
  if nullif(btrim(p ->> 'code_promo'), '') is not null then
    select * into v_promo from public.codes_promo
     where organisation_id = v.organisation_id and code = upper(btrim(p ->> 'code_promo')) for update;
    perform prive.exiger(found and prive.code_promo_valable(v_promo, v_compte), 'Ce code promo n''est pas valable');
    perform prive.exiger(v_sous_total >= v_promo.minimum,
                         format('Ce code demande au moins %s FCFA d''achats', v_promo.minimum));
    v_remise := least(v_sous_total, case v_promo.type when 'pourcent' then round(v_sous_total * v_promo.valeur / 100.0)
                                                      else v_promo.valeur end);
    update public.codes_promo set utilisations = utilisations + 1 where id = v_promo.id;
  end if;
  -- Espèces : le client indique le billet qu'il donnera, pour préparer la monnaie.
  perform prive.exiger(v_especes is null or (v_paiement = 'livraison' and v_especes >= v_sous_total - v_remise + coalesce(z.frais, 0)
                                             and v_especes <= 10000000),
                       'Le montant en espèces doit couvrir le total de la commande');

  update public.commandes_web
     set sous_total = v_sous_total, frais_livraison = coalesce(z.frais, 0), remise = v_remise, code_promo = v_promo.code,
         especes_remis = v_especes, total = v_sous_total - v_remise + coalesce(z.frais, 0)
   where id = c.id returning * into c;

  return jsonb_build_object('id', c.id, 'numero', c.numero, 'code_suivi', c.code_suivi, 'sous_total', c.sous_total,
                            'frais_livraison', c.frais_livraison, 'remise', c.remise, 'total', c.total,
                            'boutique', jsonb_build_object('nom', v.nom, 'whatsapp', coalesce(v.whatsapp, v.telephone),
                                                           'telephone', v.telephone, 'slug', v.slug));
end $$;

create or replace function public.marche_suivi(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.commandes_web;
  v public.vitrines;
begin
  select * into c from public.commandes_web where code_suivi = upper(btrim(p_code));
  if not found then raise exception 'Aucune commande avec ce code' using errcode = 'P0001'; end if;
  select * into v from public.vitrines where organisation_id = c.organisation_id;
  return jsonb_build_object(
    'id', c.id, 'numero', c.numero, 'code_suivi', c.code_suivi, 'statut', c.statut, 'paiement', c.paiement,
    'paiement_statut', c.paiement_statut, 'paiement_libelle', c.paiement_libelle, 'mode', c.mode, 'zone', c.zone_nom, 'adresse', c.adresse, 'souhaite_le', c.souhaite_le,
    'client_nom', c.client_nom, 'sous_total', c.sous_total, 'remise', c.remise, 'code_promo', c.code_promo, 'especes_remis', c.especes_remis, 'frais_livraison', c.frais_livraison, 'total', c.total,
    'justificatif', c.justificatif_path is not null, 'motif', c.motif,
    'numero_payeur', c.numero_payeur, 'reference_paiement', c.reference_paiement, 'paiement_confirme_le', c.paiement_confirme_le,
    'client_telephone', c.client_telephone, 'repere', c.repere, 'created_at', c.created_at,
    'vente', (select ve.numero from public.ventes ve where ve.id = c.vente_id),
    'dates', jsonb_build_object('passee', c.created_at, 'confirmee', c.confirmee_le, 'prete', c.prete_le,
                                'expediee', c.expediee_le, 'livree', c.livree_le, 'annulee', c.annulee_le),
    'boutique', jsonb_build_object('nom', v.nom, 'slug', v.slug, 'telephone', v.telephone, 'whatsapp', coalesce(v.whatsapp, v.telephone),
                                   'adresse', v.adresse, 'commune', v.commune, 'beneficiaire', coalesce(v.beneficiaire, v.nom),
                                   'numero_paiement', case c.paiement when 'wave' then v.numero_wave when 'orange_money' then v.numero_orange
                                                                      when 'mtn' then v.numero_mtn when 'moov' then v.numero_moov
                                                                      when 'djamo' then v.numero_djamo else c.paiement_numero end,
                                   'lien_wave', v.lien_wave, 'ville', v.ville),
    'lignes', (select jsonb_agg(jsonb_build_object('produit_id', l.produit_id, 'designation', l.designation, 'quantite', l.quantite,
                                                   'prix_unitaire', l.prix_unitaire, 'montant', l.montant,
                                                   'avis', (select a.note from public.avis_produits a
                                                             where a.commande_id = c.id and a.produit_id = l.produit_id)) order by l.ligne)
                 from public.commandes_web_lignes l where l.commande_id = c.id));
end $$;

create or replace function public.vitrine_enregistrer(p_org uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.vitrines;
  v_slug text := lower(btrim(coalesce(p ->> 'slug', '')));
  num text;
  v_autres jsonb;
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.modifier'), 'Droit « boutique.modifier » requis');
  perform prive.exiger(v_slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$',
                       'Adresse de la boutique : 3 à 40 lettres minuscules, chiffres ou tirets');
  perform prive.exiger(not exists (select 1 from public.vitrines where slug = v_slug and organisation_id <> p_org),
                       'Cette adresse est déjà prise par une autre boutique');
  perform prive.exiger(exists (select 1 from public.magasins where id = (p ->> 'magasin_id')::uuid and organisation_id = p_org and actif),
                       'Choisissez le magasin qui prépare les commandes');
  perform prive.exiger(coalesce(nullif(btrim(p ->> 'lien_wave'), ''), 'https://pay.wave.com/') ~ '^https://(pay\.wave\.com|wave\.com)/',
                       'Le lien Wave doit commencer par https://pay.wave.com/');
  perform prive.exiger(length(coalesce(p ->> 'conditions', '')) <= 8000, 'Conditions de vente : 8 000 caractères au plus');
  -- Moyens de paiement ajoutés par la boutique : nom et numéro (5 au plus).
  perform prive.exiger(jsonb_typeof(coalesce(p -> 'autres_paiements', '[]')) = 'array'
                       and jsonb_array_length(coalesce(p -> 'autres_paiements', '[]')) <= 5, 'Cinq moyens de paiement ajoutés au plus');
  select coalesce(jsonb_agg(jsonb_build_object('id', coalesce(nullif(x ->> 'id', ''), substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
                                               'libelle', btrim(x ->> 'libelle'), 'numero', nullif(btrim(coalesce(x ->> 'numero', '')), ''),
                                               'instructions', nullif(btrim(coalesce(x ->> 'instructions', '')), ''),
                                               'logo', nullif(btrim(coalesce(x ->> 'logo', '')), ''),
                                               'lien', nullif(btrim(coalesce(x ->> 'lien', '')), ''))), '[]'::jsonb)
    into v_autres from jsonb_array_elements(coalesce(p -> 'autres_paiements', '[]')) x;
  perform prive.exiger(not exists (select 1 from jsonb_array_elements(v_autres) x
                                    where length(x ->> 'libelle') not between 2 and 30
                                       or (coalesce(x ->> 'numero', '') !~ '^[0-9 +]{8,20}$' and x ->> 'lien' is null)
                                       or (x ->> 'numero' is not null and x ->> 'numero' !~ '^[0-9 +]{8,20}$')
                                       or coalesce(x ->> 'lien', 'https://x') !~ '^https://[^\s"<>]+$' or length(coalesce(x ->> 'lien', '')) > 300
                                       or (x ->> 'logo' is not null and prive.organisation_du_chemin(x ->> 'logo') is distinct from p_org)
                                       or length(coalesce(x ->> 'instructions', '')) > 200
                                       or x ->> 'id' !~ '^[a-z0-9]{4,12}$'),
                       'Moyen de paiement ajouté : un nom (2 à 30 lettres) et un numéro ou un lien de paiement (https://…) valide');
  insert into public.vitrines (organisation_id, slug, publiee, magasin_id, nom, activite, slogan, description, telephone, whatsapp, email,
                               ville, commune, adresse, latitude, longitude, horaires, photos, paiement_livraison,
                               numero_wave, numero_orange, numero_mtn, numero_moov, beneficiaire, retrait, livraison,
                               delai_preparation, commande_minimum, numero_djamo, lien_wave, conditions, autres_paiements)
  select p_org, v_slug, coalesce((p ->> 'publiee')::boolean, false), (p ->> 'magasin_id')::uuid, btrim(p ->> 'nom'),
         nullif(btrim(p ->> 'activite'), ''), nullif(btrim(p ->> 'slogan'), ''), nullif(btrim(p ->> 'description'), ''),
         nullif(btrim(p ->> 'telephone'), ''), nullif(btrim(p ->> 'whatsapp'), ''), nullif(btrim(p ->> 'email'), ''),
         nullif(btrim(p ->> 'ville'), ''), nullif(btrim(p ->> 'commune'), ''), nullif(btrim(p ->> 'adresse'), ''),
         nullif(p ->> 'latitude', '')::numeric, nullif(p ->> 'longitude', '')::numeric, nullif(btrim(p ->> 'horaires'), ''),
         coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'photos') x
                    where prive.organisation_du_chemin(x) = p_org), '{}'),
         coalesce((p ->> 'paiement_livraison')::boolean, true),
         nullif(btrim(p ->> 'numero_wave'), ''), nullif(btrim(p ->> 'numero_orange'), ''),
         nullif(btrim(p ->> 'numero_mtn'), ''), nullif(btrim(p ->> 'numero_moov'), ''), nullif(btrim(p ->> 'beneficiaire'), ''),
         coalesce((p ->> 'retrait')::boolean, true), coalesce((p ->> 'livraison')::boolean, true),
         coalesce((p ->> 'delai_preparation')::smallint, 2), coalesce((p ->> 'commande_minimum')::bigint, 0),
         nullif(btrim(p ->> 'numero_djamo'), ''), nullif(btrim(p ->> 'lien_wave'), ''), nullif(btrim(p ->> 'conditions'), ''), v_autres
  on conflict (organisation_id) do update set
    slug = excluded.slug, publiee = excluded.publiee, magasin_id = excluded.magasin_id, nom = excluded.nom, activite = excluded.activite,
    slogan = excluded.slogan, description = excluded.description, telephone = excluded.telephone, whatsapp = excluded.whatsapp,
    email = excluded.email, ville = excluded.ville, commune = excluded.commune, adresse = excluded.adresse,
    latitude = excluded.latitude, longitude = excluded.longitude, horaires = excluded.horaires, photos = excluded.photos,
    paiement_livraison = excluded.paiement_livraison, numero_wave = excluded.numero_wave, numero_orange = excluded.numero_orange,
    numero_mtn = excluded.numero_mtn, numero_moov = excluded.numero_moov, beneficiaire = excluded.beneficiaire,
    retrait = excluded.retrait, livraison = excluded.livraison, delai_preparation = excluded.delai_preparation,
    commande_minimum = excluded.commande_minimum, numero_djamo = excluded.numero_djamo, lien_wave = excluded.lien_wave,
    conditions = excluded.conditions, autres_paiements = excluded.autres_paiements, updated_at = now()
  returning * into v;
  perform prive.exiger(not v.publiee or v.telephone is not null or v.whatsapp is not null,
                       'Indiquez un téléphone ou un WhatsApp avant de publier la boutique');
  perform prive.exiger(not v.publiee or not v.livraison
                       or exists (select 1 from public.zones_livraison where organisation_id = p_org and actif),
                       'Ajoutez au moins une zone de livraison, ou proposez seulement le retrait');
  return to_jsonb(v);
end $$;

create or replace function public.encaisser_commande_web(p_id uuid, p_session uuid, p_moyen uuid default null, p_reference text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.commandes_web;
  s public.sessions_caisse;
  v_moyen uuid := p_moyen;
  v_vente uuid := gen_random_uuid();
  v_lignes jsonb;
  r jsonb;
begin
  select * into c from public.commandes_web where id = p_id for update;
  -- À la caisse : la personne qui tient la caisse encaisse (droit « boutique.consulter » + vente).
  perform prive.exiger(found and prive.a_permission(c.organisation_id, 'boutique.consulter'), 'Droit « boutique.consulter » requis');
  -- Un retrait peut être remis directement à la caisse, même avant confirmation.
  perform prive.exiger(c.statut in ('confirmee','prete','en_livraison') or (c.mode = 'retrait' and c.statut = 'nouvelle'),
                       'Confirmez la commande avant de la remettre');
  perform prive.exiger(c.vente_id is null, 'Commande déjà encaissée');
  perform prive.exiger(c.paiement = 'livraison' or c.paiement_statut = 'confirme', 'Le paiement n''est pas encore confirmé');
  select * into s from public.sessions_caisse where id = p_session and organisation_id = c.organisation_id;
  perform prive.exiger(found and s.statut = 'ouverte', 'Ouvrez une caisse pour encaisser la commande');
  perform prive.exiger(s.magasin_id = c.magasin_id, 'La caisse doit être celle du magasin de la commande');
  if v_moyen is null then
    select id into v_moyen from public.moyens_paiement
     where organisation_id = c.organisation_id and actif
       and code = case c.paiement when 'wave' then 'wave' when 'orange_money' then 'orange_money' when 'mtn' then 'mtn_momo'
                                  when 'moov' then 'moov_money' when 'djamo' then 'djamo' when 'livraison' then 'especes' end;
  end if;
  perform prive.exiger(v_moyen is not null, 'Choisissez le moyen de règlement');

  -- Prix de la commande : catalogue ou solde encore valable ; sinon le prix du catalogue avec une remise.
  -- La remise d'un code promo est répartie sur les articles, au prorata (le reste sur le dernier).
  select jsonb_agg(jsonb_build_object('produit_id', x.produit_id, 'quantite', x.quantite, 'prix_unitaire', x.pu,
                                      'remise', x.remise_prix + case when x.dernier then c.remise - x.parts_avant else x.part end) order by x.ligne)
    into v_lignes
    from (select y.*, coalesce(sum(y.part) over (order by y.ligne rows between unbounded preceding and 1 preceding), 0) parts_avant,
                 y.ligne = max(y.ligne) over () dernier
            from (select l.ligne, l.produit_id, l.quantite,
                         case when l.prix_unitaire = p.prix_vente
                                or l.prix_unitaire = prive.prix_promo(c.organisation_id, p.id, prive.jour_abidjan())
                              then l.prix_unitaire else p.prix_vente end pu,
                         case when l.prix_unitaire = p.prix_vente
                                or l.prix_unitaire = prive.prix_promo(c.organisation_id, p.id, prive.jour_abidjan())
                              then 0 else greatest(0, round(l.quantite * p.prix_vente) - l.montant) end remise_prix,
                         case when c.sous_total > 0 then floor(c.remise::numeric * l.montant / c.sous_total)::bigint else 0 end part
                    from public.commandes_web_lignes l join public.produits p on p.id = l.produit_id
                   where l.commande_id = c.id) y) x;

  -- Remise du code promo : accordée par la boutique, la caissière n'a pas besoin du droit de remise.
  perform set_config('df.remise_commande_web', 'on', true);
  r := public.enregistrer_vente(jsonb_build_object(
         'id', v_vente, 'organisation_id', c.organisation_id, 'session_id', s.id, 'caisse_id', s.caisse_id,
         'origine', 'en_ligne', 'client_nom', c.client_nom || ' (' || c.numero || ')',
         'lignes', v_lignes,
         'reglements', jsonb_build_array(jsonb_build_object(
            'moyen_id', v_moyen, 'montant', c.sous_total - c.remise,
            'reference', coalesce(nullif(btrim(p_reference), ''), c.reference_paiement, c.numero_payeur, c.numero)))));
  perform set_config('df.remise_commande_web', 'off', true);
  update public.commandes_web set vente_id = v_vente, statut = 'livree', livree_le = now(), traitee_par = auth.uid(),
         paiement_statut = 'confirme', paiement_confirme_le = coalesce(paiement_confirme_le, now()),
         paiement_confirme_par = coalesce(paiement_confirme_par, auth.uid()), confirmee_le = coalesce(confirmee_le, now())
   where id = c.id;
  return r;
end $$;

grant execute on function public.compte_marche(), public.compte_marche_enregistrer(jsonb), public.mes_commandes_marche(),
  public.mes_bons_marche(), public.codes_promo_liste(uuid), public.code_promo_enregistrer(uuid, jsonb),
  public.commandes_caisse_attente(uuid) to authenticated;
grant execute on function public.marche_code_promo(text, text) to anon, authenticated;
revoke execute on function public.compte_marche(), public.compte_marche_enregistrer(jsonb), public.mes_commandes_marche(),
  public.codes_promo_liste(uuid), public.code_promo_enregistrer(uuid, jsonb), public.commandes_caisse_attente(uuid) from anon;
