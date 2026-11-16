import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { appeler, type Accueil as DonneesAccueil, type ProduitCarte, type Vitrine } from '../api';
import {
  BanniereSoldes,
  CarteBoutique,
  Chargement,
  Erreur,
  GrilleProduits,
  Rangee,
  RangeeProduits,
  Squelettes,
  TitreRayon,
  VentesFlash,
  rayon,
  salutation,
} from '../composants';
import { IcoBoutique, IcoCoeur, IcoFlamme, IcoRecommander, IcoSuivi } from '../icones';
import { mesCommandes, useFavoris } from '../panier';

/** Page d'accueil : affiches des soldes, raccourcis, ventes flash, rayons, boutiques, populaires, nouveautés. */
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
  const flash = [...d.soldes].sort((a, b) => (a.solde_fin ?? '9').localeCompare(b.solde_fin ?? '9'));
  const derniere = mesCommandes()[0];
  return (
    <>
      <section className="accueil-tete">
        <p className="salut">{salutation()} 👋</p>
        <h1>Qu’est-ce qu’on achète aujourd’hui ?</h1>
      </section>

      {d.soldes.length > 0 ? (
        <BanniereSoldes soldes={d.soldes} />
      ) : (
        <section className="accroche">
          <h2>Les boutiques de votre quartier, en ligne</h2>
          <p>Stock en direct, livraison ou retrait, paiement à la livraison ou par Mobile Money.</p>
        </section>
      )}

      <nav className="raccourcis" aria-label="Raccourcis">
        <Link to="/soldes"><span className="rond orange"><IcoFlamme /></span>Promos</Link>
        <Link to="/boutiques"><span className="rond"><IcoBoutique /></span>Boutiques</Link>
        <Link to={derniere ? `/suivi/${derniere.code}` : '/mes-commandes'}><span className="rond"><IcoSuivi /></span>Suivi</Link>
        <Link to="/mes-commandes"><span className="rond"><IcoRecommander /></span>Recommander</Link>
        <Link to="/favoris"><span className="rond rose"><IcoCoeur /></span>Favoris</Link>
      </nav>

      <VentesFlash soldes={flash} />

      {d.categories.length > 0 && (
        <section className="section">
          <TitreRayon titre="Nos rayons" lien={{ vers: '/rayons' }} />
          <Rangee>
            {d.categories.map((c) => {
              const r = rayon(c);
              return (
                <Link key={c} to={`/rayons/${encodeURIComponent(c)}`} className="tuile-rayon" style={{ background: r.teinte }}>
                  <span aria-hidden>{r.emoji}</span>
                  <strong>{c}</strong>
                </Link>
              );
            })}
          </Rangee>
        </section>
      )}

      <section className="section">
        <TitreRayon titre="Choisissez votre boutique" lien={{ vers: '/boutiques', libelle: 'Toutes' }} />
        {d.boutiques.length ? (
          <Rangee large>{d.boutiques.map((v) => <CarteBoutique key={v.slug} v={v} />)}</Rangee>
        ) : (
          <p className="vide">Les premières boutiques arrivent bientôt.</p>
        )}
      </section>

      {d.populaires.length > 0 && (
        <section className="section">
          <TitreRayon titre="Produits populaires" sous="Les plus commandés sur DF Marché" />
          <RangeeProduits produits={d.populaires} />
        </section>
      )}

      {d.nouveautes.length > 0 && (
        <section className="section">
          <TitreRayon titre="Nouveautés" lien={{ vers: '/recherche?tri=nouveautes' }} />
          <GrilleProduits produits={d.nouveautes} />
        </section>
      )}

      <section className="garanties">
        <div><span aria-hidden>📦</span><strong>Stock en direct</strong><p>Ce qui s’affiche est en rayon : la boutique met à jour depuis sa caisse.</p></div>
        <div><span aria-hidden>🛵</span><strong>Livraison ou retrait</strong><p>Choisissez votre zone et l’heure qui vous arrange.</p></div>
        <div><span aria-hidden>📲</span><strong>Paiement simple</strong><p>À la livraison, ou Wave, Orange Money, MTN, Moov directement à la boutique.</p></div>
        <div><span aria-hidden>⭐</span><strong>Avis vérifiés</strong><p>Seuls les clients livrés peuvent noter un produit.</p></div>
      </section>
    </>
  );
}

