import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { appeler, type Accueil as DonneesAccueil, type ProduitCarte, type Vitrine } from '../api';
import { BanniereSoldes, CarteBoutique, Chargement, Erreur, GrilleProduits } from '../composants';

/** Page d'accueil : soldes à l'affiche, catégories, boutiques, nouveautés et meilleures ventes. */
export function Accueil() {
  const [d, setD] = useState<DonneesAccueil | null>(null);
  const [erreur, setErreur] = useState('');
  const charger = useCallback(() => {
    setErreur('');
    appeler<DonneesAccueil>('marche_accueil').then(setD).catch((e: Error) => setErreur(e.message));
  }, []);
  useEffect(() => {
    charger();
    document.title = 'DF Marché — les boutiques près de chez vous';
  }, [charger]);
  if (erreur) return <Erreur reessayer={charger}>{erreur}</Erreur>;
  if (!d) return <Chargement />;
  return (
    <>
      {d.soldes.length > 0 ? (
        <BanniereSoldes soldes={d.soldes} />
      ) : (
        <section className="accroche">
          <h1>Les boutiques de votre quartier, en ligne</h1>
          <p>Stock en direct, livraison ou retrait, paiement à la livraison ou par Mobile Money.</p>
        </section>
      )}
      {d.categories.length > 0 && (
        <nav className="puces-categories" aria-label="Catégories">
          {d.categories.map((c) => (
            <Link key={c} to={`/recherche?categorie=${encodeURIComponent(c)}`}>{c}</Link>
          ))}
        </nav>
      )}
      {d.soldes.length > 0 && (
        <section className="rayon">
          <div className="rayon-titre"><h2>🔥 Soldes en cours</h2><Link to="/soldes">Tout voir →</Link></div>
          <GrilleProduits produits={d.soldes.slice(0, 8)} />
        </section>
      )}
      <section className="rayon">
        <div className="rayon-titre"><h2>Boutiques</h2><Link to="/boutiques">Toutes les boutiques →</Link></div>
        {d.boutiques.length ? (
          <div className="grille-boutiques">{d.boutiques.slice(0, 6).map((v) => <CarteBoutique key={v.slug} v={v} />)}</div>
        ) : (
          <p className="vide">Les premières boutiques arrivent bientôt.</p>
        )}
      </section>
      {d.populaires.length > 0 && (
        <section className="rayon">
          <div className="rayon-titre"><h2>Les plus commandés</h2></div>
          <GrilleProduits produits={d.populaires} />
        </section>
      )}
      {d.nouveautes.length > 0 && (
        <section className="rayon">
          <div className="rayon-titre"><h2>Nouveautés</h2><Link to="/recherche?tri=nouveautes">Tout voir →</Link></div>
          <GrilleProduits produits={d.nouveautes} />
        </section>
      )}
      <section className="garanties">
        <div><span aria-hidden>📦</span><strong>Stock en direct</strong><p>Ce qui s’affiche est en rayon : la boutique met à jour depuis sa caisse.</p></div>
        <div><span aria-hidden>🛵</span><strong>Livraison ou retrait</strong><p>Choisissez votre zone et l’heure qui vous arrange.</p></div>
        <div><span aria-hidden>📲</span><strong>Paiement simple</strong><p>À la livraison, ou par Wave, Orange Money, MTN, Moov directement à la boutique.</p></div>
        <div><span aria-hidden>⭐</span><strong>Avis vérifiés</strong><p>Seuls les clients livrés peuvent noter un produit.</p></div>
      </section>
    </>
  );
}

const TRIS = [
  ['pertinence', 'Pertinence'],
  ['prix_croissant', 'Prix croissant'],
  ['prix_decroissant', 'Prix décroissant'],
  ['nouveautes', 'Nouveautés'],
] as const;

/** Recherche dans tout le marché ; « /soldes » = la même page filtrée sur les soldes. */
export function Recherche({ soldes }: { soldes?: boolean }) {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const categorie = params.get('categorie');
  const tri = params.get('tri') ?? 'pertinence';
  const [r, setR] = useState<{ total: number; produits: ProduitCarte[] } | null>(null);
  const [erreur, setErreur] = useState('');
  useEffect(() => {
    setR(null);
    appeler<{ total: number; produits: ProduitCarte[] }>('marche_produits', {
      p_texte: q || null, p_categorie: categorie, p_soldes: !!soldes, p_tri: tri, p_limite: 96,
    }).then(setR).catch((e: Error) => setErreur(e.message));
    document.title = `${soldes ? 'Soldes' : q ? `« ${q} »` : categorie ?? 'Produits'} — DF Marché`;
  }, [q, categorie, tri, soldes]);
  const maj = (k: string, v: string | null) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    setParams(n);
  };
  return (
    <section className="rayon">
      <div className="rayon-titre">
        <h1>{soldes ? '🔥 Tous les soldes' : q ? `Résultats pour « ${q} »` : categorie ?? 'Tous les produits'}</h1>
        <select value={tri} onChange={(e) => maj('tri', e.target.value)} aria-label="Trier">
          {TRIS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {categorie && <p><button className="puce-filtre" onClick={() => maj('categorie', null)}>{categorie} ✕</button></p>}
      {erreur ? <Erreur>{erreur}</Erreur> : !r ? <Chargement /> : (
        <>
          <p className="secondaire">{r.total} produit{r.total > 1 ? 's' : ''}</p>
          <GrilleProduits produits={r.produits} />
        </>
      )}
    </section>
  );
}

export function ListeBoutiques() {
  const [d, setD] = useState<Vitrine[] | null>(null);
  const [activite, setActivite] = useState('');
  const [texte, setTexte] = useState('');
  const [erreur, setErreur] = useState('');
  useEffect(() => {
    appeler<DonneesAccueil>('marche_accueil').then((x) => setD(x.boutiques)).catch((e: Error) => setErreur(e.message));
    document.title = 'Boutiques — DF Marché';
  }, []);
  if (erreur) return <Erreur>{erreur}</Erreur>;
  if (!d) return <Chargement />;
  const activites = [...new Set(d.map((v) => v.activite).filter((x): x is string => !!x))];
  const t = texte.trim().toLowerCase();
  const vues = d.filter((v) => (!activite || v.activite === activite) && (!t || `${v.nom} ${v.commune ?? ''} ${v.ville ?? ''}`.toLowerCase().includes(t)));
  return (
    <section className="rayon">
      <div className="rayon-titre"><h1>Choisissez votre boutique</h1></div>
      <div className="filtres">
        <input type="search" placeholder="Nom, commune…" value={texte} onChange={(e) => setTexte(e.target.value)} aria-label="Chercher une boutique" />
        <select value={activite} onChange={(e) => setActivite(e.target.value)} aria-label="Activité">
          <option value="">Toutes les activités</option>
          {activites.map((a) => <option key={a}>{a}</option>)}
        </select>
      </div>
      {vues.length ? <div className="grille-boutiques">{vues.map((v) => <CarteBoutique key={v.slug} v={v} />)}</div> : <p className="vide">Aucune boutique.</p>}
    </section>
  );
}
