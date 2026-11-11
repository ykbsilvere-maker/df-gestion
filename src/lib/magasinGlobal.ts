import { useSyncExternalStore } from 'react';

/**
 * Magasin choisi en haut de l'écran : '' = tous les magasins. Les pages (accueil, stock,
 * trésorerie, vue d'ensemble) suivent ce choix. Retenu sur l'appareil.
 */
const CLE = 'dfg_magasin_global';
const ecouteurs = new Set<() => void>();
let valeur = '';
try {
  valeur = localStorage.getItem(CLE) ?? '';
} catch {
  /* stockage indisponible */
}

export function choisirMagasinGlobal(id: string) {
  valeur = id;
  try {
    localStorage.setItem(CLE, id);
  } catch {
    /* stockage indisponible */
  }
  ecouteurs.forEach((f) => f());
}

export function useMagasinGlobal(): string {
  return useSyncExternalStore(
    (f) => {
      ecouteurs.add(f);
      return () => ecouteurs.delete(f);
    },
    () => valeur,
  );
}
