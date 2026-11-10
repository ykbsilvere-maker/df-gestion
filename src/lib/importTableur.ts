import { classeurXlsx, type Cellule } from './excel';
import { dateExcel, type FeuilleLue, type Valeur } from './lectureExcel';

/**
 * Import en masse depuis un fichier Excel : définition des colonnes attendues, reconnaissance
 * des en-têtes (avec leurs variantes usuelles), lecture des lignes et modèles à télécharger.
 */

export type TypeImport = 'catalogue' | 'fournisseurs' | 'approvisionnement';
type Genre = 'texte' | 'montant' | 'nombre' | 'date';

export interface Colonne {
  cle: string;
  libelle: string;
  synonymes: string[];
  obligatoire?: boolean;
  genre?: Genre;
  aide: string;
}

export const COLONNES: Record<TypeImport, Colonne[]> = {
  catalogue: [
    { cle: 'code', libelle: 'Code interne', synonymes: ['code', 'reference', 'ref', 'code article', 'code produit', 'sku'], aide: 'Facultatif : laissé vide, il est créé (P00001…).' },
    { cle: 'designation', libelle: 'Désignation', synonymes: ['designation', 'libelle', 'nom', 'article', 'produit', 'nom du produit', 'description'], obligatoire: true, aide: 'Nom de l’article, tel qu’il apparaîtra sur les tickets.' },
    { cle: 'categorie', libelle: 'Catégorie', synonymes: ['categorie', 'famille', 'rayon', 'groupe', 'type'], aide: 'Créée automatiquement si elle n’existe pas.' },
    { cle: 'marque', libelle: 'Marque', synonymes: ['marque', 'fabricant'], aide: 'Facultatif.' },
    { cle: 'unite', libelle: 'Unité', synonymes: ['unite', 'conditionnement', 'u'], aide: 'pièce, sac, carton, kg, litre… (pièce par défaut).' },
    { cle: 'prix_vente', libelle: 'Prix de vente', synonymes: ['prix de vente', 'prix vente', 'pv', 'prix', 'prix unitaire', 'prix ttc', 'prix de vente ttc'], obligatoire: true, genre: 'montant', aide: 'En francs CFA, sans décimales.' },
    { cle: 'prix_achat', libelle: 'Prix d’achat', synonymes: ['prix d achat', 'prix achat', 'pa', 'cout', 'cout d achat', 'prix de revient'], genre: 'montant', aide: 'Facultatif : sert au calcul de la marge.' },
    { cle: 'taux_tva', libelle: 'TVA (%)', synonymes: ['tva', 'taux tva', 'taux de tva', 'tva %'], genre: 'nombre', aide: '0, 9 ou 18. Vide = 0.' },
    { cle: 'code_barres', libelle: 'Code-barres', synonymes: ['code barres', 'code barre', 'codebarre', 'ean', 'ean13', 'gencod', 'gtin'], aide: 'Facultatif : chiffres du code-barres imprimé.' },
    { cle: 'seuil_min', libelle: 'Stock minimum', synonymes: ['stock minimum', 'stock min', 'seuil', 'seuil minimum', 'minimum', 'seuil d alerte'], genre: 'nombre', aide: 'Alerte de réapprovisionnement.' },
    { cle: 'seuil_max', libelle: 'Stock maximum', synonymes: ['stock maximum', 'stock max', 'maximum', 'seuil maximum'], genre: 'nombre', aide: 'Facultatif.' },
    { cle: 'gere_peremption', libelle: 'Suivi péremption', synonymes: ['suivi peremption', 'peremption', 'perissable', 'dlc'], aide: 'oui / non.' },
    { cle: 'stock_initial', libelle: 'Stock initial', synonymes: ['stock initial', 'stock de depart', 'quantite en stock', 'stock', 'quantite', 'qte'], genre: 'nombre', aide: 'Facultatif : une réception « Stock de départ » est préparée en brouillon, à valider.' },
    { cle: 'photo', libelle: 'Photo', synonymes: ['photo', 'image', 'photo nom du fichier', 'fichier photo', 'nom de la photo'], aide: 'Facultatif : collez l’image dans la case (ou écrivez le nom du fichier, ex. riz-5kg.jpg), ou choisissez-la dans DF Gestion avant l’import.' },
    { cle: 'fournisseur', libelle: 'Fournisseur', synonymes: ['fournisseur', 'fournisseur habituel', 'fournisseur principal', 'nom du fournisseur'], aide: 'Facultatif : fournisseur habituel, repris à l’approvisionnement.' },
  ],
  fournisseurs: [
    { cle: 'nom', libelle: 'Nom du fournisseur', synonymes: ['nom', 'fournisseur', 'raison sociale', 'societe', 'nom du fournisseur', 'entreprise'], obligatoire: true, aide: 'Un fournisseur déjà présent est complété, pas dupliqué.' },
    { cle: 'telephone', libelle: 'Téléphone', synonymes: ['telephone', 'tel', 'contact', 'numero', 'portable', 'mobile'], aide: 'Facultatif.' },
    { cle: 'email', libelle: 'E-mail', synonymes: ['email', 'e mail', 'mail', 'courriel', 'adresse e mail'], aide: 'Facultatif.' },
    { cle: 'adresse', libelle: 'Adresse', synonymes: ['adresse', 'localisation', 'ville', 'quartier'], aide: 'Facultatif.' },
    { cle: 'ncc', libelle: 'NCC', synonymes: ['ncc', 'compte contribuable', 'numero contribuable', 'n contribuable'], aide: 'Numéro de compte contribuable, facultatif.' },
    { cle: 'note', libelle: 'Note', synonymes: ['note', 'remarque', 'commentaire', 'observation'], aide: 'Facultatif.' },
  ],
  approvisionnement: [
    { cle: 'fournisseur', libelle: 'Fournisseur', synonymes: ['fournisseur', 'nom du fournisseur', 'raison sociale'], aide: 'Facultatif : une réception est préparée par fournisseur. Vide = celui choisi à l’écran.' },
    { cle: 'code', libelle: 'Code interne', synonymes: ['code', 'code interne', 'reference', 'ref', 'code article'], aide: 'Pour retrouver l’article (ou le code-barres, ou la désignation).' },
    { cle: 'code_barres', libelle: 'Code-barres', synonymes: ['code barres', 'code barre', 'ean', 'ean13', 'gencod', 'gtin'], aide: 'Facultatif.' },
    { cle: 'designation', libelle: 'Désignation', synonymes: ['designation', 'libelle', 'article', 'produit', 'nom'], aide: 'Si l’article n’existe pas encore, il est créé avec ce nom.' },
    { cle: 'quantite', libelle: 'Quantité', synonymes: ['quantite', 'qte', 'qt', 'nombre', 'quantite recue', 'colis'], obligatoire: true, genre: 'nombre', aide: 'Quantité reçue, dans l’unité de l’article.' },
    { cle: 'prix_achat', libelle: 'Prix d’achat unitaire', synonymes: ['prix d achat unitaire', 'prix d achat', 'prix achat', 'pa', 'prix unitaire', 'cout unitaire', 'pu'], genre: 'montant', aide: 'Vide = prix d’achat de la fiche article.' },
    { cle: 'numero_lot', libelle: 'N° de lot', synonymes: ['n de lot', 'numero de lot', 'lot', 'no lot'], aide: 'Facultatif.' },
    { cle: 'date_peremption', libelle: 'Date de péremption', synonymes: ['date de peremption', 'peremption', 'dlc', 'dluo', 'date limite', 'expiration'], genre: 'date', aide: 'JJ/MM/AAAA, facultatif.' },
    { cle: 'prix_vente', libelle: 'Prix de vente', synonymes: ['prix de vente', 'pv'], genre: 'montant', aide: 'Pour un nouvel article seulement.' },
    { cle: 'categorie', libelle: 'Catégorie', synonymes: ['categorie', 'famille', 'rayon'], aide: 'Pour un nouvel article seulement.' },
  ],
};

