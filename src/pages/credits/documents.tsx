import type { ReactNode } from 'react';
import { montant } from '../../lib/argent';
import { quantite } from '../../lib/stock';
import { dateFr } from '../../lib/tresorerie';
import type { Organisation } from '../../lib/types';

/** Paramètres de la procédure de recouvrement (jours de retard qui déclenchent chaque étape). */
export interface Procedure {
  jours_rappel: number;
  palier_1: number;
  palier_2: number;
  palier_3: number;
  palier_4: number;
  blocage_palier: number;
}

export interface DerniereAction {
  action: string;
  niveau: number;
  created_at: string;
  date_promesse: string | null;
}

/** Une ligne de la liste des dossiers (credits_liste). */
export interface DossierCredit {
  id: string;
  numero: string;
  statut: 'brouillon' | 'valide' | 'annule';
  client_id: string;
  client: string;
  telephone: string | null;
  magasin: string;
  magasin_id: string;
  date_credit: string;
  duree_jours: number;
  echeance: string;
  total: number;
  responsable_id: string | null;
  responsable: string | null;
  articles: number;
  moi: boolean;
  reste: number;
  paye: number;
  jours_retard: number;
  jours_restants: number;
  etape: number;
  derniere_action: DerniereAction | null;
  promesse: string | null;
}

export interface LigneCredit {
  id: string;
  produit_id: string;
  designation: string;
  quantite: number | string;
  prix_unitaire: number;
  remise: number;
  montant: number;
}

export interface DetailCredit {
  dossier: DossierCredit & {
    note: string | null;
    motif_exception: string | null;
    motif_annulation: string | null;
    valide_le: string | null;
    cree_par_nom: string | null;
    total_remises: number;
  };
  client: {
    id: string;
    nom: string;
    telephone: string | null;
    email: string | null;
    adresse: string | null;
    contact: string | null;
    ncc: string | null;
    plafond_credit: number | null;
    delai_paiement: number;
    encours: number;
  };
  procedure: Procedure;
  lignes: LigneCredit[];
  encaissements: { id: string; date: string; montant: number; compte: string; reference: string | null; statut: string; a_la_caisse: boolean; par: string | null }[];
  suivi: {
    id: string;
    action: string;
    niveau: number;
    note: string | null;
    date_promesse: string | null;
    montant_promis: number | null;
    reste_du: number;
    jours_retard: number;
    le: string;
    par: string | null;
  }[];
}

/** Les étapes de la procédure, de « à jour » au contentieux. */
export const ETAPES: { titre: string; court: string; conseil: string; ton: 'vert' | 'gris' | 'or' | 'rouge' }[] = [
  { titre: 'À jour', court: 'À jour', conseil: 'Avant l’échéance, un rappel aimable évite la plupart des retards.', ton: 'vert' },
  { titre: 'Relance amiable', court: '1re relance', conseil: 'Téléphoner au client et lui remettre la lettre de relance amiable.', ton: 'or' },
  { titre: 'Seconde relance', court: '2e relance', conseil: 'Seconde lettre, visite au client et promesse de paiement datée.', ton: 'or' },
  { titre: 'Mise en demeure', court: 'Mise en demeure', conseil: 'Mise en demeure écrite remise contre signature ; plus de nouveau crédit.', ton: 'rouge' },
  { titre: 'Recouvrement contentieux', court: 'Contentieux', conseil: 'Dernier avis, puis transmission au recouvrement ou échéancier négocié.', ton: 'rouge' },
];

/** Jours de retard à partir desquels commence chaque étape (0 = à jour). */
export function seuils(p: Procedure): number[] {
  return [0, p.palier_1, p.palier_2, p.palier_3, p.palier_4];
}

export const ACTIONS_SUIVI: Record<string, { libelle: string; icone: string }> = {
  rappel: { libelle: 'Rappel avant échéance', icone: '🔔' },
  relance: { libelle: 'Lettre de relance', icone: '✉️' },
  appel: { libelle: 'Appel téléphonique', icone: '📞' },
  visite: { libelle: 'Visite au client', icone: '🚶' },
  message: { libelle: 'Message (SMS, WhatsApp)', icone: '💬' },
  promesse: { libelle: 'Promesse de paiement', icone: '🤝' },
  note: { libelle: 'Note', icone: '📝' },
};

