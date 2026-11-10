import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { telechargerFichier, TYPE_XLSX } from '../../lib/excel';
import { lireFichierTableur } from '../../lib/lectureExcel';
import {
  analyser,
  analyserClasseur,
  cleFichier,
  modeleClasseur,
  modeleImport,
  ORDRE_CLASSEUR,
  paquets,
  TITRES,
  type Analyse,
  type TypeImport,
} from '../../lib/importTableur';
import { useMagasinCourant, useMagasins } from '../../lib/stock';
import { useFournisseurs } from './Fournisseurs';
import { reduire } from '../../components/PhotoProduit';
import { RevueLignes } from './RevueImport';
import { Alerte, Champ, EnTetePage, Pastille } from '../../components/ui';

type Onglet = 'classeur' | TypeImport | 'photos';

interface LigneResultat {
  ligne: number;
  statut: string;
  message?: string;
  produit_id?: string;
  code?: string;
  reception_id?: string;
}
interface Bilan {
  crees: number;
  mis_a_jour: number;
  ignores: number;
  erreurs: number;
  lignes: (LigneResultat & { numero: number })[];
  receptions: { id: string; fournisseur: string | null; lignes: number }[];
  articlesCrees: number;
  photos: number;
  photosEchouees: number[];
  /** Erreur qui a interrompu l'import (les lignes déjà traitées restent). */
  erreur?: string;
}
interface Options {
  miseAJour: boolean;
  creerArticles: boolean;
  stockDepart: boolean;
  magasin: string;
  fournisseur?: string;
  dateRec?: string;
  reference?: string;
}
type Progres = (fait: number, total: number, etape: string) => void;

const ACCEPT_TABLEUR = '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/comma-separated-values';
const ICONES: Record<TypeImport, string> = { fournisseurs: '🚚', catalogue: '🛍️', approvisionnement: '📥' };
const PERMISSIONS: Record<TypeImport, string[]> = {
  fournisseurs: ['fournisseurs.creer', 'achats.creer'],
  catalogue: ['catalogue.creer', 'catalogue.modifier'],
  approvisionnement: ['stock.creer', 'achats.creer'],
};

/** Réduit la photo, l'envoie dans le stockage puis la rattache à l'article. */
async function envoyerPhoto(org: string, produitId: string, image: Blob) {
  const reduite = await reduire(image);
  const chemin = `${org}/${produitId}-${Date.now()}.jpg`;
  const { error } = await supabase.storage.from('produits').upload(chemin, reduite, { contentType: 'image/jpeg', upsert: true });
  if (error) throw error;
  const { error: e2 } = await supabase.from('produits').update({ photo_path: chemin }).eq('id', produitId);
  if (e2) throw e2;
}

/**
 * Envoie une analyse au serveur par paquets. Pour le catalogue : photos collées dans le
 * classeur, puis réception « Stock de départ » des nouveaux articles.
 */
