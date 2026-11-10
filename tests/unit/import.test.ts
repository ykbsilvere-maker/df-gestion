import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { lireCsv, lireXlsx, lireZip, dateExcel } from '../../src/lib/lectureExcel';
import { analyser, analyserClasseur, cleFichier, modeleClasseur, modeleImport } from '../../src/lib/importTableur';

/** Archive ZIP compressée (méthode 8), comme celles produites par Excel. */
function zipDeflate(fichiers: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const morceaux: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let pos = 0;
  for (const [nom, contenu] of Object.entries(fichiers)) {
    const n = enc.encode(nom);
    const brut = enc.encode(contenu);
    const comp = deflateRawSync(brut);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(8, 8, true);
    h.setUint32(18, comp.length, true);
    h.setUint32(22, brut.length, true);
    h.setUint16(26, n.length, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(10, 8, true);
    c.setUint32(20, comp.length, true);
    c.setUint32(24, brut.length, true);
    c.setUint16(28, n.length, true);
    c.setUint32(42, pos, true);
    morceaux.push(new Uint8Array(h.buffer), n, comp);
    central.push(new Uint8Array(c.buffer), n);
    pos += 30 + n.length + comp.length;
  }
  const tailleCentral = central.reduce((s, x) => s + x.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true);
  fin.setUint16(8, Object.keys(fichiers).length, true);
  fin.setUint16(10, Object.keys(fichiers).length, true);
  fin.setUint32(12, tailleCentral, true);
  fin.setUint32(16, pos, true);
  const tout = [...morceaux, ...central, new Uint8Array(fin.buffer)];
  const r = new Uint8Array(tout.reduce((s, x) => s + x.length, 0));
  let k = 0;
  for (const x of tout) {
    r.set(x, k);
    k += x.length;
  }
  return r;
}

describe('Lecture de fichiers Excel', () => {
  it('relit le modèle du catalogue et reconnaît toutes ses colonnes', async () => {
    const feuilles = await lireXlsx(modeleImport('catalogue'));
    expect(feuilles.map((f) => f.nom)).toEqual(['Données', 'Mode d’emploi']);
    const a = analyser(feuilles, 'catalogue');
    expect(a.manquantes).toEqual([]);
    expect(a.colonnes).toHaveLength(14);
    expect(a.lignes).toHaveLength(3);
    expect(a.lignes[0]!.valeurs).toMatchObject({ designation: 'Riz parfumé 5 kg', prix_vente: 4500, code_barres: '6151100000017', stock_initial: 25, photo: 'riz-5kg.jpg' });
    expect(a.lignes[0]!.numero).toBe(2);
  });

  it('lit un classeur compressé comme ceux d’Excel (textes partagés, dates, colonnes sautées)', async () => {
    const x = zipDeflate({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Achats" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Désignation</t></si><si><t>Qté</t></si><si><t>DLC</t></si><si><r><t>Lait </t></r><r><t>&amp; Co</t></r></si></sst>',
      'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>' +
        '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3"><v>12</v></c><c r="D3" s="1"><v>46568</v></c></row></sheetData></worksheet>',
    });
    expect((await lireZip(x)).size).toBe(5);
    const a = analyser(await lireXlsx(x), 'approvisionnement');
    expect(a.lignes).toEqual([{ numero: 3, valeurs: { designation: 'Lait & Co', quantite: 12, date_peremption: '2027-06-30' } }]);
  });

  it('lit un CSV « à la française » (point-virgule, guillemets)', () => {
    const a = analyser(lireCsv('Nom du fournisseur;Téléphone\n"Grossiste ""Le Bon Prix""";07 00 00 00 00\n;\n'), 'fournisseurs');
    expect(a.lignes).toEqual([{ numero: 2, valeurs: { nom: 'Grossiste "Le Bon Prix"', telephone: '07 00 00 00 00' } }]);
  });

  it('ne confond pas « Prix d’achat » avec le prix de vente', () => {
    const a = analyser([{ nom: 'F', lignes: [['Article', 'Prix d’achat', 'PV'], ['Savon', 700, 900]] }], 'catalogue');
    expect(a.lignes[0]!.valeurs).toMatchObject({ designation: 'Savon', prix_achat: 700, prix_vente: 900 });
  });

  it('signale les colonnes obligatoires absentes', () => {
    const a = analyser([{ nom: 'F', lignes: [['Désignation', 'Marque'], ['Savon', 'Omo']] }], 'catalogue');
    expect(a.manquantes).toEqual(['Prix de vente']);
  });

  it('convertit les dates Excel et rapproche les noms de photos', () => {
    expect(dateExcel(45658)).toBe('2025-01-01');
    expect(cleFichier('Riz-5kg.JPG')).toBe(cleFichier('riz 5kg.jpeg'));
  });

  it('relit le classeur complet : un onglet par type, dans le bon ordre', async () => {
    const p = analyserClasseur(await lireXlsx(modeleClasseur()));
    expect(p.fournisseurs?.feuille).toBe('Fournisseurs');
    expect(p.catalogue?.feuille).toBe('Catalogue');
    expect(p.approvisionnement?.feuille).toBe('Approvisionnement');
    expect(p.catalogue?.lignes).toHaveLength(3);
    expect(p.approvisionnement?.lignes[0]!.valeurs).toMatchObject({ fournisseur: 'SOCOCE Distribution', quantite: 20 });
  });

  it('rattache des onglets sans nom parlant par leurs colonnes, et laisse de côté les lignes sans quantité', () => {
    const p = analyserClasseur([
      { nom: 'Feuil1', lignes: [['Désignation', 'Prix de vente'], ['Savon', 350]] },
      { nom: 'Feuil2', lignes: [['Désignation', 'Quantité'], ['Savon', 12], ['Riz', null], ['Huile', 0]] },
      { nom: 'À savoir', lignes: [['Nom du fournisseur'], ['Pas une donnée']] },
    ]);
    expect(p.catalogue?.feuille).toBe('Feuil1');
    expect(p.approvisionnement?.feuille).toBe('Feuil2');
    expect(p.approvisionnement?.lignes.map((l) => l.valeurs.designation)).toEqual(['Savon']);
    expect(p.approvisionnement?.sansQuantite).toBe(2);
    expect(p.fournisseurs).toBeUndefined();
  });

  const base = (cellulePhoto: string, extra: Record<string, string>) => ({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Catalogue" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Désignation</t></is></c><c r="B1" t="inlineStr"><is><t>Prix de vente</t></is></c><c r="C1" t="inlineStr"><is><t>Photo</t></is></c></row>' +
      `<row r="2"><c r="A2" t="inlineStr"><is><t>Riz 5 kg</t></is></c><c r="B2"><v>4800</v></c>${cellulePhoto}</row>` +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Huile 1 L</t></is></c><c r="B3"><v>1500</v></c></row></sheetData>' +
      (extra['dessin'] ?? '') +
      '</worksheet>',
    'xl/media/image1.png': 'PNG-RIZ',
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'dessin')),
  });
  const photoDe = (a: ReturnType<typeof analyser>) => a.lignes.map((l) => (l.image ? new TextDecoder().decode(l.image.octets) + ' ' + l.image.type : null));

  it('récupère une photo posée sur la ligne (image flottante)', async () => {
    const x = zipDeflate(
      base('', {
        dessin: '<drawing r:id="rId1"/>',
        'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships><Relationship Id="rId1" Type="drawing" Target="../drawings/drawing1.xml"/></Relationships>',
        'xl/drawings/drawing1.xml':
          '<xdr:wsDr><xdr:oneCellAnchor><xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
          '<xdr:pic><xdr:blipFill><a:blip xmlns:r="r" r:embed="rId1"/></xdr:blipFill></xdr:pic></xdr:oneCellAnchor></xdr:wsDr>',
        'xl/drawings/_rels/drawing1.xml.rels': '<Relationships><Relationship Id="rId1" Type="image" Target="../media/image1.png"/></Relationships>',
      }),
    );
    const a = analyser(await lireXlsx(x), 'catalogue');
    expect(photoDe(a)).toEqual(['PNG-RIZ image/png', null]);
    expect(a.images).toBe(1);
  });

  it('récupère une photo « placée dans la cellule » (Excel 365)', async () => {
    const x = zipDeflate(
      base('<c r="C2" t="e" vm="1"><v>#VALUE!</v></c>', {
        'xl/metadata.xml':
          '<metadata><futureMetadata name="XLRICHVALUE" count="1"><bk><extLst><ext><xlrd:rvb i="0"/></ext></extLst></bk></futureMetadata>' +
          '<valueMetadata count="1"><bk><rc t="1" v="0"/></bk></valueMetadata></metadata>',
        'xl/richData/rdrichvaluestructure.xml': '<rvStructures><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s></rvStructures>',
        'xl/richData/rdrichvalue.xml': '<rvData count="1"><rv s="0"><v>0</v><v>5</v></rv></rvData>',
        'xl/richData/richValueRel.xml': '<richValueRels><rel r:id="rId1"/></richValueRels>',
        'xl/richData/_rels/richValueRel.xml.rels': '<Relationships><Relationship Id="rId1" Type="image" Target="../media/image1.png"/></Relationships>',
      }),
    );
    const a = analyser(await lireXlsx(x), 'catalogue');
    expect(photoDe(a)).toEqual(['PNG-RIZ image/png', null]);
    expect(a.lignes[0]!.valeurs.photo).toBeNull();
  });

  it('récupère une photo de WPS Office (DISPIMG)', async () => {
    const x = zipDeflate(
      base('<c r="C2" t="str"><f>_xlfn.DISPIMG("ID_RIZ",1)</f><v>=DISPIMG("ID_RIZ",1)</v></c>', {
        'xl/cellimages.xml':
          '<etc:cellImages><etc:cellImage><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="ID_RIZ"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic></etc:cellImage></etc:cellImages>',
        'xl/_rels/cellimages.xml.rels': '<Relationships><Relationship Id="rId1" Type="image" Target="media/image1.png"/></Relationships>',
      }),
    );
    const a = analyser(await lireXlsx(x), 'catalogue');
    expect(photoDe(a)).toEqual(['PNG-RIZ image/png', null]);
  });
});
