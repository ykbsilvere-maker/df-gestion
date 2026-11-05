import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { sourceConfiguration } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';
import { Alerte, Champ } from '../components/ui';
import { MarqueDecodeur } from '../components/Marque';

type Mode = 'connexion' | 'inscription' | 'oubli';

/** Comptes récemment utilisés sur cet appareil (adresse seulement, jamais le mot de passe). */
const CLE_RECENTS = 'dfg_comptes_recents';
function lireRecents(): string[] {
  try {
    return (JSON.parse(localStorage.getItem(CLE_RECENTS) ?? '[]') as string[]).slice(0, 4);
  } catch {
    return [];
  }
}
function memoriser(email: string) {
  try {
    const l = [email, ...lireRecents().filter((e) => e !== email)].slice(0, 4);
    localStorage.setItem(CLE_RECENTS, JSON.stringify(l));
  } catch {
    /* stockage indisponible */
  }
}
function oublier(email: string) {
  try {
    localStorage.setItem(CLE_RECENTS, JSON.stringify(lireRecents().filter((e) => e !== email)));
  } catch {
    /* stockage indisponible */
  }
}

export function Connexion() {
  const [mode, setMode] = useState<Mode>('connexion');
  const [recents, setRecents] = useState<string[]>(lireRecents);
  const [email, setEmail] = useState(() => lireRecents()[0] ?? '');
  const [voirMotDePasse, setVoirMotDePasse] = useState(false);
  const [motDePasse, setMotDePasse] = useState('');
  const [nom, setNom] = useState('');
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const { apresConnexion, plateforme, rechargerPlateforme } = useSession();
  const naviguer = useNavigate();
  // Première installation : aucun administrateur général encore désigné.
  const premiere = plateforme?.admin_existe === false;
  const fermee = !!plateforme && plateforme.admin_existe && !plateforme.inscription_libre;
  useEffect(() => {
    if (premiere) setMode('inscription');
  }, [premiere]);

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    if (envoi) return;
    setErreur('');
    setInfo('');
    setEnvoi(true);
    try {
      if (mode === 'connexion') {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: motDePasse });
        if (error) throw error;
        memoriser(email.trim().toLowerCase());
        await apresConnexion();
        naviguer('/');
      } else if (mode === 'inscription') {
        if (motDePasse.length < 8) throw new Error('Le mot de passe doit contenir au moins 8 caractères.');
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password: motDePasse,
          options: { data: { nom_complet: nom.trim() }, emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        if (data.session) {
          await apresConnexion();
          if (premiere) {
            // Le premier compte de l'installation devient administrateur général.
            const { error: e2 } = await supabase.rpc('devenir_admin_general');
            if (!e2) {
              await rechargerPlateforme();
              naviguer('/administration');
              return;
            }
          }
          naviguer('/');
        } else {
          setInfo('Compte créé. Ouvrez le lien reçu par e-mail pour confirmer votre adresse, puis connectez-vous.');
          setMode('connexion');
        }
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/nouveau-mot-de-passe`,
        });
        if (error) throw error;
        setInfo('Si un compte existe pour cette adresse, un lien de réinitialisation vient d’être envoyé.');
      }
    } catch (err) {
      setErreur(messageErreur(err));
    } finally {
      setEnvoi(false);
    }
  }

  const titres: Record<Mode, string> = {
    connexion: 'Connexion',
    inscription: premiere ? 'Créer le compte administrateur' : 'Créer un compte',
    oubli: 'Mot de passe oublié',
  };

  return (
    <div className="page-connexion">
      <aside className="connexion-vitrine" aria-hidden>
        <div className="vitrine-contenu">
          <span className="vitrine-badge">DF Gestion</span>
          <h2>Votre commerce, en un coup d’œil.</h2>
          <p>Caisse, stock, fournisseurs, budget, trésorerie et comptabilité SYSCOHADA, sur téléphone, terminal et ordinateur.</p>
          <ul className="vitrine-points">
            <li><span>🛒</span>Caisse rapide, même sans réseau</li>
            <li><span>📦</span>Stock et arrivages contrôlés</li>
            <li><span>💰</span>Trésorerie et créances suivies</li>
            <li><span>📊</span>Tableau de bord en temps réel</li>
          </ul>
          <div className="vitrine-carte">
            <span className="secondaire">Chiffre d’affaires du mois</span>
            <strong>+ 12,5 %</strong>
            <div className="vitrine-barres">
              {[30, 45, 38, 60, 52, 75, 90].map((h, i) => (
                <span key={i} style={{ height: `${h}%` }} />
              ))}
            </div>
          </div>
        </div>
      </aside>
      <section className="panneau-public connexion-panneau">
        <MarqueDecodeur sousTitre="Caisse, stock et pilotage de votre commerce" />

        <form className="carte formulaire carte-connexion" onSubmit={soumettre}>
          <h1>{titres[mode]}</h1>
          {mode === 'connexion' && recents.length > 0 && (
            <div className="comptes-recents" aria-label="Comptes récents sur cet appareil">
              {recents.map((r) => (
                <span key={r} className={`compte-recent ${r === email ? 'actif' : ''}`}>
                  <button type="button" onClick={() => setEmail(r)} title={r}>
                    <span className="compte-recent-initiale">{r.charAt(0).toUpperCase()}</span>
                    <span className="compte-recent-email">{r}</span>
                  </button>
                  <button
                    type="button"
                    className="compte-recent-retirer"
                    aria-label={`Oublier ${r} sur cet appareil`}
                    onClick={() => {
                      oublier(r);
                      setRecents(lireRecents());
                      if (email === r) setEmail('');
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {premiere && mode === 'inscription' && (
            <Alerte type="info">
              Première installation : ce premier compte devient l’administrateur général. Il crée ensuite les entreprises et
              l’accès de leurs gérants.
            </Alerte>
          )}
          <Alerte>{erreur}</Alerte>
          <Alerte type="succes">{info}</Alerte>

          {mode === 'inscription' && (
            <Champ label="Nom et prénoms">
              <input value={nom} onChange={(e) => setNom(e.target.value)} required autoComplete="name" />
            </Champ>
          )}
          <Champ label="Adresse e-mail">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              inputMode="email"
            />
          </Champ>
          {mode !== 'oubli' && (
            <Champ label="Mot de passe" aide={mode === 'inscription' ? '8 caractères minimum' : undefined}>
              <div className="champ-mot-de-passe">
                <input
                  type={voirMotDePasse ? 'text' : 'password'}
                  value={motDePasse}
                  onChange={(e) => setMotDePasse(e.target.value)}
                  required
                  minLength={mode === 'inscription' ? 8 : undefined}
                  autoComplete={mode === 'inscription' ? 'new-password' : 'current-password'}
                  autoFocus={mode === 'connexion' && !!email}
                />
                <button
                  type="button"
                  className="voir-mot-de-passe"
                  onClick={() => setVoirMotDePasse((v) => !v)}
                  aria-label={voirMotDePasse ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                >
                  {voirMotDePasse ? '🙈' : '👁️'}
                </button>
              </div>
            </Champ>
          )}

          <button className="bouton bouton-principal bouton-plein" disabled={envoi}>
            {envoi
              ? 'Veuillez patienter…'
              : mode === 'connexion'
                ? 'Se connecter'
                : mode === 'inscription'
                  ? 'Créer mon compte'
                  : 'Recevoir le lien'}
          </button>

          <div className="liens-formulaire">
            {mode !== 'connexion' && (
              <button type="button" className="bouton-lien" onClick={() => setMode('connexion')}>
                J’ai déjà un compte
              </button>
            )}
            {mode !== 'inscription' && (
              <button type="button" className="bouton-lien" onClick={() => setMode('inscription')}>
                {fermee ? 'J’ai été invité : créer mon compte' : 'Créer un compte'}
              </button>
            )}
            {mode === 'connexion' && (
              <button type="button" className="bouton-lien" onClick={() => setMode('oubli')}>
                Mot de passe oublié
              </button>
            )}
          </div>
        </form>
        <p className="note-publique">
          {fermee
            ? 'Votre accès est créé par votre gérant ou par l’administrateur : connectez-vous avec l’identifiant et le mot de passe reçus.'
            : 'Invité par votre employeur ? Créez votre compte avec l’adresse e-mail communiquée : vous serez rattaché automatiquement à l’entreprise.'}
          {sourceConfiguration === 'appareil' && (
            <>
              {' '}
              <Link to="/configuration">Changer de serveur</Link>
            </>
          )}
        </p>
      </section>
    </div>
  );
}
