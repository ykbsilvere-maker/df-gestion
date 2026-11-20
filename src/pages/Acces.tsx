import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { libelleAppareil } from '../lib/appareil';
import { dateHeure, messageErreur } from '../lib/format';
import { Alerte, Champ, EnTetePage, Pastille } from '../components/ui';

/* --------------------------------------------------------------------------------------------
 * Écran d'un appareil pas encore approuvé : rien d'autre n'est accessible.
 * ------------------------------------------------------------------------------------------ */
export function AppareilEnAttente() {
  const { appareil, verifierAppareil, debloquerAppareil, deconnecter, organisation, session } = useSession();
  const [cle, setCle] = useState('');
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);

  // La gérante peut approuver à tout moment : on revérifie toutes les 6 secondes.
  useEffect(() => {
    if (appareil !== 'en_attente') return;
    const id = window.setInterval(() => void verifierAppareil(), 6000);
    return () => window.clearInterval(id);
  }, [appareil, verifierAppareil]);

  async function ouvrir(e: FormEvent) {
    e.preventDefault();
    setEnCours(true);
    setErreur('');
    const m = await debloquerAppareil(cle);
    setEnCours(false);
    if (m) setErreur(m);
  }

  const refuse = appareil === 'refuse' || appareil === 'revoque';
  return (
    <main className="page-acces">
      <section className="carte carte-acces">
        <div className="acces-icone" aria-hidden>{refuse ? '⛔' : '📱'}</div>
        <h1>{refuse ? 'Appareil non autorisé' : 'Appareil en attente d’approbation'}</h1>
        <p>
          {refuse ? (
            <>La gérante a {appareil === 'revoque' ? 'retiré' : 'refusé'} l’accès à <b>{organisation?.nom}</b> depuis cet appareil.</>
          ) : (
            <>
              Pour protéger <b>{organisation?.nom}</b>, chaque nouvel appareil doit être approuvé. La gérante principale vient de recevoir
              votre demande : dès qu’elle l’approuve, DF Gestion s’ouvre tout seul.
            </>
          )}
        </p>
        <p className="secondaire">
          Compte : <b>{session?.user.user_metadata?.nom_complet || session?.user.email}</b>
          <br />
          Appareil : <b>{libelleAppareil()}</b>
        </p>
        {!refuse && <p className="acces-attente"><span className="point-attente" aria-hidden /> En attente de la gérante…</p>}

        <form className="formulaire acces-cle" onSubmit={(e) => void ouvrir(e)}>
          <Champ label="Vous avez une clé d’accès personnelle ?" aide="Remise par la gérante : DFG-XXXX-XX, valable une seule fois.">
            <input
              value={cle}
              onChange={(e) => setCle(e.target.value.toUpperCase())}
              placeholder="DFG-7K4P-29"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={16}
            />
          </Champ>
          <Alerte>{erreur}</Alerte>
          <button className="bouton bouton-principal bouton-plein" disabled={cle.replace(/[^A-Za-z0-9]/g, '').length < 9 || enCours}>
            {enCours ? 'Vérification…' : '🔓 Ouvrir avec ma clé'}
          </button>
        </form>
        <button type="button" className="bouton-lien" onClick={() => void deconnecter()}>Se déconnecter</button>
      </section>
    </main>
  );
}

/* --------------------------------------------------------------------------------------------
 * Clés d'accès personnelles (gérante principale ; administrateur général pour org = null).
 * ------------------------------------------------------------------------------------------ */
interface Cle {
  id: string;
  indice: string;
  pour: string | null;
  email: string | null;
  cree_le: string;
  cree_par: string | null;
  expire_le: string;
  utilisee_le: string | null;
  utilisee_par: string | null;
  annulee_le: string | null;
  statut: 'active' | 'utilisee' | 'expiree' | 'annulee' | 'compte_cree';
}
interface Membre {
  user_id: string;
  nom: string;
}

const STATUT_CLE: Record<Cle['statut'], { libelle: string; ton: 'vert' | 'gris' | 'or' | 'rouge' | 'bleu' }> = {
  active: { libelle: 'active', ton: 'vert' },
  compte_cree: { libelle: 'compte créé', ton: 'bleu' },
  utilisee: { libelle: 'utilisée', ton: 'gris' },
  expiree: { libelle: 'expirée', ton: 'or' },
  annulee: { libelle: 'annulée', ton: 'rouge' },
};

