/**
 * Monnaies. Les montants sont des entiers dans la plus petite unité de la monnaie
 * de l'entreprise (1 XOF, 1 centime d'euro…) : c'est ce que stocke la base.
 * La monnaie courante est fixée dès que l'entreprise est connue (session).
 */
export interface Devise {
  code: string;
  libelle: string;
  drapeau: string;
  symbole: string; // affiché après le montant
  decimales: number;
  billets: number[]; // en plus petite unité, du plus grand au plus petit
  pieces: number[];
}

export const DEVISES: Record<string, Devise> = {
  XOF: { code: 'XOF', libelle: 'Franc CFA (UEMOA)', drapeau: '🇨🇮', symbole: 'XOF', decimales: 0,
    billets: [10000, 5000, 2000, 1000, 500], pieces: [500, 250, 200, 100, 50, 25, 10, 5] },
  XAF: { code: 'XAF', libelle: 'Franc CFA (CEMAC)', drapeau: '🇨🇲', symbole: 'XAF', decimales: 0,
    billets: [10000, 5000, 2000, 1000, 500], pieces: [500, 100, 50, 25, 10, 5, 2, 1] },
  EUR: { code: 'EUR', libelle: 'Euro', drapeau: '🇪🇺', symbole: '€', decimales: 2,
    billets: [50000, 20000, 10000, 5000, 2000, 1000, 500], pieces: [200, 100, 50, 20, 10, 5, 2, 1] },
  USD: { code: 'USD', libelle: 'Dollar américain', drapeau: '🇺🇸', symbole: '$', decimales: 2,
    billets: [10000, 5000, 2000, 1000, 500, 200, 100], pieces: [25, 10, 5, 1] },
  GBP: { code: 'GBP', libelle: 'Livre sterling', drapeau: '🇬🇧', symbole: '£', decimales: 2,
    billets: [5000, 2000, 1000, 500], pieces: [200, 100, 50, 20, 10, 5, 2, 1] },
  GNF: { code: 'GNF', libelle: 'Franc guinéen', drapeau: '🇬🇳', symbole: 'GNF', decimales: 0,
    billets: [20000, 10000, 5000, 2000, 1000, 500], pieces: [] },
  MAD: { code: 'MAD', libelle: 'Dirham marocain', drapeau: '🇲🇦', symbole: 'MAD', decimales: 2,
    billets: [20000, 10000, 5000, 2000], pieces: [1000, 500, 200, 100, 50, 20, 10] },
  GHS: { code: 'GHS', libelle: 'Cedi ghanéen', drapeau: '🇬🇭', symbole: 'GH₵', decimales: 2,
    billets: [20000, 10000, 5000, 2000, 1000, 500, 200, 100], pieces: [200, 100, 50, 20, 10] },
  NGN: { code: 'NGN', libelle: 'Naira nigérian', drapeau: '🇳🇬', symbole: '₦', decimales: 2,
    billets: [100000, 50000, 20000, 10000, 5000], pieces: [] },
};

let courante: Devise = DEVISES.XOF!;

export function devise(code?: string | null): Devise {
  return (code && DEVISES[code.trim().toUpperCase()]) || DEVISES.XOF!;
}

/** Fixe la monnaie de l'entreprise ouverte (appelé par la session). */
export function definirDevise(code: string | null | undefined) {
  courante = devise(code);
}

export function deviseCourante(): Devise {
  return courante;
}

const formats = new Map<number, Intl.NumberFormat>();
function format(decimales: number): Intl.NumberFormat {
  let f = formats.get(decimales);
  if (!f) {
    f = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
    formats.set(decimales, f);
  }
  return f;
}

/** Nombre sans symbole : 450000 XOF → « 450 000 » ; 1250 EUR → « 12,50 » (espaces simples : lisibles sur toutes les imprimantes). */
export function nombreMonnaie(v: number | string | null | undefined, d: Devise = courante): string {
  const n = Math.round(Number(v ?? 0));
  return format(d.decimales).format(n / 10 ** d.decimales).replace(/[  ]/g, ' ');
}

/**
 * Montant affiché : 4500 → « 4 500 XOF » ; en euros 1250 → « 12,50 € ».
 * `suffixe` remplace le symbole (« '' » pour un nombre seul).
 */
export function montant(v: number | string | null | undefined, suffixe?: string): string {
  return nombreMonnaie(v) + (suffixe ?? ` ${courante.symbole}`);
}

/** Même chose dans une monnaie donnée (console de l'administrateur : chaque entreprise a la sienne). */
export function montantEn(v: number | string | null | undefined, code: string | null | undefined): string {
  const d = devise(code);
  return `${nombreMonnaie(v, d)} ${d.symbole}`;
}

/** Billet ou pièce : « 10 000 », « 50 € », « 0,20 € ». */
export function libelleCoupure(v: number, d: Devise = courante): string {
  const entier = v % 10 ** d.decimales === 0;
  const txt = entier ? format(0).format(v / 10 ** d.decimales) : format(d.decimales).format(v / 10 ** d.decimales);
  return txt.replace(/[  ]/g, ' ') + (d.decimales ? ` ${d.symbole}` : '');
}

/**
 * Lit un montant saisi en plus petite unité, ou null si vide/invalide.
 * XOF : « 4 500 », « 4500 F » → 4500. Euro : « 12,50 », « 12.5 € », « 1 234,5 » → 1250, 1250, 123450.
 */
export function lireMontant(saisie: string, d: Devise = courante): number | null {
  if (d.decimales === 0) {
    const chiffres = saisie.replace(/[^\d]/g, '');
    if (!chiffres) return null;
    const n = Number(chiffres);
    return Number.isSafeInteger(n) ? n : null;
  }
  const propre = saisie.replace(/[^\d.,]/g, '');
  if (!/\d/.test(propre)) return null;
  // Le dernier séparateur suivi de 1 ou 2 chiffres est la virgule décimale ; les autres sont des séparateurs de milliers.
  const m = propre.match(/^(.*?)[.,](\d{1,2})$/);
  const entiers = (m ? m[1]! : propre).replace(/[.,]/g, '');
  const decimales = m ? m[2]!.padEnd(2, '0') : '00';
  const n = Number(entiers || '0') * 100 + Number(decimales);
  return Number.isSafeInteger(n) ? n : null;
}

/** Valeur à placer dans un champ de saisie : 8450 → « 8450 » (XOF) ; 1250 → « 12,50 » (euro). */
export function saisieMontant(v: number | string | null | undefined, d: Devise = courante): string {
  const n = Math.round(Number(v ?? 0));
  if (!d.decimales) return String(n);
  return (n / 10 ** d.decimales).toFixed(d.decimales).replace('.', ',');
}

/** Valeur numérique pour un export Excel/CSV, en unités de la monnaie : 1250 centimes → 12.5. */
export function enUnites(v: number | string | null | undefined, d: Devise = courante): number {
  return Number((Math.round(Number(v ?? 0)) / 10 ** d.decimales).toFixed(d.decimales));
}

/** Clavier à proposer pour la saisie d'un montant (virgule seulement si la monnaie a des centimes). */
export function clavierMontant(): 'numeric' | 'decimal' {
  return courante.decimales ? 'decimal' : 'numeric';
}
