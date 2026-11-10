import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { telechargerFichier, TYPE_XLSX } from '../../lib/excel';
import { lireFichierTableur } from '../../lib/lectureExcel';
import { analyser, cleFichier, modeleImport, paquets, TITRES, type Analyse, type TypeImport } from '../../lib/importTableur';
import { useMagasinCourant, useMagasins } from '../../lib/stock';
import { useFournisseurs } from './Fournisseurs';
import { reduire } from '../../components/PhotoProduit';
import { Alerte, Champ, EnTetePage, Pastille } from '../../components/ui';

type Onglet = TypeImport | 'photos';

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
}

const ACCEPT_TABLEUR = '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/comma-separated-values';

/**
 * Import en masse depuis Excel : catalogue, fournisseurs, approvisionnements et photos.
 * Deuxième façon de remplir l'application, à côté de la saisie article par article.
 */
export function ImportExcel() {
  const { organisation, peut } = useSession();
  const [params, setParams] = useSearchParams();
  const org = organisation!.organisation_id;
  const onglets: [Onglet, string, boolean][] = [
    ['catalogue', '🛍️ Catalogue', peut('catalogue.creer')],
    ['fournisseurs', '🚚 Fournisseurs', peut('fournisseurs.creer') || peut('achats.creer')],
    ['approvisionnement', '📥 Approvisionnement', peut('stock.creer') || peut('achats.creer')],
    ['photos', '🖼️ Photos', peut('catalogue.modifier')],
  ];
  const permis = onglets.filter((o) => o[2]);
  const demande = params.get('type') as Onglet | null;
  const onglet = permis.find((o) => o[0] === demande)?.[0] ?? permis[0]?.[0] ?? 'catalogue';

  return (
    <>
      <EnTetePage
        icone="📥"
        titre="Importer depuis Excel"
        sousTitre="Remplissez un modèle Excel (ou votre propre fichier) et ajoutez tout d’un coup, au lieu de saisir chaque ligne. La saisie une par une reste possible."
      />
      <nav className="onglets onglets-compacts onglets-import" role="tablist">
        {permis.map(([o, libelle]) => (
          <button key={o} type="button" role="tab" aria-selected={onglet === o} className={onglet === o ? 'actif' : ''} onClick={() => setParams({ type: o }, { replace: true })}>
            {libelle}
          </button>
        ))}
      </nav>
      {onglet === 'photos' ? <PhotosEnLot org={org} /> : <EtapeImport key={onglet} org={org} type={onglet} />}
    </>
  );
}

