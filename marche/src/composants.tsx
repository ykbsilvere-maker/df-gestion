import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { urlPublique, urlsPhotos, type ProduitCarte, type Vitrine } from './api';
import { ajouter, basculerFavori, nombreArticles, useAnnonces, useFavoris, usePanier } from './panier';
import {
  IcoAccueil,
  IcoCoeur,
  IcoCommandes,
  IcoFleche,
  IcoPanier,
  IcoPlus,
  IcoRayons,
  IcoRecherche,
  IcoWhatsapp,
} from './icones';

/* ---------- Formats ---------- */

export const fcfa = (v: number | string | null | undefined) =>
  `${Math.round(Number(v ?? 0)).toLocaleString('fr-FR').replace(/ | /g, ' ')} F`;

export const remise = (p: { prix: number; prix_normal: number }) =>
  Number(p.prix) < Number(p.prix_normal) ? Math.round((1 - Number(p.prix) / Number(p.prix_normal)) * 100) : 0;

export function numeroWhatsapp(tel: string | null | undefined): string {
  const c = (tel ?? '').replace(/[^0-9]/g, '');
  return c.length === 10 ? `225${c}` : c;
}
export const lienWhatsapp = (tel: string | null | undefined, message: string) =>
  `https://wa.me/${numeroWhatsapp(tel)}?text=${encodeURIComponent(message)}`;

/** Fin d'un solde : dernier instant du jour de fin (Abidjan = UTC). */
export const finSolde = (date: string) => new Date(`${date.slice(0, 10)}T23:59:59Z`);

export function salutation(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir';
}

/** Pastille d'un rayon : emoji et teinte selon le nom. */
const RAYONS: [RegExp, string, string][] = [
  [/alim|épic|epic|riz|céréal/i, '🍚', '#fff1e6'],
  [/boisson|eau|jus/i, '🥤', '#e8f6fb'],
  [/fruit|légum|legum/i, '🥬', '#eaf7ea'],
  [/viande|bouch|poisson/i, '🍗', '#fdeceb'],
  [/t[ée]l[ée]phon|smartphone/i, '📱', '#eef0fb'],
  [/access|chargeur|écouteur/i, '🎧', '#f1edfb'],
  [/tissu|pagne|wax/i, '🧵', '#fdeef3'],
  [/v[êe]tement|mode|robe/i, '👗', '#fbeef8'],
  [/beaut|cosm/i, '💄', '#fdeef3'],
  [/entretien|ménage|menage|savon/i, '🧼', '#e9f6f3'],
  [/informat|ordinat/i, '💻', '#eef3fb'],
  [/maison|cuisine|déco/i, '🏠', '#f6f1e8'],
];
export function rayon(nom: string): { emoji: string; teinte: string } {
  const r = RAYONS.find(([re]) => re.test(nom));
  return { emoji: r?.[1] ?? '🛍️', teinte: r?.[2] ?? '#f5efe8' };
}

/* ---------- Photos ---------- */

