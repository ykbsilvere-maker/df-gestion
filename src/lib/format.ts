import { montant } from './argent';
/** Messages d'erreur lisibles pour l'utilisateur (les règles métier viennent déjà en français de la base). */
export function messageErreur(e: unknown): string {
  const brut =
    typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) : String(e);
  if (/Invalid login credentials/i.test(brut)) return 'E-mail ou mot de passe incorrect.';
  if (/Email not confirmed/i.test(brut)) return 'Confirmez d’abord votre adresse e-mail (lien reçu par mail).';
  if (/User already registered/i.test(brut)) return 'Un compte existe déjà avec cette adresse e-mail.';
  if (/Password should be at least/i.test(brut)) return 'Le mot de passe doit contenir au moins 8 caractères.';
  if (/row-level security|permission denied/i.test(brut)) return 'Vous n’avez pas les droits pour cette opération.';
  if (/duplicate key.*code/i.test(brut)) return 'Ce code est déjà utilisé.';
  if (/check constraint.*code/i.test(brut)) return 'Code invalide : 2 à 20 caractères, majuscules, chiffres, - ou _.';
  if (/Failed to fetch|NetworkError/i.test(brut)) return 'Connexion Internet indisponible. Réessayez.';
  if (/organisations_devise_check/.test(brut)) return 'Monnaie non prise en charge.';
  // Montants renvoyés par le serveur en plus petite unité (« 1250 F ») : affichés dans la monnaie de l'entreprise.
  return brut.replace(/\b(\d+) F\b/g, (_, n: string) => montant(Number(n)));
}

const fmtDateHeure = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Africa/Abidjan',
});

export function dateHeure(iso: string | null | undefined): string {
  return iso ? fmtDateHeure.format(new Date(iso)) : '—';
}

/** Libellés des actions du journal d'audit. */
const LIBELLES_ACTIONS: Record<string, string> = {
  'session.connexion': 'Connexion',
  'session.deconnexion': 'Déconnexion',
  'organisations.insert': 'Création de l’entreprise',
  'organisations.update': 'Modification de l’entreprise',
  'magasins.insert': 'Création de magasin',
  'magasins.update': 'Modification de magasin',
  'caisses.insert': 'Création de caisse',
  'caisses.update': 'Modification de caisse',
  'membres.insert': 'Ajout d’un utilisateur',
  'membres.update': 'Modification d’un utilisateur',
  'membre_magasins.insert': 'Magasin attribué',
  'membre_magasins.delete': 'Magasin retiré',
  'membre_caisses.insert': 'Caisse attribuée',
  'membre_caisses.delete': 'Caisse retirée',
  'membre_permissions.insert': 'Droit individuel ajouté',
  'membre_permissions.update': 'Droit individuel modifié',
  'membre_permissions.delete': 'Droit individuel remis par défaut',
  'invitations.insert': 'Invitation envoyée',
  'invitations.update': 'Invitation traitée',
  'parametres_impression.update': 'Modèle de reçu modifié',
  'categories.insert': 'Création de catégorie',
  'categories.update': 'Modification de catégorie',
  'produits.insert': 'Création de produit',
  'produits.update': 'Modification de produit',
  'codes_barres.insert': 'Code-barres ajouté',
  'codes_barres.delete': 'Code-barres retiré',
  'fournisseurs.insert': 'Création de fournisseur',
  'fournisseurs.update': 'Modification de fournisseur',
  'receptions.insert': 'Réception commencée',
  'receptions.update': 'Réception modifiée ou validée',
  'transferts.insert': 'Transfert entre magasins',
  'inventaires.insert': 'Inventaire ouvert',
  'inventaires.update': 'Inventaire modifié ou validé',
  'moyens_paiement.insert': 'Moyen de règlement ajouté',
  'moyens_paiement.update': 'Moyen de règlement modifié',
  'sessions_caisse.insert': 'Ouverture de caisse',
  'sessions_caisse.update': 'Clôture de caisse',
  'ventes.annulation': 'Annulation de vente',
  'compte.acces_cree': 'Accès créé (mot de passe provisoire)',
  'compte.mot_de_passe_reinitialise': 'Mot de passe réinitialisé',
  'plateforme.admin_general': 'Administrateur général désigné',
  'plateforme.inscription_libre': 'Règle d’inscription modifiée',
};

export function libelleAction(code: string): string {
  return LIBELLES_ACTIONS[code] ?? code;
}

/** Champs modifiés entre deux états d'une ligne (pour le détail du journal). */
export function differences(
  avant: Record<string, unknown> | null,
  apres: Record<string, unknown> | null,
): { champ: string; avant: unknown; apres: unknown }[] {
  const ignores = new Set(['updated_at', 'created_at', 'id', 'organisation_id']);
  const champs = new Set([...Object.keys(avant ?? {}), ...Object.keys(apres ?? {})]);
  return [...champs]
    .filter((c) => !ignores.has(c))
    .filter((c) => JSON.stringify(avant?.[c]) !== JSON.stringify(apres?.[c]))
    .map((c) => ({ champ: c, avant: avant?.[c], apres: apres?.[c] }));
}

export function nomAppareil(): string {
  try {
    return localStorage.getItem('dfg_appareil') || 'Navigateur';
  } catch {
    return 'Navigateur';
  }
}
