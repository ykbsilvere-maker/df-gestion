import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';
import { codeEntreeValide, identifiantAffiche, memoriserEmpreinte } from '../lib/acces';
import { PaveCode } from '../components/PaveCode';
import { MarqueDecodeur } from '../components/Marque';

/**
 * Choix du code d'entrée de 4 chiffres : obligatoire après un code provisoire,
 * possible ensuite depuis « Mon compte » (l'ancien code est alors demandé).
 */
export function ChoisirCode() {
  const { session, codeAChoisir, codeEntreeDefini, rechargerCodeEntree, deconnecter } = useSession();
  const naviguer = useNavigate();
  const changement = codeEntreeDefini && !codeAChoisir;
  const [etape, setEtape] = useState<'ancien' | 'nouveau' | 'confirmer'>(changement ? 'ancien' : 'nouveau');
  const [ancien, setAncien] = useState<string | null>(null);
  const [nouveau, setNouveau] = useState('');
  const [erreur, setErreur] = useState('');
  const [tour, setTour] = useState(0);
  const [occupe, setOccupe] = useState(false);

  const recommencer = (message: string) => {
    setErreur(message);
    setTour((t) => t + 1);
  };

  async function suite(code: string) {
    setErreur('');
    if (etape === 'ancien') {
      setAncien(code);
      setEtape('nouveau');
      setTour((t) => t + 1);
      return;
    }
    if (etape === 'nouveau') {
      if (!codeEntreeValide(code)) return recommencer('Trop facile à deviner : évitez 1111, 1234, 4321…');
      setNouveau(code);
      setEtape('confirmer');
      setTour((t) => t + 1);
      return;
    }
    if (code !== nouveau) {
      setEtape('nouveau');
      return recommencer('Les deux codes sont différents. Recommencez.');
    }
    setOccupe(true);
    const { error } = await supabase.rpc('changer_mon_pin', { p_nouveau: code, p_ancien: ancien });
    setOccupe(false);
    if (error) {
      setEtape(changement ? 'ancien' : 'nouveau');
      return recommencer(messageErreur(error));
    }
    if (session) await memoriserEmpreinte(session.user.id, code);
    await rechargerCodeEntree();
    naviguer('/', { replace: true });
  }

  const titres = {
    ancien: 'Tapez votre code actuel',
    nouveau: changement ? 'Choisissez votre nouveau code' : 'Choisissez votre code d’entrée',
    confirmer: 'Retapez le même code',
  };

  return (
    <div className="ecran-code">
      <div className="carte-code">
        <MarqueDecodeur sousTitre="" />
        <div className="etapes-pin">
          {changement && <span className={etape === 'ancien' ? 'actif' : 'fait'}>Actuel</span>}
          <span className={etape === 'nouveau' ? 'actif' : etape === 'confirmer' ? 'fait' : ''}>Nouveau</span>
          <span className={etape === 'confirmer' ? 'actif' : ''}>Confirmer</span>
        </div>
        <h1>{titres[etape]}</h1>
        <p className="secondaire">
          {identifiantAffiche(session?.user.email)} — 4 chiffres que vous seul connaissez. Ce code vous sera demandé à chaque
          connexion et après 5 minutes sans activité. N’utilisez pas votre code Mobile Money.
        </p>
        <PaveCode onComplet={(c) => void suite(c)} occupe={occupe} erreur={erreur} remiseAZero={`${etape}-${tour}`} />
        <div className="liens-formulaire">
          {changement ? (
            <button type="button" className="bouton-lien" onClick={() => naviguer('/compte')}>
              Annuler
            </button>
          ) : (
            <button type="button" className="bouton-lien" onClick={() => void deconnecter()}>
              Se déconnecter
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
