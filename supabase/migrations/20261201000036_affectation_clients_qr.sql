-- =====================================================================
-- DF Gestion 3.9 — Affectation des commandes en ligne, clients du site,
-- code promo / QR en caisse, moyens de paiement désactivables,
-- comptabilité reliée (pertes, ajustements, frais de livraison).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Affectation : la gérante choisit la caissière qui rassemble la commande
-- ---------------------------------------------------------------------

alter table public.commandes_web
  add column caissier_id uuid references auth.users(id),
  add column affectee_le timestamptz,
  add column affectee_par uuid references auth.users(id);
create index commandes_web_caissier_idx on public.commandes_web (caissier_id) where vente_id is null;

-- Personne de l'équipe qui peut encaisser dans le magasin de la commande.
create function prive.peut_encaisser_magasin(p_org uuid, p_user uuid, p_magasin uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select prive.permission_du_membre(m, 'ventes.creer')
                          and prive.permission_du_membre(m, 'boutique.consulter')
                          and (m.role_code = 'proprietaire' or m.tous_magasins
                               or exists (select 1 from public.membre_magasins mm where mm.membre_id = m.id and mm.magasin_id = p_magasin))
                     from public.membres m
                    where m.organisation_id = p_org and m.user_id = p_user and m.actif), false)
$$;

