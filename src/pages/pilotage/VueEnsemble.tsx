import { exporterClasseur, type FormatExport } from '../../lib/export';
import { BoutonsExport } from '../../components/Export';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { enUnites, montant } from '../../lib/argent';
import { choisirMagasinGlobal, useMagasinGlobal } from '../../lib/magasinGlobal';
import { Alerte, Champ, EnTetePage } from '../../components/ui';

interface LigneMagasin {
  id: string;
  nom: string;
  ventes_jour: number;
  tickets_jour: number;
  ventes_mois: number;
  tickets_mois: number;
  cout_ventes: number;
  marge: number;
  charges: number;
  resultat: number;
  valeur_stock: number;
  ruptures: number;
  ecarts: number;
  caisses_ouvertes: number;
}
interface Vue {
  mois: string;
  aujourdhui: string;
  magasins: LigneMagasin[];
  charges_communes: number;
}
const CLES = ['ventes_jour', 'tickets_jour', 'ventes_mois', 'tickets_mois', 'cout_ventes', 'marge', 'charges', 'resultat', 'valeur_stock', 'ruptures', 'ecarts', 'caisses_ouvertes'] as const;

const moisCourant = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const taux = (marge: number, ca: number) => (ca > 0 ? `${((marge / ca) * 100).toFixed(1).replace('.', ',')} %` : '—');

