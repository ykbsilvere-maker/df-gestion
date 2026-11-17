import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { A_LA_LIVRAISON, LogoPaiement, moyensEnLigne } from '../paiement';
import { appeler, urlPublique, type FicheBoutique, type FicheProduit, type ProduitCarte, type Vitrine } from '../api';
import {
  BoutonFavori,
  Chargement,
  CompteARebours,
  Disponibilite,
  Erreur,
  Etoiles,
  GrilleProduits,
  ImageProduit,
  LogoBoutique,
  Prix,
  RangeeProduits,
  Squelettes,
  WhatsappFlottant,
  envol,
  fcfa,
  lienWhatsapp,
  remise,
  usePhotos,
} from '../composants';
import { IcoMoins, IcoPartager, IcoPlus, IcoRetour } from '../icones';
import { ajouter, memoriserVu } from '../panier';

const MOYENS: [keyof Vitrine, string, string][] = [
  ['numero_wave', 'Wave', '#1dc8f2'],
  ['numero_orange', 'Orange Money', '#ff7900'],
  ['numero_mtn', 'MTN MoMo', '#ffcb05'],
  ['numero_moov', 'Moov Money', '#0066b3'],
];

export function MoyensAcceptes({ v }: { v: Vitrine }) {
  return (
    <ul className="moyens">
      {v.paiement_livraison && <li style={{ borderColor: '#555' }}>💵 À la livraison</li>}
      {MOYENS.filter(([k]) => v[k]).map(([k, l, c]) => <li key={k} style={{ borderColor: c }}>{l}</li>)}
    </ul>
  );
}

export function Carte({ v }: { v: Pick<Vitrine, 'latitude' | 'longitude' | 'nom'> }) {
  if (v.latitude == null || v.longitude == null) return null;
  const la = Number(v.latitude);
  const lo = Number(v.longitude);
  return (
    <>
      <iframe
        className="carte-osm"
        title={`Localisation de ${v.nom}`}
        loading="lazy"
        src={`https://www.openstreetmap.org/export/embed.html?bbox=${lo - 0.006},${la - 0.004},${lo + 0.006},${la + 0.004}&layer=mapnik&marker=${la},${lo}`}
      />
      <a className="bouton" href={`https://www.google.com/maps/dir/?api=1&destination=${la},${lo}`} target="_blank" rel="noreferrer">🧭 Itinéraire</a>
    </>
  );
}