export function usePhotos(chemins: (string | null | undefined)[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const cle = chemins.filter(Boolean).join('|');
  useEffect(() => {
    let actif = true;
    if (cle) void urlsPhotos(cle.split('|')).then((u) => actif && setUrls(u)).catch(() => undefined);
    return () => {
      actif = false;
    };
  }, [cle]);
  return urls;
}

export function ImageProduit({ url, alt, grande }: { url: string | undefined; alt: string; grande?: boolean }) {
  const [chargee, setChargee] = useState(false);
  return (
    <div className={`image-produit ${grande ? 'grande' : ''} ${url && !chargee ? 'en-charge' : ''}`}>
      {url ? <img src={url} alt={alt} loading="lazy" onLoad={() => setChargee(true)} className={chargee ? 'visible' : ''} /> : <span aria-hidden>🛍️</span>}
    </div>
  );
}

/* ---------- Petits éléments ---------- */

export function Etoiles({ note, avis, taille }: { note: number | null; avis?: number; taille?: 'petite' }) {
  if (!note) return avis === 0 ? <span className="etoiles vide">Pas encore d’avis</span> : null;
  const n = Math.round(Number(note) * 2) / 2;
  return (
    <span className={`etoiles ${taille ?? ''}`} aria-label={`${note} sur 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= n ? 'pleine' : i - 0.5 === n ? 'demi' : ''} aria-hidden>★</span>
      ))}
      <small>{Number(note).toLocaleString('fr-FR')}{avis !== undefined && ` (${avis})`}</small>
    </span>
  );
}

export function useMaintenant(pas = 1000) {
  const [t, setT] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setT(Date.now()), pas);
    return () => window.clearInterval(id);
  }, [pas]);
  return t;
}

export function CompteARebours({ fin, court }: { fin: string; court?: boolean }) {
  const maintenant = useMaintenant();
  const reste = Math.max(0, finSolde(fin).getTime() - maintenant);
  const j = Math.floor(reste / 86400000);
  const h = Math.floor((reste % 86400000) / 3600000);
  const m = Math.floor((reste % 3600000) / 60000);
  const s = Math.floor((reste % 60000) / 1000);
  const deux = (x: number) => String(x).padStart(2, '0');
  if (reste === 0) return <span className="rebours fini">Solde terminé</span>;
  return (
    <span className="rebours" aria-label={`Fin du solde dans ${j} jours ${h} heures ${m} minutes`}>
      <span aria-hidden>⏱</span> {!court && 'Fin dans '}
      {j > 0 && <b>{j} j </b>}
      <b>{deux(h)}</b>:<b>{deux(m)}</b>:<b>{deux(s)}</b>
    </span>
  );
}

export function Prix({ p, grand }: { p: { prix: number; prix_normal: number }; grand?: boolean }) {
  const r = remise(p);
  return (
    <span className={`prix ${grand ? 'grand' : ''}`}>
      <strong>{fcfa(p.prix)}</strong>
      {r > 0 && <s>{fcfa(p.prix_normal)}</s>}
    </span>
  );
}

export function Disponibilite({ d, unite }: { d: number; unite?: string }) {
  const n = Number(d);
  if (n <= 0) return <span className="dispo rupture">● Rupture de stock</span>;
  if (n <= 3) return <span className="dispo peu">● Plus que {n} {unite && unite !== 'pièce' ? unite : ''} en stock</span>;
  return <span className="dispo ok">● En stock{n < 50 ? ` · ${n} disponibles` : ''}</span>;
}

export function Squelettes({ n = 6, rangee }: { n?: number; rangee?: boolean }) {
  return (
    <div className={rangee ? 'rangee' : 'grille-produits'} aria-busy="true" aria-label="Chargement">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="carte-produit squelette">
          <div className="image-produit" />
          <span className="ligne-sq" />
          <span className="ligne-sq courte" />
        </div>
      ))}
    </div>
  );
}

export function Chargement() {
  return (
    <div className="page-squelette">
      <div className="bloc-sq haut" />
      <Squelettes n={8} />
    </div>
  );
}

export function Erreur({ children, reessayer }: { children: ReactNode; reessayer?: () => void }) {
  return (
    <div className="erreur" role="alert">
      <p className="grand-emoji" aria-hidden>😕</p>
      <p>{children}</p>
      {reessayer && <button className="bouton" onClick={reessayer}>Réessayer</button>}
    </div>
  );
}

/* ---------- Cartes produits ---------- */

export function BoutonFavori({ p, flottant }: { p: ProduitCarte; flottant?: boolean }) {
  const favoris = useFavoris();
  const actif = favoris.some((x) => x.id === p.id);
  return (
    <button
      type="button"
      className={`bouton-favori ${actif ? 'actif' : ''} ${flottant ? 'flottant' : ''}`}
      aria-pressed={actif}
      aria-label={actif ? 'Retirer des favoris' : 'Ajouter aux favoris'}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        basculerFavori(p);
      }}
    >
      <IcoCoeur plein={actif} />
    </button>
  );
}

/** Une pastille s'envole du bouton vers le panier. */
export function envol(depuis: HTMLElement | null) {
  const cibles = [...document.querySelectorAll<HTMLElement>('.bulle-panier, .action-panier')].filter((e) => e.offsetParent !== null);
  const cible = cibles[0];
  if (!depuis || !cible || typeof depuis.animate !== 'function') return;
  const a = depuis.getBoundingClientRect();
  const b = cible.getBoundingClientRect();
  const p = document.createElement('span');
  p.className = 'envol';
  p.style.left = `${a.left + a.width / 2 - 11}px`;
  p.style.top = `${a.top + a.height / 2 - 11}px`;
  document.body.appendChild(p);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  p.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${dx * 0.5}px, ${Math.min(dy, 0) * 0.5 - 90}px) scale(1.25)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.3)`, opacity: 0.5 },
    ],
    { duration: 650, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  ).onfinish = () => p.remove();
}

export function BoutonAjout({ p }: { p: ProduitCarte }) {
  const [anim, setAnim] = useState(false);
  const indispo = Number(p.disponible) <= 0;
  return (
    <button
      type="button"
      className={`bouton-ajout ${anim ? 'pulse' : ''}`}
      disabled={indispo}
      aria-label={indispo ? 'Indisponible' : `Ajouter ${p.designation} au panier`}
      onClick={(e) => {
        e.preventDefault();
        envol(e.currentTarget);
        ajouter(p);
        setAnim(true);
        window.setTimeout(() => setAnim(false), 500);
      }}
    >
      <IcoPlus />
    </button>
  );
}

export function CarteProduit({ p, url, sansBoutique }: { p: ProduitCarte; url: string | undefined; sansBoutique?: boolean }) {
  const r = remise(p);
  const rupture = Number(p.disponible) <= 0;
  return (
    <article className={`carte-produit ${rupture ? 'en-rupture' : ''}`}>
      <Link to={`/produit/${p.id}`} className="carte-produit-lien">
        <div className="carte-produit-image">
          <ImageProduit url={url} alt={p.designation} />
          {r > 0 && <span className="badge-solde">−{r}%</span>}
          {rupture && <span className="badge-rupture">Rupture</span>}
          {!rupture && p.commandes >= 30 && <span className="badge-top">Meilleure vente</span>}
          <BoutonFavori p={p} />
        </div>
        <h3>{p.designation}</h3>
        {!sansBoutique ? <span className="carte-produit-boutique">{p.boutique.nom}{p.boutique.commune ? ` · ${p.boutique.commune}` : ''}</span> : p.unite !== 'pièce' && <span className="carte-produit-boutique">{p.unite}</span>}
        {(p.note || p.commandes > 0) && (
          <span className="carte-produit-meta">
            {p.note ? <><b className="etoile">★</b> {Number(p.note).toLocaleString('fr-FR')}</> : null}
            {p.note && p.commandes > 0 ? ' · ' : ''}
            {p.commandes > 0 && `${p.commandes} commande${p.commandes > 1 ? 's' : ''}`}
          </span>
        )}
      </Link>
      <div className="carte-produit-pied">
        <Prix p={p} />
        <BoutonAjout p={p} />
      </div>
    </article>
  );
}

export function GrilleProduits({ produits, sansBoutique }: { produits: ProduitCarte[]; sansBoutique?: boolean }) {
  const urls = usePhotos(produits.map((p) => p.photo));
  if (!produits.length) return <p className="vide">Aucun produit pour le moment.</p>;
  return (
    <div className="grille-produits">
      {produits.map((p, i) => (
        <div key={p.id} className="apparition" style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}>
          <CarteProduit p={p} url={p.photo ? urls[p.photo] : undefined} sansBoutique={sansBoutique} />
        </div>
      ))}
    </div>
  );
}

