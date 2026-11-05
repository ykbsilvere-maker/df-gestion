import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { clavierMontant, lireMontant, montant } from '../../lib/argent';
import { quantite } from '../../lib/stock';
import { aujourdhui, dateFr } from '../../lib/tresorerie';
import { Alerte, Champ, EnTetePage, Fenetre, MontantFort, Pastille, Vide } from '../../components/ui';
import { Vignette } from '../../components/PhotoProduit';

type Situation = 'peremption' | 'dormant' | 'surstock_fort' | 'surstock';
interface Ligne {
  id: string;
  code: string;
  designation: string;
  photo_path: string | null;
  stock: number;
  valeur: number;
  cout: number | null;
  prix_vente: number;
  vendu_30j: number;
  couverture_jours: number | null;
  age_moyen_jours: number | null;
  jours_sans_vente: number | null;
  date_peremption: string | null;
  quantite_perissable: number | null;
  cout_stockage_mois: number;
  situation: Situation;
  promo_en_cours: number | null;
  semaines_fortes: number[] | null;
  remise_proposee: number;
  prix_propose: number;
  plancher_atteint: boolean;
  proposition: string;
}
interface Parametres {
  surstock_jours: number;
  surstock_fort_jours: number;
  dormant_jours: number;
  peremption_jours: number;
  taux_stockage_mois: number;
  remise_surstock: number;
  remise_surstock_fort: number;
}
interface Promo {
  id: string;
  designation: string;
  prix_promo: number;
  prix_normal: number;
  cout_reference: number | null;
  date_debut: string;
  date_fin: string;
  statut: 'proposee' | 'active' | 'annulee';
  motif: string | null;
  qte_pendant: number;
  qte_avant: number;
  ca_pendant: number;
  en_cours: boolean;
}

const SITUATIONS: Record<Situation, { ton: 'rouge' | 'or' | 'gris'; libelle: string }> = {
  peremption: { ton: 'rouge', libelle: 'Péremption proche' },
  dormant: { ton: 'rouge', libelle: 'Dormant' },
  surstock_fort: { ton: 'or', libelle: 'Surstock fort' },
  surstock: { ton: 'or', libelle: 'Surstock' },
};

/** Semaine de l'année → mois approximatif (pour la période conseillée). */
function moisDeSemaine(s: number): string {
  const d = new Date(new Date().getFullYear(), 0, 1 + (s - 1) * 7);
  return d.toLocaleDateString('fr-FR', { month: 'long' });
}

