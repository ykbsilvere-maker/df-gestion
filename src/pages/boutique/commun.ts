import { montant } from '../../lib/argent';

/** Adresse publique du site DF Marché (config.js → marcheUrl). */
export function marcheUrl(chemin = ''): string {
  const base = (typeof window !== 'undefined' && window.DFG_CONFIG?.marcheUrl) || 'https://dfmarche.netlify.app';
  return base.replace(/\/+$/, '') + chemin;
}

export type StatutCommande = 'nouvelle' | 'confirmee' | 'prete' | 'en_livraison' | 'livree' | 'annulee';
export type Paiement = 'livraison' | 'wave' | 'orange_money' | 'mtn' | 'moov' | 'djamo';
export type StatutPaiement = 'a_la_livraison' | 'a_verifier' | 'confirme' | 'refuse';

export const STATUTS: Record<StatutCommande, { libelle: string; ton: 'or' | 'bleu' | 'vert' | 'gris' | 'rouge'; icone: string }> = {
  nouvelle: { libelle: 'Nouvelle', ton: 'or', icone: '🆕' },
  confirmee: { libelle: 'Confirmée', ton: 'bleu', icone: '👍' },
  prete: { libelle: 'Prête', ton: 'bleu', icone: '📦' },
  en_livraison: { libelle: 'En livraison', ton: 'bleu', icone: '🛵' },
  livree: { libelle: 'Livrée', ton: 'vert', icone: '✅' },
  annulee: { libelle: 'Annulée', ton: 'gris', icone: '✖️' },
};

export const PAIEMENTS: Record<Paiement, { libelle: string; couleur: string }> = {
  livraison: { libelle: 'À la livraison', couleur: '#555' },
  wave: { libelle: 'Wave', couleur: '#1dc8f2' },
  orange_money: { libelle: 'Orange Money', couleur: '#ff7900' },
  mtn: { libelle: 'MTN MoMo', couleur: '#ffcb05' },
  moov: { libelle: 'Moov Money', couleur: '#0066b3' },
  djamo: { libelle: 'Djamo', couleur: '#2b2b38' },
};

export const STATUTS_PAIEMENT: Record<StatutPaiement, { libelle: string; ton: 'or' | 'vert' | 'gris' | 'rouge' }> = {
  a_la_livraison: { libelle: 'Paiement à la livraison', ton: 'gris' },
  a_verifier: { libelle: 'Paiement à vérifier', ton: 'or' },
  confirme: { libelle: 'Paiement reçu', ton: 'vert' },
  refuse: { libelle: 'Paiement non reçu', ton: 'rouge' },
};

/** Numéro ivoirien pour wa.me : 10 chiffres → 225XXXXXXXXXX. */
export function numeroWhatsapp(tel: string | null | undefined): string {
  const c = (tel ?? '').replace(/[^0-9]/g, '');
  if (c.length === 10) return `225${c}`;
  return c;
}

export function lienWhatsapp(tel: string | null | undefined, message: string): string {
  return `https://wa.me/${numeroWhatsapp(tel)}?text=${encodeURIComponent(message)}`;
}

export interface CommandeResume {
  numero: string;
  client_nom: string;
  total: number;
  mode: 'livraison' | 'retrait';
  souhaite_le: string | null;
  code_suivi?: string;
}

const quand = (d: string | null) =>
  d ? new Date(d).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : null;

/** Message prêt à envoyer au client, selon l'étape. */
export function messageClient(c: CommandeResume, statut: StatutCommande, boutique: string, motif?: string | null): string {
  const bonjour = `Bonjour ${c.client_nom.split(' ')[0]}, ici ${boutique}.`;
  const suivi = c.code_suivi ? `\nSuivi : ${marcheUrl(`/suivi/${c.code_suivi}`)}` : '';
  switch (statut) {
    case 'confirmee':
      return `${bonjour}\nVotre commande ${c.numero} (${montant(c.total)}) est confirmée.${
        c.souhaite_le ? `\n${c.mode === 'livraison' ? 'Livraison prévue' : 'Retrait prévu'} : ${quand(c.souhaite_le)}.` : ''
      }${suivi}`;
    case 'prete':
      return c.mode === 'retrait'
        ? `${bonjour}\nVotre commande ${c.numero} est prête : vous pouvez passer la récupérer.${suivi}`
        : `${bonjour}\nVotre commande ${c.numero} est prête, elle part bientôt en livraison.${suivi}`;
    case 'en_livraison':
      return `${bonjour}\nVotre commande ${c.numero} est en route. Le livreur vous appellera à l'arrivée.${suivi}`;
    case 'livree':
      return `${bonjour}\nMerci pour votre achat ! Donnez votre avis sur les produits ici :${suivi || ' ' + marcheUrl()}`;
    case 'annulee':
      return `${bonjour}\nNous sommes désolés : votre commande ${c.numero} est annulée.${motif ? `\nMotif : ${motif}` : ''}`;
    default:
      return `${bonjour}\nNous avons bien reçu votre commande ${c.numero} (${montant(c.total)}).${suivi}`;
  }
}
