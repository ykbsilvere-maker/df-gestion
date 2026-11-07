import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { sourceConfiguration } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';
import { Alerte, Champ } from '../components/ui';
import { MarqueDecodeur } from '../components/Marque';
import { PaveCode } from '../components/PaveCode';
import {
  codeEntrepriseMemorise,
  connexionParCode,
  creerMonAcces,
  emailEmploye,
  identifiantAffiche,
  lireAccesEmploye,
  marquerVerrou,
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
  const [confirmation, setConfirmation] = useState('');
  const [nom, setNom] = useState('');
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const { apresConnexion, plateforme, rechargerPlateforme } = useSession();
  const naviguer = useNavigate();
  // Première installation : aucun administrateur général encore désigné.
  const premiere = plateforme?.admin_existe === false;
  useEffect(() => {
    if (premiere) {
      setMode('inscription');
      setType('email');
    }
  }, [premiere]);
  const parMatricule = mode === 'connexion' && type === 'employe';
  // Employé : 1) code établissement + matricule, 2) code d'entrée sur le pavé (comme Wave).
  const [etape, setEtape] = useState<'identite' | 'code'>(() => (codeEntreprise.length >= 4 && matricule ? 'code' : 'identite'));
  const [erreurCode, setErreurCode] = useState('');
  const [tentative, setTentative] = useState(0);

  async function entrerCode(pin: string) {
    if (envoi) return;
    setEnvoi(true);
    setErreurCode('');
    const r = await connexionParCode(codeEntreprise, matricule, pin);
    setEnvoi(false);
    if (!r.ok) {
      setErreurCode(r.message ?? 'Code incorrect.');
      setTentative((t) => t + 1);
      return;
    }
    memoriser(emailEmploye(codeEntreprise, matricule));
    marquerVerrou(false);
    await apresConnexion().catch(() => undefined);
    naviguer(r.provisoire ? '/choisir-code' : '/');
  }

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    if (envoi) return;
    setErreur('');
    setInfo('');
    if (parMatricule) {
      if (codeEntreprise.length < 4 || !matricule) return setErreur('Indiquez le code établissement et votre matricule.');
      setErreurCode('');
      setEtape('code');
      return;
    }
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
        marquerVerrou(false);
        if (parMatricule) memoriserCodeEntreprise(codeEntreprise);
        await apresConnexion();
        naviguer('/');
      } else if (mode === 'inscription') {
        if (motDePasse.length < 8) throw new Error('Le mot de passe doit contenir au moins 8 caractères.');
        if (motDePasse !== confirmation) throw new Error('Les deux mots de passe sont différents.');
        if (!premiere) {
          // Accès créé tout de suite, puis connexion : la personne remplit la fiche de son entreprise.
          const r = await creerMonAcces(nom.trim(), email.trim(), motDePasse);
          if (r.ok) {
            const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: motDePasse });
            if (error) throw error;
            memoriser(email.trim().toLowerCase());
            marquerVerrou(false);
            await apresConnexion();
            naviguer('/');
            return;
          }
          if (r.existe) {
            setMode('connexion');
            setType('email');
            throw new Error(r.message ?? 'Un compte existe déjà avec cette adresse : connectez-vous.');
          }
          if (!r.absente) throw new Error(r.message ?? 'Création impossible, réessayez.');
          // Fonction serveur pas encore installée : création classique (avec e-mail de confirmation).
        }
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
    inscription: premiere ? 'Créer le compte administrateur' : 'Créer mes accès',
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
                        setErreurCode('');
                        setEtape('code');
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
                🔢 Code d’entrée
              </button>
              <button type="button" role="tab" aria-selected={type === 'email'} className={type === 'email' ? 'actif' : ''} onClick={() => setType('email')}>
                ✉️ E-mail
              </button>
            </div>
          )}
          {mode === 'inscription' && !premiere && (
            <p className="secondaire petit-texte">
              Première connexion ? Créez vos accès, puis présentez votre entreprise : Décodeur Financier étudie votre demande
              et vous ouvre l’application.
            </p>
          )}
          {mode === 'inscription' && (
            <Champ label="Nom et prénoms">
              <input value={nom} onChange={(e) => setNom(e.target.value)} required autoComplete="name" />
            </Champ>
          )}
          {parMatricule && etape === 'code' ? (
            <div className="etape-code">
              <div className="qui-se-connecte">
                <span className="avatar-matricule">#</span>
                <div>
                  <strong>{matricule === '0000' ? 'Gérant principal' : `Matricule ${matricule}`}</strong>
                  <span className="secondaire">Établissement {codeEntreprise}</span>
                </div>
                <button type="button" className="bouton-lien" onClick={() => setEtape('identite')}>
                  Changer
                </button>
              </div>
              <p className="consigne-code">Tapez votre code d’entrée (4 chiffres)</p>
              <PaveCode onComplet={(c) => void entrerCode(c)} occupe={envoi} erreur={erreurCode} remiseAZero={tentative} />
              <p className="secondaire centre">Code oublié ? Votre gérant vous en donne un nouveau.</p>
            </div>
          ) : parMatricule ? (
            <div className="grille-acces">
              <Champ label="Code établissement" aide="Donné par votre gérant ; retenu sur cet appareil.">
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
              <Champ label="Matricule" aide="Gérant principal : 0000">
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
          {mode !== 'oubli' && !parMatricule && (
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
          {mode === 'inscription' && (
            <Champ label="Confirmer le mot de passe">
              <input
                type={voirMotDePasse ? 'text' : 'password'}
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </Champ>
          )}

          {!(parMatricule && etape === 'code') && (
          <button className="bouton bouton-principal bouton-plein" disabled={envoi}>
            {envoi
              ? 'Veuillez patienter…'
              : parMatricule
                ? 'Continuer'
                : mode === 'connexion'
                ? 'Se connecter'
                : mode === 'inscription'
                  ? 'Créer mes accès'
                  : 'Recevoir le lien'}
          </button>
          )}

          {mode === 'connexion' && !(parMatricule && etape === 'code') && (
            <button type="button" className="bouton bouton-discret bouton-plein bouton-creer-acces" onClick={() => setMode('inscription')}>
              Pas encore d’accès ? <strong>Créer mes accès</strong>
            </button>
          )}
          <div className="liens-formulaire">
            {mode !== 'connexion' && (
              <button type="button" className="bouton-lien" onClick={() => setMode('connexion')}>
                J’ai déjà un compte
              </button>
            )}

            {mode === 'connexion' && !parMatricule && (
              <button type="button" className="bouton-lien" onClick={() => setMode('oubli')}>
                Mot de passe oublié
              </button>
            )}

          </div>
        </form>
        <p className="note-publique">
          {type === 'employe' && mode === 'connexion'
            ? 'Employé : votre code établissement, votre matricule et votre code d’entrée vous sont donnés par votre gérant.'
            : 'Vous avez une entreprise ? Créez vos accès et envoyez votre demande. Invité par votre employeur avec votre e-mail ? Créez vos accès avec cette adresse : vous serez rattaché automatiquement.'}
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
