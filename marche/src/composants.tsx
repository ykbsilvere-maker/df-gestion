import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, useNavigate, useSearchParams } from 'react-router-dom';
import { urlPublique, urlsPhotos, type ProduitCarte, type Vitrine } from './api';
import { ajouter, nombreArticles, usePanier } from './panier';

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
  return (
    <div className={`image-produit ${grande ? 'grande' : ''}`}>
      {url ? <img src={url} alt={alt} loading="lazy" /> : <span aria-hidden>🛍️</span>}
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

export function CompteARebours({ fin, court }: { fin: string; court?: boolean }) {
  const [maintenant, setMaintenant] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setMaintenant(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const reste = Math.max(0, finSolde(fin).getTime() - maintenant);
  const j = Math.floor(reste / 86400000);
  const h = Math.floor((reste % 86400000) / 3600000);
  const m = Math.floor((reste % 3600000) / 60000);
  const s = Math.floor((reste % 60000) / 1000);
  const deux = (x: number) => String(x).padStart(2, '0');
  if (reste === 0) return <span className="rebours fini">Solde terminé</span>;
  return (
    <span className="rebours" aria-label={`Fin du solde dans ${j} jours ${h} heures ${m} minutes`}>
      {!court && 'Se termine dans '}
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
      {r > 0 && <><s>{fcfa(p.prix_normal)}</s><em>−{r} %</em></>}
    </span>
  );
}

export function Disponibilite({ d, unite }: { d: number; unite?: string }) {
  const n = Number(d);
  if (n <= 0) return <span className="dispo rupture">Rupture de stock</span>;
  if (n <= 3) return <span className="dispo peu">Plus que {n} {unite && unite !== 'pièce' ? unite : ''} en stock</span>;
  return <span className="dispo ok">En stock{n < 50 ? ` : ${n}` : ''}</span>;
}

export function Chargement() {
  return <div className="chargement" aria-live="polite"><span /><span /><span /></div>;
}

export function Erreur({ children, reessayer }: { children: ReactNode; reessayer?: () => void }) {
  return (
    <div className="erreur" role="alert">
      <p>{children}</p>
      {reessayer && <button className="bouton" onClick={reessayer}>Réessayer</button>}
    </div>
  );
}

/* ---------- Cartes ---------- */

export function CarteProduit({ p, url, sansBoutique }: { p: ProduitCarte; url: string | undefined; sansBoutique?: boolean }) {
  const [ajoute, setAjoute] = useState(false);
  const r = remise(p);
  return (
    <article className="carte-produit">
      <Link to={`/produit/${p.id}`} className="carte-produit-lien">
        <ImageProduit url={url} alt={p.designation} />
        {r > 0 && <span className="badge-solde">−{r} %</span>}
        {Number(p.disponible) <= 0 && <span className="badge-rupture">Rupture</span>}
        <h3>{p.designation}</h3>
      </Link>
      <Prix p={p} />
      {p.solde_fin && r > 0 && <CompteARebours fin={p.solde_fin} court />}
      <div className="carte-produit-meta">
        {p.note ? <Etoiles note={p.note} avis={p.avis} taille="petite" /> : null}
        {p.commandes > 0 && <span>{p.commandes} commande{p.commandes > 1 ? 's' : ''}</span>}
      </div>
      {!sansBoutique && (
        <Link to={`/boutique/${p.boutique.slug}`} className="carte-produit-boutique">🏪 {p.boutique.nom}{p.boutique.commune ? ` · ${p.boutique.commune}` : ''}</Link>
      )}
      <button
        className="bouton bouton-panier"
        disabled={Number(p.disponible) <= 0}
        onClick={() => {
          ajouter(p);
          setAjoute(true);
          window.setTimeout(() => setAjoute(false), 1400);
        }}
      >
        {Number(p.disponible) <= 0 ? 'Indisponible' : ajoute ? '✓ Ajouté' : '+ Panier'}
      </button>
    </article>
  );
}

export function GrilleProduits({ produits, sansBoutique }: { produits: ProduitCarte[]; sansBoutique?: boolean }) {
  const urls = usePhotos(produits.map((p) => p.photo));
  if (!produits.length) return <p className="vide">Aucun produit pour le moment.</p>;
  return (
    <div className="grille-produits">
      {produits.map((p) => (
        <CarteProduit key={p.id} p={p} url={p.photo ? urls[p.photo] : undefined} sansBoutique={sansBoutique} />
      ))}
    </div>
  );
}

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
        <LogoBoutique v={v} />
      </div>
      <div className="carte-boutique-texte">
        <h3>{v.nom}</h3>
        <p>{[v.activite, v.commune ?? v.ville].filter(Boolean).join(' · ')}</p>
        <div className="carte-boutique-meta">
          {v.note ? <Etoiles note={v.note} avis={v.avis} taille="petite" /> : <span className="nouveau">Nouveau</span>}
          <span>{v.produits} produit{v.produits > 1 ? 's' : ''}</span>
          {v.livraison && <span>🛵 Livraison</span>}
        </div>
      </div>
    </Link>
  );
}

