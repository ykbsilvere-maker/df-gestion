import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { clavierMontant, lireMontant, montant } from '../../lib/argent';
import { aujourdhui, dateFr, useComptes } from '../../lib/tresorerie';
import { Alerte, Champ, EnTetePage, Fenetre, MontantFort, Pastille, Vide } from '../../components/ui';
import { useDemandeCreation } from '../../lib/demande';

interface LigneSuivi {
  poste_id: string;
  libelle: string;
  compte_syscohada: string | null;
  nature: 'fixe' | 'variable';
  actif: boolean;
  prevu: number;
  reel: number;
  ecart: number;
  taux: number | null;
  alerte: 'ok' | 'attention' | 'depasse' | 'hors_budget';
  depassement: number;
  date_prevue: string | null;
  commentaire: string | null;
  date_realisation: string | null;
  derniere_depense: string | null;
  nb_depenses: number;
  jours_decalage: number | null;
  statut: StatutRealisation;
  depenses: { id: string; date: string; montant: number; libelle: string | null; beneficiaire: string | null; reference: string | null }[];
}
type StatutRealisation = 'realise' | 'depasse' | 'hors_budget' | 'en_cours' | 'en_retard' | 'non_realise' | 'a_venir' | 'sans_objet';
interface BilanAnnee {
  annee: number;
  mois: { mois: string; statut_budget: string | null; prevu: number; reel: number; depassement: number }[];
  postes: { poste_id: string; libelle: string; prevu: number; reel: number; depassement: number; mois_realises: number; mois_depasses: number; mois_non_realises: number }[];
}
interface Suivi {
  mois: string;
  budget: { id: string; statut: 'brouillon' | 'valide'; version: number; valide_le: string | null; motif_revision: string | null } | null;
  lignes: LigneSuivi[];
  totaux: { prevu: number; reel: number; depassement?: number; postes_prevus?: number; realises?: number; depasses?: number; en_retard?: number; a_venir?: number };
}
interface Depense {
  id: string;
  date_depense: string;
  poste_id: string;
  compte_id: string;
  montant: number;
  libelle: string | null;
  beneficiaire: string | null;
  reference: string | null;
  statut: 'enregistree' | 'annulee';
  motif_annulation: string | null;
}

