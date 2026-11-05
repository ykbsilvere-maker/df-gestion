import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

export type TypeCompte = 'caisse' | 'caisse_centrale' | 'mobile_money' | 'banque' | 'autre';

export interface CompteTresorerie {
  id: string;
  nom: string;
  type: TypeCompte;
  caisse_id: string | null;
  numero: string | null;
  solde_initial: number;
  date_ouverture: string;
  actif: boolean;
  ordre: number;
}

export const TYPES_COMPTE: Record<TypeCompte, { libelle: string; icone: string }> = {
  caisse: { libelle: 'Caisse (tiroir)', icone: '💵' },
  caisse_centrale: { libelle: 'Caisse centrale', icone: '🏦' },
  mobile_money: { libelle: 'Mobile Money', icone: '📱' },
  banque: { libelle: 'Banque', icone: '🏛️' },
  autre: { libelle: 'Autre', icone: '💼' },
};

/** Comptes de trésorerie actifs (pour choisir « payé depuis… »). */
export function useComptes(org: string | undefined, tous = false) {
  const [comptes, setComptes] = useState<CompteTresorerie[]>([]);
  const charger = useCallback(async () => {
    if (!org) return;
    let q = supabase.from('comptes_tresorerie').select('*').eq('organisation_id', org).order('ordre').order('nom');
    if (!tous) q = q.eq('actif', true);
    const { data } = await q;
    setComptes((data ?? []) as CompteTresorerie[]);
  }, [org, tous]);
  useEffect(() => {
    void charger();
  }, [charger]);
  return { comptes, charger };
}

export const aujourdhui = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const dateFr = (s: string | null | undefined) => (s ? new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString('fr-FR') : '—');
