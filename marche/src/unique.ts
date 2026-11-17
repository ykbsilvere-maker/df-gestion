import { useEffect, useState } from 'react';
import { appeler, type Accueil, type Vitrine } from './api';

/**
 * Boutique unique : quand une seule boutique est publiée, DF Marché devient SON site.
 * Plus de « boutiques » au pluriel : son nom et son logo en tête, pas de nom de boutique sur
 * chaque produit, pas de page « Boutiques ». La valeur est gardée sur le téléphone pour éviter
 * tout clignotement au démarrage.
 */
const CLE = 'dfm_boutique_unique';
let etat: Vitrine | null = (() => {
  try {
    const s = localStorage.getItem(CLE);
    return s ? (JSON.parse(s) as Vitrine) : null;
  } catch {
    return null;
  }
})();
const abonnes = new Set<() => void>();
const appliquer = () => document.documentElement.classList.toggle('boutique-unique', !!etat);
appliquer();

export function definirBoutiques(liste: Vitrine[]) {
  const v = liste.length === 1 ? liste[0]! : null;
  if (JSON.stringify(v) === JSON.stringify(etat)) return;
  etat = v;
  try {
    if (v) localStorage.setItem(CLE, JSON.stringify(v));
    else localStorage.removeItem(CLE);
  } catch {
    /* stockage indisponible */
  }
  appliquer();
  abonnes.forEach((f) => f());
}

export function chargerBoutiques() {
  appeler<Accueil>('marche_accueil').then((a) => definirBoutiques(a.boutiques)).catch(() => undefined);
}

export function boutiqueUnique() {
  return etat;
}

export function useBoutiqueUnique(): Vitrine | null {
  const [, maj] = useState(0);
  useEffect(() => {
    const f = () => maj((n) => n + 1);
    abonnes.add(f);
    return () => {
      abonnes.delete(f);
    };
  }, []);
  return etat;
}