async function executerImport(org: string, type: TypeImport, analyse: Analyse, o: Options, progres: Progres): Promise<Bilan> {
  const b: Bilan = { crees: 0, mis_a_jour: 0, ignores: 0, erreurs: 0, lignes: [], receptions: [], articlesCrees: 0, photos: 0, photosEchouees: [] };
  const total = analyse.lignes.length;
  progres(0, total, TITRES[type]);
  try {
    let fait = 0;
    for (const lot of paquets(analyse.lignes, type === 'approvisionnement' ? 1000 : 400)) {
      const lignes = lot.map((l) => l.valeurs);
      const { data, error } =
        type === 'catalogue'
          ? await supabase.rpc('importer_catalogue', { p_org: org, p_lignes: lignes, p_mettre_a_jour: o.miseAJour })
          : type === 'fournisseurs'
            ? await supabase.rpc('importer_fournisseurs', { p_org: org, p_lignes: lignes })
            : await supabase.rpc('importer_reception', {
                p_org: org,
                p_entete: { magasin_id: o.magasin, fournisseur: o.fournisseur || null, date_reception: o.dateRec || null, reference: o.reference || null },
                p_lignes: lignes,
                p_creer_articles: o.creerArticles,
              });
      if (error) throw error;
      const r = data as {
        crees?: number;
        mis_a_jour?: number;
        ignores?: number;
        erreurs: number;
        lignes: LigneResultat[];
        lignes_ajoutees?: number;
        articles_crees?: number;
        receptions?: Bilan['receptions'];
      };
      b.crees += r.crees ?? r.lignes_ajoutees ?? 0;
      b.mis_a_jour += r.mis_a_jour ?? 0;
      b.ignores += r.ignores ?? 0;
      b.erreurs += r.erreurs;
      b.articlesCrees += r.articles_crees ?? 0;
      b.receptions.push(...(r.receptions ?? []));
      b.lignes.push(...r.lignes.map((x) => ({ ...x, numero: lot[x.ligne - 1]!.numero })));
      fait += lot.length;
      progres(fait, total, TITRES[type]);
    }
    if (type !== 'catalogue') return b;
    const avecResultat = analyse.lignes.map((l, i) => ({ l, r: b.lignes[i] }));
    // Photos collées dans le classeur, sur la ligne de l'article.
    const photos = avecResultat.filter(({ l, r }) => l.image && r?.produit_id);
    for (const [k, { l, r }] of photos.entries()) {
      progres(k, photos.length, 'Photos');
      try {
        await envoyerPhoto(org, r!.produit_id!, new Blob([l.image!.octets.slice().buffer as ArrayBuffer], { type: l.image!.type }));
        b.photos++;
      } catch {
        b.photosEchouees.push(l.numero);
      }
    }
    // Stock de départ : une réception en brouillon pour les nouveaux articles, à vérifier puis valider.
    if (o.stockDepart && o.magasin) {
      const depart = avecResultat
        .filter(({ l, r }) => Number(l.valeurs.stock_initial) > 0 && r?.statut === 'cree' && r.code)
        .map(({ l, r }) => ({ code: r!.code, quantite: l.valeurs.stock_initial, prix_achat: l.valeurs.prix_achat }));
      if (depart.length) {
        progres(0, depart.length, 'Stock de départ');
        const { data, error } = await supabase.rpc('importer_reception', {
          p_org: org,
          p_entete: { magasin_id: o.magasin, note: 'Stock de départ (import du catalogue)', fournisseur_habituel: false },
          p_lignes: depart,
          p_creer_articles: false,
        });
        if (error) throw error;
        b.receptions.push(...((data as { receptions: Bilan['receptions'] }).receptions ?? []).map((x) => ({ ...x, fournisseur: x.fournisseur ?? 'Stock de départ' })));
      }
    }
  } catch (e) {
    b.erreur = messageErreur(e);
  }
  return b;
}

/**
 * Import en masse depuis Excel : un classeur complet (fournisseurs, catalogue avec photos,
 * approvisionnement) ou un seul type à la fois. Deuxième façon de remplir l'application,
 * à côté de la saisie une par une.
 */
export function ImportExcel() {
  const { organisation, peut } = useSession();
  const [params, setParams] = useSearchParams();
  const org = organisation!.organisation_id;
  const permis = (t: TypeImport) => PERMISSIONS[t].some((p) => peut(p));
  const onglets: [Onglet, string, boolean][] = [
    ['classeur', '📗 Classeur complet', ORDRE_CLASSEUR.some(permis)],
    ['catalogue', '🛍️ Catalogue', permis('catalogue')],
    ['fournisseurs', '🚚 Fournisseurs', permis('fournisseurs')],
    ['approvisionnement', '📥 Approvisionnement', permis('approvisionnement')],
    ['photos', '🖼️ Photos', peut('catalogue.modifier')],
  ];
  const visibles = onglets.filter((o) => o[2]);
  const demande = params.get('type') as Onglet | null;
  const onglet = visibles.find((o) => o[0] === demande)?.[0] ?? visibles[0]?.[0] ?? 'classeur';

  return (
    <>
      <EnTetePage
        icone="📥"
        titre="Importer depuis Excel"
        sousTitre="Remplissez un classeur Excel (fournisseurs, articles avec leurs photos, livraisons) et ajoutez tout d’un coup, sur l’application comme sur le site. La saisie une par une reste possible."
      />
      <nav className="onglets onglets-compacts onglets-import" role="tablist">
        {visibles.map(([o, libelle]) => (
          <button key={o} type="button" role="tab" aria-selected={onglet === o} className={onglet === o ? 'actif' : ''} onClick={() => setParams({ type: o }, { replace: true })}>
            {libelle}
          </button>
        ))}
      </nav>
      {onglet === 'photos' ? (
        <PhotosEnLot org={org} />
      ) : onglet === 'classeur' ? (
        <ClasseurComplet org={org} permis={permis} />
      ) : (
        <EtapeImport key={onglet} org={org} type={onglet} />
      )}
    </>
  );
}

