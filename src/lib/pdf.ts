import type { Cellule, Feuille } from './excel';

/**
 * Export PDF d'un tableau, sans bibliothèque : même description de feuilles que l'export Excel
 * (titre, en-têtes, lignes, totaux). Pages A4, en-têtes répétés, numéros de page.
 * Police Helvetica standard (encodage WinAnsi : accents français pris en charge).
 */
export const TYPE_PDF = 'application/pdf';

// Chasses Helvetica (millièmes de corps) pour les caractères 32 à 126.
const CHASSES = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];
const SPECIAUX: Record<string, number> = { '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97, '…': 0x85, 'œ': 0x9c, 'Œ': 0x8c, '€': 0x80, '•': 0x95 };

/** Texte → octets WinAnsi (les émojis et caractères hors alphabet latin sont retirés). */
function octets(texte: string): number[] {
  const res: number[] = [];
  for (const c of texte.normalize('NFC')) {
    const code = c.codePointAt(0)!;
    if (code === 0x202f || code === 0xa0 || code === 9) res.push(32);
    else if (code >= 32 && code <= 126) res.push(code);
    else if (code >= 0xa1 && code <= 0xff) res.push(code);
    else if (SPECIAUX[c]) res.push(SPECIAUX[c]!);
  }
  return res;
}
const SANS_ACCENT = 'AAAAAAACEEEEIIIIDNOOOOOxOUUUUYPsaaaaaaaceeeeiiiidnooooo/ouuuuypy';
function chasse(o: number, gras: boolean): number {
  const base = o >= 32 && o <= 126 ? CHASSES[o - 32]! : o >= 0xc0 ? (CHASSES[SANS_ACCENT.charCodeAt(o - 0xc0) - 32] ?? 556) : 556;
  return gras ? base * 1.06 : base;
}
const largeur = (os: number[], corps: number, gras = false) => (os.reduce((s, o) => s + chasse(o, gras), 0) * corps) / 1000;

function chaine(os: number[]): string {
  let s = '(';
  for (const o of os) s += o === 40 || o === 41 || o === 92 ? `\\${String.fromCharCode(o)}` : String.fromCharCode(o);
  return `${s})`;
}

function tronquer(os: number[], max: number, corps: number, gras: boolean): number[] {
  if (largeur(os, corps, gras) <= max) return os;
  const res = [...os];
  while (res.length > 1 && largeur([...res, 0x85], corps, gras) > max) res.pop();
  return [...res, 0x85];
}

const estNombre = (v: Cellule) => typeof v === 'number';
function texteCellule(v: Cellule): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('fr-FR') : v.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
  return String(v);
}

