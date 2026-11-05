import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from './supabase';
import { useSession } from './session';
import type { Organisation, ParametresImpression } from './types';

/** Palettes proposées : couleurs foncées testées pour un texte blanc lisible. */
export const COULEURS: Record<string, { libelle: string; fonce: string; fonce2: string }> = {
  decodeur: { libelle: 'Décodeur (noir)', fonce: '#141414', fonce2: '#2a2a2a' },
  foret: { libelle: 'Forêt', fonce: '#0f2a24', fonce2: '#183b33' },
  ocean: { libelle: 'Océan', fonce: '#0f2a44', fonce2: '#183a5c' },
  terre: { libelle: 'Terre', fonce: '#3a2315', fonce2: '#52331f' },
  prune: { libelle: 'Prune', fonce: '#2d1a33', fonce2: '#43274b' },
  ardoise: { libelle: 'Ardoise', fonce: '#22272e', fonce2: '#343c46' },
  nuit: { libelle: 'Nuit', fonce: '#151b30', fonce2: '#232c4a' },
};

export function appliquerCouleur(code: string) {
  const c = COULEURS[code] ?? COULEURS.decodeur!;
  const racine = document.documentElement.style;
  racine.setProperty('--foret', c.fonce);
  racine.setProperty('--foret-2', c.fonce2);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', c.fonce);
}

export function urlPublique(espace: 'logos' | 'produits', chemin: string | null | undefined): string | null {
  if (!chemin) return null;
  return supabase.storage.from(espace).getPublicUrl(chemin).data.publicUrl;
}

export interface Identite {
  organisation: Organisation;
  parametres: ParametresImpression;
  logoUrl: string | null;
}

interface EtatIdentite {
  identite: Identite | null;
  recharger: () => Promise<void>;
}

const Contexte = createContext<EtatIdentite>({ identite: null, recharger: async () => {} });

/** Identité visuelle et coordonnées de l'entreprise courante (logo, couleur, reçu). */
export function FournisseurIdentite({ children }: { children: ReactNode }) {
  const { organisation } = useSession();
  const org = organisation?.organisation_id;
  const [identite, setIdentite] = useState<Identite | null>(null);

  const recharger = useCallback(async () => {
    if (!org) return;
    const [o, p] = await Promise.all([
      supabase.from('organisations').select('*').eq('id', org).single(),
      supabase.from('parametres_impression').select('*').eq('organisation_id', org).single(),
    ]);
    const cle = `dfg_identite_${org}`;
    if (o.error || p.error) {
      try {
        const cache = localStorage.getItem(cle);
        if (cache) {
          const id = JSON.parse(cache) as Identite;
          setIdentite(id);
          appliquerCouleur(id.organisation.couleur);
        }
      } catch {
        /* cache illisible */
      }
      return;
    }
    const organisationLue = o.data as Organisation;
    const id: Identite = {
      organisation: organisationLue,
      parametres: p.data as ParametresImpression,
      logoUrl: urlPublique('logos', organisationLue.logo_path),
    };
    setIdentite(id);
    appliquerCouleur(organisationLue.couleur);
    try {
      localStorage.setItem(cle, JSON.stringify(id));
    } catch {
      /* stockage indisponible */
    }
  }, [org]);

  useEffect(() => {
    setIdentite(null);
    void recharger();
  }, [recharger]);

  return <Contexte.Provider value={{ identite, recharger }}>{children}</Contexte.Provider>;
}

export function useIdentite(): EtatIdentite {
  return useContext(Contexte);
}
