/**
 * Lecture d'un classeur Excel (.xlsx) ou d'un fichier CSV, sans dépendance.
 * Un .xlsx est une archive ZIP de fichiers XML : on lit le répertoire central de l'archive,
 * on décompresse les fichiers utiles (méthode « deflate », via DecompressionStream) puis on
 * extrait les cellules de chaque feuille. Les cellules sont rendues en texte ou en nombre.
 */

export type Valeur = string | number | null;
export interface ImageFeuille {
  /** Ligne et colonne (à partir de 0) de la cellule où l'image est posée. */
  ligne: number;
  colonne: number;
  octets: Uint8Array;
  type: string;
}
export interface FeuilleLue {
  nom: string;
  lignes: Valeur[][];
  /** Images collées dans la feuille (posées sur une cellule ou placées dans la cellule). */
  images?: ImageFeuille[];
}

const TYPES_IMAGE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

/** Chemin d'une cible de relation, relatif au fichier qui la déclare. */
function resoudre(source: string, cible: string): string {
  if (cible.startsWith('/')) return cible.slice(1);
  const parties = source.split('/').slice(0, -1);
  for (const p of cible.split('/')) {
    if (p === '..') parties.pop();
    else if (p !== '.') parties.push(p);
  }
  return parties.join('/');
}

/** Relations d'un fichier de l'archive : identifiant → chemin complet. */
function relations(f: Map<string, Uint8Array>, fichier: string): Map<string, string> {
  const i = fichier.lastIndexOf('/');
  const chemin = `${fichier.slice(0, i)}/_rels/${fichier.slice(i + 1)}.rels`;
  const res = new Map<string, string>();
  const xml = f.get(chemin);
  if (!xml) return res;
  for (const m of decodeur.decode(xml).matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attribut(m[0], 'Id');
    const cible = attribut(m[0], 'Target');
    if (id && cible && attribut(m[0], 'TargetMode') !== 'External') res.set(id, resoudre(fichier, cible));
  }
  return res;
}

function image(f: Map<string, Uint8Array>, chemin: string | undefined): { octets: Uint8Array; type: string } | null {
  if (!chemin) return null;
  const octets = f.get(chemin);
  const type = TYPES_IMAGE[(chemin.split('.').pop() ?? '').toLowerCase()];
  return octets && type ? { octets, type } : null;
}

/** Images « dans la cellule » d'Excel 365 : index de métadonnée (vm, à partir de 1) → image. */
function imagesDansCellule(f: Map<string, Uint8Array>): (vm: number) => { octets: Uint8Array; type: string } | null {
  const lire = (n: string) => (f.has(n) ? decodeur.decode(f.get(n)) : '');
  const valeurs = lire('xl/richData/rdrichvalue.xml');
  if (!valeurs) return () => null;
  // Position de la clé « image locale » dans chaque structure de valeur.
  const positions: number[] = [];
  for (const s of lire('xl/richData/rdrichvaluestructure.xml').matchAll(/<s\s[^>]*>([\s\S]*?)<\/s>/g)) {
    const cles = [...s[1]!.matchAll(/<k\s[^>]*>/g)].map((k) => attribut(k[0], 'n') ?? '');
    positions.push(Math.max(0, cles.indexOf('_rvRel:LocalImageIdentifier')));
  }
  const rv = [...valeurs.matchAll(/<rv\s([^>]*)>([\s\S]*?)<\/rv>/g)].map((m) => {
    const vs = [...m[2]!.matchAll(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/g)].map((v) => v[1]!);
    return Number(vs[positions[Number(attribut(` ${m[1]}`, 's') ?? 0)] ?? 0]);
  });
  const liens = relations(f, 'xl/richData/richValueRel.xml');
  const rels = [...lire('xl/richData/richValueRel.xml').matchAll(/<rel\s[^>]*>/g)].map((m) => liens.get(attribut(m[0], 'r:id') ?? ''));
  // metadata.xml : valueMetadata[vm-1] → futureMetadata[v] → rvb i (index de la valeur enrichie).
  const meta = lire('xl/metadata.xml');
  const futur = /<futureMetadata\s[^>]*name="XLRICHVALUE"[^>]*>([\s\S]*?)<\/futureMetadata>/.exec(meta)?.[1] ?? '';
  const rvb = [...futur.matchAll(/<bk>([\s\S]*?)<\/bk>/g)].map((b) => Number(/rvb\s[^>]*i="(\d+)"/.exec(b[1]!)?.[1] ?? -1));
  const vmeta = /<valueMetadata[^>]*>([\s\S]*?)<\/valueMetadata>/.exec(meta)?.[1] ?? '';
  const vers = [...vmeta.matchAll(/<bk>([\s\S]*?)<\/bk>/g)].map((b) => Number(/<rc\s[^>]*v="(\d+)"/.exec(b[1]!)?.[1] ?? -1));
  return (vm) => {
    const iv = vers.length ? rvb[vers[vm - 1] ?? -1] ?? -1 : vm - 1;
    return image(f, rels[rv[iv] ?? -1]);
  };
}