export function Soldes() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [totaux, setTotaux] = useState<{ valeur_immobilisee: number; cout_stockage_mois: number; articles: number } | null>(null);
  const [param, setParam] = useState<Parametres | null>(null);
  const [promos, setPromos] = useState<Promo[]>([]);
  const [reglages, setReglages] = useState(false);
  const [nouvelle, setNouvelle] = useState<{ ligne: Ligne; prix: string; debut: string; fin: string; motif: string; sousCout: string } | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');

  const charger = useCallback(async () => {
    const [a, b] = await Promise.all([supabase.rpc('analyse_surstock', { p_org: org }), supabase.rpc('bilan_promotions', { p_org: org })]);
    if (a.error) return setErreur(messageErreur(a.error));
    const d = a.data as { parametres: Parametres; lignes: Ligne[]; totaux: typeof totaux };
    setLignes(d.lignes);
    setTotaux(d.totaux);
    setParam(d.parametres);
    setPromos((b.data ?? []) as Promo[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);
  useEffect(() => {
    void charger();
  }, [charger]);

  async function enregistrerReglages(e: FormEvent) {
    e.preventDefault();
    if (!param) return;
    const { error } = await supabase.rpc('enregistrer_parametres_soldes', { p_org: org, p: param });
    if (error) return setErreur(messageErreur(error));
    setReglages(false);
    await charger();
  }

  async function creer(e: FormEvent) {
    e.preventDefault();
    if (!nouvelle) return;
    const prix = lireMontant(nouvelle.prix);
    if (prix === null) return setErreur('Indiquez le prix de solde.');
    const { data, error } = await supabase.rpc('creer_promotion', {
      p_org: org,
      p_produit: nouvelle.ligne.id,
      p_prix: prix,
      p_debut: nouvelle.debut,
      p_fin: nouvelle.fin,
      p_motif: nouvelle.motif || null,
      p_sous_cout_motif: nouvelle.sousCout || null,
    });
    if (error) return setErreur(messageErreur(error));
    setNouvelle(null);
    setInfo(
      (data as { statut: string }).statut === 'active'
        ? 'Promotion active : la caisse applique le nouveau prix automatiquement pendant ces dates.'
        : 'Promotion proposée : elle s’appliquera dès que le propriétaire la valide.',
    );
    await charger();
  }

  async function statut(p: Promo, s: 'active' | 'annulee') {
    const { error } = await supabase.rpc('changer_statut_promotion', { p_promotion: p.id, p_statut: s });
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

  const fin = (jours: number) => {
    const d = new Date();
    d.setDate(d.getDate() + jours);
    return d.toISOString().slice(0, 10);
  };

  return (
    <>
      <EnTetePage
        icone="🏷️"
        titre="Surstock et soldes"
        sousTitre="Les articles qui dorment, ce qu’ils coûtent à garder, et un prix de solde qui garde une marge positive."
        actions={
          peut('promotions.valider') && (
            <button className="bouton bouton-discret" onClick={() => setReglages(true)}>Réglages</button>
          )
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      {totaux && (
        <section className="tuiles">
          <div className="tuile tuile-fixe">
            <span className="tuile-valeur">{totaux.articles}</span>
            <span className="tuile-libelle">articles à écouler</span>
          </div>
          <div className="tuile tuile-fixe">
            <span className="tuile-valeur"><MontantFort v={totaux.valeur_immobilisee} /></span>
            <span className="tuile-libelle">argent bloqué en stock</span>
          </div>
          <div className="tuile tuile-fixe tuile-alerte">
            <span className="tuile-valeur"><MontantFort v={totaux.cout_stockage_mois} /></span>
            <span className="tuile-libelle">coût de stockage par mois ({param?.taux_stockage_mois} %)</span>
          </div>
        </section>
      )}

      <section className="carte">
        {lignes.length === 0 ? (
          <Vide>Aucun surstock : le stock tourne bien.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau tableau-compact">
              <thead>
                <tr>
                  <th>Produit</th>
                  <th>Situation</th>
                  <th className="nombre">Stock</th>
                  <th className="nombre col-secondaire">Couverture</th>
                  <th className="nombre col-secondaire">Âge moyen</th>
                  <th className="nombre col-secondaire">Sans vente</th>
                  <th className="nombre">Valeur</th>
                  <th>Proposition</th>
                  <th className="nombre">Prix proposé</th>
                  <th aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {lignes.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <div className="produit-avec-photo">
                        <Vignette chemin={l.photo_path} taille={36} />
                        <div>
                          <strong>{l.designation}</strong>
                          <div className="secondaire">{l.code} · {quantite(l.vendu_30j)} vendus en 30 j</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Pastille ton={SITUATIONS[l.situation].ton}>{SITUATIONS[l.situation].libelle}</Pastille>
                      {l.date_peremption && <div className="secondaire">péremption {dateFr(l.date_peremption)}</div>}
                    </td>
                    <td className="nombre">{quantite(l.stock)}</td>
                    <td className="nombre col-secondaire">{l.couverture_jours === null ? '∞' : `${l.couverture_jours} j`}</td>
                    <td className="nombre col-secondaire">{l.age_moyen_jours ?? '—'} j</td>
                    <td className="nombre col-secondaire">{l.jours_sans_vente === null ? 'jamais vendu' : `${l.jours_sans_vente} j`}</td>
                    <td className="nombre">
                      {montant(l.valeur)}
                      <div className="secondaire">{montant(l.cout_stockage_mois)}/mois</div>
                    </td>
                    <td>
                      <span className="petit-texte">{l.proposition}</span>
                      {l.semaines_fortes && l.semaines_fortes.length > 0 && (
                        <div className="secondaire">Se vend le mieux en {[...new Set(l.semaines_fortes.map(moisDeSemaine))].join(', ')}</div>
                      )}
                    </td>
                    <td className="nombre">
                      {l.promo_en_cours ? (
                        <Pastille ton="vert">en promo {montant(l.promo_en_cours)}</Pastille>
                      ) : (
                        <>
                          <strong>{montant(l.prix_propose)}</strong>
                          <div className="secondaire">
                            <s>{montant(l.prix_vente)}</s> −{Math.round(Number(l.remise_proposee))} %
                            {l.plancher_atteint && ' · au coût'}
                          </div>
                        </>
                      )}
                    </td>
                    <td>
                      {peut('promotions.creer') && !l.promo_en_cours && (
                        <button
                          className="bouton bouton-principal bouton-petit"
                          onClick={() =>
                            setNouvelle({ ligne: l, prix: montant(l.prix_propose, ''), debut: aujourdhui(), fin: fin(14), motif: l.proposition, sousCout: '' })
                          }
                        >
                          Appliquer
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="carte">
        <h2>Promotions et ventes gagnées</h2>
        {promos.length === 0 ? (
          <Vide>Aucune promotion pour l’instant.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Produit</th>
                  <th>Période</th>
                  <th className="nombre">Prix</th>
                  <th className="nombre">Vendus pendant</th>
                  <th className="nombre col-secondaire">Avant (même durée)</th>
                  <th>Statut</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {promos.map((p) => {
                  const gain = Number(p.qte_pendant) - Number(p.qte_avant);
                  return (
                    <tr key={p.id} className={p.statut === 'annulee' ? 'ligne-annulee' : ''}>
                      <td><strong>{p.designation}</strong>{p.motif && <div className="secondaire">{p.motif}</div>}</td>
                      <td>{dateFr(p.date_debut)} → {dateFr(p.date_fin)}</td>
                      <td className="nombre">{montant(p.prix_promo)}<div className="secondaire"><s>{montant(p.prix_normal)}</s></div></td>
                      <td className="nombre">
                        {quantite(p.qte_pendant)}
                        {gain !== 0 && <div className={gain > 0 ? 'texte-positif' : 'texte-negatif'}>{gain > 0 ? '+' : ''}{quantite(gain)}</div>}
                      </td>
                      <td className="nombre col-secondaire">{quantite(p.qte_avant)}</td>
                      <td>
                        {p.statut === 'active' ? (
                          <Pastille ton={p.en_cours ? 'vert' : 'gris'}>{p.en_cours ? 'En cours' : 'Active'}</Pastille>
                        ) : p.statut === 'proposee' ? (
                          <Pastille ton="or">À valider</Pastille>
                        ) : (
                          <Pastille ton="gris">Annulée</Pastille>
                        )}
                      </td>
                      <td className="actions-ligne">
                        {p.statut === 'proposee' && peut('promotions.valider') && (
                          <button className="bouton-lien" onClick={() => void statut(p, 'active')}>Valider</button>
                        )}
                        {p.statut !== 'annulee' && peut('promotions.valider') && (
                          <button className="bouton-lien lien-danger" onClick={() => void statut(p, 'annulee')}>Arrêter</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Fenetre titre={`Solde — ${nouvelle?.ligne.designation ?? ''}`} ouverte={!!nouvelle} onFermer={() => setNouvelle(null)}>
        {nouvelle && (
          <form className="formulaire" onSubmit={creer}>
            <Alerte>{erreur}</Alerte>
            <p>
              Prix actuel <strong>{montant(nouvelle.ligne.prix_vente)}</strong>
              {nouvelle.ligne.cout !== null && <> · coût de revient <strong>{montant(nouvelle.ligne.cout)}</strong></>}.
            </p>
            <div className="grille-2">
              <Champ label="Prix de solde">
                <input value={nouvelle.prix} onChange={(e) => setNouvelle({ ...nouvelle, prix: e.target.value })} inputMode={clavierMontant()} required autoFocus />
              </Champ>
              <Champ label="Motif">
                <input value={nouvelle.motif} onChange={(e) => setNouvelle({ ...nouvelle, motif: e.target.value })} maxLength={300} />
              </Champ>
              <Champ label="Du">
                <input type="date" value={nouvelle.debut} onChange={(e) => setNouvelle({ ...nouvelle, debut: e.target.value })} />
              </Champ>
              <Champ label="Au">
                <input type="date" value={nouvelle.fin} min={nouvelle.debut} onChange={(e) => setNouvelle({ ...nouvelle, fin: e.target.value })} />
              </Champ>
            </div>
            {nouvelle.ligne.cout !== null && (lireMontant(nouvelle.prix) ?? 0) < nouvelle.ligne.cout && (
              <Champ label="Vente sous le coût de revient : motif de la décision" aide="Réservé au propriétaire">
                <input value={nouvelle.sousCout} onChange={(e) => setNouvelle({ ...nouvelle, sousCout: e.target.value })} required minLength={3} />
              </Champ>
            )}
            <p className="secondaire">Pendant ces dates, la caisse applique ce prix automatiquement ; le bilan mesure les ventes gagnées.</p>
            <button className="bouton bouton-principal">{peut('promotions.valider') ? 'Appliquer la promotion' : 'Proposer la promotion'}</button>
          </form>
        )}
      </Fenetre>

      <Fenetre titre="Réglages du surstock" ouverte={reglages} onFermer={() => setReglages(false)}>
        {param && (
          <form className="formulaire" onSubmit={enregistrerReglages}>
            <div className="grille-2">
              {(
                [
                  ['surstock_jours', 'Surstock au-delà de (jours de vente)'],
                  ['surstock_fort_jours', 'Surstock fort au-delà de (jours)'],
                  ['dormant_jours', 'Dormant sans vente depuis (jours)'],
                  ['peremption_jours', 'Péremption proche sous (jours)'],
                  ['taux_stockage_mois', 'Coût de stockage (% par mois)'],
                  ['remise_surstock', 'Remise surstock (%)'],
                  ['remise_surstock_fort', 'Remise surstock fort / dormant (%)'],
                ] as [keyof Parametres, string][]
              ).map(([k, l]) => (
                <Champ key={k} label={l}>
                  <input type="number" step="0.5" value={param[k]} onChange={(e) => setParam({ ...param, [k]: Number(e.target.value) })} />
                </Champ>
              ))}
            </div>
            <button className="bouton bouton-principal">Enregistrer</button>
          </form>
        )}
      </Fenetre>
    </>
  );
}