/* ---------- Bannière des soldes (page d'accueil) ---------- */

export function BanniereSoldes({ soldes }: { soldes: ProduitCarte[] }) {
  const [i, setI] = useState(0);
  const urls = usePhotos(soldes.slice(0, 8).map((p) => p.photo));
  useEffect(() => {
    if (soldes.length < 2) return;
    const id = window.setInterval(() => setI((x) => (x + 1) % Math.min(8, soldes.length)), 6000);
    return () => window.clearInterval(id);
  }, [soldes.length]);
  if (!soldes.length) return null;
  const affiches = soldes.slice(0, 8);
  return (
    <section className="banniere-soldes" aria-label="Soldes en cours" aria-roledescription="carrousel">
      {affiches.map((p, k) => (
        <Link key={p.id} to={`/produit/${p.id}`} className={`affiche ${k === i ? 'active' : ''}`} aria-hidden={k !== i} tabIndex={k === i ? 0 : -1}>
          <div className="affiche-texte">
            <span className="affiche-etiquette">🔥 SOLDE −{remise(p)} %</span>
            <h2>{p.designation}</h2>
            <p className="affiche-boutique">chez {p.boutique.nom}{p.boutique.commune ? `, ${p.boutique.commune}` : ''}</p>
            <Prix p={p} grand />
            {p.solde_fin && <p className="affiche-rebours"><CompteARebours fin={p.solde_fin} /></p>}
            <span className="bouton bouton-blanc">J’en profite →</span>
          </div>
          <div className="affiche-image">
            {p.photo && urls[p.photo] ? <img src={urls[p.photo]} alt="" /> : <span aria-hidden>🏷️</span>}
          </div>
        </Link>
      ))}
      {affiches.length > 1 && (
        <div className="affiche-points">
          {affiches.map((p, k) => (
            <button key={p.id} className={k === i ? 'actif' : ''} onClick={() => setI(k)} aria-label={`Solde ${k + 1}`} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------- En-tête et pied ---------- */

export function EnTete() {
  const panier = usePanier();
  const n = nombreArticles(panier);
  const naviguer = useNavigate();
  const [params] = useSearchParams();
  const [texte, setTexte] = useState(params.get('q') ?? '');
  function chercher(e: FormEvent) {
    e.preventDefault();
    naviguer(`/recherche?q=${encodeURIComponent(texte.trim())}`);
  }
  return (
    <header className="entete">
      <div className="entete-ligne">
        <Link to="/" className="marque" aria-label="DF Marché, accueil">
          <img src="/icone-marche.svg" alt="" width={36} height={36} />
          <span>DF <b>Marché</b></span>
        </Link>
        <form className="recherche" role="search" onSubmit={chercher}>
          <input type="search" value={texte} onChange={(e) => setTexte(e.target.value)} placeholder="Riz, téléphone, pagne, boutique…" aria-label="Rechercher" />
          <button aria-label="Chercher">🔎</button>
        </form>
        <Link to="/panier" className="lien-panier" aria-label={`Panier : ${n} article(s)`}>
          🛒{n > 0 && <span className="compteur">{n}</span>}
        </Link>
      </div>
      <nav className="entete-nav">
        <NavLink to="/" end>Accueil</NavLink>
        <NavLink to="/soldes">🔥 Soldes</NavLink>
        <NavLink to="/boutiques">Boutiques</NavLink>
        <NavLink to="/mes-commandes">Mes commandes</NavLink>
      </nav>
    </header>
  );
}

export function Pied() {
  return (
    <footer className="pied">
      <div>
        <strong>DF Marché</strong>
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
    </footer>
  );
}
