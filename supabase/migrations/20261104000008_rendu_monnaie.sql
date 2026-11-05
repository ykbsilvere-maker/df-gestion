-- =====================================================================
-- v0.7 — Monnaie rendue en partie par un autre moyen
--   Exemple : ticket de 8 450, le client donne 10 000 en espèces ; faute de pièces,
--   la caissière rend 50 en espèces et 1 500 par Wave.
--   * le règlement espèces garde 9 950 (reçu 10 000, rendu 50 en espèces) ;
--   * une ligne « rendu » de 1 500 sur Wave (sortie du compte Wave) ;
--   * encaissements − rendus = total de la vente (8 450).
--   Les totaux de session donnent, pour chaque moyen, l'encaissé, le rendu et le
--   net à reverser ; les espèces attendues dans le tiroir en tiennent compte.
-- =====================================================================

alter table public.reglements
  add column sens text not null default 'encaissement' check (sens in ('encaissement', 'rendu'));

comment on column public.reglements.sens is
  'encaissement : somme reçue par ce moyen ; rendu : monnaie rendue au client par ce moyen (autre que les espèces).';

-- Enregistre une vente complète (idempotente). Règlements :
--   [{ moyen_id, montant, montant_recu, reference, sens }] ; sens = 'encaissement' (défaut) ou 'rendu'.
create or replace function public.enregistrer_vente(p_vente jsonb) returns jsonb
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
  v_rendus bigint := 0;
  v_especes bigint := 0;
  v_sens text;
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
    v_sens := coalesce(nullif(r ->> 'sens', ''), 'encaissement');
    perform prive.exiger(v_sens in ('encaissement', 'rendu'), 'Sens de règlement invalide');
    perform prive.exiger(v_montant > 0, 'Montant de règlement invalide');
    perform prive.exiger(not mp.reference_obligatoire or length(btrim(coalesce(r ->> 'reference', ''))) > 0,
                         format('Référence de transaction obligatoire pour %s', mp.libelle));
    if v_sens = 'rendu' then
      -- Monnaie rendue par un autre moyen que les espèces (Wave, Orange Money…) : sortie de ce moyen.
      perform prive.exiger(mp.nature <> 'especes',
        'La monnaie rendue en espèces se déduit de la somme reçue : seul un autre moyen peut servir au rendu');
      insert into public.reglements (organisation_id, vente_id, moyen_id, nature, libelle, montant, sens, reference)
      values (v_org, v_id, mp.id, mp.nature, mp.libelle, v_montant, 'rendu', nullif(btrim(r ->> 'reference'), ''));
      v_rendus := v_rendus + v_montant;
    else
      v_recu := case when mp.nature = 'especes' then greatest(coalesce((r ->> 'montant_recu')::bigint, v_montant), v_montant) end;
      insert into public.reglements (organisation_id, vente_id, moyen_id, nature, libelle, montant, montant_recu, rendu, reference)
      values (v_org, v_id, mp.id, mp.nature, mp.libelle, v_montant, v_recu, coalesce(v_recu - v_montant, 0),
              nullif(btrim(r ->> 'reference'), ''));
      v_regle := v_regle + v_montant;
      if mp.nature = 'especes' then v_especes := v_especes + v_montant; end if;
    end if;
  end loop;

  -- Le rendu par un autre moyen compense des espèces reçues en trop : jamais plus que les espèces gardées.
  perform prive.exiger(v_rendus <= v_especes,
    'Le rendu par un autre moyen ne peut pas dépasser les espèces reçues');
  perform prive.exiger(v_regle - v_rendus = v_total,
    format('Les règlements (%s F) ne correspondent pas au total de la vente (%s F)', v_regle - v_rendus, v_total));
  update public.ventes set total = v_total, total_remises = v_remises where id = v_id;
  return jsonb_build_object('id', v_id, 'numero', v_numero, 'total', v_total, 'deja_enregistree', false);
end $$;


-- Totaux d'une session : par moyen, encaissé, rendu et net à reverser.
create or replace function prive.calculer_totaux_session(p_session uuid) returns jsonb
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
    'especes_encaissees', (select coalesce(sum(montant), 0) from r where nature = 'especes' and sens = 'encaissement'),
    'especes_attendues', (select fond_initial from s)
                         + (select coalesce(sum(montant), 0) from r where nature = 'especes' and sens = 'encaissement'),
    'rendus_autres_moyens', (select coalesce(sum(montant), 0) from r where sens = 'rendu'),
    'par_moyen', coalesce((
      select jsonb_agg(jsonb_build_object('libelle', libelle, 'nature', nature, 'montant', net, 'encaisse', encaisse,
                                          'rendu', rendu, 'nombre', nb) order by net desc)
      from (select libelle, nature,
                   coalesce(sum(montant) filter (where sens = 'encaissement'), 0) encaisse,
                   coalesce(sum(montant) filter (where sens = 'rendu'), 0) rendu,
                   coalesce(sum(case when sens = 'rendu' then -montant else montant end), 0) net,
                   count(*) filter (where sens = 'encaissement') nb
            from r group by libelle, nature) x
    ), '[]'::jsonb),
    'calcule_le', now()
  )
$$;
