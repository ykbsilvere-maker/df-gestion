import { useState } from 'react';
import type { Paiement, Vitrine } from './api';
import { fcfa } from './composants';

/**
 * Moyens de paiement de DF Marché. Le client paie directement la boutique : DF Marché
 * n'encaisse rien et ne demande jamais de code secret. Pour aller vite, un bouton ouvre
 * l'appli (lien Wave de la boutique) ou compose le code USSD de l'opérateur sur le téléphone.
 */
export interface Moyen {
  code: Paiement;
  libelle: string;
  logo: string;
  couleur: string;
  champ?: 'numero_wave' | 'numero_orange' | 'numero_mtn' | 'numero_moov' | 'numero_djamo';
  /** Code USSD à composer (Côte d'Ivoire). */
  ussd?: string;
  aide?: string;
}

export const MOYENS: Moyen[] = [
  { code: 'orange_money', libelle: 'Orange Money', logo: '/paiement/orange.png', couleur: '#ff7900', champ: 'numero_orange', ussd: '#144#', aide: 'Composez #144#, choisissez « Transfert », puis saisissez le numéro et le montant.' },
  { code: 'moov', libelle: 'Moov Money', logo: '/paiement/moov.png', couleur: '#0066b3', champ: 'numero_moov', ussd: '*155#', aide: 'Composez *155#, choisissez « Transfert d’argent », puis saisissez le numéro et le montant.' },
  { code: 'wave', libelle: 'Wave', logo: '/paiement/wave.png', couleur: '#1dc8f2', champ: 'numero_wave', aide: 'Dans l’appli Wave, touchez « Envoyer », saisissez le numéro et le montant.' },
  { code: 'mtn', libelle: 'MTN MoMo', logo: '/paiement/mtn.svg', couleur: '#ffcb05', champ: 'numero_mtn', ussd: '*133#', aide: 'Composez *133#, choisissez « Transfert », puis saisissez le numéro et le montant.' },
  { code: 'djamo', libelle: 'Djamo', logo: '/paiement/djamo.png', couleur: '#2b2b38', champ: 'numero_djamo', aide: 'Dans l’appli Djamo, envoyez le montant vers ce numéro.' },
];
export const A_LA_LIVRAISON: Moyen = { code: 'livraison', libelle: 'À la livraison', logo: '/paiement/especes.svg', couleur: '#1f8a65' };

export const moyen = (code: Paiement): Moyen => MOYENS.find((m) => m.code === code) ?? A_LA_LIVRAISON;

/** Moyens de paiement en ligne acceptés par la boutique (ceux dont elle a donné le numéro). */
export const moyensEnLigne = (v: Pick<Vitrine, 'numero_wave' | 'numero_orange' | 'numero_mtn' | 'numero_moov' | 'numero_djamo'>) =>
  MOYENS.filter((m) => !!v[m.champ!]);

export const numeroDe = (v: Partial<Vitrine>, code: Paiement): string | null =>
  code === 'livraison' ? null : ((v[moyen(code).champ!] as string | null | undefined) ?? null);

const versUssd = (code: string) => `tel:${code.replace(/#/g, '%23')}`;

export function LogoPaiement({ m, taille = 40 }: { m: Moyen; taille?: number }) {
  return <img className="logo-paiement" src={m.logo} alt="" width={taille} height={taille} loading="lazy" />;
}

function Copier({ texte, libelle }: { texte: string; libelle: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className="bouton petit"
      onClick={() => {
        void navigator.clipboard?.writeText(texte).then(() => {
          setOk(true);
          window.setTimeout(() => setOk(false), 1500);
        });
      }}
    >
      {ok ? '✓ Copié' : libelle}
    </button>
  );
}

/** Carte « Payez maintenant » : montant, numéro de la boutique et bouton qui ouvre l'appli ou le code. */
export function CartePaiement({ m, numero, montant, beneficiaire, lienWave }: { m: Moyen; numero: string; montant: number; beneficiaire: string; lienWave?: string | null }) {
  const brut = numero.replace(/[^0-9]/g, '');
  return (
    <div className="carte-paiement" style={{ ['--marque' as string]: m.couleur }}>
      <div className="carte-paiement-tete">
        <LogoPaiement m={m} taille={48} />
        <div>
          <span>Payez par {m.libelle}</span>
          <strong>{fcfa(montant)}</strong>
        </div>
      </div>
      <div className="carte-paiement-numero">
        <span>Au numéro de la boutique</span>
        <strong className="numero">{numero}</strong>
        <small>{beneficiaire}</small>
      </div>
      <div className="carte-paiement-actions">
        {m.code === 'wave' && lienWave ? (
          <a className="bouton bouton-marque" href={lienWave} target="_blank" rel="noreferrer">Ouvrir Wave et payer</a>
        ) : m.ussd ? (
          <a className="bouton bouton-marque" href={versUssd(m.ussd)}>Ouvrir {m.libelle} ({m.ussd})</a>
        ) : null}
        <Copier texte={brut} libelle="Copier le numéro" />
        <Copier texte={String(Math.round(montant))} libelle="Copier le montant" />
      </div>
      {m.aide && <p className="secondaire petit">{m.aide} Ne communiquez jamais votre code secret : ni la boutique ni DF Marché ne vous le demanderont.</p>}
    </div>
  );
}
