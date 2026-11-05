import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { messageErreur } from '../lib/format';
import { Alerte } from '../components/ui';
import type { MoyenPaiement } from './local';

/** Réglage des moyens de règlement proposés à la caisse (actif, référence obligatoire). */
export function MoyensReglement({ org, modifiable }: { org: string; modifiable: boolean }) {
  const [moyens, setMoyens] = useState<MoyenPaiement[]>([]);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    void supabase
      .from('moyens_paiement')
      .select('*')
      .eq('organisation_id', org)
      .order('ordre')
      .then(({ data, error }) => (error ? setErreur(messageErreur(error)) : setMoyens((data ?? []) as MoyenPaiement[])));
  }, [org]);

  async function changer(m: MoyenPaiement, champ: 'actif' | 'reference_obligatoire', valeur: boolean) {
    setErreur('');
    setMoyens((ms) => ms.map((x) => (x.id === m.id ? { ...x, [champ]: valeur } : x)));
    const { error } = await supabase.from('moyens_paiement').update({ [champ]: valeur }).eq('id', m.id);
    if (error) {
      setErreur(messageErreur(error));
      setMoyens((ms) => ms.map((x) => (x.id === m.id ? { ...x, [champ]: !valeur } : x)));
    }
  }

  return (
    <section className="carte">
      <div className="carte-entete">
        <h2>Moyens de règlement à la caisse</h2>
        <span className="secondaire">Tracés uniquement : aucun paiement n’est déclenché</span>
      </div>
      <Alerte>{erreur}</Alerte>
      <table className="tableau tableau-compact">
        <thead>
          <tr>
            <th>Moyen</th>
            <th>Proposé à la caisse</th>
            <th>Référence de transaction obligatoire</th>
          </tr>
        </thead>
        <tbody>
          {moyens.map((m) => (
            <tr key={m.id} className={m.actif ? '' : 'ligne-inactive'}>
              <td>{m.libelle}</td>
              <td>
                <label className="case">
                  <input
                    type="checkbox"
                    checked={m.actif}
                    disabled={!modifiable}
                    onChange={(e) => void changer(m, 'actif', e.target.checked)}
                    aria-label={`${m.libelle} proposé`}
                  />
                </label>
              </td>
              <td>
                {m.nature !== 'especes' && (
                  <label className="case">
                    <input
                      type="checkbox"
                      checked={m.reference_obligatoire}
                      disabled={!modifiable}
                      onChange={(e) => void changer(m, 'reference_obligatoire', e.target.checked)}
                      aria-label={`Référence obligatoire pour ${m.libelle}`}
                    />
                  </label>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
