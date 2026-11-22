import { pointsPct, zip, type Cellule, type Feuille } from './excel';

/**
 * Export Word (.docx), sans bibliothèque : même description de feuilles que les exports Excel et PDF
 * (titre, en-têtes, lignes, totaux). Un vrai document Word, modifiable : titre en gras, tableau à
 * bordures, en-têtes grisés et répétés à chaque page, montants alignés à droite, totaux en gras.
 */
export const TYPE_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const enc = new TextEncoder();
const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function texte(v: Cellule): string {
  if (v === null || v === undefined) return '';
  const p = pointsPct(v, false);
  if (p !== null) return `${p.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('fr-FR') : v.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
  return String(v);
}

function run(t: string, o: { gras?: boolean; taille?: number; couleur?: string } = {}): string {
  const props = `${o.gras ? '<w:b/>' : ''}${o.couleur ? `<w:color w:val="${o.couleur}"/>` : ''}<w:sz w:val="${o.taille ?? 18}"/>`;
  return `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>${props}</w:rPr><w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;
}
const paragraphe = (contenu: string, apres = 60, align?: 'right' | 'center') =>
  `<w:p><w:pPr><w:spacing w:before="0" w:after="${apres}"/>${align ? `<w:jc w:val="${align}"/>` : ''}</w:pPr>${contenu}</w:p>`;

function cellule(v: Cellule, largeur: number, o: { gras?: boolean; fond?: string; droite?: boolean }): string {
  return `<w:tc><w:tcPr><w:tcW w:w="${largeur}" w:type="dxa"/>${o.fond ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fond}"/>` : ''}</w:tcPr>${paragraphe(
    run(texte(v), { gras: o.gras }),
    0,
    o.droite ? 'right' : undefined,
  )}</w:tc>`;
}

export function documentWord(feuilles: Feuille[], options: { entreprise?: string } = {}): Uint8Array {
  const corps: string[] = [];
  let paysage = false;
  feuilles.forEach((f, n) => {
    const nb = f.entetes.length;
    paysage ||= nb > 6;
    const utile = nb > 6 ? 16838 - 1440 : 11906 - 1440; // largeur de page moins les marges (twips)
    const toutes = [...f.lignes, ...(f.totaux ? [f.totaux] : [])];
    const droite = f.entetes.map((_, i) => toutes.some((l) => typeof l[i] === 'number') && toutes.every((l) => l[i] === null || l[i] === undefined || l[i] === '' || typeof l[i] === 'number'));
    // Largeurs selon le contenu (échantillon), ramenées à la largeur utile.
    const nat = f.entetes.map((e, i) => Math.min(Math.max(e.length, ...toutes.slice(0, 300).map((l) => texte(l[i]).length), 6), 48));
    const somme = nat.reduce((a, b) => a + b, 0);
    const larg = nat.map((x) => Math.floor((x / somme) * utile));

    if (n > 0) corps.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    if (options.entreprise) corps.push(paragraphe(run(options.entreprise, { gras: true, taille: 18, couleur: '6B6B6B' }), 40));
    (f.titre?.length ? f.titre : [f.nom]).forEach((t, k) =>
      corps.push(paragraphe(run(t, k === 0 ? { gras: true, taille: 30 } : { taille: 19, couleur: '444444' }), k === 0 ? 120 : 40)),
    );
    corps.push(paragraphe('', 80));

    const bord = '<w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>';
    const lignes: string[] = [];
    lignes.push(`<w:tr><w:trPr><w:tblHeader/></w:trPr>${f.entetes.map((e, i) => cellule(e, larg[i]!, { gras: true, fond: 'EFEFEF', droite: droite[i] })).join('')}</w:tr>`);
    for (const l of f.lignes) lignes.push(`<w:tr><w:trPr><w:cantSplit/></w:trPr>${f.entetes.map((_, i) => cellule(l[i], larg[i]!, { droite: droite[i] })).join('')}</w:tr>`);
    if (f.totaux) lignes.push(`<w:tr>${f.entetes.map((_, i) => cellule(f.totaux![i], larg[i]!, { gras: true, fond: 'F7F7F7', droite: droite[i] })).join('')}</w:tr>`);
    corps.push(
      `<w:tbl><w:tblPr><w:tblW w:w="${utile}" w:type="dxa"/><w:tblBorders>${bord}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${larg
        .map((w) => `<w:gridCol w:w="${w}"/>`)
        .join('')}</w:tblGrid>${lignes.join('')}</w:tbl>`,
    );
    const date = new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    corps.push(paragraphe(run(`Édité le ${date} · DF Gestion`, { taille: 15, couleur: '8A8A8A' }), 0));
  });

  const [L, H] = paysage ? [16838, 11906] : [11906, 16838];
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${corps.join('')}<w:sectPr><w:pgSz w:w="${L}" w:h="${H}"${paysage ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return zip([
    { nom: '[Content_Types].xml', contenu: enc.encode(types) },
    { nom: '_rels/.rels', contenu: enc.encode(rels) },
    { nom: 'word/document.xml', contenu: enc.encode(document) },
  ]);
}
