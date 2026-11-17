-- =====================================================================
-- v3.6 — DF Marché : paiement en ligne (Orange Money, Moov, Wave, MTN, Djamo),
-- vérification du paiement selon le mode de remise (retrait : la caisse ;
-- livraison : le responsable), reçus, ventes et arrivages issus de DF Gestion.
-- =====================================================================

alter table public.vitrines
  add column numero_djamo text check (numero_djamo is null or numero_djamo ~ '^[0-9 +]{8,20}$'),
  add column lien_wave text check (lien_wave is null or lien_wave ~ '^https://(pay\.wave\.com|wave\.com)/'),
  add column conditions text check (conditions is null or length(conditions) <= 8000);

alter table public.commandes_web drop constraint commandes_web_paiement_check;
alter table public.commandes_web add constraint commandes_web_paiement_check
  check (paiement in ('livraison','wave','orange_money','mtn','moov','djamo'));
alter table public.commandes_web
  add column paiement_confirme_le timestamptz,
  add column paiement_confirme_par uuid;

create or replace function prive.produit_marche(p public.produits, v public.vitrines) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'designation', p.designation, 'marque', p.marque, 'unite', p.unite, 'photo', p.photo_path,
    'categorie', (select c.nom from public.categories c where c.id = p.categorie_id),
    'prix', coalesce(pr.prix_promo, p.prix_vente), 'prix_normal', p.prix_vente,
    'solde_fin', pr.date_fin,
    'disponible', prive.disponible_en_ligne(v.magasin_id, p.id),
    'boutique', jsonb_build_object('slug', v.slug, 'nom', v.nom, 'commune', v.commune, 'ville', v.ville),
    'note', (select round(avg(a.note), 1) from public.avis_produits a where a.produit_id = p.id and not a.masque),
    'avis', (select count(*) from public.avis_produits a where a.produit_id = p.id and not a.masque),
    'commandes', (select count(distinct l.commande_id) from public.commandes_web_lignes l
                    join public.commandes_web c on c.id = l.commande_id
                   where l.produit_id = p.id and c.statut <> 'annulee'),
    -- Ventes en caisse des 30 derniers jours (tous magasins) : « 45 vendus ce mois ».
    'vendus', (select coalesce(round(sum(vl.quantite)), 0) from public.ventes_lignes vl
                 join public.ventes ve on ve.id = vl.vente_id
                where vl.produit_id = p.id and ve.statut = 'validee' and ve.date_vente > now() - interval '30 days'),
    -- Dernier réapprovisionnement du magasin de la vitrine, s'il date de moins de 10 jours.
    'arrivage', (select max(rc.date_reception) from public.receptions_lignes rl
                   join public.receptions rc on rc.id = rl.reception_id
                  where rl.produit_id = p.id and rc.magasin_id = v.magasin_id and rc.statut = 'validee'
                    and rc.date_reception > prive.jour_abidjan() - 10))
  from (select min(prix_promo) prix_promo, min(date_fin) date_fin from public.promotions
         where organisation_id = p.organisation_id and produit_id = p.id and statut = 'active'
           and prive.jour_abidjan() between date_debut and date_fin) pr
$$;

