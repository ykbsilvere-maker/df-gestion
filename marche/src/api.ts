import { createClient } from '@supabase/supabase-js';

declare global {
  interface Window {
    DFG_CONFIG?: { supabaseUrl?: string; supabaseAnonKey?: string; marcheUrl?: string };
  }
}

/** Client public (clé « publishable ») : le site ne lit que ce que les fonctions publiques exposent. */
export const supabase = createClient(window.DFG_CONFIG?.supabaseUrl ?? 'http://localhost', window.DFG_CONFIG?.supabaseAnonKey ?? 'cle-absente', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

export function erreurLisible(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  if (/Failed to fetch|NetworkError|load failed/i.test(m)) return 'Connexion impossible : vérifiez votre réseau et réessayez.';
  return m.replace(/^.*?ERROR:\s*/, '');
}

export async function appeler<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(erreurLisible(error));
  return data as T;
}

/* ---------- Types renvoyés par les fonctions publiques ---------- */

export interface BoutiqueResume {
  slug: string;
  nom: string;
  commune: string | null;
  ville: string | null;
}

export interface ProduitCarte {
  id: string;
  designation: string;
  marque: string | null;
  unite: string;
  photo: string | null;
  /** Galerie (en plus de la photo principale). */
  photos?: string[];
  categorie: string | null;
  prix: number;
  prix_normal: number;
  solde_fin: string | null;
  disponible: number;
  boutique: BoutiqueResume;
  note: number | null;
  avis: number;
  commandes: number;
  /** Vendus en caisse les 30 derniers jours (DF Gestion). */
  vendus?: number;
  /** Date du dernier réapprovisionnement, s'il a moins de 10 jours. */
  arrivage?: string | null;
}

export interface Zone {
  id: string;
  nom: string;
  frais: number;
  delai: string | null;
}

export interface Vitrine {
  slug: string;
  nom: string;
  activite: string | null;
  slogan: string | null;
  description?: string | null;
  telephone: string | null;
  whatsapp: string | null;
  email: string | null;
  ville: string | null;
  commune: string | null;
  adresse: string | null;
  latitude: number | null;
  longitude: number | null;
  horaires: string | null;
  photos: string[];
  logo: string | null;
  couleur: string | null;
  paiement_livraison: boolean;
  numero_wave: string | null;
  numero_orange: string | null;
  numero_mtn: string | null;
  numero_moov: string | null;
  numero_djamo?: string | null;
  lien_wave?: string | null;
  conditions?: string | null;
  autres_paiements?: AutrePaiement[];
  beneficiaire: string;
  retrait: boolean;
  livraison: boolean;
  delai_preparation: number;
  commande_minimum: number;
  produits: number;
  commandes: number;
  note: number | null;
  avis: number;
  zones?: Zone[];
}

export interface Avis {
  auteur: string;
  note: number;
  commentaire: string | null;
  date: string;
  produit?: string;
}

export interface Accueil {
  soldes: ProduitCarte[];
  boutiques: Vitrine[];
  nouveautes: ProduitCarte[];
  arrivages?: ProduitCarte[];
  populaires: ProduitCarte[];
  categories: string[];
  activites: string[];
}

export interface FicheProduit extends ProduitCarte {
  description: string | null;
  code: string;
  vitrine: Vitrine;
  avis_liste: Avis[];
  similaires: ProduitCarte[];
}

export interface FicheBoutique extends Vitrine {
  categories: string[];
  derniers_avis: Avis[];
}

export type StatutCommande = 'nouvelle' | 'confirmee' | 'prete' | 'en_livraison' | 'livree' | 'annulee';
export type Paiement = 'livraison' | 'wave' | 'orange_money' | 'mtn' | 'moov' | 'djamo' | 'autre';
/** Moyen de paiement ajouté par la boutique (nom et numéro). */
export interface AutrePaiement { id: string; libelle: string; numero: string; instructions?: string | null }

export interface Suivi {
  id: string;
  numero: string;
  code_suivi: string;
  statut: StatutCommande;
  paiement: Paiement;
  paiement_statut: 'a_la_livraison' | 'a_verifier' | 'confirme' | 'refuse';
  paiement_libelle?: string | null;
  mode: 'livraison' | 'retrait';
  zone: string | null;
  adresse: string | null;
  souhaite_le: string | null;
  client_nom: string;
  sous_total: number;
  frais_livraison: number;
  total: number;
  justificatif: boolean;
  motif: string | null;
  numero_payeur: string | null;
  reference_paiement: string | null;
  paiement_confirme_le: string | null;
  client_telephone: string;
  repere: string | null;
  created_at: string;
  vente: string | null;
  dates: Record<'passee' | 'confirmee' | 'prete' | 'expediee' | 'livree' | 'annulee', string | null>;
  boutique: { nom: string; slug: string; telephone: string | null; whatsapp: string | null; adresse: string | null; commune: string | null; beneficiaire: string; numero_paiement: string | null; lien_wave: string | null; ville: string | null };
  lignes: { produit_id: string; designation: string; quantite: number; prix_unitaire: number; montant: number; avis: number | null }[];
}

/* ---------- Images ---------- */

const cache = new Map<string, { url: string; expire: number }>();

/** Photos des produits (espace privé) : adresses signées, demandées par lots. */
export async function urlsPhotos(chemins: (string | null | undefined)[]): Promise<Record<string, string>> {
  const r: Record<string, string> = {};
  const manquants: string[] = [];
  for (const c of new Set(chemins.filter((x): x is string => !!x))) {
    const e = cache.get(c);
    if (e && e.expire > Date.now()) r[c] = e.url;
    else manquants.push(c);
  }
  if (manquants.length) {
    const { data } = await supabase.storage.from('produits').createSignedUrls(manquants, 3600);
    for (const d of data ?? []) {
      if (d.signedUrl && d.path) {
        cache.set(d.path, { url: d.signedUrl, expire: Date.now() + 50 * 60 * 1000 });
        r[d.path] = d.signedUrl;
      }
    }
  }
  return r;
}

export const urlPublique = (espace: 'vitrines' | 'logos', chemin: string | null | undefined) =>
  chemin ? supabase.storage.from(espace).getPublicUrl(chemin).data.publicUrl : null;
