import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { appeler, supabase, type Compte } from './api';

/**
 * Compte client DF Marché : adresse e-mail + mot de passe (téléphone facultatif, dans le profil).
 * Les anciens comptes créés avec un numéro se connectent toujours : le numéro devient l'identifiant
 * technique « 2250700000000@tel.dfmarche.ci » (aucun e-mail n'y est envoyé).
 */
export function identifiantVersEmail(saisie: string): string {
  const s = saisie.trim().toLowerCase();
  if (s.includes('@')) return s;
  let chiffres = s.replace(/\D/g, '');
  if (chiffres.length === 10) chiffres = `225${chiffres}`;
  return `${chiffres}@tel.dfmarche.ci`;
}

export const estTelephone = (email: string | null | undefined) => !!email?.endsWith('@tel.dfmarche.ci');

let etat: { session: Session | null; compte: Compte | null; pret: boolean } = { session: null, compte: null, pret: false };
const abonnes = new Set<() => void>();
const publier = (x: Partial<typeof etat>) => {
  etat = { ...etat, ...x };
  abonnes.forEach((f) => f());
};

export async function rechargerCompte() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) return publier({ session: null, compte: null, pret: true });
  try {
    const c = await appeler<Compte | null>('compte_marche');
    publier({ session: data.session, compte: c, pret: true });
  } catch {
    publier({ session: data.session, compte: null, pret: true });
  }
}

void rechargerCompte();
supabase.auth.onAuthStateChange((evenement) => {
  if (evenement === 'SIGNED_IN' || evenement === 'SIGNED_OUT' || evenement === 'USER_UPDATED') void rechargerCompte();
});

export function useCompte() {
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

export async function connexion(identifiant: string, motDePasse: string) {
  const { error } = await supabase.auth.signInWithPassword({ email: identifiantVersEmail(identifiant), password: motDePasse });
  if (error) throw new Error(/invalid/i.test(error.message) ? 'Identifiant ou mot de passe incorrect.' : error.message);
  await rechargerCompte();
}

export async function inscription(p: { identifiant: string; motDePasse: string; nom: string; telephone: string }) {
  const email = p.identifiant.trim().toLowerCase();
  if (!email.includes('@')) throw new Error('Créez votre compte avec votre adresse e-mail.');
  const { data, error } = await supabase.auth.signUp({ email, password: p.motDePasse, options: { data: { nom_complet: p.nom } } });
  if (error) throw new Error(/registered|exists/i.test(error.message) ? 'Un compte existe déjà avec cet identifiant : connectez-vous.' : error.message);
  if (!data.session) throw new Error('Compte créé : confirmez votre adresse e-mail puis connectez-vous.');
  await appeler('compte_marche_enregistrer', { p: { nom: p.nom, telephone: p.telephone || null } });
  await rechargerCompte();
}

export async function deconnexion() {
  await supabase.auth.signOut();
  publier({ session: null, compte: null });
}
