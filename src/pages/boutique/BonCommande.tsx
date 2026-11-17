import { montant } from '../../lib/argent';
import type { Organisation } from '../../lib/types';
import { PapierEntete } from '../credits/papier';
import { libellePaiement, STATUTS_PAIEMENT, type Paiement, type StatutPaiement } from './commun';

/** Ce qu'il faut d'une commande DF Marché pour imprimer son reçu ou son bon. */
export interface CommandeImprimable {
  numero: string;
  code_suivi: string;
  client_nom: string;
  client_telephone: string;
  mode: 'livraison' | 'retrait';
  zone_nom: string | null;
  adresse: string | null;
  repere: string | null;
  created_at: string;
  sous_total: number;
  frais_livraison: number;
  total: number;
  paiement: Paiement;
  paiement_statut: StatutPaiement;
  paiement_libelle?: string | null;
  numero_payeur: string | null;
  reference_paiement: string | null;
  paiement_confirme_le?: string | null;
  confirme_par?: string | null;
  numero_boutique: string | null;
  vente: { numero: string } | null;
  lignes: { produit_id: string; designation: string; quantite: number; prix_unitaire: number; montant: number }[];
}

const quand = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

/**
 * Reçu de paiement (paiement confirmé) ou bon de commande, sur le papier à en-tête :
 * copie de la boutique, avec le mode de paiement et les références de la transaction.
 */
export function BonCommandeWeb({ c, o, logoUrl }: { c: CommandeImprimable; o: Organisation | undefined; logoUrl: string | null }) {
  const paye = c.paiement_statut === 'confirme';
  const enLigne = c.paiement !== 'livraison';
  return (
    <PapierEntete
      o={o}
      logoUrl={logoUrl}
      titre={paye ? 'Reçu de paiement — commande en ligne' : 'Bon de commande en ligne'}
      reference={<>N° {c.numero}<br />du {quand(c.created_at)}</>}
    >
      <div className="bloc-infos">
        <div><span>Client</span><strong>{c.client_nom}</strong><small>{c.client_telephone}</small></div>
        <div>
          <span>{c.mode === 'livraison' ? 'Livraison' : 'Retrait en boutique'}</span>
          <strong>{c.mode === 'livraison' ? c.zone_nom ?? '—' : 'Au magasin'}</strong>
          {c.mode === 'livraison' && <small>{[c.adresse, c.repere].filter(Boolean).join(' · ')}</small>}
        </div>
        <div><span>Code de suivi</span><strong>{c.code_suivi}</strong></div>
        {c.vente && <div><span>Ticket de caisse</span><strong>{c.vente.numero}</strong></div>}
      </div>
      <table className="rapport-tableau">
        <thead>
          <tr><th>Article</th><th className="nombre">Quantité</th><th className="nombre">Prix unitaire</th><th className="nombre">Montant</th></tr>
        </thead>
        <tbody>
          {c.lignes.map((l) => (
            <tr key={l.produit_id}>
              <td>{l.designation}</td>
              <td className="nombre">{Number(l.quantite)}</td>
              <td className="nombre">{montant(l.prix_unitaire)}</td>
              <td className="nombre">{montant(l.montant)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={3}>Articles</td><td className="nombre">{montant(c.sous_total)}</td></tr>
          {c.mode === 'livraison' && <tr><td colSpan={3}>Livraison ({c.zone_nom})</td><td className="nombre">{montant(c.frais_livraison)}</td></tr>}
          <tr><td colSpan={3}>Total</td><td className="nombre">{montant(c.total)}</td></tr>
        </tfoot>
      </table>
      <div className="bloc-infos bloc-paiement-web">
        <div><span>Mode de paiement</span><strong>{enLigne ? libellePaiement(c.paiement, c.paiement_libelle) : `À la ${c.mode === 'livraison' ? 'livraison' : 'récupération'}`}</strong></div>
        {enLigne && <div><span>Payé au</span><strong>{c.numero_boutique ?? '—'}</strong><small>numéro de la boutique</small></div>}
        {c.numero_payeur && <div><span>Depuis le numéro</span><strong>{c.numero_payeur}</strong></div>}
        {c.reference_paiement && <div><span>Référence transaction</span><strong>{c.reference_paiement}</strong></div>}
        <div>
          <span>Statut du paiement</span>
          <strong>{STATUTS_PAIEMENT[c.paiement_statut].libelle}</strong>
          {paye && <small>le {quand(c.paiement_confirme_le)}{c.confirme_par ? ` par ${c.confirme_par}` : ''}</small>}
        </div>
      </div>
      <p className="secondaire">
        {paye
          ? 'Paiement vérifié sur le téléphone de la boutique et confirmé. Copie à conserver par la boutique.'
          : 'Bon de commande : ce document n’est pas une preuve de paiement.'}
      </p>
      <div className="signatures">
        <div>Le client<br /><span>Reçu conforme, date et signature</span></div>
        <div>{c.mode === 'livraison' ? 'Le livreur' : 'La caissière / Le caissier'}<br /><span>Nom et signature</span></div>
        <div>Le gérant<br /><span>Signature et cachet</span></div>
      </div>
    </PapierEntete>
  );
}