create or replace function prive.vitrine_publique(v public.vitrines) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'slug', v.slug, 'nom', v.nom, 'activite', v.activite, 'slogan', v.slogan, 'description', v.description,
    'telephone', v.telephone, 'whatsapp', v.whatsapp, 'email', v.email, 'ville', v.ville, 'commune', v.commune,
    'adresse', v.adresse, 'latitude', v.latitude, 'longitude', v.longitude, 'horaires', v.horaires, 'photos', v.photos,
    'logo', o.logo_path, 'couleur', o.couleur,
    'paiement_livraison', v.paiement_livraison, 'numero_wave', v.numero_wave, 'numero_orange', v.numero_orange,
    'numero_mtn', v.numero_mtn, 'numero_moov', v.numero_moov, 'numero_djamo', v.numero_djamo, 'lien_wave', v.lien_wave,
    'conditions', v.conditions, 'beneficiaire', coalesce(v.beneficiaire, v.nom),
    'retrait', v.retrait, 'livraison', v.livraison, 'delai_preparation', v.delai_preparation,
    'commande_minimum', v.commande_minimum,
    'produits', (select count(*) from public.produits p where p.organisation_id = v.organisation_id and p.en_ligne and p.statut = 'actif'),
    'commandes', (select count(*) from public.commandes_web c where c.organisation_id = v.organisation_id and c.statut = 'livree'),
    'note', (select round(avg(a.note), 1) from public.avis_produits a where a.organisation_id = v.organisation_id and not a.masque),
    'avis', (select count(*) from public.avis_produits a where a.organisation_id = v.organisation_id and not a.masque),
    'zones', coalesce((select jsonb_agg(jsonb_build_object('id', z.id, 'nom', z.nom, 'frais', z.frais, 'delai', z.delai) order by z.ordre, z.nom)
                         from public.zones_livraison z where z.organisation_id = v.organisation_id and z.actif), '[]'::jsonb))
  from public.organisations o where o.id = v.organisation_id
$$;

create or replace function public.marche_accueil() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'soldes', coalesce((
      select jsonb_agg(x.f order by x.remise desc) from (
        select distinct on (pm.produit_id) prive.produit_marche(p0, v0) f,
               (pm.prix_normal - pm.prix_promo)::numeric / nullif(pm.prix_normal, 0) remise
          from public.promotions pm
          join public.produits p0 on p0.id = pm.produit_id and p0.en_ligne and p0.statut = 'actif'
          join prive.vitrines_ouvertes() v0 on v0.organisation_id = pm.organisation_id
         where pm.statut = 'active' and prive.jour_abidjan() between pm.date_debut and pm.date_fin
         order by pm.produit_id, pm.prix_promo
         limit 40) x), '[]'::jsonb),
    'boutiques', coalesce((select jsonb_agg(prive.vitrine_publique(v) - 'zones' - 'description' order by v.nom)
                             from prive.vitrines_ouvertes() v), '[]'::jsonb),
    'nouveautes', coalesce((select jsonb_agg(x.f order by x.created_at desc) from (
                              select prive.produit_marche(p0, v0) f, p0.created_at
                                from public.produits p0 join prive.vitrines_ouvertes() v0 on v0.organisation_id = p0.organisation_id
                               where p0.en_ligne and p0.statut = 'actif' order by p0.created_at desc limit 12) x), '[]'::jsonb),
    'populaires', coalesce((select jsonb_agg(prive.produit_marche(p0, v0) order by x.n desc)
                              from (select l.produit_id, count(distinct l.commande_id) n from public.commandes_web_lignes l
                                      join public.commandes_web c on c.id = l.commande_id and c.statut <> 'annulee'
                                     group by l.produit_id order by 2 desc limit 12) x
                              join public.produits p0 on p0.id = x.produit_id and p0.en_ligne and p0.statut = 'actif'
                              join prive.vitrines_ouvertes() v0 on v0.organisation_id = p0.organisation_id), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(distinct c.nom)
                              from public.produits p0 join prive.vitrines_ouvertes() v0 on v0.organisation_id = p0.organisation_id
                              join public.categories c on c.id = p0.categorie_id
                             where p0.en_ligne and p0.statut = 'actif'), '[]'::jsonb),
    'arrivages', coalesce((select jsonb_agg(x.f order by x.d desc) from (
                             select prive.produit_marche(p0, v0) f, max(rc.date_reception) d
                               from public.produits p0 join prive.vitrines_ouvertes() v0 on v0.organisation_id = p0.organisation_id
                               join public.receptions_lignes rl on rl.produit_id = p0.id
                               join public.receptions rc on rc.id = rl.reception_id and rc.magasin_id = v0.magasin_id and rc.statut = 'validee'
                              where p0.en_ligne and p0.statut = 'actif' and rc.date_reception > prive.jour_abidjan() - 10
                              group by p0.*, v0.* order by 2 desc limit 12) x), '[]'::jsonb),
    'activites', coalesce((select jsonb_agg(distinct v.activite) from prive.vitrines_ouvertes() v where v.activite is not null), '[]'::jsonb))
