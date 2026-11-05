import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { montant } from '../lib/argent';
import type { Identite } from '../lib/identite';
import type { FormatRecu } from '../lib/types';

export interface LigneRecu {
  designation: string;
  quantite: number;
  prix_unitaire: number;
  remise?: number;
}

export interface ReglementRecu {
  moyen: string;
  /** Part du total réglée par ce moyen. */
  montant: number;
  /** Espèces : somme remise par le client (≥ montant). */
  montant_recu?: number;
  reference?: string;
  /** « rendu » : monnaie rendue au client par ce moyen (Wave, OM…). */
  sens?: 'encaissement' | 'rendu';
}

export interface VenteRecu {
  numero: string;
  /** Vente faite hors connexion, pas encore enregistrée sur le serveur. */
  provisoire?: boolean;
  date: Date;
  caissier?: string;
  magasin?: string;
  client?: string;
  lignes: LigneRecu[];
  reglements: ReglementRecu[];
}

/** Vente fictive pour l'aperçu et l'impression test. */
export function venteExemple(magasin?: string, caissier?: string): VenteRecu {
  return {
    numero: 'T-000123',
    date: new Date(),
    magasin,
    caissier,
    lignes: [
      { designation: 'Riz parfumé 5 kg', quantite: 1, prix_unitaire: 4500 },
      { designation: 'Huile végétale 1 L', quantite: 2, prix_unitaire: 1500 },
      { designation: 'Sucre en poudre 1 kg', quantite: 1, prix_unitaire: 900 },
      { designation: 'Lait concentré sucré', quantite: 3, prix_unitaire: 650, remise: 150 },
    ],
    reglements: [
      { moyen: 'Wave', montant: 5000, reference: 'T8K2-4QP1' },
      { moyen: 'Espèces', montant: 5200, montant_recu: 6000 },
    ],
  };
}

export function totalVente(v: VenteRecu): number {
  return v.lignes.reduce((s, l) => s + l.quantite * l.prix_unitaire - (l.remise ?? 0), 0);
}

const dateHeure = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Abidjan' });

