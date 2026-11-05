export type RegimeFiscal = 'entreprenant' | 'micro' | 'rsi' | 'rni' | 'non_precise';

export const REGIMES: { code: RegimeFiscal; libelle: string }[] = [
  { code: 'entreprenant', libelle: 'Entreprenant' },
  { code: 'micro', libelle: 'Micro-entreprise' },
  { code: 'rsi', libelle: 'Réel simplifié (RSI)' },
  { code: 'rni', libelle: 'Réel normal (RNI)' },
  { code: 'non_precise', libelle: 'Non précisé' },
];

export interface MonOrganisation {
  organisation_id: string;
  nom: string;
  membre_id: string;
  role_code: string;
  role_libelle: string;
  tous_magasins: boolean;
  permissions: string[];
  /** Code de la monnaie (XOF par défaut ; absent dans un ancien cache). */
  devise?: string;
}

export interface Organisation {
  id: string;
  nom: string;
  ncc: string | null;
  rccm: string | null;
  regime_fiscal: RegimeFiscal;
  telephone: string | null;
  email: string | null;
  adresse: string | null;
  ville: string | null;
  devise: string;
  logo_path: string | null;
  couleur: string;
}

export type FormatRecu = 'a4_6' | 'thermique_80' | 'thermique_58';

export interface ParametresImpression {
  organisation_id: string;
  format: FormatRecu;
  afficher_logo: boolean;
  entete: string | null;
  pied: string | null;
  mention_legale: string | null;
  afficher_caissier: boolean;
  afficher_ncc: boolean;
  decalage_x_mm: number | string;
  decalage_y_mm: number | string;
}

export interface Categorie {
  id: string;
  organisation_id: string;
  parent_id: string | null;
  nom: string;
  actif: boolean;
}

export type StatutProduit = 'actif' | 'suspendu' | 'arrete';

export interface Produit {
  id: string;
  organisation_id: string;
  code: string;
  designation: string;
  categorie_id: string | null;
  marque: string | null;
  unite: string;
  prix_vente: number | string;
  prix_achat: number | string | null;
  taux_tva: number | string;
  seuil_min: number | null;
  seuil_max: number | null;
  gere_peremption: boolean;
  photo_path: string | null;
  statut: StatutProduit;
}

export interface CodeBarres {
  id: string;
  produit_id: string;
  code: string;
  genere: boolean;
}

export const UNITES = ['pièce', 'kg', 'g', 'litre', 'cl', 'carton', 'paquet', 'sachet', 'boîte', 'bouteille', 'mètre', 'lot'];

export interface Magasin {
  id: string;
  organisation_id: string;
  code: string;
  nom: string;
  adresse: string | null;
  ville: string | null;
  telephone: string | null;
  actif: boolean;
}

export interface Caisse {
  id: string;
  organisation_id: string;
  magasin_id: string;
  code: string;
  nom: string;
  actif: boolean;
}

export interface Role {
  code: string;
  libelle: string;
  ordre: number;
}

export interface Membre {
  id: string;
  organisation_id: string;
  user_id: string;
  role_code: string;
  tous_magasins: boolean;
  actif: boolean;
  motif_desactivation: string | null;
  desactive_le: string | null;
  derniere_connexion: string | null;
  created_at: string;
}

export interface Profil {
  id: string;
  nom_complet: string | null;
  telephone: string | null;
  email: string | null;
}

export interface Invitation {
  id: string;
  email: string;
  role_code: string;
  tous_magasins: boolean;
  magasins: string[];
  caisses: string[];
  statut: 'en_attente' | 'acceptee' | 'annulee';
  created_at: string;
}

export interface LigneAudit {
  id: number;
  user_id: string | null;
  action: string;
  objet_type: string | null;
  objet_id: string | null;
  avant: Record<string, unknown> | null;
  apres: Record<string, unknown> | null;
  contexte: Record<string, unknown> | null;
  created_at: string;
}

export const MODULES: { code: string; libelle: string }[] = [
  { code: 'administration', libelle: 'Administration' },
  { code: 'magasins', libelle: 'Magasins et caisses' },
  { code: 'utilisateurs', libelle: 'Utilisateurs' },
  { code: 'audit', libelle: 'Journal d’audit' },
  { code: 'catalogue', libelle: 'Catalogue' },
  { code: 'stock', libelle: 'Stock' },
  { code: 'achats', libelle: 'Achats' },
  { code: 'caisse', libelle: 'Caisse' },
  { code: 'ventes', libelle: 'Ventes' },
  { code: 'clients', libelle: 'Clients' },
  { code: 'fournisseurs', libelle: 'Fournisseurs' },
  { code: 'rapports', libelle: 'Rapports' },
  { code: 'comptabilite', libelle: 'Comptabilité' },
];

export const ACTIONS: { code: string; libelle: string }[] = [
  { code: 'consulter', libelle: 'Consulter' },
  { code: 'creer', libelle: 'Créer' },
  { code: 'modifier', libelle: 'Modifier' },
  { code: 'valider', libelle: 'Valider' },
  { code: 'annuler', libelle: 'Annuler' },
  { code: 'supprimer', libelle: 'Supprimer' },
  { code: 'exporter', libelle: 'Exporter' },
  { code: 'cloturer', libelle: 'Clôturer' },
  { code: 'administrer', libelle: 'Administrer' },
];
