import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { supabase } from '../lib/supabase';

/**
 * Stockage local de la caisse (IndexedDB) : catalogue, moyens de règlement et file des ventes.
 * Une vente est d'abord écrite ici, puis envoyée au serveur ; elle n'est jamais perdue
 * si le réseau coupe, et jamais enregistrée deux fois (identifiant unique créé ici).
 */

export interface ProduitCaisse {
  id: string;
  code: string;
  designation: string;
  unite: string;
  prix_vente: number;
  taux_tva: number;
  codes_barres: string[];
  quantite_stock: number;
}

export interface MoyenPaiement {
  id: string;
  code: string;
  libelle: string;
  nature: 'especes' | 'mobile' | 'carte' | 'virement' | 'cheque' | 'autre';
  reference_obligatoire: boolean;
  actif: boolean;
  ordre: number;
}

export interface LigneVente {
  produit_id: string;
  designation: string;
  unite: string;
  quantite: number;
  prix_unitaire: number;
  remise: number;
}

export interface ReglementVente {
  moyen_id: string;
  libelle: string;
  nature: MoyenPaiement['nature'];
  montant: number;
  montant_recu?: number;
  reference?: string;
  /** « rendu » : monnaie rendue au client par ce moyen (Wave, OM…) ; absent = encaissement. */
  sens?: 'encaissement' | 'rendu';
}

export type StatutSync = 'en_attente' | 'synchronisee' | 'rejetee';

export interface VenteLocale {
  id: string;
  organisation_id: string;
  caisse_id: string;
  session_id: string;
  magasin_nom: string;
  caissier_nom: string;
  date_vente: string;
  numero_local: string;
  numero?: string;
  lignes: LigneVente[];
  reglements: ReglementVente[];
  total: number;
  origine: 'en_ligne' | 'hors_ligne';
  statut: StatutSync;
  erreur?: string;
  tentatives: number;
}

interface SchemaCaisse extends DBSchema {
  catalogue: { key: string; value: { cle: string; produits: ProduitCaisse[]; maj_le: string } };
  moyens: { key: string; value: { organisation_id: string; moyens: MoyenPaiement[] } };
  ventes: { key: string; value: VenteLocale; indexes: { par_statut: StatutSync; par_session: string } };
  compteurs: { key: string; value: { cle: string; valeur: number } };
}

let base: Promise<IDBPDatabase<SchemaCaisse>> | null = null;
function db() {
  base ??= openDB<SchemaCaisse>('dfg-caisse', 1, {
    upgrade(d) {
      d.createObjectStore('catalogue', { keyPath: 'cle' });
      d.createObjectStore('moyens', { keyPath: 'organisation_id' });
      const v = d.createObjectStore('ventes', { keyPath: 'id' });
      v.createIndex('par_statut', 'statut');
      v.createIndex('par_session', 'session_id');
      d.createObjectStore('compteurs', { keyPath: 'cle' });
    },
  });
  return base;
}

/** Erreur réseau (à réessayer) par opposition à un refus métier du serveur (à corriger). */
export function estErreurReseau(e: unknown): boolean {
  const m = typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) : String(e);
  const code = typeof e === 'object' && e !== null && 'code' in e ? (e as { code?: string }).code : undefined;
  return !code || /fetch|network|Load failed|timeout|ECONN/i.test(m);
}

// ---------- Joignabilité du serveur ----------
// navigator.onLine ne suffit pas (Wi-Fi sans Internet, serveur injoignable) : chaque appel
// de la caisse signale si le serveur a répondu.

let joignable = true;
const ecouteurs = new Set<(ok: boolean) => void>();
export function signalerReseau(ok: boolean) {
  if (ok === joignable) return;
  joignable = ok;
  ecouteurs.forEach((f) => f(ok));
}
export const serveurJoignable = () => joignable;
export function surReseau(f: (ok: boolean) => void): () => void {
  ecouteurs.add(f);
  return () => ecouteurs.delete(f);
}

// ---------- Catalogue et moyens ----------

export async function chargerCatalogue(org: string, magasin: string): Promise<{ produits: ProduitCaisse[]; maj_le: string | null; hors_ligne: boolean }> {
  const cle = `${org}:${magasin}`;
  const { data, error } = await supabase.rpc('catalogue_caisse', { p_org: org, p_magasin: magasin });
  signalerReseau(!error || !estErreurReseau(error));
  if (!error && data) {
    const produits = (data as ProduitCaisse[]).map((p) => ({ ...p, prix_vente: Number(p.prix_vente), quantite_stock: Number(p.quantite_stock), taux_tva: Number(p.taux_tva) }));
    const maj_le = new Date().toISOString();
    await (await db()).put('catalogue', { cle, produits, maj_le });
    return { produits, maj_le, hors_ligne: false };
  }
  const local = await (await db()).get('catalogue', cle);
  return { produits: local?.produits ?? [], maj_le: local?.maj_le ?? null, hors_ligne: true };
}

/** Catalogue gardé sur l'appareil (lecture immédiate, sans attendre le réseau). */
export async function catalogueLocal(org: string, magasin: string) {
  return (await (await db()).get('catalogue', `${org}:${magasin}`)) ?? null;
}

