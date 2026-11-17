import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { appeler, supabase, urlPublique, type BonAchat, type CommandeCompte, type FicheBoutique, type ProduitCarte } from '../api';
import { Chargement, Erreur, GrilleProduits, LogoBoutique, TitreRayon, fcfa } from '../composants';
import { EmailNonConfirme, connexion, deconnexion, estTelephone, inscription, motDePasseOublie, rechargerCompte, renvoyerConfirmation, useCompte } from '../compte';
import { mesCommandes, memoriserClient, useFavoris, vusRecemment } from '../panier';

/* ------------------------------------------------------------------------------------------
 * Codes promo : le code choisi (lien partagé, bon d'achat) est gardé pour le panier.
 * ---------------------------------------------------------------------------------------- */

const CLE_CODE = 'dfm_code';
export function codeMemorise(slug: string): string | null {
  try {
    const x = JSON.parse(localStorage.getItem(CLE_CODE) ?? 'null') as { slug: string; code: string } | null;
    return x && x.slug === slug ? x.code : null;
  } catch {
    return null;
  }
}
export function memoriserCode(slug: string, code: string | null) {
  try {
    if (code) localStorage.setItem(CLE_CODE, JSON.stringify({ slug, code }));
    else localStorage.removeItem(CLE_CODE);
  } catch {
    /* navigateur privé */
  }
}
export const texteBon = (b: Pick<BonAchat, 'type' | 'valeur'>) => (b.type === 'pourcent' ? `−${b.valeur} %` : `−${fcfa(b.valeur)}`);

/* ------------------------------------------------------------------------------------------
 * Mon compte
 * ---------------------------------------------------------------------------------------- */

function Ligne({ vers, icone, children, detail }: { vers: string; icone: string; children: ReactNode; detail?: ReactNode }) {
  return (
    <Link to={vers} className="ligne-compte">
      <span className="ligne-compte-ico" aria-hidden>{icone}</span>
      <span>{children}</span>
      {detail && <small>{detail}</small>}
      <span className="chevron" aria-hidden>›</span>
    </Link>
  );
}

