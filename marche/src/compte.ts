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

let etat: { session: Session | null; compte: Compte | null; pret: boolean; bons: number } = { session: null, compte: null, pret: false, bons: 0 };
const abonnes = new Set<() => void>();
const publier = (x: Partial<typeof etat>) => {
  etat = { ...etat, ...x };
  abonnes.forEach((f) => f());
};

export async function rechargerCompte() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) return publier({ session: null, compte: null, pret: true, bons: 0 });
  try {
    let c = await appeler<Compte | null>('compte_marche');
    // Compte confirmé par e-mail : la fiche client est créée à la première connexion, avec le nom saisi à l'inscription.
    const meta = data.session.user.user_metadata as { source?: string; nom_complet?: string; telephone?: string } | undefined;
    if (!c && meta?.source === 'dfmarche' && meta.nom_complet) {
      c = await appeler<Compte | null>('compte_marche_enregistrer', { p: { nom: meta.nom_complet, telephone: meta.telephone || null } });
    }
    publier({ session: data.session, compte: c, pret: true });
    void compterBons();
  } catch {
    publier({ session: data.session, compte: null, pret: true });
  }
}

void rechargerCompte();
supabase.auth.onAuthStateChange((evenement) => {
  // Différé : on ne rappelle pas Supabase depuis l'intérieur de l'écouteur.
  if (evenement === 'SIGNED_IN' || evenement === 'SIGNED_OUT' || evenement === 'USER_UPDATED') window.setTimeout(() => void rechargerCompte(), 0);
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
  if (error) {
    if (/not confirmed/i.test(error.message)) throw new EmailNonConfirme(identifiant.trim().toLowerCase());
    throw new Error(/invalid/i.test(error.message) ? 'Adresse e-mail ou mot de passe incorrect.' : error.message);
  }
  await rechargerCompte();
}

/** Mis à jour par les alertes (vérification régulière). */
export const publierBons = (n: number) => etat.bons !== n && publier({ bons: n });

/** Nombre de bons d'achat disponibles (affiché sur « Compte » et « Bons d'achat », sans ouvrir la page). */
export async function compterBons() {
  if (!etat.session) return publier({ bons: 0 });
  try {
    const bons = await appeler<unknown[]>('mes_bons_marche');
    publier({ bons: Array.isArray(bons) ? bons.length : 0 });
  } catch {
    /* compteur indisponible */
  }
}

/** Lien de confirmation : il ramène sur DF Marché, qui ouvre la session et crée la fiche client. */
const retourConfirmation = () => `${window.location.origin}/compte/confirme`;

/** Connexion refusée tant que l'adresse n'est pas confirmée. */
export class EmailNonConfirme extends Error {
  constructor(public email: string) {
    super('Confirmez d’abord votre adresse : ouvrez le lien reçu par e-mail.');
  }
}

/** Inscription : renvoie « a_confirmer » quand un e-mail de confirmation est parti (accès après le clic sur le lien). */
export async function inscription(p: { identifiant: string; motDePasse: string; nom: string; telephone: string }): Promise<'connecte' | 'a_confirmer'> {
  const email = p.identifiant.trim().toLowerCase();
  if (!email.includes('@')) throw new Error('Créez votre compte avec votre adresse e-mail.');
  const { data, error } = await supabase.auth.signUp({
    email,
    password: p.motDePasse,
    options: { data: { nom_complet: p.nom, telephone: p.telephone || null, source: 'dfmarche' }, emailRedirectTo: retourConfirmation() },
  });
  if (error) {
    if (/rate limit/i.test(error.message)) throw new Error('Trop d’inscriptions en même temps : réessayez dans quelques minutes.');
    throw new Error(/registered|exists/i.test(error.message) ? 'Un compte existe déjà avec cette adresse : connectez-vous.' : error.message);
  }
  // Adresse déjà inscrite : Supabase répond sans erreur mais sans identités.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0)
    throw new Error('Un compte existe déjà avec cette adresse : connectez-vous (ou « Mot de passe oublié »).');
  if (!data.session) return 'a_confirmer';
  await appeler('compte_marche_enregistrer', { p: { nom: p.nom, telephone: p.telephone || null } });
  await rechargerCompte();
  return 'connecte';
}

/** Renvoie l'e-mail de confirmation. */
export async function renvoyerConfirmation(email: string) {
  const { error } = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: retourConfirmation() } });
  if (error) throw new Error(/rate limit|seconds/i.test(error.message) ? 'Patientez une minute avant de renvoyer l’e-mail.' : error.message);
}

/** Mot de passe oublié : lien de réinitialisation par e-mail. */
export async function motDePasseOublie(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: `${window.location.origin}/compte/nouveau-mot-de-passe` });
  if (error) throw new Error(/rate limit|seconds/i.test(error.message) ? 'Patientez une minute avant de redemander le lien.' : error.message);
}

export async function deconnexion() {
  await supabase.auth.signOut();
  publier({ session: null, compte: null, bons: 0 });
}