/** Les magasins côte à côte, puis le total de l'entreprise. Un clic sur un magasin le choisit pour tout l'écran. */
export function VueEnsemble() {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const [mois, setMois] = useState(moisCourant());
  const [vue, setVue] = useState<Vue | null>(null);
  const [erreur, setErreur] = useState('');
  const choisi = useMagasinGlobal();

  const charger = useCallback(async () => {
    setErreur('');
    const { data, error } = await supabase.rpc('vue_ensemble', { p_org: org, p_mois: `${mois}-01` });
    if (error) return setErreur(messageErreur(error));
    setVue(data as Vue);
  }, [org, mois]);
  useEffect(() => {
    void charger();
  }, [charger]);

  const lignes = vue?.magasins ?? [];
  const total = Object.fromEntries(CLES.map((k) => [k, lignes.reduce((s, l) => s + Number(l[k]), 0)])) as Record<(typeof CLES)[number], number>;
  const communes = Number(vue?.charges_communes ?? 0);
  const resultatGlobal = total.resultat - communes;
  const meilleur = Math.max(1, ...lignes.map((l) => Number(l.ventes_mois)));
  const ceMois = mois === moisCourant();

  function exporter(format: FormatExport = 'xlsx') {
    const l = (x: LigneMagasin | (typeof total & { nom: string })) => [
      x.nom, enUnites(x.ventes_jour), x.tickets_jour, enUnites(x.ventes_mois), x.tickets_mois, enUnites(x.marge), enUnites(x.charges), enUnites(x.resultat), enUnites(x.valeur_stock), x.ruptures, enUnites(x.ecarts),
    ];
    exporterClasseur(
      `Vue-ensemble-${mois}.xlsx`,
      [
        {
          nom: 'Magasins',
          titre: [`Vue d’ensemble des magasins — ${mois}`],
          entetes: ['Magasin', 'Ventes du jour', 'Tickets du jour', 'Ventes du mois', 'Tickets du mois', 'Marge', 'Charges', 'Résultat', 'Valeur du stock', 'Ruptures', 'Écarts de caisse'],
          lignes: [...lignes.map(l), ['Charges communes', '', '', '', '', '', enUnites(communes), enUnites(-communes), '', '', '']],
          totaux: ['Entreprise', enUnites(total.ventes_jour), total.tickets_jour, enUnites(total.ventes_mois), total.tickets_mois, enUnites(total.marge), enUnites(total.charges + communes), enUnites(resultatGlobal), enUnites(total.valeur_stock), total.ruptures, enUnites(total.ecarts)],
          largeurs: [26, 16, 14, 16, 14, 16, 16, 16, 16, 10, 16],
        },
      ],
      format,
    );
  }

  return (
    <>
      <EnTetePage
        icone="🏬"
        titre="Vue d’ensemble"
        sousTitre="Chaque magasin géré à part, et le résultat de toute l’entreprise. Cliquez sur un magasin pour ne voir que lui dans le reste de l’application."
        actions={
          <div className="actions-entete">
            <Champ label="Mois">
              <input type="month" value={mois} max={moisCourant()} onChange={(e) => e.target.value && setMois(e.target.value)} />
            </Champ>
            <BoutonsExport onExport={exporter} disabled={!lignes.length} />
          </div>
        }
      />
      <Alerte>{erreur}</Alerte>
      {vue && (
        <>
          <section className="tuiles">
            <div className="tuile tuile-fixe">
              <span className="tuile-valeur">{montant(total.ventes_mois)}</span>
              <span className="tuile-libelle">ventes du mois, {lignes.length} magasin{lignes.length > 1 ? 's' : ''}</span>
            </div>
            <div className="tuile tuile-fixe">
              <span className="tuile-valeur">{montant(total.marge)}</span>
              <span className="tuile-libelle">marge commerciale ({taux(total.marge, total.ventes_mois)})</span>
            </div>
            <div className="tuile tuile-fixe">
              <span className="tuile-valeur">{montant(total.charges + communes)}</span>
              <span className="tuile-libelle">charges, dont {montant(communes)} communes</span>
            </div>
            <div className={`tuile tuile-fixe ${resultatGlobal < 0 ? 'tuile-alerte' : 'tuile-ok'}`}>
              <span className="tuile-valeur">{montant(resultatGlobal)}</span>
              <span className="tuile-libelle">{resultatGlobal < 0 ? 'perte de l’entreprise' : 'bénéfice de l’entreprise'}</span>
            </div>
          </section>

          <section className="cartes-magasins">
            {lignes.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`carte carte-magasin ${choisi === l.id ? 'choisi' : ''}`}
                onClick={() => choisirMagasinGlobal(choisi === l.id ? '' : l.id)}
                aria-pressed={choisi === l.id}
              >
                <span className="carte-magasin-tete">
                  <strong>🏬 {l.nom}</strong>
                  {l.caisses_ouvertes > 0 ? <span className="pastille-colonne">{l.caisses_ouvertes} caisse{l.caisses_ouvertes > 1 ? 's' : ''} ouverte{l.caisses_ouvertes > 1 ? 's' : ''}</span> : <span className="pastille-colonne ignoree">caisses fermées</span>}
                </span>
                <span className="carte-magasin-ca">{montant(l.ventes_mois)}</span>
                <span className="barre-part"><i style={{ width: `${Math.round((Number(l.ventes_mois) / meilleur) * 100)}%` }} /></span>
                <span className="secondaire">
                  {total.ventes_mois > 0 ? `${Math.round((Number(l.ventes_mois) / total.ventes_mois) * 100)} % des ventes` : 'aucune vente'} · {l.tickets_mois} ticket{l.tickets_mois > 1 ? 's' : ''}
                  {ceMois && <> · aujourd’hui {montant(l.ventes_jour)}</>}
                </span>
                <span className="carte-magasin-chiffres">
                  <span><small>Marge</small>{montant(l.marge)} <em>{taux(l.marge, l.ventes_mois)}</em></span>
                  <span><small>Charges</small>{montant(l.charges)}</span>
                  <span className={l.resultat < 0 ? 'texte-negatif' : 'texte-positif'}><small>Résultat</small>{montant(l.resultat)}</span>
                </span>
                <span className="carte-magasin-chiffres">
                  <span><small>Stock</small>{montant(l.valeur_stock)}</span>
                  <span className={l.ruptures > 0 ? 'texte-negatif' : ''}><small>Ruptures</small>{l.ruptures}</span>
                  <span className={l.ecarts !== 0 ? 'texte-negatif' : ''}><small>Écarts de caisse</small>{montant(l.ecarts)}</span>
                </span>
              </button>
            ))}
          </section>

          <section className="carte">
            <h2>Comparaison</h2>
            <div className="defilement-horizontal">
              <table className="tableau">
                <thead>
                  <tr>
                    <th>Magasin</th>
                    {ceMois && <th className="nombre">Ventes du jour</th>}
                    <th className="nombre">Ventes du mois</th>
                    <th className="nombre">Marge</th>
                    <th className="nombre">Taux</th>
                    <th className="nombre">Charges</th>
                    <th className="nombre">Résultat</th>
                    <th className="nombre">Stock</th>
                    <th className="nombre">Ruptures</th>
                    <th className="nombre">Écarts</th>
                  </tr>
                </thead>
                <tbody>
                  {lignes.map((l) => (
                    <tr key={l.id} className={choisi === l.id ? 'ligne-choisie' : ''}>
                      <td><strong>{l.nom}</strong></td>
                      {ceMois && <td className="nombre">{montant(l.ventes_jour)}</td>}
                      <td className="nombre">{montant(l.ventes_mois)}</td>
                      <td className="nombre">{montant(l.marge)}</td>
                      <td className="nombre">{taux(l.marge, l.ventes_mois)}</td>
                      <td className="nombre">{montant(l.charges)}</td>
                      <td className={`nombre ${l.resultat < 0 ? 'texte-negatif' : ''}`}><strong>{montant(l.resultat)}</strong></td>
                      <td className="nombre">{montant(l.valeur_stock)}</td>
                      <td className="nombre">{l.ruptures}</td>
                      <td className="nombre">{montant(l.ecarts)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="secondaire">Charges communes (sans magasin)</td>
                    {ceMois && <td />}
                    <td /><td /><td />
                    <td className="nombre">{montant(communes)}</td>
                    <td className="nombre">{montant(-communes)}</td>
                    <td /><td /><td />
                  </tr>
                </tbody>
                <tfoot>
                  <tr className="ligne-total">
                    <td><strong>Entreprise</strong></td>
                    {ceMois && <td className="nombre"><strong>{montant(total.ventes_jour)}</strong></td>}
                    <td className="nombre"><strong>{montant(total.ventes_mois)}</strong></td>
                    <td className="nombre"><strong>{montant(total.marge)}</strong></td>
                    <td className="nombre">{taux(total.marge, total.ventes_mois)}</td>
                    <td className="nombre"><strong>{montant(total.charges + communes)}</strong></td>
                    <td className={`nombre ${resultatGlobal < 0 ? 'texte-negatif' : ''}`}><strong>{montant(resultatGlobal)}</strong></td>
                    <td className="nombre"><strong>{montant(total.valeur_stock)}</strong></td>
                    <td className="nombre">{total.ruptures}</td>
                    <td className="nombre">{montant(total.ecarts)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="secondaire petit-texte">
              Marge = ventes − coût d’achat des articles vendus. Charges = dépenses payées par les comptes du magasin (Trésorerie › compte › Magasin). Les dépenses des
              comptes « communs » sont réparties sur l’entreprise entière. Résultat de gestion, avant écritures d’inventaire et impôts.
            </p>
          </section>
        </>
      )}
    </>
  );
}
