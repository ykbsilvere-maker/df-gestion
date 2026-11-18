import { useCallback, useEffect, useState, type FormEvent } from 'react';
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
