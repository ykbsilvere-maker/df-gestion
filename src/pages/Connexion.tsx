import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { sourceConfiguration } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';
import { Alerte, Champ } from '../components/ui';
import { MarqueDecodeur } from '../components/Marque';
import {
  codeEntrepriseMemorise,
  emailEmploye,
  identifiantAffiche,
  lireAccesEmploye,
  memoriserCodeEntreprise,
  normaliserCode,
  normaliserMatricule,
} from '../lib/acces';

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
  const [email, setEmail] = useState(() => (lireAccesEmploye(lireRecents()[0]) ? '' : (lireRecents()[0] ?? '')));
  // Employés : code entreprise + matricule + code secret ; gérant principal : adresse e-mail.
  const [type, setType] = useState<'employe' | 'email'>(() => {
    const dernier = lireRecents()[0];
    return dernier ? (lireAccesEmploye(dernier) ? 'employe' : 'email') : 'employe';
  });
  const [codeEntreprise, setCodeEntreprise] = useState(() => lireAccesEmploye(lireRecents()[0])?.code ?? codeEntrepriseMemorise());
  const [matricule, setMatricule] = useState(() => lireAccesEmploye(lireRecents()[0])?.matricule ?? '');
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
    if (premiere) {
      setMode('inscription');
      setType('email');
    }
  }, [premiere]);
  const parMatricule = mode === 'connexion' && type === 'employe';

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    if (envoi) return;
    setErreur('');
    setInfo('');
    setEnvoi(true);
    try {
      if (mode === 'connexion') {
        const identifiant = parMatricule ? emailEmploye(codeEntreprise, matricule) : email.trim();
        const { error } = await supabase.auth.signInWithPassword({ email: identifiant, password: motDePasse });
        if (error) {
          if (parMatricule && /invalid login|credentials/i.test(error.message))
            throw new Error('Code entreprise, matricule ou code secret incorrect.');
          throw error;
        }
        memoriser(identifiant.toLowerCase());
        if (parMatricule) memoriserCodeEntreprise(codeEntreprise);
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
                  <button
                    type="button"
                    onClick={() => {
                      const a = lireAccesEmploye(r);
                      if (a) {
                        setType('employe');
                        setCodeEntreprise(a.code);
                        setMatricule(a.matricule);
                      } else {
                        setType('email');
                        setEmail(r);
                      }
                    }}
                    title={identifiantAffiche(r)}
                  >
                    <span className="compte-recent-initiale">{lireAccesEmploye(r) ? '#' : r.charAt(0).toUpperCase()}</span>
                    <span className="compte-recent-email">
                      {lireAccesEmploye(r) ? `${identifiantAffiche(r)} · ${lireAccesEmploye(r)!.code}` : r}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="compte-recent-retirer"
                    aria-label={`Oublier ${identifiantAffiche(r)} sur cet appareil`}
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

          {mode === 'connexion' && !premiere && (
            <div className="onglets-connexion" role="tablist" aria-label="Type d’accès">
              <button type="button" role="tab" aria-selected={type === 'employe'} className={type === 'employe' ? 'actif' : ''} onClick={() => setType('employe')}>
                👤 Employé (matricule)
              </button>
              <button type="button" role="tab" aria-selected={type === 'email'} className={type === 'email' ? 'actif' : ''} onClick={() => setType('email')}>
                ✉️ Gérant (e-mail)
              </button>
            </div>
          )}
          {mode === 'inscription' && (
            <Champ label="Nom et prénoms">
              <input value={nom} onChange={(e) => setNom(e.target.value)} required autoComplete="name" />
            </Champ>
          )}
          {parMatricule ? (
            <div className="grille-acces">
              <Champ label="Code entreprise" aide="Donné par votre gérant ; retenu sur cet appareil.">
                <input
                  value={codeEntreprise}
                  onChange={(e) => setCodeEntreprise(normaliserCode(e.target.value))}
                  required
                  minLength={4}
                  maxLength={10}
                  autoCapitalize="characters"
                  autoComplete="organization"
                  placeholder="ex. BOUT78"
                  className="champ-code"
                />
              </Champ>
              <Champ label="Matricule">
                <input
                  value={matricule}
                  onChange={(e) => setMatricule(normaliserMatricule(e.target.value).toUpperCase())}
                  required
                  maxLength={12}
                  autoComplete="username"
                  placeholder="ex. 0012"
                  className="champ-code"
                  autoFocus={!!codeEntreprise && !matricule}
                />
              </Champ>
            </div>
          ) : (
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
          )}
          {mode !== 'oubli' && (
            <Champ label={parMatricule ? 'Code secret' : 'Mot de passe'} aide={mode === 'inscription' ? '8 caractères minimum' : undefined}>
              <div className="champ-mot-de-passe">
                <input
                  type={voirMotDePasse ? 'text' : 'password'}
                  value={motDePasse}
                  onChange={(e) => setMotDePasse(e.target.value)}
                  required
                  minLength={mode === 'inscription' ? 8 : undefined}
                  autoComplete={mode === 'inscription' ? 'new-password' : 'current-password'}
                  autoFocus={mode === 'connexion' && (parMatricule ? !!matricule : !!email)}
                  inputMode={parMatricule ? 'numeric' : undefined}
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
            {mode !== 'inscription' && !parMatricule && (
              <button type="button" className="bouton-lien" onClick={() => setMode('inscription')}>
                {fermee ? 'J’ai été invité : créer mon compte' : 'Créer un compte'}
              </button>
            )}
            {mode === 'connexion' && !parMatricule && (
              <button type="button" className="bouton-lien" onClick={() => setMode('oubli')}>
                Mot de passe oublié
              </button>
            )}
            {parMatricule && <span className="secondaire">Code secret oublié ? Votre gérant vous en donne un nouveau.</span>}
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
