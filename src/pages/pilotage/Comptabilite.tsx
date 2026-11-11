import { exporterClasseur, type FormatExport } from '../../lib/export';
import { BoutonsExport } from '../../components/Export';
import { SaisieGuidee } from './SaisieGuidee';
import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { clavierMontant, enUnites, lireMontant, montant } from '../../lib/argent';
import { aujourdhui, dateFr } from '../../lib/tresorerie';
import type { Feuille } from '../../lib/excel';
import { Alerte, Champ, EnTetePage, Fenetre, Pastille, Vide } from '../../components/ui';

type Onglet = 'journal' | 'grand_livre' | 'balance' | 'bilan' | 'cloture' | 'plan';
const ONGLETS: { code: Onglet; libelle: string }[] = [
  { code: 'journal', libelle: 'Journal' },
  { code: 'grand_livre', libelle: 'Grand livre' },
  { code: 'balance', libelle: 'Balance' },
  { code: 'bilan', libelle: 'Bilan' },
  { code: 'cloture', libelle: 'Clôtures et écritures' },
  { code: 'plan', libelle: 'Plan comptable' },
];
const JOURNAUX: Record<string, string> = { VT: 'Ventes', AC: 'Achats', TR: 'Trésorerie', OD: 'Opérations diverses', AN: 'À-nouveaux' };

interface Ligne { compte: string; intitule?: string | null; libelle?: string | null; debit: number; credit: number }
interface Ecriture {
  id: string;
  numero: string;
  date_ecriture: string;
  journal: string;
  libelle: string;
  piece: string | null;
  automatique: boolean;
  extourne_de: string | null;
  cloturee: boolean;
  lignes: Ligne[];
}
interface LigneBalance { compte: string; intitule: string; solde_initial: number; debit: number; credit: number; solde_final: number }
interface CompteGL { compte: string; intitule: string; solde_initial: number; mouvements: { date: string; numero: string; journal: string; libelle: string; piece: string | null; debit: number; credit: number }[] | null }
interface Bilan {
  au: string;
  actif: { immobilisations: number; stocks: number; creances: number; tresorerie: number; total: number };
  passif: { capitaux_propres: number; resultat: number; dettes_financieres: number; dettes_fournisseurs: number; dettes_fiscales_sociales: number; autres_dettes: number; tresorerie_passif: number; total: number };
}

