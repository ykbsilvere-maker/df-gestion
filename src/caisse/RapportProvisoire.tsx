import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { messageErreur } from '../lib/format';
import { montant } from '../lib/argent';
import { Alerte } from '../components/ui';
import { RapportCaisse, type RapportSession } from '../impression/RapportCaisse';
import { useImpressionCaisse } from './impressionCaisse';
import { useIdentite } from '../lib/identite';

/**
 * Rapport X provisoire d'une caisse ouverte, consulté par le gérant principal :
 * chiffre d'affaires, règlements, espèces attendues et produits vendus. Rien n'est clôturé.
 */
export function RapportProvisoire({
  sessionId,
  caisse,
  magasin,
  caissier,
  ouverteLe,
}: {
  sessionId: string;
  caisse: string;
  magasin?: string;
  caissier: string;
  ouverteLe: string;
}) {
  const [rapport, setRapport] = useState<RapportSession | null>(null);
  const [erreur, setErreur] = useState('');
  const { identite } = useIdentite();
  const { imprimerTicket, format } = useImpressionCaisse();

  useEffect(() => {
    let actif = true;
    void supabase.rpc('rapport_session', { p_session: sessionId }).then(({ data, error }) => {
      if (!actif) return;
      if (error) setErreur(messageErreur(error));
      else setRapport(data as RapportSession);
    });
    return () => {
      actif = false;
    };
  }, [sessionId]);

  if (erreur) return <Alerte type="erreur">{erreur}</Alerte>;
  if (!rapport) return <div className="chargement">Calcul du rapport…</div>;

  const produits = rapport.par_produit ?? [];
  const totalProduits = produits.reduce((s, p) => s + Number(p.montant), 0) || 1;
  const heure = new Date(rapport.calcule_le).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Abidjan' });

  return (
    <div className="rapport-provisoire">
      <p className="secondaire petit">
        {caissier} · lecture provisoire à {heure}. La caisse reste ouverte.
      </p>
      <div className="rapport-chiffres">
        <div>
          <span>Ventes</span>
          <strong>{montant(Number(rapport.total_ventes))}</strong>
        </div>
        <div>
          <span>Tickets</span>
          <strong>{rapport.nombre_ventes}</strong>
        </div>
        <div>
          <span>Panier moyen</span>
          <strong>{montant(Number(rapport.panier_moyen))}</strong>
        </div>
        <div>
          <span>Espèces attendues</span>
          <strong>{montant(Number(rapport.especes_attendues))}</strong>
        </div>
      </div>

      {rapport.par_moyen.length > 0 && (
        <div className="rapport-bloc">
          <h3>Règlements</h3>
          {rapport.par_moyen.map((m) => (
            <div key={m.libelle} className="rapport-ligne">
              <span>
                {m.libelle} <span className="secondaire">({m.nombre})</span>
              </span>
              <strong>{montant(Number(m.montant))}</strong>
            </div>
          ))}
        </div>
      )}

      <div className="rapport-bloc">
        <h3>Produits vendus</h3>
        {produits.length === 0 && <p className="secondaire petit">Aucune vente pour le moment.</p>}
        {produits.map((p) => (
          <div key={p.designation} className="rapport-produit">
            <div className="rapport-ligne">
              <span className="rapport-produit-nom">{p.designation}</span>
              <span className="secondaire">× {Number(p.quantite).toLocaleString('fr-FR')}</span>
              <strong>{montant(Number(p.montant))}</strong>
            </div>
            <div className="barre-part" aria-hidden>
              <span style={{ width: `${Math.round((Number(p.montant) / totalProduits) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>

      {rapport.nombre_annulations > 0 && (
        <p className="secondaire petit">
          {rapport.nombre_annulations} annulation{rapport.nombre_annulations > 1 ? 's' : ''} : {montant(Number(rapport.total_annulations))}
        </p>
      )}

      <button
        type="button"
        className="bouton bouton-discret bouton-plein"
        disabled={!identite}
        onClick={() =>
          identite &&
          void imprimerTicket(
            <RapportCaisse identite={identite} rapport={rapport} format={format} caisse={caisse} magasin={magasin} caissier={caissier} ouverteLe={ouverteLe} />,
          )
        }
      >
        🖨 Imprimer le rapport X
      </button>
    </div>
  );
}