export async function moyensLocaux(org: string): Promise<MoyenPaiement[]> {
  return (await (await db()).get('moyens', org))?.moyens ?? [];
}

export async function chargerMoyens(org: string): Promise<MoyenPaiement[]> {
  const { data, error } = await supabase.from('moyens_paiement').select('*').eq('organisation_id', org).order('ordre');
  if (!error && data) {
    await (await db()).put('moyens', { organisation_id: org, moyens: data as MoyenPaiement[] });
    return data as MoyenPaiement[];
  }
  return (await (await db()).get('moyens', org))?.moyens ?? [];
}

const normaliser = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Recherche locale (fonctionne sans réseau) : code-barres ou code exact, puis mots. */
export function chercherLocal(produits: ProduitCaisse[], terme: string, limite = 8): { exact?: ProduitCaisse; resultats: ProduitCaisse[] } {
  const t = terme.trim();
  if (!t) return { resultats: [] };
  const compact = t.replace(/\s/g, '').toUpperCase();
  const exact = produits.find((p) => p.codes_barres.includes(compact) || p.code === compact);
  if (exact) return { exact, resultats: [exact] };
  const mots = normaliser(t).split(/\s+/).filter(Boolean);
  const resultats = produits
    .filter((p) => {
      const cible = normaliser(`${p.designation} ${p.code}`);
      return mots.every((m) => cible.includes(m));
    })
    .slice(0, limite);
  return { resultats };
}

// ---------- File des ventes ----------

export async function prochainNumeroLocal(caisseCode: string, caisseId: string): Promise<string> {
  const jour = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const cle = `${caisseId}:${jour}`;
  const d = await db();
  const tx = d.transaction('compteurs', 'readwrite');
  const actuel = (await tx.store.get(cle))?.valeur ?? 0;
  await tx.store.put({ cle, valeur: actuel + 1 });
  await tx.done;
  return `${caisseCode}-${jour}-${String(actuel + 1).padStart(4, '0')}`;
}

export async function enregistrerLocalement(v: VenteLocale) {
  await (await db()).put('ventes', v);
}

export async function ventesDeSession(session: string): Promise<VenteLocale[]> {
  return (await (await db()).getAllFromIndex('ventes', 'par_session', session)).sort((a, b) => b.date_vente.localeCompare(a.date_vente));
}

export async function ventesEnAttente(): Promise<VenteLocale[]> {
  return (await (await db()).getAllFromIndex('ventes', 'par_statut', 'en_attente')).sort((a, b) => a.date_vente.localeCompare(b.date_vente));
}

export async function ventesRejetees(): Promise<VenteLocale[]> {
  return (await db()).getAllFromIndex('ventes', 'par_statut', 'rejetee');
}

function charge(v: VenteLocale) {
  return {
    id: v.id,
    organisation_id: v.organisation_id,
    caisse_id: v.caisse_id,
    session_id: v.session_id,
    date_vente: v.date_vente,
    origine: v.origine,
    numero_local: v.numero_local,
    lignes: v.lignes.map((l) => ({ produit_id: l.produit_id, quantite: l.quantite, prix_unitaire: l.prix_unitaire, remise: l.remise })),
    reglements: v.reglements.map((r) => ({ moyen_id: r.moyen_id, montant: r.montant, montant_recu: r.montant_recu, reference: r.reference, sens: r.sens })),
  };
}

/** Envoie une vente au serveur. Renvoie la vente mise à jour (numéro ou erreur). */
export async function envoyer(v: VenteLocale): Promise<VenteLocale> {
  const { data, error } = await supabase.rpc('enregistrer_vente', { p_vente: charge(v) });
  let maj: VenteLocale;
  signalerReseau(!error || !estErreurReseau(error));
  if (!error) {
    maj = { ...v, statut: 'synchronisee', numero: (data as { numero: string }).numero, erreur: undefined };
  } else if (estErreurReseau(error)) {
    // La vente a été faite sans réseau : elle sera envoyée plus tard comme vente hors connexion.
    maj = { ...v, origine: 'hors_ligne', tentatives: v.tentatives + 1 };
  } else {
    maj = { ...v, statut: 'rejetee', erreur: error.message, tentatives: v.tentatives + 1 };
  }
  await enregistrerLocalement(maj);
  return maj;
}

let synchronisationEnCours: Promise<number> | null = null;

/** Envoie toutes les ventes en attente, dans l'ordre. Renvoie le nombre restant en attente. */
export function synchroniser(): Promise<number> {
  synchronisationEnCours ??= (async () => {
    try {
      for (const v of await ventesEnAttente()) {
        const r = await envoyer(v);
        if (r.statut === 'en_attente') break; // toujours hors connexion : on réessaiera
      }
      return (await ventesEnAttente()).length;
    } finally {
      synchronisationEnCours = null;
    }
  })();
  return synchronisationEnCours;
}

/** Retire une vente refusée en direct par le serveur (le panier est rendu au caissier). */
export async function supprimerLocale(id: string) {
  await (await db()).delete('ventes', id);
}

/** Remet une vente refusée dans la file (après correction côté serveur, par exemple d'un droit). */
export async function reessayer(v: VenteLocale) {
  await enregistrerLocalement({ ...v, statut: 'en_attente', erreur: undefined });
}