/** Rangée qui défile horizontalement (téléphone : au doigt ; ordinateur : flèches). */
export function Rangee({ children, large }: { children: ReactNode; large?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const defiler = (sens: number) => ref.current?.scrollBy({ left: sens * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  return (
    <div className="rangee-cadre">
      <button type="button" className="rangee-fleche gauche" onClick={() => defiler(-1)} aria-label="Précédent"><span style={{ transform: 'rotate(180deg)', display: 'flex' }}><IcoFleche /></span></button>
      <div className={`rangee ${large ? 'large' : ''}`} ref={ref}>{children}</div>
      <button type="button" className="rangee-fleche droite" onClick={() => defiler(1)} aria-label="Suivant"><IcoFleche /></button>
    </div>
  );
}

export function RangeeProduits({ produits, sansBoutique }: { produits: ProduitCarte[]; sansBoutique?: boolean }) {
  const urls = usePhotos(produits.map((p) => p.photo));
  return (
    <Rangee>
      {produits.map((p) => (
        <CarteProduit key={p.id} p={p} url={p.photo ? urls[p.photo] : undefined} sansBoutique={sansBoutique} />
      ))}
    </Rangee>
  );
}

export function TitreRayon({ titre, lien, sous }: { titre: ReactNode; lien?: { vers: string; libelle?: string }; sous?: ReactNode }) {
  return (
    <div className="titre-rayon">
      <div>
        <h2>{titre}</h2>
        {sous && <p>{sous}</p>}
      </div>
      {lien && <Link to={lien.vers} className="pastille-lien">{lien.libelle ?? 'Voir tout'}</Link>}
    </div>
  );
}

/* ---------- Boutiques ---------- */

export function Monogramme({ nom, couleur }: { nom: string; couleur?: string | null }) {
  const lettres = nom.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((m) => m.length > 1).slice(0, 2).map((m) => m[0]!.toUpperCase()).join('') || '?';
  return <span className="monogramme" style={{ background: couleur && /^#[0-9a-f]{6}$/i.test(couleur) ? couleur : undefined }}>{lettres}</span>;
}

export function LogoBoutique({ v }: { v: Pick<Vitrine, 'logo' | 'nom' | 'couleur'> }) {
  const u = urlPublique('logos', v.logo);
  return u ? <img className="logo-boutique" src={u} alt="" /> : <Monogramme nom={v.nom} couleur={v.couleur} />;
}

export function CarteBoutique({ v }: { v: Vitrine }) {
  const couverture = urlPublique('vitrines', v.photos?.[0]);
  return (
    <Link to={`/boutique/${v.slug}`} className="carte-boutique">
      <div className="carte-boutique-couverture" style={couverture ? { backgroundImage: `url(${couverture})` } : undefined}>
        {v.livraison && <span className="puce-verre">🛵 Livraison</span>}
      </div>
      <div className="carte-boutique-texte">
        <LogoBoutique v={v} />
        <div>
          <h3>{v.nom}</h3>
          <p>{[v.activite, v.commune ?? v.ville].filter(Boolean).join(' · ')}</p>
          <div className="carte-boutique-meta">
            {v.note ? <span><b className="etoile">★</b> {Number(v.note).toLocaleString('fr-FR')} ({v.avis})</span> : <span className="nouveau">Nouveau</span>}
            <span>{v.produits} produit{v.produits > 1 ? 's' : ''}</span>
            <span>Prêt en {v.delai_preparation} h</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

/* ---------- Accueil : affiches des soldes et ventes flash ---------- */

export function BanniereSoldes({ soldes }: { soldes: ProduitCarte[] }) {
  const [i, setI] = useState(0);
  const affiches = soldes.slice(0, 6);
  const urls = usePhotos(affiches.map((p) => p.photo));
  const depart = useRef<number | null>(null);
  useEffect(() => {
    if (affiches.length < 2) return;
    const id = window.setInterval(() => setI((x) => (x + 1) % affiches.length), 5500);
    return () => window.clearInterval(id);
  }, [affiches.length, i]);
  if (!affiches.length) return null;
  return (
    <section
      className="banniere-soldes"
      aria-label="Soldes à l’affiche"
      aria-roledescription="carrousel"
      onTouchStart={(e) => (depart.current = e.touches[0]!.clientX)}
      onTouchEnd={(e) => {
        if (depart.current === null) return;
        const dx = e.changedTouches[0]!.clientX - depart.current;
        if (Math.abs(dx) > 40) setI((x) => (x + (dx < 0 ? 1 : affiches.length - 1)) % affiches.length);
        depart.current = null;
      }}
    >
      <div className="affiches" style={{ transform: `translateX(-${i * 100}%)` }}>
        {affiches.map((p, k) => (
          <Link key={p.id} to={`/produit/${p.id}`} className={`affiche ${k === i ? 'courante' : ''}`} aria-hidden={k !== i} tabIndex={k === i ? 0 : -1}>
            <div className="affiche-image">
              {p.photo && urls[p.photo] ? <img src={urls[p.photo]} alt="" /> : <span aria-hidden>🏷️</span>}
              <span className="affiche-remise">−{remise(p)}%</span>
            </div>
            <div className="affiche-texte">
              <span className="affiche-etiquette">Solde chez {p.boutique.nom}</span>
              <h2>{p.designation}</h2>
              <p className="affiche-prix"><strong>{fcfa(p.prix)}</strong> au lieu de <s>{fcfa(p.prix_normal)}</s></p>
              {p.solde_fin && <CompteARebours fin={p.solde_fin} />}
              <span className="bouton bouton-principal petit">J’en profite</span>
            </div>
          </Link>
        ))}
      </div>
      {affiches.length > 1 && (
        <div className="affiche-points">
          {affiches.map((p, k) => (
            <button key={p.id} className={k === i ? 'actif' : ''} onClick={() => setI(k)} aria-label={`Affiche ${k + 1}`} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Bloc « Ventes flash » : soldes qui finissent le plus tôt, avec le compte à rebours commun. */
export function VentesFlash({ soldes }: { soldes: ProduitCarte[] }) {
  const urls = usePhotos(soldes.map((p) => p.photo));
  if (!soldes.length) return null;
  const fin = [...soldes].map((p) => p.solde_fin).filter((x): x is string => !!x).sort()[0];
  return (
    <section className="ventes-flash">
      <div className="ventes-flash-tete">
        <div>
          <h2><i aria-hidden>⚡</i> Ventes flash</h2>
          {fin && <CompteARebours fin={fin} />}
        </div>
        <Link to="/soldes" className="rond-lien" aria-label="Tous les soldes"><IcoFleche /></Link>
      </div>
      <Rangee>
        {soldes.map((p) => (
          <article key={p.id} className="flash-carte">
            <Link to={`/produit/${p.id}`}>
              <ImageProduit url={p.photo ? urls[p.photo] : undefined} alt={p.designation} />
              <span className="badge-solde">−{remise(p)}%</span>
              <h3>{p.designation}</h3>
            </Link>
            <div className="carte-produit-pied">
              <Prix p={p} />
              <BoutonAjout p={p} />
            </div>
            <div className="jauge" title={`${p.commandes} commandes`}>
              <span style={{ width: `${Math.min(100, 15 + p.commandes * 2)}%` }} />
            </div>
            <small className="jauge-texte">{Number(p.disponible) > 0 ? `${p.disponible} restants` : 'Épuisé'}</small>
          </article>
        ))}
      </Rangee>
    </section>
  );
}

/* ---------- En-tête, onglets, pied ---------- */

export function EnTete() {
  const panier = usePanier();
  const favoris = useFavoris();
  const n = nombreArticles(panier);
  const naviguer = useNavigate();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const [texte, setTexte] = useState(params.get('q') ?? '');
  const [defile, setDefile] = useState(false);
  const [bond, setBond] = useState(false);
  const precedent = useRef(n);
  useEffect(() => {
    const f = () => setDefile(window.scrollY > 8);
    window.addEventListener('scroll', f, { passive: true });
    return () => window.removeEventListener('scroll', f);
  }, []);
  useEffect(() => {
    if (n > precedent.current) {
      setBond(true);
      window.setTimeout(() => setBond(false), 500);
    }
    precedent.current = n;
  }, [n]);
  function chercher(e: FormEvent) {
    e.preventDefault();
    naviguer(`/recherche?q=${encodeURIComponent(texte.trim())}`);
  }
  // Fiche produit sur téléphone : la photo occupe le haut, l'en-tête se fait discret.
  const fiche = pathname.startsWith('/produit/');
  return (
    <header className={`entete ${defile ? 'defile' : ''} ${fiche ? 'sur-fiche' : ''}`}>
      <div className="entete-ligne">
        <Link to="/" className="marque" aria-label="DF Marché, accueil">
          <img src="/icone-marche.svg" alt="" width={34} height={34} />
          <span>DF <b>Marché</b></span>
        </Link>
        <form className="recherche" role="search" onSubmit={chercher}>
          <IcoRecherche />
          <input type="search" value={texte} onChange={(e) => setTexte(e.target.value)} placeholder="Riz, téléphone, pagne, boutique…" aria-label="Rechercher" enterKeyHint="search" />
        </form>
        <nav className="entete-actions" aria-label="Raccourcis">
          <NavLink to="/rayons" className="action-ordi"><IcoRayons /><span>Rayons</span></NavLink>
          <NavLink to="/mes-commandes" className="action-ordi"><IcoCommandes /><span>Commandes</span></NavLink>
          <NavLink to="/favoris" className="action-ordi"><IcoCoeur /><span>Favoris</span>{favoris.length > 0 && <i className="compteur doux">{favoris.length}</i>}</NavLink>
          <NavLink to="/panier" className={`action-panier ${bond ? 'bond' : ''}`} aria-label={`Panier : ${n} article(s)`}>
            <IcoPanier /><span>Panier</span>{n > 0 && <i className="compteur">{n}</i>}
          </NavLink>
        </nav>
      </div>
      <nav className="entete-sous" aria-label="Rubriques">
        <NavLink to="/soldes" className={({ isActive }) => `chaud ${isActive ? 'active' : ''}`}>🔥 Soldes</NavLink>
        <NavLink to="/boutiques">Boutiques</NavLink>
        <NavLink to="/rayons">Rayons</NavLink>
        <Link to="/recherche?tri=nouveautes" className={pathname === '/recherche' && params.get('tri') === 'nouveautes' ? 'active' : ''}>Nouveautés</Link>
        <NavLink to="/mes-commandes">Suivre ma commande</NavLink>
        <NavLink to="/favoris">Favoris</NavLink>
      </nav>
    </header>
  );
}

export function BarreOnglets() {
  const panier = usePanier();
  const favoris = useFavoris();
  const n = nombreArticles(panier);
  return (
    <nav className="barre-onglets" aria-label="Navigation principale">
      <NavLink to="/" end><IcoAccueil /><span>Accueil</span></NavLink>
      <NavLink to="/rayons"><IcoRayons /><span>Rayons</span></NavLink>
      <NavLink to="/panier" className="onglet-panier"><span className="bulle-panier"><IcoPanier />{n > 0 && <i className="compteur">{n}</i>}</span><span>Panier</span></NavLink>
      <NavLink to="/favoris"><IcoCoeur /><span>Favoris</span>{favoris.length > 0 && <i className="point" />}</NavLink>
      <NavLink to="/mes-commandes"><IcoCommandes /><span>Commandes</span></NavLink>
    </nav>
  );
}

export function Annonces() {
  const annonces = useAnnonces();
  return (
    <div className="annonces" aria-live="polite">
      {annonces.map((a) => (
        <div key={a.id} className="annonce">
          <span>{a.texte}</span>
          {a.lien && <Link to={a.lien.vers}>{a.lien.libelle}</Link>}
        </div>
      ))}
    </div>
  );
}

/** Bouton WhatsApp flottant (page d'une boutique ou d'un produit). */
export function WhatsappFlottant({ tel, message }: { tel: string | null | undefined; message: string }) {
  if (!tel) return null;
  return (
    <a className="whatsapp-flottant" href={lienWhatsapp(tel, message)} target="_blank" rel="noreferrer" aria-label="Écrire à la boutique sur WhatsApp">
      <IcoWhatsapp />
    </a>
  );
}

const MESSAGES = ['🛵 Livraison ou retrait en boutique', '💵 Paiement à la livraison', '📲 Wave · Orange Money · MTN · Moov', '📦 Stock en direct depuis la caisse', '⭐ Avis de clients livrés', '🔥 Soldes avec compte à rebours'];

/** Bandeau d'annonces qui défile en haut du site. */
export function Bandeau() {
  return (
    <div className="bandeau-annonces" aria-label="Avantages DF Marché">
      <div className="bandeau-piste">
        {[0, 1].map((k) => (
          <span key={k} aria-hidden={k === 1}>
            {MESSAGES.map((m) => <b key={m}>{m}</b>)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function RetourHaut() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const f = () => setVisible(window.scrollY > 700);
    window.addEventListener('scroll', f, { passive: true });
    return () => window.removeEventListener('scroll', f);
  }, []);
  return (
    <button className={`retour-haut ${visible ? 'visible' : ''}`} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="Revenir en haut" tabIndex={visible ? 0 : -1}>
      <span style={{ transform: 'rotate(-90deg)', display: 'flex' }}><IcoFleche /></span>
    </button>
  );
}

export function Pied() {
  return (
    <footer className="pied">
      <div className="pied-grille">
        <div>
          <Link to="/" className="marque"><img src="/icone-marche.svg" alt="" width={30} height={30} /><span>DF <b>Marché</b></span></Link>
          <p>Les boutiques de votre quartier, en ligne. Stock et prix à jour en direct depuis leur caisse.</p>
        </div>
        <div>
          <strong>Payer en confiance</strong>
          <p>Vous payez directement la boutique : à la livraison, ou par Wave, Orange Money, MTN ou Moov sur son numéro. Ne donnez jamais votre code secret.</p>
        </div>
        <div>
          <strong>Vous êtes commerçant ?</strong>
          <p>Vendez en ligne avec DF Gestion. Intéressé ? Abonnez-vous et laissez-moi un message.</p>
          <p className="propulse"><img src="/logo-decodeur.png" alt="" height={22} /> Propulsé par Le Décodeur Financier</p>
        </div>
      </div>
    </footer>
  );
}
