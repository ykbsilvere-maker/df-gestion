/**
 * Adresse du serveur (projet Supabase) et clé publique, sans recompiler l'application.
 * Ordre de lecture :
 *   1. valeurs intégrées au build (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) ;
 *   2. fichier public `config.js` (à remplir avec le Bloc-notes avant de publier le site) ;
 *   3. configuration saisie sur l'appareil (écran « Configurer l'application », QR code ou code).
 * La clé publique (« anon » / « publishable ») n'est pas un secret : la sécurité repose
 * sur les règles de la base. La clé secrète de service ne doit JAMAIS être saisie ici.
 */

export interface ConfigServeur {
  url: string;
  cle: string;
}

export type SourceConfiguration = 'build' | 'fichier' | 'appareil';

declare global {
  interface Window {
    DFG_CONFIG?: { supabaseUrl?: string; supabaseAnonKey?: string };
  }
}

const CLE_APPAREIL = 'dfg_config_serveur';
const PREFIXE = 'DFG1.';

function propre(c: Partial<ConfigServeur> | null | undefined): ConfigServeur | null {
  const url = (c?.url ?? '').trim().replace(/\/+$/, '');
  const cle = (c?.cle ?? '').trim();
  if (!/^https?:\/\/[^\s/]+/.test(url) || cle.length < 20) return null;
  return { url, cle };
}

export function lireConfiguration(): (ConfigServeur & { source: SourceConfiguration }) | null {
  const build = propre({ url: import.meta.env.VITE_SUPABASE_URL, cle: import.meta.env.VITE_SUPABASE_ANON_KEY });
  if (build) return { ...build, source: 'build' };
  if (typeof window === 'undefined') return null; // hors navigateur (tests)
  const fichier = propre({ url: window.DFG_CONFIG?.supabaseUrl, cle: window.DFG_CONFIG?.supabaseAnonKey });
  if (fichier) return { ...fichier, source: 'fichier' };
  try {
    const appareil = propre(JSON.parse(localStorage.getItem(CLE_APPAREIL) ?? 'null'));
    if (appareil) return { ...appareil, source: 'appareil' };
  } catch {
    /* stockage illisible */
  }
  return null;
}

export function enregistrerConfiguration(c: ConfigServeur) {
  localStorage.setItem(CLE_APPAREIL, JSON.stringify(propre(c)));
}

export function effacerConfiguration() {
  try {
    localStorage.removeItem(CLE_APPAREIL);
  } catch {
    /* rien */
  }
}

const enBase64Url = (t: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(t))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const depuisBase64Url = (t: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

/** Code de configuration à partager (QR code, WhatsApp) : « DFG1. » + adresse et clé publique encodées. */
export function encoderCode(c: ConfigServeur): string {
  return PREFIXE + enBase64Url(JSON.stringify({ u: c.url, k: c.cle }));
}

/** Lit un code de configuration (ou un lien / texte qui le contient). */
export function decoderCode(texte: string): ConfigServeur | null {
  const m = texte.match(/DFG1\.([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const o = JSON.parse(depuisBase64Url(m[1]!)) as { u?: string; k?: string };
    return propre({ url: o.u, cle: o.k });
  } catch {
    return null;
  }
}

/** Vérifie que l'adresse et la clé répondent avant de les enregistrer. Renvoie un message d'erreur ou null. */
export async function verifierConfiguration(c: ConfigServeur): Promise<string | null> {
  try {
    const r = await fetch(`${c.url}/rest/v1/rpc/plateforme_info`, {
      method: 'POST',
      headers: { apikey: c.cle, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (r.ok) return null;
    if (r.status === 401 || r.status === 403) return 'La clé est refusée par le serveur : recopiez la clé publique (anon / publishable).';
    if (r.status === 404) return 'Le serveur répond, mais la base n’est pas installée (exécutez les migrations 001 à 006).';
    return `Le serveur répond avec une erreur (${r.status}).`;
  } catch {
    return 'Serveur injoignable : vérifiez l’adresse et la connexion Internet.';
  }
}
