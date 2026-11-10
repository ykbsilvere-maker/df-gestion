import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { messageErreur } from '../../lib/format';
import { clavierMontant, lireMontant, montant } from '../../lib/argent';
import { Alerte, Champ } from '../../components/ui';

/**
 * Saisie comptable guidée : la personne décrit ce qui s'est passé avec des mots de tous les
 * jours ; l'application choisit les comptes SYSCOHADA et le sens (débit / crédit) à sa place.
 */
interface Ligne {
  compte: string;
  debit: number;
  credit: number;
}
interface Operation {
  code: string;
  icone: string;
  titre: string;
  aide: string;
  /** Sens de l'argent : il entre, il sort, ou rien ne bouge encore (facture à payer plus tard). */
  argent: 'entre' | 'sort' | 'aucun';
  /** Compte de contrepartie (ce pour quoi l'argent bouge). */
  compte: string;
  intitule: string;
  /** Liste de natures proposées (frais à payer plus tard). */
  natures?: { compte: string; libelle: string }[];
  attention?: string;
}

const TRESORERIES = [
  { compte: '5712', libelle: 'Caisse centrale (espèces)' },
  { compte: '5211', libelle: 'Banque' },
  { compte: '551', libelle: 'Mobile Money (Wave, Orange, MTN, Moov)' },
];

const NATURES_FRAIS = [
  { compte: '622', libelle: 'Loyer' },
  { compte: '6052', libelle: 'Électricité' },
  { compte: '6051', libelle: 'Eau' },
  { compte: '628', libelle: 'Téléphone et Internet' },
  { compte: '618', libelle: 'Transport' },
  { compte: '624', libelle: 'Entretien et réparations' },
  { compte: '627', libelle: 'Publicité' },
  { compte: '64', libelle: 'Impôts et taxes' },
  { compte: '658', libelle: 'Autre frais' },
];

const OPERATIONS: Operation[] = [
  { code: 'apport', icone: '💼', titre: 'J’ai mis de l’argent dans l’entreprise', aide: 'Apport personnel du propriétaire ou d’un associé.', argent: 'entre', compte: '101', intitule: 'Capital' },
  { code: 'emprunt', icone: '🏦', titre: 'J’ai reçu un prêt', aide: 'Banque, microfinance ou autre prêteur.', argent: 'entre', compte: '162', intitule: 'Emprunts' },
  { code: 'rembourse', icone: '↩️', titre: 'J’ai remboursé une partie d’un prêt', aide: 'La part du prêt lui-même, sans les intérêts.', argent: 'sort', compte: '162', intitule: 'Emprunts' },
  { code: 'interets', icone: '％', titre: 'J’ai payé des intérêts', aide: 'Intérêts d’un prêt ou agios.', argent: 'sort', compte: '67', intitule: 'Frais financiers' },
  { code: 'materiel', icone: '🧰', titre: 'J’ai acheté du matériel ou du mobilier', aide: 'Congélateur, rayonnage, ordinateur, caisse… (ce qui sert plusieurs années).', argent: 'sort', compte: '24', intitule: 'Matériel et mobilier' },
  { code: 'vehicule', icone: '🛵', titre: 'J’ai acheté un véhicule', aide: 'Moto, tricycle, voiture de livraison.', argent: 'sort', compte: '245', intitule: 'Matériel de transport' },
  { code: 'recette', icone: '🎁', titre: 'J’ai reçu une autre recette', aide: 'Une rentrée d’argent qui n’est pas une vente de la caisse.', argent: 'entre', compte: '758', intitule: 'Produits divers' },
  {
    code: 'retrait', icone: '👛', titre: 'J’ai pris de l’argent pour moi', aide: 'Retrait personnel du propriétaire.', argent: 'sort', compte: '471', intitule: 'Compte d’attente',
    attention: 'Classé en compte d’attente : votre comptable le régularisera (prélèvement de l’exploitant ou rémunération).',
  },
  {
    code: 'facture', icone: '🧾', titre: 'J’ai reçu une facture que je paierai plus tard', aide: 'Loyer, électricité, réparation… pas encore payés.', argent: 'aucun', compte: '622', intitule: 'Frais',
    natures: NATURES_FRAIS,
  },
];

/** Écriture équilibrée correspondant à l'opération : l'utilisateur ne choisit ni compte ni sens. */
export function lignesOperation(op: Pick<Operation, 'argent' | 'compte'>, somme: number, tresorerie: string, nature?: string): Ligne[] {
  const contrepartie = nature || op.compte;
  if (op.argent === 'entre') return [{ compte: tresorerie, debit: somme, credit: 0 }, { compte: contrepartie, debit: 0, credit: somme }];
  if (op.argent === 'sort') return [{ compte: contrepartie, debit: somme, credit: 0 }, { compte: tresorerie, debit: 0, credit: somme }];
  return [{ compte: contrepartie, debit: somme, credit: 0 }, { compte: '401', debit: 0, credit: somme }];
}

