import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { useIdentite } from '../../lib/identite';
import { messageErreur } from '../../lib/format';
import { deviseCourante, enUnites, montant } from '../../lib/argent';
import { quantite, telechargerCsv, useMagasins } from '../../lib/stock';
import { classeurXlsx, telechargerFichier, TYPE_XLSX, type Cellule, type Feuille } from '../../lib/excel';
import { useImpression } from '../../impression/impression';
import { Alerte, Champ, EnTetePage, MontantFort, Vide } from '../../components/ui';
import { RechercheProduit, type ProduitTrouve } from '../../components/RechercheProduit';

type Vue = 'tickets' | 'produits' | 'periodes' | 'paiements';
type Frequence = 'jour' | 'semaine' | 'mois';
type Ligne = Record<string, string | number | null>;

interface Resultat {
  vue: Vue;
  frequence: Frequence;
  debut: string;
  fin: string;
  marges_visibles: boolean;
  lignes: Ligne[];
  totaux: {
    tickets: number;
    chiffre_affaires: number;
    remises: number;
    panier_moyen: number;
    annulations: number;
    total_annulations: number;
    cout?: number;
    marge?: number;
  };
  tronque: boolean;
}

interface Colonne {
  cle: string;
  libelle: string;
  type: 'texte' | 'montant' | 'quantite' | 'date' | 'periode' | 'pourcent' | 'entier';
  /** Colonne de coût ou de marge : affichée seulement si la base l'a renvoyée. */
  marge?: boolean;
  secondaire?: boolean;
  /** Valeur sommée dans la ligne de totaux. */
  total?: boolean;
}

const VUES: { code: Vue; libelle: string; aide: string }[] = [
  { code: 'tickets', libelle: 'Par ticket', aide: 'Chaque vente : numéro, heure, caisse, caissier, paiement.' },
  { code: 'produits', libelle: 'Par produit', aide: 'Quantités vendues et chiffre d’affaires de chaque article.' },
  { code: 'periodes', libelle: 'Par période', aide: 'Évolution jour par jour, semaine par semaine ou mois par mois.' },
  { code: 'paiements', libelle: 'Par paiement', aide: 'Espèces, Wave, Orange Money, carte… encaissé et rendu.' },
];

const COLONNES: Record<Vue, Colonne[]> = {
  tickets: [
    { cle: 'numero', libelle: 'Ticket', type: 'texte' },
    { cle: 'date_vente', libelle: 'Date', type: 'date' },
    { cle: 'magasin', libelle: 'Magasin', type: 'texte', secondaire: true },
    { cle: 'caisse', libelle: 'Caisse', type: 'texte', secondaire: true },
    { cle: 'caissier', libelle: 'Caissier', type: 'texte', secondaire: true },
    { cle: 'client', libelle: 'Client', type: 'texte', secondaire: true },
    { cle: 'paiement', libelle: 'Paiement', type: 'texte' },
    { cle: 'articles', libelle: 'Articles', type: 'quantite', secondaire: true, total: true },
    { cle: 'remises', libelle: 'Remises', type: 'montant', secondaire: true, total: true },
    { cle: 'total', libelle: 'Total', type: 'montant', total: true },
    { cle: 'cout', libelle: 'Coût d’achat', type: 'montant', marge: true, secondaire: true, total: true },
    { cle: 'marge', libelle: 'Marge', type: 'montant', marge: true, total: true },
    { cle: 'statut', libelle: 'Statut', type: 'texte', secondaire: true },
  ],
  produits: [
    { cle: 'code', libelle: 'Code', type: 'texte', secondaire: true },
    { cle: 'designation', libelle: 'Produit', type: 'texte' },
    { cle: 'quantite', libelle: 'Quantité', type: 'quantite', total: true },
    { cle: 'tickets', libelle: 'Tickets', type: 'entier', secondaire: true },
    { cle: 'prix_moyen', libelle: 'Prix moyen', type: 'montant', secondaire: true },
    { cle: 'remises', libelle: 'Remises', type: 'montant', secondaire: true, total: true },
    { cle: 'chiffre_affaires', libelle: 'Chiffre d’affaires', type: 'montant', total: true },
    { cle: 'cout', libelle: 'Coût d’achat', type: 'montant', marge: true, secondaire: true, total: true },
    { cle: 'marge', libelle: 'Marge', type: 'montant', marge: true, total: true },
    { cle: 'taux_marge', libelle: 'Taux de marge', type: 'pourcent', marge: true },
  ],
  periodes: [
    { cle: 'debut', libelle: 'Période', type: 'periode' },
    { cle: 'tickets', libelle: 'Tickets', type: 'entier', total: true },
    { cle: 'chiffre_affaires', libelle: 'Chiffre d’affaires', type: 'montant', total: true },
    { cle: 'panier_moyen', libelle: 'Panier moyen', type: 'montant', secondaire: true },
    { cle: 'remises', libelle: 'Remises', type: 'montant', secondaire: true, total: true },
    { cle: 'annulations', libelle: 'Annulations', type: 'entier', secondaire: true, total: true },
    { cle: 'cout', libelle: 'Coût d’achat', type: 'montant', marge: true, secondaire: true, total: true },
    { cle: 'marge', libelle: 'Marge', type: 'montant', marge: true, total: true },
  ],
  paiements: [
    { cle: 'moyen', libelle: 'Moyen de paiement', type: 'texte' },
    { cle: 'operations', libelle: 'Opérations', type: 'entier', total: true },
    { cle: 'encaisse', libelle: 'Encaissé', type: 'montant', total: true },
    { cle: 'rendu', libelle: 'Rendu', type: 'montant', secondaire: true, total: true },
    { cle: 'net', libelle: 'Net', type: 'montant', total: true },
  ],
};

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function raccourcis(): { libelle: string; du: string; au: string }[] {
  const auj = new Date();
  const a = auj.getFullYear();
  const m = auj.getMonth();
  const lundi = new Date(auj);
  lundi.setDate(auj.getDate() - ((auj.getDay() + 6) % 7));
  return [
    { libelle: 'Aujourd’hui', du: iso(auj), au: iso(auj) },
    { libelle: 'Cette semaine', du: iso(lundi), au: iso(auj) },
    { libelle: 'Ce mois', du: iso(new Date(a, m, 1)), au: iso(auj) },
    { libelle: 'Mois dernier', du: iso(new Date(a, m - 1, 1)), au: iso(new Date(a, m, 0)) },
    { libelle: 'Cette année', du: iso(new Date(a, 0, 1)), au: iso(auj) },
  ];
}

