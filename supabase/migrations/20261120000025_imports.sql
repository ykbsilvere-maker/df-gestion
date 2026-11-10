-- 2.1 — Import en masse depuis Excel : catalogue (articles), fournisseurs et approvisionnements.
-- Chaque ligne est traitée à part : une ligne fausse est signalée avec son numéro sans bloquer
-- les autres. Les droits sont ceux de la saisie à la main.

-- Retrouver un article par code interne, code-barres ou désignation (sans accents ni casse).
create function prive.trouver_produit(p_org uuid, p_code text, p_code_barres text, p_designation text) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select id from public.produits where organisation_id = p_org and nullif(btrim(p_code), '') is not null
        and upper(code) = upper(btrim(p_code))),
    (select produit_id from public.codes_barres where organisation_id = p_org and nullif(btrim(p_code_barres), '') is not null
        and code = btrim(p_code_barres)),
    (select id from public.produits where organisation_id = p_org and nullif(btrim(p_designation), '') is not null
        and prive.normaliser(designation) = prive.normaliser(btrim(p_designation))
      order by created_at limit 1))
$$;

create function prive.categorie_par_nom(p_org uuid, p_nom text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if nullif(btrim(coalesce(p_nom, '')), '') is null then return null; end if;
  select id into v_id from public.categories
   where organisation_id = p_org and prive.normaliser(nom) = prive.normaliser(btrim(p_nom)) limit 1;
  if v_id is null then
    insert into public.categories (organisation_id, nom) values (p_org, left(btrim(p_nom), 80)) returning id into v_id;
  end if;
  return v_id;
end $$;

create function prive.fournisseur_par_nom(p_org uuid, p_nom text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if nullif(btrim(coalesce(p_nom, '')), '') is null then return null; end if;
  select id into v_id from public.fournisseurs
   where organisation_id = p_org and prive.normaliser(nom) = prive.normaliser(btrim(p_nom));
  if v_id is null then
    insert into public.fournisseurs (organisation_id, nom) values (p_org, left(btrim(p_nom), 120)) returning id into v_id;
  end if;
  return v_id;
end $$;

-- Montant lu dans une cellule : « 5 000 », « 5000 F », « 5 000,00 » → 5000.
create function prive.montant_import(p text) returns bigint
language sql immutable set search_path = '' as $$
  select case when nullif(btrim(coalesce(p, '')), '') is null then null
              else round(replace(regexp_replace(p, '[^0-9,.-]', '', 'g'), ',', '.')::numeric)::bigint end
$$;

create function prive.nombre_import(p text) returns numeric
language sql immutable set search_path = '' as $$
  select case when nullif(btrim(coalesce(p, '')), '') is null then null
              else replace(regexp_replace(p, '[^0-9,.-]', '', 'g'), ',', '.')::numeric end
$$;

-- ---------------------------------------------------------------------------------------------
-- Catalogue : crée les articles absents, met à jour les existants si demandé.
-- Ligne : code, designation, categorie, marque, unite, prix_vente, prix_achat, taux_tva,
--         seuil_min, seuil_max, code_barres, gere_peremption.
create function public.importer_catalogue(p_org uuid, p_lignes jsonb, p_mettre_a_jour boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  l jsonb;
  n int := 0;
  v_id uuid;
  v_existe boolean;
  v_cb text;
  v_tva numeric;
  v_res jsonb := '[]'::jsonb;
  v_crees int := 0;
  v_maj int := 0;
  v_err int := 0;
  v_ignores int := 0;
  v_msg text;
  v_code text;
begin
  perform prive.exiger(prive.a_permission(p_org, 'catalogue.creer'), 'Droit « catalogue.creer » requis pour importer des articles');
  perform prive.exiger(jsonb_typeof(p_lignes) = 'array' and jsonb_array_length(p_lignes) <= 1000,
                       'Envoyez au plus 1 000 lignes à la fois');
  for l in select * from jsonb_array_elements(p_lignes) loop
    n := n + 1;
    begin
      perform prive.exiger(length(btrim(coalesce(l ->> 'designation', ''))) >= 2, 'Désignation manquante');
      v_cb := nullif(btrim(coalesce(l ->> 'code_barres', '')), '');
      v_tva := coalesce(prive.nombre_import(l ->> 'taux_tva'), 0);
      if v_tva > 0 and v_tva < 1 then v_tva := v_tva * 100; end if; -- 0,18 → 18
      v_id := prive.trouver_produit(p_org, l ->> 'code', v_cb, l ->> 'designation');
      v_existe := v_id is not null;
      if v_existe and not p_mettre_a_jour then
        v_ignores := v_ignores + 1;
        v_res := v_res || jsonb_build_object('ligne', n, 'statut', 'ignore', 'produit_id', v_id,
                                             'message', 'Article déjà présent (mise à jour désactivée)');
        continue;
      end if;
      if v_existe then
        perform prive.exiger(prive.a_permission(p_org, 'catalogue.modifier'), 'Droit « catalogue.modifier » requis pour mettre à jour');
        update public.produits set
          designation = case when prive.normaliser(designation) = prive.normaliser(btrim(l ->> 'designation')) then designation
                             else btrim(l ->> 'designation') end,
          categorie_id = coalesce(prive.categorie_par_nom(p_org, l ->> 'categorie'), categorie_id),
          marque = coalesce(nullif(btrim(coalesce(l ->> 'marque', '')), ''), marque),
          unite = coalesce(nullif(btrim(coalesce(l ->> 'unite', '')), ''), unite),
          prix_vente = coalesce(prive.montant_import(l ->> 'prix_vente'), prix_vente),
          prix_achat = coalesce(prive.montant_import(l ->> 'prix_achat'), prix_achat),
          taux_tva = case when nullif(l ->> 'taux_tva', '') is null then taux_tva else v_tva end,
          seuil_min = coalesce(prive.nombre_import(l ->> 'seuil_min')::int, seuil_min),
          seuil_max = coalesce(prive.nombre_import(l ->> 'seuil_max')::int, seuil_max),
          gere_peremption = coalesce(prive.oui_non(l ->> 'gere_peremption'), gere_peremption)
        where id = v_id returning code into v_code;
        v_maj := v_maj + 1;
      else
        insert into public.produits (organisation_id, code, designation, categorie_id, marque, unite, prix_vente, prix_achat,
                                     taux_tva, seuil_min, seuil_max, gere_peremption, cree_par)
        values (p_org, nullif(btrim(coalesce(l ->> 'code', '')), ''), btrim(l ->> 'designation'),
                prive.categorie_par_nom(p_org, l ->> 'categorie'),
                nullif(btrim(coalesce(l ->> 'marque', '')), ''),
                coalesce(nullif(btrim(coalesce(l ->> 'unite', '')), ''), 'pièce'),
                coalesce(prive.montant_import(l ->> 'prix_vente'), 0),
                prive.montant_import(l ->> 'prix_achat'),
                v_tva,
                prive.nombre_import(l ->> 'seuil_min')::int,
                prive.nombre_import(l ->> 'seuil_max')::int,
                coalesce(prive.oui_non(l ->> 'gere_peremption'), false),
                auth.uid())
        returning id, code into v_id, v_code;
        v_crees := v_crees + 1;
      end if;
      if v_cb is not null and not exists (select 1 from public.codes_barres where organisation_id = p_org and code = v_cb) then
        insert into public.codes_barres (organisation_id, produit_id, code) values (p_org, v_id, v_cb);
      end if;
      v_res := v_res || jsonb_build_object('ligne', n, 'statut', case when v_existe then 'mis_a_jour' else 'cree' end,
                                           'produit_id', v_id, 'code', v_code);
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_err := v_err + 1;
      v_res := v_res || jsonb_build_object('ligne', n, 'statut', 'erreur', 'message', prive.message_import(v_msg));
    end;
  end loop;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, apres)
  values (p_org, auth.uid(), 'import.catalogue', 'import', null,
          jsonb_build_object('crees', v_crees, 'mis_a_jour', v_maj, 'erreurs', v_err));
  return jsonb_build_object('crees', v_crees, 'mis_a_jour', v_maj, 'ignores', v_ignores, 'erreurs', v_err, 'lignes', v_res);
end $$;

-- « oui », « x », « 1 », « vrai » → vrai ; « non », « 0 » → faux ; vide → null.
create function prive.oui_non(p text) returns boolean
language sql immutable set search_path = '' as $$
  select case when nullif(btrim(coalesce(p, '')), '') is null then null
              when lower(btrim(p)) in ('oui', 'o', 'x', '1', 'vrai', 'true', 'yes', 'y') then true
              else false end
$$;

-- Messages techniques de la base rendus lisibles.
create function prive.message_import(p text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p like '%produits_code_check%' or p like '%code ~%' then 'Code interne invalide : lettres, chiffres, tirets, 30 caractères au plus'
    when p like '%codes_barres_code_check%' then 'Code-barres invalide : 3 à 40 chiffres ou lettres'
    when p like '%designation%' and p like '%check%' then 'Désignation : 2 à 160 caractères'
    when p like '%taux_tva%' then 'Taux de TVA : 0, 9 ou 18'
    when p like '%seuil_max%' then 'Le stock maximum doit être supérieur au minimum'
    when p like '%invalid input syntax for type numeric%' then 'Nombre illisible dans la ligne'
    when p like '%invalid input syntax for type date%' or p like '%date/time field%' then 'Date illisible (format attendu : JJ/MM/AAAA)'
    when p like '%duplicate key%' and p like '%code%' then 'Ce code est déjà utilisé par un autre article'
    when p like '%fournisseurs_nom_unique%' then 'Fournisseur déjà présent'
    when p like '%email%' then 'Adresse e-mail invalide'
    else p end
$$;

-- ---------------------------------------------------------------------------------------------
-- Fournisseurs : ligne = nom, telephone, email, adresse, ncc, note.
create function public.importer_fournisseurs(p_org uuid, p_lignes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  l jsonb;
  n int := 0;
  v_id uuid;
  v_existe boolean;
  v_res jsonb := '[]'::jsonb;
  v_crees int := 0;
  v_maj int := 0;
  v_err int := 0;
  v_msg text;
begin
  perform prive.exiger(prive.a_permission(p_org, 'fournisseurs.creer') or prive.a_permission(p_org, 'achats.creer'),
                       'Droit « fournisseurs.creer » requis');
  perform prive.exiger(jsonb_typeof(p_lignes) = 'array' and jsonb_array_length(p_lignes) <= 1000, 'Envoyez au plus 1 000 lignes à la fois');
  for l in select * from jsonb_array_elements(p_lignes) loop
    n := n + 1;
    begin
      perform prive.exiger(length(btrim(coalesce(l ->> 'nom', ''))) >= 2, 'Nom du fournisseur manquant');
      select id into v_id from public.fournisseurs
       where organisation_id = p_org and prive.normaliser(nom) = prive.normaliser(btrim(l ->> 'nom'));
      v_existe := v_id is not null;
      if v_existe then
        update public.fournisseurs set
          telephone = coalesce(nullif(btrim(coalesce(l ->> 'telephone', '')), ''), telephone),
          email = coalesce(nullif(lower(btrim(coalesce(l ->> 'email', ''))), ''), email),
          adresse = coalesce(nullif(btrim(coalesce(l ->> 'adresse', '')), ''), adresse),
          ncc = coalesce(nullif(btrim(coalesce(l ->> 'ncc', '')), ''), ncc),
          note = coalesce(nullif(btrim(coalesce(l ->> 'note', '')), ''), note),
          actif = true
        where id = v_id;
        v_maj := v_maj + 1;
      else
        insert into public.fournisseurs (organisation_id, nom, telephone, email, adresse, ncc, note)
        values (p_org, btrim(l ->> 'nom'), nullif(btrim(coalesce(l ->> 'telephone', '')), ''),
                nullif(lower(btrim(coalesce(l ->> 'email', ''))), ''), nullif(btrim(coalesce(l ->> 'adresse', '')), ''),
                nullif(btrim(coalesce(l ->> 'ncc', '')), ''), nullif(btrim(coalesce(l ->> 'note', '')), ''))
        returning id into v_id;
        v_crees := v_crees + 1;
      end if;
      v_res := v_res || jsonb_build_object('ligne', n, 'statut', case when v_existe then 'mis_a_jour' else 'cree' end, 'fournisseur_id', v_id);
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_err := v_err + 1;
      v_res := v_res || jsonb_build_object('ligne', n, 'statut', 'erreur', 'message', prive.message_import(v_msg));
    end;
  end loop;
  return jsonb_build_object('crees', v_crees, 'mis_a_jour', v_maj, 'erreurs', v_err, 'lignes', v_res);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Approvisionnement : crée une réception en BROUILLON par fournisseur (colonne « fournisseur »
-- de chaque ligne, sinon le fournisseur choisi à l'écran). Le gérant vérifie puis valide :
-- c'est la validation qui fait entrer le stock (et qui exige une journée ouverte).
-- Entête : magasin_id, fournisseur, date_reception, reference, note.
-- Ligne : fournisseur, code, code_barres, designation, quantite, prix_achat, numero_lot,
--         date_peremption, prix_vente, categorie (ces deux derniers pour créer un article absent).
create function public.importer_reception(p_org uuid, p_entete jsonb, p_lignes jsonb, p_creer_articles boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  l jsonb;
  n int := 0;
  v_mag uuid := nullif(p_entete ->> 'magasin_id', '')::uuid;
  v_fourn uuid;
  v_cle text;
  v_receptions jsonb := '{}'::jsonb;
  v_rec uuid;
  v_prod uuid;
  v_qte numeric;
  v_prix bigint;
  v_res jsonb := '[]'::jsonb;
  v_ok int := 0;
  v_err int := 0;
  v_nouveaux int := 0;
  v_msg text;
begin
  perform prive.exiger(v_mag is not null and prive.peut_reception(p_org, v_mag, 'creer'),
                       'Droit de créer une réception dans ce magasin requis');
  perform prive.exiger(jsonb_typeof(p_lignes) = 'array' and jsonb_array_length(p_lignes) <= 1000, 'Envoyez au plus 1 000 lignes à la fois');
  for l in select * from jsonb_array_elements(p_lignes) loop
    n := n + 1;
    begin
      v_qte := prive.nombre_import(l ->> 'quantite');
      perform prive.exiger(v_qte is not null and v_qte > 0, 'Quantité manquante ou nulle');
      v_prod := prive.trouver_produit(p_org, l ->> 'code', l ->> 'code_barres', l ->> 'designation');
      if v_prod is null then
        perform prive.exiger(p_creer_articles, 'Article introuvable dans le catalogue');
        perform prive.exiger(prive.a_permission(p_org, 'catalogue.creer'), 'Article absent et droit « catalogue.creer » manquant');
        perform prive.exiger(length(btrim(coalesce(l ->> 'designation', ''))) >= 2, 'Article introuvable : indiquez au moins sa désignation');
        insert into public.produits (organisation_id, code, designation, categorie_id, prix_vente, prix_achat, cree_par)
        values (p_org, nullif(btrim(coalesce(l ->> 'code', '')), ''), btrim(l ->> 'designation'),
                prive.categorie_par_nom(p_org, l ->> 'categorie'),
                coalesce(prive.montant_import(l ->> 'prix_vente'), 0), prive.montant_import(l ->> 'prix_achat'), auth.uid())
        returning id into v_prod;
        if nullif(btrim(coalesce(l ->> 'code_barres', '')), '') is not null then
          insert into public.codes_barres (organisation_id, produit_id, code) values (p_org, v_prod, btrim(l ->> 'code_barres'));
        end if;
        v_nouveaux := v_nouveaux + 1;
      end if;
      v_prix := coalesce(prive.montant_import(l ->> 'prix_achat'),
                         (select prix_achat from public.produits where id = v_prod), 0);
      v_fourn := prive.fournisseur_par_nom(p_org, coalesce(nullif(btrim(coalesce(l ->> 'fournisseur', '')), ''), p_entete ->> 'fournisseur'));
      v_cle := coalesce(v_fourn::text, 'aucun');
      v_rec := nullif(v_receptions ->> v_cle, '')::uuid;
      if v_rec is null then
        insert into public.receptions (organisation_id, magasin_id, fournisseur_id, date_reception, reference, note, cree_par)
        values (p_org, v_mag, v_fourn,
                coalesce(nullif(p_entete ->> 'date_reception', '')::date, prive.aujourdhui()),
                nullif(btrim(coalesce(p_entete ->> 'reference', '')), ''),
                coalesce(nullif(btrim(coalesce(p_entete ->> 'note', '')), ''), 'Importée depuis un fichier Excel'),
                auth.uid())
        returning id into v_rec;
        v_receptions := v_receptions || jsonb_build_object(v_cle, v_rec);
      end if;
      insert into public.receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire, numero_lot, date_peremption)
      values (p_org, v_rec, v_prod, v_qte, v_prix,
              nullif(btrim(coalesce(l ->> 'numero_lot', '')), ''), nullif(l ->> 'date_peremption', '')::date);
      v_ok := v_ok + 1;
      v_res := v_res || jsonb_build_object('ligne', n, 'statut', 'ajoutee', 'reception_id', v_rec, 'produit_id', v_prod);
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_err := v_err + 1;
      v_res := v_res || jsonb_build_object('ligne', n, 'statut', 'erreur', 'message', prive.message_import(v_msg));
    end;
  end loop;
  return jsonb_build_object(
    'lignes_ajoutees', v_ok, 'erreurs', v_err, 'articles_crees', v_nouveaux, 'lignes', v_res,
    'receptions', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'fournisseur', f.nom,
                                          'lignes', (select count(*) from public.receptions_lignes where reception_id = r.id)))
        from public.receptions r left join public.fournisseurs f on f.id = r.fournisseur_id
       where r.id in (select (value #>> '{}')::uuid from jsonb_each(v_receptions))), '[]'::jsonb));
end $$;

revoke all on function prive.trouver_produit(uuid, text, text, text), prive.categorie_par_nom(uuid, text),
  prive.fournisseur_par_nom(uuid, text) from public, anon, authenticated;
revoke all on function public.importer_catalogue(uuid, jsonb, boolean), public.importer_fournisseurs(uuid, jsonb),
  public.importer_reception(uuid, jsonb, jsonb, boolean) from public, anon;
grant execute on function public.importer_catalogue(uuid, jsonb, boolean), public.importer_fournisseurs(uuid, jsonb),
  public.importer_reception(uuid, jsonb, jsonb, boolean) to authenticated;
