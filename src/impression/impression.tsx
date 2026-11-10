import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { pontAndroid } from '../lib/android';

/**
 * Impression navigateur : le contenu est rendu dans une zone dédiée (hors de l'application),
 * seule visible à l'impression, avec la taille de page adaptée au support.
 */
export type Support = 'a4' | 'thermique';

interface EtatImpression {
  imprimer: (contenu: ReactNode, support: Support) => Promise<void>;
}

const Contexte = createContext<EtatImpression>({ imprimer: async () => {} });

const REGLE_PAGE: Record<Support, string> = {
  a4: '@page { size: A4 portrait; margin: 0; }',
  // Rouleau : la largeur vient du contenu (58 ou 80 mm) ; régler le papier dans le pilote de l'imprimante.
  thermique: '@page { margin: 0; }',
};

function imagesChargees(racine: HTMLElement): Promise<void> {
  const images = [...racine.querySelectorAll('img')];
  return Promise.all(
    images.map((img) =>
      img.complete ? Promise.resolve() : new Promise<void>((ok) => { img.onload = img.onerror = () => ok(); }),
    ),
  ).then(() => undefined);
}

const deuxImages = () => new Promise<void>((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok())));

export function FournisseurImpression({ children }: { children: ReactNode }) {
  const [contenu, setContenu] = useState<ReactNode>(null);
  const zone = useRef<HTMLDivElement | null>(null);

  const imprimer = useCallback(async (noeud: ReactNode, support: Support) => {
    setContenu(noeud);
    const style = document.createElement('style');
    style.id = 'regle-page-impression';
    style.textContent = REGLE_PAGE[support];
    document.getElementById('regle-page-impression')?.remove();
    document.head.appendChild(style);
    await deuxImages();
    if (zone.current) await imagesChargees(zone.current);
    await deuxImages();
    const android = pontAndroid();
    if (android) {
      // Application Android : service d'impression du téléphone (imprimante Wi-Fi, Bluetooth, PDF).
      android.imprimer(document.title || 'Ticket');
      await new Promise((ok) => setTimeout(ok, 800));
      return;
    }
    await new Promise<void>((ok) => {
      const fin = () => {
        window.removeEventListener('afterprint', fin);
        ok();
      };
      window.addEventListener('afterprint', fin);
      window.print();
      // Certains navigateurs mobiles n'émettent pas « afterprint » : on libère quand même.
      setTimeout(fin, 1500);
    });
  }, []);

  return (
    <Contexte.Provider value={{ imprimer }}>
      {children}
      {createPortal(
        <div id="zone-impression" ref={zone} aria-hidden>
          {contenu}
        </div>,
        document.body,
      )}
    </Contexte.Provider>
  );
}

/** Imprime la page affichée (liste, état, journal) sur A4, sans le menu ni les filtres. */
export async function imprimerPageA4(titre?: string) {
  document.getElementById('regle-page-impression')?.remove();
  const style = document.createElement('style');
  style.id = 'regle-page-impression';
  style.textContent = '@page { size: A4 portrait; margin: 12mm; }';
  document.head.appendChild(style);
  document.body.classList.add('impression-page');
  const ancien = document.title;
  if (titre) document.title = titre;
  const fin = () => {
    document.body.classList.remove('impression-page');
    document.title = ancien;
  };
  const android = pontAndroid();
  if (android) {
    android.imprimer(titre || ancien || 'DF Gestion');
    setTimeout(fin, 1500);
    return;
  }
  window.addEventListener('afterprint', fin, { once: true });
  window.print();
  setTimeout(fin, 60000);
}

/** Feuille A4 entière pour un ticket ou un rapport de caisse (au lieu du rouleau). */
export function PageA4({ children }: { children: ReactNode }) {
  return <div className="page-a4-pleine">{children}</div>;
}

export function useImpression(): EtatImpression {
  return useContext(Contexte);
}

/** Case suivante sur la feuille A4 en cours, mémorisée par appareil et par entreprise. */
export function caseSuivante(org: string): number {
  try {
    const v = Number(localStorage.getItem(`dfg_case_a4_${org}`));
    return v >= 1 && v <= 6 ? v : 1;
  } catch {
    return 1;
  }
}

export function memoriserCaseSuivante(org: string, caseUtilisee: number, double: boolean) {
  const prochaine = ((caseUtilisee - 1 + (double ? 2 : 1)) % 6) + 1;
  try {
    localStorage.setItem(`dfg_case_a4_${org}`, String(prochaine));
  } catch {
    /* stockage indisponible */
  }
}

/** Choisit directement la prochaine case (feuille entamée, case abîmée…). */
export function definirCaseSuivante(org: string, n: number) {
  try {
    localStorage.setItem(`dfg_case_a4_${org}`, String(n >= 1 && n <= 6 ? n : 1));
  } catch {
    /* stockage indisponible */
  }
}