const dateCourte = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString('fr-FR');

function libellePeriode(debut: string, f: Frequence): string {
  const d = new Date(`${debut.slice(0, 10)}T00:00:00`);
  if (f === 'mois') {
    const s = d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  if (f === 'semaine') return `Semaine du ${d.toLocaleDateString('fr-FR')}`;
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Valeur affichée à l'écran et sur le PDF. */
function afficher(c: Colonne, v: string | number | null | undefined, f: Frequence): string {
  if (v === null || v === undefined || v === '') return '';
  switch (c.type) {
    case 'montant':
      return montant(v);
    case 'quantite':
      return quantite(v);
    case 'entier':
      return Number(v).toLocaleString('fr-FR');
    case 'pourcent':
      return `${Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
    case 'date':
      return new Date(String(v)).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    case 'periode':
      return libellePeriode(String(v), f);
    default:
      return c.cle === 'statut' ? (v === 'annulee' ? 'Annulée' : 'Validée') : String(v);
  }
}

/** Valeur écrite dans Excel : nombres en nombres, pour que les sommes fonctionnent. */
function pourExcel(c: Colonne, v: string | number | null | undefined, f: Frequence): Cellule {
  if (v === null || v === undefined || v === '') return '';
  if (c.type === 'montant') return enUnites(v);
  if (c.type === 'quantite' || c.type === 'entier' || c.type === 'pourcent') return Number(v);
  return afficher(c, v, f);
}

function colonnesVisibles(vue: Vue, marges: boolean) {
  return COLONNES[vue].filter((c) => !c.marge || marges);
}

function totauxColonnes(cols: Colonne[], lignes: Ligne[]): (number | null)[] {
  const valides = lignes.filter((l) => l.statut !== 'annulee');
  return cols.map((c) => (c.total ? valides.reduce((s, l) => s + Number(l[c.cle] ?? 0), 0) : null));
}

export function ExtractionVentes() {
  const { organisation, peut } = useSession();
  const { identite } = useIdentite();
  const peutExporter = peut('ventes.exporter') || peut('rapports.exporter');
  const { imprimer } = useImpression();
  const org = organisation!.organisation_id;
  const magasins = useMagasins(org);
  const choix = useMemo(raccourcis, []);
  const [du, setDu] = useState(choix[2]!.du);
  const [au, setAu] = useState(choix[2]!.au);
  const [vue, setVue] = useState<Vue>('produits');
  const [frequence, setFrequence] = useState<Frequence>('jour');
  const [magasin, setMagasin] = useState('');
  const [produit, setProduit] = useState<ProduitTrouve | null>(null);
  const [annulees, setAnnulees] = useState(false);
  const [resultat, setResultat] = useState<Resultat | null>(null);
  const [chargement, setChargement] = useState(false);
  const [exportEnCours, setExportEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  const charger = useCallback(
    async (v: Vue, f: Frequence = frequence) => {
      const { data, error } = await supabase.rpc('extraction_ventes', {
        p_org: org,
        p_debut: du,
        p_fin: au,
        p_vue: v,
        p_frequence: f,
        p_magasin: magasin || null,
        p_produit: produit?.id ?? null,
        p_inclure_annulees: annulees,
      });
      if (error) throw error;
      return data as Resultat;
    },
    [org, du, au, frequence, magasin, produit, annulees],
  );

  useEffect(() => {
    if (!du || !au || du > au) return;
    let actif = true;
    setChargement(true);
    setErreur('');
    charger(vue)
      .then((r) => actif && setResultat(r))
      .catch((e) => actif && setErreur(messageErreur(e)))
      .finally(() => actif && setChargement(false));
    return () => {
      actif = false;
    };
  }, [charger, vue, du, au]);

  const marges = !!resultat?.marges_visibles;
  const cols = colonnesVisibles(vue, marges);
  const lignes = resultat?.vue === vue ? resultat.lignes : [];
  const t = resultat?.totaux;
  const nomMagasin = magasin ? magasins.find((m) => m.id === magasin)?.nom : 'Tous les magasins';
  const libellePeriodeChoisie = du === au ? `le ${dateCourte(du)}` : `du ${dateCourte(du)} au ${dateCourte(au)}`;
  const filtresTexte = [nomMagasin, produit ? `Produit : ${produit.designation}` : '', annulees ? 'Annulations incluses' : '']
    .filter(Boolean)
    .join(' · ');
  const nomFichier = `ventes-${du}-au-${au}`;

  async function exporterExcel() {
    setExportEnCours(true);
    setErreur('');
    try {
      const vues: Vue[] = ['produits', 'periodes', 'tickets', 'paiements'];
      const res = await Promise.all(vues.map((v) => charger(v)));
      const tot = res[0]!.totaux;
      const m = res[0]!.marges_visibles;
      const code = deviseCourante().code;
      const entete = [
        `${identite?.organisation.nom ?? organisation!.nom} — Ventes ${libellePeriodeChoisie}`,
        filtresTexte,
        `Montants en ${code} · extrait le ${new Date().toLocaleString('fr-FR')}`,
      ];
      const synthese: Feuille = {
        nom: 'Synthèse',
        titre: entete,
        entetes: ['Indicateur', 'Valeur'],
        lignes: [
          ['Tickets', tot.tickets],
          ['Chiffre d’affaires', enUnites(tot.chiffre_affaires)],
          ['Panier moyen', enUnites(tot.panier_moyen)],
          ['Remises accordées', enUnites(tot.remises)],
          ['Ventes annulées (nombre)', tot.annulations],
          ['Ventes annulées (montant)', enUnites(tot.total_annulations)],
          ...(m
            ? ([
                ['Coût d’achat des articles vendus', enUnites(tot.cout ?? 0)],
                ['Marge brute', enUnites(tot.marge ?? 0)],
                ['Taux de marge (%)', tot.chiffre_affaires ? Math.round((1000 * (tot.marge ?? 0)) / tot.chiffre_affaires) / 10 : 0],
              ] as Cellule[][])
            : []),
        ],
        largeurs: [36, 18],
      };
      const feuilles: Feuille[] = [
        synthese,
        ...vues.map((v, i) => {
          const r = res[i]!;
          const c = colonnesVisibles(v, r.marges_visibles);
          const tl = totauxColonnes(c, r.lignes);
          return {
            nom: VUES.find((x) => x.code === v)!.libelle.replace('Par ', '').replace(/^./, (x) => x.toUpperCase()),
            titre: [entete[0]!, v === 'periodes' ? `Regroupement : ${r.frequence}` : VUES.find((x) => x.code === v)!.aide],
            entetes: c.map((x) => x.libelle),
            lignes: r.lignes.map((l) => c.map((x) => pourExcel(x, l[x.cle], r.frequence))),
            totaux: c.map((x, j) => (j === 0 ? 'Total' : tl[j] === null ? '' : x.type === 'montant' ? enUnites(tl[j]) : tl[j])),
          } satisfies Feuille;
        }),
      ];
      const ok = telechargerFichier(`${nomFichier}.xlsx`, TYPE_XLSX, classeurXlsx(feuilles));
      if (!ok) {
        // Ancienne version de l'application Android : export CSV de la vue affichée.
        telechargerCsv(
          `${nomFichier}-${vue}.csv`,
          cols.map((c) => c.libelle),
          lignes.map((l) => cols.map((c) => pourExcel(c, l[c.cle], frequence) as string | number)),
        );
      }
    } catch (e) {
      setErreur(messageErreur(e));
    } finally {
      setExportEnCours(false);
    }
  }

  async function exporterPdf() {
    if (!resultat) return;
    const tl = totauxColonnes(cols, lignes);
    // Sur papier, on garde les colonnes principales pour tenir dans la largeur A4.
    const colsPdf = cols.length > 8 ? cols.filter((c) => !c.secondaire || c.marge) : cols;
    const tlPdf = colsPdf.map((c) => tl[cols.indexOf(c)] ?? null);
    await imprimer(
      <div className="rapport-a4">
        <header className="rapport-entete">
          <div>
            <strong>{identite?.organisation.nom ?? organisation!.nom}</strong>
            <h1>Ventes {VUES.find((v) => v.code === vue)!.libelle.toLowerCase()}</h1>
            <p>
              {libellePeriodeChoisie}
              {vue === 'periodes' ? ` · par ${frequence}` : ''} · {filtresTexte}
            </p>
          </div>
          {identite?.logoUrl && <img src={identite.logoUrl} alt="" />}
        </header>
        <div className="rapport-tuiles">
          <div><span>Chiffre d’affaires</span><strong>{montant(resultat.totaux.chiffre_affaires)}</strong></div>
          <div><span>Tickets</span><strong>{resultat.totaux.tickets}</strong></div>
          <div><span>Panier moyen</span><strong>{montant(resultat.totaux.panier_moyen)}</strong></div>
          {marges && <div><span>Marge brute</span><strong>{montant(resultat.totaux.marge ?? 0)}</strong></div>}
        </div>
        <table className="rapport-tableau">
          <thead>
            <tr>{colsPdf.map((c) => <th key={c.cle} className={c.type === 'texte' || c.type === 'date' || c.type === 'periode' ? '' : 'nombre'}>{c.libelle}</th>)}</tr>
          </thead>
          <tbody>
            {lignes.map((l, i) => (
              <tr key={i}>
                {colsPdf.map((c) => <td key={c.cle} className={c.type === 'texte' || c.type === 'date' || c.type === 'periode' ? '' : 'nombre'}>{afficher(c, l[c.cle], frequence)}</td>)}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              {colsPdf.map((c, j) => (
                <td key={c.cle} className={j === 0 ? '' : 'nombre'}>{j === 0 ? 'Total' : tlPdf[j] === null ? '' : afficher(c, tlPdf[j], frequence)}</td>
              ))}
            </tr>
          </tfoot>
        </table>
        <footer className="rapport-pied">Extrait le {new Date().toLocaleString('fr-FR')} · DF Gestion</footer>
      </div>,
      'a4',
    );
  }

  const tl = totauxColonnes(cols, lignes);
  const aligne = (c: Colonne) => (c.type === 'texte' || c.type === 'date' || c.type === 'periode' ? '' : 'nombre');

  return (
    <>
      <EnTetePage
        icone="📊"
        titre="Extraction des ventes"
        sousTitre="Choisissez une période et une présentation, puis exportez en Excel ou en PDF."
        actions={
          <>
            {peutExporter && (
              <>
                <button className="bouton bouton-discret" onClick={() => void exporterPdf()} disabled={!lignes.length}>
                  PDF
                </button>
                <button className="bouton" onClick={() => void exporterExcel()} disabled={!resultat || exportEnCours}>
                  {exportEnCours ? 'Préparation…' : 'Excel'}
                </button>
              </>
            )}
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      <section className="carte">
        <div className="raccourcis-periode">
          {choix.map((c) => (
            <button
              key={c.libelle}
              type="button"
              className={`puce ${du === c.du && au === c.au ? 'puce-active' : ''}`}
              onClick={() => {
                setDu(c.du);
                setAu(c.au);
              }}
            >
              {c.libelle}
            </button>
          ))}
        </div>
        <div className="filtres">
          <Champ label="Du">
            <input type="date" value={du} max={au} onChange={(e) => setDu(e.target.value)} />
          </Champ>
          <Champ label="Au">
            <input type="date" value={au} min={du} onChange={(e) => setAu(e.target.value)} />
          </Champ>
          <Champ label="Magasin">
            <select value={magasin} onChange={(e) => setMagasin(e.target.value)}>
              <option value="">Tous</option>
              {magasins.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nom}
                </option>
              ))}
            </select>
          </Champ>
          <div className="champ filtre-produit">
            <span className="champ-label">Produit</span>
            {produit ? (
              <div className="produit-choisi produit-choisi-compact">
                <strong>{produit.designation}</strong>
                <button type="button" className="bouton-lien" onClick={() => setProduit(null)}>
                  Retirer
                </button>
              </div>
            ) : (
              <RechercheProduit org={org} onChoisir={setProduit} placeholder="Tous les produits" />
            )}
          </div>
        </div>
        <div className="onglets onglets-compacts onglets-vue" role="tablist">
          {VUES.map((v) => (
            <button key={v.code} type="button" role="tab" aria-selected={vue === v.code} className={vue === v.code ? 'actif' : ''} onClick={() => setVue(v.code)}>
              {v.libelle}
            </button>
          ))}
        </div>
        <p className="secondaire">{VUES.find((v) => v.code === vue)!.aide}</p>
        <div className="filtres-ligne">
          {vue === 'periodes' && (
            <Champ label="Regrouper par">
              <select value={frequence} onChange={(e) => setFrequence(e.target.value as Frequence)}>
                <option value="jour">Jour</option>
                <option value="semaine">Semaine</option>
                <option value="mois">Mois</option>
              </select>
            </Champ>
          )}
          {(vue === 'tickets' || vue === 'periodes') && (
            <label className="case">
              <input type="checkbox" checked={annulees} onChange={(e) => setAnnulees(e.target.checked)} /> Inclure les ventes annulées
            </label>
          )}
        </div>
      </section>

      {t && (
        <section className="tuiles">
          <div className="tuile tuile-fixe">
            <span className="tuile-valeur"><MontantFort v={t.chiffre_affaires} /></span>
            <span className="tuile-libelle">Chiffre d’affaires</span>
          </div>
          <div className="tuile tuile-fixe">
            <span className="tuile-valeur">{t.tickets.toLocaleString('fr-FR')}</span>
            <span className="tuile-libelle">Tickets</span>
          </div>
          <div className="tuile tuile-fixe">
            <span className="tuile-valeur"><MontantFort v={t.panier_moyen} /></span>
            <span className="tuile-libelle">Panier moyen</span>
          </div>
          {marges ? (
            <div className="tuile tuile-fixe">
              <span className="tuile-valeur"><MontantFort v={t.marge ?? 0} /></span>
              <span className="tuile-libelle">Marge brute{t.chiffre_affaires ? ` (${Math.round((1000 * (t.marge ?? 0)) / t.chiffre_affaires) / 10} %)` : ''}</span>
            </div>
          ) : (
            <div className="tuile tuile-fixe">
              <span className="tuile-valeur"><MontantFort v={t.remises} /></span>
              <span className="tuile-libelle">Remises</span>
            </div>
          )}
        </section>
      )}

      <section className="carte">
        {resultat?.tronque && <Alerte type="info">Plus de 20 000 tickets : seuls les 20 000 premiers sont affichés. Réduisez la période.</Alerte>}
        {chargement && !lignes.length ? (
          <Vide>Calcul en cours…</Vide>
        ) : lignes.length === 0 ? (
          <Vide>Aucune vente pour ces critères.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau tableau-compact">
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c.cle} className={`${aligne(c)} ${c.secondaire ? 'col-secondaire' : ''}`}>
                      {c.libelle}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lignes.slice(0, 500).map((l, i) => (
                  <tr key={i} className={l.statut === 'annulee' ? 'ligne-annulee' : ''}>
                    {cols.map((c) => (
                      <td key={c.cle} className={`${aligne(c)} ${c.secondaire ? 'col-secondaire' : ''} ${c.cle === 'marge' && Number(l[c.cle]) < 0 ? 'texte-negatif' : ''}`}>
                        {afficher(c, l[c.cle], frequence)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="ligne-total">
                  {cols.map((c, j) => (
                    <td key={c.cle} className={`${j === 0 ? '' : 'nombre'} ${c.secondaire ? 'col-secondaire' : ''}`}>
                      {j === 0 ? 'Total' : tl[j] === null ? '' : afficher(c, tl[j], frequence)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
            {lignes.length > 500 && <p className="secondaire">500 premières lignes affichées sur {lignes.length.toLocaleString('fr-FR')} — l’export Excel contient tout.</p>}
          </div>
        )}
        {!marges && resultat && (
          <p className="secondaire">Le coût d’achat et la marge ne s’affichent qu’au niveau « Valider » du module Extraction des ventes.</p>
        )}
      </section>
    </>
  );
}
