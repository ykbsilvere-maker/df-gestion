import { pontAndroid } from './android';

/**
 * Écriture d'un classeur Excel (.xlsx) sans dépendance : un .xlsx est une
 * archive ZIP de quelques fichiers XML. Les fichiers sont stockés sans
 * compression (format ZIP « stored »), ce qu'Excel, LibreOffice et Google
 * Sheets lisent sans difficulté.
 */

export type Cellule = string | number | null | undefined;

export interface Feuille {
  nom: string;
  entetes: string[];
  lignes: Cellule[][];
  /** Ligne de totaux ajoutée en gras sous le tableau. */
  totaux?: Cellule[];
  /** Lignes d'information au-dessus du tableau (titre, période, filtres). */
  titre?: string[];
  largeurs?: number[];
}

const encodeur = new TextEncoder();

const TABLE_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(octets: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < octets.length; i++) c = TABLE_CRC[(c ^ octets[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Archive ZIP non compressée. */
export function zip(fichiers: { nom: string; contenu: Uint8Array }[]): Uint8Array {
  const morceaux: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let decalage = 0;
  for (const f of fichiers) {
    const nom = encodeur.encode(f.nom);
    const crc = crc32(f.contenu);
    const taille = f.contenu.length;
    const entete = new DataView(new ArrayBuffer(30));
    entete.setUint32(0, 0x04034b50, true);
    entete.setUint16(4, 20, true);
    entete.setUint16(6, 0x0800, true); // noms en UTF-8
    entete.setUint16(8, 0, true); // stocké
    entete.setUint16(10, 0, true);
    entete.setUint16(12, 0x21, true); // 1980-01-01
    entete.setUint32(14, crc, true);
    entete.setUint32(18, taille, true);
    entete.setUint32(22, taille, true);
    entete.setUint16(26, nom.length, true);
    entete.setUint16(28, 0, true);
    morceaux.push(new Uint8Array(entete.buffer), nom, f.contenu);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, 0, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, taille, true);
    c.setUint32(24, taille, true);
    c.setUint16(28, nom.length, true);
    c.setUint32(42, decalage, true);
    central.push(new Uint8Array(c.buffer), nom);
    decalage += 30 + nom.length + taille;
  }
  const tailleCentral = central.reduce((s, x) => s + x.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true);
  fin.setUint16(8, fichiers.length, true);
  fin.setUint16(10, fichiers.length, true);
  fin.setUint32(12, tailleCentral, true);
  fin.setUint32(16, decalage, true);
  const tout = [...morceaux, ...central, new Uint8Array(fin.buffer)];
  const sortie = new Uint8Array(tout.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of tout) {
    sortie.set(x, p);
    p += x.length;
  }
  return sortie;
}

const xml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // caractères de contrôle interdits en XML
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function colonne(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Styles : 0 normal, 1 en-tête (gras, fond), 2 nombre « # ##0 », 3 total gras, 4 total nombre gras, 5 titre gras
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.###"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF4"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cellule(ref: string, v: Cellule, styleTexte: number, styleNombre: number): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${styleNombre}"><v>${v}</v></c>`;
  return `<c r="${ref}" s="${styleTexte}" t="inlineStr"><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
}

function feuilleXml(f: Feuille): string {
  const lignes: string[] = [];
  let r = 1;
  for (const t of f.titre ?? []) {
    lignes.push(`<row r="${r}">${cellule(`A${r}`, t, 5, 5)}</row>`);
    r++;
  }
  if (f.titre?.length) r++;
  const ligneEntete = r;
  lignes.push(`<row r="${r}">${f.entetes.map((e, i) => cellule(`${colonne(i)}${r}`, e, 1, 1)).join('')}</row>`);
  r++;
  for (const l of f.lignes) {
    lignes.push(`<row r="${r}">${l.map((v, i) => cellule(`${colonne(i)}${r}`, v, 0, 2)).join('')}</row>`);
    r++;
  }
  if (f.totaux) {
    lignes.push(`<row r="${r}">${f.totaux.map((v, i) => cellule(`${colonne(i)}${r}`, v, 3, 4)).join('')}</row>`);
  }
  const largeurs = f.entetes.map((e, i) => {
    const imposee = f.largeurs?.[i];
    if (imposee) return imposee;
    const max = Math.max(e.length, ...f.lignes.slice(0, 200).map((l) => String(l[i] ?? '').length));
    return Math.min(45, Math.max(8, max + 2));
  });
  const cols = `<cols>${largeurs.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
  const figer = `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${ligneEntete}" topLeftCell="A${ligneEntete + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${figer}${cols}<sheetData>${lignes.join('')}</sheetData></worksheet>`;
}

/** Nom d'onglet accepté par Excel : 31 caractères, sans : \ / ? * [ ]. */
function nomOnglet(nom: string, i: number): string {
  const n = nom.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31);
  return n || `Feuille${i + 1}`;
}

export function classeurXlsx(feuilles: Feuille[]): Uint8Array {
  const noms = feuilles.map((f, i) => nomOnglet(f.nom, i));
  const fichiers: { nom: string; contenu: string }[] = [
    {
      nom: '[Content_Types].xml',
      contenu: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${feuilles.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
    },
    {
      nom: '_rels/.rels',
      contenu: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      nom: 'xl/workbook.xml',
      contenu: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${noms
        .map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    },
    {
      nom: 'xl/_rels/workbook.xml.rels',
      contenu: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${feuilles
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}<Relationship Id="rId${feuilles.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { nom: 'xl/styles.xml', contenu: STYLES },
    ...feuilles.map((f, i) => ({ nom: `xl/worksheets/sheet${i + 1}.xml`, contenu: feuilleXml(f) })),
  ];
  return zip(fichiers.map((f) => ({ nom: f.nom, contenu: encodeur.encode(f.contenu) })));
}

export const TYPE_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function enBase64(octets: Uint8Array): string {
  let s = '';
  const pas = 0x8000;
  for (let i = 0; i < octets.length; i += pas) s += String.fromCharCode(...octets.subarray(i, i + pas));
  return btoa(s);
}

/**
 * Enregistre un fichier binaire : « Téléchargements » dans l'application Android,
 * téléchargement classique dans un navigateur. Renvoie false si l'APK installé
 * est trop ancien pour enregistrer un fichier binaire.
 */
export function telechargerFichier(nom: string, type: string, octets: Uint8Array): boolean {
  const android = pontAndroid();
  if (android) {
    if (!android.enregistrerBase64) return false;
    const message = android.enregistrerBase64(nom, type, enBase64(octets));
    if (message) window.alert(message);
    return true;
  }
  // Copie dans un ArrayBuffer simple (exigé par les types DOM récents pour Blob).
  const blob = new Blob([octets.slice().buffer as ArrayBuffer], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nom;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
