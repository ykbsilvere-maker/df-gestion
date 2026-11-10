/**
 * Lecture d'un classeur Excel (.xlsx) ou d'un fichier CSV, sans dépendance.
 * Un .xlsx est une archive ZIP de fichiers XML : on lit le répertoire central de l'archive,
 * on décompresse les fichiers utiles (méthode « deflate », via DecompressionStream) puis on
 * extrait les cellules de chaque feuille. Les cellules sont rendues en texte ou en nombre.
 */

export type Valeur = string | number | null;
export interface FeuilleLue {
  nom: string;
  lignes: Valeur[][];
}

const decodeur = new TextDecoder('utf-8');

async function inflater(octets: Uint8Array): Promise<Uint8Array> {
  const flux = new Blob([octets]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(flux).arrayBuffer());
}

/** Fichiers d'une archive ZIP (seulement ceux dont le nom est demandé, ou tous). */
export async function lireZip(donnees: Uint8Array, filtre?: (nom: string) => boolean): Promise<Map<string, Uint8Array>> {
  const vue = new DataView(donnees.buffer, donnees.byteOffset, donnees.byteLength);
  let fin = -1;
  for (let i = donnees.length - 22; i >= Math.max(0, donnees.length - 65557); i--) {
    if (vue.getUint32(i, true) === 0x06054b50) {
      fin = i;
      break;
    }
  }
  if (fin < 0) throw new Error('Fichier illisible : ce n’est pas un classeur Excel (.xlsx).');
  const nombre = vue.getUint16(fin + 10, true);
  let pos = vue.getUint32(fin + 16, true);
  const fichiers = new Map<string, Uint8Array>();
  for (let k = 0; k < nombre; k++) {
    if (vue.getUint32(pos, true) !== 0x02014b50) throw new Error('Archive Excel abîmée.');
    const methode = vue.getUint16(pos + 10, true);
    const tailleComp = vue.getUint32(pos + 20, true);
    const lgNom = vue.getUint16(pos + 28, true);
    const lgExtra = vue.getUint16(pos + 30, true);
    const lgComm = vue.getUint16(pos + 32, true);
    const local = vue.getUint32(pos + 42, true);
    const nom = decodeur.decode(donnees.subarray(pos + 46, pos + 46 + lgNom));
    pos += 46 + lgNom + lgExtra + lgComm;
    if (filtre && !filtre(nom)) continue;
    const debut = local + 30 + vue.getUint16(local + 26, true) + vue.getUint16(local + 28, true);
    const brut = donnees.subarray(debut, debut + tailleComp);
    if (methode === 0) fichiers.set(nom, brut);
    else if (methode === 8) fichiers.set(nom, await inflater(brut));
    else throw new Error('Compression non prise en charge dans ce fichier : enregistrez-le de nouveau depuis Excel.');
  }
  return fichiers;
}