function ChoixFichier({ fichier, onChoix, modele, libelleModele, texteModele }: { fichier: File | null; onChoix: (f: File) => void; modele: () => void; libelleModele: string; texteModele: ReactNode }) {
  const entree = useRef<HTMLInputElement>(null);
  return (
    <ol className="import-pas">
      <li>
        {texteModele}
        <div className="actions-demande">
          <button type="button" className="bouton bouton-discret" onClick={modele}>
            ⬇️ {libelleModele}
          </button>
        </div>
      </li>
      <li>
        <strong>Choisissez votre fichier</strong> (.xlsx ou .csv).
        <div className="actions-demande">
          <input
            ref={entree}
            type="file"
            accept={ACCEPT_TABLEUR}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) onChoix(f);
            }}
          />
          <button type="button" className="bouton bouton-principal" onClick={() => entree.current?.click()}>
            📂 {fichier ? 'Choisir un autre fichier' : 'Choisir le fichier'}
          </button>
          {fichier && <span className="secondaire">{fichier.name}</span>}
        </div>
      </li>
    </ol>
  );
}

function useOptionsImport(org: string) {
  const magasins = useMagasins(org);
  const [magasin, setMagasin] = useMagasinCourant(org, magasins);
  const [miseAJour, setMiseAJour] = useState(true);
  const [creerArticles, setCreerArticles] = useState(true);
  const [stockDepart, setStockDepart] = useState(true);
  return { magasins, magasin, setMagasin, miseAJour, setMiseAJour, creerArticles, setCreerArticles, stockDepart, setStockDepart };
}

function ChoixMagasin({ o }: { o: ReturnType<typeof useOptionsImport> }) {
  if (o.magasins.length < 2) return null;
  return (
    <Champ label="Magasin qui reçoit la marchandise">
      <select value={o.magasin} onChange={(e) => o.setMagasin(e.target.value)}>
        {o.magasins.map((m) => (
          <option key={m.id} value={m.id}>
            {m.nom}
          </option>
        ))}
      </select>
    </Champ>
  );
}

