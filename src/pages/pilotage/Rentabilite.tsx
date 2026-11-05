import { Fragment, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { montant } from '../../lib/argent';
import { aujourdhui, dateFr } from '../../lib/tresorerie';
import { classeurXlsx, telechargerFichier, TYPE_XLSX } from '../../lib/excel';
import { enUnites } from '../../lib/argent';
import { Alerte, Champ, EnTetePage, MontantFort, Pastille } from '../../components/ui';

interface Mois {
  mois: string;
  ca: number;
  marge: number;
  taux_marge: number | null;
  charges: number;
  resultat: number;
}
interface Compte {
  mois: string;
  chiffre_affaires: number;
  cout_ventes: number;
  marge: number;
  taux_marge: number | null;
  charges: number;
  charges_detail: { libelle: string; compte: string; reel: number; prevu: number; retenu: number; estime: boolean }[];
  budget_valide: boolean;
  resultat: number;
  seuil_rentabilite: number | null;
  point_mort: string | null;
  reste_a_vendre: number | null;
  par_jour_restant: number | null;
  jours_restants: number;
  tickets: number;
  sig: { repere: string; libelle: string; montant: number; detail?: Record<string, number> }[];
  evolution: Mois[];
}

const libelleMois = (iso: string, court = false) => {
  const s = new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('fr-FR', court ? { month: 'short' } : { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1).replace('.', '');
};

const DETAILS: Record<string, string> = {
  ventes_701: 'Ventes de marchandises (701)',
  achats_601: 'Achats de marchandises et frais (601)',
  variation_stock_6031: 'Variation de stock (6031)',
  services_exterieurs_autres_achats: 'Autres achats et services extérieurs (60–63, 65)',
  impots_taxes_64: 'Impôts et taxes (64)',
  charges_personnel_66: 'Charges de personnel (66)',
  dotations_68: 'Dotations aux amortissements (68)',
  frais_financiers_67: 'Frais financiers (67)',
  impot_resultat: 'Impôt sur le résultat',
};

/** Causes d'un mauvais mois : comparaison avec le mois précédent. */
function causes(evo: Mois[]): string[] {
  if (evo.length < 2) return [];
  const a = evo[evo.length - 1]!;
  const b = evo[evo.length - 2]!;
  const r: string[] = [];
  if (b.ca > 0 && a.ca < b.ca * 0.95) r.push(`Ventes en baisse de ${Math.round(100 - (100 * a.ca) / b.ca)} % par rapport au mois précédent.`);
  if (a.taux_marge !== null && b.taux_marge !== null && a.taux_marge < b.taux_marge - 1)
    r.push(`Taux de marge en baisse : ${a.taux_marge} % contre ${b.taux_marge} % (prix d’achat en hausse, remises ou soldes).`);
  if (b.charges > 0 && a.charges > b.charges * 1.05) r.push(`Charges en hausse de ${Math.round((100 * a.charges) / b.charges - 100)} %.`);
  return r;
}

function Evolution({ evo }: { evo: Mois[] }) {
  const max = Math.max(1, ...evo.map((m) => Math.abs(Number(m.resultat))), ...evo.map((m) => Number(m.ca) / 4));
  const L = 640;
  const H = 220;
  const zero = H / 2;
  const l = (L - 40) / Math.max(evo.length, 1);
  const pointsCa = evo
    .map((m, i) => `${40 + i * l + l / 2},${zero - ((H / 2 - 16) * Number(m.ca)) / 4 / max}`)
    .join(' ');
  return (
    <div className="graphique">
      <svg viewBox={`0 0 ${L} ${H}`} role="img" aria-label="Résultat net sur 12 mois">
        <line x1={40} x2={L} y1={zero} y2={zero} className="graphique-grille" />
        {evo.map((m, i) => {
          const h = ((H / 2 - 16) * Math.abs(Number(m.resultat))) / max;
          const positif = Number(m.resultat) >= 0;
          return (
            <g key={m.mois}>
              <rect x={40 + i * l + l * 0.2} y={positif ? zero - h : zero} width={l * 0.6} height={Math.max(h, 1)} rx={3} className={positif ? 'barre-positive' : 'barre-negative'}>
                <title>{`${libelleMois(m.mois)} : résultat ${montant(m.resultat)}, CA ${montant(m.ca)}`}</title>
              </rect>
              <text x={40 + i * l + l / 2} y={H - 4} textAnchor="middle" className="graphique-axe">
                {libelleMois(m.mois, true)}
              </text>
            </g>
          );
        })}
        <polyline points={pointsCa} fill="none" stroke="#3b6fb6" strokeWidth={2} strokeDasharray="4 3" />
      </svg>
      <p className="secondaire">
        Barres : résultat net (vert positif, rouge négatif). Pointillé bleu : chiffre d’affaires (à l’échelle ¼).
      </p>
    </div>
  );
}

export function Rentabilite() {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const [mois, setMois] = useState(aujourdhui().slice(0, 7));
  const [c, setC] = useState<Compte | null>(null);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    let actif = true;
    void supabase.rpc('compte_exploitation', { p_org: org, p_mois: `${mois}-01` }).then(({ data, error }) => {
      if (!actif) return;
      if (error) setErreur(messageErreur(error));
      else {
        setErreur('');
        setC(data as Compte);
      }
    });
    return () => {
      actif = false;
    };
  }, [org, mois]);

  function exporter() {
    if (!c) return;
    telechargerFichier(
      `rentabilite-${mois}.xlsx`,
      TYPE_XLSX,
      classeurXlsx([
        {
          nom: 'Compte d’exploitation',
          titre: [`${organisation!.nom} — Compte d’exploitation de ${libelleMois(c.mois).toLowerCase()}`],
          entetes: ['Ligne', 'Montant'],
          lignes: [
            ['Chiffre d’affaires', enUnites(c.chiffre_affaires)],
            ['− Coût d’achat des marchandises vendues', enUnites(c.cout_ventes)],
            ['= Marge commerciale', enUnites(c.marge)],
            ['Taux de marge (%)', c.taux_marge ?? 0],
            ['− Charges du mois', enUnites(c.charges)],
            ['= Résultat net', enUnites(c.resultat)],
            ['Seuil de rentabilité', c.seuil_rentabilite === null ? '' : enUnites(c.seuil_rentabilite)],
          ],
        },
        {
          nom: 'SIG SYSCOHADA',
          entetes: ['Repère', 'Solde', 'Montant'],
          lignes: c.sig.map((s) => [s.repere, s.libelle, enUnites(s.montant)]),
        },
        {
          nom: 'Charges',
          entetes: ['Poste', 'Compte', 'Prévu', 'Réel', 'Retenu'],
          lignes: c.charges_detail.map((x) => [x.libelle, x.compte, enUnites(x.prevu), enUnites(x.reel), enUnites(x.retenu)]),
        },
        {
          nom: 'Évolution 12 mois',
          entetes: ['Mois', 'CA', 'Marge', 'Taux de marge (%)', 'Charges', 'Résultat'],
          lignes: c.evolution.map((m) => [libelleMois(m.mois), enUnites(m.ca), enUnites(m.marge), m.taux_marge ?? 0, enUnites(m.charges), enUnites(m.resultat)]),
        },
      ]),
    );
  }

  const progression = c?.seuil_rentabilite ? Math.min(100, (100 * Number(c.chiffre_affaires)) / Number(c.seuil_rentabilite)) : 0;
  const pourquoi = c ? causes(c.evolution) : [];

  return (
    <>
      <EnTetePage
        icone="📈"
        titre="Rentabilité"
        sousTitre="La boutique gagne-t-elle de l’argent ? Compte d’exploitation, seuil de rentabilité et soldes SYSCOHADA, mois par mois."
        actions={c && <button className="bouton bouton-discret" onClick={exporter}>Excel</button>}
      />
      <Alerte>{erreur}</Alerte>
      <section className="carte">
        <div className="filtres-ligne">
          <Champ label="Mois">
            <input type="month" value={mois} onChange={(e) => e.target.value && setMois(e.target.value)} />
          </Champ>
          {c && !c.budget_valide && <Pastille ton="or">Budget du mois non validé : seules les dépenses saisies comptent</Pastille>}
        </div>
      </section>

      {c && (
        <>
          <section className="tdb-tuiles">
            <div className="kpi">
              <span className="kpi-icone" aria-hidden>💰</span>
              <span className="kpi-libelle">Chiffre d’affaires</span>
              <span className="kpi-valeur"><MontantFort v={c.chiffre_affaires} /></span>
              <span className="kpi-evolution secondaire">{c.tickets} tickets</span>
            </div>
            <div className="kpi">
              <span className="kpi-icone" aria-hidden>📊</span>
              <span className="kpi-libelle">Marge commerciale</span>
              <span className="kpi-valeur"><MontantFort v={c.marge} /></span>
              <span className="kpi-evolution secondaire">taux {c.taux_marge ?? 0} %</span>
            </div>
            <div className="kpi">
              <span className="kpi-icone" aria-hidden>🧾</span>
              <span className="kpi-libelle">Charges du mois</span>
              <span className="kpi-valeur"><MontantFort v={c.charges} /></span>
              <span className="kpi-evolution secondaire">réel, à défaut budget validé</span>
            </div>
            <div className={`kpi ${c.resultat >= 0 ? 'kpi-positif' : 'kpi-negatif'}`}>
              <span className="kpi-icone" aria-hidden>{c.resultat >= 0 ? '✅' : '⚠️'}</span>
              <span className="kpi-libelle">Résultat net</span>
              <span className="kpi-valeur"><MontantFort v={c.resultat} /></span>
              <span className="kpi-evolution">{c.resultat >= 0 ? 'bénéfice' : 'perte'}</span>
            </div>
          </section>

          <div className="tdb-grille">
            <section className="carte">
              <h3>Seuil de rentabilité</h3>
              {c.seuil_rentabilite === null ? (
                <p className="secondaire">Pas encore de marge ce mois-ci : le seuil se calcule dès les premières ventes.</p>
              ) : (
                <>
                  <p>
                    Il faut vendre <strong className="montant-bloc">{montant(c.seuil_rentabilite)}</strong> ce mois-ci pour couvrir{' '}
                    {montant(c.charges)} de charges avec {c.taux_marge} % de marge.
                  </p>
                  <div className="jauge jauge-grande">
                    <span style={{ width: `${progression}%` }} />
                  </div>
                  <p className="secondaire">{Math.round(progression)} % atteints</p>
                  {c.point_mort ? (
                    <Alerte type="succes">Point mort atteint le {dateFr(c.point_mort)} : chaque vente fait désormais du bénéfice.</Alerte>
                  ) : c.jours_restants > 0 ? (
                    <Alerte type="info">
                      Reste {montant(c.reste_a_vendre ?? 0)} à vendre, soit {montant(c.par_jour_restant ?? 0)} par jour pendant {c.jours_restants} jours.
                    </Alerte>
                  ) : (
                    <Alerte>Le mois s’est terminé sous le seuil de rentabilité.</Alerte>
                  )}
                </>
              )}
            </section>
            <section className="carte">
              <h3>Compte d’exploitation</h3>
              <table className="tableau tableau-compact">
                <tbody>
                  <tr><td>Chiffre d’affaires</td><td className="nombre">{montant(c.chiffre_affaires)}</td></tr>
                  <tr><td>− Coût d’achat des marchandises vendues</td><td className="nombre">{montant(c.cout_ventes)}</td></tr>
                  <tr className="ligne-total"><td>= Marge commerciale ({c.taux_marge ?? 0} %)</td><td className="nombre">{montant(c.marge)}</td></tr>
                  <tr><td>− Charges du mois</td><td className="nombre">{montant(c.charges)}</td></tr>
                  <tr className="ligne-total">
                    <td>= Résultat net</td>
                    <td className={`nombre ${c.resultat < 0 ? 'texte-negatif' : 'texte-positif'}`}>{montant(c.resultat)}</td>
                  </tr>
                </tbody>
              </table>
            </section>
          </div>

          <section className="carte">
            <h3>Évolution sur 12 mois</h3>
            <Evolution evo={c.evolution} />
            {pourquoi.length > 0 && (
              <Alerte type="info">
                <strong>Pourquoi ce mois est moins bon :</strong>
                <ul className="liste-simple">
                  {pourquoi.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Alerte>
            )}
          </section>

          <div className="tdb-grille">
            <section className="carte">
              <h3>Charges retenues</h3>
              {c.charges_detail.length === 0 ? (
                <p className="secondaire">Aucune charge saisie ni budgétée ce mois-ci.</p>
              ) : (
                <table className="tableau tableau-compact">
                  <thead>
                    <tr><th>Poste</th><th className="nombre">Prévu</th><th className="nombre">Réel</th><th className="nombre">Retenu</th></tr>
                  </thead>
                  <tbody>
                    {c.charges_detail.map((x) => (
                      <tr key={x.libelle}>
                        <td>{x.libelle} <span className="secondaire">{x.compte}</span> {x.estime && <Pastille ton="or">estimé</Pastille>}</td>
                        <td className="nombre">{montant(x.prevu)}</td>
                        <td className="nombre">{montant(x.reel)}</td>
                        <td className="nombre">{montant(x.retenu)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            <section className="carte">
              <h3>Soldes intermédiaires de gestion (SYSCOHADA)</h3>
              <table className="tableau tableau-compact sig">
                <tbody>
                  {c.sig.map((s) => (
                    <Fragment key={s.repere}>
                      <tr className={['XA', 'XD', 'XG', 'XI'].includes(s.repere) ? 'ligne-total' : ''}>
                        <td><span className="code">{s.repere}</span> {s.libelle}</td>
                        <td className={`nombre ${Number(s.montant) < 0 ? 'texte-negatif' : ''}`}>{montant(s.montant)}</td>
                      </tr>
                      {s.detail &&
                        Object.entries(s.detail)
                          .filter(([, v]) => Number(v) !== 0)
                          .map(([k, v]) => (
                            <tr key={`${s.repere}-${k}`} className="sig-detail">
                              <td>{DETAILS[k] ?? k}</td>
                              <td className="nombre">{montant(v)}</td>
                            </tr>
                          ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              <p className="secondaire">
                Aide à la gestion calculée depuis les ventes, réceptions, mouvements de stock et dépenses. Les états financiers
                annuels officiels restent à faire valider par un expert-comptable.
              </p>
            </section>
          </div>
        </>
      )}
    </>
  );
}
