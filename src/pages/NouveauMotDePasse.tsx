import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';
import { Alerte, Champ } from '../components/ui';

/**
 * Choix d'un nouveau mot de passe : après le lien de réinitialisation reçu par e-mail,
 * ou à la première connexion avec un mot de passe provisoire donné par un responsable.
 */
export function NouveauMotDePasse() {
  const { session, mdpProvisoire, deconnecter } = useSession();
  const [mdp, setMdp] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const naviguer = useNavigate();

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    setErreur('');
    if (mdp.length < 8) return setErreur('Le mot de passe doit contenir au moins 8 caractères.');
    if (mdp !== confirmation) return setErreur('Les deux mots de passe ne correspondent pas.');
    setEnvoi(true);
    const { error } = await supabase.auth.updateUser({ password: mdp, data: { mdp_provisoire: false } });
    setEnvoi(false);
    if (error) return setErreur(messageErreur(error));
    naviguer('/');
  }

  return (
    <div className="page-accueil-public">
      <section className="panneau-public">
        <form className="carte formulaire" onSubmit={soumettre}>
          <h1>{mdpProvisoire ? 'Choisissez votre mot de passe' : 'Nouveau mot de passe'}</h1>
          {mdpProvisoire && (
            <p className="sous-titre">
              Votre accès a été créé avec un mot de passe provisoire. Choisissez-en un que vous seul connaissez.
            </p>
          )}
          {!session && <Alerte type="info">Lien expiré ou déjà utilisé : redemandez un lien depuis la page de connexion.</Alerte>}
          <Alerte>{erreur}</Alerte>
          <Champ label="Nouveau mot de passe" aide="8 caractères minimum">
            <input type="password" value={mdp} onChange={(e) => setMdp(e.target.value)} autoComplete="new-password" />
          </Champ>
          <Champ label="Confirmation">
            <input
              type="password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="new-password"
            />
          </Champ>
          <button className="bouton bouton-principal bouton-plein" disabled={envoi || !session}>
            Enregistrer
          </button>
          {mdpProvisoire && (
            <div className="liens-formulaire">
              <button type="button" className="bouton-lien" onClick={() => void deconnecter()}>
                Se déconnecter
              </button>
            </div>
          )}
        </form>
      </section>
    </div>
  );
}