const TRIS = [
  ['pertinence', 'Pertinence'],
  ['prix_croissant', 'Prix ↑'],
  ['prix_decroissant', 'Prix ↓'],
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
    setParams(n, { replace: true });
  };
  return (
    <section className="section">
      <div className="entete-page">
        <h1>{soldes ? '🔥 Tous les soldes' : q ? `« ${q} »` : categorie ?? 'Tous les produits'}</h1>
        {r && <p>{r.total} produit{r.total > 1 ? 's' : ''}</p>}
      </div>
      <div className="puces-filtres" role="tablist" aria-label="Trier">
        {TRIS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tri === k} className={tri === k ? 'actif' : ''} onClick={() => maj('tri', k)}>{l}</button>
        ))}
        {categorie && <button className="actif" onClick={() => maj('categorie', null)}>{categorie} ✕</button>}
      </div>
      {erreur ? <Erreur>{erreur}</Erreur> : !r ? <Squelettes n={8} /> : <GrilleProduits produits={r.produits} />}
    </section>
  );
}

/** Rayons : liste des rayons à gauche, produits du rayon à droite (comme un rayon de supermarché). */
export function Rayons() {
  const { nom } = useParams();
  const naviguer = useNavigate();
  const [rayons, setRayons] = useState<string[] | null>(null);
  const [r, setR] = useState<{ total: number; produits: ProduitCarte[] } | null>(null);
  const [erreur, setErreur] = useState('');
  useEffect(() => {
    appeler<DonneesAccueil>('marche_accueil').then((x) => setRayons(x.categories)).catch((e: Error) => setErreur(e.message));
    document.title = 'Rayons — DF Marché';
  }, []);
  const courant = nom ?? null;
  useEffect(() => {
    setR(null);
    appeler<{ total: number; produits: ProduitCarte[] }>('marche_produits', { p_categorie: courant, p_limite: 96 })
      .then(setR)
      .catch((e: Error) => setErreur(e.message));
  }, [courant]);
  if (erreur) return <Erreur>{erreur}</Erreur>;
  return (
    <section className="page-rayons">
      <nav className="liste-rayons" aria-label="Rayons">
        <button className={!courant ? 'actif' : ''} onClick={() => naviguer('/rayons', { replace: true })}><span aria-hidden>🛍️</span>Tout</button>
        {(rayons ?? []).map((c) => (
          <button key={c} className={courant === c ? 'actif' : ''} onClick={() => naviguer(`/rayons/${encodeURIComponent(c)}`, { replace: true })}>
            <span aria-hidden>{rayon(c).emoji}</span>{c}
          </button>
        ))}
      </nav>
      <div className="contenu-rayon">
        <div className="entete-page">
          <h1>{courant ?? 'Tous les rayons'}</h1>
          {r && <p>{r.total} produit{r.total > 1 ? 's' : ''}</p>}
        </div>
        {r ? <GrilleProduits produits={r.produits} /> : <Squelettes n={6} />}
      </div>
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
    <section className="section">
      <div className="entete-page"><h1>Choisissez votre boutique</h1><p>{d.length} boutique{d.length > 1 ? 's' : ''} près de chez vous</p></div>
      <input className="champ-doux" type="search" placeholder="Nom de la boutique, commune…" value={texte} onChange={(e) => setTexte(e.target.value)} aria-label="Chercher une boutique" />
      <div className="puces-filtres">
        <button className={!activite ? 'actif' : ''} onClick={() => setActivite('')}>Toutes</button>
        {activites.map((a) => <button key={a} className={activite === a ? 'actif' : ''} onClick={() => setActivite(a)}>{a}</button>)}
      </div>
      {vues.length ? <div className="grille-boutiques">{vues.map((v) => <CarteBoutique key={v.slug} v={v} />)}</div> : <p className="vide">Aucune boutique.</p>}
    </section>
  );
}

export function Favoris() {
  const favoris = useFavoris();
  useEffect(() => {
    document.title = 'Mes favoris — DF Marché';
  }, []);
  return (
    <section className="section">
      <div className="entete-page"><h1>Mes favoris</h1><p>Gardés sur ce téléphone</p></div>
      {favoris.length ? (
        <GrilleProduits produits={favoris} />
      ) : (
        <div className="etat-vide">
          <p className="grand-emoji" aria-hidden>🤍</p>
          <h2>Pas encore de favoris</h2>
          <p>Touchez le cœur d’un produit pour le retrouver ici.</p>
          <Link className="bouton bouton-principal" to="/">Découvrir les produits</Link>
        </div>
      )}
    </section>
  );
}