const dateLongue = () => new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Abidjan' });

function EnTeteLettre({ o, logoUrl, client }: { o: Organisation | undefined; logoUrl: string | null; client: DetailCredit['client'] }) {
  return (
    <header className="lettre-entete">
      <div>
        {logoUrl && <img src={logoUrl} alt="" />}
        <strong>{o?.nom}</strong>
        <div>{[o?.adresse, o?.ville].filter(Boolean).join(', ')}</div>
        <div>{[o?.telephone, o?.email].filter(Boolean).join(' · ')}</div>
        {(o?.rccm || o?.ncc) && <div>{[o?.rccm && `RCCM ${o.rccm}`, o?.ncc && `NCC ${o.ncc}`].filter(Boolean).join(' · ')}</div>}
      </div>
      <div className="lettre-destinataire">
        <strong>{client.nom}</strong>
        {client.contact && <div>À l’attention de {client.contact}</div>}
        {client.adresse && <div>{client.adresse}</div>}
        {client.telephone && <div>{client.telephone}</div>}
      </div>
    </header>
  );
}

function TableauSituation({ d }: { d: DetailCredit }) {
  const x = d.dossier;
  return (
    <table className="rapport-tableau">
      <thead>
        <tr>
          <th>Crédit</th>
          <th>Accordé le</th>
          <th>Échéance</th>
          <th className="nombre">Montant</th>
          <th className="nombre">Déjà réglé</th>
          <th className="nombre">Reste dû</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{x.numero}</td>
          <td>{dateFr(x.date_credit)}</td>
          <td>{dateFr(x.echeance)}{x.jours_retard > 0 ? ` (${x.jours_retard} j de retard)` : ''}</td>
          <td className="nombre">{montant(x.total)}</td>
          <td className="nombre">{montant(x.paye)}</td>
          <td className="nombre"><strong>{montant(x.reste)}</strong></td>
        </tr>
      </tbody>
    </table>
  );
}

/** Textes des courriers : 0 = rappel avant échéance, 1 à 4 = étapes de la procédure. */
export function texteLettre(niveau: number, d: DetailCredit): { titre: string; corps: string; fin: string } {
  const x = d.dossier;
  const reste = montant(x.reste);
  switch (niveau) {
    case 0:
      return {
        titre: `Rappel d’échéance — crédit n° ${x.numero}`,
        corps: `Nous vous rappelons que le crédit n° ${x.numero} qui vous a été accordé le ${dateFr(x.date_credit)} arrive à échéance le ${dateFr(x.echeance)}. Le montant restant à régler est de ${reste}.`,
        fin: 'Nous vous remercions de bien vouloir prévoir ce règlement à la date convenue.',
      };
    case 1:
      return {
        titre: `Relance amiable — crédit n° ${x.numero}`,
        corps: `Sauf erreur de notre part, le crédit n° ${x.numero}, arrivé à échéance le ${dateFr(x.echeance)}, n’a pas encore été entièrement réglé. Le montant restant dû s’élève à ${reste}.`,
        fin: 'Il s’agit sans doute d’un oubli : nous vous remercions de procéder à ce règlement dans les meilleurs délais. Si votre paiement a été effectué entre-temps, merci de ne pas tenir compte de ce courrier.',
      };
    case 2:
      return {
        titre: `Seconde relance — crédit n° ${x.numero}`,
        corps: `Malgré notre précédent courrier, le crédit n° ${x.numero}, échu depuis le ${dateFr(x.echeance)} (${x.jours_retard} jours de retard), reste impayé pour un montant de ${reste}.`,
        fin: 'Nous vous demandons de régulariser votre situation sous huit (8) jours. À défaut, nous serons contraints de suspendre tout nouveau crédit à votre profit.',
      };
    case 3:
      return {
        titre: `Mise en demeure de payer — crédit n° ${x.numero}`,
        corps: `Malgré nos relances, la somme de ${reste} due au titre du crédit n° ${x.numero}, échu le ${dateFr(x.echeance)}, demeure impayée. Par la présente, nous vous mettons en demeure de régler cette somme sous huit (8) jours à compter de la réception de ce courrier.`,
        fin: 'À défaut de règlement dans ce délai, nous engagerons sans autre avis la procédure de recouvrement de notre créance. Ce courrier vaut mise en demeure.',
      };
    default:
      return {
        titre: `Dernier avis avant recouvrement contentieux — crédit n° ${x.numero}`,
        corps: `Notre mise en demeure est restée sans effet : la somme de ${reste} due au titre du crédit n° ${x.numero} reste impayée depuis le ${dateFr(x.echeance)}.`,
        fin: 'Sans règlement intégral sous quarante-huit (48) heures, le dossier sera transmis pour recouvrement contentieux. Les frais de recouvrement pourront être mis à votre charge dans les limites prévues par la loi.',
      };
  }
}