create function public.caissiers_commande(p_org uuid, p_magasin uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.valider'), 'Droit « boutique.valider » requis');
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

create function public.affecter_commande_web(p_id uuid, p_caissier uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.commandes_web;
begin
  select * into c from public.commandes_web where id = p_id for update;
  perform prive.exiger(found and prive.a_permission(c.organisation_id, 'boutique.valider'), 'Droit « boutique.valider » requis');
  perform prive.exiger(prive.acces_magasin(c.organisation_id, c.magasin_id), 'Cette commande concerne un autre magasin');
  perform prive.exiger(c.statut not in ('livree','annulee') and c.vente_id is null, 'Cette commande est terminée');
  perform prive.exiger(p_caissier is null or prive.peut_encaisser_magasin(c.organisation_id, p_caissier, c.magasin_id),
                       'Cette personne ne peut pas encaisser dans ce magasin');
  update public.commandes_web
     set caissier_id = p_caissier, affectee_le = case when p_caissier is null then null else now() end,
         affectee_par = case when p_caissier is null then null else auth.uid() end, traitee_par = auth.uid(),
         -- Affecter vaut confirmation : le client voit sa commande « confirmée ».
         statut = case when p_caissier is not null and statut = 'nouvelle' then 'confirmee' else statut end,
         confirmee_le = case when p_caissier is not null and statut = 'nouvelle' then now() else confirmee_le end
   where id = p_id returning * into c;
  return to_jsonb(c);
end $$;

-- La caissière affectée peut marquer la commande « prête » (rassemblée, vérifiée).
create or replace function public.avancer_commande_web(p_id uuid, p_statut text, p_motif text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.commandes_web;
begin
  select * into c from public.commandes_web where id = p_id for update;
  perform prive.exiger(found and (prive.a_permission(c.organisation_id, 'boutique.valider')
                                  or (p_statut = 'prete' and c.caissier_id = auth.uid()
                                      and prive.a_permission(c.organisation_id, 'boutique.consulter'))),
                       'Droit « boutique.valider » requis');
  perform prive.exiger(prive.acces_magasin(c.organisation_id, c.magasin_id), 'Cette commande concerne un autre magasin');
  perform prive.exiger(c.statut not in ('livree','annulee'), 'Cette commande est terminée');
  if p_statut = 'annulee' then
    perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Indiquez le motif de l''annulation (il sera visible par le client)');
    update public.commandes_web set statut = 'annulee', motif = btrim(p_motif), annulee_le = now(), traitee_par = auth.uid()
     where id = p_id returning * into c;
  else
    perform prive.exiger(
      (c.statut = 'nouvelle' and p_statut = 'confirmee') or (c.statut = 'confirmee' and p_statut = 'prete')
      or (c.statut = 'prete' and p_statut = 'en_livraison' and c.mode = 'livraison'),
      'Étape non permise');
    perform prive.exiger(p_statut <> 'en_livraison' or c.paiement_statut in ('confirme','a_la_livraison'),
                         'Vérifiez d''abord le paiement reçu');
    update public.commandes_web set statut = p_statut, traitee_par = auth.uid(),
           confirmee_le = case when p_statut = 'confirmee' then now() else confirmee_le end,
           prete_le = case when p_statut = 'prete' then now() else prete_le end,
           expediee_le = case when p_statut = 'en_livraison' then now() else expediee_le end
     where id = p_id returning * into c;
  end if;
  return to_jsonb(c);
end $$;

-- Vérification du paiement : le responsable, ou la caissière à qui la commande est affectée.
create or replace function public.verifier_paiement_commande(p_id uuid, p_recu boolean, p_motif text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.commandes_web;
begin
  select * into c from public.commandes_web where id = p_id for update;
  perform prive.exiger(found and (prive.a_permission(c.organisation_id, 'boutique.valider')
                                  or (c.caissier_id = auth.uid() and prive.a_permission(c.organisation_id, 'boutique.consulter'))),
                       'Cette commande ne vous est pas affectée');
  perform prive.exiger(c.paiement <> 'livraison', 'Paiement prévu à la livraison');
  perform prive.exiger(c.statut not in ('livree','annulee'), 'Cette commande est terminée');
  perform prive.exiger(p_recu or length(btrim(coalesce(p_motif, ''))) >= 3, 'Indiquez ce qui ne va pas (visible par le client)');
  update public.commandes_web set paiement_statut = case when p_recu then 'confirme' else 'refuse' end,
         motif = case when p_recu then motif else btrim(p_motif) end, traitee_par = auth.uid(),
         paiement_confirme_le = case when p_recu then now() end, paiement_confirme_par = case when p_recu then auth.uid() end
   where id = p_id returning * into c;
  return to_jsonb(c);
end $$;

-- Remise au client : seulement la caissière affectée (ou le responsable).
-- Plus de remise directe d'une commande « nouvelle » : elle doit d'abord être affectée.
do $$
declare
  v_def text := pg_get_functiondef('public.encaisser_commande_web(uuid,uuid,uuid,text)'::regprocedure);
  v_a text := $a$perform prive.exiger(found and prive.a_permission(c.organisation_id, 'boutique.consulter'), 'Droit « boutique.consulter » requis');$a$;
  v_b text := $b$perform prive.exiger(c.statut in ('confirmee','prete','en_livraison') or (c.mode = 'retrait' and c.statut = 'nouvelle'),$b$;
begin
  if position(v_a in v_def) = 0 or position(v_b in v_def) = 0 then
    raise exception 'encaisser_commande_web : point d''insertion introuvable';
  end if;
  v_def := replace(v_def, v_a,
    $n$perform prive.exiger(found and (prive.a_permission(c.organisation_id, 'boutique.valider')
                                  or (c.caissier_id = auth.uid() and prive.a_permission(c.organisation_id, 'boutique.consulter'))),
                       'Cette commande ne vous est pas affectée : demandez à la gérante de vous l''affecter');$n$);
  v_def := replace(v_def, v_b,
    $n$perform prive.exiger(c.statut in ('confirmee','prete','en_livraison')
                         or (c.mode = 'retrait' and c.statut = 'nouvelle' and prive.a_permission(c.organisation_id, 'boutique.valider')),$n$);
  execute v_def;
end $$;

-- Alerte de l'application : commandes affectées à moi, et (gérante) commandes à affecter.
create or replace function public.commandes_caisse_attente(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when prive.a_permission(p_org, 'boutique.consulter') then jsonb_build_object(
    'nombre', (select count(*) from public.commandes_web
                where organisation_id = p_org and vente_id is null and caissier_id = auth.uid()
                  and statut in ('confirmee','prete','en_livraison')),
    'a_affecter', case when prive.a_permission(p_org, 'boutique.valider') then
                    (select count(*) from public.commandes_web
                      where organisation_id = p_org and vente_id is null and caissier_id is null
                        and statut in ('nouvelle','confirmee','prete') and prive.acces_magasin(organisation_id, magasin_id))
                  else 0 end,
    'gerante', prive.a_permission(p_org, 'boutique.valider'),
    'derniere', (select max(created_at) from public.commandes_web where organisation_id = p_org and statut = 'nouvelle'),
    'derniere_affectation', (select max(affectee_le) from public.commandes_web where organisation_id = p_org and caissier_id = auth.uid()))
  else jsonb_build_object('nombre', 0, 'a_affecter', 0) end
$$;

-- Écran « Commandes à remettre » de la caisse : mes commandes affectées
-- (le responsable voit toutes les commandes affectées encore à remettre).
create function public.commandes_caisse(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_resp boolean := prive.a_permission(p_org, 'boutique.valider');
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.consulter'), 'Droit « boutique.consulter » requis');
  return jsonb_build_object('commandes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'numero', c.numero, 'client_nom', c.client_nom, 'client_telephone', c.client_telephone, 'mode', c.mode,
        'zone', c.zone_nom, 'souhaite_le', c.souhaite_le, 'total', c.total, 'paiement', c.paiement, 'paiement_statut', c.paiement_statut,
        'justificatif', c.justificatif_path is not null, 'statut', c.statut, 'created_at', c.created_at,
        'caissier_id', c.caissier_id, 'affectee_le', c.affectee_le, 'a_moi', c.caissier_id = auth.uid(),
        'caissier_nom', (select coalesce(nullif(btrim(pr.nom_complet), ''), pr.email) from public.profils pr where pr.id = c.caissier_id),
        'articles', (select coalesce(sum(quantite), 0) from public.commandes_web_lignes where commande_id = c.id))
        order by (c.caissier_id = auth.uid()) desc, c.affectee_le desc nulls last)
      from public.commandes_web c
     where c.organisation_id = p_org and c.vente_id is null and c.statut in ('confirmee','prete','en_livraison')
       and (c.caissier_id = auth.uid() or (v_resp and c.caissier_id is not null and prive.acces_magasin(p_org, c.magasin_id)))),
     '[]'::jsonb));
end $$;

-- Listes et détail : la personne affectée.
do $$
declare
  v_def text := pg_get_functiondef('public.commandes_web_liste(uuid,text)'::regprocedure);
  v_a text := $a$'statut', c.statut, 'created_at', c.created_at,$a$;
begin
  if position(v_a in v_def) = 0 then raise exception 'commandes_web_liste : point d''insertion introuvable'; end if;
  execute replace(v_def, v_a, v_a || $n$
        'caissier_id', c.caissier_id,
        'caissier_nom', (select coalesce(nullif(btrim(pr.nom_complet), ''), pr.email) from public.profils pr where pr.id = c.caissier_id),$n$);

  v_def := pg_get_functiondef('public.commande_web_detail(uuid)'::regprocedure);
  v_a := $a$'confirme_par', ($a$;
  if position(v_a in v_def) = 0 then raise exception 'commande_web_detail : point d''insertion introuvable'; end if;
  execute replace(v_def, v_a, $n$'caissier_nom', (select coalesce(nullif(btrim(pr.nom_complet), ''), pr.email) from public.profils pr where pr.id = c.caissier_id),
    'affectee_par_nom', (select coalesce(nullif(btrim(pr.nom_complet), ''), pr.email) from public.profils pr where pr.id = c.affectee_par),
    $n$ || v_a);
end $$;

-- ---------------------------------------------------------------------
-- 2. Clients du site : photo de profil, liste et fiche pour les boutiques
-- ---------------------------------------------------------------------

alter table public.clients_marche add column photo_path text check (photo_path is null or length(photo_path) <= 200);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clients', 'clients', true, 524288, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;
-- Chaque client dépose sa photo dans son propre dossier (<id du compte>/…).
create policy df_clients_photo_depot on storage.objects for insert to authenticated
  with check (bucket_id = 'clients' and split_part(name, '/', 1) = auth.uid()::text);
create policy df_clients_photo_modif on storage.objects for update to authenticated
  using (bucket_id = 'clients' and split_part(name, '/', 1) = auth.uid()::text);
create policy df_clients_photo_suppr on storage.objects for delete to authenticated
  using (bucket_id = 'clients' and split_part(name, '/', 1) = auth.uid()::text);

create or replace function public.compte_marche() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'nom', c.nom, 'telephone', c.telephone, 'adresse', c.adresse, 'repere', c.repere,
                            'commune', c.commune, 'email', u.email, 'depuis', c.created_at, 'photo_path', c.photo_path,
                            'commandes', (select count(*) from public.commandes_web w where w.compte_id = c.id))
    from public.clients_marche c join auth.users u on u.id = c.id
   where c.id = auth.uid()
$$;

create or replace function public.compte_marche_enregistrer(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tel text := nullif(regexp_replace(coalesce(p ->> 'telephone', ''), '[^0-9+]', '', 'g'), '');
  v_photo text := nullif(btrim(coalesce(p ->> 'photo_path', '')), '');
begin
  perform prive.exiger(auth.uid() is not null, 'Connectez-vous d''abord');
  perform prive.exiger(length(btrim(coalesce(p ->> 'nom', ''))) between 2 and 80, 'Indiquez votre nom');
  perform prive.exiger(v_photo is null or split_part(v_photo, '/', 1) = auth.uid()::text, 'Photo invalide');
  insert into public.clients_marche (id, nom, telephone, adresse, repere, commune, photo_path)
  values (auth.uid(), btrim(p ->> 'nom'), v_tel, nullif(btrim(p ->> 'adresse'), ''), nullif(btrim(p ->> 'repere'), ''),
          nullif(btrim(p ->> 'commune'), ''), v_photo)
  on conflict (id) do update set nom = excluded.nom, telephone = excluded.telephone, adresse = excluded.adresse,
                                 repere = excluded.repere, commune = excluded.commune,
                                 photo_path = case when p ? 'photo_path' then excluded.photo_path else public.clients_marche.photo_path end,
                                 updated_at = now();
  return public.compte_marche();
end $$;

-- Tous les comptes du site, avec leurs commandes dans ma boutique.
create function public.clients_marche_liste(p_org uuid, p_q text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_q text := nullif(lower(btrim(coalesce(p_q, ''))), '');
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.consulter'), 'Droit « boutique.consulter » requis');
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.derniere_commande desc nulls last, x.inscrit_le desc) from (
    select cm.id, cm.nom, u.email, cm.telephone, cm.commune, cm.photo_path, cm.created_at inscrit_le,
           count(c.id) filter (where c.statut <> 'annulee') commandes,
           coalesce(sum(c.total) filter (where c.statut = 'livree'), 0) achats,
           max(c.created_at) derniere_commande,
           (select count(*) from public.codes_promo k where k.organisation_id = p_org and k.compte_id = cm.id and k.actif) codes
      from public.clients_marche cm
      join auth.users u on u.id = cm.id
      left join public.commandes_web c on c.compte_id = cm.id and c.organisation_id = p_org
     where v_q is null or lower(cm.nom) like '%' || v_q || '%' or lower(coalesce(u.email, '')) like '%' || v_q || '%'
        or coalesce(cm.telephone, '') like '%' || regexp_replace(v_q, '[^0-9]', '', 'g') || '%' and length(regexp_replace(v_q, '[^0-9]', '', 'g')) >= 3
     group by cm.id, u.email
     order by max(c.created_at) desc nulls last, cm.created_at desc
     limit 300) x), '[]'::jsonb);
end $$;

create function public.client_marche_detail(p_org uuid, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.consulter'), 'Droit « boutique.consulter » requis');
  select jsonb_build_object('id', cm.id, 'nom', cm.nom, 'email', u.email, 'telephone', cm.telephone, 'adresse', cm.adresse,
                            'repere', cm.repere, 'commune', cm.commune, 'photo_path', cm.photo_path, 'inscrit_le', cm.created_at)
    into r
    from public.clients_marche cm join auth.users u on u.id = cm.id where cm.id = p_id;
  perform prive.exiger(r is not null, 'Client introuvable');
  return r || jsonb_build_object(
    'commandes', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'numero', c.numero, 'created_at', c.created_at,
                                                               'total', c.total, 'statut', c.statut, 'mode', c.mode,
                                                               'paiement', c.paiement, 'code_promo', c.code_promo, 'remise', c.remise)
                                            order by c.created_at desc)
                             from public.commandes_web c where c.organisation_id = p_org and c.compte_id = p_id), '[]'::jsonb),
    'codes', coalesce((select jsonb_agg(to_jsonb(k) order by k.created_at desc)
                         from public.codes_promo k where k.organisation_id = p_org and k.compte_id = p_id), '[]'::jsonb),
    'slug', (select slug from public.vitrines where organisation_id = p_org));
