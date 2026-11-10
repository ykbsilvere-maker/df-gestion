import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { estAccesEmploye } from '../lib/acces';
import { Alerte, Champ, Fenetre } from './ui';
import { PaveCode } from './PaveCode';

/**
 * Confirmation d'identité avant un geste sensible (ouvrir ou clôturer une caisse) :
 * le code d'entrée de la personne connectée, ou son mot de passe si elle n'a pas de code.
 */
export function ConfirmerCode({ ouverte, titre, consigne, onValide, onFermer }: { ouverte: boolean; titre: string; consigne: string; onValide: () => void; onFermer: () => void }) {
  const { session, codeEntreeDefini } = useSession();
  const email = session?.user.email ?? '';
  const employe = estAccesEmploye(email);
  const [parMotDePasse, setParMotDePasse] = useState(false);
  const [motDePasse, setMotDePasse] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState('');
  const [tour, setTour] = useState(0);
  const parCode = (employe || codeEntreeDefini) && !parMotDePasse;

  const reussi = () => {
    setErreur('');
    setMotDePasse('');
    setParMotDePasse(false);
    onValide();
  };
  const refuser = (m: string) => {
    setErreur(m);
    setTour((t) => t + 1);
  };

  async function avecCode(code: string) {
    setOccupe(true);
    const { data, error } = await supabase.rpc('verifier_mon_pin', { p_pin: code });
    setOccupe(false);
    if (error) return refuser('Vérification impossible : contrôlez la connexion Internet.');
    const r = data as { ok: boolean; message?: string };
    if (r.ok) return reussi();
    refuser(r.message ?? 'Code incorrect.');
  }

  async function avecMotDePasse(e: FormEvent) {
    e.preventDefault();
    if (!email) return;
    setOccupe(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password: motDePasse });
    setOccupe(false);
    if (error) return refuser(navigator.onLine ? 'Mot de passe incorrect.' : 'Pas de réseau : impossible de vérifier le mot de passe.');
    reussi();
  }

  return (
    <Fenetre titre={titre} ouverte={ouverte} onFermer={onFermer}>
      <div className="confirmer-code">
        <p className="secondaire centre">{consigne}</p>
        {parCode ? (
          <>
            <PaveCode onComplet={(c) => void avecCode(c)} occupe={occupe} erreur={erreur} remiseAZero={tour} />
            {!employe && (
              <button type="button" className="bouton-lien" onClick={() => { setParMotDePasse(true); setErreur(''); }}>
                Utiliser mon mot de passe
              </button>
            )}
          </>
        ) : (
          <form onSubmit={(e) => void avecMotDePasse(e)} className="formulaire">
            <Alerte>{erreur}</Alerte>
            <Champ label="Votre mot de passe">
              <input type="password" value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} autoComplete="current-password" autoFocus required />
            </Champ>
            <button type="submit" className="bouton bouton-principal bouton-plein" disabled={occupe || !motDePasse}>
              {occupe ? 'Vérification…' : 'Confirmer'}
            </button>
            {codeEntreeDefini && (
              <button type="button" className="bouton-lien" onClick={() => { setParMotDePasse(false); setErreur(''); }}>
                Utiliser mon code d’entrée
              </button>
            )}
          </form>
        )}
      </div>
    </Fenetre>
  );
}
