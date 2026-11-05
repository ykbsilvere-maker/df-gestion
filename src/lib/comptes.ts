import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { encoderCode, lireConfiguration } from './config';

export interface ResultatCompte {
  ok: boolean;
  message: string;
  /** La fonction serveur « comptes » n'est pas installée sur le projet Supabase. */
  absente?: boolean;
  /** « existe » : la personne a déjà un compte (elle garde son mot de passe). */
  statut?: string;
}

/**
 * Création d'un accès (mot de passe provisoire) ou réinitialisation, par la fonction
 * serveur « comptes ». La base vérifie les droits de la personne qui agit.
 */
export async function gererCompte(
  action: 'creer' | 'reinitialiser',
  email: string,
  motDePasse: string,
  nom?: string,
): Promise<ResultatCompte> {
  const { data, error } = await supabase.functions.invoke('comptes', {
    body: { action, email, mot_de_passe: motDePasse, nom },
  });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const statut = (error.context as Response).status;
      if (statut === 404)
        return {
          ok: false,
          absente: true,
          message: 'La fonction « comptes » n’est pas installée sur votre projet Supabase (voir le guide d’installation).',
        };
      try {
        const corps = (await (error.context as Response).json()) as { erreur?: string };
        return { ok: false, message: corps.erreur ?? `Refusé (${statut})` };
      } catch {
        return { ok: false, message: `Refusé (${statut})` };
      }
    }
    return { ok: false, message: 'Serveur injoignable : réessayez une fois connecté.' };
  }
  const r = data as { ok: boolean; message?: string; erreur?: string; statut?: string };
  return { ok: r.ok, statut: r.statut, message: (r.ok ? r.message : r.erreur) ?? '' };
}

/** Mot de passe provisoire lisible (sans caractères ambigus), 10 caractères. */
export function genererMotDePasse(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const valeurs = crypto.getRandomValues(new Uint32Array(10));
  const brut = Array.from(valeurs, (v) => alphabet[v % alphabet.length]).join('');
  return `${brut.slice(0, 5)}-${brut.slice(5)}`;
}

/** Message prêt à envoyer (WhatsApp, SMS) avec les identifiants et le code de configuration. */
export function messageIdentifiants(p: { nom?: string; entreprise?: string; email: string; motDePasse: string }): string {
  const config = lireConfiguration();
  return [
    `Bonjour${p.nom ? ` ${p.nom}` : ''},`,
    `Votre accès au logiciel Le Décodeur Financier${p.entreprise ? ` pour ${p.entreprise}` : ''} :`,
    `• Identifiant : ${p.email}`,
    `• Mot de passe provisoire : ${p.motDePasse}`,
    'À la première connexion, vous choisirez votre propre mot de passe.',
    ...(config
      ? ['', 'Si l’application demande sa configuration, collez ce code :', encoderCode(config)]
      : []),
  ].join('\n');
}
