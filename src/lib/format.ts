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
  if (/Could not find the function|schema cache/i.test(brut))
    return 'Le serveur n’est pas encore à jour pour cette fonction : la base de données doit être mise à jour (contactez l’administrateur).';
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
  'connexion.code_entree': 'Connexion avec le code d’entrée',
  'activite.module_ouvert': 'Ouverture d’un module',
  'activite.fenetre_fermee': 'Fermeture d’une fenêtre',
  'activite.fenetre_reduite': 'Fenêtre réduite',
  'activite.impression': 'Impression',
  'activite.export': 'Export de fichier',
  'activite.verrouillage': 'Verrouillage de l’écran',
  'activite.deverrouillage': 'Déverrouillage de l’écran',
  'activite.code_refuse': 'Code d’entrée refusé',
  'activite.deconnexion': 'Déconnexion',
  'connexion.code_entree_refuse': 'Code d’entrée refusé (plusieurs essais)',
  'journee.ouverte': 'Ouverture de la journée',
  'journee.cloturee': 'Clôture de la journée',
  'journee.reouverte': 'Réouverture de la journée',
  'import.catalogue': 'Import d’articles depuis Excel',
  'demande.soumise': 'Demande d’ouverture envoyée',
  'demande.valider': 'Demande d’ouverture validée',
  'demande.refuser': 'Demande d’ouverture refusée',
  'demande.ajourner': 'Demande d’ouverture ajournée',
  'depenses.insert': 'Dépense enregistrée',
  'depenses.update': 'Dépense modifiée ou annulée',
  'virements.insert': 'Virement entre comptes',
  'clients.insert': 'Création de client',
  'clients.update': 'Modification de client',
};

const VERBES: Record<string, string> = { insert: 'Création', update: 'Modification', delete: 'Suppression' };

export function libelleAction(code: string): string {
  if (LIBELLES_ACTIONS[code]) return LIBELLES_ACTIONS[code]!;
  // Opération sans libellé prévu : « ventes_lignes.insert » → « Création — ventes lignes ».
  const [objet = '', verbe = ''] = code.split('.');
  const nom = objet.replace(/_/g, ' ');
  return VERBES[verbe] ? `${VERBES[verbe]} — ${nom}` : `${nom.charAt(0).toUpperCase()}${nom.slice(1)}${verbe ? ` : ${verbe.replace(/_/g, ' ')}` : ''}`;
}

/** Icône de la famille d'une opération du journal. */
export function iconeAction(code: string): string {
  if (/refuse/.test(code)) return '⛔';
  if (/^activite\.(impression|export)/.test(code)) return code.includes('export') ? '⬇️' : '🖨️';
  if (/^activite\./.test(code)) return '🖱️';
  if (/^(session|connexion)\./.test(code)) return code.includes('deconnexion') ? '🚪' : '🔑';
  if (/^journee\./.test(code)) return '📅';
  if (/^(sessions_caisse|caisses|ventes|moyens_paiement)/.test(code)) return '🛒';
  if (/^(membres|membre_|invitations|compte)/.test(code)) return '👤';
  if (/^(produits|categories|codes_barres|import)/.test(code)) return '🛍️';
  if (/^(receptions|transferts|inventaires|fournisseurs)/.test(code)) return '📦';
  if (/^(depenses|virements|encaissements|paiements)/.test(code)) return '💰';
  return '⚙️';
}

/** « Android · Chrome », « Windows · Edge »… à partir de la signature du navigateur. */
export function appareilLisible(ua: string | undefined | null): string {
  if (!ua) return '';
  const systeme = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone / iPad' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  const appli = /DFGestion|; wv\)/.test(ua) ? 'Application DF Gestion' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  return [systeme, appli].filter(Boolean).join(' · ');
}

const LIBELLES_CHAMPS: Record<string, string> = {
  nom: 'Nom', designation: 'Désignation', prix_vente: 'Prix de vente', prix_achat: 'Prix d’achat', actif: 'Actif', statut: 'Statut',
  role_code: 'Rôle', telephone: 'Téléphone', email: 'E-mail', adresse: 'Adresse', taux_tva: 'TVA (%)', seuil_min: 'Stock minimum',
  seuil_max: 'Stock maximum', categorie_id: 'Catégorie', fournisseur_id: 'Fournisseur', libelle: 'Libellé', code: 'Code', unite: 'Unité',
  fond_initial: 'Fond de caisse', especes_comptees: 'Espèces comptées', ecart: 'Écart', motif_ecart: 'Motif de l’écart', total: 'Total',
  cloturee_le: 'Clôturée le', ouverte_le: 'Ouverte le', caissier_id: 'Caissier', magasin_id: 'Magasin', caisse_id: 'Caisse', montant: 'Montant',
  motif: 'Motif', note: 'Note', reference: 'Référence', photo_path: 'Photo', marque: 'Marque', gere_peremption: 'Suivi de péremption',
  date_reception: 'Date de réception', derniere_connexion: 'Dernière connexion', crees: 'Créés', mis_a_jour: 'Mis à jour', erreurs: 'Erreurs',
  appareil: 'Appareil', navigateur: 'Navigateur', module: 'Module', document: 'Document', fichier: 'Fichier', entreprise: 'Entreprise', nombre_ventes: 'Nombre de ventes', total_ventes: 'Total des ventes',
};
export function libelleChamp(c: string): string {
  return LIBELLES_CHAMPS[c] ?? c.replace(/_id$/, '').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
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