const moisCourant = () => aujourdhui().slice(0, 7);
const premierJour = (m: string) => `${m}-01`;
const moisPrecedent = (m: string) => {
  const [a, mm] = m.split('-').map(Number) as [number, number];
  const d = new Date(a, mm - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const libelleMois = (m: string) => {
  const s = new Date(`${m}-01T00:00:00`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const STATUTS: Record<StatutRealisation, { ton: 'vert' | 'gris' | 'or' | 'rouge'; libelle: string } | null> = {
  realise: { ton: 'vert', libelle: '✅ Réalisé' },
  depasse: { ton: 'rouge', libelle: '🔴 Dépassé' },
  hors_budget: { ton: 'rouge', libelle: '🔴 Hors budget' },
  en_cours: { ton: 'or', libelle: '◐ En cours' },
  en_retard: { ton: 'or', libelle: '⚠️ En retard' },
  non_realise: { ton: 'gris', libelle: '✗ Non réalisé' },
  a_venir: { ton: 'gris', libelle: '⏳ À venir' },
  sans_objet: null,
};
const NOMS_MOIS = ['Janv.', 'Févr.', 'Mars', 'Avr.', 'Mai', 'Juin', 'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.'];
/** Même jour dans un autre mois (borné à la fin du mois). */
const memeJour = (iso: string, mois: string) => {
  const [a, m] = mois.split('-').map(Number) as [number, number];
  const fin = new Date(a, m, 0).getDate();
  return `${mois}-${String(Math.min(Number(iso.slice(8, 10)), fin)).padStart(2, '0')}`;
};
const decalage = (j: number | null) =>
  j === null ? '' : j === 0 ? ' · à la date prévue' : j > 0 ? ` · ${j} j de retard` : ` · ${-j} j d’avance`;

const ALERTES = {
  ok: { ton: 'vert', libelle: 'Dans le budget' },
  attention: { ton: 'or', libelle: '80 % atteints' },
  depasse: { ton: 'rouge', libelle: 'Dépassé' },
  hors_budget: { ton: 'rouge', libelle: 'Hors budget' },
} as const;

export function Budget() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const { comptes } = useComptes(org);
  const [mois, setMois] = useState(moisCourant);
  const [suivi, setSuivi] = useState<Suivi | null>(null);
  const [saisie, setSaisie] = useState<Record<string, string>>({});
  const [dates, setDates] = useState<Record<string, string>>({});
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [vue, setVue] = useState<'mois' | 'annee'>('mois');
  const [bilan, setBilan] = useState<BilanAnnee | null>(null);
  useDemandeCreation(!!suivi && comptes.length > 0 && peut('budget.creer'), () =>
    setNouvelle({ date: aujourdhui(), poste: suivi?.lignes.find((p) => p.actif)?.poste_id ?? '', compte: comptes[0]?.id ?? '', montant: '' }),
  );
  const [depenses, setDepenses] = useState<Depense[]>([]);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [nouvelle, setNouvelle] = useState<Record<string, string> | null>(null);

  const charger = useCallback(async () => {
    setErreur('');
    const fin = new Date(`${mois}-01T00:00:00`);
    fin.setMonth(fin.getMonth() + 1);
    const finIso = `${fin.getFullYear()}-${String(fin.getMonth() + 1).padStart(2, '0')}-01`;
    const [a, b] = await Promise.all([
      supabase.rpc('suivi_budget', { p_org: org, p_mois: premierJour(mois) }),
      supabase
        .from('depenses')
        .select('*')
        .eq('organisation_id', org)
        .gte('date_depense', premierJour(mois))
        .lt('date_depense', finIso)
        .order('date_depense', { ascending: false }),
    ]);
    if (a.error) return setErreur(messageErreur(a.error));
    const s = a.data as Suivi;
    setSuivi(s);
    setSaisie(Object.fromEntries(s.lignes.map((l) => [l.poste_id, Number(l.prevu) ? montant(l.prevu, '') : ''])));
    setDates(Object.fromEntries(s.lignes.map((l) => [l.poste_id, l.date_prevue ?? ''])));
    setDepenses((b.data ?? []) as Depense[]);
  }, [org, mois]);
  useEffect(() => {
    void charger();
  }, [charger]);
  useEffect(() => {
    if (vue !== 'annee') return;
    void supabase.rpc('bilan_budget', { p_org: org, p_annee: Number(mois.slice(0, 4)) }).then(({ data, error }) => {
      if (error) setErreur(messageErreur(error));
      else setBilan(data as BilanAnnee);
    });
  }, [vue, org, mois]);

  const brouillon = !suivi?.budget || suivi.budget.statut === 'brouillon';
  const peutSaisir = brouillon && peut('budget.creer');
  const totalSaisi = useMemo(
    () => Object.values(saisie).reduce((t, v) => t + (lireMontant(v) ?? 0), 0),
    [saisie],
  );
  const modifie = useMemo(
    () =>
      !!suivi &&
      suivi.lignes.some(
        (l) => (lireMontant(saisie[l.poste_id] ?? '') ?? 0) !== Number(l.prevu) || (dates[l.poste_id] ?? '') !== (l.date_prevue ?? ''),
      ),
    [suivi, saisie, dates],
  );

  async function enregistrer() {
    if (!suivi) return;
    setOccupe(true);
    setErreur('');
    const { error } = await supabase.rpc('enregistrer_budget', {
      p_org: org,
      p_mois: premierJour(mois),
      p_lignes: suivi.lignes.map((l) => ({
        poste_id: l.poste_id,
        montant: lireMontant(saisie[l.poste_id] ?? '') ?? 0,
        date_prevue: dates[l.poste_id] || null,
        commentaire: l.commentaire,
      })),
    });
    setOccupe(false);
    if (error) return setErreur(messageErreur(error));
    setInfo('Budget enregistré (brouillon).');
    await charger();
  }

  async function reprendre() {
    const { data, error } = await supabase.rpc('suivi_budget', { p_org: org, p_mois: premierJour(moisPrecedent(mois)) });
    if (error) return setErreur(messageErreur(error));
    const prec = data as Suivi;
    if (!prec.budget) return setErreur(`Aucun budget en ${libelleMois(moisPrecedent(mois)).toLowerCase()}.`);
    setSaisie((s) => ({ ...s, ...Object.fromEntries(prec.lignes.map((l) => [l.poste_id, Number(l.prevu) ? montant(l.prevu, '') : ''])) }));
    setDates((d) => ({ ...d, ...Object.fromEntries(prec.lignes.map((l) => [l.poste_id, l.date_prevue ? memeJour(l.date_prevue, mois) : ''])) }));
    setInfo('Montants du mois précédent repris : vérifiez puis enregistrez.');
  }

  async function valider() {
    if (!suivi?.budget) return;
    if (modifie) return setErreur('Enregistrez d’abord vos changements.');
    if (!window.confirm(`Valider le budget de ${libelleMois(mois).toLowerCase()} ? Il sera figé ; toute modification passera par une révision.`)) return;
    const { error } = await supabase.rpc('valider_budget', { p_budget: suivi.budget.id });
    if (error) return setErreur(messageErreur(error));
    setInfo('Budget validé et figé.');
    await charger();
  }

  async function reviser() {
    if (!suivi?.budget) return;
    const motif = window.prompt('Motif de la révision (gardé dans le journal)');
    if (!motif?.trim()) return;
    const { error } = await supabase.rpc('reviser_budget', { p_budget: suivi.budget.id, p_motif: motif.trim() });
    if (error) return setErreur(messageErreur(error));
    setInfo('Révision ouverte : modifiez les montants, enregistrez puis validez à nouveau.');
    await charger();
  }

  async function ajouterPoste() {
    const libelle = window.prompt('Nom du nouveau poste (ex. Gardiennage)');
    if (!libelle?.trim()) return;
    const compte = window.prompt('Compte SYSCOHADA (facultatif, ex. 6241)') ?? '';
    const { error } = await supabase.from('postes_budget').insert({
      organisation_id: org,
      libelle: libelle.trim(),
      compte_syscohada: compte.trim() || null,
      ordre: 50,
    });
    if (error) return setErreur(/duplicate/.test(error.message) ? 'Ce poste existe déjà.' : messageErreur(error));
    await charger();
  }

  async function enregistrerDepense(e: FormEvent) {
    e.preventDefault();
    if (!nouvelle) return;
    const m = lireMontant(nouvelle.montant ?? '');
    if (!m || m <= 0) return setErreur('Indiquez le montant.');
    const { error } = await supabase.rpc('enregistrer_depense', {
      p_org: org,
      p_date: nouvelle.date,
      p_poste: nouvelle.poste,
      p_compte: nouvelle.compte,
      p_montant: m,
      p_libelle: nouvelle.libelle || null,
      p_beneficiaire: nouvelle.beneficiaire || null,
      p_reference: nouvelle.reference || null,
    });
    if (error) return setErreur(messageErreur(error));
    setNouvelle(null);
    setInfo('Dépense enregistrée : elle sort du compte choisi en trésorerie.');
    await charger();
  }

  async function annulerDepense(d: Depense) {
    const motif = window.prompt('Motif de l’annulation');
    if (!motif?.trim()) return;
    const { error } = await supabase.rpc('annuler_depense', { p_depense: d.id, p_motif: motif.trim() });
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

  const t = suivi?.totaux ?? { prevu: 0, reel: 0 };
  const finMois = (() => {
    const [a, m] = mois.split('-').map(Number) as [number, number];
    return `${mois}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}`;
  })();
  const maxBilan = Math.max(1, ...(bilan?.mois ?? []).map((m) => Math.max(Number(m.prevu), Number(m.reel))));
  const taux = t.prevu ? Math.round((100 * t.reel) / t.prevu) : 0;
  const postes = suivi?.lignes ?? [];

  return (
    <>
      <EnTetePage
        icone="📒"
        titre="Budget du mois"
        sousTitre="Saisissez les charges prévues, validez, puis suivez chaque jour le réel face au prévu."
        actions={
          peut('budget.creer') && (
            <button
              className="bouton bouton-principal"
              onClick={() =>
                setNouvelle({ date: aujourdhui(), poste: postes.find((p) => p.actif)?.poste_id ?? '', compte: comptes[0]?.id ?? '', montant: '' })
              }
            >
              Nouvelle dépense
            </button>
          )
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      <section className="carte">
        <div className="filtres-ligne">
          <Champ label="Mois">
            <input type="month" value={mois} onChange={(e) => e.target.value && setMois(e.target.value)} />
          </Champ>
          <div className="etat-budget">
            {!suivi?.budget ? (
              <Pastille ton="gris">Pas encore de budget</Pastille>
            ) : suivi.budget.statut === 'valide' ? (
              <Pastille ton="vert">Validé le {dateFr(suivi.budget.valide_le)} · version {suivi.budget.version}</Pastille>
            ) : (
              <Pastille ton="or">Brouillon · version {suivi.budget.version}</Pastille>
            )}
            {suivi?.budget?.motif_revision && <span className="secondaire">Révision : {suivi.budget.motif_revision}</span>}
          </div>
        </div>
      </section>

      <nav className="onglets-pilules" role="tablist" aria-label="Vue du budget">
        <button type="button" role="tab" aria-selected={vue === 'mois'} className={vue === 'mois' ? 'actif' : ''} onClick={() => setVue('mois')}>
          Prévu / réalisé du mois
        </button>
        <button type="button" role="tab" aria-selected={vue === 'annee'} className={vue === 'annee' ? 'actif' : ''} onClick={() => setVue('annee')}>
          Bilan de l’année {mois.slice(0, 4)}
        </button>
      </nav>

      {vue === 'annee' && (
        <BilanAnnuel bilan={bilan} maxBilan={maxBilan} onMois={(m) => { setMois(m.slice(0, 7)); setVue('mois'); }} />
      )}

      {vue === 'mois' && (
      <>
      <section className="tuiles">
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur"><MontantFort v={t.prevu} /></span>
          <span className="tuile-libelle">prévu</span>
        </div>
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur"><MontantFort v={t.reel} /></span>
          <span className="tuile-libelle">réalisé ({taux} %)</span>
        </div>
        <div className={`tuile tuile-fixe ${t.reel > t.prevu && t.prevu > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur"><MontantFort v={t.prevu - t.reel} /></span>
          <span className="tuile-libelle">{t.reel > t.prevu ? 'dépassement global' : 'reste à dépenser'}</span>
        </div>
        <div className={`tuile tuile-fixe ${Number(t.depassement ?? 0) > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur"><MontantFort v={t.depassement ?? 0} /></span>
          <span className="tuile-libelle">dépassements ({t.depasses ?? 0} poste{(t.depasses ?? 0) > 1 ? 's' : ''})</span>
        </div>
      </section>
      <section className="resume-realisation">
        <Pastille ton="vert">{t.realises ?? 0} / {t.postes_prevus ?? 0} postes réalisés</Pastille>
        {(t.en_retard ?? 0) > 0 && <Pastille ton="or">{t.en_retard} en retard ou non réalisé{(t.en_retard ?? 0) > 1 ? 's' : ''}</Pastille>}
        {(t.a_venir ?? 0) > 0 && <Pastille ton="gris">{t.a_venir} à venir ou en cours</Pastille>}
      </section>

      <section className="carte">
        <div className="defilement-horizontal">
          <table className="tableau">
            <thead>
              <tr>
                <th>Poste</th>
                <th>Date prévue</th>
                <th className="nombre">Prévu</th>
                <th className="nombre">Réalisé</th>
                <th className="nombre col-secondaire">Écart</th>
                <th>Réalisation</th>
              </tr>
            </thead>
            <tbody>
              {postes.map((l) => {
                const pct = l.taux === null ? (Number(l.reel) > 0 ? 100 : 0) : Math.min(100, Number(l.taux));
                const st = STATUTS[l.statut ?? 'sans_objet'];
                const detail = ouvert === l.poste_id;
                return (
                  <Fragment key={l.poste_id}>
                    <tr className={`${l.actif ? '' : 'ligne-inactive'} ${l.nb_depenses ? 'ligne-cliquable' : ''}`} onClick={() => l.nb_depenses && setOuvert(detail ? null : l.poste_id)}>
                      <td>
                        <strong>{l.libelle}</strong>
                        <div className="secondaire">
                          {l.compte_syscohada ? `Compte ${l.compte_syscohada}` : ''}
                          {l.nature === 'fixe' ? ' · fixe' : ''}
                          {l.nb_depenses ? ` · ${l.nb_depenses} dépense${l.nb_depenses > 1 ? 's' : ''} ${detail ? '▴' : '▾'}` : ''}
                        </div>
                      </td>
                      <td onClick={(e) => peutSaisir && e.stopPropagation()}>
                        {peutSaisir ? (
                          <input
                            type="date"
                            className="champ-date-compact"
                            value={dates[l.poste_id] ?? ''}
                            min={premierJour(mois)}
                            max={finMois}
                            onChange={(e) => setDates({ ...dates, [l.poste_id]: e.target.value })}
                            aria-label={`Date prévue ${l.libelle}`}
                          />
                        ) : (
                          <>
                            {l.date_prevue ? dateFr(l.date_prevue) : '—'}
                            {l.date_realisation && (
                              <div className="secondaire">
                                fait le {dateFr(l.date_realisation)}
                                {decalage(l.jours_decalage)}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="nombre" onClick={(e) => peutSaisir && e.stopPropagation()}>
                        {peutSaisir ? (
                          <input
                            className="champ-nombre champ-prix"
                            inputMode={clavierMontant()}
                            value={saisie[l.poste_id] ?? ''}
                            placeholder="0"
                            onChange={(e) => setSaisie({ ...saisie, [l.poste_id]: e.target.value })}
                            aria-label={`Prévu ${l.libelle}`}
                          />
                        ) : (
                          montant(l.prevu)
                        )}
                      </td>
                      <td className="nombre">{montant(l.reel)}</td>
                      <td className={`nombre col-secondaire ${Number(l.ecart) < 0 ? 'texte-negatif' : ''}`}>
                        {montant(l.ecart)}
                        {Number(l.depassement) > 0 && Number(l.prevu) > 0 && (
                          <div className="secondaire texte-negatif">+{Math.round((100 * Number(l.depassement)) / Number(l.prevu))} %</div>
                        )}
                      </td>
                      <td>
                        {(Number(l.prevu) > 0 || Number(l.reel) > 0) && (
                          <div className="jauge-ligne">
                            <div className={`jauge jauge-${l.alerte}`}>
                              <span style={{ width: `${pct}%` }} />
                            </div>
                            {st ? (
                              <Pastille ton={st.ton}>{st.libelle}</Pastille>
                            ) : (
                              <Pastille ton={ALERTES[l.alerte].ton}>{ALERTES[l.alerte].libelle}</Pastille>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                    {detail && (
                      <tr className="ligne-detail">
                        <td colSpan={6}>
                          <table className="tableau tableau-compact">
                            <tbody>
                              {l.depenses.map((d) => (
                                <tr key={d.id}>
                                  <td>{dateFr(d.date)}</td>
                                  <td>{[d.libelle, d.beneficiaire, d.reference].filter(Boolean).join(' · ') || '—'}</td>
                                  <td className="nombre">{montant(d.montant)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="ligne-total">
                <td>Total</td>
                <td />
                <td className="nombre">{montant(peutSaisir ? totalSaisi : t.prevu)}</td>
                <td className="nombre">{montant(t.reel)}</td>
                <td className="nombre col-secondaire">{montant((peutSaisir ? totalSaisi : t.prevu) - t.reel)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="actions-piece">
          {peut('budget.modifier') && (
            <button className="bouton-lien" onClick={() => void ajouterPoste()}>
              + Ajouter un poste
            </button>
          )}
          {peutSaisir && (
            <button className="bouton bouton-discret" onClick={() => void reprendre()}>
              Reprendre le mois précédent
            </button>
          )}
          {peutSaisir && (
            <button className="bouton" disabled={occupe || !modifie} onClick={() => void enregistrer()}>
              Enregistrer
            </button>
          )}
          {brouillon && suivi?.budget && peut('budget.valider') && (
            <button className="bouton bouton-principal" onClick={() => void valider()}>
              Valider le budget
            </button>
          )}
          {!brouillon && peut('budget.valider') && (
            <button className="bouton bouton-discret" onClick={() => void reviser()}>
              Réviser
            </button>
          )}
        </div>
      </section>

      <section className="carte">
        <h2>Dépenses de {libelleMois(mois).toLowerCase()}</h2>
        {depenses.length === 0 ? (
          <Vide>Aucune dépense ce mois-ci.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Poste</th>
                  <th className="col-secondaire">Détail</th>
                  <th>Payé depuis</th>
                  <th className="nombre">Montant</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {depenses.map((d) => (
                  <tr key={d.id} className={d.statut === 'annulee' ? 'ligne-annulee' : ''}>
                    <td>{dateFr(d.date_depense)}</td>
                    <td>{postes.find((p) => p.poste_id === d.poste_id)?.libelle ?? '—'}</td>
                    <td className="col-secondaire">
                      {[d.libelle, d.beneficiaire, d.reference].filter(Boolean).join(' · ') || '—'}
                      {d.motif_annulation && <div className="secondaire">Annulée : {d.motif_annulation}</div>}
                    </td>
                    <td>{comptes.find((c) => c.id === d.compte_id)?.nom ?? '—'}</td>
                    <td className="nombre">{montant(d.montant)}</td>
                    <td>
                      {d.statut === 'enregistree' && peut('budget.valider') && (
                        <button className="bouton-lien lien-danger" onClick={() => void annulerDepense(d)}>
                          Annuler
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

      </>
      )}

      <Fenetre titre="Nouvelle dépense" ouverte={!!nouvelle} onFermer={() => setNouvelle(null)}>
        {nouvelle && (
          <form className="formulaire" onSubmit={enregistrerDepense}>
            <Alerte>{erreur}</Alerte>
            <div className="grille-2">
              <Champ label="Poste">
                <select value={nouvelle.poste} onChange={(e) => setNouvelle({ ...nouvelle, poste: e.target.value })} required>
                  {postes
                    .filter((p) => p.actif)
                    .map((p) => (
                      <option key={p.poste_id} value={p.poste_id}>
                        {p.libelle}
                      </option>
                    ))}
                </select>
              </Champ>
              <Champ label="Montant">
                <input value={nouvelle.montant} onChange={(e) => setNouvelle({ ...nouvelle, montant: e.target.value })} inputMode={clavierMontant()} required autoFocus />
              </Champ>
              <Champ label="Date">
                <input type="date" value={nouvelle.date} max={aujourdhui()} onChange={(e) => setNouvelle({ ...nouvelle, date: e.target.value })} />
              </Champ>
              <Champ label="Payé depuis">
                <select value={nouvelle.compte} onChange={(e) => setNouvelle({ ...nouvelle, compte: e.target.value })} required>
                  {comptes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nom}
                    </option>
                  ))}
                </select>
              </Champ>
              <Champ label="Détail">
                <input value={nouvelle.libelle ?? ''} onChange={(e) => setNouvelle({ ...nouvelle, libelle: e.target.value })} placeholder="Facture CIE octobre" maxLength={120} />
              </Champ>
              <Champ label="Bénéficiaire">
                <input value={nouvelle.beneficiaire ?? ''} onChange={(e) => setNouvelle({ ...nouvelle, beneficiaire: e.target.value })} maxLength={80} />
              </Champ>
              <Champ label="Référence" aide="N° de facture, de transaction…">
                <input value={nouvelle.reference ?? ''} onChange={(e) => setNouvelle({ ...nouvelle, reference: e.target.value })} maxLength={60} />
              </Champ>
            </div>
            <button className="bouton bouton-principal">Enregistrer la dépense</button>
          </form>
        )}
      </Fenetre>
    </>
  );
}

function BilanAnnuel({ bilan, maxBilan, onMois }: { bilan: BilanAnnee | null; maxBilan: number; onMois: (m: string) => void }) {
  if (!bilan) return <Vide>Calcul du bilan…</Vide>;
  const tp = bilan.mois.reduce((s, m) => s + Number(m.prevu), 0);
  const tr = bilan.mois.reduce((s, m) => s + Number(m.reel), 0);
  const td = bilan.mois.reduce((s, m) => s + Number(m.depassement), 0);
  return (
    <>
      <section className="tuiles">
        <div className="tuile tuile-fixe"><span className="tuile-valeur"><MontantFort v={tp} /></span><span className="tuile-libelle">prévu sur l’année</span></div>
        <div className="tuile tuile-fixe"><span className="tuile-valeur"><MontantFort v={tr} /></span><span className="tuile-libelle">réalisé ({tp ? Math.round((100 * tr) / tp) : 0} %)</span></div>
        <div className={`tuile tuile-fixe ${td > 0 ? 'tuile-alerte' : ''}`}><span className="tuile-valeur"><MontantFort v={td} /></span><span className="tuile-libelle">dépassements cumulés</span></div>
      </section>
      <section className="carte">
        <h2>Prévu et réalisé, mois par mois</h2>
        <div className="histo-budget" role="img" aria-label="Histogramme du prévu et du réalisé par mois">
          {bilan.mois.map((m, i) => (
            <button key={m.mois} type="button" className="histo-mois" onClick={() => onMois(m.mois)} title={`${NOMS_MOIS[i]} : prévu ${montant(m.prevu)}, réalisé ${montant(m.reel)}`}>
              <div className="histo-barres">
                <span className="barre-prevu" style={{ height: `${(100 * Number(m.prevu)) / maxBilan}%` }} />
                <span className={`barre-reel ${Number(m.depassement) > 0 ? 'depasse' : ''}`} style={{ height: `${(100 * Number(m.reel)) / maxBilan}%` }} />
              </div>
              <span className="histo-libelle">{NOMS_MOIS[i]}</span>
            </button>
          ))}
        </div>
        <p className="legende-histo secondaire">
          <span className="puce barre-prevu" /> prévu <span className="puce barre-reel" /> réalisé <span className="puce barre-reel depasse" /> mois avec dépassement · touchez un mois pour l’ouvrir
        </p>
        <div className="defilement-horizontal">
          <table className="tableau tableau-compact">
            <thead><tr><th>Mois</th><th>Budget</th><th className="nombre">Prévu</th><th className="nombre">Réalisé</th><th className="nombre">Écart</th><th className="nombre">Dépassements</th></tr></thead>
            <tbody>
              {bilan.mois.map((m, i) => (
                <tr key={m.mois} className="ligne-cliquable" onClick={() => onMois(m.mois)}>
                  <td>{NOMS_MOIS[i]}</td>
                  <td>{m.statut_budget === 'valide' ? <Pastille ton="vert">validé</Pastille> : m.statut_budget ? <Pastille ton="or">brouillon</Pastille> : <span className="secondaire">—</span>}</td>
                  <td className="nombre">{montant(m.prevu, '')}</td>
                  <td className="nombre">{montant(m.reel, '')}</td>
                  <td className={`nombre ${Number(m.prevu) - Number(m.reel) < 0 ? 'texte-negatif' : ''}`}>{montant(Number(m.prevu) - Number(m.reel), '')}</td>
                  <td className={`nombre ${Number(m.depassement) > 0 ? 'texte-negatif' : ''}`}>{Number(m.depassement) ? montant(m.depassement, '') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="carte">
        <h2>Par poste</h2>
        {bilan.postes.length === 0 ? (
          <Vide>Aucun budget ni dépense cette année.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau tableau-compact">
              <thead><tr><th>Poste</th><th className="nombre">Prévu</th><th className="nombre">Réalisé</th><th className="nombre">Dépassements</th><th>Mois réalisés / dépassés / non réalisés</th></tr></thead>
              <tbody>
                {bilan.postes.map((p) => (
                  <tr key={p.poste_id}>
                    <td>{p.libelle}</td>
                    <td className="nombre">{montant(p.prevu, '')}</td>
                    <td className="nombre">{montant(p.reel, '')}</td>
                    <td className={`nombre ${Number(p.depassement) > 0 ? 'texte-negatif' : ''}`}>{Number(p.depassement) ? montant(p.depassement, '') : ''}</td>
                    <td>
                      <Pastille ton="vert">{p.mois_realises} réalisé{p.mois_realises > 1 ? 's' : ''}</Pastille>{' '}
                      {p.mois_depasses > 0 && <Pastille ton="rouge">{p.mois_depasses} dépassé{p.mois_depasses > 1 ? 's' : ''}</Pastille>}{' '}
                      {p.mois_non_realises > 0 && <Pastille ton="gris">{p.mois_non_realises} non réalisé{p.mois_non_realises > 1 ? 's' : ''}</Pastille>}
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