/** Tout le classeur d'un coup : fournisseurs, puis catalogue (et photos), puis approvisionnement. */
function ClasseurComplet({ org, permis }: { org: string; permis: (t: TypeImport) => boolean }) {
  const [fichier, setFichier] = useState<File | null>(null);
  const [parties, setParties] = useState<Partial<Record<TypeImport, Analyse>> | null>(null);
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState<{ fait: number; total: number; etape: string } | null>(null);
  const [bilans, setBilans] = useState<Partial<Record<TypeImport, Bilan>> | null>(null);
  const o = useOptionsImport(org);
  const { fournisseurs } = useFournisseurs(org);
  const nomsFournisseurs = useMemo(
    () => [...(parties?.fournisseurs?.lignes.map((l) => String(l.valeurs.nom ?? '')) ?? []), ...fournisseurs.map((f) => f.nom)],
    [parties?.fournisseurs, fournisseurs],
  );

  async function choisir(f: File) {
    setFichier(f);
    setParties(null);
    setBilans(null);
    setErreur('');
    try {
      const p = analyserClasseur(await lireFichierTableur(f));
      if (!Object.keys(p).length)
        throw new Error('Aucun onglet reconnu. Nommez vos onglets « Fournisseurs », « Catalogue » et « Approvisionnement » (ou partez du classeur modèle).');
      setParties(p);
    } catch (e) {
      setErreur(messageErreur(e));
    }
  }

  const aImporter = parties ? ORDRE_CLASSEUR.filter((t) => parties[t] && permis(t) && !parties[t]!.manquantes.length && parties[t]!.lignes.length) : [];
  const aStock = !!parties?.catalogue?.lignes.some((l) => Number(l.valeurs.stock_initial) > 0);

  async function toutImporter() {
    if (!parties || envoi) return;
    setErreur('');
    const res: Partial<Record<TypeImport, Bilan>> = {};
    for (const t of aImporter) {
      const b = await executerImport(org, t, parties[t]!, { ...o, stockDepart: o.stockDepart && aStock }, (fait, total, etape) => setEnvoi({ fait, total, etape }));
      res[t] = b;
      setBilans({ ...res });
      if (b.erreur) break;
    }
    setEnvoi(null);
  }

  return (
    <section className="carte import-etape">
      <ChoixFichier
        fichier={fichier}
        onChoix={(f) => void choisir(f)}
        modele={() => telechargerFichier('Classeur-DF-Gestion.xlsx', TYPE_XLSX, modeleClasseur())}
        libelleModele="Classeur modèle (3 onglets)"
        texteModele={
          <>
            <strong>Un seul fichier, trois onglets</strong> : <em>Fournisseurs</em>, <em>Catalogue</em> (prix d’achat, prix de vente, stock initial et
            photo de chaque article) et <em>Approvisionnement</em> (marchandises reçues). Pour la photo, collez l’image sur la ligne de l’article dans
            Excel (Insertion › Image › Placer dans la cellule) ou dans WPS.
          </>
        }
      />
      <Alerte>{erreur}</Alerte>

      {parties && (
        <>
          <div className="classeur-parties">
            {ORDRE_CLASSEUR.map((t) => {
              const a = parties[t];
              return (
                <div key={t} className={`classeur-partie${a ? '' : ' absente'}`}>
                  <span className="classeur-icone" aria-hidden>
                    {ICONES[t]}
                  </span>
                  <div>
                    <strong>{TITRES[t]}</strong>
                    {!a ? (
                      <p className="secondaire">Onglet absent : rien à importer.</p>
                    ) : (
                      <p>
                        Onglet « {a.feuille} » : <strong>{a.lignes.length}</strong> ligne{a.lignes.length > 1 ? 's' : ''}
                        {a.images > 0 && <> · 🖼️ {a.images} photo{a.images > 1 ? 's' : ''}</>}
                        {a.sansQuantite > 0 && <span className="secondaire"> · {a.sansQuantite} sans quantité, laissée{a.sansQuantite > 1 ? 's' : ''} de côté</span>}
                      </p>
                    )}
                    {a && a.manquantes.length > 0 && <p className="texte-alerte">Colonne obligatoire absente : {a.manquantes.join(', ')}.</p>}
                    {a && !permis(t) && <p className="texte-alerte">Votre rôle ne permet pas cet import.</p>}
                  </div>
                </div>
              );
            })}
          </div>

          {parties.catalogue && permis('catalogue') && !bilans && (
            <details className="revue-bloc" open>
              <summary>🛍️ Vérifier les articles : photo (📷 = choisir sur l’appareil) et fournisseur</summary>
              <RevueLignes analyse={parties.catalogue} type="catalogue" fournisseurs={nomsFournisseurs} onChange={(a) => setParties({ ...parties, catalogue: a })} />
            </details>
          )}
          {parties.approvisionnement && permis('approvisionnement') && !bilans && parties.approvisionnement.lignes.length > 0 && (
            <details className="revue-bloc">
              <summary>📥 Vérifier la livraison : quantités et fournisseur ({parties.approvisionnement.lignes.length} lignes)</summary>
              <RevueLignes
                analyse={parties.approvisionnement}
                type="approvisionnement"
                fournisseurs={nomsFournisseurs}
                onChange={(a) => setParties({ ...parties, approvisionnement: a })}
              />
            </details>
          )}

          <div className="import-options">
            {parties.catalogue && (
              <label className="case">
                <input type="checkbox" checked={o.miseAJour} onChange={(e) => o.setMiseAJour(e.target.checked)} />
                Mettre à jour les articles déjà présents (prix, catégorie, photo…)
              </label>
            )}
            {aStock && (
              <label className="case">
                <input type="checkbox" checked={o.stockDepart} onChange={(e) => o.setStockDepart(e.target.checked)} />
                Préparer une réception « Stock de départ » avec la colonne Stock initial des nouveaux articles
              </label>
            )}
            {parties.approvisionnement && (
              <label className="case">
                <input type="checkbox" checked={o.creerArticles} onChange={(e) => o.setCreerArticles(e.target.checked)} />
                Approvisionnement : créer les articles absents du catalogue
              </label>
            )}
            {(aStock || parties.approvisionnement) && <ChoixMagasin o={o} />}
            {(aStock || parties.approvisionnement) && (
              <p className="secondaire petit-texte">Les entrées de stock sont préparées en réceptions brouillon : vérifiez-les puis validez-les (journée ouverte).</p>
            )}
          </div>

          <button
            type="button"
            className="bouton bouton-principal bouton-plein"
            disabled={!!envoi || !!bilans || !aImporter.length || ((aStock || !!parties.approvisionnement) && !o.magasin)}
            onClick={() => void toutImporter()}
          >
            {envoi
              ? `${envoi.etape}… ${envoi.fait} / ${envoi.total}`
              : bilans
                ? 'Import terminé — choisissez un autre fichier pour recommencer'
                : `Tout importer (${aImporter.map((t) => TITRES[t].split(' ')[0]!.toLowerCase()).join(', ')})`}
          </button>
        </>
      )}

      {bilans &&
        ORDRE_CLASSEUR.filter((t) => bilans[t]).map((t) => (
          <VueBilan key={t} type={t} bilan={bilans[t]!} titre={`${ICONES[t]} ${TITRES[t]}`} />
        ))}
    </section>
  );
}

