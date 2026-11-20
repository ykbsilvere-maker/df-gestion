import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { appeler, supabase, erreurLisible, type BonAchat, type FicheBoutique } from '../api';
import { useCompte } from '../compte';
import { codeMemorise, memoriserCode, texteBon } from './Compte';
import { Chargement, Erreur, ImageProduit, QuantiteSaisie, fcfa, usePhotos } from '../composants';
import type { PanierBoutique } from '../panier';
import { A_LA_LIVRAISON, CartePaiement, LogoPaiement, moyensEnLigne, numeroDe, type Moyen } from '../paiement';
import { changerQuantite, clientMemorise, memoriserClient, memoriserCommande, usePanier, viderBoutique } from '../panier';

/** Envoie la capture du paiement (image réduite) puis la rattache à la commande. */
export async function envoyerJustificatif(commandeId: string, code: string, f: File): Promise<void> {
  let corps: Blob = f;
  let ext = f.type === 'application/pdf' ? 'pdf' : 'jpg';
  if (f.type.startsWith('image/')) {
    const img = await createImageBitmap(f);
    const r = Math.min(1, 1400 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * r);
    c.height = Math.round(img.height * r);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    corps = await new Promise<Blob>((ok, ko) => c.toBlob((b) => (b ? ok(b) : ko(new Error('Image illisible'))), 'image/jpeg', 0.85));
    ext = 'jpg';
  }
  const chemin = `${commandeId}/paiement-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('justificatifs').upload(chemin, corps, { contentType: ext === 'pdf' ? 'application/pdf' : 'image/jpeg' });
  if (error) throw new Error(erreurLisible(error));
  await appeler('joindre_justificatif', { p_code: code, p_chemin: chemin });
}

const ETAPES = ['Panier', 'Informations', 'Récapitulatif', 'Confirmation'];

/** Fil d'étapes de la commande : Panier → Informations → Récapitulatif et paiement → Confirmation. */
export function Etapes({ actuelle }: { actuelle: number }) {
  return (
    <ol className="fil-etapes" aria-label="Étapes de la commande">
      <span className="fil-etapes-barre" style={{ ['--avance' as string]: `${(actuelle / (ETAPES.length - 1)) * 100}%` }} aria-hidden />
      {ETAPES.map((e, i) => (
        <li key={e} className={i < actuelle ? 'faite' : i === actuelle ? 'actuelle' : ''} aria-current={i === actuelle ? 'step' : undefined}>
          <span className="fil-etapes-rond">{i < actuelle ? '✓' : i === 0 ? '🛒' : i + 1}</span>
          <span className="fil-etapes-nom">{e}</span>
        </li>
      ))}
    </ol>
  );
}

function Reassurance() {
  return (
    <div className="reassurance">
      <div><span aria-hidden>🔒</span><strong>Paiement sécurisé</strong><small>Wave · Orange Money · à la livraison, sans code secret</small></div>
      <div><span aria-hidden>📦</span><strong>Stock en direct</strong><small>Les quantités viennent de la caisse de la boutique</small></div>
      <div><span aria-hidden>🧾</span><strong>Reçu téléchargeable</strong><small>Avec le mode de paiement et la référence</small></div>
    </div>
  );
}

function CarteRecap({ b, urls, children, titre = 'Récapitulatif', frais, remise }: {
  b: PanierBoutique;
  urls: Record<string, string>;
  children?: ReactNode;
  titre?: string;
  frais?: { libelle: string; montant: number | null };
  remise?: { code: string; montant: number } | null;
}) {
  const nb = b.articles.reduce((s, a) => s + a.quantite, 0);
  const sousTotal = b.articles.reduce((s, a) => s + a.prix * a.quantite, 0);
  const total = sousTotal - (remise?.montant ?? 0) + (frais?.montant ?? 0);
  return (
    <aside className="carte-recap">
      <header>
        <strong>🧾 {titre}</strong>
        <small>{b.nom} · {b.articles.length} produit{b.articles.length > 1 ? 's' : ''} · {nb} article{nb > 1 ? 's' : ''}</small>
      </header>
      <ul className="recap-lignes">
        {b.articles.map((a) => (
          <li key={a.id}>
            <ImageProduit url={a.photo ? urls[a.photo] : undefined} alt={a.designation} />
            <span>{a.designation}<small>Qté : {a.quantite}</small></span>
            <strong>{fcfa(a.prix * a.quantite)}</strong>
          </li>
        ))}
      </ul>
      <dl className="recap-totaux">
        <dt>Sous-total ({nb} art.)</dt><dd>{fcfa(sousTotal)}</dd>
        {remise && <><dt className="remise">🎟️ Code {remise.code}</dt><dd className="remise">−{fcfa(remise.montant)}</dd></>}
        <dt>🛵 {frais?.libelle ?? 'Livraison'}</dt>
        <dd className={frais?.montant == null ? 'a-venir' : ''}>{frais == null ? 'À l’étape suivante' : frais.montant == null ? 'À choisir' : frais.montant ? fcfa(frais.montant) : 'Gratuit'}</dd>
        <dt className="total">Total</dt><dd className="total">{fcfa(total)}</dd>
      </dl>
      {children}
      <p className="recap-securite">🛡️ Paiement direct à la boutique · données protégées</p>
    </aside>
  );
}

export function Panier() {
  const panier = usePanier();
  const boutiques = Object.values(panier);
  const urls = usePhotos(boutiques.flatMap((b) => b.articles.map((a) => a.photo)));
  useEffect(() => {
    document.title = 'Mon panier — DF Marché';
  }, []);
  if (!boutiques.length)
    return (
      <section className="page-commande">
        <Etapes actuelle={0} />
        <div className="bloc vide-panier">
          <p aria-hidden className="grand-emoji">🛒</p>
          <h1>Votre panier est vide</h1>
          <p><Link className="bouton bouton-principal" to="/">Découvrir les produits</Link></p>
        </div>
      </section>
    );
  return (
    <section className="page-commande">
      <Etapes actuelle={0} />
      {boutiques.length > 1 && <p className="secondaire">Vos articles viennent de {boutiques.length} boutiques : chaque boutique prépare sa commande.</p>}
      {boutiques.map((b) => {
        const nb = b.articles.reduce((s, a) => s + a.quantite, 0);
        return (
          <div key={b.slug} className="commande-grille">
            <div className="commande-principal">
              <h1 className="titre-etape">Mon <em>panier</em> <span className="pastille-nb">{nb} article{nb > 1 ? 's' : ''}</span></h1>
              <p className="secondaire"><Link to={`/boutique/${b.slug}`}>🏪 {b.nom}</Link></p>
              <ul className="lignes-panier">
                {b.articles.map((a) => (
                  <li key={a.id}>
                    <ImageProduit url={a.photo ? urls[a.photo] : undefined} alt={a.designation} />
                    <div>
                      <Link to={`/produit/${a.id}`}>{a.designation}</Link>
                      <small>{fcfa(a.prix)}{a.prix < a.prix_normal && <s> {fcfa(a.prix_normal)}</s>}</small>
                    </div>
                    <div className="quantite petite">
                      <button onClick={() => changerQuantite(b.slug, a.id, a.quantite - 1)} aria-label="Moins">−</button>
                      <QuantiteSaisie q={a.quantite} max={a.disponible} className="quantite-champ" onChange={(n) => changerQuantite(b.slug, a.id, n)} />
                      <button onClick={() => changerQuantite(b.slug, a.id, a.quantite + 1)} aria-label="Plus" disabled={a.quantite >= a.disponible}>+</button>
                    </div>
                    <strong>{fcfa(a.prix * a.quantite)}</strong>
                    <button className="retirer-ligne" onClick={() => changerQuantite(b.slug, a.id, 0)} aria-label={`Retirer ${a.designation}`}>🗑</button>
                  </li>
                ))}
              </ul>
              <div className="panier-pied">
                <button className="bouton-lien" onClick={() => viderBoutique(b.slug)}>Vider le panier</button>
                <Link className="bouton" to={`/boutique/${b.slug}`}>+ Ajouter des articles</Link>
              </div>
              <Reassurance />
            </div>
            <CarteRecap b={b} urls={urls}>
              <Link className="bouton bouton-principal large" to={`/commander/${b.slug}`}>🔒 Passer la commande</Link>
              <Link className="lien-retour" to="/">← Continuer mes achats</Link>
            </CarteRecap>
          </div>
        );
      })}
    </section>
  );
}

/** Format attendu par <input type="datetime-local"> (heure locale). */
const versSaisie = (d: Date) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 16);
};

interface Fait { id: string; numero: string; code_suivi: string; total: number; justificatif: 'ok' | 'echec' | null; enLigne: boolean; moyen: string; especes: number | null }

export function Commander() {
  const { slug } = useParams();
  const panier = usePanier();
  const b = slug ? panier[slug] : undefined;
  const [v, setV] = useState<FicheBoutique | null>(null);
  const memo = useMemo(() => clientMemorise(), []);
  const [etape, setEtape] = useState<1 | 2>(1);
  const [f, setF] = useState({
    nom: memo.nom ?? '', telephone: memo.telephone ?? '', email: memo.email ?? '', mode: '' as '' | 'livraison' | 'retrait', zone: '',
    adresse: memo.adresse ?? '', repere: memo.repere ?? '', quand: 'vite' as 'vite' | 'choisir', souhaite: '', note: '',
    choix: '', payeur: '', reference: '', accepte: false, especes: '', code: slug ? codeMemorise(slug) ?? '' : '',
  });
  const { compte } = useCompte();
  const [bon, setBon] = useState<BonAchat | null>(null);
  const [erreurCode, setErreurCode] = useState('');
  useEffect(() => {
    if (compte)
      setF((y) => ({
        ...y, nom: y.nom || compte.nom, telephone: y.telephone || compte.telephone || '', adresse: y.adresse || compte.adresse || '',
        repere: y.repere || compte.repere || '',
      }));
  }, [compte]);
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [autre, setAutre] = useState(false);
  const [fichier, setFichier] = useState<File | null>(null);
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [fait, setFait] = useState<Fait | null>(null);
  const urls = usePhotos(b?.articles.map((a) => a.photo) ?? []);

  useEffect(() => {
    if (!slug) return;
    appeler<FicheBoutique>('marche_boutique', { p_slug: slug })
      .then((x) => {
        setV(x);
        setF((y) => ({
          ...y,
          mode: y.mode || (x.retrait ? 'retrait' : 'livraison'),
          choix: y.choix || (moyensEnLigne(x)[0]?.cle ?? 'livraison'),
        }));
      })
      .catch((e: Error) => setErreur(e.message));
    document.title = 'Finaliser la commande — DF Marché';
    const memo = slug ? codeMemorise(slug) : null;
    if (memo) void appliquerCode(memo, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function appliquerCode(code: string, silencieux = false) {
    setErreurCode('');
    if (!code.trim()) return setBon(null);
    try {
      const k = await appeler<BonAchat>('marche_code_promo', { p_boutique: slug, p_code: code });
      setBon(k);
      memoriserCode(slug!, k.code);
      setF((y) => ({ ...y, code: k.code }));
    } catch (x) {
      setBon(null);
      if (!silencieux) setErreurCode((x as Error).message);
      else memoriserCode(slug!, null);
    }
  }
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [etape, fait]);

  if (fait) return <Confirmation fait={fait} boutique={v?.nom ?? ''} />;
  if (!b) return <section className="page-commande"><Etapes actuelle={0} /><div className="bloc"><p>Ce panier est vide.</p><Link to="/panier">← Retour au panier</Link></div></section>;
  if (!v) return erreur ? <Erreur>{erreur}</Erreur> : <Chargement />;

  const zone = v.zones?.find((z) => z.id === f.zone);
  const sousTotal = b.articles.reduce((s, a) => s + a.prix * a.quantite, 0);
  const frais = f.mode === 'livraison' ? Number(zone?.frais ?? 0) : 0;
  const remiseCode = bon && sousTotal >= Number(bon.minimum)
    ? Math.min(sousTotal, bon.type === 'pourcent' ? Math.round((sousTotal * Number(bon.valeur)) / 100) : Number(bon.valeur)) : 0;
  const total = sousTotal - remiseCode + frais;
  const especes = f.especes === 'exact' ? total : Number(f.especes.replace(/\D/g, '')) || 0;
  const billets = [5000, 10000, 20000, 50000].filter((x) => x > total).slice(0, 3);
  const enLigne = moyensEnLigne(v);
  const choisi: Moyen | undefined = f.choix === 'livraison' ? A_LA_LIVRAISON : enLigne.find((m) => m.cle === f.choix);
  const numero = numeroDe(v, choisi);
  const minimum = new Date(Date.now() + Math.max(1, v.delai_preparation) * 3600000);
  const maj = (x: Partial<typeof f>) => setF((y) => ({ ...y, ...x }));
  const recapFrais = { libelle: f.mode === 'retrait' ? 'Retrait en boutique' : `Livraison${zone ? ` (${zone.nom})` : ''}`, montant: f.mode === 'retrait' ? 0 : zone ? frais : null };

  function localiser() {
    navigator.geolocation?.getCurrentPosition(
      (p) => setPosition({ lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6 }),
      () => setErreur('Position refusée : décrivez simplement l’adresse et un repère.'),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  function versRecap(e: FormEvent) {
    e.preventDefault();
    setErreur('');
    const tel = f.telephone.replace(/[^0-9]/g, '');
    if (f.nom.trim().length < 2) return setErreur('Indiquez votre nom complet.');
    if (tel.length < 8) return setErreur('Indiquez un numéro de téléphone valide (10 chiffres).');
    if (f.mode === 'livraison' && !f.zone) return setErreur('Choisissez votre zone de livraison.');
    if (f.mode === 'livraison' && f.adresse.trim().length < 3) return setErreur('Indiquez l’adresse de livraison.');
    if (sousTotal < v!.commande_minimum) return setErreur(`Commande minimum : ${fcfa(v!.commande_minimum)}.`);
    setEtape(2);
  }

  async function valider(e: FormEvent) {
    e.preventDefault();
    setErreur('');
    if (!choisi) return setErreur('Choisissez un moyen de paiement.');
    const enLignePaye = choisi.code !== 'livraison';
    const payeur = f.payeur.trim() || f.telephone;
    if (enLignePaye && payeur.replace(/[^0-9]/g, '').length < 8) return setErreur('Indiquez le numéro qui a effectué le paiement.');
    if (enLignePaye && !fichier && !f.reference.trim()) return setErreur('Joignez la capture du paiement.');
    if (!enLignePaye && f.especes && f.especes !== 'exact' && especes < total) return setErreur(`Le billet indiqué doit couvrir ${fcfa(total)}.`);
    if (!f.accepte) return setErreur('Cochez « J’ai lu et j’accepte les conditions de vente ».');
    setEnCours(true);
    try {
      const r = await appeler<{ id: string; numero: string; code_suivi: string; total: number }>('passer_commande', {
        p: {
          boutique: slug, client_nom: f.nom, client_telephone: f.telephone, client_email: f.email || null, mode: f.mode,
          zone_id: f.mode === 'livraison' ? f.zone : null, adresse: f.mode === 'livraison' ? f.adresse : null, repere: f.repere || null,
          latitude: position?.lat ?? null, longitude: position?.lng ?? null,
          souhaite_le: f.quand === 'choisir' && f.souhaite ? new Date(f.souhaite).toISOString() : null,
          note: f.note || null, paiement: choisi.code, paiement_autre: choisi.autre?.id ?? null,
          code_promo: bon?.code ?? null, especes_remis: !enLignePaye && f.especes ? especes : null,
          numero_payeur: enLignePaye ? f.payeur.trim() || f.telephone : null, reference_paiement: f.reference || null,
          lignes: b!.articles.map((a) => ({ produit_id: a.id, quantite: a.quantite })),
        },
      });
      memoriserClient({ nom: f.nom, telephone: f.telephone, email: f.email, adresse: f.adresse, repere: f.repere });
      memoriserCommande({ code: r.code_suivi, numero: r.numero, boutique: v!.nom, total: r.total, date: new Date().toISOString() });
      let justificatif: Fait['justificatif'] = null;
      if (fichier) {
        try {
          await envoyerJustificatif(r.id, r.code_suivi, fichier);
          justificatif = 'ok';
        } catch {
          justificatif = 'echec';
        }
      }
      setFait({ ...r, justificatif, enLigne: enLignePaye, moyen: choisi.libelle, especes: !enLignePaye && f.especes ? especes : null });
      memoriserCode(slug!, null);
      viderBoutique(slug!);
    } catch (x) {
      setErreur((x as Error).message);
      setEnCours(false);
    }
  }

  if (etape === 1)
    return (
      <form className="page-commande" onSubmit={versRecap} noValidate>
        <nav className="fil-ariane"><Link to="/">Accueil</Link> › <Link to="/panier">Panier</Link> › <span>Informations</span></nav>
        <Etapes actuelle={1} />
        <div className="commande-grille">
          <div className="commande-principal">
            <h1 className="titre-etape">Vos <em>informations</em></h1>
            {!compte && <p className="info-retrait">👤 Déjà client ? <Link to={`/compte/connexion?retour=/commander/${v.slug}`}>Connectez-vous</Link> pour remplir vos informations et garder l’historique. Ou continuez sans compte.</p>}
            <div className="bloc">
              <h2 className="titre-bloc"><span aria-hidden>👤</span>Coordonnées et livraison</h2>
              {erreur && <p className="alerte" role="alert">⚠️ {erreur}</p>}
              <div className="champs-2">
                <label>Nom complet *<input value={f.nom} onChange={(e) => maj({ nom: e.target.value })} required minLength={2} maxLength={80} autoComplete="name" placeholder="Awa Koné" /></label>
                <label>Téléphone *
                  <span className="champ-indicatif"><span>🇨🇮 +225</span><input value={f.telephone} onChange={(e) => maj({ telephone: e.target.value })} required inputMode="tel" autoComplete="tel" placeholder="07 00 00 00 00" /></span>
                  <small>10 chiffres · la boutique vous appelle pour la remise</small>
                </label>
              </div>
              <label>E-mail (facultatif)<input type="email" value={f.email} onChange={(e) => maj({ email: e.target.value })} autoComplete="email" /></label>

              <p className="etiquette">Mode de réception *</p>
              <div className="options-simples" role="radiogroup" aria-label="Mode de réception">
                {v.retrait && (
                  <button type="button" role="radio" aria-checked={f.mode === 'retrait'} className={f.mode === 'retrait' ? 'actif' : ''} onClick={() => maj({ mode: 'retrait' })}>
                    <span className="option-icone" aria-hidden>🏪</span>
                    <span className="option-texte"><strong>Retrait en boutique</strong><small>Prêt en {v.delai_preparation} h · {v.commune ?? v.ville ?? ''}</small></span>
                    <span className="option-prix gratuit">Gratuit</span>
                  </button>
                )}
                {v.livraison && (
                  <button type="button" role="radio" aria-checked={f.mode === 'livraison'} className={f.mode === 'livraison' ? 'actif' : ''} onClick={() => maj({ mode: 'livraison' })}>
                    <span className="option-icone" aria-hidden>🛵</span>
                    <span className="option-texte"><strong>Livraison</strong><small>Le livreur vous appelle avant de passer</small></span>
                    <span className="option-prix">{v.zones?.length ? `dès ${fcfa(Math.min(...v.zones.map((z) => Number(z.frais))))}` : 'à confirmer'}</span>
                  </button>
                )}
              </div>
              {f.mode === 'livraison' && (
                <>
                  <label>Zone de livraison *
                    <select value={f.zone} onChange={(e) => maj({ zone: e.target.value })} required>
                      <option value="">Choisir votre commune ou quartier…</option>
                      {v.zones?.map((z) => <option key={z.id} value={z.id}>{z.nom} — {fcfa(z.frais)}{z.delai ? ` · ${z.delai}` : ''}</option>)}
                    </select>
                  </label>
                  <label>Adresse de livraison *<input value={f.adresse} onChange={(e) => maj({ adresse: e.target.value })} required minLength={3} maxLength={200} placeholder="Quartier, rue, résidence…" />
                    <small>Ex. Cocody Riviera 3, près de la pharmacie</small></label>
                  <label>Repère<input value={f.repere} onChange={(e) => maj({ repere: e.target.value })} maxLength={200} placeholder="Portail bleu, 2e étage…" /></label>
                  <button type="button" className="bouton" onClick={localiser}>{position ? '📍 Position partagée ✓' : '📍 Partager ma position (aide le livreur)'}</button>
                </>
              )}
              {f.mode === 'retrait' && <p className="info-retrait">🏪 À récupérer : {[v.adresse, v.commune, v.ville].filter(Boolean).join(', ')}{v.horaires ? ` · ${v.horaires}` : ''}</p>}

              <p className="etiquette">Quand ?</p>
              <div className="segment" role="radiogroup" aria-label="Quand ?">
                <button type="button" role="radio" aria-checked={f.quand === 'vite'} className={f.quand === 'vite' ? 'actif' : ''} onClick={() => maj({ quand: 'vite' })}>
                  ⚡ Dès que possible <small>≈ {v.delai_preparation} h</small>
                </button>
                <button type="button" role="radio" aria-checked={f.quand === 'choisir'} className={f.quand === 'choisir' ? 'actif' : ''} onClick={() => maj({ quand: 'choisir', souhaite: f.souhaite || versSaisie(minimum) })}>
                  📅 Choisir un créneau
                </button>
              </div>
              {f.quand === 'choisir' && (
                <label>{f.mode === 'livraison' ? 'Livraison souhaitée le' : 'Retrait prévu le'}
                  <input type="datetime-local" value={f.souhaite} min={versSaisie(minimum)} onChange={(e) => maj({ souhaite: e.target.value })} required />
                </label>
              )}
              <label>Notes / instructions (facultatif)<textarea rows={2} value={f.note} onChange={(e) => maj({ note: e.target.value })} maxLength={500} placeholder="Toute indication utile pour la préparation ou la livraison…" /></label>
              <button className="bouton bouton-principal large">→ Voir le récapitulatif</button>
            </div>
            <p className="secondaire petit">🛡️ Vos données servent uniquement au traitement de votre commande.</p>
          </div>
          <CarteRecap b={b} urls={urls} titre="Votre commande" frais={recapFrais} remise={remiseCode ? { code: bon!.code, montant: remiseCode } : null}>
            <button className="bouton bouton-principal large">🔒 Continuer</button>
            <Link className="lien-retour" to="/panier">← Retour au panier</Link>
          </CarteRecap>
        </div>
      </form>
    );

  return (
    <form className="page-commande" onSubmit={valider}>
      <nav className="fil-ariane"><Link to="/">Accueil</Link> › <Link to="/panier">Panier</Link> › <button type="button" className="bouton-lien" onClick={() => setEtape(1)}>Informations</button> › <span>Récapitulatif</span></nav>
      <Etapes actuelle={2} />
      <div className="commande-grille">
        <div className="commande-principal">
          <h1 className="titre-etape">Récapitulatif et <em>paiement</em></h1>
          <div className="bloc recap-infos">
            <div>
              <span>👤 Client</span>
              <strong>{f.nom}</strong>
              <small>{f.telephone}{f.email ? ` · ${f.email}` : ''}</small>
            </div>
            <div>
              <span>{f.mode === 'livraison' ? '🛵 Livraison' : '🏪 Retrait en boutique'}</span>
              <strong>{f.mode === 'livraison' ? zone?.nom : v.nom}</strong>
              <small>{f.mode === 'livraison' ? [f.adresse, f.repere].filter(Boolean).join(' · ') : [v.adresse, v.commune].filter(Boolean).join(', ')}</small>
              <small>{f.quand === 'choisir' && f.souhaite ? `Le ${new Date(f.souhaite).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}` : `Dès que possible (≈ ${v.delai_preparation} h)`}</small>
            </div>
            <button type="button" className="bouton-lien" onClick={() => setEtape(1)}>✏️ Modifier</button>
          </div>

          <div className="bloc">
            <h2 className="titre-bloc"><span aria-hidden>🎟️</span>Code promo</h2>
            <div className="code-promo-saisie">
              <input value={f.code} onChange={(e) => maj({ code: e.target.value.toUpperCase() })} placeholder="Avez-vous un code ?" aria-label="Code promo" maxLength={20} />
              {bon ? (
                <button type="button" className="bouton" onClick={() => { setBon(null); maj({ code: '' }); memoriserCode(slug!, null); }}>Retirer</button>
              ) : (
                <button type="button" className="bouton bouton-principal" onClick={() => void appliquerCode(f.code)}>Appliquer</button>
              )}
            </div>
            {bon && (remiseCode > 0
              ? <p className="code-ok">✓ {bon.libelle || 'Code'} {texteBon(bon)} : vous économisez <b>{fcfa(remiseCode)}</b></p>
              : <p className="alerte">Ce code demande au moins {fcfa(bon.minimum)} d’achats.</p>)}
            {erreurCode && <p className="alerte">⚠️ {erreurCode}{/connectez-vous/i.test(erreurCode) && <> — <Link to={`/compte/connexion?retour=/commander/${v.slug}`}>se connecter</Link></>}</p>}

            <h2 className="titre-bloc"><span aria-hidden>💳</span>Mode de paiement</h2>
            <div className="familles-paiement" role="radiogroup" aria-label="Mode de paiement">
              {enLigne.length > 0 && (
                <button type="button" role="radio" aria-checked={f.choix !== 'livraison'} className={f.choix !== 'livraison' ? 'actif' : ''}
                  onClick={() => maj({ choix: f.choix !== 'livraison' ? f.choix : enLigne[0]!.cle })}>
                  <span aria-hidden>📲</span><strong>Mobile Money</strong><small>Payer maintenant</small>
                </button>
              )}
              {v.paiement_livraison && (
                <button type="button" role="radio" aria-checked={f.choix === 'livraison'} className={f.choix === 'livraison' ? 'actif' : ''} onClick={() => maj({ choix: 'livraison' })}>
                  <span aria-hidden>💵</span><strong>Espèces</strong><small>{f.mode === 'retrait' ? 'À la caisse, au retrait' : 'Au livreur, à la livraison'}</small>
                </button>
              )}
            </div>
            {f.choix !== 'livraison' && enLigne.length > 1 && (
              <div className="logos-paiement" role="radiogroup" aria-label="Moyen Mobile Money">
                {enLigne.map((m) => (
                  <button type="button" role="radio" aria-checked={f.choix === m.cle} key={m.cle} className={f.choix === m.cle ? 'actif' : ''}
                    style={{ ['--marque' as string]: m.couleur }} onClick={() => maj({ choix: m.cle })}>
                    <LogoPaiement m={m} taille={26} />
                    <span>{m.libelle}</span>
                  </button>
                ))}
              </div>
            )}
            {f.choix === 'livraison' && (
              <div className="bloc-especes">
                <p>💵 Vous payez avec… <small>La boutique prépare votre monnaie.</small></p>
                <div className="puces-montant" role="radiogroup" aria-label="Montant remis">
                  <button type="button" role="radio" aria-checked={f.especes === 'exact'} className={f.especes === 'exact' ? 'actif' : ''} onClick={() => { setAutre(false); maj({ especes: 'exact' }); }}>
                    Le compte exact
                  </button>
                  {billets.map((x) => (
                    <button type="button" role="radio" aria-checked={f.especes === String(x)} key={x} className={f.especes === String(x) ? 'actif' : ''} onClick={() => { setAutre(false); maj({ especes: String(x) }); }}>
                      {fcfa(x)}
                    </button>
                  ))}
                  <button type="button" role="radio" aria-checked={autre} className={autre ? 'actif' : ''} onClick={() => { setAutre(true); maj({ especes: '' }); }}>
                    Autre
                  </button>
                </div>
                {autre && (
                  <input className="montant-autre" value={f.especes} onChange={(e) => maj({ especes: e.target.value.replace(/\D/g, '') })} inputMode="numeric" placeholder="Montant du billet, ex. 25000" aria-label="Autre montant" autoFocus />
                )}
                {f.especes && (
                  <p className="monnaie-ligne">
                    {especes > total ? <>Monnaie à vous rendre : <b>{fcfa(especes - total)}</b></> : especes === total ? <>Pas de monnaie à rendre.</> : <>Le billet doit couvrir <b>{fcfa(total)}</b>.</>}
                  </p>
                )}
              </div>
            )}
            {choisi && choisi.code !== 'livraison' && (numero || choisi.autre?.lien) && (
              <div className="instructions-paiement">
                <CartePaiement m={choisi} numero={numero} montant={total} beneficiaire={v.beneficiaire} lienWave={v.lien_wave} />
                <ol className="etapes-paiement">
                  <li>Payez <strong>{fcfa(total)}</strong> avec le bouton ci-dessus.</li>
                  <li>Joignez la capture du paiement : la boutique vérifie, confirme, et votre reçu est prêt.</li>
                </ol>
                <label className={`depot ${fichier ? 'rempli' : ''}`}>
                  <input type="file" accept="image/*,application/pdf" onChange={(e) => setFichier(e.target.files?.[0] ?? null)} />
                  <span className="depot-icone" aria-hidden>{fichier ? '✅' : '📎'}</span>
                  <span>{fichier ? <><b>Capture jointe</b><small>{fichier.name} · toucher pour changer</small></> : <><b>Joindre la capture du paiement *</b><small>Photo ou capture d’écran du message de confirmation</small></>}</span>
                </label>
                <details className="details-payeur">
                  <summary>Payé depuis un autre numéro que le vôtre ?</summary>
                  <div className="champs-2">
                    <label>Numéro qui a payé<input value={f.payeur} onChange={(e) => maj({ payeur: e.target.value })} inputMode="tel" placeholder={f.telephone || '07 00 00 00 00'} /></label>
                    <label>Référence (facultatif)<input value={f.reference} onChange={(e) => maj({ reference: e.target.value })} maxLength={60} placeholder="Ex. MP231117.1234.A56789" /></label>
                  </div>
                </details>
              </div>
            )}
            <label className="case-cgv">
              <input type="checkbox" checked={f.accepte} onChange={(e) => maj({ accepte: e.target.checked })} />
              <span>J’ai lu et j’accepte les <Link to={`/conditions?boutique=${v.slug}`} target="_blank">conditions de vente</Link>.</span>
            </label>
            {erreur && <p className="alerte" role="alert">⚠️ {erreur}</p>}
            <button className="bouton bouton-principal large" disabled={enCours}>{enCours ? 'Envoi…' : `✅ Confirmer la commande · ${fcfa(total)}`}</button>
          </div>
        </div>
        <CarteRecap b={b} urls={urls} titre="Votre commande" frais={recapFrais} remise={remiseCode ? { code: bon!.code, montant: remiseCode } : null}>
          <button className="bouton bouton-principal large" disabled={enCours}>{enCours ? 'Envoi…' : '✅ Confirmer la commande'}</button>
          <button type="button" className="lien-retour bouton-lien" onClick={() => setEtape(1)}>← Modifier mes informations</button>
        </CarteRecap>
      </div>
    </form>
  );
}

function Confirmation({ fait, boutique }: { fait: Fait; boutique: string }) {
  useEffect(() => {
    document.title = `Commande ${fait.numero} envoyée — DF Marché`;
  }, [fait.numero]);
  return (
    <section className="page-commande">
      <Etapes actuelle={3} />
      <div className="bloc confirmation">
        <div className="confirmation-rond" aria-hidden>✓</div>
        <h1>Merci, votre commande est envoyée !</h1>
        <p><strong>{boutique}</strong> l’a reçue sur sa caisse et va la préparer.</p>
        <div className="confirmation-code">
          <span>N° de commande</span><strong>{fait.numero}</strong>
          <span>Code de suivi</span><strong className="code">{fait.code_suivi}</strong>
          <span>Total</span><strong>{fcfa(fait.total)}</strong>
        </div>
        {fait.enLigne ? (
          <p className="info-retrait">
            💳 Paiement {fait.moyen} : la boutique vérifie la somme reçue puis confirme. Votre <b>reçu de paiement</b> sera alors disponible.
            {fait.justificatif === 'echec' && <><br />⚠️ La capture n’a pas pu être envoyée : renvoyez-la depuis le suivi.</>}
          </p>
        ) : (
          <p className="info-retrait">💵 Vous paierez en espèces à la remise de la commande{fait.especes && fait.especes > fait.total ? ` avec ${fcfa(fait.especes)} : la boutique prépare ${fcfa(fait.especes - fait.total)} de monnaie` : ''}.</p>
        )}
        <p className="secondaire">Gardez votre code de suivi : il permet de suivre la commande et de télécharger le reçu.</p>
        <div className="confirmation-actions">
          <Link className="bouton bouton-principal" to={`/suivi/${fait.code_suivi}`}>📍 Suivre ma commande</Link>
          <Link className="bouton" to={`/recu/${fait.code_suivi}`}>🧾 Bon de commande</Link>
          <Link className="bouton-lien" to="/">Continuer mes achats</Link>
        </div>
      </div>
    </section>
  );
}
