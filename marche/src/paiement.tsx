import { useState } from 'react';
import { urlPublique, type AutrePaiement, type Paiement, type Vitrine } from './api';
import { fcfa } from './composants';

/**
 * Moyens de paiement de DF Marché. Le client paie directement la boutique : DF Marché
 * n'encaisse rien et ne demande jamais de code secret. Pour aller vite, un bouton ouvre
 * l'appli (lien Wave de la boutique) ou compose le code USSD de l'opérateur sur le téléphone.
 */
export interface Moyen {
  code: Paiement;
  /** Clé unique du choix : le code, ou « autre:<id> » pour un moyen ajouté par la boutique. */
  cle: string;
  libelle: string;
  logo?: string;
  couleur: string;
  champ?: 'numero_wave' | 'numero_orange' | 'numero_mtn' | 'numero_moov' | 'numero_djamo';
  /** Moyen ajouté par la boutique. */
  autre?: AutrePaiement;
  /** Code USSD à composer (Côte d'Ivoire). */
  ussd?: string;
  aide?: string;
}

// Wave et Orange Money d'abord : les deux moyens les plus utilisés.
export const MOYENS: Moyen[] = [
  { code: 'wave', cle: 'wave', libelle: 'Wave', logo: '/paiement/wave.png', couleur: '#1dc8f2', champ: 'numero_wave', aide: 'Dans l’appli Wave, touchez « Envoyer », saisissez le numéro et le montant.' },
  { code: 'orange_money', cle: 'orange_money', libelle: 'Orange Money', logo: '/paiement/orange.png', couleur: '#ff7900', champ: 'numero_orange', ussd: '#144#', aide: 'Composez #144#, choisissez « Transfert », puis saisissez le numéro et le montant.' },
  { code: 'mtn', cle: 'mtn', libelle: 'MTN MoMo', logo: '/paiement/mtn.svg', couleur: '#ffcb05', champ: 'numero_mtn', ussd: '*133#', aide: 'Composez *133#, choisissez « Transfert », puis saisissez le numéro et le montant.' },
  { code: 'moov', cle: 'moov', libelle: 'Moov Money', logo: '/paiement/moov.png', couleur: '#0066b3', champ: 'numero_moov', ussd: '*155#', aide: 'Composez *155#, choisissez « Transfert d’argent », puis saisissez le numéro et le montant.' },
  { code: 'djamo', cle: 'djamo', libelle: 'Djamo', logo: '/paiement/djamo.png', couleur: '#2b2b38', champ: 'numero_djamo', aide: 'Dans l’appli Djamo, envoyez le montant vers ce numéro.' },
];
export const A_LA_LIVRAISON: Moyen = { code: 'livraison', cle: 'livraison', libelle: 'À la livraison', logo: '/paiement/especes.svg', couleur: '#1f8a65' };

// Un moyen ajouté qui porte le nom d'un opérateur connu reprend son logo et sa couleur.
const connu = (libelle: string) => MOYENS.find((m) => new RegExp(m.libelle.split(' ')[0]!, 'i').test(libelle));
const versAutre = (a: AutrePaiement): Moyen => ({
  code: 'autre', cle: `autre:${a.id}`, libelle: a.libelle, couleur: connu(a.libelle)?.couleur ?? '#5b4a3f',
  logo: (a.logo ? urlPublique('vitrines', a.logo) : null) ?? connu(a.libelle)?.logo,
  ussd: connu(a.libelle)?.ussd, autre: a,
  aide: a.instructions || (a.lien ? `Touchez « Payer avec ${a.libelle} » : le montant est déjà rempli.` : `Envoyez le montant au numéro ci-dessus avec ${a.libelle}.`),
});

/** Le moyen d'une commande (pour un moyen ajouté, son nom vient de la commande). */
export const moyen = (code: Paiement, libelle?: string | null): Moyen =>
  code === 'autre'
    ? { code: 'autre', cle: 'autre', libelle: libelle || 'Autre moyen', couleur: '#5b4a3f' }
    : MOYENS.find((m) => m.code === code) ?? A_LA_LIVRAISON;