export function Boutique() {
  const { slug } = useParams();
  const [v, setV] = useState<FicheBoutique | null>(null);
  const [produits, setProduits] = useState<ProduitCarte[] | null>(null);
  const [categorie, setCategorie] = useState<string | null>(null);
  const [texte, setTexte] = useState('');
  const [onglet, setOnglet] = useState<'produits' | 'infos' | 'avis'>('produits');
  const [erreur, setErreur] = useState('');
  useEffect(() => {
    appeler<FicheBoutique>('marche_boutique', { p_slug: slug })
      .then((b) => {
        setV(b);
        document.title = `${b.nom} — DF Marché`;
      })
      .catch((e: Error) => setErreur(e.message));
    appeler<{ produits: ProduitCarte[] }>('marche_produits', { p_boutique: slug, p_limite: 96 })
      .then((r) => setProduits(r.produits))
      .catch((e: Error) => setErreur(e.message));
  }, [slug]);
  const vus = useMemo(() => {
    const t = texte.trim().toLowerCase();
    return (produits ?? []).filter((p) => (!categorie || p.categorie === categorie) && (!t || p.designation.toLowerCase().includes(t)));
  }, [produits, categorie, texte]);
  if (erreur) return <Erreur>{erreur}</Erreur>;
  if (!v) return <Chargement />;
  const couverture = urlPublique('vitrines', v.photos[0]);
  const wa = v.whatsapp ?? v.telephone;
  return (
    <>
      <section className="tete-boutique" style={couverture ? { backgroundImage: `linear-gradient(180deg, rgba(0,0,0,.05), rgba(0,0,0,.72)), url(${couverture})` } : undefined}>
        <LogoBoutique v={v} />
        <div>
          <h1>{v.nom}</h1>
          {v.slogan && <p className="slogan">{v.slogan}</p>}
          <p className="tete-meta">
            {[v.activite, [v.commune, v.ville].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
            {v.note ? <> · <Etoiles note={v.note} avis={v.avis} taille="petite" /></> : null}
            {v.commandes > 0 && <> · {v.commandes} commande{v.commandes > 1 ? 's' : ''} livrée{v.commandes > 1 ? 's' : ''}</>}
          </p>
        </div>
        <div className="tete-actions">
          {wa && <a className="bouton bouton-whatsapp" href={lienWhatsapp(wa, `Bonjour ${v.nom}, je vous écris depuis DF Marché.`)} target="_blank" rel="noreferrer">WhatsApp</a>}
          {v.telephone && <a className="bouton bouton-verre" href={`tel:${v.telephone.replace(/\s/g, '')}`}>📞 Appeler</a>}
        </div>
      </section>
      <WhatsappFlottant tel={wa} message={`Bonjour ${v.nom}, je vous écris depuis DF Marché.`} />
      <div className="bandeau-infos">
        <span>{v.livraison ? `🛵 Livraison${v.zones?.length ? ` dès ${fcfa(Math.min(...v.zones.map((z) => Number(z.frais))))}` : ''}` : '🏪 Retrait seulement'}</span>
        {v.retrait && v.livraison && <span>🏪 Retrait gratuit</span>}
        <span>⏱️ Prêt en {v.delai_preparation} h</span>
        {v.horaires && <span>🕗 {v.horaires}</span>}
        {v.commande_minimum > 0 && <span>Minimum {fcfa(v.commande_minimum)}</span>}
      </div>
      <nav className="onglets-boutique" role="tablist">
        <button role="tab" aria-selected={onglet === 'produits'} className={onglet === 'produits' ? 'actif' : ''} onClick={() => setOnglet('produits')}>Produits ({v.produits})</button>
        <button role="tab" aria-selected={onglet === 'infos'} className={onglet === 'infos' ? 'actif' : ''} onClick={() => setOnglet('infos')}>Présentation et accès</button>
        <button role="tab" aria-selected={onglet === 'avis'} className={onglet === 'avis' ? 'actif' : ''} onClick={() => setOnglet('avis')}>Avis ({v.avis})</button>
      </nav>
      {onglet === 'produits' && (
        <section className="rayon">
          <div className="filtres">
            <input type="search" placeholder={`Chercher chez ${v.nom}…`} value={texte} onChange={(e) => setTexte(e.target.value)} />
          </div>
          {v.categories.length > 1 && (
            <nav className="puces-categories">
              <button className={!categorie ? 'actif' : ''} onClick={() => setCategorie(null)}>Tout</button>
              {v.categories.map((c) => <button key={c} className={categorie === c ? 'actif' : ''} onClick={() => setCategorie(c)}>{c}</button>)}
            </nav>
          )}
          {produits ? <GrilleProduits produits={vus} sansBoutique /> : <Squelettes n={6} />}
        </section>
      )}
      {onglet === 'infos' && (
        <div className="infos-boutique">
          <section className="bloc">
            <h2>À propos</h2>
            {v.description ? v.description.split('\n').map((l, i) => <p key={i}>{l}</p>) : <p className="secondaire">—</p>}
            {v.photos.length > 1 && (
              <div className="galerie">{v.photos.map((p) => <img key={p} src={urlPublique('vitrines', p)!} alt="" loading="lazy" />)}</div>
            )}
          </section>
          <section className="bloc">
            <h2>Où nous trouver</h2>
            <p>{[v.adresse, v.commune, v.ville].filter(Boolean).join(', ')}</p>
            {v.horaires && <p>🕗 {v.horaires}</p>}
            <Carte v={v} />
            <h2>Contact</h2>
            <p>
              {v.telephone && <>📞 <a href={`tel:${v.telephone}`}>{v.telephone}</a><br /></>}
              {v.whatsapp && <>💬 <a href={lienWhatsapp(v.whatsapp, `Bonjour ${v.nom}`)} target="_blank" rel="noreferrer">{v.whatsapp}</a><br /></>}
              {v.email && <>✉️ <a href={`mailto:${v.email}`}>{v.email}</a></>}
            </p>
          </section>
          <section className="bloc">
            <h2>Livraison</h2>
            {v.livraison && v.zones?.length ? (
              <table className="zones"><tbody>
                {v.zones.map((z) => <tr key={z.id}><td>{z.nom}</td><td>{fcfa(z.frais)}</td><td className="secondaire">{z.delai ?? ''}</td></tr>)}
              </tbody></table>
            ) : <p>Pas de livraison : retrait à la boutique.</p>}
            {v.retrait && <p>🏪 Retrait gratuit en boutique.</p>}
            <h2>Paiement accepté</h2>
            <MoyensAcceptes v={v} />
          </section>
        </div>
      )}
      {onglet === 'avis' && (
        <section className="bloc">
          {v.derniers_avis.length ? <ListeAvis avis={v.derniers_avis} /> : <p className="vide">Pas encore d’avis : soyez le premier après votre commande.</p>}
        </section>
      )}
    </>
  );
}

export function ListeAvis({ avis }: { avis: FicheProduit['avis_liste'] }) {
  return (
    <ul className="liste-avis">
      {avis.map((a, i) => (
        <li key={i}>
          <div><Etoiles note={a.note} taille="petite" /> <strong>{a.auteur}</strong> <span className="secondaire">· {new Date(a.date).toLocaleDateString('fr-FR')}{a.produit ? ` · ${a.produit}` : ''}</span></div>
          {a.commentaire && <p>{a.commentaire}</p>}
          <span className="verifie">✓ Achat vérifié</span>
        </li>
      ))}
    </ul>
  );
}

export function Produit() {
  const { id } = useParams();
  const naviguer = useNavigate();
  const [p, setP] = useState<FicheProduit | null>(null);
  const [q, setQ] = useState(1);
  const [erreur, setErreur] = useState('');
  useEffect(() => {
    setP(null);
    setQ(1);
    appeler<FicheProduit>('marche_produit', { p_id: id })
      .then((x) => {
        setP(x);
        memoriserVu(x);
        document.title = `${x.designation} — ${x.vitrine.nom} — DF Marché`;
      })
      .catch((e: Error) => setErreur(e.message));
  }, [id]);
  const urls = usePhotos(p ? [p.photo] : []);
  if (erreur) return <Erreur>{erreur}</Erreur>;
  if (!p) return <Chargement />;
  const dispo = Number(p.disponible);
  const r = remise(p);
  const v = p.vitrine;
  const wa = v.whatsapp ?? v.telephone;
  function partager() {
    const lien = window.location.href;
    if (navigator.share) void navigator.share({ title: p!.designation, text: `${p!.designation} à ${fcfa(p!.prix)} chez ${v.nom}`, url: lien }).catch(() => undefined);
    else void navigator.clipboard?.writeText(lien);
  }
  return (
    <div className="page-produit">
      <section className="fiche-produit">
        <div className="fiche-image">
          <ImageProduit url={p.photo ? urls[p.photo] : undefined} alt={p.designation} categorie={p.categorie} grande />
          <button className="rond-flottant retour" onClick={() => (window.history.length > 1 ? naviguer(-1) : naviguer('/'))} aria-label="Retour"><IcoRetour /></button>
          <div className="actions-image">
            <button className="rond-flottant" onClick={partager} aria-label="Partager"><IcoPartager /></button>
            <BoutonFavori p={p} flottant />
          </div>
          {r > 0 && <span className="badge-solde grand">−{r}%</span>}
        </div>
        <div className="fiche-texte">
          <p className="fil"><Link to={`/boutique/${v.slug}`}>{v.nom}</Link>{p.categorie && <> · {p.categorie}</>}</p>
          <h1>{p.designation}</h1>
          <div className="fiche-meta">
            <Etoiles note={p.note} avis={p.avis} />
            {p.commandes > 0 && <span>· {p.commandes} commande{p.commandes > 1 ? 's' : ''}</span>}
            {Number(p.vendus ?? 0) >= 3 && <span className="vendus">· 🔥 {Math.round(Number(p.vendus))} vendus ce mois</span>}
            {p.arrivage && <span className="badge-arrivage en-ligne">Nouvel arrivage</span>}
          </div>
          <div className="ligne-prix">
            <Prix p={p} grand />
            {dispo > 0 && (
              <div className="quantite" aria-label="Quantité">
                <button onClick={() => setQ((x) => Math.max(1, x - 1))} aria-label="Moins"><IcoMoins /></button>
                <span>{q}</span>
                <button onClick={() => setQ((x) => Math.min(dispo, x + 1))} aria-label="Plus"><IcoPlus /></button>
              </div>
            )}
          </div>
          {r > 0 && p.solde_fin && (
            <div className="encart-solde">🔥 Vous économisez <b>{fcfa(Number(p.prix_normal) - Number(p.prix))}</b> <CompteARebours fin={p.solde_fin} /></div>
          )}
          <Disponibilite d={dispo} unite={p.unite} />
          {p.description && <div className="description">{p.description.split('\n').map((l, i) => <p key={i}>{l}</p>)}</div>}
          <div className="barre-achat">
            <button className="bouton bouton-principal large" disabled={dispo <= 0} onClick={(e) => { envol(e.currentTarget); ajouter(p, q); }}>
              {dispo <= 0 ? 'Indisponible' : <>Ajouter au panier · {fcfa(Number(p.prix) * q)}</>}
            </button>
          </div>
          <div className="paiements-acceptes">
            <span>Paiement</span>
            {moyensEnLigne(v).map((m) => <LogoPaiement key={m.code} m={m} taille={28} />)}
            {v.paiement_livraison && <LogoPaiement m={A_LA_LIVRAISON} taille={28} />}
            <small>{[...moyensEnLigne(v).map((m) => m.libelle), ...(v.paiement_livraison ? ['à la livraison'] : [])].join(' · ')}</small>
          </div>
          <Link to={`/boutique/${v.slug}`} className="encart-boutique">
            <LogoBoutique v={v} />
            <span>
              <strong>Vendu par {v.nom}</strong>
              <small>{[v.commune, v.ville].filter(Boolean).join(', ')} · {v.livraison ? '🛵 livraison' : ''}{v.livraison && v.retrait ? ' ou ' : ''}{v.retrait ? '🏪 retrait' : ''} · prêt en {v.delai_preparation} h</small>
            </span>
          </Link>
          <MoyensAcceptes v={v} />
        </div>
      </section>
      <section className="bloc">
        <h2>Avis clients</h2>
        {p.avis_liste.length ? <ListeAvis avis={p.avis_liste} /> : <p className="secondaire">Pas encore d’avis. Les avis sont réservés aux clients qui ont reçu le produit.</p>}
      </section>
      {p.similaires.length > 0 && (
        <section className="section"><div className="titre-rayon"><h2>Vous aimerez aussi</h2></div><RangeeProduits produits={p.similaires} sansBoutique /></section>
      )}
      <WhatsappFlottant tel={wa} message={`Bonjour ${v.nom}, une question sur « ${p.designation} » (${fcfa(p.prix)}) vu sur DF Marché : `} />
    </div>
  );
}