function entites(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    return String.fromCodePoint(e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

/** Texte d'un nœud (concatène les <t> d'un texte enrichi). */
function texte(xml: string): string {
  let s = '';
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) s += m[1] ?? '';
  return entites(s);
}

function attribut(balise: string, nom: string): string | null {
  const m = new RegExp(`\\s${nom}="([^"]*)"`).exec(balise);
  return m ? entites(m[1]!) : null;
}

function indexColonne(ref: string): number {
  let n = 0;
  for (const c of ref.replace(/\d+$/, '')) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** Styles de cellule qui affichent une date (pour convertir les numéros de série Excel). */
function stylesDate(stylesXml: string | undefined): Set<number> {
  const res = new Set<number>();
  if (!stylesXml) return res;
  const formatsDate = new Set([14, 15, 16, 17, 22, 27, 30, 36, 50, 57]);
  for (const m of stylesXml.matchAll(/<numFmt\s[^>]*>/g)) {
    const id = Number(attribut(m[0], 'numFmtId'));
    const code = (attribut(m[0], 'formatCode') ?? '').toLowerCase().replace(/"[^"]*"|\[[^\]]*\]/g, '');
    if (/[dy]/.test(code) || (/m/.test(code) && !/[h:s]/.test(code) && /[\/\-.]/.test(code))) formatsDate.add(id);
  }
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  let i = 0;
  for (const m of xfs.matchAll(/<xf\s[^>]*?\/?>/g)) {
    if (formatsDate.has(Number(attribut(m[0], 'numFmtId')))) res.add(i);
    i++;
  }
  return res;
}

/** Numéro de série Excel (jours depuis 1899-12-30) → AAAA-MM-JJ. */
export function dateExcel(n: number): string {
  const ms = Math.round((n - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

export async function lireXlsx(donnees: Uint8Array): Promise<FeuilleLue[]> {
  const f = await lireZip(donnees, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(n));
  const lire = (n: string) => (f.has(n) ? decodeur.decode(f.get(n)) : undefined);
  const classeur = lire('xl/workbook.xml');
  if (!classeur) throw new Error('Fichier illisible : ce n’est pas un classeur Excel (.xlsx).');
  const partages: string[] = [];
  for (const m of (lire('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)) partages.push(texte(m[1]!));
  const dates = stylesDate(lire('xl/styles.xml'));
  const liens = new Map<string, string>();
  for (const m of (lire('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attribut(m[0], 'Id');
    const cible = attribut(m[0], 'Target');
    if (id && cible) liens.set(id, cible.replace(/^\/?(xl\/)?/, 'xl/'));
  }
  const feuilles: FeuilleLue[] = [];
  for (const m of classeur.matchAll(/<sheet\s[^>]*>/g)) {
    const nom = attribut(m[0], 'name') ?? `Feuille${feuilles.length + 1}`;
    const rid = attribut(m[0], 'r:id');
    const chemin = (rid && liens.get(rid)) || `xl/worksheets/sheet${feuilles.length + 1}.xml`;
    const xml = lire(chemin);
    if (!xml) continue;
    const lignes: Valeur[][] = [];
    for (const r of xml.matchAll(/<row\s([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const num = Number(attribut(` ${r[1]}`, 'r') ?? lignes.length + 1) - 1;
      const ligne: Valeur[] = [];
      for (const c of (r[2] ?? '').matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const att = ` ${c[1]}`;
        const ref = attribut(att, 'r');
        const col = ref ? indexColonne(ref) : ligne.length;
        const type = attribut(att, 't');
        const corps = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(corps)?.[1];
        let val: Valeur = null;
        if (type === 's') val = partages[Number(v)] ?? null;
        else if (type === 'inlineStr') val = texte(corps);
        else if (type === 'str' || type === 'e') val = v !== undefined ? entites(v) : null;
        else if (type === 'b') val = v === '1' ? 'oui' : 'non';
        else if (v !== undefined && v !== '') {
          const n = Number(v);
          val = Number.isFinite(n) ? (dates.has(Number(attribut(att, 's') ?? -1)) ? dateExcel(n) : n) : entites(v);
        }
        ligne[col] = typeof val === 'string' ? val.trim() || null : val;
      }
      for (let i = 0; i < ligne.length; i++) if (ligne[i] === undefined) ligne[i] = null;
      lignes[num] = ligne;
    }
    for (let i = 0; i < lignes.length; i++) if (!lignes[i]) lignes[i] = [];
    feuilles.push({ nom, lignes });
  }
  return feuilles;
}

/** CSV (séparateur « ; », « , » ou tabulation, guillemets doubles), tel qu'exporté par Excel. */
export function lireCsv(contenu: string): FeuilleLue[] {
  const t = contenu.replace(/^﻿/, '');
  const premiere = t.split(/\r?\n/, 1)[0] ?? '';
  const sep = [';', '\t', ','].map((s) => [s, premiere.split(s).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const lignes: Valeur[][] = [];
  let ligne: Valeur[] = [];
  let champ = '';
  let guillemets = false;
  const pousserChamp = () => {
    const v = champ.trim();
    ligne.push(v === '' ? null : v);
    champ = '';
  };
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (guillemets) {
      if (c === '"' && t[i + 1] === '"') {
        champ += '"';
        i++;
      } else if (c === '"') guillemets = false;
      else champ += c;
    } else if (c === '"') guillemets = true;
    else if (c === sep) pousserChamp();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      pousserChamp();
      lignes.push(ligne);
      ligne = [];
    } else champ += c;
  }
  if (champ !== '' || ligne.length) {
    pousserChamp();
    lignes.push(ligne);
  }
  return [{ nom: 'CSV', lignes }];
}

/** Lit un fichier choisi par l'utilisateur (.xlsx ou .csv). */
export async function lireFichierTableur(fichier: File): Promise<FeuilleLue[]> {
  const nom = fichier.name.toLowerCase();
  if (nom.endsWith('.csv') || nom.endsWith('.txt')) {
    const octets = new Uint8Array(await fichier.arrayBuffer());
    let texteCsv = new TextDecoder('utf-8', { fatal: false }).decode(octets);
    if (texteCsv.includes('�')) texteCsv = new TextDecoder('windows-1252').decode(octets);
    return lireCsv(texteCsv);
  }
  if (nom.endsWith('.xls')) throw new Error('Ancien format Excel (.xls) : enregistrez le fichier au format « Classeur Excel (.xlsx) ».');
  return lireXlsx(new Uint8Array(await fichier.arrayBuffer()));
}
