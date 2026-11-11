import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import type { Magasin } from './types';
import { pontAndroid } from './android';
import { useMagasinGlobal } from './magasinGlobal';
import { exporterClasseur } from './export';

export const LIBELLES_MOUVEMENTS: Record<string, string> = {
  reception: 'Réception',
  retour_client: 'Retour client',
  transfert_entree: 'Transfert reçu',
  ajustement_plus: 'Ajustement +',
  inventaire_plus: 'Inventaire +',
  vente: 'Vente',
  retour_fournisseur: 'Retour fournisseur',
  transfert_sortie: 'Transfert envoyé',
  ajustement_moins: 'Ajustement −',
  inventaire_moins: 'Inventaire −',
  perte: 'Perte',
  casse: 'Casse',
  vol: 'Vol',
  avarie: 'Avarie',
  peremption: 'Péremption',
  consommation: 'Consommation interne',
};

export const TYPES_SORTIE_MANUELLE: { code: string; libelle: string; ajustement?: boolean }[] = [
  { code: 'perte', libelle: 'Perte' },
  { code: 'casse', libelle: 'Casse' },
  { code: 'vol', libelle: 'Vol' },
  { code: 'avarie', libelle: 'Avarie' },
  { code: 'peremption', libelle: 'Produit périmé' },
  { code: 'consommation', libelle: 'Consommation interne' },
  { code: 'ajustement_plus', libelle: 'Ajustement en plus (correction)', ajustement: true },
  { code: 'ajustement_moins', libelle: 'Ajustement en moins (correction)', ajustement: true },
];

const fmtQ = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });
export function quantite(v: number | string | null | undefined): string {
  return fmtQ.format(Number(v ?? 0)).replace(/[  ]/g, ' ');
}

/** Magasins actifs accessibles à l'utilisateur (la base filtre déjà selon son périmètre). */
export function useMagasins(org: string | undefined) {
  const [magasins, setMagasins] = useState<Magasin[]>([]);
  useEffect(() => {
    if (!org) return;
    void supabase
      .from('magasins')
      .select('*')
      .eq('organisation_id', org)
      .eq('actif', true)
      .order('code')
      .then(({ data }) => setMagasins((data ?? []) as Magasin[]));
  }, [org]);
  return magasins;
}

/** Magasin de travail retenu sur cet appareil. */
export function useMagasinCourant(org: string | undefined, magasins: Magasin[]): [string, (id: string) => void] {
  const cle = `dfg_magasin_${org}`;
  const [id, setId] = useState<string>(() => {
    try {
      return localStorage.getItem(cle) ?? '';
    } catch {
      return '';
    }
  });
  const global = useMagasinGlobal();
  useEffect(() => {
    if (magasins.length && !magasins.some((m) => m.id === id)) setId(magasins[0]!.id);
  }, [magasins, id]);
  // Un magasin précis choisi en haut de l'écran s'impose aux pages de stock.
  useEffect(() => {
    if (global && magasins.some((m) => m.id === global)) setId(global);
  }, [global, magasins]);
  const choisir = (v: string) => {
    setId(v);
    try {
      localStorage.setItem(cle, v);
    } catch {
      /* stockage indisponible */
    }
  };
  return [id, choisir];
}

/** Export Excel (.xlsx) d'un tableau simple. Le nom historique est gardé pour les appels existants. */
export function telechargerCsv(nom: string, entetes: string[], lignes: (string | number | null | undefined)[][], format: 'xlsx' | 'pdf' = 'xlsx') {
  const echapper = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Vrai classeur Excel (.xlsx) : colonnes à la bonne largeur, nombres reconnus comme des nombres.
  const feuille = {
    nom: 'Export',
    entetes,
    lignes: lignes.map((l) => l.map((v) => (v === null || v === undefined ? '' : v))),
    largeurs: entetes.map((e, i) => Math.max(10, Math.min(46, Math.max(e.length, ...lignes.slice(0, 200).map((l) => String(l[i] ?? '').length)) + 3))),
  };
  if (exporterClasseur(nom, [{ ...feuille, titre: [nom.replace(/\.(csv|xlsx)$/i, '').replace(/-/g, ' ')] }], format)) return;
  // Ancienne application Android sans enregistrement de fichiers binaires : repli en CSV.
  const contenu = [entetes, ...lignes].map((l) => l.map(echapper).join(';')).join('\r\n');
  // Application Android : le fichier est enregistré dans « Téléchargements ».
  const android = pontAndroid();
  if (android) {
    const message = android.enregistrer(nom, 'text/csv', '\ufeff' + contenu);
    if (message) window.alert(message);
    return;
  }
  const blob = new Blob(['﻿' + contenu], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nom;
  a.click();
  URL.revokeObjectURL(url);
}

export function nouvelleCle(): string {
  return crypto.randomUUID();
}
