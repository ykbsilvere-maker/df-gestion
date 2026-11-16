import type { CSSProperties, ReactNode } from 'react';
import { REGIMES, type Organisation } from '../../lib/types';

/**
 * Papier à en-tête commun aux courriers et documents de crédit (lettres de relance, bon de
 * crédit, relevés, reçus) : logo de l'entreprise — ou son monogramme s'il n'y a pas encore de
 * logo —, coordonnées, bandeau à sa couleur et pied de page avec les mentions légales.
 */

export interface Destinataire {
  nom: string;
  contact?: string | null;
  adresse?: string | null;
  telephone?: string | null;
  ncc?: string | null;
  rccm?: string | null;
}

/** Initiales de l'entreprise (« Boutique Le Bon Prix » → « BP »), pour le monogramme. */
export function initiales(nom: string | undefined): string {
  const mots = (nom ?? '').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((m) => m.length > 2 || /^\p{Lu}/u.test(m));
  const lettres = (mots.length >= 2 ? [mots[0], mots[mots.length - 1]] : [mots[0] ?? nom ?? '?'])
    .map((m) => (m ?? '').charAt(0).toUpperCase())
    .join('');
  return lettres.slice(0, 2) || '?';
}

const couleurDe = (o: Organisation | undefined) => (o?.couleur && /^#[0-9a-f]{6}$/i.test(o.couleur) ? o.couleur : '#b3261e');

function Marque({ o, logoUrl }: { o: Organisation | undefined; logoUrl: string | null }) {
  if (logoUrl) return <img className="papier-logo" src={logoUrl} alt="" />;
  return (
    <div className="papier-monogramme" aria-hidden>
      {initiales(o?.nom)}
    </div>
  );
}

export function mentionsLegales(o: Organisation | undefined): string[] {
  return [
    o?.nom,
    [o?.adresse, o?.ville].filter(Boolean).join(', '),
    o?.rccm && `RCCM ${o.rccm}`,
    o?.ncc && `NCC ${o.ncc}`,
    o?.regime_fiscal && o.regime_fiscal !== 'non_precise' && `Régime : ${REGIMES.find((r) => r.code === o.regime_fiscal)?.libelle ?? o.regime_fiscal}`,
    [o?.telephone && `Tél. ${o.telephone}`, o?.email].filter(Boolean).join(' · '),
  ].filter((x): x is string => !!x);
}

/**
 * Page A4 sur papier à en-tête. `titre` s'affiche dans le cartouche de droite (documents) ;
 * pour une lettre, passez `destinataire` : le bloc d'adresse remplace le cartouche.
 */
export function PapierEntete({
  o,
  logoUrl,
  titre,
  reference,
  destinataire,
  lettre,
  children,
}: {
  o: Organisation | undefined;
  logoUrl: string | null;
  titre?: string;
  reference?: ReactNode;
  destinataire?: Destinataire;
  lettre?: boolean;
  children: ReactNode;
}) {
  const style = { '--papier-accent': couleurDe(o) } as CSSProperties;
  return (
    <div className={`rapport-a4 papier ${lettre ? 'lettre' : ''}`} style={style}>
      <div className="papier-bandeau" />
      <header className="papier-entete">
        <div className="papier-emetteur">
          <Marque o={o} logoUrl={logoUrl} />
          <div>
            <div className="papier-nom">{o?.nom}</div>
            {(o?.adresse || o?.ville) && <div>{[o?.adresse, o?.ville].filter(Boolean).join(', ')}</div>}
            {(o?.telephone || o?.email) && <div>{[o?.telephone, o?.email].filter(Boolean).join(' · ')}</div>}
          </div>
        </div>
        {titre && !destinataire && (
          <div className="papier-cartouche">
            <div className="papier-titre">{titre}</div>
            {reference && <div className="papier-reference">{reference}</div>}
          </div>
        )}
      </header>
      {destinataire && (
        <div className="papier-adresse">
          <div className="papier-adresse-bloc">
            <span>Destinataire</span>
            <strong>{destinataire.nom}</strong>
            {destinataire.contact && <div>À l’attention de {destinataire.contact}</div>}
            {destinataire.adresse && <div>{destinataire.adresse}</div>}
            {destinataire.telephone && <div>Tél. {destinataire.telephone}</div>}
            {(destinataire.ncc || destinataire.rccm) && (
              <div className="papier-adresse-legal">
                {[destinataire.rccm && `RCCM ${destinataire.rccm}`, destinataire.ncc && `NCC ${destinataire.ncc}`].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="papier-corps">{children}</div>
      <footer className="papier-pied">{mentionsLegales(o).join('  ·  ')}</footer>
    </div>
  );
}

/** Formule de date d'un courrier : « Abidjan, le 16 novembre 2026 ». */
export function dateCourrier(o: Organisation | undefined): string {
  const d = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Abidjan' });
  return `${o?.ville ? `${o.ville}, le` : 'Le'} ${d}`;
}

export function Signature({ qui = 'La Direction' }: { qui?: string }) {
  return (
    <div className="lettre-signature">
      <div>{qui}</div>
      <div className="lettre-ligne-signature" />
      <div className="secondaire">Signature et cachet</div>
    </div>
  );
}
