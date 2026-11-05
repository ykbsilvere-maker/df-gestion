import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { useIdentite } from '../lib/identite';
import {
  INACTIVITE_MS,
  estAccesEmploye,
  identifiantAffiche,
  inactifDepuisTrop,
  lireAccesEmploye,
  marquerVerrou,
  memoriserEmpreinte,
  noterActivite,
  verifierEmpreinte,
} from '../lib/acces';
import { PaveCode } from './PaveCode';

/**
 * Après 5 minutes sans activité (ou au retour sur l'application après 5 minutes),
 * l'écran d'entrée revient : code d'entrée de 4 chiffres. Ce qui était en cours
 * (panier de la caisse, saisie) reste en place derrière et reprend au déverrouillage.
 * Sans réseau, le code est vérifié avec l'empreinte gardée sur l'appareil.
 */
export function VerrouInactivite() {
  const { session, organisation, codeEntreeDefini, deconnecter } = useSession();
  const { identite } = useIdentite();
  const [verrouille, setVerrouille] = useState(() => inactifDepuisTrop());
  const [erreur, setErreur] = useState('');
  const [tour, setTour] = useState(0);
  const [occupe, setOccupe] = useState(false);
  const [motDePasse, setMotDePasse] = useState('');
  const derniere = useRef(Date.now());

  const verrouiller = useCallback(() => {
    marquerVerrou(true);
    setErreur('');
    setVerrouille(true);
  }, []);

  useEffect(() => {
    if (verrouille) return;
    noterActivite();
    const activite = () => {
      const t = Date.now();
      if (t - derniere.current > 5000) {
        derniere.current = t;
        noterActivite();
      }
    };
    const verifier = () => {
      if (document.visibilityState === 'visible' && inactifDepuisTrop()) verrouiller();
    };
    const evenements: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
    evenements.forEach((e) => window.addEventListener(e, activite, { passive: true }));
    document.addEventListener('visibilitychange', verifier);
    const minuterie = window.setInterval(() => {
      if (Date.now() - derniere.current > INACTIVITE_MS) verrouiller();
    }, 10_000);
    const surDemande = () => verrouiller();
    window.addEventListener('dfg:verrouiller', surDemande);
    return () => {
      evenements.forEach((e) => window.removeEventListener(e, activite));
      document.removeEventListener('visibilitychange', verifier);
      window.removeEventListener('dfg:verrouiller', surDemande);
      window.clearInterval(minuterie);
    };
  }, [verrouille, verrouiller]);

  const ouvrir = () => {
    marquerVerrou(false);
    derniere.current = Date.now();
    setMotDePasse('');
    setVerrouille(false);
  };
  const refuser = (message: string) => {
    setErreur(message);
    setTour((t) => t + 1);
  };

  async function avecCode(code: string) {
    if (!session) return;
    setOccupe(true);
    const { data, error } = await supabase.rpc('verifier_mon_pin', { p_pin: code });
    if (error) {
      // Sans réseau : empreinte locale.
      const local = await verifierEmpreinte(session.user.id, code);
      setOccupe(false);
      if (local === true) return ouvrir();
      return refuser(local === false ? 'Code incorrect.' : 'Pas de réseau, et ce code n’a jamais servi sur cet appareil.');
    }
    setOccupe(false);
    const r = data as { ok: boolean; message?: string };
    if (r.ok) {
      await memoriserEmpreinte(session.user.id, code);
      return ouvrir();
    }
    refuser(r.message ?? 'Code incorrect.');
  }

  async function avecMotDePasse(e: FormEvent) {
    e.preventDefault();
    if (!session?.user.email) return;
    setOccupe(true);
    const { error } = await supabase.auth.signInWithPassword({ email: session.user.email, password: motDePasse });
    setOccupe(false);
    if (error) return refuser(navigator.onLine ? 'Mot de passe incorrect.' : 'Pas de réseau : impossible de vérifier le mot de passe.');
    ouvrir();
  }

  if (!verrouille || !session) return null;
  const employe = estAccesEmploye(session.user.email);
  const parCode = employe || codeEntreeDefini;
  const nom = (session.user.user_metadata?.nom_complet as string | undefined) || identifiantAffiche(session.user.email);
  const acces = lireAccesEmploye(session.user.email);

  return (
    <div className="ecran-verrouille" role="dialog" aria-modal="true" aria-label="Application verrouillée">
      <div className="carte-code">
        <div className="verrou-entreprise">
          {identite?.logoUrl ? <img src={identite.logoUrl} alt="" /> : <span className="verrou-initiale">{(organisation?.nom ?? 'D').charAt(0)}</span>}
          <div>
            <strong>{organisation?.nom ?? 'DF Gestion'}</strong>
            {acces && <span className="secondaire">Établissement {acces.code}</span>}
          </div>
        </div>
        <div className="qui-se-connecte">
          <span className="avatar-matricule">{nom.charAt(0).toUpperCase()}</span>
          <div>
            <strong>{nom}</strong>
            <span className="secondaire">{identifiantAffiche(session.user.email)}</span>
          </div>
        </div>
        <p className="consigne-code">
          {parCode ? 'Application verrouillée après 5 minutes sans activité. Tapez votre code d’entrée.' : 'Session verrouillée : tapez votre mot de passe.'}
        </p>
        {parCode ? (
          <PaveCode onComplet={(c) => void avecCode(c)} occupe={occupe} erreur={erreur} remiseAZero={tour} />
        ) : (
          <form className="formulaire" onSubmit={avecMotDePasse}>
            <input type="password" value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} autoFocus autoComplete="current-password" aria-label="Mot de passe" />
            {erreur && <p className="texte-negatif" role="alert">{erreur}</p>}
            <button className="bouton bouton-principal bouton-plein" disabled={occupe || !motDePasse}>
              Déverrouiller
            </button>
            <p className="secondaire petit">Astuce : créez un code d’entrée de 4 chiffres dans « Mon compte » pour déverrouiller plus vite.</p>
          </form>
        )}
        <button
          type="button"
          className="bouton-lien changer-utilisateur"
          onClick={() => {
            marquerVerrou(false);
            void deconnecter();
          }}
        >
          Changer d’utilisateur
        </button>
      </div>
    </div>
  );
}

/** Verrouille tout de suite (bouton 🔒). */
export function verrouillerMaintenant() {
  window.dispatchEvent(new Event('dfg:verrouiller'));
}