$$;

-- Recherche dans tout le marché ou dans une boutique.
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
begin
  v := prive.vitrine_ouverte(p ->> 'boutique');
  perform prive.exiger(length(btrim(coalesce(p ->> 'client_nom', ''))) between 2 and 80, 'Indiquez votre nom');
  perform prive.exiger(length(v_tel) between 8 and 15, 'Indiquez un numéro de téléphone valide');
  perform prive.exiger(v_mode in ('livraison','retrait'), 'Choisissez la livraison ou le retrait en boutique');
  perform prive.exiger(v_mode <> 'livraison' or v.livraison, 'Cette boutique ne livre pas : choisissez le retrait');
  perform prive.exiger(v_mode <> 'retrait' or v.retrait, 'Cette boutique ne propose que la livraison');
  perform prive.exiger(v_paiement in ('livraison','wave','orange_money','mtn','moov','djamo'), 'Choisissez un moyen de paiement');
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
                                    paiement, numero_payeur, reference_paiement, paiement_statut)
  values (v.organisation_id, v.magasin_id, v_numero, v_code, btrim(p ->> 'client_nom'), v_tel, nullif(btrim(p ->> 'client_email'), ''),
          v_mode, z.id, z.nom, nullif(btrim(p ->> 'adresse'), ''), nullif(btrim(p ->> 'repere'), ''),
          nullif(p ->> 'latitude', '')::numeric, nullif(p ->> 'longitude', '')::numeric, v_souhaite, nullif(btrim(p ->> 'note'), ''),
          v_paiement, nullif(regexp_replace(coalesce(p ->> 'numero_payeur', ''), '[^0-9+]', '', 'g'), ''),
          nullif(btrim(p ->> 'reference_paiement'), ''),
          case when v_paiement = 'livraison' then 'a_la_livraison' else 'a_verifier' end)
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

  update public.commandes_web
     set sous_total = v_sous_total, frais_livraison = coalesce(z.frais, 0), total = v_sous_total + coalesce(z.frais, 0)
   where id = c.id returning * into c;

  return jsonb_build_object('id', c.id, 'numero', c.numero, 'code_suivi', c.code_suivi, 'sous_total', c.sous_total,
                            'frais_livraison', c.frais_livraison, 'total', c.total,
                            'boutique', jsonb_build_object('nom', v.nom, 'whatsapp', coalesce(v.whatsapp, v.telephone),
                                                           'telephone', v.telephone, 'slug', v.slug));
end $$;

-- Suivi d'une commande avec son code (communiqué au client).
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
    'paiement_statut', c.paiement_statut, 'mode', c.mode, 'zone', c.zone_nom, 'adresse', c.adresse, 'souhaite_le', c.souhaite_le,
    'client_nom', c.client_nom, 'sous_total', c.sous_total, 'frais_livraison', c.frais_livraison, 'total', c.total,
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
                                                                      when 'djamo' then v.numero_djamo end,
                                   'lien_wave', v.lien_wave, 'ville', v.ville),
    'lignes', (select jsonb_agg(jsonb_build_object('produit_id', l.produit_id, 'designation', l.designation, 'quantite', l.quantite,
                                                   'prix_unitaire', l.prix_unitaire, 'montant', l.montant,
                                                   'avis', (select a.note from public.avis_produits a
                                                             where a.commande_id = c.id and a.produit_id = l.produit_id)) order by l.ligne)
                 from public.commandes_web_lignes l where l.commande_id = c.id));
end $$;