export function LettreCredit({ d, niveau, o, logoUrl }: { d: DetailCredit; niveau: number; o: Organisation | undefined; logoUrl: string | null }) {
  const t = texteLettre(niveau, d);
  return (
    <div className="rapport-a4 lettre">
      <EnTeteLettre o={o} logoUrl={logoUrl} client={d.client} />
      <p className="lettre-date">{o?.ville ? `${o.ville}, le ` : 'Le '}{dateLongue()}</p>
      <p><strong>Objet : {t.titre}</strong></p>
      {niveau === 3 && <p><strong>Lettre remise en main propre contre décharge</strong></p>}
      <p>Madame, Monsieur,</p>
      <p>{t.corps}</p>
      <TableauSituation d={d} />
      <p>{t.fin}</p>
      <p>Pour tout renseignement, votre interlocuteur est {d.dossier.responsable ?? 'la Direction'}.</p>
      <p>Nous vous prions d’agréer, Madame, Monsieur, l’expression de nos salutations distinguées.</p>
      <div className="lettre-signature">
        <div>La Direction</div>
        <div className="lettre-ligne-signature" />
      </div>
      {niveau >= 3 && (
        <div className="signatures signatures-2 decharge">
          <div>Reçu le<br /><span>Date</span></div>
          <div>Le client<br /><span>Nom et signature (décharge)</span></div>
        </div>
      )}
    </div>
  );
}

function Corps({ titre, o, logoUrl, d, children }: { titre: string; o: Organisation | undefined; logoUrl: string | null; d: DetailCredit; children: ReactNode }) {
  return (
    <div className="rapport-a4">
      <header className="rapport-entete">
        <div>
          <strong>{o?.nom}</strong>
          <h1>{titre}</h1>
          <p>
            {d.dossier.numero} · {d.client.nom} · {d.dossier.magasin}
          </p>
        </div>
        {logoUrl && <img src={logoUrl} alt="" />}
      </header>
      {children}
    </div>
  );
}