const aujourdhui = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function SaisieGuidee({ org, onFaite, onExpert }: { org: string; onFaite: () => void; onExpert: () => void }) {
  const [op, setOp] = useState<Operation | null>(null);
  const [somme, setSomme] = useState('');
  const [tresorerie, setTresorerie] = useState('5712');
  const [nature, setNature] = useState(NATURES_FRAIS[0]!.compte);
  const [date, setDate] = useState(aujourdhui());
  const [piece, setPiece] = useState('');
  const [precision, setPrecision] = useState('');
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);

  if (!op) {
    return (
      <div className="guide-compta">
        <p className="secondaire">
          Choisissez ce qui s’est passé : DF Gestion écrit la comptabilité pour vous. Les <strong>ventes</strong>, les <strong>achats de marchandises</strong>,
          les <strong>dépenses payées</strong> et les <strong>virements</strong> sont déjà comptabilisés automatiquement, ne les ressaisissez pas ici.
        </p>
        <div className="guide-choix">
          {OPERATIONS.map((o) => (
            <button key={o.code} type="button" className="guide-carte" onClick={() => setOp(o)}>
              <span className="guide-icone" aria-hidden>{o.icone}</span>
              <span>
                <strong>{o.titre}</strong>
                <small>{o.aide}</small>
              </span>
            </button>
          ))}
        </div>
        <p className="secondaire petit-texte">
          Une dépense payée tout de suite (loyer, électricité, salaire, transport…) se saisit dans{' '}
          <Link to="/tresorerie">Trésorerie › Dépenses</Link>. Vous êtes comptable ?{' '}
          <button type="button" className="bouton-lien" onClick={onExpert}>Saisie avec débit et crédit</button>
        </p>
      </div>
    );
  }

  const m = lireMontant(somme) ?? 0;
  const lignes = lignesOperation(op, m, tresorerie, op.natures ? nature : undefined);
  const nomTreso = TRESORERIES.find((t) => t.compte === tresorerie)?.libelle ?? '';
  const nomNature = op.natures?.find((n) => n.compte === nature)?.libelle ?? op.intitule;
  const phrase =
    op.argent === 'entre'
      ? `${montant(m)} entrent dans « ${nomTreso} ».`
      : op.argent === 'sort'
        ? `${montant(m)} sortent de « ${nomTreso} ».`
        : `${montant(m)} de ${nomNature.toLowerCase()} à payer plus tard : la dette envers le fournisseur est notée.`;

  async function enregistrer(e: FormEvent) {
    e.preventDefault();
    if (!op || m <= 0) return setErreur('Indiquez le montant.');
    setEnCours(true);
    setErreur('');
    const libelle = [op.natures ? `Facture à payer — ${nomNature}` : op.titre.replace(/^J’ai /, '').replace(/^./, (x) => x.toUpperCase()), precision.trim()].filter(Boolean).join(' : ');
    const { error } = await supabase.rpc('ecriture_manuelle', {
      p_org: org,
      p_date: date,
      p_journal: op.argent === 'aucun' ? 'AC' : 'OD',
      p_libelle: libelle.slice(0, 200),
      p_lignes: lignes,
      p_piece: piece.trim() || 'Sans pièce',
      p_justificatif: null,
    });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    onFaite();
  }

  return (
    <form className="formulaire guide-compta" onSubmit={(e) => void enregistrer(e)}>
      <button type="button" className="bouton-lien" onClick={() => setOp(null)}>← Autre opération</button>
      <h3>
        <span aria-hidden>{op.icone} </span>
        {op.titre}
      </h3>
      <Alerte>{erreur}</Alerte>
      <div className="grille-2">
        <Champ label="Combien ?">
          <input value={somme} onChange={(e) => setSomme(e.target.value)} inputMode={clavierMontant()} placeholder="0" autoFocus required aria-label="Montant" />
        </Champ>
        <Champ label="Quel jour ?">
          <input type="date" value={date} max={aujourdhui()} onChange={(e) => setDate(e.target.value)} required />
        </Champ>
        {op.natures && (
          <Champ label="C’est une facture de…">
            <select value={nature} onChange={(e) => setNature(e.target.value)}>
              {op.natures.map((n) => (
                <option key={n.compte} value={n.compte}>{n.libelle}</option>
              ))}
            </select>
          </Champ>
        )}
        {op.argent !== 'aucun' && (
          <Champ label={op.argent === 'entre' ? 'Où l’argent est-il arrivé ?' : 'D’où l’argent est-il sorti ?'}>
            <select value={tresorerie} onChange={(e) => setTresorerie(e.target.value)}>
              {TRESORERIES.map((t) => (
                <option key={t.compte} value={t.compte}>{t.libelle}</option>
              ))}
            </select>
          </Champ>
        )}
        <Champ label="Numéro du reçu ou de la facture" aide="Le papier qui prouve l’opération (facultatif mais conseillé)">
          <input value={piece} onChange={(e) => setPiece(e.target.value)} maxLength={60} />
        </Champ>
        <Champ label="Précision (facultatif)">
          <input value={precision} onChange={(e) => setPrecision(e.target.value)} maxLength={120} placeholder="Ex. congélateur 300 L, prêt Baobab…" />
        </Champ>
      </div>
      {op.attention && <Alerte type="info">{op.attention}</Alerte>}
      {m > 0 && (
        <div className="guide-resume">
          <strong>En clair :</strong> {phrase}
          <details>
            <summary>Voir l’écriture comptable préparée</summary>
            <table className="tableau tableau-compact">
              <thead>
                <tr><th>Compte</th><th className="nombre">Débit</th><th className="nombre">Crédit</th></tr>
              </thead>
              <tbody>
                {lignes.map((l) => (
                  <tr key={l.compte + l.debit}>
                    <td>{l.compte}</td>
                    <td className="nombre">{l.debit ? montant(l.debit) : ''}</td>
                    <td className="nombre">{l.credit ? montant(l.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
      <button type="submit" className="bouton bouton-principal bouton-plein" disabled={enCours || m <= 0}>
        {enCours ? 'Enregistrement…' : 'Enregistrer'}
      </button>
    </form>
  );
}