export const TITRES: Record<TypeImport, string> = {
  catalogue: 'Catalogue (articles)',
  fournisseurs: 'Fournisseurs',
  approvisionnement: 'Approvisionnement',
};

export function normaliserEntete(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)|\*/g, ' ')
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s*%\s*/g, ' %')
    .trim();
}

function correspond(entete: string, c: Colonne): number {
  const e = normaliserEntete(entete);
  if (!e) return 0;
  const candidats = [normaliserEntete(c.libelle), ...c.synonymes.map(normaliserEntete)];
  if (candidats.includes(e)) return 3;
  if (candidats.some((s) => s.length > 3 && (e.startsWith(s + ' ') || e.endsWith(' ' + s)))) return 1;
  return 0;
}

export interface LigneImport {
  /** Numéro de la ligne dans le fichier (comme dans Excel). */
  numero: number;
  valeurs: Record<string, string | number | null>;
  /** Photo collée sur la ligne dans le classeur. */
  image?: { octets: Uint8Array; type: string };
}

export interface Analyse {
  feuille: string;
  ligneEntete: number;
  colonnes: { cle: string; libelle: string; enTete: string; index: number }[];
  manquantes: string[];
  ignorees: string[];
  lignes: LigneImport[];
  /** Nombre de lignes portant une photo collée dans le classeur. */
  images: number;
  /** Lignes laissées de côté (approvisionnement sans quantité). */
  sansQuantite: number;
}