/** Le reçu lui-même, identique à l'écran et sur papier. */
export function Recu({ identite, vente, format }: { identite: Identite; vente: VenteRecu; format: FormatRecu }) {
  const { organisation: o, parametres: p, logoUrl } = identite;
  const total = totalVente(vente);
  const encaissements = vente.reglements.filter((r) => r.sens !== 'rendu');
  const rendusAutres = vente.reglements.filter((r) => r.sens === 'rendu');
  const regle = encaissements.reduce((s, r) => s + r.montant, 0) - rendusAutres.reduce((s, r) => s + r.montant, 0);
  const avecRemise = encaissements.some((r) => r.montant_recu != null);
  const rendu = avecRemise
    ? encaissements.reduce((s, r) => s + Math.max(0, (r.montant_recu ?? r.montant) - r.montant), 0)
    : Math.max(0, regle - total);
  const reste = Math.max(0, total - regle);
  const totalRemises = vente.lignes.reduce((s, l) => s + (l.remise ?? 0), 0);
  const coordonnees = [o.adresse, o.ville].filter(Boolean).join(', ');
  const legal = [p.afficher_ncc && o.ncc ? `NCC ${o.ncc}` : null, o.rccm ? `RCCM ${o.rccm}` : null].filter(Boolean);

  return (
    <div className={`recu recu-${format}`}>
      <header className="recu-entete">
        {p.afficher_logo && logoUrl && <img className="recu-logo" src={logoUrl} alt="" />}
        <div className="recu-nom">{o.nom}</div>
        {coordonnees && <div>{coordonnees}</div>}
        {(o.telephone || o.email) && <div>{[o.telephone, o.email].filter(Boolean).join(' · ')}</div>}
        {legal.length > 0 && <div>{legal.join(' · ')}</div>}
        {p.entete && <div className="recu-slogan">{p.entete}</div>}
      </header>

      <div className="recu-infos">
        <span>{vente.provisoire ? `Reçu provisoire n° ${vente.numero}` : `Reçu n° ${vente.numero}`}</span>
        <span>{dateHeure.format(vente.date)}</span>
        {vente.magasin && <span>{vente.magasin}</span>}
        {p.afficher_caissier && vente.caissier && <span>Caissier : {vente.caissier}</span>}
        {vente.client && <span>Client : {vente.client}</span>}
      </div>

      <table className="recu-lignes">
        <tbody>
          {vente.lignes.map((l, i) =>
            format === 'thermique_58' ? (
              <tr key={i}>
                <td>
                  <div className="recu-designation">{l.designation}</div>
                  <div className="recu-detail">
                    {l.quantite} × {montant(l.prix_unitaire, '')}
                    {l.remise ? ` − remise ${montant(l.remise, '')}` : ''}
                  </div>
                </td>
                <td className="recu-montant">{montant(l.quantite * l.prix_unitaire - (l.remise ?? 0), '')}</td>
              </tr>
            ) : (
              // Une ligne par article : désignation, quantité × prix, montant (format compact).
              <tr key={i}>
                <td className="recu-designation">
                  {l.designation}
                  {l.remise ? <div className="recu-detail">remise − {montant(l.remise, '')}</div> : null}
                </td>
                <td className="recu-quantite">
                  {l.quantite} × {montant(l.prix_unitaire, '')}
                </td>
                <td className="recu-montant">{montant(l.quantite * l.prix_unitaire - (l.remise ?? 0), '')}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>

      <div className="recu-totaux">
        {totalRemises > 0 && (
          <div>
            <span>Remises</span>
            <span>− {montant(totalRemises)}</span>
          </div>
        )}
        <div className="recu-total">
          <span>TOTAL</span>
          <span>{montant(total)}</span>
        </div>
        {encaissements.map((r, i) => (
          <div key={i}>
            <span>
              {r.moyen}
              {r.reference ? ` (${r.reference})` : ''}
            </span>
            <span>{montant(r.montant_recu ?? r.montant)}</span>
          </div>
        ))}
        {rendu > 0 && (
          <div>
            <span>{rendusAutres.length ? 'Monnaie rendue (espèces)' : 'Monnaie rendue'}</span>
            <span>{montant(rendu)}</span>
          </div>
        )}
        {rendusAutres.map((r, i) => (
          <div key={`r${i}`}>
            <span>
              Monnaie rendue par {r.moyen}
              {r.reference ? ` (${r.reference})` : ''}
            </span>
            <span>{montant(r.montant)}</span>
          </div>
        ))}
        {reste > 0 && (
          <div className="recu-reste">
            <span>Reste à payer</span>
            <span>{montant(reste)}</span>
          </div>
        )}
      </div>

      <footer className="recu-pied">
        {p.pied && <div>{p.pied}</div>}
        {p.mention_legale && <div className="recu-mention">{p.mention_legale}</div>}
        <div className="recu-logiciel">Logiciel Le Décodeur Financier</div>
      </footer>
    </div>
  );
}

/** Position d'une case (1 à 6) sur la feuille : 2 colonnes, 3 rangées, de gauche à droite puis de haut en bas. */
const positionCase = (n: number) => ({ colonne: ((n - 1) % 2) + 1, rangee: Math.ceil(n / 2) });

/**
 * Feuille A4 découpée en 6 (105 × 99 mm). Le reçu est placé dans la case choisie.
 * S'il est trop long, il est d'abord réduit (jusqu'à 80 %), puis étendu sur la case du dessous.
 */
export function FeuilleA4Six({
  caseNumero,
  decalageX = 0,
  decalageY = 0,
  apercu = false,
  onMesure,
  children,
}: {
  caseNumero: number;
  decalageX?: number;
  decalageY?: number;
  apercu?: boolean;
  onMesure?: (r: { double: boolean; echelle: number }) => void;
  children: ReactNode;
}) {
  const caseRef = useRef<HTMLDivElement>(null);
  const contenuRef = useRef<HTMLDivElement>(null);
  const [mise, setMise] = useState({ double: false, echelle: 1 });
  const { colonne, rangee } = positionCase(caseNumero);
  const peutDoubler = rangee < 3;

  const dernierSignale = useRef<string>('');

  // La hauteur naturelle du reçu ne dépend pas de l'échelle (transform) : la mesure est stable.
  useLayoutEffect(() => {
    const c = caseRef.current;
    const r = contenuRef.current;
    if (!c || !r || c.clientHeight === 0) return; // pas encore mis en page
    const style = getComputedStyle(c);
    const marges = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const hauteurCase = c.clientHeight / (mise.double ? 2 : 1);
    const utileSimple = hauteurCase - marges;
    const utileDouble = hauteurCase * 2 - marges;
    const hauteur = r.scrollHeight;
    let resultat = { double: false, echelle: 1 };
    if (hauteur > utileSimple) {
      const ratio = utileSimple / hauteur;
      if (ratio >= 0.8 || !peutDoubler) resultat = { double: false, echelle: Math.max(ratio, 0.55) };
      else resultat = { double: true, echelle: Math.min(1, utileDouble / hauteur) };
    }
    if (resultat.double !== mise.double || Math.abs(resultat.echelle - mise.echelle) > 0.01) setMise(resultat);
    const signature = `${resultat.double}-${resultat.echelle.toFixed(2)}`;
    if (signature !== dernierSignale.current) {
      dernierSignale.current = signature;
      onMesure?.(resultat);
    }
  });

  return (
    <div
      className={`feuille-a4 ${apercu ? 'feuille-apercu' : ''}`}
      style={{ transform: `translate(${decalageX}mm, ${decalageY}mm)` }}
    >
      {[1, 2, 3, 4, 5, 6].map((n) => {
        const pos = positionCase(n);
        const estCase = n === caseNumero;
        const couverte = mise.double && n === caseNumero + 2;
        if (couverte) return null;
        return (
          <div
            key={n}
            ref={estCase ? caseRef : undefined}
            className={`case-a4 ${estCase ? 'case-active' : ''}`}
            style={{
              gridColumn: pos.colonne,
              gridRow: estCase && mise.double ? `${rangee} / span 2` : pos.rangee,
            }}
          >
            {estCase && (
              <div
                ref={contenuRef}
                style={{ transform: `scale(${mise.echelle})`, transformOrigin: 'top center' }}
              >
                {children}
              </div>
            )}
            {apercu && !estCase && <span className="case-numero">{n}</span>}
          </div>
        );
      })}
      {/* colonne/rangée conservées pour l'accessibilité de l'aperçu */}
      <span className="sr-only">
        Case {caseNumero} : colonne {colonne}, rangée {rangee}
      </span>
    </div>
  );
}

/** Choix visuel de la case (1 à 6) sur la feuille A4. */
export function ChoixCase({ valeur, onChange }: { valeur: number; onChange: (n: number) => void }) {
  return (
    <div className="choix-case" role="radiogroup" aria-label="Case de la feuille A4">
      {[1, 2, 3, 4, 5, 6].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={valeur === n}
          className={valeur === n ? 'actif' : ''}
          onClick={() => onChange(n)}
        >
          {n}
        </button>
      ))}
    </div>
  );
}
