import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useIdentite } from '../lib/identite';
import { useSession } from '../lib/session';
import { FeuilleA4Six } from '../impression/Recu';
import { caseSuivante, definirCaseSuivante, memoriserCaseSuivante, PageA4, useImpression } from '../impression/impression';

/**
 * Impression des tickets et rapports au format choisi par l'entreprise :
 * A4 ÷ 6 (une case par ticket, la suivante est retenue) ou rouleau thermique.
 */
const CLE_ROULEAU = 'dfg_impression_rouleau';
/** Réglage de l'appareil : ticket sur rouleau thermique au lieu de la feuille A4 (par défaut : A4). */
export function imprimeSurRouleau(): boolean {
  try {
    return localStorage.getItem(CLE_ROULEAU) === '1';
  } catch {
    return false;
  }
}
export function choisirRouleau(oui: boolean) {
  try {
    if (oui) localStorage.setItem(CLE_ROULEAU, '1');
    else localStorage.removeItem(CLE_ROULEAU);
  } catch {
    /* stockage indisponible */
  }
}

export function useImpressionCaisse() {
  const { identite } = useIdentite();
  const { imprimer } = useImpression();
  const org = identite?.organisation.id ?? '';
  const { peut } = useSession();
  const formatEntreprise = identite?.parametres.format ?? 'thermique_80';
  // Reçu A4 réservé au gérant principal (droit « Personnalisation — Reçu A4 », administration.valider) ;
  // les autres postes impriment toujours sur rouleau (TPE, imprimante thermique).
  const format = formatEntreprise === 'a4_6' && !peut('administration.valider') ? 'thermique_80' : formatEntreprise;
  const [caseA4, setCaseA4] = useState(() => (org ? caseSuivante(org) : 1));
  useEffect(() => {
    if (org) setCaseA4(caseSuivante(org));
  }, [org]);

  const imprimerTicket = useCallback(
    async (contenu: ReactNode) => {
      if (!identite) return;
      if (format === 'a4_6') {
        const n = caseSuivante(org);
        let double = false;
        const p = identite.parametres;
        await imprimer(
          <FeuilleA4Six caseNumero={n} decalageX={Number(p.decalage_x_mm)} decalageY={Number(p.decalage_y_mm)} onMesure={(m) => (double = m.double)}>
            {contenu}
          </FeuilleA4Six>,
          'a4',
        );
        memoriserCaseSuivante(org, n, double);
        setCaseA4(caseSuivante(org));
      } else if (imprimeSurRouleau()) {
        await imprimer(contenu, 'thermique');
      } else {
        // Par défaut, tout s'imprime sur une feuille A4 entière.
        await imprimer(<PageA4>{contenu}</PageA4>, 'a4');
      }
    },
    [identite, format, org, imprimer],
  );

  /** Même document sur une feuille A4 entière (imprimante de bureau, archivage, PDF). */
  const imprimerA4 = useCallback(
    async (contenu: ReactNode) => {
      await imprimer(<PageA4>{contenu}</PageA4>, 'a4');
    },
    [imprimer],
  );

  const choisirCase = useCallback(
    (n: number) => {
      definirCaseSuivante(org, n);
      setCaseA4(n);
    },
    [org],
  );

  return { imprimerTicket, imprimerA4, format, caseA4, choisirCase };
}