export function classeurPdf(feuilles: Feuille[], options: { entreprise?: string } = {}): Uint8Array {
  const pages: string[] = [];
  const formats: [number, number][] = [];
  const date = new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

  for (const f of feuilles) {
    const nb = f.entetes.length;
    const paysage = nb > 6;
    const [L, H] = paysage ? [842, 595] : [595, 842];
    const marge = 30;
    const utile = L - 2 * marge;
    const corps = nb > 11 ? 6.5 : nb > 8 ? 7.5 : 8.5;
    const hauteurLigne = corps + 6;
    const toutes = [...f.lignes, ...(f.totaux ? [f.totaux] : [])];
    // Largeur des colonnes : selon le contenu (échantillon), bornée, puis ramenée à la largeur utile.
    const droite = f.entetes.map((_, i) => toutes.some((l) => estNombre(l[i])) && toutes.every((l) => l[i] === null || l[i] === undefined || l[i] === '' || estNombre(l[i])));
    const naturelles = f.entetes.map((e, i) => {
      let m = largeur(octets(e), corps, true);
      for (const l of toutes.slice(0, 400)) m = Math.max(m, largeur(octets(texteCellule(l[i])), corps));
      return Math.min(Math.max(m + 8, 26), 230);
    });
    const somme = naturelles.reduce((s, x) => s + x, 0);
    const cols = naturelles.map((x) => (x * utile) / somme);
    const xs = cols.map((_, i) => marge + cols.slice(0, i).reduce((s, x) => s + x, 0));

    let flux = '';
    let y = 0;
    const texte = (os: number[], x: number, yy: number, c: number, gras = false) => {
      flux += `BT /${gras ? 'F2' : 'F1'} ${c} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td ${chaine(os)} Tj ET\n`;
    };
    const ligne = (valeurs: Cellule[], gras: boolean, fond?: string) => {
      if (fond) flux += `${fond} rg ${marge} ${(y - 4).toFixed(1)} ${utile} ${hauteurLigne} re f 0 g\n`;
      valeurs.slice(0, nb).forEach((v, i) => {
        const os = tronquer(octets(gras && typeof v === 'string' ? v : texteCellule(v)), cols[i]! - 6, corps, gras);
        const x = droite[i] ? xs[i]! + cols[i]! - 3 - largeur(os, corps, gras) : xs[i]! + 3;
        if (os.length) texte(os, x, y, corps, gras);
      });
      y -= hauteurLigne;
    };
    const debutPage = (premiere: boolean) => {
      flux = '';
      y = H - marge - 10;
      if (premiere) {
        if (options.entreprise) {
          texte(octets(options.entreprise), marge, y, 9, true);
          y -= 16;
        }
        (f.titre?.length ? f.titre : [f.nom]).forEach((t, k) => {
          texte(tronquer(octets(t), utile, k ? 9 : 13, !k), marge, y, k ? 9 : 13, !k);
          y -= k ? 13 : 18;
        });
        y -= 4;
      }
      ligne(f.entetes, true, '0.89 0.87 0.83');
    };
    const finPage = () => {
      pages.push(flux);
      formats.push([L, H]);
    };

    debutPage(true);
    f.lignes.forEach((l, k) => {
      if (y < marge + 24) {
        finPage();
        debutPage(false);
      }
      ligne(l, false, k % 2 ? '0.965 0.96 0.95' : undefined);
    });
    if (f.totaux) {
      if (y < marge + 24) {
        finPage();
        debutPage(false);
      }
      flux += `0.2 G 0.8 w ${marge} ${(y + corps + 3).toFixed(1)} m ${L - marge} ${(y + corps + 3).toFixed(1)} l S\n`;
      ligne(f.totaux, true);
    }
    finPage();
  }

  // Pied de page (numéro et date), puis assemblage du fichier.
  const total = pages.length;
  const objets: string[] = [];
  const ajouter = (corps: string) => objets.push(corps);
  ajouter('<< /Type /Catalog /Pages 2 0 R >>');
  ajouter(`<< /Type /Pages /Count ${total} /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] >>`);
  ajouter('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  ajouter('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  pages.forEach((p, i) => {
    const [L, H] = formats[i]!;
    const pied = octets(`DF Gestion · édité le ${date}`);
    const num = octets(`Page ${i + 1} / ${total}`);
    const contenu = `${p}0.45 g\nBT /F1 7 Tf 30 16 Td ${chaine(pied)} Tj ET\nBT /F1 7 Tf ${(L - 30 - largeur(num, 7)).toFixed(1)} 16 Td ${chaine(num)} Tj ET\n`;
    ajouter(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${L} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    ajouter(`<< /Length ${contenu.length} >>\nstream\n${contenu}endstream`);
  });
  let sortie = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const positions: number[] = [];
  objets.forEach((o, i) => {
    positions.push(sortie.length);
    sortie += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = sortie.length;
  sortie += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n${positions.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}`;
  sortie += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const res = new Uint8Array(sortie.length);
  for (let i = 0; i < sortie.length; i++) res[i] = sortie.charCodeAt(i) & 0xff;
  return res;
}
