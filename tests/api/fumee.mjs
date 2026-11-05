// Test de fumée de l'API : rejoue, avec @supabase/supabase-js, les appels exacts
// faits par l'application, contre PostgREST branché sur une base migrée.
//
// Prérequis (voir README) : PostgREST lancé sur PGRST_URL avec PGRST_JWT_SECRET,
// base de test migrée (shim + migrations), accès SQL admin via TEST_API_DATABASE_URL.
// Usage : node tests/api/fumee.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const PGRST = process.env.PGRST_URL ?? 'http://localhost:3901';
const SECRET = process.env.PGRST_JWT_SECRET ?? 'secret-de-test-tres-long-pour-hs256-0123456789';
const DB = process.env.TEST_API_DATABASE_URL ?? 'postgres://postgres@localhost:54329/dfg_api?host=/tmp';

// supabase-js appelle <url>/rest/v1/... : petit relais qui retire ce préfixe.
const relais = http.createServer((req, res) => {
  const cible = new URL(req.url.replace(/^\/rest\/v1/, ''), PGRST);
  const p = http.request(cible, { method: req.method, headers: { ...req.headers, host: cible.host } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  req.pipe(p);
});
await new Promise((ok) => relais.listen(0, ok));
const URL_API = `http://localhost:${relais.address().port}`;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jeton(sub) {
  const corps = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${corps}.${crypto.createHmac('sha256', SECRET).update(corps).digest('base64url')}`;
}
const client = (sub) =>
  createClient(URL_API, 'cle-anon-factice', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jeton(sub)}` } },
  });