function EtapeImport({ org, type }: { org: string; type: TypeImport }) {
  const [fichier, setFichier] = useState<File | null>(null);
  const [analyse, setAnalyse] = useState<Analyse | null>(null);
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState<{ fait: number; total: number; etape: string } | null>(null);
  const [bilan, setBilan] = useState<Bilan | null>(null);
  const o = useOptionsImport(org);
  const { fournisseurs } = useFournisseurs(org);
  const [fournisseur, setFournisseur] = useState('');
  const [dateRec, setDateRec] = useState('');
  const [reference, setReference] = useState('');

  async function choisir(f: File) {
    setFichier(f);
    setAnalyse(null);
    setBilan(null);
    setErreur('');
    try {
      setAnalyse(analyser(await lireFichierTableur(f), type));
    } catch (e) {
      setErreur(messageErreur(e));
    }
  }

  const aStock = type === 'catalogue' && !!analyse?.lignes.some((l) => Number(l.valeurs.stock_initial) > 0);
  const aNomsPhotos = type === 'catalogue' && !!analyse?.lignes.some((l) => l.valeurs.photo && !l.image);

  async function importer() {
    if (!analyse || envoi) return;
    setErreur('');
    const b = await executerImport(
      org,
      type,
      analyse,
      { ...o, stockDepart: o.stockDepart && aStock, fournisseur, dateRec, reference },
      (fait, total, etape) => setEnvoi({ fait, total, etape }),
    );
    setBilan(b);
    setEnvoi(null);
  }

  const correspondancePhotos = useMemo(() => {
    if (!bilan || !analyse || !aNomsPhotos) return null;
    const m = new Map<string, string>();
    analyse.lignes.forEach((l, i) => {
      const r = bilan.lignes[i];
      if (l.valeurs.photo && !l.image && r?.produit_id) m.set(cleFichier(String(l.valeurs.photo)), r.produit_id);
    });
    return m;
  }, [bilan, analyse, aNomsPhotos]);

  return (
    <section className="carte import-etape">
      <ChoixFichier
        fichier={fichier}
        onChoix={(f) => void choisir(f)}
        modele={() => telechargerFichier(`Modele-DF-Gestion-${type}.xlsx`, TYPE_XLSX, modeleImport(type))}
        libelleModele={`Modèle Excel « ${TITRES[type]} »`}
        texteModele={
          <>
            <strong>Téléchargez le modèle</strong> et remplissez-le (une ligne par {type === 'fournisseurs' ? 'fournisseur' : 'article'}). Votre propre
            fichier convient aussi si ses colonnes portent des noms proches.
          </>
        }
      />
      <Alerte>{erreur}</Alerte>

      {analyse && (
        <>
          <div className="import-analyse">
            <p>
              Feuille « {analyse.feuille} » : <strong>{analyse.lignes.length}</strong> ligne{analyse.lignes.length > 1 ? 's' : ''} à importer
              {analyse.images > 0 && <> · 🖼️ {analyse.images} photo{analyse.images > 1 ? 's' : ''} dans le fichier</>}.
              {analyse.sansQuantite > 0 && (
                <span className="secondaire">
                  {' '}
                  ({analyse.sansQuantite} ligne{analyse.sansQuantite > 1 ? 's' : ''} sans quantité, laissée{analyse.sansQuantite > 1 ? 's' : ''} de côté)
                </span>
              )}
            </p>
            <div className="import-colonnes">
              {analyse.colonnes.map((c) => (
                <span key={c.cle} className="pastille-colonne" title={`Colonne du fichier : ${c.enTete}`}>
                  ✓ {c.libelle}
                </span>
              ))}
              {analyse.ignorees.map((c) => (
                <span key={c} className="pastille-colonne ignoree" title="Colonne non reconnue : elle sera ignorée">
                  {c}
                </span>
              ))}
            </div>
            {analyse.manquantes.length > 0 && <Alerte>{`Colonne obligatoire absente : ${analyse.manquantes.join(', ')}.`}</Alerte>}
          </div>

          {type !== 'fournisseurs' && !bilan ? (
            <RevueLignes analyse={analyse} type={type} fournisseurs={fournisseurs.map((f) => f.nom)} onChange={setAnalyse} />
          ) : (
          <div className="defilement-horizontal import-apercu">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Ligne</th>
                  {analyse.colonnes.map((c) => (
                    <th key={c.cle}>{c.libelle}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {analyse.lignes.slice(0, 8).map((l) => (
                  <tr key={l.numero}>
                    <td className="secondaire">{l.numero}</td>
                    {analyse.colonnes.map((c) => (
                      <td key={c.cle}>{c.cle === 'photo' && l.image ? '🖼️ image' : (l.valeurs[c.cle] ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {analyse.lignes.length > 8 && <p className="secondaire petit-texte">… et {analyse.lignes.length - 8} autres lignes.</p>}
          </div>
          )}

          <div className="import-options">
            {type === 'catalogue' && (
              <>
                <label className="case">
                  <input type="checkbox" checked={o.miseAJour} onChange={(e) => o.setMiseAJour(e.target.checked)} />
                  Mettre à jour les articles déjà présents (retrouvés par code, code-barres ou désignation)
                </label>
                {aStock && (
                  <label className="case">
                    <input type="checkbox" checked={o.stockDepart} onChange={(e) => o.setStockDepart(e.target.checked)} />
                    Préparer une réception « Stock de départ » avec la colonne Stock initial des nouveaux articles (à vérifier puis valider)
                  </label>
                )}
              </>
            )}
            {(type === 'approvisionnement' || (aStock && o.stockDepart)) && <ChoixMagasin o={o} />}
            {type === 'approvisionnement' && (
              <>
                <div className="grille-2">
                  <Champ label="Fournisseur par défaut" aide="Pour les lignes sans colonne Fournisseur">
                    <input list="fournisseurs-import" value={fournisseur} onChange={(e) => setFournisseur(e.target.value)} placeholder="Nom du fournisseur" />
                    <datalist id="fournisseurs-import">
                      {fournisseurs.map((f) => (
                        <option key={f.id} value={f.nom} />
                      ))}
                    </datalist>
                  </Champ>
                  <Champ label="Date de réception">
                    <input type="date" value={dateRec} onChange={(e) => setDateRec(e.target.value)} />
                  </Champ>
                  <Champ label="Référence (bon de livraison, facture)">
                    <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
                  </Champ>
                </div>
                <label className="case">
                  <input type="checkbox" checked={o.creerArticles} onChange={(e) => o.setCreerArticles(e.target.checked)} />
                  Créer dans le catalogue les articles absents (avec leur désignation et leur prix)
                </label>
                <p className="secondaire petit-texte">Les réceptions sont préparées en brouillon : vérifiez-les, puis validez-les pour faire entrer le stock.</p>
              </>
            )}
          </div>

          <button
            type="button"
            className="bouton bouton-principal bouton-plein"
            disabled={!!envoi || !!bilan || analyse.lignes.length === 0 || analyse.manquantes.length > 0 || (type === 'approvisionnement' && !o.magasin)}
            onClick={() => void importer()}
          >
            {envoi
              ? `${envoi.etape}… ${envoi.fait} / ${envoi.total}`
              : bilan
                ? 'Import terminé — choisissez un autre fichier pour recommencer'
                : `Importer ${analyse.lignes.length} ligne${analyse.lignes.length > 1 ? 's' : ''}`}
          </button>
        </>
      )}

      {bilan && (
        <VueBilan type={type} bilan={bilan} titre="Résultat">
          {correspondancePhotos && correspondancePhotos.size > 0 && (
            <div className="rapport-bloc">
              <h3>Photos indiquées par leur nom dans le fichier</h3>
              <PhotosEnLot org={org} correspondance={correspondancePhotos} compact />
            </div>
          )}
        </VueBilan>
      )}
    </section>
  );
}

function VueBilan({ type, bilan, titre, children }: { type: TypeImport; bilan: Bilan; titre: string; children?: ReactNode }) {
  const libelles = {
    catalogue: { cree: 'articles créés', maj: 'articles mis à jour' },
    fournisseurs: { cree: 'fournisseurs créés', maj: 'fournisseurs complétés' },
    approvisionnement: { cree: 'lignes reçues', maj: '' },
  }[type];
  return (
    <div className="import-bilan">
      <h2>{titre}</h2>
      <Alerte>{bilan.erreur && `Import interrompu : ${bilan.erreur}`}</Alerte>
      <div className="rapport-chiffres">
        <Chiffre libelle={libelles.cree} valeur={bilan.crees} />
        {libelles.maj && <Chiffre libelle={libelles.maj} valeur={bilan.mis_a_jour} />}
        {type === 'catalogue' && (bilan.photos > 0 || bilan.photosEchouees.length > 0) && <Chiffre libelle="photos ajoutées" valeur={bilan.photos} />}
        {type === 'approvisionnement' && <Chiffre libelle="articles créés" valeur={bilan.articlesCrees} />}
        {bilan.ignores > 0 && <Chiffre libelle="déjà présents, ignorés" valeur={bilan.ignores} />}
        <Chiffre libelle="lignes en erreur" valeur={bilan.erreurs} alerte={bilan.erreurs > 0} />
      </div>
      {bilan.receptions.length > 0 && (
        <div className="rapport-bloc">
          <h3>Réceptions préparées (brouillons)</h3>
          {bilan.receptions.map((r) => (
            <div key={r.id} className="rapport-ligne">
              <span>
                {r.fournisseur ?? 'Sans fournisseur'} · {r.lignes} ligne{Number(r.lignes) > 1 ? 's' : ''}
              </span>
              <Link className="bouton bouton-discret" to={`/stock/receptions/${r.id}`}>
                Vérifier et valider →
              </Link>
            </div>
          ))}
        </div>
      )}
      {(bilan.erreurs > 0 || bilan.photosEchouees.length > 0) && (
        <div className="rapport-bloc">
          <h3>Lignes à corriger dans le fichier</h3>
          <ul className="import-erreurs">
            {bilan.lignes
              .filter((l) => l.statut === 'erreur')
              .map((l) => (
                <li key={l.numero}>
                  <strong>Ligne {l.numero}</strong> : {l.message}
                </li>
              ))}
            {bilan.photosEchouees.map((n) => (
              <li key={`p${n}`}>
                <strong>Ligne {n}</strong> : photo illisible ou trop lourde (utilisez une image JPG ou PNG).
              </li>
            ))}
          </ul>
          <p className="secondaire petit-texte">Corrigez ces lignes et importez de nouveau le fichier : les lignes déjà importées sont retrouvées, pas dupliquées.</p>
        </div>
      )}
      {children}
    </div>
  );
}

function Chiffre({ libelle, valeur, alerte }: { libelle: string; valeur: number; alerte?: boolean }) {
  return (
    <div className={alerte ? 'chiffre-alerte' : ''}>
      <span>{libelle}</span>
      <strong>{valeur}</strong>
    </div>
  );
}

interface ArticleRef {
  id: string;
  code: string;
  designation: string;
}

/**
 * Photos en lot : chaque image est rattachée à l'article dont le code, le code-barres ou la
 * désignation correspond au nom du fichier (ou au nom indiqué dans la colonne Photo).
 */
function PhotosEnLot({ org, correspondance, compact }: { org: string; correspondance?: Map<string, string>; compact?: boolean }) {
  const [articles, setArticles] = useState<Map<string, ArticleRef> | null>(null);
  const [index, setIndex] = useState<Map<string, string>>(new Map());
  const [choix, setChoix] = useState<{ fichier: File; produit: ArticleRef | null }[]>([]);
  const [envoi, setEnvoi] = useState<{ fait: number; total: number } | null>(null);
  const [fin, setFin] = useState('');
  const [erreur, setErreur] = useState('');
  const entree = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      const tous = new Map<string, ArticleRef>();
      const idx = new Map<string, string>();
      for (let debut = 0; debut < 20000; debut += 1000) {
        const { data, error } = await supabase.from('produits').select('id, code, designation').eq('organisation_id', org).range(debut, debut + 999);
        if (error) return setErreur(messageErreur(error));
        for (const p of (data ?? []) as ArticleRef[]) {
          tous.set(p.id, p);
          idx.set(cleFichier(p.code), p.id);
          if (!idx.has(cleFichier(p.designation))) idx.set(cleFichier(p.designation), p.id);
        }
        if ((data ?? []).length < 1000) break;
      }
      for (let debut = 0; debut < 40000; debut += 1000) {
        const { data } = await supabase.from('codes_barres').select('code, produit_id').eq('organisation_id', org).range(debut, debut + 999);
        for (const c of (data ?? []) as { code: string; produit_id: string }[]) idx.set(cleFichier(c.code), c.produit_id);
        if ((data ?? []).length < 1000) break;
      }
      setArticles(tous);
      setIndex(idx);
    })();
  }, [org]);

  function choisir(liste: FileList | null) {
    if (!liste || !articles) return;
    setFin('');
    setChoix(
      Array.from(liste)
        .filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(f.name))
        .map((f) => {
          const cle = cleFichier(f.name);
          const id = correspondance?.get(cle) ?? index.get(cle);
          return { fichier: f, produit: (id && articles.get(id)) || null };
        }),
    );
  }

  const trouvees = choix.filter((c) => c.produit);
  const perdues = choix.filter((c) => !c.produit);

  async function envoyer() {
    setErreur('');
    setEnvoi({ fait: 0, total: trouvees.length });
    let ok = 0;
    const echecs: string[] = [];
    for (const c of trouvees) {
      try {
        await envoyerPhoto(org, c.produit!.id, c.fichier);
        ok++;
      } catch {
        echecs.push(c.fichier.name);
      }
      setEnvoi((e) => (e ? { ...e, fait: e.fait + 1 } : e));
    }
    setEnvoi(null);
    setChoix([]);
    setFin(`${ok} photo${ok > 1 ? 's' : ''} ajoutée${ok > 1 ? 's' : ''}.`);
    if (echecs.length) setErreur(`Envoi impossible pour : ${echecs.join(', ')}.`);
  }

  const contenu: ReactNode = (
    <>
      {!compact && (
        <p className="secondaire">
          Nommez chaque image comme l’article : son <strong>code interne</strong> (P00012.jpg), son <strong>code-barres</strong>
          (6151100000017.jpg) ou sa <strong>désignation</strong> (Riz parfumé 5 kg.jpg). Les photos sont réduites avant l’envoi. Vous pouvez aussi coller
          les photos directement dans le classeur (onglet « Classeur complet »).
        </p>
      )}
      <div className="actions-demande">
        <input ref={entree} type="file" accept="image/*" multiple hidden onChange={(e) => choisir(e.target.files)} />
        <button type="button" className="bouton bouton-principal" disabled={!articles || !!envoi} onClick={() => entree.current?.click()}>
          🖼️ {articles ? 'Choisir les photos' : 'Chargement du catalogue…'}
        </button>
      </div>
      <Alerte type="succes">{fin}</Alerte>
      <Alerte>{erreur}</Alerte>
      {choix.length > 0 && (
        <>
          <ul className="import-photos">
            {trouvees.map((c) => (
              <li key={c.fichier.name}>
                <Pastille ton="vert">✓</Pastille> {c.fichier.name} → <strong>{c.produit!.designation}</strong>
              </li>
            ))}
            {perdues.map((c) => (
              <li key={c.fichier.name} className="secondaire">
                <Pastille ton="gris">?</Pastille> {c.fichier.name} : aucun article de ce nom
              </li>
            ))}
          </ul>
          <button type="button" className="bouton bouton-principal bouton-plein" disabled={!!envoi || trouvees.length === 0} onClick={() => void envoyer()}>
            {envoi ? `Envoi… ${envoi.fait} / ${envoi.total}` : `Ajouter ${trouvees.length} photo${trouvees.length > 1 ? 's' : ''}`}
          </button>
        </>
      )}
    </>
  );
  return compact ? <div>{contenu}</div> : <section className="carte import-etape">{contenu}</section>;
}
