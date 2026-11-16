import { useSyncExternalStore } from 'react';
import type { ProduitCarte } from './api';

/**
 * Panier gardé dans le navigateur, rangé par boutique : on commande boutique par boutique
 * (chaque boutique prépare, livre et encaisse sa propre commande).
 */
export interface ArticlePanier {
  id: string;
  designation: string;
  photo: string | null;
  prix: number;
  prix_normal: number;
  disponible: number;
  quantite: number;
}
export interface PanierBoutique {
  slug: string;
  nom: string;
  articles: ArticlePanier[];
}
type Etat = Record<string, PanierBoutique>;

const CLE = 'dfm_panier';
let etat: Etat = lire();
const abonnes = new Set<() => void>();

function lire(): Etat {
  try {
    return JSON.parse(localStorage.getItem(CLE) ?? '{}') as Etat;
  } catch {
    return {};
  }
}
function ecrire(e: Etat) {
  etat = e;
  try {
    localStorage.setItem(CLE, JSON.stringify(e));
  } catch {
    /* stockage plein ou interdit : le panier reste en mémoire */
  }
  abonnes.forEach((f) => f());
}
window.addEventListener('storage', (e) => {
  if (e.key === CLE) {
    etat = lire();
    abonnes.forEach((f) => f());
  }
});

export function usePanier(): Etat {
  return useSyncExternalStore(
    (f) => {
      abonnes.add(f);
      return () => abonnes.delete(f);
    },
    () => etat,
  );
}

export function nombreArticles(e: Etat): number {
  return Object.values(e).reduce((s, b) => s + b.articles.reduce((t, a) => t + a.quantite, 0), 0);
}

export function ajouter(p: ProduitCarte, quantite = 1) {
  const b = etat[p.boutique.slug] ?? { slug: p.boutique.slug, nom: p.boutique.nom, articles: [] };
  const existant = b.articles.find((a) => a.id === p.id);
  const max = Math.max(0, Number(p.disponible));
  const articles = existant
    ? b.articles.map((a) => (a.id === p.id ? { ...a, quantite: Math.min(max, a.quantite + quantite), prix: p.prix, disponible: max } : a))
    : [...b.articles, { id: p.id, designation: p.designation, photo: p.photo, prix: Number(p.prix), prix_normal: Number(p.prix_normal), disponible: max, quantite: Math.min(max, quantite) }];
  ecrire({ ...etat, [b.slug]: { ...b, articles } });
}

export function changerQuantite(slug: string, id: string, quantite: number) {
  const b = etat[slug];
  if (!b) return;
  const articles = b.articles
    .map((a) => (a.id === id ? { ...a, quantite: Math.max(0, Math.min(a.disponible || quantite, quantite)) } : a))
    .filter((a) => a.quantite > 0);
  const e = { ...etat };
  if (articles.length) e[slug] = { ...b, articles };
  else delete e[slug];
  ecrire(e);
}

export function viderBoutique(slug: string) {
  const e = { ...etat };
  delete e[slug];
  ecrire(e);
}

/* Commandes passées depuis cet appareil (codes de suivi). */
const CLE_CMD = 'dfm_commandes';
export interface CommandeMemo {
  code: string;
  numero: string;
  boutique: string;
  total: number;
  date: string;
}
export function mesCommandes(): CommandeMemo[] {
  try {
    return JSON.parse(localStorage.getItem(CLE_CMD) ?? '[]') as CommandeMemo[];
  } catch {
    return [];
  }
}
export function memoriserCommande(c: CommandeMemo) {
  try {
    localStorage.setItem(CLE_CMD, JSON.stringify([c, ...mesCommandes().filter((x) => x.code !== c.code)].slice(0, 30)));
  } catch {
    /* rien */
  }
}

/* Coordonnées du client, reprises à la commande suivante. */
const CLE_CLIENT = 'dfm_client';
export interface ClientMemo {
  nom: string;
  telephone: string;
  email: string;
  adresse: string;
  repere: string;
}
export function clientMemorise(): Partial<ClientMemo> {
  try {
    return JSON.parse(localStorage.getItem(CLE_CLIENT) ?? '{}') as Partial<ClientMemo>;
  } catch {
    return {};
  }
}
export function memoriserClient(c: ClientMemo) {
  try {
    localStorage.setItem(CLE_CLIENT, JSON.stringify(c));
  } catch {
    /* rien */
  }
}