function EtapeImport({ org, type }: { org: string; type: TypeImport }) {
  const [fichier, setFichier] = useState<File | null>(null);
  const [analyse, setAnalyse] = useState<Analyse | null>(null);
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState<{ fait: number; total: number } | null>(null);
  const [bilan, setBilan] = useState<Bilan | null>(null);
  const [miseAJour, setMiseAJour] = useState(true);
  const [creerArticles, setCreerArticles] = useState(true);
  const [stockDepart, setStockDepart] = useState(true);
  const magasins = useMagasins(org);
  const [magasin, setMagasin] = useMagasinCourant(org, magasins);
  const { fournisseurs } = useFournisseurs(org);
  const [fournisseur, setFournisseur] = useState('');
  const [dateRec, setDateRec] = useState('');
  const [reference, setReference] = useState('');
  const entree = useRef<HTMLInputElement>(null);

  async function choisir(f: File | undefined) {
    if (!f) return;
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
  const aPhotos = type === 'catalogue' && !!analyse?.lignes.some((l) => l.valeurs.photo);

  async function importer() {
    if (!analyse || envoi) return;
    setErreur('');
    setBilan(null);
    const lots = paquets(analyse.lignes, type === 'approvisionnement' ? 1000 : 400);
    const b: Bilan = { crees: 0, mis_a_jour: 0, ignores: 0, erreurs: 0, lignes: [], receptions: [], articlesCrees: 0 };
    setEnvoi({ fait: 0, total: analyse.lignes.length });
    try {
      let fait = 0;
      for (const lot of lots) {
        const lignes = lot.map((l) => l.valeurs);
        const { data, error } =
          type === 'catalogue'
            ? await supabase.rpc('importer_catalogue', { p_org: org, p_lignes: lignes, p_mettre_a_jour: miseAJour })
            : type === 'fournisseurs'
              ? await supabase.rpc('importer_fournisseurs', { p_org: org, p_lignes: lignes })
              : await supabase.rpc('importer_reception', {
                  p_org: org,
                  p_entete: { magasin_id: magasin, fournisseur: fournisseur || null, date_reception: dateRec || null, reference: reference || null },
                  p_lignes: lignes,
                  p_creer_articles: creerArticles,
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
        setEnvoi({ fait, total: analyse.lignes.length });
      }
      // Stock de départ : une réception en brouillon, à vérifier puis valider.
      if (aStock && stockDepart && magasin) {
        const depart = analyse.lignes
          .map((l, i) => ({ l, r: b.lignes[i] }))
          .filter(({ l, r }) => Number(l.valeurs.stock_initial) > 0 && r?.statut === 'cree' && r.code)
          .map(({ l, r }) => ({ code: r!.code, quantite: l.valeurs.stock_initial, prix_achat: l.valeurs.prix_achat }));
        if (depart.length) {
          const { data, error } = await supabase.rpc('importer_reception', {
            p_org: org,
            p_entete: { magasin_id: magasin, note: 'Stock de départ (import du catalogue)' },
            p_lignes: depart,
            p_creer_articles: false,
          });
          if (error) throw error;
          b.receptions.push(...((data as { receptions: Bilan['receptions'] }).receptions ?? []));
        }
      }
      setBilan(b);
    } catch (e) {
      setErreur(messageErreur(e));
      if (b.lignes.length) setBilan(b);
    } finally {
      setEnvoi(null);
    }
  }

  const correspondancePhotos = useMemo(() => {
    if (!bilan || !analyse || !aPhotos) return null;
    const m = new Map<string, string>();
    analyse.lignes.forEach((l, i) => {
      const r = bilan.lignes[i];
      if (l.valeurs.photo && r?.produit_id) m.set(cleFichier(String(l.valeurs.photo)), r.produit_id);
    });
    return m;
  }, [bilan, analyse, aPhotos]);

  const libelles = {
    catalogue: { cree: 'articles créés', maj: 'articles mis à jour' },
    fournisseurs: { cree: 'fournisseurs créés', maj: 'fournisseurs complétés' },
    approvisionnement: { cree: 'lignes ajoutées', maj: '' },
  }[type];

  return (
    <section className="carte import-etape">
      <ol className="import-pas">
        <li>
          <strong>Téléchargez le modèle</strong> et remplissez-le (une ligne par {type === 'fournisseurs' ? 'fournisseur' : 'article'}). Votre propre
          fichier convient aussi si ses colonnes portent des noms proches.
          <div className="actions-demande">
            <button
              type="button"
              className="bouton bouton-discret"
              onClick={() => telechargerFichier(`Modele-DF-Gestion-${type}.xlsx`, TYPE_XLSX, modeleImport(type))}
            >
              ⬇️ Modèle Excel « {TITRES[type]} »
            </button>
          </div>
        </li>
        <li>
          <strong>Choisissez votre fichier</strong> (.xlsx ou .csv).
          <div className="actions-demande">
            <input ref={entree} type="file" accept={ACCEPT_TABLEUR} hidden onChange={(e) => void choisir(e.target.files?.[0])} />
            <button type="button" className="bouton bouton-principal" onClick={() => entree.current?.click()}>
              📂 {fichier ? 'Choisir un autre fichier' : 'Choisir le fichier'}
            </button>
            {fichier && <span className="secondaire">{fichier.name}</span>}
          </div>
        </li>
      </ol>
      <Alerte>{erreur}</Alerte>

      {analyse && (
        <>
          <div className="import-analyse">
            <p>
              Feuille « {analyse.feuille} » : <strong>{analyse.lignes.length}</strong> ligne{analyse.lignes.length > 1 ? 's' : ''} à importer.
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
                      <td key={c.cle}>{l.valeurs[c.cle] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {analyse.lignes.length > 8 && <p className="secondaire petit-texte">… et {analyse.lignes.length - 8} autres lignes.</p>}
          </div>

          <div className="import-options">
            {type === 'catalogue' && (
              <>
                <label className="case">
                  <input type="checkbox" checked={miseAJour} onChange={(e) => setMiseAJour(e.target.checked)} />
                  Mettre à jour les articles déjà présents (retrouvés par code, code-barres ou désignation)
                </label>
                {aStock && (
                  <label className="case">
                    <input type="checkbox" checked={stockDepart} onChange={(e) => setStockDepart(e.target.checked)} />
                    Préparer une réception « Stock de départ » avec la colonne Stock initial des nouveaux articles (à vérifier puis valider)
                  </label>
                )}
              </>
            )}
            {(type === 'approvisionnement' || (type === 'catalogue' && aStock && stockDepart)) && magasins.length > 1 && (
              <Champ label="Magasin qui reçoit">
                <select value={magasin} onChange={(e) => setMagasin(e.target.value)}>
                  {magasins.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.nom}
                    </option>
                  ))}
                </select>
              </Champ>
            )}
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
                  <input type="checkbox" checked={creerArticles} onChange={(e) => setCreerArticles(e.target.checked)} />
                  Créer dans le catalogue les articles absents (avec leur désignation et leur prix)
                </label>
                <p className="secondaire petit-texte">
                  Les réceptions sont préparées en brouillon : vérifiez-les, puis validez-les pour faire entrer le stock.
                </p>
              </>
            )}
          </div>

          <button
            type="button"
            className="bouton bouton-principal bouton-plein"
            disabled={!!envoi || !!bilan || analyse.lignes.length === 0 || analyse.manquantes.length > 0 || (type === 'approvisionnement' && !magasin)}
            onClick={() => void importer()}
          >
            {envoi ? `Import en cours… ${envoi.fait} / ${envoi.total}` : bilan ? 'Import terminé — choisissez un autre fichier pour recommencer' : `Importer ${analyse.lignes.length} ligne${analyse.lignes.length > 1 ? 's' : ''}`}
          </button>
        </>
      )}

      {bilan && (
        <div className="import-bilan">
          <h2>Résultat</h2>
          <div className="rapport-chiffres">
            <Chiffre libelle={libelles.cree} valeur={bilan.crees} />
            {libelles.maj && <Chiffre libelle={libelles.maj} valeur={bilan.mis_a_jour} />}
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
                    {r.fournisseur ?? (type === 'catalogue' ? 'Stock de départ' : 'Sans fournisseur')} · {r.lignes} ligne{Number(r.lignes) > 1 ? 's' : ''}
                  </span>
                  <Link className="bouton bouton-discret" to={`/stock/receptions/${r.id}`}>
                    Vérifier et valider →
                  </Link>
                </div>
              ))}
            </div>
          )}
          {bilan.erreurs > 0 && (
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
              </ul>
              <p className="secondaire petit-texte">Corrigez ces lignes et importez de nouveau le fichier : les lignes déjà importées sont retrouvées, pas dupliquées.</p>
            </div>
          )}
          {correspondancePhotos && correspondancePhotos.size > 0 && (
            <div className="rapport-bloc">
              <h3>Photos indiquées dans le fichier</h3>
              <PhotosEnLot org={org} correspondance={correspondancePhotos} compact />
            </div>
          )}
        </div>
      )}
    </section>
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
        const image = await reduire(c.fichier);
        const chemin = `${org}/${c.produit!.id}-${Date.now()}.jpg`;
        const { error } = await supabase.storage.from('produits').upload(chemin, image, { contentType: 'image/jpeg', upsert: true });
        if (error) throw error;
        const { error: e2 } = await supabase.from('produits').update({ photo_path: chemin }).eq('id', c.produit!.id);
        if (e2) throw e2;
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
          (6151100000017.jpg) ou sa <strong>désignation</strong> (Riz parfumé 5 kg.jpg). Les photos sont réduites avant l’envoi.
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
