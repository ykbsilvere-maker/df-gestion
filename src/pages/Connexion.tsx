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

export function Connexion() {
  const [mode, setMode] = useState<Mode>('connexion');
  const [email, setEmail] = useState('');
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
    <div className="page-accueil-public">
      <section className="panneau-public">
        <MarqueDecodeur sousTitre="Caisse, stock et pilotage de votre commerce" />

        <form className="carte formulaire" onSubmit={soumettre}>
          <h1>{titres[mode]}</h1>
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
              <input
                type="password"
                value={motDePasse}
                onChange={(e) => setMotDePasse(e.target.value)}
                required
                minLength={mode === 'inscription' ? 8 : undefined}
                autoComplete={mode === 'inscription' ? 'new-password' : 'current-password'}
              />
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
