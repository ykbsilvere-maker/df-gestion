import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';
import { montant } from '../lib/argent';
import type { Categorie, Produit } from '../lib/types';
import { Alerte, Fenetre, Pastille, Vide } from '../components/ui';
import { Scanner } from '../components/Scanner';
import { useDouchette } from '../lib/douchette';
import { FicheProduit } from './FicheProduit';
import { Vignette } from '../components/PhotoProduit';
import { useDemandeCreation } from '../lib/demande';

interface Ligne extends Produit {
  codes_barres: string[];
  pertinence?: number;
}

type Edition = { produit?: Produit; codeInitial?: string } | null;

const PAR_PAGE = 50;
const ressembleCodeBarres = (t: string) => /^\d{6,14}$/.test(t.replace(/\s/g, ''));

export function Catalogue() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const [terme, setTerme] = useState('');
  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [categories, setCategories] = useState<Categorie[]>([]);
  const [filtreCategorie, setFiltreCategorie] = useState('');
  const [avecArretes, setAvecArretes] = useState(false);
  const [page, setPage] = useState(0);
  const [encore, setEncore] = useState(false);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState('');
  const [edition, setEdition] = useState<Edition>(null);
  const [scan, setScan] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [codeInconnu, setCodeInconnu] = useState('');
  const champ = useRef<HTMLInputElement>(null);
  useDemandeCreation(peut('catalogue.creer'), () => setEdition({}));
  const requete = useRef(0);

  const chargerCategories = useCallback(async () => {
    const { data } = await supabase.from('categories').select('*').eq('organisation_id', org).order('nom');
    setCategories((data ?? []) as Categorie[]);
  }, [org]);

  /** Recherche (code-barres, code interne, mots) ou liste paginée. Renvoie les lignes trouvées. */
  const charger = useCallback(
    async (t: string): Promise<Ligne[]> => {
      const numero = ++requete.current;
      setChargement(true);
      setErreur('');
      let resultat: Ligne[] = [];
      if (t.trim()) {
        const { data, error } = await supabase.rpc('rechercher_produits', {
          p_org: org,
          p_terme: t,
          p_limite: 100,
          p_inclure_inactifs: avecArretes,
        });
        if (error) setErreur(messageErreur(error));
        const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
        const complets = ids.length
          ? ((await supabase.from('produits').select('*').in('id', ids)).data ?? [])
          : [];
        const parId = new Map((complets as Produit[]).map((p) => [p.id, p]));
        resultat = ((data ?? []) as { id: string; codes_barres: string[]; pertinence: number }[])
          .filter((r) => parId.has(r.id))
          .map((r) => ({ ...parId.get(r.id)!, codes_barres: r.codes_barres, pertinence: r.pertinence }));
        if (filtreCategorie) resultat = resultat.filter((r) => r.categorie_id === filtreCategorie);
        setEncore(false);
      } else {
        let q = supabase
          .from('produits')
          .select('*')
          .eq('organisation_id', org)
          .order('designation')
          .range(page * PAR_PAGE, page * PAR_PAGE + PAR_PAGE);
        if (!avecArretes) q = q.eq('statut', 'actif');
        if (filtreCategorie) q = q.eq('categorie_id', filtreCategorie);
        const { data, error } = await q;
        if (error) setErreur(messageErreur(error));
        const produits = (data ?? []) as Produit[];
        setEncore(produits.length > PAR_PAGE);
        const visibles = produits.slice(0, PAR_PAGE);
        const { data: codes } = visibles.length
          ? await supabase.from('codes_barres').select('produit_id, code').in('produit_id', visibles.map((p) => p.id))
          : { data: [] };
        const parProduit = new Map<string, string[]>();
        for (const c of (codes ?? []) as { produit_id: string; code: string }[])
          parProduit.set(c.produit_id, [...(parProduit.get(c.produit_id) ?? []), c.code]);
        resultat = visibles.map((p) => ({ ...p, codes_barres: parProduit.get(p.id) ?? [] }));
      }
      if (numero === requete.current) {
        setLignes(resultat);
        setChargement(false);
      }
      return resultat;
    },
    [org, page, avecArretes, filtreCategorie],
  );

  useEffect(() => {
    void chargerCategories();
  }, [chargerCategories]);

  // Recherche au fil de la frappe (léger délai) ; Entrée et le scan déclenchent tout de suite.
  useEffect(() => {
    const t = setTimeout(() => void charger(terme), terme ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terme, page, avecArretes, filtreCategorie]);

  // Lecteur de codes-barres : un scan cherche l'article, où que soit le curseur.
  useDouchette((code) => {
    setTerme(code);
    setPage(0);
    void validerSaisie(code);
  }, !edition && !scan);

  /** Traitement d'un code lu (lecteur USB/Bluetooth ou caméra) ou d'une saisie validée par Entrée. */
  async function validerSaisie(saisie: string) {
    const t = saisie.trim();
    setCodeInconnu('');
    if (!t) return;
    const trouves = await charger(t);
    const exact = trouves.filter((r) => r.pertinence === 0);
    if (exact.length === 1) {
      setEdition({ produit: exact[0] });
    } else if (trouves.length === 0 && ressembleCodeBarres(t)) {
      setCodeInconnu(t.replace(/\s/g, ''));
    }
  }

  function basculerSelection(id: string) {
    const s = new Set(selection);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelection(s);
  }

  const nomCategorie = (id: string | null) => categories.find((c) => c.id === id)?.nom ?? '—';

  return (
    <div className="page-catalogue">
      <h1 className="sr-only">Catalogue</h1>
      <Alerte>{erreur}</Alerte>

      {/* Recherche figée en haut : la liste défile dessous, comme à la caisse. */}
      <section className="carte barre-recherche barre-figee">
        <div className="champ-avec-bouton">
          <input
            ref={champ}
            data-douchette="champ"
            type="search"
            value={terme}
            onChange={(e) => {
              setTerme(e.target.value);
              setPage(0);
              setCodeInconnu('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void validerSaisie(terme);
              }
            }}
            placeholder="Nom, code interne ou code-barres…"
            aria-label="Rechercher un produit"
            autoFocus
            enterKeyHint="search"
          />
          <button className="bouton bouton-discret" onClick={() => setScan(true)} aria-label="Scanner un code-barres">
            📷
          </button>
          {(peut('catalogue.creer') || peut('catalogue.modifier')) && (
            <button className="bouton bouton-discret" onClick={() => naviguer('/import')} aria-label="Importer depuis Excel" title="Importer depuis Excel (articles, prix, photos)">
              📥
            </button>
          )}
          {peut('catalogue.creer') && (
            <button className="bouton bouton-principal" onClick={() => setEdition({})} aria-label="Nouveau produit" title="Nouveau produit">
              + Nouveau
            </button>
          )}
        </div>
        <div className="filtres-ligne">
          <select value={filtreCategorie} onChange={(e) => { setFiltreCategorie(e.target.value); setPage(0); }} aria-label="Catégorie">
            <option value="">Toutes les catégories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nom}
              </option>
            ))}
          </select>
          <label className="case">
            <input type="checkbox" checked={avecArretes} onChange={(e) => setAvecArretes(e.target.checked)} />
            Suspendus et arrêtés
          </label>
          {selection.size > 0 && (
            <button className="bouton-lien" onClick={() => naviguer('/catalogue/etiquettes', { state: { produits: [...selection] } })}>
              🏷 Étiquettes ({selection.size})
            </button>
          )}
        </div>
        {codeInconnu && (
          <Alerte type="info">
            Aucun produit n’a le code <strong>{codeInconnu}</strong>.{' '}
            {peut('catalogue.creer') && (
              <button className="bouton-lien" onClick={() => setEdition({ codeInitial: codeInconnu })}>
                Créer un produit avec ce code
              </button>
            )}
          </Alerte>
        )}
      </section>

      <section className="carte">
        {!chargement && lignes.length === 0 ? (
          <Vide>{terme ? 'Aucun produit ne correspond.' : 'Aucun produit pour l’instant. Commencez par « Nouveau produit ».'}</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau tableau-catalogue">
              <thead>
                <tr>
                  <th aria-label="Sélection" />
                  <th>Produit</th>
                  <th className="col-secondaire">Catégorie</th>
                  <th className="nombre">Prix de vente</th>
                  <th className="col-secondaire">Codes-barres</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {lignes.map((p) => (
                  <tr key={p.id} className={p.statut === 'actif' ? 'ligne-cliquable' : 'ligne-cliquable ligne-inactive'}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selection.has(p.id)}
                        onChange={() => basculerSelection(p.id)}
                        aria-label={`Sélectionner ${p.designation}`}
                      />
                    </td>
                    <td onClick={() => setEdition({ produit: p })}>
                      <div className="produit-avec-photo">
                      <Vignette chemin={p.photo_path} taille={40} />
                      <div>
                      <strong>{p.designation}</strong>
                      <div className="secondaire">
                        <span className="code">{p.code}</span> · {p.unite}
                        {p.marque ? ` · ${p.marque}` : ''}
                      </div>
                      </div>
                      </div>
                    </td>
                    <td className="col-secondaire" onClick={() => setEdition({ produit: p })}>{nomCategorie(p.categorie_id)}</td>
                    <td className="nombre" onClick={() => setEdition({ produit: p })}>
                      {montant(p.prix_vente)}
                    </td>
                    <td className="col-secondaire" onClick={() => setEdition({ produit: p })}>
                      {p.codes_barres.length ? (
                        <span className="code">
                          {p.codes_barres[0]}
                          {p.codes_barres.length > 1 ? ` +${p.codes_barres.length - 1}` : ''}
                        </span>
                      ) : (
                        <span className="secondaire">aucun</span>
                      )}
                    </td>
                    <td onClick={() => setEdition({ produit: p })}>
                      {p.statut === 'actif' ? (
                        <Pastille ton="vert">Actif</Pastille>
                      ) : p.statut === 'suspendu' ? (
                        <Pastille ton="or">Suspendu</Pastille>
                      ) : (
                        <Pastille ton="gris">Arrêté</Pastille>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!terme && (
          <div className="pagination">
            <button className="bouton bouton-discret" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Précédents
            </button>
            <span>Page {page + 1}</span>
            <button className="bouton bouton-discret" disabled={!encore} onClick={() => setPage(page + 1)}>
              Suivants
            </button>
          </div>
        )}
      </section>

      <Fenetre
        titre={edition?.produit ? edition.produit.designation : 'Nouveau produit'}
        ouverte={!!edition}
        onFermer={() => {
          setEdition(null);
          void charger(terme);
          champ.current?.focus();
        }}
        large
      >
        {edition && (
          <FicheProduit
            key={edition.produit?.id ?? `nouveau-${edition.codeInitial ?? ''}`}
            produit={edition.produit}
            codeInitial={edition.codeInitial}
            categories={categories}
            onCategorieCreee={chargerCategories}
            onEnregistre={() => setCodeInconnu('')}
          />
        )}
      </Fenetre>

      <Fenetre titre="Scanner un code-barres" ouverte={scan} onFermer={() => setScan(false)}>
        {scan && (
          <Scanner
            onCode={(code) => {
              setScan(false);
              setTerme(code);
              void validerSaisie(code);
            }}
            onFermer={() => setScan(false)}
          />
        )}
      </Fenetre>
    </div>
  );
}