function TableauArticles({ d }: { d: DetailCredit }) {
  return (
    <table className="rapport-tableau">
      <thead>
        <tr>
          <th>Article</th>
          <th className="nombre">Quantité</th>
          <th className="nombre">Prix unitaire</th>
          <th className="nombre">Remise</th>
          <th className="nombre">Montant</th>
        </tr>
      </thead>
      <tbody>
        {d.lignes.map((l) => (
          <tr key={l.id}>
            <td>{l.designation}</td>
            <td className="nombre">{quantite(l.quantite)}</td>
            <td className="nombre">{montant(l.prix_unitaire)}</td>
            <td className="nombre">{Number(l.remise) ? montant(l.remise) : '—'}</td>
            <td className="nombre">{montant(l.montant)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={4}>Total du crédit</td>
          <td className="nombre">{montant(d.dossier.total)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/** Bon de crédit : articles remis, échéance et reconnaissance de dette signée. */
export function BonCredit({ d, o, logoUrl }: { d: DetailCredit; o: Organisation | undefined; logoUrl: string | null }) {
  const x = d.dossier;
  return (
    <Corps titre="Bon de crédit — reconnaissance de dette" o={o} logoUrl={logoUrl} d={d}>
      <div className="bloc-infos">
        <div><span>Client</span><strong>{d.client.nom}</strong>{d.client.telephone && <small>{d.client.telephone}</small>}</div>
        <div><span>Accordé le</span><strong>{dateFr(x.date_credit)}</strong></div>
        <div><span>Durée</span><strong>{x.duree_jours} jours</strong></div>
        <div><span>À payer au plus tard le</span><strong>{dateFr(x.echeance)}</strong></div>
      </div>
      <TableauArticles d={d} />
      <p className="reconnaissance">
        Je soussigné(e), <strong>{d.client.contact || d.client.nom}</strong>, reconnais avoir reçu les articles ci-dessus et
        m’engage à régler à <strong>{o?.nom}</strong> la somme de <strong>{montant(x.total)}</strong> au plus tard le{' '}
        <strong>{dateFr(x.echeance)}</strong>.
      </p>
      {x.note && <p>Conditions : {x.note}</p>}
      <p className="secondaire">Dossier suivi par {x.responsable ?? '—'}.</p>
      <div className="signatures">
        <div>Le client<br /><span>« Lu et approuvé », date et signature</span></div>
        <div>Le caissier / La caissière<br /><span>Nom et signature</span></div>
        <div>Le gérant<br /><span>Signature et cachet</span></div>
      </div>
    </Corps>
  );
}

/** Relevé du dossier : articles, règlements reçus et reste dû. */
export function ReleveCredit({ d, o, logoUrl }: { d: DetailCredit; o: Organisation | undefined; logoUrl: string | null }) {
  const reglements = d.encaissements.filter((e) => e.statut === 'enregistre');
  return (
    <Corps titre={`Relevé du crédit au ${dateFr(new Date().toISOString())}`} o={o} logoUrl={logoUrl} d={d}>
      <TableauArticles d={d} />
      <table className="rapport-tableau">
        <thead>
          <tr><th>Date</th><th>Règlement</th><th className="nombre">Montant</th></tr>
        </thead>
        <tbody>
          {reglements.length === 0 ? (
            <tr><td colSpan={3}>Aucun règlement reçu.</td></tr>
          ) : (
            reglements.map((e) => (
              <tr key={e.id}>
                <td>{dateFr(e.date)}</td>
                <td>{e.compte}{e.reference ? ` · ${e.reference}` : ''}</td>
                <td className="nombre">{montant(e.montant)}</td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr><td colSpan={2}>Total réglé</td><td className="nombre">{montant(d.dossier.paye)}</td></tr>
          <tr><td colSpan={2}>Reste dû (échéance {dateFr(d.dossier.echeance)})</td><td className="nombre">{montant(d.dossier.reste)}</td></tr>
        </tfoot>
      </table>
    </Corps>
  );
}

/** Reçu remis au client après un règlement. */
export function RecuReglement({
  d,
  o,
  logoUrl,
  reglement,
}: {
  d: DetailCredit;
  o: Organisation | undefined;
  logoUrl: string | null;
  reglement: { montant: number; moyen: string; reference: string | null; reste: number; par: string };
}) {
  return (
    <Corps titre="Reçu de règlement" o={o} logoUrl={logoUrl} d={d}>
      <div className="bloc-infos">
        <div><span>Date</span><strong>{new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Abidjan' })}</strong></div>
        <div><span>Montant reçu</span><strong>{montant(reglement.montant)}</strong></div>
        <div><span>Moyen</span><strong>{reglement.moyen}</strong>{reglement.reference && <small>Réf. {reglement.reference}</small>}</div>
        <div><span>Reste dû</span><strong>{montant(reglement.reste)}</strong></div>
      </div>
      <p>
        Reçu de <strong>{d.client.nom}</strong> la somme de <strong>{montant(reglement.montant)}</strong> en règlement du crédit n°{' '}
        {d.dossier.numero} (total {montant(d.dossier.total)}, échéance {dateFr(d.dossier.echeance)}).
        {reglement.reste === 0 ? ' Ce crédit est entièrement soldé.' : ''}
      </p>
      <div className="signatures signatures-2">
        <div>Reçu par {reglement.par}<br /><span>Signature</span></div>
        <div>Le client<br /><span>Signature</span></div>
      </div>
    </Corps>
  );
}
