import { Fragment } from 'react';
import { libelleCoupure, montant } from '../lib/argent';
import type { Identite } from '../lib/identite';
import type { FormatRecu } from '../lib/types';

export interface RapportSession {
  nombre_ventes: number;
  total_ventes: number;
  total_remises: number;
  nombre_annulations: number;
  total_annulations: number;
  ventes_hors_ligne: number;
  ventes_apres_cloture: number;
  panier_moyen: number;
  fond_initial: number;
  especes_encaissees: number;
  especes_attendues: number;
  /** montant = net à reverser (encaissé − monnaie rendue par ce moyen). */
  par_moyen: { libelle: string; nature: string; montant: number; nombre: number; encaisse?: number; rendu?: number }[];
  rendus_autres_moyens?: number;
  calcule_le: string;
  // Rapport Z (session clôturée)
  numero_z?: number;
  especes_comptees?: number;
  ecart?: number;
  motif_ecart?: string | null;
  billetage?: Record<string, number> | null;
  cloturee_le?: string;
}


const dateHeure = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Abidjan' });

/** Rapport X (lecture en cours de journée) ou Z (clôture), au format du ticket de caisse. */
export function RapportCaisse({
  identite,
  rapport,
  format,
  caisse,
  magasin,
  caissier,
  ouverteLe,
}: {
  identite: Identite;
  rapport: RapportSession;
  format: FormatRecu;
  caisse: string;
  magasin?: string;
  caissier?: string;
  ouverteLe?: string;
}) {
  const z = rapport.numero_z != null;
  const o = identite.organisation;
  const billetage = Object.entries(rapport.billetage ?? {})
    .filter(([, n]) => Number(n) > 0)
    .sort(([a], [b]) => Number(b) - Number(a));

  return (
    <div className={`recu recu-${format} rapport-caisse`}>
      <header className="recu-entete">
        <div className="recu-nom">{o.nom}</div>
        <div className="rapport-titre">{z ? `RAPPORT Z n° ${rapport.numero_z}` : 'RAPPORT X (lecture)'}</div>
      </header>

      <div className="recu-infos">
        <span>Caisse : {caisse}</span>
        {magasin && <span>{magasin}</span>}
        {caissier && <span>Édité par : {caissier}</span>}
        {ouverteLe && <span>Ouverte le {dateHeure.format(new Date(ouverteLe))}</span>}
        <span>
          {z && rapport.cloturee_le
            ? `Clôturée le ${dateHeure.format(new Date(rapport.cloturee_le))}`
            : `Édité le ${dateHeure.format(new Date(rapport.calcule_le))}`}
        </span>
      </div>

      <div className="recu-totaux">
        <div>
          <span>Ventes</span>
          <span>{rapport.nombre_ventes}</span>
        </div>
        <div className="recu-total">
          <span>CHIFFRE D’AFFAIRES</span>
          <span>{montant(rapport.total_ventes)}</span>
        </div>
        {rapport.total_remises > 0 && (
          <div>
            <span>dont remises accordées</span>
            <span>{montant(rapport.total_remises)}</span>
          </div>
        )}
        <div>
          <span>Panier moyen</span>
          <span>{montant(rapport.panier_moyen)}</span>
        </div>
        {rapport.nombre_annulations > 0 && (
          <div>
            <span>Annulations ({rapport.nombre_annulations})</span>
            <span>{montant(rapport.total_annulations)}</span>
          </div>
        )}
        {rapport.ventes_hors_ligne > 0 && (
          <div>
            <span>Ventes hors connexion</span>
            <span>{rapport.ventes_hors_ligne}</span>
          </div>
        )}
      </div>

      <div className="rapport-section">Règlements — net à reverser</div>
      <div className="recu-totaux">
        {rapport.par_moyen.length === 0 && <div>Aucun règlement</div>}
        {rapport.par_moyen.map((m) => (
          <Fragment key={m.libelle}>
            <div>
              <span>
                {m.libelle} ({m.nombre})
              </span>
              <span>{montant(m.montant)}</span>
            </div>
            {!!m.rendu && (
              <div className="rapport-detail">
                <span>
                  encaissé {montant(m.encaisse ?? 0)} − monnaie rendue {montant(m.rendu)}
                </span>
              </div>
            )}
          </Fragment>
        ))}
      </div>

      <div className="rapport-section">Espèces</div>
      <div className="recu-totaux">
        <div>
          <span>Fond de caisse</span>
          <span>{montant(rapport.fond_initial)}</span>
        </div>
        <div>
          <span>Encaissées</span>
          <span>{montant(rapport.especes_encaissees)}</span>
        </div>
        <div className="recu-total">
          <span>Attendues en caisse</span>
          <span>{montant(rapport.especes_attendues)}</span>
        </div>
        {z && (
          <>
            <div>
              <span>Comptées</span>
              <span>{montant(rapport.especes_comptees ?? 0)}</span>
            </div>
            <div className={rapport.ecart ? 'recu-reste' : ''}>
              <span>Écart</span>
              <span>
                {(rapport.ecart ?? 0) > 0 ? '+ ' : ''}
                {montant(rapport.ecart ?? 0)}
              </span>
            </div>
            {rapport.motif_ecart && <div className="recu-detail">Motif : {rapport.motif_ecart}</div>}
          </>
        )}
      </div>

      {z && billetage.length > 0 && (
        <>
          <div className="rapport-section">Billetage</div>
          <table className="recu-lignes">
            <tbody>
              {billetage.map(([coupure, n]) => (
                <tr key={coupure}>
                  <td className="recu-designation">{libelleCoupure(Number(coupure.replace(/^p/, '')))}{coupure.startsWith('p') ? ' (pièce)' : ''}</td>
                  <td className="recu-quantite">× {n}</td>
                  <td className="recu-montant">{montant(Number(coupure.replace(/^p/, '')) * Number(n), '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <footer className="recu-pied">
        {z && <div>Signature caissier : ____________</div>}
        {z && <div>Signature responsable : ____________</div>}
        <div className="recu-logiciel">Logiciel Le Décodeur Financier</div>
      </footer>
    </div>
  );
}