function versDate(v: Valeur): string | null {
  if (v === null || v === '') return null;
  if (typeof v === 'number') return v > 20000 && v < 80000 ? dateExcel(v) : null;
  const s = String(v).trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) {
    const a = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${a}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

/**
 * Repère la feuille et la ligne d'en-têtes, associe chaque colonne du fichier à un champ
 * attendu, puis rend les lignes de données (les lignes vides sont ignorées).
 */
export function analyser(feuilles: FeuilleLue[], type: TypeImport): Analyse {
  const attendues = COLONNES[type];
  let meilleure: { score: number; f: FeuilleLue; ligne: number } | null = null;
  for (const f of feuilles) {
    if (FEUILLE_AIDE.test(normaliserEntete(f.nom))) continue;
    for (let i = 0; i < Math.min(f.lignes.length, 20); i++) {
      const score = (f.lignes[i] ?? []).reduce<number>((s, cell) => s + Math.max(0, ...attendues.map((c) => correspond(String(cell ?? ''), c))), 0);
      if (!meilleure || score > meilleure.score) meilleure = { score, f, ligne: i };
    }
  }
  if (!meilleure || meilleure.score < 3)
    throw new Error('Aucune colonne reconnue. Utilisez le modèle à télécharger ou nommez les colonnes comme dans le modèle (ex. « Désignation », « Prix de vente »).');
  const entetes = meilleure.f.lignes[meilleure.ligne] ?? [];
  const colonnes: Analyse['colonnes'] = [];
  const prises = new Set<number>();
  // D'abord les correspondances exactes, puis les approchées sur les colonnes restantes :
  // « Prix d'achat » ne doit pas être pris pour « Prix de vente ».
  for (const niveau of [3, 1]) {
    for (const c of attendues) {
      if (colonnes.some((x) => x.cle === c.cle)) continue;
      const idx = entetes.findIndex((e, i) => !prises.has(i) && correspond(String(e ?? ''), c) === niveau);
      if (idx >= 0) {
        prises.add(idx);
        colonnes.push({ cle: c.cle, libelle: c.libelle, enTete: String(entetes[idx] ?? ''), index: idx });
      }
    }
  }
  colonnes.sort((x, y) => x.index - y.index);
  const manquantes = attendues.filter((c) => c.obligatoire && !colonnes.some((x) => x.cle === c.cle)).map((c) => c.libelle);
  const ignorees = entetes.map((e, i) => (prises.has(i) || e === null ? null : String(e))).filter((e): e is string => !!e);
  const genres = new Map(attendues.map((c) => [c.cle, c.genre ?? 'texte']));
  const lignes: LigneImport[] = [];
  const colPhoto = colonnes.find((c) => c.cle === 'photo')?.index;
  const parLigne = new Map<number, NonNullable<FeuilleLue['images']>>();
  for (const im of meilleure.f.images ?? []) parLigne.set(im.ligne, [...(parLigne.get(im.ligne) ?? []), im]);
  meilleure.f.lignes.slice(meilleure.ligne + 1).forEach((l, k) => {
    const ims = parLigne.get(meilleure!.ligne + 1 + k);
    const im = ims && (ims.find((x) => x.colonne === colPhoto) ?? ims[0]);
    if ((!l || l.every((v) => v === null || v === '')) && !im) return;
    l = l ?? [];
    const valeurs: LigneImport['valeurs'] = {};
    for (const c of colonnes) {
      const v = l[c.index] ?? null;
      const g = genres.get(c.cle);
      valeurs[c.cle] = g === 'date' ? versDate(v) : typeof v === 'number' && g === 'texte' ? String(v) : v;
    }
    if (Object.values(valeurs).every((v) => v === null || v === '')) return;
    lignes.push({ numero: meilleure!.ligne + 2 + k, valeurs, ...(im ? { image: { octets: im.octets, type: im.type } } : {}) });
  });
  let sansQuantite = 0;
  let gardees = lignes;
  // Bon d'approvisionnement : on peut lister tous les articles et ne remplir que ceux reçus.
  if (type === 'approvisionnement' && !manquantes.length) {
    gardees = lignes.filter((l) => Number(String(l.valeurs.quantite ?? '').replace(/\s/g, '').replace(',', '.')) > 0);
    sansQuantite = lignes.length - gardees.length;
  }
  return {
    feuille: meilleure.f.nom,
    ligneEntete: meilleure.ligne + 1,
    colonnes,
    manquantes,
    ignorees,
    lignes: gardees,
    images: gardees.filter((l) => l.image).length,
    sansQuantite,
  };
}

const FEUILLE_AIDE = /^(aide|a savoir|mode d ?emploi|notice|instructions|lisez moi|lisezmoi)/;
const NOMS_FEUILLES: Record<TypeImport, RegExp> = {
  fournisseurs: /fournisseur/,
  catalogue: /catalogue|article|produit/,
  approvisionnement: /approvision|reception|livraison|arrivage|entree|achat/,
};
export const ORDRE_CLASSEUR: TypeImport[] = ['fournisseurs', 'catalogue', 'approvisionnement'];

/**
 * Classeur complet : chaque onglet est rattaché à un type d'import, d'abord par son nom
 * (« Fournisseurs », « Catalogue », « Approvisionnement »…), sinon par ses colonnes.
 */
export function analyserClasseur(feuilles: FeuilleLue[]): Partial<Record<TypeImport, Analyse>> {
  const res: Partial<Record<TypeImport, Analyse>> = {};
  const utiles = feuilles.filter((f) => !FEUILLE_AIDE.test(normaliserEntete(f.nom)));
  const prises = new Set<string>();
  const essai = (fs: FeuilleLue[], t: TypeImport) => {
    try {
      return analyser(fs, t);
    } catch {
      return null;
    }
  };
  // 1. Par le nom de l'onglet (approvisionnement avant catalogue : « Articles reçus »…).
  for (const t of ['fournisseurs', 'approvisionnement', 'catalogue'] as TypeImport[]) {
    const candidates = utiles.filter((f) => !prises.has(f.nom) && NOMS_FEUILLES[t].test(normaliserEntete(f.nom)));
    const a = candidates.length ? essai(candidates, t) : null;
    if (a) {
      res[t] = a;
      prises.add(a.feuille);
    }
  }
  // 2. Onglets restants : le type dont toutes les colonnes obligatoires sont présentes et qui en reconnaît le plus.
  for (const f of utiles) {
    if (prises.has(f.nom)) continue;
    let choix: Analyse | null = null;
    let type: TypeImport | null = null;
    for (const t of ['catalogue', 'approvisionnement', 'fournisseurs'] as TypeImport[]) {
      if (res[t]) continue;
      const a = essai([f], t);
      if (a && !a.manquantes.length && (!choix || a.colonnes.length > choix.colonnes.length)) {
        choix = a;
        type = t;
      }
    }
    if (choix && type) {
      res[type] = choix;
      prises.add(f.nom);
    }
  }
  return res;
}

const EXEMPLES: Record<TypeImport, Cellule[][]> = {
  catalogue: [
    ['', 'Riz parfumé 5 kg', 'Épicerie', 'Uncle Sam', 'sac', 4500, 3800, 0, '6151100000017', 10, 60, 'non', 25, 'riz-5kg.jpg', 'SOCOCE Distribution'],
    ['', 'Huile Dinor 1 L', 'Épicerie', 'Dinor', 'bouteille', 1600, 1300, 0, '', 24, '', 'non', 48, '', 'SOCOCE Distribution'],
    ['LAIT-400', 'Lait en poudre 400 g', 'Produits laitiers', '', 'boîte', 2650, 2200, 0, '', 12, '', 'oui', 30, '', 'Grossiste du Plateau'],
  ],
  fournisseurs: [
    ['SOCOCE Distribution', '27 22 00 00 00', 'commandes@exemple.ci', 'Abidjan, Zone 4', '', 'Livraison le mardi'],
    ['Grossiste du Plateau', '07 00 00 00 00', '', 'Adjamé, marché', '', ''],
  ],
  approvisionnement: [
    ['SOCOCE Distribution', '', '6151100000017', 'Riz parfumé 5 kg', 20, 3750, '', '', '', ''],
    ['SOCOCE Distribution', '', '', 'Huile Dinor 1 L', 24, 1300, 'L2611', '30/06/2027', '', ''],
    ['Grossiste du Plateau', '', '', 'Sucre en morceaux 1 kg', 30, 900, '', '', 1100, 'Épicerie'],
  ],
};

/** Modèle Excel prêt à remplir : une feuille de données avec exemples, une feuille d'aide. */
export function modeleImport(type: TypeImport): Uint8Array {
  const cols = COLONNES[type];
  return classeurXlsx([
    {
      nom: 'Données',
      entetes: cols.map((c) => (c.obligatoire ? `${c.libelle} *` : c.libelle)),
      lignes: EXEMPLES[type],
      largeurs: cols.map((c) => Math.max(12, Math.min(34, c.libelle.length + 6))),
    },
    {
      nom: 'Mode d’emploi',
      titre: [
        `DF Gestion — import « ${TITRES[type]} »`,
        'Remplacez les lignes d’exemple par vos données (une ligne par élément), sans changer les titres de colonnes.',
        'Les colonnes marquées * sont obligatoires ; les autres peuvent rester vides. Enregistrez au format .xlsx.',
      ],
      entetes: ['Colonne', 'Obligatoire', 'À savoir'],
      lignes: cols.map((c) => [c.libelle, c.obligatoire ? 'oui' : '', c.aide]),
      largeurs: [26, 12, 80],
    },
  ]);
}

/** Classeur complet à remplir : un onglet par type, plus le mode d'emploi. */
export function modeleClasseur(): Uint8Array {
  const feuille = (type: TypeImport, nom: string) => {
    const cols = COLONNES[type];
    return {
      nom,
      entetes: cols.map((c) => (c.obligatoire ? `${c.libelle} *` : c.libelle)),
      lignes: EXEMPLES[type],
      largeurs: cols.map((c) => Math.max(12, Math.min(34, c.libelle.length + 6))),
    };
  };
  const aide = (type: TypeImport, onglet: string) => COLONNES[type].map((c) => [onglet, c.libelle, c.obligatoire ? 'oui' : '', c.aide] as Cellule[]);
  return classeurXlsx([
    feuille('fournisseurs', 'Fournisseurs'),
    feuille('catalogue', 'Catalogue'),
    feuille('approvisionnement', 'Approvisionnement'),
    {
      nom: 'Mode d’emploi',
      titre: [
        'DF Gestion — classeur complet : fournisseurs, catalogue, approvisionnement',
        'Remplissez les trois onglets (ou seulement ceux qui vous servent) en remplaçant les exemples, sans changer les titres de colonnes.',
        'Photos : dans l’onglet Catalogue, collez l’image sur la ligne de l’article (Insertion > Image > Placer dans la cellule, ou image posée sur la colonne Photo).',
        'Approvisionnement : seules les lignes avec une quantité sont importées ; le nom du fournisseur doit être celui de l’onglet Fournisseurs.',
        'Dans DF Gestion : Catalogue > 📥 > onglet « Classeur complet » > Choisir le fichier > Tout importer.',
      ],
      entetes: ['Onglet', 'Colonne', 'Obligatoire', 'À savoir'],
      lignes: [...aide('fournisseurs', 'Fournisseurs'), ...aide('catalogue', 'Catalogue'), ...aide('approvisionnement', 'Approvisionnement')],
      largeurs: [18, 26, 12, 80],
    },
  ]);
}

/** Découpe en paquets pour les envois au serveur. */
export function paquets<T>(liste: T[], taille: number): T[][] {
  const r: T[][] = [];
  for (let i = 0; i < liste.length; i += taille) r.push(liste.slice(i, i + taille));
  return r;
}

/** Nom de fichier ramené à une clé de comparaison (sans extension, accents, casse, séparateurs). */
export function cleFichier(nom: string): string {
  return normaliserEntete(nom.replace(/\.[a-z0-9]{2,5}$/i, '')).replace(/\s+/g, '');
}