const debutMois = () => `${aujourdhui().slice(0, 7)}-01`;
const libelleMois = (iso: string) => {
  const s = new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function Comptabilite() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const [onglet, setOnglet] = useState<Onglet>('journal');
  const [du, setDu] = useState(debutMois());
  const [au, setAu] = useState(aujourdhui());
  const [journal, setJournal] = useState('');
  const [compte, setCompte] = useState('');
  const [ecritures, setEcritures] = useState<Ecriture[]>([]);
  const [balance, setBalance] = useState<LigneBalance[]>([]);
  const [gl, setGl] = useState<CompteGL[]>([]);
  const [bilan, setBilan] = useState<Bilan | null>(null);
  const [periodes, setPeriodes] = useState<{ mois: string; cloturee: boolean; cloturee_le: string | null; ecritures: number }[]>([]);
  const [plan, setPlan] = useState<{ numero: string; libelle: string }[]>([]);
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [guide, setGuide] = useState(false);
  const [saisie, setSaisie] = useState<{ date: string; journal: string; libelle: string; piece: string; justificatif: string; lignes: { compte: string; debit: string; credit: string }[] } | null>(null);

  const charger = useCallback(async () => {
    setChargement(true);
    setErreur('');
    let r: { data: unknown; error: unknown } = { data: null, error: null };
    if (onglet === 'journal') r = await supabase.rpc('journal_comptable', { p_org: org, p_debut: du, p_fin: au, p_journal: journal || null });
    else if (onglet === 'balance') r = await supabase.rpc('balance_comptable', { p_org: org, p_debut: du, p_fin: au });
    else if (onglet === 'grand_livre') r = await supabase.rpc('grand_livre', { p_org: org, p_debut: du, p_fin: au, p_compte: compte || null });
    else if (onglet === 'bilan') r = await supabase.rpc('bilan_simplifie', { p_org: org, p_au: au });
    else if (onglet === 'cloture') r = await supabase.rpc('periodes_comptables_etat', { p_org: org });
    else r = await supabase.from('plan_comptable').select('numero, libelle').eq('organisation_id', org).order('numero');
    setChargement(false);
    if (r.error) return setErreur(messageErreur(r.error));
    if (onglet === 'journal') setEcritures((r.data ?? []) as Ecriture[]);
    else if (onglet === 'balance') setBalance((r.data ?? []) as LigneBalance[]);
    else if (onglet === 'grand_livre') setGl((r.data ?? []) as CompteGL[]);
    else if (onglet === 'bilan') setBilan(r.data as Bilan);
    else if (onglet === 'cloture') setPeriodes((r.data ?? []) as typeof periodes);
    else setPlan((r.data ?? []) as typeof plan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, onglet, du, au, journal, compte]);
  useEffect(() => {
    void charger();
  }, [charger]);

  async function cloturer(mois: string) {
    if (!window.confirm(`Clôturer ${libelleMois(mois).toLowerCase()} ? Les écritures seront figées ; une correction passera par une extourne.`)) return;
    const { data, error } = await supabase.rpc('cloturer_mois_comptable', { p_org: org, p_mois: mois });
    if (error) return setErreur(messageErreur(error));
    setInfo(`${libelleMois(mois)} clôturé : ${(data as { ecritures: number }).ecritures} écritures figées.`);
    await charger();
  }

  async function extourner(e: Ecriture) {
    const motif = window.prompt(`Motif de l’extourne de ${e.numero}`);
    if (!motif?.trim()) return;
    const { error } = await supabase.rpc('extourner_ecriture', { p_ecriture: e.id, p_motif: motif.trim() });
    if (error) return setErreur(messageErreur(error));
    setInfo('Extourne passée à la date du jour.');
    await charger();
  }

  async function enregistrerSaisie(ev: FormEvent) {
    ev.preventDefault();
    if (!saisie) return;
    const lignes = saisie.lignes
      .filter((l) => l.compte.trim())
      .map((l) => ({ compte: l.compte.trim(), debit: lireMontant(l.debit) ?? 0, credit: lireMontant(l.credit) ?? 0 }));
    const { error } = await supabase.rpc('ecriture_manuelle', {
      p_org: org,
      p_date: saisie.date,
      p_journal: saisie.journal,
      p_libelle: saisie.libelle,
      p_lignes: lignes,
      p_piece: saisie.piece,
      p_justificatif: saisie.justificatif || null,
    });
    if (error) return setErreur(messageErreur(error));
    setSaisie(null);
    setInfo('Écriture enregistrée.');
    await charger();
  }

  async function renommer(numero: string, ancien: string) {
    const libelle = window.prompt(`Intitulé du compte ${numero}`, ancien);
    if (!libelle?.trim() || libelle === ancien) return;
    const { error } = await supabase.from('plan_comptable').update({ libelle: libelle.trim() }).eq('organisation_id', org).eq('numero', numero);
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

  async function ajouterCompte() {
    const numero = window.prompt('Numéro du compte (ex. 2441)');
    if (!numero?.trim()) return;
    const libelle = window.prompt('Intitulé du compte');
    if (!libelle?.trim()) return;
    const { error } = await supabase.from('plan_comptable').insert({ organisation_id: org, numero: numero.trim(), libelle: libelle.trim() });
    if (error) return setErreur(/duplicate/.test(error.message) ? 'Ce compte existe déjà.' : messageErreur(error));
    await charger();
  }

  function exporter(format: FormatExport = 'xlsx') {
    const titre = `${organisation!.nom} — du ${dateFr(du)} au ${dateFr(au)}`;
    let feuilles: Feuille[] = [];
    if (onglet === 'journal')
      feuilles = [{
        nom: 'Journal',
        titre: [`Journal général · ${titre}`],
        entetes: ['Date', 'N°', 'Journal', 'Compte', 'Intitulé', 'Libellé', 'Pièce', 'Débit', 'Crédit'],
        lignes: ecritures.flatMap((e) => e.lignes.map((l) => [dateFr(e.date_ecriture), e.numero, e.journal, l.compte, l.intitule ?? '', l.libelle ?? e.libelle, e.piece ?? '', enUnites(l.debit), enUnites(l.credit)])),
        totaux: ['Total', '', '', '', '', '', '', enUnites(ecritures.reduce((s, e) => s + e.lignes.reduce((t, l) => t + Number(l.debit), 0), 0)), enUnites(ecritures.reduce((s, e) => s + e.lignes.reduce((t, l) => t + Number(l.credit), 0), 0))],
      }];
    else if (onglet === 'balance')
      feuilles = [{
        nom: 'Balance',
        titre: [`Balance générale · ${titre}`],
        entetes: ['Compte', 'Intitulé', 'Solde initial', 'Débit', 'Crédit', 'Solde débiteur', 'Solde créditeur'],
        lignes: balance.map((b) => [b.compte, b.intitule, enUnites(b.solde_initial), enUnites(b.debit), enUnites(b.credit), b.solde_final > 0 ? enUnites(b.solde_final) : '', b.solde_final < 0 ? enUnites(-b.solde_final) : '']),
        totaux: ['Total', '', '', enUnites(balance.reduce((s, b) => s + Number(b.debit), 0)), enUnites(balance.reduce((s, b) => s + Number(b.credit), 0)),
          enUnites(balance.reduce((s, b) => s + Math.max(Number(b.solde_final), 0), 0)), enUnites(balance.reduce((s, b) => s + Math.max(-Number(b.solde_final), 0), 0))],
      }];
    else if (onglet === 'grand_livre')
      feuilles = [{
        nom: 'Grand livre',
        titre: [`Grand livre · ${titre}`],
        entetes: ['Compte', 'Date', 'N°', 'Journal', 'Libellé', 'Débit', 'Crédit', 'Solde'],
        lignes: gl.flatMap((c) => {
          let solde = Number(c.solde_initial);
          return [
            [c.compte, '', '', '', `${c.intitule} — solde initial`, '', '', enUnites(solde)],
            ...(c.mouvements ?? []).map((m) => {
              solde += Number(m.debit) - Number(m.credit);
              return [c.compte, dateFr(m.date), m.numero, m.journal, m.libelle, enUnites(m.debit), enUnites(m.credit), enUnites(solde)];
            }),
          ];
        }),
      }];
    if (feuilles.length) exporterClasseur(`comptabilite-${onglet}-${du}-${au}`, feuilles, format);
  }

  const totDebit = ecritures.reduce((s, e) => s + e.lignes.reduce((t, l) => t + Number(l.debit), 0), 0);
  const totCredit = ecritures.reduce((s, e) => s + e.lignes.reduce((t, l) => t + Number(l.credit), 0), 0);
  const saisieDebit = saisie ? saisie.lignes.reduce((s, l) => s + (lireMontant(l.debit) ?? 0), 0) : 0;
  const saisieCredit = saisie ? saisie.lignes.reduce((s, l) => s + (lireMontant(l.credit) ?? 0), 0) : 0;

  return (
    <>
      <EnTetePage
        icone="📚"
        titre="Comptabilité"
        sousTitre="Écritures SYSCOHADA générées automatiquement par les ventes, achats, dépenses et virements : journal, grand livre, balance et bilan."
        actions={
          <>
            {['journal', 'balance', 'grand_livre'].includes(onglet) && <BoutonsExport onExport={exporter} />}
            {peut('comptabilite.creer') && (
              <button className="bouton bouton-principal" onClick={() => setGuide(true)}>
                ✨ Saisir une opération
              </button>
            )}
            {peut('comptabilite.creer') && (
              <button
                className="bouton bouton-discret"
                onClick={() => setSaisie({ date: aujourdhui(), journal: 'OD', libelle: '', piece: '', justificatif: '', lignes: [{ compte: '', debit: '', credit: '' }, { compte: '', debit: '', credit: '' }] })}
              >
                Écriture (débit / crédit)
              </button>
            )}
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      <nav className="onglets-pilules" role="tablist" aria-label="Comptabilité">
        {ONGLETS.map((o) => (
          <button key={o.code} type="button" role="tab" aria-selected={onglet === o.code} className={onglet === o.code ? 'actif' : ''} onClick={() => setOnglet(o.code)}>
            {o.libelle}
          </button>
        ))}
      </nav>

      {onglet !== 'cloture' && onglet !== 'plan' && (
        <section className="carte">
          <div className="filtres-ligne">
            {onglet !== 'bilan' && (
              <Champ label="Du">
                <input type="date" value={du} max={au} onChange={(e) => e.target.value && setDu(e.target.value)} />
              </Champ>
            )}
            <Champ label={onglet === 'bilan' ? 'Bilan au' : 'Au'}>
              <input type="date" value={au} min={onglet === 'bilan' ? undefined : du} max={aujourdhui()} onChange={(e) => e.target.value && setAu(e.target.value)} />
            </Champ>
            {onglet === 'journal' && (
              <Champ label="Journal">
                <select value={journal} onChange={(e) => setJournal(e.target.value)}>
                  <option value="">Tous</option>
                  {Object.entries(JOURNAUX).map(([k, v]) => (
                    <option key={k} value={k}>{k} — {v}</option>
                  ))}
                </select>
              </Champ>
            )}
            {onglet === 'grand_livre' && (
              <Champ label="Comptes commençant par">
                <input value={compte} onChange={(e) => setCompte(e.target.value.replace(/\D/g, ''))} placeholder="ex. 5, 401, 6" inputMode="numeric" />
              </Champ>
            )}
          </div>
        </section>
      )}

      {chargement && <Vide>Calcul en cours…</Vide>}

      {!chargement && onglet === 'journal' && (
        <section className="carte">
          {ecritures.length === 0 ? (
            <Vide>Aucune écriture sur la période.</Vide>
          ) : (
            <div className="defilement-horizontal">
              <table className="tableau tableau-compact journal">
                <thead>
                  <tr><th>Date</th><th>N° / libellé</th><th>Compte</th><th className="nombre">Débit</th><th className="nombre">Crédit</th><th aria-label="Actions" /></tr>
                </thead>
                <tbody>
                  {ecritures.map((e) => (
                    <Fragment key={e.id}>
                      <tr className="ecriture-tete">
                        <td>{dateFr(e.date_ecriture)}</td>
                        <td colSpan={4}>
                          <span className="code">{e.numero}</span> <strong>{e.libelle}</strong>
                          {e.piece && <span className="secondaire"> · pièce {e.piece}</span>}
                          {!e.automatique && <> <Pastille ton="or">manuelle</Pastille></>}
                          {e.cloturee && <> <Pastille ton="gris">clôturée</Pastille></>}
                        </td>
                        <td>
                          {(e.cloturee || !e.automatique) && peut('comptabilite.creer') && !e.extourne_de && (
                            <button className="bouton-lien" onClick={() => void extourner(e)}>Extourner</button>
                          )}
                        </td>
                      </tr>
                      {e.lignes.map((l, i) => (
                        <tr key={i} className="ecriture-ligne">
                          <td />
                          <td className="secondaire">{l.intitule ?? ''}{l.libelle ? ` · ${l.libelle}` : ''}</td>
                          <td className="code">{l.compte}</td>
                          <td className="nombre">{Number(l.debit) ? montant(l.debit, '') : ''}</td>
                          <td className="nombre">{Number(l.credit) ? montant(l.credit, '') : ''}</td>
                          <td />
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="ligne-total">
                    <td colSpan={3}>Total ({ecritures.length} écritures)</td>
                    <td className="nombre">{montant(totDebit)}</td>
                    <td className="nombre">{montant(totCredit)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      )}

      {!chargement && onglet === 'balance' && (
        <section className="carte">
          {balance.length === 0 ? (
            <Vide>Aucune écriture.</Vide>
          ) : (
            <div className="defilement-horizontal">
              <table className="tableau tableau-compact">
                <thead>
                  <tr><th>Compte</th><th>Intitulé</th><th className="nombre col-secondaire">Solde initial</th><th className="nombre">Débit</th><th className="nombre">Crédit</th><th className="nombre">Solde débiteur</th><th className="nombre">Solde créditeur</th></tr>
                </thead>
                <tbody>
                  {balance.map((b) => (
                    <tr key={b.compte} className="ligne-cliquable" onClick={() => { setCompte(b.compte); setOnglet('grand_livre'); }}>
                      <td className="code">{b.compte}</td>
                      <td>{b.intitule}</td>
                      <td className="nombre col-secondaire">{montant(b.solde_initial, '')}</td>
                      <td className="nombre">{montant(b.debit, '')}</td>
                      <td className="nombre">{montant(b.credit, '')}</td>
                      <td className="nombre">{b.solde_final > 0 ? montant(b.solde_final, '') : ''}</td>
                      <td className="nombre">{b.solde_final < 0 ? montant(-b.solde_final, '') : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="ligne-total">
                    <td colSpan={3}>Total</td>
                    <td className="nombre">{montant(balance.reduce((s, b) => s + Number(b.debit), 0))}</td>
                    <td className="nombre">{montant(balance.reduce((s, b) => s + Number(b.credit), 0))}</td>
                    <td className="nombre">{montant(balance.reduce((s, b) => s + Math.max(Number(b.solde_final), 0), 0))}</td>
                    <td className="nombre">{montant(balance.reduce((s, b) => s + Math.max(-Number(b.solde_final), 0), 0))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      )}

      {!chargement && onglet === 'grand_livre' && (
        <section className="carte">
          {gl.length === 0 ? (
            <Vide>Aucun mouvement.</Vide>
          ) : (
            gl.map((c) => {
              let solde = Number(c.solde_initial);
              return (
                <div key={c.compte} className="compte-gl">
                  <h3><span className="code">{c.compte}</span> {c.intitule}</h3>
                  <table className="tableau tableau-compact">
                    <thead>
                      <tr><th>Date</th><th>N°</th><th>Libellé</th><th className="nombre">Débit</th><th className="nombre">Crédit</th><th className="nombre">Solde</th></tr>
                    </thead>
                    <tbody>
                      <tr className="secondaire"><td colSpan={5}>Solde initial</td><td className="nombre">{montant(solde, '')}</td></tr>
                      {(c.mouvements ?? []).map((m, i) => {
                        solde += Number(m.debit) - Number(m.credit);
                        return (
                          <tr key={i}>
                            <td>{dateFr(m.date)}</td>
                            <td className="code">{m.numero}</td>
                            <td>{m.libelle}</td>
                            <td className="nombre">{Number(m.debit) ? montant(m.debit, '') : ''}</td>
                            <td className="nombre">{Number(m.credit) ? montant(m.credit, '') : ''}</td>
                            <td className={`nombre ${solde < 0 ? 'texte-negatif' : ''}`}>{montant(solde, '')}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })
          )}
        </section>
      )}

      {!chargement && onglet === 'bilan' && bilan && (
        <section className="bilan">
          <div className="carte">
            <h3>Actif</h3>
            <table className="tableau tableau-compact">
              <tbody>
                <tr><td>Immobilisations nettes</td><td className="nombre">{montant(bilan.actif.immobilisations)}</td></tr>
                <tr><td>Stocks de marchandises</td><td className="nombre">{montant(bilan.actif.stocks)}</td></tr>
                <tr><td>Créances (clients et autres)</td><td className="nombre">{montant(bilan.actif.creances)}</td></tr>
                <tr><td>Trésorerie (caisse, Mobile Money, banque)</td><td className="nombre">{montant(bilan.actif.tresorerie)}</td></tr>
                <tr className="ligne-total"><td>Total actif</td><td className="nombre">{montant(bilan.actif.total)}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="carte">
            <h3>Passif</h3>
            <table className="tableau tableau-compact">
              <tbody>
                <tr><td>Capitaux propres</td><td className="nombre">{montant(bilan.passif.capitaux_propres)}</td></tr>
                <tr><td>Résultat de la période</td><td className={`nombre ${bilan.passif.resultat < 0 ? 'texte-negatif' : 'texte-positif'}`}>{montant(bilan.passif.resultat)}</td></tr>
                <tr><td>Dettes financières (emprunts)</td><td className="nombre">{montant(bilan.passif.dettes_financieres)}</td></tr>
                <tr><td>Dettes fournisseurs</td><td className="nombre">{montant(bilan.passif.dettes_fournisseurs)}</td></tr>
                <tr><td>Dettes fiscales et sociales</td><td className="nombre">{montant(bilan.passif.dettes_fiscales_sociales)}</td></tr>
                <tr><td>Autres dettes</td><td className="nombre">{montant(bilan.passif.autres_dettes)}</td></tr>
                <tr><td>Trésorerie passif (découverts)</td><td className="nombre">{montant(bilan.passif.tresorerie_passif)}</td></tr>
                <tr className="ligne-total"><td>Total passif</td><td className="nombre">{montant(bilan.passif.total)}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="secondaire bilan-note">
            Bilan simplifié au {dateFr(bilan.au)}, calculé depuis les écritures. {bilan.actif.total === bilan.passif.total ? '✅ Actif et passif sont équilibrés.' : '⚠️ Écart entre actif et passif : vérifiez les écritures manuelles.'}{' '}
            Les états financiers annuels officiels restent à faire valider par un expert-comptable.
          </p>
        </section>
      )}

      {!chargement && onglet === 'cloture' && (
        <section className="carte">
          <p className="secondaire">
            Tant qu’un mois est ouvert, ses écritures se recalculent à partir des opérations. La clôture les fige ; une erreur se corrige
            ensuite par une extourne, passée dans le mois en cours.
          </p>
          <table className="tableau">
            <thead><tr><th>Mois</th><th className="nombre">Écritures</th><th>État</th><th aria-label="Action" /></tr></thead>
            <tbody>
              {periodes.map((p) => (
                <tr key={p.mois}>
                  <td>{libelleMois(p.mois)}</td>
                  <td className="nombre">{p.ecritures}</td>
                  <td>{p.cloturee ? <Pastille ton="vert">Clôturé le {dateFr(p.cloturee_le)}</Pastille> : <Pastille ton="or">Ouvert</Pastille>}</td>
                  <td>
                    {!p.cloturee && peut('comptabilite.cloturer') && p.mois < debutMois() && (
                      <button className="bouton bouton-discret bouton-petit" onClick={() => void cloturer(p.mois)}>Clôturer</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {!chargement && onglet === 'plan' && (
        <section className="carte">
          <div className="entete-section">
            <h2>Plan comptable SYSCOHADA révisé</h2>
            {peut('comptabilite.creer') && <button className="bouton bouton-discret" onClick={() => void ajouterCompte()}>+ Compte</button>}
          </div>
          <p className="secondaire">
            Comptes proposés d’office, ajustables par l’expert-comptable. Les comptes des caisses, de Mobile Money et de la banque se règlent
            dans Trésorerie ; ceux des charges, dans les postes du Budget.
          </p>
          <table className="tableau tableau-compact">
            <tbody>
              {plan.map((p) => (
                <tr key={p.numero} className={peut('comptabilite.creer') ? 'ligne-cliquable' : ''} onClick={() => peut('comptabilite.creer') && void renommer(p.numero, p.libelle)}>
                  <td className="code">{p.numero}</td>
                  <td>{p.libelle}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <Fenetre titre="Saisir une opération (sans débit ni crédit)" ouverte={guide} onFermer={() => setGuide(false)} large>
        {guide && (
          <SaisieGuidee
            org={org}
            onFaite={() => {
              setGuide(false);
              setInfo('Opération enregistrée dans la comptabilité.');
              void charger();
            }}
            onExpert={() => {
              setGuide(false);
              setSaisie({ date: aujourdhui(), journal: 'OD', libelle: '', piece: '', justificatif: '', lignes: [{ compte: '', debit: '', credit: '' }, { compte: '', debit: '', credit: '' }] });
            }}
          />
        )}
      </Fenetre>

      <Fenetre titre="Écriture manuelle" ouverte={!!saisie} onFermer={() => setSaisie(null)} large>
        {saisie && (
          <form className="formulaire" onSubmit={enregistrerSaisie}>
            <Alerte>{erreur}</Alerte>
            <div className="grille-4">
              <Champ label="Date">
                <input type="date" value={saisie.date} max={aujourdhui()} onChange={(e) => setSaisie({ ...saisie, date: e.target.value })} />
              </Champ>
              <Champ label="Journal">
                <select value={saisie.journal} onChange={(e) => setSaisie({ ...saisie, journal: e.target.value })}>
                  {Object.entries(JOURNAUX).map(([k, v]) => (
                    <option key={k} value={k}>{k} — {v}</option>
                  ))}
                </select>
              </Champ>
              <Champ label="Pièce justificative">
                <input value={saisie.piece} onChange={(e) => setSaisie({ ...saisie, piece: e.target.value })} required placeholder="Facture, PV, contrat…" />
              </Champ>
              <Champ label="Libellé">
                <input value={saisie.libelle} onChange={(e) => setSaisie({ ...saisie, libelle: e.target.value })} required minLength={3} placeholder="Achat d’un congélateur" />
              </Champ>
            </div>
            <table className="tableau tableau-saisie">
              <thead><tr><th>Compte</th><th className="nombre">Débit</th><th className="nombre">Crédit</th><th aria-label="Retirer" /></tr></thead>
              <tbody>
                {saisie.lignes.map((l, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        value={l.compte}
                        list="plan-comptable"
                        inputMode="numeric"
                        onChange={(e) => setSaisie({ ...saisie, lignes: saisie.lignes.map((x, j) => (j === i ? { ...x, compte: e.target.value.replace(/\D/g, '') } : x)) })}
                        placeholder="ex. 2441"
                      />
                    </td>
                    <td className="nombre">
                      <input className="champ-nombre champ-prix" inputMode={clavierMontant()} value={l.debit}
                        onChange={(e) => setSaisie({ ...saisie, lignes: saisie.lignes.map((x, j) => (j === i ? { ...x, debit: e.target.value, credit: '' } : x)) })} />
                    </td>
                    <td className="nombre">
                      <input className="champ-nombre champ-prix" inputMode={clavierMontant()} value={l.credit}
                        onChange={(e) => setSaisie({ ...saisie, lignes: saisie.lignes.map((x, j) => (j === i ? { ...x, credit: e.target.value, debit: '' } : x)) })} />
                    </td>
                    <td>
                      {saisie.lignes.length > 2 && (
                        <button type="button" className="bouton-lien lien-danger" onClick={() => setSaisie({ ...saisie, lignes: saisie.lignes.filter((_, j) => j !== i) })}>×</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="ligne-total">
                  <td>
                    <button type="button" className="bouton-lien" onClick={() => setSaisie({ ...saisie, lignes: [...saisie.lignes, { compte: '', debit: '', credit: '' }] })}>+ Ligne</button>
                  </td>
                  <td className="nombre">{montant(saisieDebit)}</td>
                  <td className="nombre">{montant(saisieCredit)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
            <datalist id="plan-comptable">
              {plan.map((p) => (
                <option key={p.numero} value={p.numero}>{p.libelle}</option>
              ))}
            </datalist>
            {saisieDebit !== saisieCredit && <Alerte type="info">Débit et crédit doivent être égaux (écart {montant(Math.abs(saisieDebit - saisieCredit))}).</Alerte>}
            <button className="bouton bouton-principal" disabled={saisieDebit !== saisieCredit || saisieDebit === 0}>Enregistrer l’écriture</button>
          </form>
        )}
      </Fenetre>
    </>
  );
}