-- Capture du paiement : déposée par le client (espace « justificatifs », dossier = identifiant de la commande),
-- puis rattachée à la commande.
create or replace function public.vitrine_enregistrer(p_org uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.vitrines;
  v_slug text := lower(btrim(coalesce(p ->> 'slug', '')));
  num text;
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
  insert into public.vitrines (organisation_id, slug, publiee, magasin_id, nom, activite, slogan, description, telephone, whatsapp, email,
                               ville, commune, adresse, latitude, longitude, horaires, photos, paiement_livraison,
                               numero_wave, numero_orange, numero_mtn, numero_moov, beneficiaire, retrait, livraison,
                               delai_preparation, commande_minimum, numero_djamo, lien_wave, conditions)
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
         nullif(btrim(p ->> 'numero_djamo'), ''), nullif(btrim(p ->> 'lien_wave'), ''), nullif(btrim(p ->> 'conditions'), '')
  on conflict (organisation_id) do update set
    slug = excluded.slug, publiee = excluded.publiee, magasin_id = excluded.magasin_id, nom = excluded.nom, activite = excluded.activite,
    slogan = excluded.slogan, description = excluded.description, telephone = excluded.telephone, whatsapp = excluded.whatsapp,
    email = excluded.email, ville = excluded.ville, commune = excluded.commune, adresse = excluded.adresse,
    latitude = excluded.latitude, longitude = excluded.longitude, horaires = excluded.horaires, photos = excluded.photos,
    paiement_livraison = excluded.paiement_livraison, numero_wave = excluded.numero_wave, numero_orange = excluded.numero_orange,
    numero_mtn = excluded.numero_mtn, numero_moov = excluded.numero_moov, beneficiaire = excluded.beneficiaire,
    retrait = excluded.retrait, livraison = excluded.livraison, delai_preparation = excluded.delai_preparation,
    commande_minimum = excluded.commande_minimum, numero_djamo = excluded.numero_djamo, lien_wave = excluded.lien_wave,
    conditions = excluded.conditions, updated_at = now()
  returning * into v;
  perform prive.exiger(not v.publiee or v.telephone is not null or v.whatsapp is not null,
                       'Indiquez un téléphone ou un WhatsApp avant de publier la boutique');
  perform prive.exiger(not v.publiee or not v.livraison
                       or exists (select 1 from public.zones_livraison where organisation_id = p_org and actif),
                       'Ajoutez au moins une zone de livraison, ou proposez seulement le retrait');
  return to_jsonb(v);
end $$;

create or replace function public.verifier_paiement_commande(p_id uuid, p_recu boolean, p_motif text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.commandes_web;
begin
  select * into c from public.commandes_web where id = p_id for update;
  -- Livraison : le responsable (boutique.valider). Retrait : aussi la caissière, à sa caisse.
  perform prive.exiger(found and (prive.a_permission(c.organisation_id, 'boutique.valider')
                                  or (c.mode = 'retrait' and prive.a_permission(c.organisation_id, 'boutique.consulter')
                                      and prive.a_permission(c.organisation_id, 'caisse.creer'))),
                       'Droit « boutique.valider » requis');
  perform prive.exiger(c.paiement <> 'livraison', 'Paiement prévu à la livraison');
  perform prive.exiger(c.statut not in ('livree','annulee'), 'Cette commande est terminée');
  perform prive.exiger(p_recu or length(btrim(coalesce(p_motif, ''))) >= 3, 'Indiquez ce qui ne va pas (visible par le client)');
  update public.commandes_web set paiement_statut = case when p_recu then 'confirme' else 'refuse' end,
         motif = case when p_recu then motif else btrim(p_motif) end, traitee_par = auth.uid(),
         paiement_confirme_le = case when p_recu then now() end, paiement_confirme_par = case when p_recu then auth.uid() end
   where id = p_id returning * into c;
  return to_jsonb(c);
end $$;

-- Remise au client : la commande devient une vente dans la caisse ouverte de la personne qui encaisse
-- (stock, reçu, comptabilité).
-- Les frais de livraison ne sont pas une marchandise : ils restent sur la commande.
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
                                  when 'moov' then 'moov_money' when 'djamo' then 'djamo' else 'especes' end;
  end if;
  perform prive.exiger(v_moyen is not null, 'Choisissez le moyen de règlement');

  -- Prix de la commande : catalogue ou solde encore valable ; sinon le prix du catalogue avec une remise.
  select jsonb_agg(jsonb_build_object(
           'produit_id', l.produit_id, 'quantite', l.quantite,
           'prix_unitaire', case when l.prix_unitaire = p.prix_vente
                                   or l.prix_unitaire = prive.prix_promo(c.organisation_id, p.id, prive.jour_abidjan())
                                 then l.prix_unitaire else p.prix_vente end,
           'remise', case when l.prix_unitaire = p.prix_vente
                            or l.prix_unitaire = prive.prix_promo(c.organisation_id, p.id, prive.jour_abidjan())
                          then 0 else greatest(0, round(l.quantite * p.prix_vente) - l.montant) end) order by l.ligne)
    into v_lignes
    from public.commandes_web_lignes l join public.produits p on p.id = l.produit_id
   where l.commande_id = c.id;

  r := public.enregistrer_vente(jsonb_build_object(
         'id', v_vente, 'organisation_id', c.organisation_id, 'session_id', s.id, 'caisse_id', s.caisse_id,
         'origine', 'en_ligne', 'client_nom', c.client_nom || ' (' || c.numero || ')',
         'lignes', v_lignes,
         'reglements', jsonb_build_array(jsonb_build_object(
            'moyen_id', v_moyen, 'montant', c.sous_total,
            'reference', coalesce(nullif(btrim(p_reference), ''), c.reference_paiement, c.numero_payeur, c.numero)))));
  update public.commandes_web set vente_id = v_vente, statut = 'livree', livree_le = now(), traitee_par = auth.uid(),
         paiement_statut = 'confirme', paiement_confirme_le = coalesce(paiement_confirme_le, now()),
         paiement_confirme_par = coalesce(paiement_confirme_par, auth.uid()), confirmee_le = coalesce(confirmee_le, now())
   where id = c.id;
  return r;
end $$;

create or replace function public.commande_web_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.commandes_web;
begin
  select * into c from public.commandes_web where id = p_id;
  perform prive.exiger(found and prive.a_permission(c.organisation_id, 'boutique.consulter'), 'Commande introuvable');
  return to_jsonb(c) || jsonb_build_object(
    'lignes', (select jsonb_agg(jsonb_build_object('produit_id', l.produit_id, 'designation', l.designation, 'quantite', l.quantite,
                                                   'prix_unitaire', l.prix_unitaire, 'prix_normal', l.prix_normal, 'montant', l.montant,
                                                   'stock', coalesce((select s.quantite from public.stocks s
                                                                       where s.magasin_id = c.magasin_id and s.produit_id = l.produit_id), 0))
                                order by l.ligne) from public.commandes_web_lignes l where l.commande_id = c.id),
    'vente', (select jsonb_build_object('id', ve.id, 'numero', ve.numero) from public.ventes ve where ve.id = c.vente_id),
    'confirme_par', (select coalesce(pr.nom_complet, pr.email) from public.profils pr where pr.id = c.paiement_confirme_par),
    'commandes_client', (select count(*) from public.commandes_web where organisation_id = c.organisation_id
                           and client_telephone = c.client_telephone and statut = 'livree'),
    'numero_boutique', (select case c.paiement when 'wave' then v.numero_wave when 'orange_money' then v.numero_orange
                                                when 'mtn' then v.numero_mtn when 'moov' then v.numero_moov
                                                when 'djamo' then v.numero_djamo end
                          from public.vitrines v where v.organisation_id = c.organisation_id));
end $$;

-- Nombre de commandes à traiter (pastille du menu, alerte).