export function ClesAcces({ org, membres }: { org: string | null; membres: Membre[] }) {
  const [cles, setCles] = useState<Cle[] | null>(null);
  const [erreur, setErreur] = useState('');
  const [pour, setPour] = useState(''); // user_id d'un membre, ou '' (nouvelle personne)
  const [nom, setNom] = useState('');
  const [email, setEmail] = useState('');
  const [jours, setJours] = useState(7);
  const [nouvelle, setNouvelle] = useState<{ cle: string; pour: string; expire_le: string } | null>(null);
  const [copie, setCopie] = useState(false);

  const charger = useCallback(async () => {
    const { data, error } = await supabase.rpc('cles_acces_liste', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    setCles((data as Cle[]) ?? []);
  }, [org]);
  useEffect(() => {
    void charger();
  }, [charger]);

  async function creer(e: FormEvent) {
    e.preventDefault();
    setErreur('');
    setCopie(false);
    const { data, error } = await supabase.rpc('cle_acces_creer', {
      p_org: org, p_pour_nom: pour ? null : nom.trim() || null, p_pour_email: pour ? null : email.trim() || null, p_user: pour || null, p_jours: jours,
    });
    if (error) return setErreur(messageErreur(error));
    setNouvelle(data as { cle: string; pour: string; expire_le: string });
    setNom('');
    setEmail('');
    await charger();
  }
  async function annuler(c: Cle) {
    if (!window.confirm(`Annuler la clé …${c.indice} de ${c.pour ?? 'cette personne'} ? Elle ne pourra plus servir.`)) return;
    const { data, error } = await supabase.rpc('cle_acces_annuler', { p_id: c.id });
    if (error) return setErreur(messageErreur(error));
    setCles((data as Cle[]) ?? []);
  }

  return (
    <section className="carte">
      <h2>🔑 Clés d’accès personnelles</h2>
      <p className="secondaire">
        {org
          ? 'Une clé ouvre un nouvel appareil sans attendre votre approbation, ou permet à une personne invitée de créer son compte. Elle sert une seule fois et expire.'
          : 'Clé à remettre à un futur gérant : sans elle, impossible de créer un compte sur DF Gestion. Elle sert une seule fois et expire.'}{' '}
        Transmettez-la en main propre ou par message privé.
      </p>
      <Alerte>{erreur}</Alerte>
      {nouvelle && (
        <div className="cle-nouvelle" role="status">
          <span>Clé pour <b>{nouvelle.pour ?? 'la personne'}</b> — notez-la maintenant, elle ne sera plus affichée :</span>
          <code className="cle-code">{nouvelle.cle}</code>
          <span className="secondaire petit">Valable jusqu’au {dateHeure(nouvelle.expire_le)}, une seule fois.</span>
          <button
            type="button"
            className="bouton bouton-discret"
            onClick={() => void navigator.clipboard?.writeText(nouvelle.cle).then(() => setCopie(true)).catch(() => undefined)}
          >
            {copie ? '✅ Copiée' : '📋 Copier la clé'}
          </button>
        </div>
      )}
      <form className="formulaire grille-cle" onSubmit={(e) => void creer(e)}>
        {org && (
          <Champ label="Pour qui ?">
            <select value={pour} onChange={(e) => setPour(e.target.value)}>
              <option value="">Nouvelle personne (création du compte)</option>
              {membres.map((m) => (
                <option key={m.user_id} value={m.user_id}>{m.nom} — nouvel appareil</option>
              ))}
            </select>
          </Champ>
        )}
        {!pour && (
          <>
            <Champ label="Nom">
              <input value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Awa Koné" maxLength={80} />
            </Champ>
            <Champ label="Son adresse e-mail" aide="La clé ne servira qu’à cette adresse (conseillé).">
              <input value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" placeholder="awa@exemple.ci" maxLength={120} />
            </Champ>
          </>
        )}
        <Champ label="Valable">
          <select value={jours} onChange={(e) => setJours(Number(e.target.value))}>
            <option value={1}>24 heures</option>
            <option value={3}>3 jours</option>
            <option value={7}>7 jours</option>
            <option value={30}>30 jours</option>
          </select>
        </Champ>
        <button className="bouton bouton-principal" disabled={!pour && !nom.trim() && !email.trim()}>Créer une clé</button>
      </form>
      {cles && cles.length > 0 && (
        <div className="tableau-defilant">
          <table className="tableau">
            <thead>
              <tr><th>Clé</th><th>Pour</th><th>Statut</th><th className="col-secondaire">Créée</th><th>Expire / utilisée</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {cles.map((c) => (
                <tr key={c.id}>
                  <td><code>DFG-••••-•{c.indice.slice(-1)}</code></td>
                  <td>{c.pour ?? '—'}{c.email ? <div className="secondaire petit">{c.email}</div> : null}</td>
                  <td><Pastille ton={STATUT_CLE[c.statut].ton}>{STATUT_CLE[c.statut].libelle}</Pastille></td>
                  <td className="col-secondaire">{dateHeure(c.cree_le)}{c.cree_par ? <div className="secondaire petit">par {c.cree_par}</div> : null}</td>
                  <td>
                    {c.utilisee_le ? <>{dateHeure(c.utilisee_le)}<div className="secondaire petit">par {c.utilisee_par}</div></> : c.annulee_le ? dateHeure(c.annulee_le) : dateHeure(c.expire_le)}
                  </td>
                  <td>
                    {(c.statut === 'active' || c.statut === 'compte_cree') && (
                      <button type="button" className="bouton-lien lien-danger" onClick={() => void annuler(c)}>Annuler</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* --------------------------------------------------------------------------------------------
 * Page « Accès et appareils » de la gérante principale.
 * ------------------------------------------------------------------------------------------ */
interface Appareil {
  id: string;
  user_id: string;
  nom: string | null;
  libelle: string | null;
  statut: 'en_attente' | 'approuve' | 'refuse' | 'revoque';
  via: string | null;
  demande_le: string;
  decide_le: string | null;
  decide_par: string | null;
  vu_le: string | null;
  moi: boolean;
  courant: boolean;
}
interface Liste {
  exige: boolean;
  session_approuvee: boolean;
  appareils: Appareil[];
}
const VIA: Record<string, string> = { gerante: 'approuvé par la gérante', cle: 'ouvert avec une clé', automatique: 'déjà utilisé avant l’activation', administrateur: 'approuvé par l’administrateur' };

export function AccesAppareils() {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const [liste, setListe] = useState<Liste | null>(null);
  const [membres, setMembres] = useState<Membre[]>([]);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');

  const charger = useCallback(async () => {
    const { data, error } = await supabase.rpc('appareils_liste', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    setListe(data as Liste);
  }, [org]);
  useEffect(() => {
    void charger();
    const id = window.setInterval(() => void charger(), 15000);
    void (async () => {
      const { data: mb } = await supabase.from('membres').select('user_id').eq('organisation_id', org).eq('actif', true);
      const ids = (mb ?? []).map((m: { user_id: string }) => m.user_id);
      if (!ids.length) return;
      const { data } = await supabase.from('profils').select('id, nom_complet, email').in('id', ids);
      type P = { id: string; nom_complet: string | null; email: string | null };
      setMembres(((data ?? []) as P[]).map((p) => ({ user_id: p.id, nom: p.nom_complet || p.email || 'Membre' })).sort((x, y) => x.nom.localeCompare(y.nom, 'fr')));
    })();
    return () => window.clearInterval(id);
  }, [charger, org]);

  async function decider(a: Appareil, d: 'approuve' | 'refuse' | 'revoque') {
    setErreur('');
    if (d === 'revoque' && !window.confirm(`Retirer l’accès de ${a.nom} depuis « ${a.libelle} » ? La personne sera déconnectée de cet appareil.`)) return;
    const { data, error } = await supabase.rpc('appareil_decider', { p_id: a.id, p_decision: d });
    if (error) return setErreur(messageErreur(error));
    setListe(data as Liste);
    setInfo(d === 'approuve' ? `Appareil de ${a.nom} approuvé : DF Gestion s’ouvre chez elle.` : d === 'refuse' ? 'Demande refusée.' : 'Accès retiré.');
  }
  async function exiger(v: boolean) {
    setErreur('');
    if (!v && !window.confirm('Désactiver la protection ? Tout appareil pourra de nouveau ouvrir DF Gestion avec un mot de passe.')) return;
    const { data, error } = await supabase.rpc('appareils_exiger', { p_org: org, p_exiger: v });
    if (error) return setErreur(messageErreur(error));
    setListe(data as Liste);
    setInfo(v ? 'Protection activée : tout nouvel appareil devra être approuvé (ou ouvert avec une clé).' : 'Protection désactivée.');
  }

  const attente = (liste?.appareils ?? []).filter((a) => a.statut === 'en_attente');
  const approuves = (liste?.appareils ?? []).filter((a) => a.statut === 'approuve');
  const autres = (liste?.appareils ?? []).filter((a) => a.statut === 'refuse' || a.statut === 'revoque');

  return (
    <>
      <EnTetePage icone="🔐" titre="Accès et appareils" sousTitre="DF Gestion n’est ouvert qu’aux appareils que vous avez approuvés et aux personnes à qui vous avez remis une clé." />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      <section className="carte">
        <h2>📱 Appareils approuvés</h2>
        <div className="acces-reglage">
          <button
            type="button"
            role="switch"
            aria-checked={!!liste?.exige}
            className={`commutateur-en-ligne ${liste?.exige ? 'allume' : 'eteint'}`}
            onClick={() => void exiger(!liste?.exige)}
          >
            <span className="commutateur-piste" aria-hidden><span className="commutateur-bouton" /></span>
            <span className="commutateur-texte">{liste?.exige ? 'Protection active' : 'Protection désactivée'}</span>
          </button>
          <p className="secondaire">
            Active : une connexion depuis un téléphone ou un ordinateur inconnu reste fermée tant que vous ne l’avez pas approuvée (ou
            que la personne n’a pas saisi sa clé). Un mot de passe volé ne suffit plus. Les appareils déjà utilisés restent reconnus.
          </p>
        </div>

        {attente.length > 0 && (
          <>
            <h3>⏳ En attente ({attente.length})</h3>
            <ul className="liste-appareils">
              {attente.map((a) => (
                <li key={a.id} className="appareil-attente">
                  <span>
                    <strong>{a.nom}</strong> — {a.libelle ?? 'Appareil'}
                    <div className="secondaire petit">demandé le {dateHeure(a.demande_le)}</div>
                  </span>
                  <span className="actions-appareil">
                    <button type="button" className="bouton bouton-discret" onClick={() => void decider(a, 'refuse')}>Refuser</button>
                    <button type="button" className="bouton bouton-principal" onClick={() => void decider(a, 'approuve')}>✅ Approuver</button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <h3>✅ Approuvés ({approuves.length})</h3>
        <ul className="liste-appareils">
          {approuves.map((a) => (
            <li key={a.id}>
              <span>
                <strong>{a.nom}</strong>{a.moi ? ' (vous)' : ''} — {a.libelle ?? 'Appareil'} {a.courant && <Pastille ton="bleu">cet appareil</Pastille>}
                <div className="secondaire petit">
                  {a.via ? VIA[a.via] ?? a.via : ''}{a.decide_par && a.via !== 'automatique' ? ` (${a.decide_par})` : ''}
                  {a.vu_le ? ` · vu le ${dateHeure(a.vu_le)}` : ''}
                </div>
              </span>
              {!a.courant && <button type="button" className="bouton-lien lien-danger" onClick={() => void decider(a, 'revoque')}>Retirer l’accès</button>}
            </li>
          ))}
          {approuves.length === 0 && <li className="secondaire">Aucun appareil pour l’instant.</li>}
        </ul>
        {autres.length > 0 && (
          <details className="appareils-refuses">
            <summary>Refusés ou retirés ({autres.length})</summary>
            <ul className="liste-appareils">
              {autres.map((a) => (
                <li key={a.id}>
                  <span>
                    <strong>{a.nom}</strong> — {a.libelle ?? 'Appareil'}
                    <div className="secondaire petit">{a.statut === 'refuse' ? 'refusé' : 'retiré'} le {dateHeure(a.decide_le)}{a.decide_par ? ` par ${a.decide_par}` : ''}</div>
                  </span>
                  <button type="button" className="bouton-lien" onClick={() => void decider(a, 'approuve')}>Rétablir</button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <ClesAcces org={org} membres={membres} />
      <p className="secondaire petit">Chaque approbation, refus, clé créée, utilisée, refusée ou annulée est inscrite au journal d’audit.</p>
    </>
  );
}

/* --------------------------------------------------------------------------------------------
 * Code de connexion Telegram : demandé après le mot de passe (ou le code d'entrée).
 * ------------------------------------------------------------------------------------------ */
interface EtatOtp {
  exige: boolean;
  verifie?: boolean;
  telegram?: string;
  envoye_le?: string | null;
  expire_le?: string | null;
  envoi?: { recu?: boolean; statut?: number | null; erreur?: string | null; texte?: string } | null;
}

/** La réponse du robot Telegram signale-t-elle un échec ? */
function envoiEchoue(e: EtatOtp['envoi']): string | null {
  if (!e) return null;
  if (e.erreur) return e.erreur;
  const t = (e.texte ?? '').trim();
  if (Number(e.statut) >= 400 || /error|invalid|not\s+(allowed|authori[sz]ed|registered|found)|blocked|unauthori[sz]ed|start/i.test(t))
    return t || `Réponse ${e.statut}`;
  return null;
}

export function CodeTelegram() {
  const { organisation, verifierAppareil, deconnecter } = useSession();
  const org = organisation!.organisation_id;
  const [chiffres, setChiffres] = useState<string[]>(['', '', '', '', '', '']);
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [maintenant, setMaintenant] = useState(() => Date.now());
  const [dernierEnvoi, setDernierEnvoi] = useState<number>(0);
  const [echec, setEchec] = useState(false);
  const cases = useRef<(HTMLInputElement | null)[]>([]);
  const envoiAuto = useRef(false);

  const lire = useCallback(async () => {
    const { data } = await supabase.rpc('otp_etat', { p_org: org });
    const e = data as EtatOtp | null;
    if (!e) return null;
    setEchec(!!envoiEchoue(e.envoi));
    if (!e.exige || e.verifie) await verifierAppareil(); // autorisée par la gérante, ou code retiré
    return e;
  }, [org, verifierAppareil]);

  const envoyer = useCallback(async () => {
    setErreur('');
    setEchec(false);
    const { error } = await supabase.rpc('otp_envoyer', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    setDernierEnvoi(Date.now());
    setChiffres(['', '', '', '', '', '']);
    cases.current[0]?.focus();
    window.setTimeout(() => void lire(), 4000);
    window.setTimeout(() => void lire(), 9000);
  }, [org, lire]);

  useEffect(() => {
    void (async () => {
      const e = await lire();
      const valable = e?.expire_le && new Date(e.expire_le).getTime() > Date.now() + 20000;
      if (e?.exige && !e.verifie && !envoiAuto.current) {
        envoiAuto.current = true;
        if (valable) setDernierEnvoi(new Date(e.envoye_le ?? Date.now()).getTime());
        else await envoyer();
      }
    })();
    const t = window.setInterval(() => setMaintenant(Date.now()), 1000);
    const p = window.setInterval(() => void lire(), 6000);
    return () => {
      window.clearInterval(t);
      window.clearInterval(p);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function valider(code: string) {
    setEnCours(true);
    setErreur('');
    const { data, error } = await supabase.rpc('otp_verifier', { p_org: org, p_code: code });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    const r = data as { statut: string; message?: string };
    if (r.statut === 'verifie') {
      await verifierAppareil();
      return;
    }
    setChiffres(['', '', '', '', '', '']);
    cases.current[0]?.focus();
    setErreur(r.message ?? 'Code incorrect');
  }

  function saisir(i: number, v: string) {
    const d = v.replace(/\D/g, '');
    const suite = [...chiffres];
    if (d.length > 1) {
      // Code collé (ou proposé par le téléphone) : on remplit toutes les bulles.
      d.slice(0, 6).split('').forEach((c, k) => (suite[k] = c));
    } else suite[i] = d;
    setChiffres(suite);
    setErreur('');
    const prochaine = d.length > 1 ? Math.min(5, d.length) : d ? i + 1 : i;
    if (prochaine <= 5) cases.current[prochaine]?.focus();
    const code = suite.join('');
    if (code.length === 6 && !enCours) void valider(code);
  }

  const attendre = Math.max(0, 30 - Math.round((maintenant - dernierEnvoi) / 1000));
  return (
    <main className="page-acces">
      <section className="carte carte-acces carte-otp">
        <div className="acces-icone" aria-hidden>🔐</div>
        <h1>Entrez le code OTP</h1>
        <div className="bulles-otp" role="group" aria-label="Code OTP à 6 chiffres">
          {chiffres.map((c, i) => (
            <input
              key={i}
              ref={(el) => {
                cases.current[i] = el;
              }}
              value={c}
              onChange={(e) => saisir(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Backspace' && !chiffres[i] && i > 0) cases.current[i - 1]?.focus();
              }}
              inputMode="numeric"
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              maxLength={i === 0 ? 6 : 1}
              autoFocus={i === 0}
              disabled={enCours}
              aria-label={`Chiffre ${i + 1}`}
              className={c ? 'rempli' : ''}
            />
          ))}
        </div>
        {(erreur || echec) && <p className="erreur-otp">{erreur || 'Le code n’a pas pu être envoyé : renvoyez-le ou prévenez votre gérante.'}</p>}
        {enCours && <p className="secondaire">Vérification…</p>}
        <button type="button" className="bouton-lien renvoyer-otp" disabled={attendre > 0} onClick={() => void envoyer()}>
          {attendre > 0 ? `Renvoyer le code dans ${attendre} s` : '↻ Renvoyer le code'}
        </button>
        <button type="button" className="bouton-lien secondaire petit" onClick={() => void deconnecter()}>Se déconnecter</button>
      </section>
    </main>
  );
}

/* --------------------------------------------------------------------------------------------
 * Fenêtre de la gérante : Telegram d'une personne (notifications et, au choix, code OTP).
 * ------------------------------------------------------------------------------------------ */
export function ReglageTelegram({
  org,
  userId,
  email,
  nom,
  actuel,
  relie = false,
  otp = true,
  otpParDefaut = true,
  onFait,
}: {
  org: string;
  userId?: string;
  email?: string;
  nom: string;
  actuel?: string | null;
  /** Telegram déjà relié au robot. */
  relie?: boolean;
  /** Code OTP demandé à chaque connexion (sinon : notifications seulement). */
  otp?: boolean;
  otpParDefaut?: boolean;
  onFait: (texte: string) => void;
}) {
  const [avecOtp, setAvecOtp] = useState(otpParDefaut);
  const [robot, setRobot] = useState<{ configure: boolean; robot?: string } | null>(null);
  const [tg, setTg] = useState(actuel ?? '');
  const [lien, setLien] = useState<string | null>(null);
  const [erreur, setErreur] = useState('');
  const [copie, setCopie] = useState(false);
  useEffect(() => {
    void supabase.rpc('telegram_robot_etat').then(({ data }) => setRobot((data as { configure: boolean; robot?: string }) ?? { configure: false }));
  }, []);

  async function creerLien() {
    setErreur('');
    const { data, error } = await supabase.rpc('otp_lien', { p_org: org, p_user: userId ?? null, p_email: email ?? null, p_otp: avecOtp });
    if (error) return setErreur(messageErreur(error));
    setLien((data as { lien: string }).lien);
  }
  async function enregistrer(e: FormEvent, retirer = false) {
    e.preventDefault();
    setErreur('');
    const { error } = await supabase.rpc('otp_configurer', {
      p_org: org, p_user: userId ?? null, p_telegram: retirer ? null : tg.trim(), p_actif: !retirer, p_email: email ?? null,
    });
    if (error) return setErreur(messageErreur(error));
    onFait(retirer ? `Telegram délié pour ${nom} : plus de notifications ni de code OTP.` : `Code OTP activé pour ${nom} : il lui sera demandé à chaque connexion.`);
  }
  async function basculer(v: boolean) {
    setErreur('');
    const { error } = await supabase.rpc('otp_basculer', { p_org: org, p_user: userId ?? null, p_otp: v });
    if (error) return setErreur(messageErreur(error));
    onFait(v ? `Code OTP activé pour ${nom} : il lui sera demandé à chaque connexion.` : `Code OTP retiré pour ${nom} : son Telegram reçoit toujours les notifications.`);
  }
  const message = lien
    ? `Bonjour ${nom}, pour recevoir sur Telegram vos notifications DF Gestion${avecOtp ? ' et vos codes de connexion' : ''}, ouvrez ce lien sur votre téléphone puis touchez « Démarrer » : ${lien}`
    : '';

  if (!robot) return <p className="secondaire">Chargement…</p>;
  return (
    <div className="formulaire">
      <p>
        Le robot {robot.robot ?? 'Telegram'} envoie à <b>{nom}</b> les <b>notifications</b> des commandes en ligne (nouvelle commande, affectation,
        acceptée, prête, livrée…). Avec le <b>code OTP</b>, il lui envoie aussi un code à 6 chiffres à chaque connexion ; après 4 heures sans
        activité, il faut se reconnecter puis saisir un nouveau code.
      </p>
      {robot.configure ? (
        <>
          {relie && !lien && userId && (
            <p className="secondaire">
              {otp ? '🔐 Code OTP demandé à chaque connexion.' : '📲 Notifications seulement (pas de code OTP).'}{' '}
              <button type="button" className="bouton-lien" onClick={() => void basculer(!otp)}>
                {otp ? 'Garder les notifications sans code OTP' : 'Activer aussi le code OTP'}
              </button>
            </p>
          )}
          {!lien ? (
            <>
              {!relie && (
                <label className="case">
                  <input type="checkbox" checked={avecOtp} onChange={(e) => setAvecOtp(e.target.checked)} />
                  <span>🔐 Demander aussi un code OTP à chaque connexion</span>
                </label>
              )}
              <button type="button" className="bouton bouton-principal" onClick={() => void creerLien()}>
                {relie || actuel ? '🔁 Relier un autre Telegram' : '🔗 Créer le lien d’activation'}
              </button>
            </>
          ) : (
            <div className="cle-nouvelle">
              <span>Envoyez ce lien à <b>{nom}</b> : elle l’ouvre sur son téléphone et touche « Démarrer ». Valable 7 jours.</span>
              <code className="lien-activation">{lien}</code>
              <div className="actions-piece">
                <button type="button" className="bouton bouton-discret" onClick={() => void navigator.clipboard?.writeText(lien).then(() => setCopie(true)).catch(() => undefined)}>
                  {copie ? '✅ Copié' : '📋 Copier'}
                </button>
                <a className="bouton bouton-discret" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">💬 Envoyer par WhatsApp</a>
                <button type="button" className="bouton bouton-principal" onClick={() => onFait(`Lien d’activation créé pour ${nom} : dès qu’elle aura touché « Démarrer », elle recevra les notifications${avecOtp ? ' et le code OTP sera demandé' : ''}.`)}>Terminé</button>
              </div>
            </div>
          )}
          {actuel && <p className="secondaire petit">Relié : {actuel}</p>}
        </>
      ) : (
        <form className="formulaire" onSubmit={(e) => void enregistrer(e)}>
          <Alerte type="info">Le robot DF Gestion n’est pas encore configuré (Administration › Robot Telegram). En attendant, le code passe par le robot CallMeBot.</Alerte>
          <ol className="etapes-alerte">
            <li>Depuis le Telegram de la personne, ouvrez <a href="https://t.me/CallMeBot_txtbot" target="_blank" rel="noreferrer">@CallMeBot_txtbot</a> et envoyez <code>/start</code>.</li>
            <li>Saisissez son nom d’utilisateur Telegram ci-dessous.</li>
          </ol>
          <Champ label="Nom d’utilisateur Telegram">
            <input value={tg} onChange={(e) => setTg(e.target.value)} placeholder="@awa_kone" autoComplete="off" autoCapitalize="none" required />
          </Champ>
          <button className="bouton bouton-principal">{actuel ? 'Enregistrer' : 'Activer le code OTP'}</button>
        </form>
      )}
      <Alerte>{erreur}</Alerte>
      {(actuel || relie) && (
        <button type="button" className="bouton-lien lien-danger" onClick={(e) => void enregistrer(e as unknown as FormEvent, true)}>
          {relie ? 'Délier ce Telegram (plus de notifications ni de code OTP)' : 'Retirer le code OTP'}
        </button>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------
 * Administration : le robot Telegram « DF Gestion » (nom, description, logo).
 * ------------------------------------------------------------------------------------------ */
async function logoEnJpeg(source: File | string): Promise<string> {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((ok, ko) => {
    img.onload = () => ok();
    img.onerror = () => ko(new Error('Image illisible'));
    img.src = url;
  });
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 640;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 640, 640);
  const k = Math.min(640 / img.width, 640 / img.height);
  const w = img.width * k;
  const h = img.height * k;
  g.drawImage(img, (640 - w) / 2, (640 - h) / 2, w, h);
  if (typeof source !== 'string') URL.revokeObjectURL(url);
  return c.toDataURL('image/jpeg', 0.9);
}

export function RobotTelegram() {
  const [etat, setEtat] = useState<{ configure: boolean; robot?: string; nom?: string; le?: string } | null>(null);
  const [jeton, setJeton] = useState('');
  const [nom, setNom] = useState('DF Gestion');
  const [description, setDescription] = useState('');
  const [logo, setLogo] = useState<string | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [enCours, setEnCours] = useState(false);
  const charger = useCallback(async () => {
    const { data } = await supabase.rpc('telegram_robot_etat');
    const e = (data as { configure: boolean; robot?: string; nom?: string; le?: string }) ?? { configure: false };
    setEtat(e);
    if (e.nom) setNom(e.nom);
  }, []);
  useEffect(() => {
    void charger();
    void logoEnJpeg('/icone-512.png').then(setLogo).catch(() => undefined);
  }, [charger]);

  async function configurer(e: FormEvent) {
    e.preventDefault();
    setErreur('');
    setInfo('');
    setEnCours(true);
    const { data, error } = await supabase.functions.invoke('telegram', {
      body: { action: 'configurer', jeton: jeton.trim() || undefined, nom, description: description || undefined, logo: logo ?? undefined },
    });
    setEnCours(false);
    const r = (data ?? {}) as { ok?: boolean; message?: string; robot?: string; avertissements?: string[] };
    if (error && !r.message) {
      let m = 'Service indisponible, réessayez.';
      try {
        const c = (await (error as { context?: Response }).context?.json()) as { message?: string } | undefined;
        if (c?.message) m = c.message;
      } catch {
        /* rien */
      }
      return setErreur(m);
    }
    if (!r.ok) return setErreur(r.message ?? 'Configuration impossible');
    setJeton('');
    setInfo(`Robot ${r.robot} prêt : nom, description${logo ? ', logo' : ''} et réception des « Démarrer » réglés.${r.avertissements?.length ? ` À noter : ${r.avertissements.join(' ; ')}` : ''}`);
    await charger();
  }

  return (
    <section className="carte">
      <h2>🤖 Robot Telegram {etat?.configure ? <Pastille ton="vert">{etat.robot}</Pastille> : <Pastille ton="or">à configurer</Pastille>}</h2>
      <p className="secondaire">
        Votre propre robot, à votre nom et avec votre logo, envoie les codes OTP de connexion. Son jeton reste sur le serveur : il n’est
        jamais réaffiché.
      </p>
      {!etat?.configure && (
        <ol className="etapes-alerte">
          <li>Dans Telegram, ouvrez <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> et envoyez <code>/newbot</code>.</li>
          <li>Donnez un nom (ex. DF Gestion) puis un identifiant qui finit par « bot » (ex. dfgestion_ci_bot).</li>
          <li>Copiez le jeton reçu (123456789:AA…) et collez-le ci-dessous.</li>
        </ol>
      )}
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      <form className="formulaire" onSubmit={(e) => void configurer(e)}>
        <Champ label={etat?.configure ? 'Nouveau jeton (laisser vide pour garder l’actuel)' : 'Jeton du robot (BotFather)'}>
          <input type="password" value={jeton} onChange={(e) => setJeton(e.target.value)} autoComplete="off" required={!etat?.configure} placeholder="123456789:AA…" />
        </Champ>
        <div className="grille-2">
          <Champ label="Nom affiché">
            <input value={nom} onChange={(e) => setNom(e.target.value)} maxLength={64} required />
          </Champ>
          <Champ label="Logo (photo du robot)" aide="Carré conseillé ; le logo DF Gestion est proposé par défaut.">
            <div className="logo-robot">
              {logo && <img src={logo} alt="" width={56} height={56} />}
              <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && void logoEnJpeg(e.target.files[0]).then(setLogo).catch((x: Error) => setErreur(x.message))} />
            </div>
          </Champ>
        </div>
        <Champ label="Description (facultatif)" aide="Visible quand la personne ouvre le robot.">
          <textarea rows={2} maxLength={512} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Robot officiel DF Gestion : il vous envoie vos codes OTP de connexion." />
        </Champ>
        <button className="bouton bouton-principal" disabled={enCours}>{enCours ? 'Configuration…' : etat?.configure ? 'Mettre à jour le robot' : 'Configurer le robot'}</button>
      </form>
    </section>
  );
}
