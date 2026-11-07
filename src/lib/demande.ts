import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Raccourcis de l'accueil : une page ouverte avec « ?nouveau=1 » (ou une autre valeur) ouvre
 * directement son formulaire de création, une seule fois, dès que ses données sont prêtes.
 */
export function useDemandeCreation(pret: boolean, action: (valeur: string) => void) {
  const [params, setParams] = useSearchParams();
  const fait = useRef(false);
  const valeur = params.get('nouveau');
  useEffect(() => {
    if (fait.current || !pret || !valeur) return;
    fait.current = true;
    const p = new URLSearchParams(params);
    p.delete('nouveau');
    setParams(p, { replace: true });
    action(valeur);
  });
}
