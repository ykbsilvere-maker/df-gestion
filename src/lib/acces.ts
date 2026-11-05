/**
 * Connexion des employés par matricule.
 * L'identifiant technique (jamais montré) est fabriqué à partir du code entreprise et du matricule :
 * <matricule>.<code>@acces.dfgestion.app — le même calcul est fait par la base (prive.email_employe).
 */
export const DOMAINE_ACCES = 'acces.dfgestion.app';
const CLE_CODE = 'dfg_code_entreprise';

export const normaliserCode = (c: string) => c.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
export const normaliserMatricule = (m: string) => m.trim().replace(/[^A-Za-z0-9-]/g, '');

export function emailEmploye(code: string, matricule: string): string {
  return `${normaliserMatricule(matricule).toLowerCase()}.${normaliserCode(code).toLowerCase()}@${DOMAINE_ACCES}`;
}

export function estAccesEmploye(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(`@${DOMAINE_ACCES}`);
}

/** Matricule et code entreprise d'un identifiant employé (null pour une vraie adresse). */
export function lireAccesEmploye(email: string | null | undefined): { matricule: string; code: string } | null {
  if (!estAccesEmploye(email)) return null;
  const local = email!.split('@')[0]!;
  const i = local.lastIndexOf('.');
  return { matricule: local.slice(0, i).toUpperCase(), code: local.slice(i + 1).toUpperCase() };
}

/** Ce qu'on affiche à la place de l'adresse : « Matricule 0012 » ou l'e-mail. */
export function identifiantAffiche(email: string | null | undefined): string {
  const a = lireAccesEmploye(email);
  return a ? `Matricule ${a.matricule}` : (email ?? '');
}

export function codeEntrepriseMemorise(): string {
  try {
    return localStorage.getItem(CLE_CODE) ?? '';
  } catch {
    return '';
  }
}
export function memoriserCodeEntreprise(code: string) {
  try {
    localStorage.setItem(CLE_CODE, normaliserCode(code));
  } catch {
    /* stockage indisponible */
  }
}

/** Même règle que la base : 4 chiffres, ni tous identiques, ni suite. */
export function codeEntreeValide(c: string): boolean {
  return /^\d{4}$/.test(c) && !/^(\d)\1{3}$/.test(c) && !'0123456789'.includes(c) && !'9876543210'.includes(c);
}

/** Code d'entrée provisoire de 4 chiffres (jamais trivial). */
export function genererCodeProvisoire(): string {
  for (;;) {
    const v = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 10_000).padStart(4, '0');
    if (codeEntreeValide(v)) return v;
  }
}

// ---------------------------------------------------------------------------
// Connexion par code d'entrée (fonction serveur « connexion »)
// ---------------------------------------------------------------------------

export interface ResultatConnexion {
  ok: boolean;
  provisoire?: boolean;
  message?: string;
}

export async function connexionParCode(code: string, matricule: string, pin: string): Promise<ResultatConnexion> {
  const { supabase } = await import('./supabase');
  const { data, error } = await supabase.functions.invoke('connexion', {
    body: { code: normaliserCode(code), matricule: normaliserMatricule(matricule), pin },
  });
  if (error) {
    const statut = (error as { context?: Response }).context?.status;
    if (statut === 404) return { ok: false, message: 'La connexion par code n’est pas encore installée sur le serveur.' };
    try {
      const corps = (await (error as { context: Response }).context.json()) as { message?: string };
      if (corps.message) return { ok: false, message: corps.message };
    } catch {
      /* pas de corps lisible */
    }
    return { ok: false, message: navigator.onLine ? 'Service indisponible, réessayez.' : 'Pas de réseau : la première connexion du jour demande Internet.' };
  }
  const r = data as { ok: boolean; provisoire?: boolean; message?: string; access_token?: string; refresh_token?: string };
  if (!r.ok || !r.access_token || !r.refresh_token) return { ok: false, message: r.message ?? 'Connexion refusée.' };
  const { data: s, error: e2 } = await supabase.auth.setSession({ access_token: r.access_token, refresh_token: r.refresh_token });
  if (e2 || !s.session) return { ok: false, message: 'Session refusée, réessayez.' };
  await memoriserEmpreinte(s.session.user.id, pin);
  memoriserCodeEntreprise(code);
  return { ok: true, provisoire: r.provisoire };
}

// ---------------------------------------------------------------------------
// Empreinte locale du code (PBKDF2) : déverrouillage sans réseau après inactivité
// ---------------------------------------------------------------------------

const cleEmpreinte = (uid: string) => `dfg_empreinte_code_${uid}`;

async function empreinte(uid: string, pin: string): Promise<string | null> {
  try {
    const cle = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: new TextEncoder().encode(`dfg-entree:${uid}`), iterations: 120000, hash: 'SHA-256' },
      cle,
      256,
    );
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export async function memoriserEmpreinte(uid: string, pin: string) {
  const e = await empreinte(uid, pin);
  try {
    if (e) localStorage.setItem(cleEmpreinte(uid), e);
  } catch {
    /* stockage indisponible */
  }
}

/** true / false si l'appareil connaît le code ; null s'il ne le connaît pas. */
export async function verifierEmpreinte(uid: string, pin: string): Promise<boolean | null> {
  let connue: string | null = null;
  try {
    connue = localStorage.getItem(cleEmpreinte(uid));
  } catch {
    /* stockage indisponible */
  }
  if (!connue) return null;
  return (await empreinte(uid, pin)) === connue;
}

// ---------------------------------------------------------------------------
// Inactivité : après 5 minutes, l'application revient à l'écran du code
// ---------------------------------------------------------------------------

export const INACTIVITE_MS = 5 * 60 * 1000;
const CLE_ACTIVITE = 'dfg_derniere_activite';
const CLE_VERROU = 'dfg_verrouille';

export function noterActivite() {
  try {
    localStorage.setItem(CLE_ACTIVITE, String(Date.now()));
  } catch {
    /* rien */
  }
}
export function inactifDepuisTrop(): boolean {
  try {
    if (localStorage.getItem(CLE_VERROU) === '1') return true;
    const t = Number(localStorage.getItem(CLE_ACTIVITE) ?? 0);
    return t > 0 && Date.now() - t > INACTIVITE_MS;
  } catch {
    return false;
  }
}
export function marquerVerrou(v: boolean) {
  try {
    if (v) localStorage.setItem(CLE_VERROU, '1');
    else {
      localStorage.removeItem(CLE_VERROU);
      noterActivite();
    }
  } catch {
    /* rien */
  }
}

/** Message prêt à envoyer (WhatsApp, SMS) à un employé. */
export function messageAccesEmploye(p: { nom?: string; entreprise: string; code: string; matricule: string; codeProvisoire: string }): string {
  return [
    `Bonjour${p.nom ? ` ${p.nom}` : ''},`,
    `Votre accès à DF Gestion pour ${p.entreprise} :`,
    `• Code entreprise : ${p.code}`,
    `• Matricule : ${p.matricule}`,
    `• Code d’entrée provisoire : ${p.codeProvisoire}`,
    'À la première connexion, choisissez votre propre code d’entrée de 4 chiffres (gardez-le secret).',
  ].join('\n');
}
