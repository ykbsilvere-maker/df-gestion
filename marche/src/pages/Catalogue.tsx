import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { appeler, type Accueil as DonneesAccueil, type ProduitCarte, type Vitrine } from '../api';
import {
  AppelPanier,
  BandeauxPromo,
  BanniereSoldes,
  CarteBoutique,
  Defilant,
  HeroFrais,
  OngletsRayons,
  Chargement,
  Erreur,
  GrilleProduits,
  Rangee,
  Squelettes,
  TitreRayon,
  VentesFlash,
  rayon,
  salutation,
  sansDoublon,
} from '../composants';
import { useCompte } from '../compte';
import { definirBoutiques, useBoutiqueUnique } from '../unique';
import { IcoBoutique, IcoCoeur, IcoFlamme, IcoRecommander, IcoSuivi } from '../icones';
import { mesCommandes, useFavoris, vusRecemment } from '../panier';


/** Page d'accueil : affiches des soldes, raccourcis, ventes flash, rayons, boutiques, populaires, nouveautés. */
export function Accueil() {
  const { compte } = useCompte();
  const unique = useBoutiqueUnique();
  const [d, setD] = useState<DonneesAccueil | null>(null);
  const [erreur, setErreur] = useState('');
  const charger = useCallback(() => {
    setErreur('');
    appeler<DonneesAccueil>('marche_accueil').then((x) => { definirBoutiques(x.boutiques); setD(x); }).catch((e: Error) => setErreur(e.message));
  }, []);
  useEffect(() => {
    charger();
    document.title = 'DF Marché — les boutiques près de chez vous';
  }, [charger]);
  if (erreur) return <Erreur reessayer={charger}>{erreur}</Erreur>;
  if (!d) return <Chargement />;
  const flash = [...d.soldes].sort((a, b) => (a.solde_fin ?? '9').localeCompare(b.solde_fin ?? '9'));
  const derniere = mesCommandes()[0];
  const vus = vusRecemment();
  const tous = sansDoublon([d.populaires, d.soldes, d.nouveautes, d.arrivages]);
  const selection = sansDoublon([d.arrivages, d.soldes, d.populaires, d.nouveautes]).slice(0, 10);
  const livraison = d.boutiques.some((v) => v.livraison);
  return (
    <>
      <HeroFrais
        produits={sansDoublon([d.soldes, d.populaires, d.nouveautes])}
        etiquette={unique ? `🏪 ${unique.nom}${unique.commune ? ` · ${unique.commune}` : ''}` : undefined}
        titre={unique
          ? <>{unique.slogan || 'Vos courses'}, <em>{unique.livraison ? 'livrées' : 'prêtes'}</em>{unique.livraison ? ' ou prêtes au retrait.' : ' au retrait en boutique.'}</>
          : <>Les boutiques de votre quartier, <em>livrées</em> ou prêtes au retrait.</>}
        texte={unique
          ? `${salutation()} 👋 Stock en direct, prix de la boutique, paiement Wave, Orange Money ou en espèces.`
          : `${salutation()} 👋 Stock réel, prix des boutiques, paiement Wave, Orange Money ou en espèces.`}
        lien={{ vers: '/rayons', libelle: 'Découvrir les produits' }}
      />

      {/* Comme sur les grands sites : les ventes flash et les offres juste sous la bannière. */}
      <VentesFlash soldes={flash} />

      <BandeauxPromo soldes={d.soldes} livraison={livraison} />

      <nav className="raccourcis revele" aria-label="Raccourcis">
        <Link to="/soldes"><span className="rond orange"><IcoFlamme /></span>Promos</Link>
        {unique ? (
          <Link to={`/boutique/${unique.slug}`}><span className="rond"><IcoBoutique /></span>La boutique</Link>
        ) : (
          <Link to="/boutiques"><span className="rond"><IcoBoutique /></span>Boutiques</Link>
        )}
        <Link to={derniere ? `/suivi/${derniere.code}` : '/mes-commandes'}><span className="rond"><IcoSuivi /></span>Suivi</Link>
        <Link to="/compte/commandes"><span className="rond"><IcoRecommander /></span>Recommander</Link>
        <Link to="/compte/bons"><span className="rond orange" aria-hidden>🎟️</span>Bons d’achat</Link>
        <Link to="/favoris"><span className="rond rose"><IcoCoeur /></span>Favoris</Link>
      </nav>

      {selection.length > 0 && (
        <section className="section bloc-blanc revele">
          <TitreRayon titre="La sélection du jour" sous="Arrivages, soldes et produits les plus demandés" lien={{ vers: '/recherche?tri=nouveautes' }} />
          <GrilleProduits produits={selection} />
        </section>
      )}

      {d.soldes.length > 0 && (
        <div className="revele">
          <BanniereSoldes soldes={d.soldes} />
        </div>
      )}

      <OngletsRayons titre="Meilleures ventes de la semaine" produits={tous} lien={{ vers: '/rayons' }} />

      <Defilant produits={tous} />

      {d.categories.length > 0 && (
        <section className="section revele">
          <TitreRayon titre="Nos rayons" lien={{ vers: '/rayons' }} />
          <nav className="bulles-rayons" aria-label="Rayons">
            <Link to="/rayons" className="bulle-rayon tout"><span aria-hidden>🛍️</span><strong>Tout</strong></Link>
            {d.categories.map((c) => {
              const r = rayon(c);
              return (
                <Link key={c} to={`/rayons/${encodeURIComponent(c)}`} className="bulle-rayon" style={{ ['--teinte-rayon' as string]: r.teinte }}>
                  <span aria-hidden>{r.emoji}</span>
                  <strong>{c}</strong>
                </Link>
              );
            })}
          </nav>
        </section>
      )}


      {(vus.length > 0 || d.nouveautes.length > 0) && (
        <section className="section bloc-blanc revele">
          <TitreRayon titre={vus.length ? 'Juste pour vous' : 'Nouveautés'} sous={vus.length ? 'Reprenez là où vous vous étiez arrêté' : undefined} lien={{ vers: '/recherche?tri=nouveautes' }} />
          <GrilleProduits produits={(vus.length ? vus : d.nouveautes).slice(0, 10)} />
        </section>
      )}

      {!unique && <section className="section revele">
        <TitreRayon titre="Nos boutiques" sous="Tous leurs produits sont déjà sur cette page" lien={{ vers: '/boutiques', libelle: 'Toutes' }} />
        {d.boutiques.length ? (
          <Rangee large>{d.boutiques.map((v) => <CarteBoutique key={v.slug} v={v} />)}</Rangee>
        ) : (
          <p className="vide">Les premières boutiques arrivent bientôt.</p>
        )}
      </section>}

      <section className="section comment-ca-marche revele">
        <TitreRayon titre="Commander en 4 étapes" sous="Simple, rapide et sûr" />
        <ol className="etapes-accueil">
          <li><span aria-hidden>🛍️</span><strong>Choisir</strong><small>Ajoutez vos produits au panier</small></li>
          <li><span aria-hidden>📝</span><strong>Commander</strong><small>Retrait en boutique ou livraison</small></li>
          <li><span aria-hidden>📲</span><strong>Payer</strong><small>Wave, Orange Money ou à la remise</small></li>
          <li><span aria-hidden>🎁</span><strong>Recevoir</strong><small>Suivi en direct et reçu téléchargeable</small></li>
        </ol>
      </section>

      <AppelPanier produits={tous} connecte={!!compte} />

      <section className="garanties revele">
        <div><span aria-hidden>📦</span><strong>Stock en direct</strong><p>Ce qui s’affiche est en rayon : la boutique met à jour depuis sa caisse.</p></div>
        <div><span aria-hidden>🛵</span><strong>Livraison ou retrait</strong><p>Choisissez votre zone et l’heure qui vous arrange.</p></div>
        <div><span aria-hidden>📲</span><strong>Paiement Mobile Money</strong><p>Payez la boutique en un geste depuis votre appli, ou en espèces. Reçu téléchargeable avec la référence.</p></div>
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

/** Recherche dans tout le marché, avec filtres ; « /soldes » = la même page filtrée sur les soldes. */
export function Recherche({ soldes }: { soldes?: boolean }) {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const categorie = params.get('categorie');
  const tri = params.get('tri') ?? 'pertinence';
  const [r, setR] = useState<{ total: number; produits: ProduitCarte[] } | null>(null);
  const [erreur, setErreur] = useState('');
  const [f, setF] = useState({ stock: false, note: false, promo: false, min: '', max: '', boutique: '' });
  const [ouvert, setOuvert] = useState(false);
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
  const boutiques = useMemo(() => [...new Map((r?.produits ?? []).map((p) => [p.boutique.slug, p.boutique.nom])).entries()], [r]);
  const vus = useMemo(() => {
    const min = Number(f.min.replace(/\D/g, '')) || 0;
    const max = Number(f.max.replace(/\D/g, '')) || Infinity;
    return (r?.produits ?? []).filter(
      (p) =>
        (!f.stock || Number(p.disponible) > 0) && (!f.note || Number(p.note ?? 0) >= 4) && (!f.promo || Number(p.prix) < Number(p.prix_normal)) &&
        Number(p.prix) >= min && Number(p.prix) <= max && (!f.boutique || p.boutique.slug === f.boutique),
    );
  }, [r, f]);
  const actifs = [f.stock, f.note, f.promo, f.min, f.max, f.boutique].filter(Boolean).length;
  return (
    <section className="page-recherche">
      <aside className={`filtres-panneau ${ouvert ? 'ouvert' : ''}`} aria-label="Filtres">
        <div className="filtres-tete">
          <strong>Filtres</strong>
          {actifs > 0 && <button className="bouton-lien" onClick={() => setF({ stock: false, note: false, promo: false, min: '', max: '', boutique: '' })}>Tout effacer</button>}
        </div>
        <label className="case-filtre"><input type="checkbox" checked={f.stock} onChange={(e) => setF({ ...f, stock: e.target.checked })} /> En stock seulement</label>
        {!soldes && <label className="case-filtre"><input type="checkbox" checked={f.promo} onChange={(e) => setF({ ...f, promo: e.target.checked })} /> 🔥 En solde</label>}
        <label className="case-filtre"><input type="checkbox" checked={f.note} onChange={(e) => setF({ ...f, note: e.target.checked })} /> <b className="etoile">★★★★</b> et plus</label>
        <strong>Prix (F)</strong>
        <div className="filtre-prix">
          <input inputMode="numeric" placeholder="Min" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} aria-label="Prix minimum" />
          <span>–</span>
          <input inputMode="numeric" placeholder="Max" value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} aria-label="Prix maximum" />
        </div>
        {boutiques.length > 1 && (
          <>
            <strong>Boutique</strong>
            <label className="case-filtre"><input type="radio" name="boutique" checked={!f.boutique} onChange={() => setF({ ...f, boutique: '' })} /> Toutes</label>
            {boutiques.map(([slug, nom]) => (
              <label key={slug} className="case-filtre"><input type="radio" name="boutique" checked={f.boutique === slug} onChange={() => setF({ ...f, boutique: slug })} /> {nom}</label>
            ))}
          </>
        )}
        <button className="bouton bouton-principal large voir-resultats" onClick={() => setOuvert(false)}>Voir {vus.length} produit{vus.length > 1 ? 's' : ''}</button>
      </aside>
      {ouvert && <div className="voile" onClick={() => setOuvert(false)} />}
      <div>
        <div className="entete-page">
          <h1>{soldes ? '🔥 Tous les soldes' : q ? `« ${q} »` : categorie ?? 'Tous les produits'}</h1>
          {r && <p>{vus.length} produit{vus.length > 1 ? 's' : ''}</p>}
        </div>
        <div className="puces-filtres" role="tablist" aria-label="Trier">
          <button className={`bouton-filtres ${actifs ? 'actif' : ''}`} onClick={() => setOuvert(true)}>⚙ Filtres{actifs ? ` (${actifs})` : ''}</button>
          {TRIS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tri === k} className={tri === k ? 'actif' : ''} onClick={() => maj('tri', k)}>{l}</button>
          ))}
          {categorie && <button className="actif" onClick={() => maj('categorie', null)}>{categorie} ✕</button>}
        </div>
        {erreur ? <Erreur>{erreur}</Erreur> : !r ? <Squelettes n={8} /> : vus.length ? <GrilleProduits produits={vus} /> : <p className="vide">Aucun produit avec ces filtres.</p>}
      </div>
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
  // Une seule boutique : on va directement chez elle.
  if (d.length === 1) return <Navigate to={`/boutique/${d[0]!.slug}`} replace />;
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