export function MonCompte() {
  const { compte, session, pret } = useCompte();
  const favoris = useFavoris();
  const naviguer = useNavigate();
  useEffect(() => {
    document.title = 'Mon compte — DF Marché';
  }, []);
  if (!pret) return <Chargement />;
  return (
    <section className="page-compte">
      {compte ? (
        <div className="compte-tete">
          <span className="avatar" aria-hidden>{compte.photo_path ? <img src={urlPublique('clients', compte.photo_path)!} alt="" /> : compte.nom.slice(0, 1).toUpperCase()}</span>
          <div>
            <h1>Bienvenue {compte.nom.split(' ')[0]} !</h1>
            <small>{estTelephone(compte.email) ? compte.telephone ?? '' : compte.email}</small>
          </div>
        </div>
      ) : session ? (
        <div className="compte-tete"><div><h1>Complétez votre profil</h1><small>Votre nom et votre téléphone pour vos commandes.</small></div></div>
      ) : (
        <div className="compte-invite">
          <img src="/icone-marche.svg" alt="" width={64} height={64} />
          <h1>Mon compte</h1>
          <p>Connectez-vous pour retrouver vos commandes sur tous vos appareils, garder vos adresses et profiter des bons d’achat de vos boutiques.</p>
          <Link className="bouton bouton-principal large" to="/compte/connexion">Se connecter</Link>
          <Link className="bouton large" to="/compte/connexion?creer=1">Créer un compte</Link>
          <p className="secondaire petit">Sans compte, vous pouvez toujours commander : vos informations restent sur ce téléphone.</p>
        </div>
      )}

      <h2 className="compte-section">Mon compte DF Marché</h2>
      <nav className="liste-compte">
        <Ligne vers="/compte/commandes" icone="📦" detail={compte ? `${compte.commandes}` : mesCommandes().length || undefined}>Mes commandes</Ligne>
        <Ligne vers="/compte/bons" icone="🎟️">Bons d’achat et codes promo</Ligne>
        <Ligne vers="/favoris" icone="♡" detail={favoris.length || undefined}>Favoris</Ligne>
        <Ligne vers="/compte/vus" icone="🕘">Consultés récemment</Ligne>
        <Ligne vers="/mes-commandes" icone="📍">Suivre une commande avec son code</Ligne>
      </nav>

      {session && (
        <>
          <h2 className="compte-section">Mes paramètres</h2>
          <nav className="liste-compte">
            <Ligne vers="/compte/profil" icone="📒">Carnet d’adresses</Ligne>
            <Ligne vers="/compte/profil" icone="👤">Gestion du compte</Ligne>
          </nav>
        </>
      )}

      <h2 className="compte-section">À propos</h2>
      <nav className="liste-compte">
        <Ligne vers="/conditions" icone="📄">Conditions générales de vente</Ligne>
        <Ligne vers="/confidentialite" icone="🔒">Politique de confidentialité</Ligne>
        <Ligne vers="/boutiques" icone="🏪">Toutes les boutiques</Ligne>
      </nav>

      {session && (
        <button className="bouton-deconnexion" onClick={() => void deconnexion().then(() => naviguer('/compte'))}>Se déconnecter</button>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------
 * Connexion / création
 * ---------------------------------------------------------------------------------------- */

export function Connexion() {
  const [params] = useSearchParams();
  const naviguer = useNavigate();
  const [creer, setCreer] = useState(params.get('creer') === '1');
  const [f, setF] = useState({ identifiant: '', motDePasse: '', nom: '', telephone: '', accepte: false });
  const [voir, setVoir] = useState(false);
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [aConfirmer, setAConfirmer] = useState<string | null>(null);
  const [info, setInfo] = useState('');
  const retour = params.get('retour') || '/compte';
  useEffect(() => {
    document.title = `${creer ? 'Créer un compte' : 'Se connecter'} — DF Marché`;
  }, [creer]);

  async function renvoyer() {
    if (!aConfirmer) return;
    setErreur('');
    try {
      await renvoyerConfirmation(aConfirmer);
      setInfo('E-mail renvoyé. Pensez à regarder dans « Spam » ou « Promotions ».');
    } catch (x) {
      setErreur((x as Error).message);
    }
  }
  async function oublie() {
    setErreur('');
    setInfo('');
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(f.identifiant.trim())) return setErreur('Tapez d’abord votre adresse e-mail, puis « Mot de passe oublié ».');
    try {
      await motDePasseOublie(f.identifiant);
      setInfo('Si un compte existe pour cette adresse, un lien pour choisir un nouveau mot de passe vient d’être envoyé.');
    } catch (x) {
      setErreur((x as Error).message);
    }
  }

  async function valider(e: FormEvent) {
    e.preventDefault();
    setErreur('');
    if (creer && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(f.identifiant.trim())) return setErreur('Indiquez une adresse e-mail valide (ex. vous@gmail.com).');
    if (!creer && f.identifiant.replace(/\s/g, '').length < 5) return setErreur('Indiquez votre adresse e-mail.');
    if (creer && f.telephone && f.telephone.replace(/\D/g, '').length < 8) return setErreur('Le téléphone semble incomplet (facultatif : laissez vide).');
    if (f.motDePasse.length < 6) return setErreur('Mot de passe : 6 caractères au moins.');
    if (creer && f.nom.trim().length < 2) return setErreur('Indiquez votre nom.');
    if (creer && !f.accepte) return setErreur('Acceptez la politique de confidentialité pour créer votre compte.');
    setEnCours(true);
    try {
      if (creer) {
        const r = await inscription({ identifiant: f.identifiant, motDePasse: f.motDePasse, nom: f.nom.trim(), telephone: f.telephone });
        memoriserClient({ nom: f.nom.trim(), telephone: f.telephone });
        if (r === 'a_confirmer') {
          memoriserRetour(retour);
          return setAConfirmer(f.identifiant.trim().toLowerCase());
        }
      } else await connexion(f.identifiant, f.motDePasse);
      naviguer(retour);
    } catch (x) {
      if (x instanceof EmailNonConfirme) {
        memoriserRetour(retour);
        setAConfirmer(x.email);
      }
      setErreur((x as Error).message);
    } finally {
      setEnCours(false);
    }
  }

  if (aConfirmer)
    return (
      <section className="page-compte etroite">
        <div className="bloc boite-mail">
          <div className="boite-mail-icone" aria-hidden>📩</div>
          <h1>Vérifiez votre boîte mail</h1>
          <p>Nous avons envoyé un lien de confirmation à <b>{aConfirmer}</b>.</p>
          <p className="secondaire">Ouvrez l’e-mail « Confirmez votre compte DF Marché » et touchez le bouton : votre compte est activé et vous êtes connecté(e).</p>
          {info && <p className="succes">✓ {info}</p>}
          {erreur && !/Confirmez d’abord/.test(erreur) && <p className="alerte">⚠️ {erreur}</p>}
          <div className="boite-mail-actions">
            <a className="bouton bouton-principal" href="https://mail.google.com" target="_blank" rel="noreferrer">Ouvrir Gmail</a>
            <button type="button" className="bouton" onClick={() => void renvoyer()}>Renvoyer l’e-mail</button>
          </div>
          <p className="secondaire petit">Rien reçu après 2 minutes ? Regardez dans « Spam » ou « Promotions », ou vérifiez l’adresse.</p>
          <button type="button" className="bouton-lien" onClick={() => { setAConfirmer(null); setErreur(''); setInfo(''); setCreer(false); }}>← Retour à la connexion</button>
        </div>
      </section>
    );

  return (
    <section className="page-compte etroite">
      <div className="onglets-connexion" role="tablist">
        <button role="tab" aria-selected={!creer} className={!creer ? 'actif' : ''} onClick={() => setCreer(false)}>Se connecter</button>
        <button role="tab" aria-selected={creer} className={creer ? 'actif' : ''} onClick={() => setCreer(true)}>Créer un compte</button>
      </div>
      <form className="bloc formulaire-compte" onSubmit={valider} noValidate>
        <h1>{creer ? 'Créez votre compte' : 'Bon retour parmi nous'}</h1>
        <p className="secondaire">{creer ? 'Uniquement avec votre adresse e-mail : vos commandes, adresses et bons d’achat au même endroit.' : 'Avec votre adresse e-mail et votre mot de passe.'}</p>
        {erreur && <p className="alerte" role="alert">⚠️ {erreur}</p>}
        {info && <p className="succes">✓ {info}</p>}
        {creer && <label>Nom complet *<input value={f.nom} onChange={(e) => setF({ ...f, nom: e.target.value })} autoComplete="name" placeholder="Awa Koné" /></label>}
        <label>Adresse e-mail *
          <input type="email" value={f.identifiant} onChange={(e) => setF({ ...f, identifiant: e.target.value })} autoComplete={creer ? 'email' : 'username'} inputMode="email" placeholder="vous@gmail.com" autoCapitalize="none" />
        </label>
        {creer && (
          <label>Téléphone <span className="facultatif">facultatif</span><input value={f.telephone} onChange={(e) => setF({ ...f, telephone: e.target.value })} inputMode="tel" autoComplete="tel" placeholder="07 00 00 00 00" /></label>
        )}
        <label>Mot de passe *
          <span className="champ-indicatif">
            <input type={voir ? 'text' : 'password'} value={f.motDePasse} onChange={(e) => setF({ ...f, motDePasse: e.target.value })} autoComplete={creer ? 'new-password' : 'current-password'} minLength={6} />
            <button type="button" className="voir-mdp" onClick={() => setVoir(!voir)} aria-label={voir ? 'Masquer' : 'Afficher'}>{voir ? '🙈' : '👁️'}</button>
          </span>
          {creer && <small>6 caractères au moins. Ne réutilisez jamais un code Mobile Money.</small>}
        </label>
        {creer && (
          <label className="case-cgv">
            <input type="checkbox" checked={f.accepte} onChange={(e) => setF({ ...f, accepte: e.target.checked })} />
            <span>J’ai lu et j’accepte la <Link to="/confidentialite" target="_blank">politique de confidentialité</Link>.</span>
          </label>
        )}
        <button className="bouton bouton-principal large" disabled={enCours}>{enCours ? 'Patientez…' : creer ? 'Créer mon compte' : 'Se connecter'}</button>
        {!creer && <button type="button" className="bouton-lien" onClick={() => void oublie()}>Mot de passe oublié ?</button>}
        {creer && <p className="secondaire petit">📩 Un e-mail de confirmation vous sera envoyé pour activer votre compte.</p>}
      </form>
    </section>
  );
}

const CLE_RETOUR = 'dfm_retour_confirmation';
function memoriserRetour(r: string) {
  try {
    localStorage.setItem(CLE_RETOUR, r);
  } catch {
    /* stockage indisponible */
  }
}

/** Retour du lien de confirmation : la session s'ouvre toute seule, on accueille le client. */
export function CompteConfirme() {
  const { session, compte, pret } = useCompte();
  const naviguer = useNavigate();
  const [attente, setAttente] = useState(true);
  const erreurLien = new URLSearchParams(window.location.hash.slice(1)).get('error_description') ?? new URLSearchParams(window.location.search).get('error_description');
  useEffect(() => {
    document.title = 'Compte confirmé — DF Marché';
    const t = window.setTimeout(() => setAttente(false), 6000);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!session || !compte) return;
    let retour = '/compte';
    try {
      retour = localStorage.getItem(CLE_RETOUR) || '/compte';
      localStorage.removeItem(CLE_RETOUR);
    } catch {
      /* rien */
    }
    const t = window.setTimeout(() => naviguer(retour, { replace: true }), 2200);
    return () => window.clearTimeout(t);
  }, [session, compte, naviguer]);
  return (
    <section className="page-compte etroite">
      <div className="bloc boite-mail">
        {session ? (
          <>
            <div className="boite-mail-icone ok" aria-hidden>✓</div>
            <h1>Adresse confirmée</h1>
            <p>Bienvenue{compte ? `, ${compte.nom.split(' ')[0]}` : ''} ! Votre compte DF Marché est actif.</p>
            <Link className="bouton bouton-principal" to="/compte">Mon compte</Link>
          </>
        ) : erreurLien || (!attente && pret) ? (
          <>
            <div className="boite-mail-icone" aria-hidden>⏳</div>
            <h1>Lien expiré ou déjà utilisé</h1>
            <p className="secondaire">{erreurLien ? decodeURIComponent(erreurLien.replace(/\+/g, ' ')) : 'Connectez-vous : si votre adresse est déjà confirmée, ça marche directement.'}</p>
            <Link className="bouton bouton-principal" to="/compte/connexion">Se connecter</Link>
          </>
        ) : (
          <Chargement />
        )}
      </div>
    </section>
  );
}

/** Lien « mot de passe oublié » : choisir un nouveau mot de passe. */
export function NouveauMotDePasse() {
  const { session, pret } = useCompte();
  const naviguer = useNavigate();
  const [mdp, setMdp] = useState('');
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);
  async function valider(e: FormEvent) {
    e.preventDefault();
    if (mdp.length < 6) return setErreur('Mot de passe : 6 caractères au moins.');
    setEnCours(true);
    const { error } = await supabase.auth.updateUser({ password: mdp });
    setEnCours(false);
    if (error) return setErreur(error.message);
    naviguer('/compte', { replace: true });
  }
  if (!pret) return <Chargement />;
  return (
    <section className="page-compte etroite">
      <form className="bloc formulaire-compte" onSubmit={valider}>
        <h1>Nouveau mot de passe</h1>
        {!session ? (
          <p className="alerte">Ce lien a expiré. Redemandez-le depuis « Se connecter » → « Mot de passe oublié ».</p>
        ) : (
          <>
            {erreur && <p className="alerte">⚠️ {erreur}</p>}
            <label>Nouveau mot de passe *<input type="password" value={mdp} onChange={(e) => setMdp(e.target.value)} autoComplete="new-password" minLength={6} /></label>
            <button className="bouton bouton-principal large" disabled={enCours}>{enCours ? 'Patientez…' : 'Enregistrer'}</button>
          </>
        )}
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------
 * Mes commandes (compte + ce téléphone)
 * ---------------------------------------------------------------------------------------- */

const STATUTS: Record<string, [string, string]> = {
  nouvelle: ['Reçue', 'gris'], confirmee: ['Confirmée', 'vert'], prete: ['Prête', 'vert'], en_livraison: ['En livraison', 'bleu'],
  livree: ['Livrée', 'vert'], annulee: ['Annulée', 'rouge'],
};

export function CommandesCompte() {
  const { session, pret } = useCompte();
  const [liste, setListe] = useState<CommandeCompte[] | null>(null);
  const [erreur, setErreur] = useState('');
  const locales = mesCommandes();
  useEffect(() => {
    document.title = 'Mes commandes — DF Marché';
    if (!pret) return;
    if (!session) return setListe([]);
    appeler<CommandeCompte[]>('mes_commandes_marche').then(setListe).catch((e: Error) => setErreur(e.message));
  }, [session, pret]);
  if (erreur) return <Erreur>{erreur}</Erreur>;
  if (!liste) return <Chargement />;
  const codes = new Set(liste.map((c) => c.code));
  const autres = locales.filter((c) => !codes.has(c.code));
  return (
    <section className="page-compte">
      <nav className="fil-ariane"><Link to="/compte">Mon compte</Link> › <span>Mes commandes</span></nav>
      <h1 className="titre-etape">Mes <em>commandes</em></h1>
      {!session && <p className="info-retrait">🔐 <Link to="/compte/connexion?retour=/compte/commandes">Connectez-vous</Link> pour retrouver vos commandes sur tous vos appareils.</p>}
      {!liste.length && !autres.length && (
        <div className="bloc vide-panier"><p className="grand-emoji" aria-hidden>📦</p><p>Aucune commande pour l’instant.</p><Link className="bouton bouton-principal" to="/">Commencer mes achats</Link></div>
      )}
      <ul className="cartes-commandes">
        {liste.map((c) => (
          <li key={c.code}>
            <Link to={`/suivi/${c.code}`}>
              <div><strong>{c.numero}</strong><span className={`pastille-statut ${STATUTS[c.statut]?.[1] ?? 'gris'}`}>{STATUTS[c.statut]?.[0] ?? c.statut}</span></div>
              <small>{c.boutique} · {new Date(c.date).toLocaleDateString('fr-FR')} · {c.articles} article{c.articles > 1 ? 's' : ''}</small>
              <b>{fcfa(c.total)}</b>
            </Link>
          </li>
        ))}
        {autres.map((c) => (
          <li key={c.code}>
            <Link to={`/suivi/${c.code}`}>
              <div><strong>{c.numero}</strong><span className="pastille-statut gris">sur ce téléphone</span></div>
              <small>{c.boutique} · {new Date(c.date).toLocaleDateString('fr-FR')}</small>
              <b>{fcfa(c.total)}</b>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------
 * Bons d'achat
 * ---------------------------------------------------------------------------------------- */

export function Bons() {
  const { session, pret } = useCompte();
  const [liste, setListe] = useState<BonAchat[] | null>(null);
  const naviguer = useNavigate();
  useEffect(() => {
    document.title = 'Bons d’achat — DF Marché';
    if (pret) appeler<BonAchat[]>('mes_bons_marche').then(setListe).catch(() => setListe([]));
  }, [session, pret]);
  if (!liste) return <Chargement />;
  return (
    <section className="page-compte">
      <nav className="fil-ariane"><Link to="/compte">Mon compte</Link> › <span>Bons d’achat</span></nav>
      <h1 className="titre-etape">Mes <em>bons d’achat</em></h1>
      {!session && <p className="info-retrait">🎁 <Link to="/compte/connexion?retour=/compte/bons">Connectez-vous</Link> : vos boutiques peuvent vous réserver des réductions personnelles.</p>}
      {!liste.length ? <p className="vide">Aucun bon d’achat pour le moment.</p> : (
        <ul className="bons">
          {liste.map((b) => (
            <li key={`${b.boutique?.slug}-${b.code}`} className={b.personnel ? 'personnel' : ''}>
              <div className="bon-valeur">{texteBon(b)}</div>
              <div className="bon-corps">
                <strong>{b.libelle || (b.personnel ? 'Réduction rien que pour vous' : 'Offre spéciale')}</strong>
                <small>{b.boutique?.nom}{b.minimum ? ` · dès ${fcfa(b.minimum)}` : ''}{b.fin ? ` · jusqu’au ${new Date(b.fin).toLocaleDateString('fr-FR')}` : ''}</small>
                <span className="bon-code">{b.code}</span>
              </div>
              {b.boutique && (
                <button className="bouton bouton-principal" onClick={() => { memoriserCode(b.boutique!.slug, b.code); naviguer(`/boutique/${b.boutique!.slug}`); }}>Utiliser</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------
 * Profil : carnet d'adresses et gestion du compte
 * ---------------------------------------------------------------------------------------- */

/** Photo de profil réduite (côté le plus long : max px) en JPEG. */
async function reduirePhoto(f: File, max: number): Promise<Blob> {
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise<HTMLImageElement>((ok, ko) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => ko(new Error('Image illisible : choisissez une photo JPEG ou PNG.'));
      i.src = url;
    });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>((ok, ko) => c.toBlob((b) => (b ? ok(b) : ko(new Error('Photo impossible à préparer.'))), 'image/jpeg', 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function Profil() {
  const { compte, session, pret } = useCompte();
  const naviguer = useNavigate();
  const [f, setF] = useState({ nom: '', telephone: '', adresse: '', repere: '', commune: '' });
  const [info, setInfo] = useState('');
  const [erreur, setErreur] = useState('');
  useEffect(() => {
    if (pret && !session) naviguer('/compte/connexion?retour=/compte/profil', { replace: true });
    if (compte) setF({ nom: compte.nom, telephone: compte.telephone ?? '', adresse: compte.adresse ?? '', repere: compte.repere ?? '', commune: compte.commune ?? '' });
  }, [compte, session, pret, naviguer]);
  const [envoi, setEnvoi] = useState(false);
  async function changerPhoto(fichier: File | undefined) {
    if (!fichier || !session) return;
    setErreur('');
    setEnvoi(true);
    try {
      const blob = await reduirePhoto(fichier, 480);
      const chemin = `${session.user.id}/profil-${Date.now()}.jpg`;
      const { error } = await supabase.storage.from('clients').upload(chemin, blob, { contentType: 'image/jpeg' });
      if (error) throw new Error(error.message);
      const ancien = compte?.photo_path;
      await appeler('compte_marche_enregistrer', { p: { ...f, photo_path: chemin } });
      if (ancien) await supabase.storage.from('clients').remove([ancien]);
      await rechargerCompte();
      setInfo('Photo de profil mise à jour.');
    } catch (x) {
      setErreur((x as Error).message);
    } finally {
      setEnvoi(false);
    }
  }
  async function enregistrer(e: FormEvent) {
    e.preventDefault();
    setErreur('');
    try {
      await appeler('compte_marche_enregistrer', { p: f });
      memoriserClient({ nom: f.nom, telephone: f.telephone, adresse: f.adresse, repere: f.repere });
      await rechargerCompte();
      setInfo('Enregistré : ces informations rempliront vos prochaines commandes.');
    } catch (x) {
      setErreur((x as Error).message);
    }
  }
  return (
    <section className="page-compte etroite">
      <nav className="fil-ariane"><Link to="/compte">Mon compte</Link> › <span>Profil et adresse</span></nav>
      <form className="bloc formulaire-compte" onSubmit={enregistrer}>
        <h1>Profil et adresse</h1>
        {info && <p className="succes">✓ {info}</p>}
        {erreur && <p className="alerte">⚠️ {erreur}</p>}
        <div className="photo-profil">
          <span className="avatar grand" aria-hidden>
            {compte?.photo_path ? <img src={urlPublique('clients', compte.photo_path)!} alt="" /> : (f.nom || '?').slice(0, 1).toUpperCase()}
          </span>
          <label className="bouton">
            <input type="file" accept="image/*" hidden onChange={(e) => { void changerPhoto(e.target.files?.[0]); e.target.value = ''; }} />
            {envoi ? 'Envoi…' : compte?.photo_path ? '📷 Changer la photo' : '📷 Ajouter une photo'}
          </label>
          <small className="secondaire">Facultatif · visible par les boutiques où vous commandez</small>
        </div>
        <label>Nom complet *<input value={f.nom} onChange={(e) => setF({ ...f, nom: e.target.value })} required /></label>
        <label>Téléphone <span className="facultatif">facultatif</span><input value={f.telephone} onChange={(e) => setF({ ...f, telephone: e.target.value })} inputMode="tel" placeholder="07 00 00 00 00" /></label>
        <h2 className="titre-bloc"><span aria-hidden>📒</span>Adresse de livraison</h2>
        <label>Commune / quartier<input value={f.commune} onChange={(e) => setF({ ...f, commune: e.target.value })} placeholder="Cocody Angré" /></label>
        <label>Adresse<input value={f.adresse} onChange={(e) => setF({ ...f, adresse: e.target.value })} placeholder="Rue, résidence, immeuble…" /></label>
        <label>Repère<input value={f.repere} onChange={(e) => setF({ ...f, repere: e.target.value })} placeholder="Portail bleu après la pharmacie" /></label>
        <button className="bouton bouton-principal large">Enregistrer</button>
        {compte && <p className="secondaire petit">Compte : {estTelephone(compte.email) ? compte.telephone : compte.email} · depuis le {new Date(compte.depuis).toLocaleDateString('fr-FR')}</p>}
      </form>
    </section>
  );
}

export function VusRecemment() {
  const liste = vusRecemment();
  useEffect(() => {
    document.title = 'Consultés récemment — DF Marché';
  }, []);
  return (
    <section className="page-compte">
      <nav className="fil-ariane"><Link to="/compte">Mon compte</Link> › <span>Consultés récemment</span></nav>
      <h1 className="titre-etape">Consultés <em>récemment</em></h1>
      {liste.length ? <GrilleProduits produits={liste} /> : <p className="vide">Les produits que vous regardez s’afficheront ici.</p>}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------
 * Offre partagée : /offre/<boutique>/<CODE> → le code est retenu pour le panier.
 * ---------------------------------------------------------------------------------------- */

export function Offre() {
  const { slug, code } = useParams();
  const [bon, setBon] = useState<BonAchat | null>(null);
  const [v, setV] = useState<FicheBoutique | null>(null);
  const [produits, setProduits] = useState<ProduitCarte[]>([]);
  const [erreur, setErreur] = useState('');
  useEffect(() => {
    if (!slug || !code) return;
    appeler<{ produits: ProduitCarte[] }>('marche_produits', { p_boutique: slug, p_limite: 24 }).then((r) => setProduits(r.produits)).catch(() => undefined);
    appeler<BonAchat>('marche_code_promo', { p_boutique: slug, p_code: code })
      .then((b) => { setBon(b); memoriserCode(slug, b.code); })
      .catch((e: Error) => setErreur(e.message));
    appeler<FicheBoutique>('marche_boutique', { p_slug: slug }).then(setV).catch(() => undefined);
    document.title = 'Votre offre — DF Marché';
  }, [slug, code]);
  if (erreur)
    return (
      <section className="page-compte etroite">
        <div className="bloc vide-panier">
          <p className="grand-emoji" aria-hidden>🎟️</p>
          <h1>Offre indisponible</h1>
          <p>{erreur}</p>
          {/connectez-vous/i.test(erreur) && <Link className="bouton bouton-principal" to={`/compte/connexion?retour=/offre/${slug}/${code}`}>Se connecter</Link>}
          <Link className="bouton" to={`/boutique/${slug}`}>Voir la boutique</Link>
        </div>
      </section>
    );
  if (!bon || !v) return <Chargement />;
  return (
    <section className="page-offre">
      <div className="offre-carte">
        <div className="offre-fond" aria-hidden />
        <LogoBoutique v={v} />
        <p className="offre-boutique">{v.nom} vous offre</p>
        <p className="offre-valeur">{texteBon(bon)}</p>
        <p>{bon.libelle ?? 'sur votre commande'}{bon.minimum ? ` dès ${fcfa(bon.minimum)} d’achats` : ''}</p>
        <p className="offre-code">Code <strong>{bon.code}</strong> · appliqué automatiquement au panier ✓</p>
        {bon.fin && <small>Valable jusqu’au {new Date(bon.fin).toLocaleDateString('fr-FR')}</small>}
        <Link className="bouton bouton-principal large" to={`/boutique/${v.slug}`}>J’en profite</Link>
      </div>
      {!!produits.length && (
        <>
          <TitreRayon titre={`Les produits de ${v.nom}`} lien={{ vers: `/boutique/${v.slug}` }} />
          <GrilleProduits produits={produits} sansBoutique />
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------
 * Politique de confidentialité
 * ---------------------------------------------------------------------------------------- */

const CONFIDENTIALITE: [string, string][] = [
  ['Qui sommes-nous ?', 'DF Marché réunit des boutiques de Côte d’Ivoire qui utilisent le logiciel DF Gestion (Le Décodeur Financier). Chaque boutique vend ses propres produits et traite ses commandes.'],
  ['Les données que nous recueillons', 'Pour une commande : votre nom, votre téléphone, votre adresse et votre repère de livraison, le contenu de la commande, le moyen de paiement choisi, le numéro qui a payé, la référence de la transaction et la capture que vous joignez. Pour un compte : votre adresse e-mail et votre mot de passe (protégé et jamais visible), et si vous les ajoutez, votre téléphone, votre adresse et votre photo de profil. Nous ne demandons et ne conservons jamais de code secret Mobile Money ni de données de carte bancaire.'],
  ['Pourquoi nous les utilisons', 'Uniquement pour préparer, livrer et encaisser votre commande, vous en envoyer le suivi et le reçu, et vous proposer les réductions de vos boutiques. Pas de revente de données, pas de publicité de tiers.'],
  ['Qui peut les voir', 'La boutique à qui vous commandez (gérant, caissière, livreur) voit les informations de cette commande. Si vous créez un compte, les boutiques de DF Marché voient votre profil client (nom, e-mail, téléphone, commune, photo) pour vous offrir des bons de réduction ; elles ne voient que les commandes passées chez elles. Les captures de paiement restent visibles uniquement par la boutique concernée.'],
  ['Sur votre téléphone', 'Sans compte, votre panier, vos favoris, vos derniers produits vus et vos coordonnées restent dans ce navigateur. Vous pouvez les effacer depuis les réglages du navigateur.'],
  ['Sécurité', 'Les échanges sont chiffrés (HTTPS). Les données sont protégées par des règles d’accès strictes : chaque boutique n’accède qu’à ses propres commandes et aux profils des comptes clients. Les captures de paiement ne sont visibles que par la boutique concernée.'],
  ['Durée de conservation', 'Les commandes sont gardées le temps nécessaire à la comptabilité de la boutique. Un compte inutilisé peut être fermé à votre demande.'],
  ['Vos droits', 'Vous pouvez consulter et corriger vos informations dans « Mon compte », et demander la fermeture de votre compte à la boutique ou à DF Marché depuis le formulaire de la plateforme.'],
];

export function Confidentialite() {
  const [ouvert, setOuvert] = useState(0);
  useEffect(() => {
    document.title = 'Politique de confidentialité — DF Marché';
  }, []);
  return (
    <section className="rayon page-conditions">
      <div className="rayon-titre"><h1>Politique de confidentialité</h1></div>
      <p className="secondaire">Comment DF Marché et ses boutiques protègent vos informations.</p>
      <div className="accordeon">
        {CONFIDENTIALITE.map(([t, texte], i) => (
          <div key={t} className={`accordeon-item ${ouvert === i ? 'ouvert' : ''}`}>
            <button type="button" aria-expanded={ouvert === i} onClick={() => setOuvert(ouvert === i ? -1 : i)}>
              <span>{i + 1}. {t}</span>
              <span aria-hidden className="signe">{ouvert === i ? '−' : '+'}</span>
            </button>
            {ouvert === i && <div className="accordeon-corps"><p>{texte}</p></div>}
          </div>
        ))}
      </div>
    </section>
  );
}
