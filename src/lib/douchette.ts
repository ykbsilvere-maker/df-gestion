import { useEffect, useRef } from 'react';

/**
 * Lecteur de codes-barres (douchette USB, sans fil ou Bluetooth) : il se comporte comme un
 * clavier qui tape le code très vite puis appuie sur Entrée. Ce crochet reconnaît cette rafale
 * où que soit le curseur (bouton, panier, case de quantité…) et rend le code, sans toucher à la
 * saisie normale au clavier. Les champs marqués data-douchette="champ" gèrent eux-mêmes le scan.
 */
const ECART_MAX_MS = 45; // une personne tape rarement plus vite que 80 ms entre deux touches
const LONGUEUR_MIN = 4;

/** Remet la valeur d'un champ piloté par React (la douchette a pu y écrire avant d'être reconnue). */
function remettreValeur(champ: HTMLInputElement | HTMLTextAreaElement, valeur: string) {
  const proto = champ instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(champ, valeur);
  champ.dispatchEvent(new Event('input', { bubbles: true }));
}

export function useDouchette(surCode: (code: string) => void, actif = true) {
  const rappel = useRef(surCode);
  rappel.current = surCode;

  useEffect(() => {
    if (!actif) return;
    let tampon = '';
    let derniere = 0;
    let rapide = true;
    let cible: HTMLInputElement | HTMLTextAreaElement | null = null;
    let avant = '';

    const touche = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[data-douchette="champ"]')) return;
      const maintenant = performance.now();
      if (maintenant - derniere > ECART_MAX_MS * 3 || !tampon) {
        // Début possible d'une rafale : on note le champ et sa valeur pour pouvoir la rétablir.
        tampon = '';
        rapide = true;
        cible = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement ? t : null;
        avant = cible?.value ?? '';
      } else if (maintenant - derniere > ECART_MAX_MS) rapide = false;
      derniere = maintenant;

      if (e.key === 'Enter' || e.key === 'Tab') {
        const code = tampon.trim();
        tampon = '';
        if (rapide && code.length >= LONGUEUR_MIN) {
          e.preventDefault();
          e.stopPropagation();
          if (cible && cible.value !== avant) remettreValeur(cible, avant);
          rappel.current(code);
        }
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        tampon += e.key;
        // Pas de champ de saisie : on évite que les touches déclenchent un raccourci ou un bouton.
        if (!cible && tampon.length > 1) e.preventDefault();
      }
    };
    window.addEventListener('keydown', touche, true);
    return () => window.removeEventListener('keydown', touche, true);
  }, [actif]);
}
