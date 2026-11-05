import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';
import { Alerte, Champ } from '../components/ui';
import { estAccesEmploye, lireAccesEmploye } from '../lib/acces';

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
  // Employé connecté par matricule : un code secret de 6 chiffres suffit.
  const employe = estAccesEmploye(session?.user.email);
  const minimum = employe ? 6 : 8;
  const mot = employe ? 'code secret' : 'mot de passe';

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    setErreur('');
    if (mdp.length < minimum) return setErreur(`Le ${mot} doit contenir au moins ${minimum} caractères.`);
    if (employe && /^(\d)\1+$|^(012345|123456|234567|345678|456789|987654|876543|654321)/.test(mdp))
      return setErreur('Code trop facile à deviner : évitez les chiffres identiques ou qui se suivent.');
    if (mdp !== confirmation) return setErreur(`Les deux ${employe ? 'codes' : 'mots de passe'} ne correspondent pas.`);
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
          <h1>{mdpProvisoire ? `Choisissez votre ${mot}` : `Nouveau ${mot}`}</h1>
          {mdpProvisoire && (
            <p className="sous-titre">
              {employe
                ? `Matricule ${lireAccesEmploye(session?.user.email)?.matricule} : votre accès a été créé avec un code provisoire. Choisissez un code secret que vous seul connaissez (au moins 6 chiffres) — pas votre code Mobile Money.`
                : 'Votre accès a été créé avec un mot de passe provisoire. Choisissez-en un que vous seul connaissez.'}
            </p>
          )}
          {!session && <Alerte type="info">Lien expiré ou déjà utilisé : redemandez un lien depuis la page de connexion.</Alerte>}
          <Alerte>{erreur}</Alerte>
          <Champ label={`Nouveau ${mot}`} aide={`${minimum} ${employe ? 'chiffres' : 'caractères'} minimum`}>
            <input type="password" value={mdp} onChange={(e) => setMdp(e.target.value)} autoComplete="new-password" inputMode={employe ? 'numeric' : undefined} />
          </Champ>
          <Champ label="Confirmation">
            <input
              type="password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="new-password"
              inputMode={employe ? 'numeric' : undefined}
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