/** Moyens de paiement en ligne acceptés par la boutique : ceux dont elle a donné le numéro, puis ceux qu'elle a ajoutés. */
export const moyensEnLigne = (v: Pick<Vitrine, 'numero_wave' | 'numero_orange' | 'numero_mtn' | 'numero_moov' | 'numero_djamo' | 'autres_paiements'>) => [
  ...MOYENS.filter((m) => !!v[m.champ!]),
  ...(v.autres_paiements ?? []).map(versAutre),
];

export const numeroDe = (v: Partial<Vitrine>, m: Moyen | undefined): string | null =>
  !m || m.code === 'livraison' ? null : m.autre ? m.autre.numero : ((v[m.champ!] as string | null | undefined) ?? null);

const ANDROID = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
// Android : ouvre l'appli Wave installée (sinon sa page sur le Play Store).
const APPLI_WAVE = 'intent://#Intent;package=com.wave.personal;S.browser_fallback_url=' +
  encodeURIComponent('https://play.google.com/store/apps/details?id=com.wave.personal') + ';end';

const versUssd = (code: string) => `tel:${code.replace(/#/g, '%23')}`;

export function LogoPaiement({ m, taille = 40 }: { m: Moyen; taille?: number }) {
  if (!m.logo)
    return (
      <span className="logo-paiement lettre" style={{ width: taille, height: taille, fontSize: taille * 0.45, background: m.couleur }} aria-hidden>
        {m.libelle.slice(0, 1).toUpperCase()}
      </span>
    );
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
/** Lien de paiement avec le montant : « {montant} » est remplacé ; un lien Wave reçoit « amount ». */
export function lienAvecMontant(lien: string, montant: number): string {
  const m = String(Math.round(montant));
  if (lien.includes('{montant}')) return lien.split('{montant}').join(m);
  try {
    const u = new URL(lien);
    if (/(^|\.)wave\.com$/.test(u.hostname) && !u.searchParams.has('amount')) u.searchParams.set('amount', m);
    return u.toString();
  } catch {
    return lien;
  }
}

export function CartePaiement({ m, numero, montant, beneficiaire, lienWave }: { m: Moyen; numero: string | null; montant: number; beneficiaire: string; lienWave?: string | null }) {
  const brut = (numero ?? '').replace(/[^0-9]/g, '');
  return (
    <div className="carte-paiement" style={{ ['--marque' as string]: m.couleur }}>
      <div className="carte-paiement-tete">
        <LogoPaiement m={m} taille={48} />
        <div>
          <span>Payez par {m.libelle}</span>
          <strong>{fcfa(montant)}</strong>
        </div>
      </div>
      {/* Le numéro n'est pas affiché : un bouton le copie si l'appli de paiement le demande. */}
      <p className="carte-paiement-benef">Bénéficiaire : <b>{beneficiaire}</b></p>
      <div className="carte-paiement-actions">
        {m.autre?.lien ? (
          <a className="bouton bouton-marque" href={lienAvecMontant(m.autre.lien, montant)} target="_blank" rel="noreferrer">Payer {fcfa(montant)} avec {m.libelle}</a>
        ) : m.code === 'wave' && lienWave ? (
          <a className="bouton bouton-marque" href={lienAvecMontant(lienWave, montant)} target="_blank" rel="noreferrer">Ouvrir Wave et payer {fcfa(montant)}</a>
        ) : m.code === 'wave' && ANDROID ? (
          <a className="bouton bouton-marque" href={APPLI_WAVE}>Ouvrir l’appli Wave</a>
        ) : m.ussd ? (
          <a className="bouton bouton-marque" href={versUssd(m.ussd)}>Ouvrir {m.libelle} ({m.ussd})</a>
        ) : null}
        {brut && <Copier texte={brut} libelle="Copier le numéro du marchand" />}
        <Copier texte={String(Math.round(montant))} libelle="Copier le montant" />
      </div>
      {m.aide && <p className="secondaire petit">{m.aide} Ne communiquez jamais votre code secret : ni la boutique ni DF Marché ne vous le demanderont.</p>}
    </div>
  );
}