/** Images de WPS Office (fonction DISPIMG) : identifiant → image. */
function imagesWps(f: Map<string, Uint8Array>): Map<string, { octets: Uint8Array; type: string }> {
  const res = new Map<string, { octets: Uint8Array; type: string }>();
  const xml = f.get('xl/cellimages.xml');
  if (!xml) return res;
  const liens = relations(f, 'xl/cellimages.xml');
  for (const m of decodeur.decode(xml).matchAll(/<(?:\w+:)?cellImage>([\s\S]*?)<\/(?:\w+:)?cellImage>/g)) {
    const nom = /<(?:\w+:)?cNvPr\s[^>]*name="([^"]+)"/.exec(m[1]!)?.[1];
    const rid = /<(?:\w+:)?blip\s[^>]*r:embed="([^"]+)"/.exec(m[1]!)?.[1];
    const im = image(f, liens.get(rid ?? ''));
    if (nom && im) res.set(nom, im);
  }
  return res;
}

/** Images posées sur la feuille (dessin) : ancrées à la cellule de leur coin haut-gauche. */
function imagesDessin(f: Map<string, Uint8Array>, feuille: string, xml: string): ImageFeuille[] {
  const rid = /<drawing\s[^>]*r:id="([^"]+)"/.exec(xml)?.[1];
  const dessin = rid && relations(f, feuille).get(rid);
  const contenu = dessin && f.get(dessin);
  if (!dessin || !contenu) return [];
  const liens = relations(f, dessin);
  const res: ImageFeuille[] = [];
  for (const a of decodeur.decode(contenu).matchAll(/<(?:\w+:)?(twoCellAnchor|oneCellAnchor)[\s>][\s\S]*?<\/(?:\w+:)?\1>/g)) {
    const de = /<(?:\w+:)?from>([\s\S]*?)<\/(?:\w+:)?from>/.exec(a[0])?.[1] ?? '';
    const col = Number(/<(?:\w+:)?col>(\d+)</.exec(de)?.[1] ?? NaN);
    const ligne = Number(/<(?:\w+:)?row>(\d+)</.exec(de)?.[1] ?? NaN);
    const decalage = Number(/<(?:\w+:)?rowOff>(\d+)</.exec(de)?.[1] ?? 0);
    const vers = /<(?:\w+:)?to>([\s\S]*?)<\/(?:\w+:)?to>/.exec(a[0])?.[1];
    const ligneFin = vers ? Number(/<(?:\w+:)?row>(\d+)</.exec(vers)?.[1] ?? ligne) : ligne;
    const im = image(f, liens.get(/<(?:\w+:)?blip\s[^>]*r:embed="([^"]+)"/.exec(a[0])?.[1] ?? ''));
    if (!im || !Number.isFinite(col) || !Number.isFinite(ligne)) continue;
    // Image commencée tout en bas d'une ligne (plus de 2/3 de sa hauteur) : on la rattache à la suivante.
    const surLaSuivante = ligneFin > ligne && decalage > 0.66 * 190500;
    res.push({ ligne: surLaSuivante ? ligne + 1 : ligne, colonne: col, ...im });
  }
  return res;
}

const decodeur = new TextDecoder('utf-8');

async function inflater(octets: Uint8Array): Promise<Uint8Array> {
  const flux = new Blob([octets.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
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
  const f = await lireZip(donnees, (n) =>
    /^xl\/(workbook\.xml|_rels\/(workbook|cellimages)\.xml\.rels|sharedStrings\.xml|styles\.xml|metadata\.xml|cellimages\.xml|worksheets\/(_rels\/)?[^/]+\.xml(\.rels)?|drawings\/(_rels\/)?[^/]+\.xml(\.rels)?|richData\/(_rels\/)?[^/]+\.xml(\.rels)?|media\/[^/]+)$/.test(n),
  );
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
  const dansCellule = imagesDansCellule(f);
  const wps = imagesWps(f);
  const feuilles: FeuilleLue[] = [];
  for (const m of classeur.matchAll(/<sheet\s[^>]*>/g)) {
    const nom = attribut(m[0], 'name') ?? `Feuille${feuilles.length + 1}`;
    const rid = attribut(m[0], 'r:id');
    const chemin = (rid && liens.get(rid)) || `xl/worksheets/sheet${feuilles.length + 1}.xml`;
    const xml = lire(chemin);
    if (!xml) continue;
    const lignes: Valeur[][] = [];
    const images = imagesDessin(f, chemin, xml);
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
        const vm = Number(attribut(att, 'vm') ?? 0);
        const dispimg = /DISPIMG\(\s*(?:&quot;|")([^"&]+)/.exec(corps)?.[1];
        const im = (vm > 0 && dansCellule(vm)) || (dispimg && wps.get(dispimg)) || null;
        if (im) {
          images.push({ ligne: num, colonne: col, ...im });
          ligne[col] = null;
          continue;
        }
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
    feuilles.push({ nom, lignes, images });
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
