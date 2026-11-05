import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { quantite, useMagasins } from '../../lib/stock';
import { Alerte, EnTetePage, Ico, Pastille, Vide } from '../../components/ui';

interface LigneAlerte {
  niveau: 'critique' | 'attention' | 'info';
  type: string;
  produit_id: string;
  designation: string;
  magasin_id: string;
  quantite: number | string;
  seuil: number | null;
  date_reference: string | null;
  detail: string;
}

const ORDRE = { critique: 0, attention: 1, info: 2 };
const TON = { critique: 'rouge', attention: 'or', info: 'gris' } as const;
const NIVEAU = { critique: 'Urgent', attention: 'À surveiller', info: 'Information' };
const ICONE_NIVEAU = { critique: '🔴', attention: '🟠', info: 'ℹ️' };

export function AlertesStock() {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const magasins = useMagasins(org);
  const [alertes, setAlertes] = useState<LigneAlerte[]>([]);
  const [erreur, setErreur] = useState('');
  const [charge, setCharge] = useState(false);

  useEffect(() => {
    void supabase.rpc('alertes_stock', { p_org: org }).then(({ data, error }) => {
      if (error) setErreur(messageErreur(error));
      setAlertes(((data ?? []) as LigneAlerte[]).sort((a, b) => ORDRE[a.niveau] - ORDRE[b.niveau] || a.designation.localeCompare(b.designation)));
      setCharge(true);
    });
  }, [org]);

  const nomMagasin = (id: string) => magasins.find((m) => m.id === id)?.nom ?? '';

  return (
    <>
      <EnTetePage
        icone="⚠️" titre="Alertes de stock"
        sousTitre="Ruptures, minimum atteint, lots périmés ou proches de la péremption (30 jours), produits sans sortie depuis 60 jours."
      />
      <Alerte>{erreur}</Alerte>
      <section className="carte">
        {charge && alertes.length === 0 ? (
          <Vide>Aucune alerte. Indiquez un stock minimum sur vos produits pour être prévenu avant la rupture.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Niveau</th>
                  <th>Produit</th>
                  <th className="col-secondaire">Magasin</th>
                  <th className="nombre">Quantité</th>
                  <th>Détail</th>
                </tr>
              </thead>
              <tbody>
                {alertes.map((a, i) => (
                  <tr key={i}>
                    <td>
                      <Pastille ton={TON[a.niveau]}>
                        <Ico>{ICONE_NIVEAU[a.niveau]}</Ico>
                        {NIVEAU[a.niveau]}
                      </Pastille>
                    </td>
                    <td>
                      <strong>{a.designation}</strong>
                    </td>
                    <td className="col-secondaire">{nomMagasin(a.magasin_id)}</td>
                    <td className="nombre">
                      {quantite(a.quantite)}
                      {a.seuil != null && <div className="secondaire">seuil {a.seuil}</div>}
                    </td>
                    <td>
                      {a.detail}
                      {a.date_reference && (
                        <div className="secondaire">{new Date(a.date_reference).toLocaleDateString('fr-FR')}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