const db = new pg.Client({ connectionString: DB });
await db.connect();
const suffixe = Date.now();
async function compte(email, nom) {
  const { rows } = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), $1, jsonb_build_object('nom_complet', $2::text)) returning id`,
    [email, nom],
  );
  return rows[0].id;
}

let echecs = 0;
async function etape(nom, fn) {
  try {
    await fn();
    console.log(`  ✓ ${nom}`);
  } catch (e) {
    echecs++;
    console.log(`  ✗ ${nom}\n      ${e.message ?? e}`);
  }
}
const verifier = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sans = ({ error, data, count }) => {
  if (error) throw new Error(error.message);
  return { data, count };
};

const uidAlice = await compte(`alice.${suffixe}@test.ci`, 'Alice');
const uidChantal = await compte(`chantal.${suffixe}@test.ci`, 'Chantal');
const alice = client(uidAlice);
const chantal = client(uidChantal);
let org, mag1, mag2, caisse1, membreChantal;

console.log('Parcours propriétaire (appels identiques à l’application)');
await etape('creer_organisation', async () => {
  org = sans(
    await alice.rpc('creer_organisation', {
      p_nom: 'Supérette API',
      p_ncc: null,
      p_regime_fiscal: 'rsi',
      p_telephone: '+225 07 00 00 00 00',
      p_adresse: null,
      p_ville: 'Abidjan',
      p_nom_magasin: 'Magasin Angré',
    }),
  ).data;
  verifier(typeof org === 'string', 'identifiant attendu');
});
await etape('mes_organisations', async () => {
  const { data } = sans(await alice.rpc('mes_organisations'));
  verifier(data.length === 1 && data[0].permissions.length === 117, JSON.stringify(data));
});
await etape('compteur (head + count exact)', async () => {
  const { count } = sans(
    await alice.from('magasins').select('*', { count: 'exact', head: true }).eq('organisation_id', org).eq('actif', true),
  );
  verifier(count === 1, `count=${count}`);
});
await etape('insertion d’un magasin et lecture des caisses', async () => {
  sans(await alice.from('magasins').insert({ code: 'MAG02', nom: 'Magasin Cocody', adresse: null, ville: null, telephone: null, organisation_id: org }));
  const { data: m } = sans(await alice.from('magasins').select('*').eq('organisation_id', org).order('code'));
  [mag1, mag2] = m.map((x) => x.id);
  const { data: c } = sans(await alice.from('caisses').select('*').eq('organisation_id', org).order('code'));
  caisse1 = c[0].id;
  verifier(m.length === 2 && c.length === 1, 'magasins/caisses');
});
await etape('modification d’une caisse et désactivation d’un magasin', async () => {
  sans(await alice.from('caisses').update({ code: 'CAISSE01', nom: 'Caisse entrée' }).eq('id', caisse1));
  sans(await alice.from('magasins').update({ actif: false }).eq('id', mag2));
  sans(await alice.from('magasins').update({ actif: true }).eq('id', mag2));
});
await etape('modification de l’entreprise (colonnes autorisées)', async () => {
  sans(
    await alice
      .from('organisations')
      .update({ nom: 'Supérette API SARL', ncc: 'AB123456', regime_fiscal: 'rsi', telephone: null, adresse: 'Angré', ville: 'Abidjan' })
      .eq('id', org),
  );
});
await etape('refus de modifier une colonne protégée', async () => {
  const { error } = await alice.from('organisations').update({ actif: false }).eq('id', org);
  verifier(error && /permission denied/.test(error.message), `refus attendu, reçu ${error?.message}`);
});
await etape('inviter_membre (compte existant, tableaux de magasins/caisses)', async () => {
  sans(
    await alice.rpc('inviter_membre', {
      p_org: org,
      p_email: `Chantal.${suffixe}@test.ci`,
      p_role: 'caissier',
      p_tous_magasins: false,
      p_magasins: [mag1],
      p_caisses: [caisse1],
    }),
  );
  const { data } = sans(await chantal.rpc('mes_organisations'));
  verifier(data[0]?.role_code === 'caissier', JSON.stringify(data));
});
await etape('écran Utilisateurs : membres, périmètres, profils (.in)', async () => {
  const { data: mb } = sans(await alice.from('membres').select('*').eq('organisation_id', org).order('created_at'));
  membreChantal = mb.find((m) => m.user_id === uidChantal).id;
  const { data: mm } = sans(await alice.from('membre_magasins').select('*').eq('organisation_id', org));
  const { data: pr } = sans(await alice.from('profils').select('*').in('id', mb.map((m) => m.user_id)));
  sans(await alice.from('role_permissions').select('*'));
  verifier(mm.length === 1 && pr.length === 2, `mm=${mm.length} pr=${pr.length}`);
});
await etape('modifier_membre puis droits individuels', async () => {
  sans(await alice.rpc('modifier_membre', { p_membre: membreChantal, p_role: 'responsable_caisse', p_tous_magasins: false, p_magasins: [mag1, mag2], p_caisses: [] }));
  sans(await alice.rpc('definir_permission_membre', { p_membre: membreChantal, p_permission: 'audit.consulter', p_accorde: true }));
  sans(await alice.rpc('definir_permission_membre', { p_membre: membreChantal, p_permission: 'audit.consulter', p_accorde: null }));
});
await etape('désactivation : accès coupé ; réactivation', async () => {
  sans(await alice.rpc('desactiver_membre', { p_membre: membreChantal, p_motif: 'Test API' }));
  const { data } = sans(await chantal.from('magasins').select('*'));
  verifier(data.length === 0, 'aucun magasin attendu');
  sans(await alice.rpc('reactiver_membre', { p_membre: membreChantal }));
  const { data: d2 } = sans(await chantal.from('magasins').select('*'));
  verifier(d2.length === 2, `2 magasins attendus, ${d2.length}`);
});
await etape('invitation sans compte puis annulation', async () => {
  const { data: id } = sans(await alice.rpc('inviter_membre', { p_org: org, p_email: `nouveau.${suffixe}@test.ci`, p_role: 'vendeur', p_tous_magasins: true, p_magasins: [], p_caisses: [] }));
  sans(await alice.from('invitations').select('*').eq('organisation_id', org).eq('statut', 'en_attente'));
  sans(await alice.rpc('annuler_invitation', { p_invitation: id }));
});
await etape('connexion / déconnexion journalisées', async () => {
  sans(await alice.rpc('enregistrer_connexion', { p_appareil: 'Tablette caisse', p_user_agent: 'fumee' }));
  sans(await alice.rpc('enregistrer_deconnexion'));
});
await etape('écran Journal : filtres like, eq, gte, lte et pagination', async () => {
  const { data } = sans(
    await alice
      .from('journal_audit')
      .select('*')
      .eq('organisation_id', org)
      .order('id', { ascending: false })
      .range(0, 50)
      .like('action', 'membres.%')
      .eq('user_id', uidAlice)
      .gte('created_at', '2020-01-01T00:00:00Z')
      .lte('created_at', '2100-01-01T23:59:59.999Z'),
  );
  verifier(data.length >= 3, `lignes=${data.length}`);
  verifier(data.some((l) => l.contexte?.motif === 'Test API'), 'motif de désactivation absent');
});
await etape('Mon compte : profil et lecture', async () => {
  sans(await alice.from('profils').update({ nom_complet: 'Alice K.', telephone: null }).eq('id', uidAlice));
  const { data } = sans(await alice.from('profils').select('nom_complet, telephone').eq('id', uidAlice).single());
  verifier(data.nom_complet === 'Alice K.', 'nom non mis à jour');
});
await etape('la caissière ne voit pas le journal', async () => {
  const { data } = sans(await chantal.from('journal_audit').select('*').eq('organisation_id', org));
  verifier(data.length === 0, 'journal visible');
});

console.log('Personnalisation et catalogue');
let prod1, prod2;
await etape('personnalisation : identité, couleur et modèle de reçu', async () => {
  sans(await alice.from('organisations').update({ rccm: 'CI-ABJ-2026-B-1', email: 'contact@superette.ci', couleur: 'ocean', logo_path: `${org}/logo-1.png` }).eq('id', org));
  sans(await alice.from('parametres_impression').update({ format: 'a4_6', afficher_logo: true, entete: 'Le bon prix', pied: 'Merci !', mention_legale: null, afficher_caissier: true, afficher_ncc: true, decalage_x_mm: 1.5, decalage_y_mm: -1 }).eq('organisation_id', org));
  const { data } = sans(await alice.from('parametres_impression').select('*').eq('organisation_id', org).single());
  verifier(data.format === 'a4_6' && Number(data.decalage_x_mm) === 1.5, JSON.stringify(data));
});
await etape('création de produit avec retour de la ligne (insert + select + single)', async () => {
  prod1 = sans(await alice.from('produits').insert({ organisation_id: org, designation: 'Riz parfumé 5 kg', code: null, categorie_id: null, marque: null, unite: 'sac', prix_vente: 4500, prix_achat: 3900, taux_tva: 0, seuil_min: 5, seuil_max: null, gere_peremption: false }).select('*').single()).data;
  verifier(prod1.code === 'P00001', prod1.code);
  prod2 = sans(await alice.from('produits').insert({ organisation_id: org, designation: 'Huile végétale 1 L', prix_vente: 1500 }).select('*').single()).data;
});
await etape('code-barres scanné, généré, puis retiré', async () => {
  sans(await alice.from('codes_barres').insert({ organisation_id: org, produit_id: prod1.id, code: '6111245800017' }));
  const { data: c } = sans(await alice.rpc('generer_code_barres', { p_produit: prod2.id }));
  verifier(/^20\d{11}$/.test(c), c);
  const { data: liste } = sans(await alice.from('codes_barres').select('*').eq('produit_id', prod2.id).order('created_at'));
  sans(await alice.from('codes_barres').delete().eq('id', liste[0].id));
});
await etape('recherche : code-barres exact, mots, liste des codes par produits (.in)', async () => {
  const { data: r1 } = sans(await alice.rpc('rechercher_produits', { p_org: org, p_terme: '6111245800017', p_limite: 100, p_inclure_inactifs: false }));
  verifier(r1.length === 1 && r1[0].pertinence === 0, JSON.stringify(r1));
  const { data: r2 } = sans(await alice.rpc('rechercher_produits', { p_org: org, p_terme: 'vegetale huile', p_limite: 100, p_inclure_inactifs: false }));
  verifier(r2[0]?.designation === 'Huile végétale 1 L', JSON.stringify(r2));
  sans(await alice.from('codes_barres').select('produit_id, code').in('produit_id', [prod1.id, prod2.id]));
});
await etape('liste paginée du catalogue avec filtre de statut', async () => {
  const { data } = sans(await alice.from('produits').select('*').eq('organisation_id', org).order('designation').range(0, 50).eq('statut', 'actif'));
  verifier(data.length === 2, `produits=${data.length}`);
});
await etape('catégorie créée depuis la fiche produit', async () => {
  const { data } = sans(await alice.from('categories').insert({ organisation_id: org, nom: 'Épicerie' }).select('id').single());
  sans(await alice.from('produits').update({ categorie_id: data.id, statut: 'actif' }).eq('id', prod1.id).select('*').single());
});

console.log('Stock');
let mag1Stock, recep, inventaire;
await etape('réception : brouillon, lignes, frais, validation', async () => {
  mag1Stock = mag1;
  recep = sans(await alice.from('receptions').insert({ organisation_id: org, magasin_id: mag1 }).select('id').single()).data;
  sans(await alice.from('receptions').update({ fournisseur_id: null, reference: 'BL-778', frais_approche: 1000, date_reception: '2026-10-25' }).eq('id', recep.id));
  sans(await alice.from('receptions_lignes').insert({ organisation_id: org, reception_id: recep.id, produit_id: prod1.id, quantite: 10, prix_unitaire: 3900 }));
  const { data: lignes } = sans(await alice.from('receptions_lignes').select('*').eq('reception_id', recep.id).order('created_at'));
  sans(await alice.from('receptions_lignes').update({ quantite: 12 }).eq('id', lignes[0].id));
  const { data: numero } = sans(await alice.rpc('valider_reception', { p_reception: recep.id }));
  verifier(/^R-\d{6}$/.test(numero), numero);
});
await etape('fournisseur créé depuis la réception (insert + select + single)', async () => {
  sans(await alice.from('fournisseurs').insert({ organisation_id: org, nom: 'SODIS Distribution', telephone: null, email: null, adresse: null, ncc: null, note: null }).select('*').single());
});
await etape('état du stock, stock d’un produit (maybeSingle), lots embarqués', async () => {
  const { data: etat } = sans(await alice.rpc('etat_stock', { p_org: org, p_magasin: mag1 }));
  const riz = etat.find((e) => e.produit_id === prod1.id);
  verifier(Number(riz.quantite) === 12 && Number(riz.valeur) === 12 * 3900 + 1000, JSON.stringify(riz));
  const { data: s1 } = sans(await alice.from('stocks').select('quantite').eq('magasin_id', mag1).eq('produit_id', prod1.id).maybeSingle());
  verifier(Number(s1.quantite) === 12, JSON.stringify(s1));
  sans(await alice.from('stocks_lots').select('lot_id, quantite, lots(numero, date_peremption)').eq('magasin_id', mag1).eq('produit_id', prod1.id).gt('quantite', 0));
});
await etape('transfert, sortie motivée, alertes', async () => {
  const { data: t } = sans(await alice.rpc('transferer_stock', { p_org: org, p_source: mag1, p_destination: mag2, p_lignes: [{ produit_id: prod1.id, quantite: 2 }], p_note: null, p_cle: crypto.randomUUID() }));
  verifier(/^TR-/.test(t), t);
  sans(await alice.rpc('enregistrer_mouvement_manuel', { p_org: org, p_magasin: mag1, p_produit: prod1.id, p_type: 'casse', p_quantite: 1, p_motif: 'Sac déchiré', p_lot: null, p_cle: crypto.randomUUID() }));
  sans(await alice.rpc('alertes_stock', { p_org: org }));
  const { data: mv } = sans(await alice.from('mouvements_stock').select('id, type, quantite, valeur, motif, produit_id, created_at').eq('organisation_id', org).eq('magasin_id', mag1).in('type', ['casse', 'perte']).order('id', { ascending: false }).limit(15));
  verifier(mv.length === 1, `mouvements=${mv.length}`);
});
await etape('inventaire : ouverture, comptage au scan, validation', async () => {
  inventaire = sans(await alice.rpc('ouvrir_inventaire', { p_org: org, p_magasin: mag1, p_categorie: null })).data;
  sans(await alice.rpc('compter_inventaire', { p_inventaire: inventaire, p_produit: prod1.id, p_quantite: 1, p_ajouter: true }));
  sans(await alice.rpc('compter_inventaire', { p_inventaire: inventaire, p_produit: prod1.id, p_quantite: 8, p_ajouter: false }));
  const { data: v } = sans(await alice.rpc('valider_inventaire', { p_inventaire: inventaire }));
  verifier(Number(v) < 0, `écart=${v}`);
  const { data: lignes } = sans(await alice.from('inventaires_lignes').select('*').eq('inventaire_id', inventaire));
  verifier(lignes.some((l) => Number(l.ecart) === -1), JSON.stringify(lignes));
});
await etape('registre des mouvements filtré et paginé', async () => {
  const { data } = sans(await alice.from('mouvements_stock').select('*').eq('organisation_id', org).order('id', { ascending: false }).range(0, 50).eq('produit_id', prod1.id).gte('created_at', '2020-01-01T00:00:00Z'));
  verifier(data.length === 5, `mouvements=${data.length}`);
});

console.log('Caisse');
let sessionId, venteId, moyens;
await etape('caisses actives, session ouverte (maybeSingle), ouverture', async () => {
  const { data: c } = sans(await alice.from('caisses').select('*').eq('organisation_id', org).eq('actif', true).order('code'));
  verifier(c.some((x) => x.id === caisse1), 'caisse1 visible');
  const { data: aucune } = sans(await alice.from('sessions_caisse').select('id, caisse_id, magasin_id, fond_initial, ouverte_le, ouverte_par').eq('caisse_id', caisse1).eq('statut', 'ouverte').maybeSingle());
  verifier(aucune === null, 'pas de session');
  sessionId = sans(await alice.rpc('ouvrir_session', { p_org: org, p_caisse: caisse1, p_fond: 10000 })).data;
  const { data: s } = sans(await alice.from('sessions_caisse').select('id, caisse_id, magasin_id, fond_initial, ouverte_le, ouverte_par').eq('caisse_id', caisse1).eq('statut', 'ouverte').maybeSingle());
  verifier(s.id === sessionId && Number(s.fond_initial) === 10000, JSON.stringify(s));
});
await etape('catalogue de caisse et moyens de règlement', async () => {
  const { data: cat } = sans(await alice.rpc('catalogue_caisse', { p_org: org, p_magasin: mag1 }));
  const riz = cat.find((p) => p.id === prod1.id);
  verifier(riz && Array.isArray(riz.codes_barres) && Number(riz.quantite_stock) === 8, JSON.stringify(riz));
  moyens = sans(await alice.from('moyens_paiement').select('*').eq('organisation_id', org).order('ordre')).data;
  verifier(moyens.length === 8 && moyens[0].nature === 'especes', `moyens=${moyens.length}`);
});
await etape('vente : espèces + Wave, rendu, idempotence', async () => {
  venteId = crypto.randomUUID();
  const especes = moyens.find((m) => m.code === 'especes');
  const wave = moyens.find((m) => m.code === 'wave');
  const { data: prix } = sans(await alice.from('produits').select('prix_vente').eq('id', prod1.id).single());
  const total = 2 * Number(prix.prix_vente);
  const charge = {
    id: venteId, organisation_id: org, caisse_id: caisse1, session_id: sessionId, date_vente: new Date().toISOString(),
    origine: 'en_ligne', numero_local: 'CAISSE01-261025-0001',
    lignes: [{ produit_id: prod1.id, quantite: 2, prix_unitaire: Number(prix.prix_vente), remise: 0 }],
    reglements: [
      { moyen_id: wave.id, montant: 1000, montant_recu: undefined, reference: 'WV-123' },
      { moyen_id: especes.id, montant: total - 1000, montant_recu: total, reference: undefined },
    ],
  };
  const { data: r1 } = sans(await alice.rpc('enregistrer_vente', { p_vente: charge }));
  const { data: r2 } = sans(await alice.rpc('enregistrer_vente', { p_vente: charge }));
  verifier(/^T-\d{6}$/.test(r1.numero) && r2.numero === r1.numero && r2.deja_enregistree === true, JSON.stringify([r1, r2]));
});
await etape('liste des ventes de la session et détail pour réimpression', async () => {
  const { data } = sans(await alice.from('ventes').select('id, numero, date_vente, total, statut').eq('session_id', sessionId).order('date_vente', { ascending: false }).limit(300));
  verifier(data.length === 1, `ventes=${data.length}`);
  const { data: l } = sans(await alice.from('ventes_lignes').select('produit_id, designation, quantite, prix_unitaire, remise').eq('vente_id', venteId).order('ligne'));
  const { data: r } = sans(await alice.from('reglements').select('moyen_id, libelle, nature, montant, montant_recu, reference').eq('vente_id', venteId));
  verifier(l.length === 1 && r.length === 2 && r.some((x) => x.reference === 'WV-123'), JSON.stringify(r));
});
await etape('vente refusée (règlements ≠ total) : erreur métier avec code', async () => {
  const { error } = await alice.rpc('enregistrer_vente', { p_vente: { id: crypto.randomUUID(), organisation_id: org, caisse_id: caisse1, session_id: sessionId, date_vente: new Date().toISOString(), origine: 'en_ligne', lignes: [{ produit_id: prod1.id, quantite: 1, prix_unitaire: 100, remise: 0 }], reglements: [{ moyen_id: moyens[0].id, montant: 50 }] } });
  verifier(error && error.code, `erreur=${JSON.stringify(error)}`);
});
await etape('annulation, rapport X, ventes du jour', async () => {
  const v2 = crypto.randomUUID();
  const { data: prix } = sans(await alice.from('produits').select('prix_vente').eq('id', prod1.id).single());
  sans(await alice.rpc('enregistrer_vente', { p_vente: { id: v2, organisation_id: org, caisse_id: caisse1, session_id: sessionId, date_vente: new Date().toISOString(), origine: 'en_ligne', lignes: [{ produit_id: prod1.id, quantite: 1, prix_unitaire: Number(prix.prix_vente), remise: 0 }], reglements: [{ moyen_id: moyens[0].id, montant: Number(prix.prix_vente), montant_recu: Number(prix.prix_vente) }] } }));
  sans(await alice.rpc('annuler_vente', { p_vente: v2, p_motif: 'Erreur de saisie' }));
  const { data: x } = sans(await alice.rpc('rapport_session', { p_session: sessionId }));
  verifier(x.nombre_ventes === 1 && x.nombre_annulations === 1 && x.par_moyen.length === 2, JSON.stringify(x));
  const { data: j } = sans(await alice.rpc('ventes_du_jour', { p_org: org }));
  verifier(Number(j[0].nombre) === 1, JSON.stringify(j));
});
await etape('clôture avec billetage et écart justifié → rapport Z', async () => {
  const { data: x } = sans(await alice.rpc('rapport_session', { p_session: sessionId }));
  const compte = Number(x.especes_attendues) - 100;
  const { data: z } = sans(await alice.rpc('cloturer_session', { p_session: sessionId, p_especes_comptees: compte, p_billetage: { '10000': 1, p100: 3 }, p_motif_ecart: 'Pièce de 100 manquante' }));
  verifier(z.numero_z === 1 && Number(z.ecart) === -100 && z.billetage.p100 === 3, JSON.stringify(z));
});

await db.end();
relais.close();
console.log(echecs ? `\n${echecs} échec(s)` : '\nTous les appels de l’application passent par l’API.');
process.exit(echecs ? 1 : 0);
