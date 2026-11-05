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

/** Code provisoire de 6 chiffres. */
export function genererCodeProvisoire(): string {
  const v = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return String(v).padStart(6, '0');
}

/** Message prêt à envoyer (WhatsApp, SMS) à un employé. */
export function messageAccesEmploye(p: { nom?: string; entreprise: string; code: string; matricule: string; codeProvisoire: string }): string {
  return [
    `Bonjour${p.nom ? ` ${p.nom}` : ''},`,
    `Votre accès à DF Gestion pour ${p.entreprise} :`,
    `• Code entreprise : ${p.code}`,
    `• Matricule : ${p.matricule}`,
    `• Code provisoire : ${p.codeProvisoire}`,
    'À la première connexion, choisissez votre propre code secret (6 chiffres au moins).',
  ].join('\n');
}