end $$;

-- Code promo : le client peut aussi être choisi directement dans la liste (compte_id).
do $$
declare
  v_def text := pg_get_functiondef('public.code_promo_enregistrer(uuid,jsonb)'::regprocedure);
  v_a text := $a$  if v_client is not null then$a$;
begin
  if position(v_a in v_def) = 0 then raise exception 'code_promo_enregistrer : point d''insertion introuvable'; end if;
  execute replace(v_def, v_a, $n$  if nullif(p ->> 'compte_id', '') is not null then
    select id into v_compte from public.clients_marche where id = (p ->> 'compte_id')::uuid;
    perform prive.exiger(v_compte is not null, 'Compte client introuvable');
  elsif v_client is not null then$n$);
end $$;

-- ---------------------------------------------------------------------
-- 3. Code promo / QR à la caisse
-- ---------------------------------------------------------------------

alter table public.ventes add column code_promo text;

-- Lecture d'un code pour la caisse (le QR contient le lien de l'offre : on garde le dernier segment).
create function public.code_promo_caisse_verifier(p_org uuid, p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  k public.codes_promo;
  v_code text := upper(btrim(regexp_replace(coalesce(p_code, ''), '^.*/', '')));
begin
  perform prive.exiger(prive.a_permission(p_org, 'ventes.creer'), 'Droit « ventes.creer » requis');
  select * into k from public.codes_promo where organisation_id = p_org and code = v_code;
  perform prive.exiger(found, 'Code inconnu dans cette boutique');
  perform prive.exiger(prive.code_promo_valable(k, k.compte_id), 'Ce code n''est plus valable (dates, nombre d''utilisations ou désactivé)');
  return jsonb_build_object('code', k.code, 'libelle', k.libelle, 'type', k.type, 'valeur', k.valeur, 'minimum', k.minimum,
                            'fin', k.fin, 'client', (select cm.nom from public.clients_marche cm where cm.id = k.compte_id));
end $$;

-- Contrôle d'une vente portant un code : les remises des lignes ne dépassent pas ce que le code accorde.
create function prive.code_promo_caisse(p_org uuid, p_vente_id uuid, p_vente jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k public.codes_promo;
  v_code text := upper(btrim(regexp_replace(p_vente ->> 'code_promo', '^.*/', '')));
  v_brut bigint;
  v_remises bigint;
  v_permis bigint;
begin
  select * into k from public.codes_promo where organisation_id = p_org and code = v_code for update;
  perform prive.exiger(found and prive.code_promo_valable(k, k.compte_id), 'Code promo non valable : ' || v_code);
  select coalesce(sum(round((l ->> 'quantite')::numeric * coalesce((l ->> 'prix_unitaire')::bigint, p.prix_vente))), 0)::bigint,
         coalesce(sum(coalesce((l ->> 'remise')::bigint, 0)), 0)::bigint
    into v_brut, v_remises
    from jsonb_array_elements(p_vente -> 'lignes') l
    left join public.produits p on p.id = (l ->> 'produit_id')::uuid and p.organisation_id = p_org;
  perform prive.exiger(v_brut >= k.minimum, format('Ce code demande au moins %s FCFA d''achat', k.minimum));
  v_permis := case k.type when 'pourcent' then round(v_brut * k.valeur / 100.0)::bigint else least(k.valeur, v_brut) end;
  perform prive.exiger(v_remises <= v_permis, format('Remise supérieure à celle du code (%s FCFA au plus)', v_permis));
  update public.codes_promo set utilisations = utilisations + 1 where id = k.id;
  update public.ventes set code_promo = k.code where id = p_vente_id;
  -- La remise est accordée par la boutique : la caissière n'a pas besoin du droit de remise.
  perform set_config('df.remise_commande_web', 'on', true);
end $$;

do $$
declare
  v_def text := pg_get_functiondef('public.enregistrer_vente(jsonb)'::regprocedure);
  v_a text := $a$  for l in select * from jsonb_array_elements(p_vente -> 'lignes') loop$a$;
begin
  if position(v_a in v_def) = 0 then raise exception 'enregistrer_vente : point d''insertion introuvable'; end if;
  execute replace(v_def, v_a, $n$  -- Code promo (QR du client) : vérifié et compté une seule fois.
  if nullif(btrim(coalesce(p_vente ->> 'code_promo', '')), '') is not null then
    perform prive.code_promo_caisse(v_org, v_id, p_vente);
  end if;

$n$ || v_a);
end $$;

-- ---------------------------------------------------------------------
-- 4. Moyens de paiement : cocher / décocher sans perdre les numéros
-- ---------------------------------------------------------------------

alter table public.vitrines add column paiements_inactifs jsonb not null default '{}'::jsonb;

create function public.vitrine_paiements_inactifs(p_org uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.modifier'), 'Droit « boutique.modifier » requis');
  perform prive.exiger(jsonb_typeof(coalesce(p, '{}'::jsonb)) = 'object' and length(coalesce(p, '{}'::jsonb)::text) <= 8000,
                       'Données invalides');
  update public.vitrines set paiements_inactifs = coalesce(p, '{}'::jsonb) where organisation_id = p_org;
  return coalesce(p, '{}'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 5. Comptabilité reliée : pertes, consommation, ajustements, frais de livraison
-- ---------------------------------------------------------------------

create or replace function prive.creer_plan_comptable(p_org uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.plan_comptable (organisation_id, numero, libelle)
  select p_org, n, l from (values
    ('101', 'Capital social'), ('121', 'Report à nouveau créditeur'), ('129', 'Report à nouveau débiteur'),
    ('131', 'Résultat net : bénéfice'), ('139', 'Résultat net : perte'), ('162', 'Emprunts auprès des établissements de crédit'),
    ('21', 'Immobilisations incorporelles'), ('24', 'Matériel, mobilier et actifs biologiques'), ('245', 'Matériel de transport'),
    ('284', 'Amortissements du matériel'), ('31', 'Marchandises'),
    ('401', 'Fournisseurs'), ('411', 'Clients'), ('421', 'Personnel, avances et acomptes'), ('431', 'Sécurité sociale (CNPS)'),
    ('4431', 'TVA facturée sur ventes'), ('4452', 'TVA récupérable sur achats'), ('447', 'État, impôts retenus à la source'),
    ('471', 'Débiteurs et créditeurs divers (attente)'),
    ('5211', 'Banque'), ('551', 'Monnaie électronique (Mobile Money)'), ('5711', 'Caisse (tiroirs)'), ('5712', 'Caisse centrale'),
    ('5800', 'Autres trésoreries'), ('585', 'Virements de fonds'),
    ('601', 'Achats de marchandises'), ('6015', 'Frais sur achats (transport, manutention, douane)'), ('6031', 'Variation des stocks de marchandises'),
    ('6051', 'Fournitures non stockables — eau'), ('6052', 'Fournitures non stockables — électricité'),
    ('618', 'Autres frais de transport'), ('622', 'Locations et charges locatives'), ('624', 'Entretien, réparations et maintenance'),
    ('627', 'Publicité, publications, relations publiques'), ('628', 'Frais de télécommunications'), ('631', 'Frais bancaires et Mobile Money'),
    ('64', 'Impôts et taxes'), ('658', 'Charges diverses'),
    ('6581', 'Pertes de marchandises (casse, vol, avarie, périmés)'), ('6582', 'Consommation interne de marchandises'),
    ('6583', 'Écarts d''inventaire : manquants'),
    ('661', 'Rémunérations directes versées au personnel'),
    ('664', 'Charges sociales'), ('67', 'Frais financiers'), ('681', 'Dotations aux amortissements d''exploitation'),
    ('701', 'Ventes de marchandises'), ('7019', 'Remises accordées (codes promo, remises de caisse)'), ('706', 'Services vendus (frais de livraison)'), ('758', 'Produits divers'),
    ('7583', 'Écarts d''inventaire : excédents'), ('77', 'Revenus financiers'), ('89', 'Impôts sur le résultat')
  ) v(n, l)
  on conflict do nothing
$$;
do $$ begin perform prive.creer_plan_comptable(id) from public.organisations; end $$;

do $$
declare
  v_def text := pg_get_functiondef('prive.generer_ecritures(uuid,date)'::regprocedure);
  v_a text := $a$  -- 9. Fin de mois : variation de stock (6031 / 31) au coût moyen pondéré.$a$;
begin
  if position(v_a in v_def) = 0 then raise exception 'generer_ecritures : point d''insertion introuvable'; end if;
  execute replace(v_def, v_a, $n$  -- 10. Sorties et entrées de stock hors ventes et achats : reclassées hors de la variation de stock,
  --     pour voir ce que coûtent les pertes, la consommation et les écarts d'inventaire.
  for r in
    select (ms.created_at at time zone 'Africa/Abidjan')::date jour, ms.type, (-sum(ms.valeur))::bigint montant
      from public.mouvements_stock ms
     where ms.organisation_id = p_org
       and ms.type in ('perte','casse','vol','avarie','peremption','consommation',
                       'ajustement_moins','inventaire_moins','ajustement_plus','inventaire_plus')
       and (ms.created_at at time zone 'Africa/Abidjan')::date >= v_m0 and (ms.created_at at time zone 'Africa/Abidjan')::date < v_m1
     group by 1, 2
    having sum(ms.valeur) <> 0
  loop
    perform prive.ajouter_ecriture(p_org, r.jour, 'OD',
      case r.type when 'perte' then 'Perte de marchandises' when 'casse' then 'Casse de marchandises'
                  when 'vol' then 'Vol de marchandises' when 'avarie' then 'Marchandises avariées'
                  when 'peremption' then 'Marchandises périmées' when 'consommation' then 'Consommation interne'
                  when 'ajustement_moins' then 'Ajustement de stock (manquant)' when 'inventaire_moins' then 'Inventaire : manquants'
                  when 'ajustement_plus' then 'Ajustement de stock (excédent)' else 'Inventaire : excédents' end,
      case when r.montant > 0
           then jsonb_build_array(
                  jsonb_build_object('compte', case when r.type = 'consommation' then '6582'
                                                    when r.type in ('ajustement_moins','inventaire_moins') then '6583'
                                                    else '6581' end, 'debit', r.montant),
                  jsonb_build_object('compte', '6031', 'credit', r.montant))
           else jsonb_build_array(jsonb_build_object('compte', '6031', 'debit', -r.montant),
                                  jsonb_build_object('compte', '7583', 'credit', -r.montant)) end,
      null, 'mouvement_stock', null);
  end loop;

  -- 11. Frais de livraison des commandes en ligne remises : un service vendu (706),
  --     encaissé sur le même compte que la commande.
  for r in
    select c.id, c.numero, c.frais_livraison, (c.livree_le at time zone 'Africa/Abidjan')::date jour,
           (select prive.compte_de(coalesce(
                     case when mp.nature = 'especes' then (select ct.id from public.comptes_tresorerie ct
                            where ct.organisation_id = p_org and ct.caisse_id = v.caisse_id and ct.actif order by ct.ordre limit 1) end,
                     mp.compte_id))
              from public.reglements rg join public.moyens_paiement mp on mp.id = rg.moyen_id
             where rg.vente_id = v.id and rg.statut = 'enregistre' order by rg.montant desc limit 1) compte
      from public.commandes_web c join public.ventes v on v.id = c.vente_id and v.statut = 'validee'
     where c.organisation_id = p_org and c.statut = 'livree' and c.frais_livraison > 0
       and (c.livree_le at time zone 'Africa/Abidjan')::date >= v_m0 and (c.livree_le at time zone 'Africa/Abidjan')::date < v_m1
  loop
    perform prive.ajouter_ecriture(p_org, r.jour, 'VT', 'Frais de livraison · commande ' || r.numero,
      jsonb_build_array(jsonb_build_object('compte', coalesce(r.compte, '471'), 'debit', r.frais_livraison),
                        jsonb_build_object('compte', '706', 'credit', r.frais_livraison)),
      r.numero, 'commande_web', r.id);
  end loop;

  -- 12. Remises accordées (codes promo, remises de caisse) : le chiffre d'affaires brut reste visible en 701,
  --     les remises en 7019 (le net encaissé ne change pas).
  for r in
    select (v.date_vente at time zone 'Africa/Abidjan')::date jour,
           sum(case when v_tva and l.taux_tva > 0 then round(l.remise / (1 + l.taux_tva / 100)) else l.remise end)::bigint remises
      from public.ventes v join public.ventes_lignes l on l.vente_id = v.id
     where v.organisation_id = p_org and v.statut = 'validee' and l.remise > 0
       and (v.date_vente at time zone 'Africa/Abidjan')::date >= v_m0 and (v.date_vente at time zone 'Africa/Abidjan')::date < v_m1
     group by 1
  loop
    perform prive.ajouter_ecriture(p_org, r.jour, 'VT', 'Remises accordées du jour',
      jsonb_build_array(jsonb_build_object('compte', '7019', 'debit', r.remises),
                        jsonb_build_object('compte', '701', 'credit', r.remises)),
      null, 'remises_jour', null);
  end loop;

$n$ || v_a);
end $$;

-- ---------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------
revoke execute on function prive.peut_encaisser_magasin(uuid, uuid, uuid), prive.code_promo_caisse(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.caissiers_commande(uuid, uuid), public.affecter_commande_web(uuid, uuid), public.commandes_caisse(uuid),
  public.clients_marche_liste(uuid, text), public.client_marche_detail(uuid, uuid), public.code_promo_caisse_verifier(uuid, text),
  public.vitrine_paiements_inactifs(uuid, jsonb) to authenticated;
revoke execute on function public.caissiers_commande(uuid, uuid), public.affecter_commande_web(uuid, uuid), public.commandes_caisse(uuid),
  public.clients_marche_liste(uuid, text), public.client_marche_detail(uuid, uuid), public.code_promo_caisse_verifier(uuid, text),
  public.vitrine_paiements_inactifs(uuid, jsonb) from anon, public;
