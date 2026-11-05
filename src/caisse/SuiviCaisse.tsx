import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';
import { clavierMontant, lireMontant, montant } from '../lib/argent';
import { Alerte, Champ, EnTetePage, Fenetre, MontantFort, Pastille, Vide } from '../components/ui';
import { RapportCaisse, type RapportSession } from '../impression/RapportCaisse';
import { useImpressionCaisse } from './impressionCaisse';
import { useIdentite } from '../lib/identite';

interface Totaux {
  nombre_ventes: number;
  total_ventes: number;
  nombre_annulations: number;
  total_annulations: number;
  fond_initial: number;
  especes_encaissees: number;
  especes_attendues: number;
  depenses_caisse?: number;
  sorties_caisse?: number;
  apports_caisse?: number;
  par_moyen: { libelle: string; nature: string; montant: number; nombre: number }[];
}
interface VenteJournal {
  id: string;
  numero: string;
  date_vente: string;
  total: number;
  statut: 'validee' | 'annulee';
  client: string | null;
  motif_annulation: string | null;
  annulee_le: string | null;
  paiement: string | null;
}
interface MouvementJournal {
  type: 'depense' | 'sortie' | 'apport';
  montant: number;
  motif: string | null;
  poste?: string | null;
  compte?: string | null;
  statut: string;
  cree_le: string;
}
interface Journal {
  session: { id: string; statut: string; ouverte_le: string; cloturee_le: string | null; numero_z: number | null; fond_initial: number };
  totaux: Totaux;
  ventes: VenteJournal[];
  mouvements: MouvementJournal[];
}
interface Cloture {
  id: string;
  caisse: string;
  numero_z: number;
  ouverte_le: string;
  cloturee_le: string;
  caissier: string | null;
  total_ventes: string | null;
  nombre_ventes: string | null;
  especes_attendues: number;
  especes_comptees: number;
  ecart: number;
  motif_ecart: string | null;
}

type Onglet = 'vue' | 'journal' | 'sorties' | 'remboursements' | 'clotures' | 'depenses';
const ONGLETS: { code: Onglet; libelle: string }[] = [
  { code: 'vue', libelle: 'Vue générale' },
  { code: 'journal', libelle: 'Journal' },
  { code: 'sorties', libelle: 'Sorties et apports' },
  { code: 'remboursements', libelle: 'Remboursements' },
  { code: 'clotures', libelle: 'Clôtures' },
  { code: 'depenses', libelle: 'Dépenses' },
];

const heure = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Abidjan' });

export function SuiviCaisse() {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const [params] = useSearchParams();
  const [sessionId, setSessionId] = useState(params.get('session'));
  const [journal, setJournal] = useState<Journal | null>(null);
  const [clotures, setClotures] = useState<Cloture[]>([]);
  const [onglet, setOnglet] = useState<Onglet>('vue');
  const [options, setOptions] = useState<{ comptes: { id: string; nom: string; type: string }[]; postes: { id: string; libelle: string }[] }>({ comptes: [], postes: [] });
  const [saisie, setSaisie] = useState<{ type: 'depense' | 'sortie' | 'apport'; montant: string; motif: string; poste: string; compte: string; reference: string } | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const { imprimerTicket, format } = useImpressionCaisse();
  const { identite } = useIdentite();

  // Sans session indiquée : la session ouverte de la caisse choisie sur cet appareil.
  useEffect(() => {
    if (sessionId) return;
    let caisse = '';
    try {
      caisse = JSON.parse(localStorage.getItem(`dfg_caisse_${org}`) ?? '""') as string;
    } catch {
      /* rien */
    }
    if (!caisse) return;
    void supabase
      .from('sessions_caisse')
      .select('id')
      .eq('caisse_id', caisse)
      .eq('statut', 'ouverte')
      .maybeSingle()
      .then(({ data }) => data && setSessionId(data.id as string));
  }, [org, sessionId]);

  const charger = useCallback(async () => {
    const [h, o] = await Promise.all([
      supabase.rpc('historique_clotures', { p_org: org, p_limite: 60 }),
      supabase.rpc('options_caisse', { p_org: org }),
    ]);
    if (!h.error) setClotures((h.data ?? []) as Cloture[]);
    if (!o.error) setOptions(o.data as typeof options);
    if (!sessionId) return;
    const { data, error } = await supabase.rpc('journal_session', { p_session: sessionId });
    if (error) return setErreur(messageErreur(error));
    setJournal(data as Journal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, sessionId]);
  useEffect(() => {
    void charger();
  }, [charger]);

  async function enregistrer(e: FormEvent) {
    e.preventDefault();
    if (!saisie || !sessionId) return;
    const m = lireMontant(saisie.montant);
    if (!m || m <= 0) return setErreur('Indiquez le montant.');
    const { error } = await supabase.rpc('mouvement_caisse', {
      p_session: sessionId,
      p_type: saisie.type,
      p_montant: m,
      p_motif: saisie.motif,
      p_poste: saisie.type === 'depense' ? saisie.poste || null : null,
      p_compte: saisie.type === 'depense' ? null : saisie.compte || null,
      p_reference: saisie.reference || null,
    });
    if (error) return setErreur(messageErreur(error));
    setSaisie(null);
    setInfo(saisie.type === 'depense' ? 'Dépense enregistrée : elle sort du tiroir.' : saisie.type === 'sortie' ? 'Sortie enregistrée.' : 'Apport enregistré.');
    await charger();
  }

  async function reimprimerZ(c: Cloture) {
    const { data, error } = await supabase.rpc('rapport_session', { p_session: c.id });
    if (error) return setErreur(messageErreur(error));
    if (!identite) return;
    await imprimerTicket(
      <RapportCaisse identite={identite} rapport={data as RapportSession} format={format} caisse={c.caisse} caissier={c.caissier ?? undefined} ouverteLe={c.ouverte_le} />,
    );
  }

  const t = journal?.totaux;
  const ouverte = journal?.session.statut === 'ouverte';
  const ventesValides = journal?.ventes.filter((v) => v.statut === 'validee') ?? [];
  const annulations = journal?.ventes.filter((v) => v.statut === 'annulee') ?? [];
  const depenses = journal?.mouvements.filter((m) => m.type === 'depense') ?? [];
  const sorties = journal?.mouvements.filter((m) => m.type !== 'depense') ?? [];
  const destinations = options.comptes;

  const nouveau = (type: 'depense' | 'sortie' | 'apport') =>
    setSaisie({
      type,
      montant: '',
      motif: '',
      poste: options.postes.find((p) => p.libelle.startsWith('Imprévu'))?.id ?? options.postes[0]?.id ?? '',
      compte: destinations.find((c) => c.type === (type === 'sortie' ? 'caisse_centrale' : 'mobile_money'))?.id ?? destinations.find((c) => c.type !== 'caisse')?.id ?? '',
      reference: '',
    });

  return (
    <>
      <EnTetePage
        icone="💼"
        titre="Ma caisse"
        sousTitre={journal ? `Session ouverte à ${heure(journal.session.ouverte_le)}${journal.session.numero_z ? ` · Z n° ${journal.session.numero_z}` : ''}` : 'Suivi du tiroir, des ventes et des clôtures'}
        actions={
          <Link to="/caisse" className="bouton bouton-principal">
            Retour à la vente
          </Link>
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      <nav className="onglets-pilules" role="tablist" aria-label="Suivi de caisse">
        {ONGLETS.map((o) => (
          <button
            key={o.code}
            type="button"
            role="tab"
            aria-selected={onglet === o.code}
            className={onglet === o.code ? 'actif' : ''}
            onClick={() => setOnglet(o.code)}
          >
            {o.libelle}
            {o.code === 'journal' && journal ? ` (${journal.ventes.length})` : ''}
            {o.code === 'sorties' && sorties.length ? ` (${sorties.length})` : ''}
            {o.code === 'remboursements' && annulations.length ? ` (${annulations.length})` : ''}
            {o.code === 'depenses' && depenses.length ? ` (${depenses.length})` : ''}
          </button>
        ))}
      </nav>

      {!journal && onglet !== 'clotures' && <Vide>Aucune caisse ouverte sur cet appareil. Ouvrez la caisse pour suivre la session.</Vide>}

      {journal && t && onglet === 'vue' && (
        <>
          <section className="tdb-tuiles">
            <div className="kpi">
              <span className="kpi-icone" aria-hidden>💵</span>
              <span className="kpi-libelle">Espèces au tiroir</span>
              <span className="kpi-valeur"><MontantFort v={t.especes_attendues} /></span>
              <span className="kpi-evolution secondaire">solde théorique</span>
            </div>
            <div className="kpi">
              <span className="kpi-icone" aria-hidden>🪙</span>
              <span className="kpi-libelle">Encaissements espèces</span>
              <span className="kpi-valeur"><MontantFort v={t.especes_encaissees} /></span>
              <span className="kpi-evolution secondaire">{ouverte ? 'session ouverte' : 'session clôturée'}</span>
            </div>
            <div className="kpi">
              <span className="kpi-icone" aria-hidden>💳</span>
              <span className="kpi-libelle">Paiements du jour</span>
              <span className="kpi-valeur"><MontantFort v={t.total_ventes} /></span>
              <span className="kpi-evolution secondaire">toutes méthodes · {t.nombre_ventes} ventes</span>
            </div>
            <div className={`kpi ${t.nombre_annulations ? 'kpi-alerte' : ''}`}>
              <span className="kpi-icone" aria-hidden>↩️</span>
              <span className="kpi-libelle">Remboursements</span>
              <span className="kpi-valeur"><MontantFort v={t.total_annulations} /></span>
              <span className="kpi-evolution secondaire">{t.nombre_annulations} vente{t.nombre_annulations > 1 ? 's' : ''} annulée{t.nombre_annulations > 1 ? 's' : ''}</span>
            </div>
          </section>
          <section className="carte">
            <h2>Détail du tiroir</h2>
            <table className="tableau tableau-compact">
              <tbody>
                <tr><td>Fond de caisse à l’ouverture</td><td className="nombre">{montant(t.fond_initial)}</td></tr>
                <tr><td>+ Ventes en espèces</td><td className="nombre">{montant(t.especes_encaissees)}</td></tr>
                <tr><td>+ Apports</td><td className="nombre">{montant(t.apports_caisse ?? 0)}</td></tr>
                <tr><td>− Dépenses payées par le tiroir</td><td className="nombre">{montant(t.depenses_caisse ?? 0)}</td></tr>
                <tr><td>− Sorties (versements)</td><td className="nombre">{montant(t.sorties_caisse ?? 0)}</td></tr>
                <tr className="ligne-total"><td>= Espèces attendues au tiroir</td><td className="nombre">{montant(t.especes_attendues)}</td></tr>
              </tbody>
            </table>
            <h2>Par moyen de paiement</h2>
            {t.par_moyen.length === 0 ? (
              <Vide>Aucun encaissement.</Vide>
            ) : (
              <table className="tableau tableau-compact">
                <tbody>
                  {t.par_moyen.map((m) => (
                    <tr key={m.libelle}>
                      <td>{m.libelle} <span className="secondaire">· {m.nombre} opération{m.nombre > 1 ? 's' : ''}</span></td>
                      <td className="nombre">{montant(m.montant)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {journal && onglet === 'journal' && (
        <section className="carte">
          {journal.ventes.length === 0 ? (
            <Vide>Aucune vente dans cette session.</Vide>
          ) : (
            <table className="tableau">
              <thead>
                <tr><th>Heure</th><th>Ticket</th><th className="col-secondaire">Paiement</th><th className="nombre">Total</th><th>Statut</th></tr>
              </thead>
              <tbody>
                {journal.ventes.map((v) => (
                  <tr key={v.id} className={v.statut === 'annulee' ? 'ligne-annulee' : ''}>
                    <td>{heure(v.date_vente)}</td>
                    <td><strong>{v.numero}</strong>{v.client && <div className="secondaire">{v.client}</div>}</td>
                    <td className="col-secondaire">{v.paiement ?? '—'}</td>
                    <td className="nombre">{montant(v.total)}</td>
                    <td>{v.statut === 'validee' ? <Pastille ton="vert">Validée</Pastille> : <Pastille ton="rouge">Annulée</Pastille>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="ligne-total">
                  <td colSpan={3}>Total des ventes validées</td>
                  <td className="nombre">{montant(ventesValides.reduce((s, v) => s + Number(v.total), 0))}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          )}
        </section>
      )}

      {journal && (onglet === 'sorties' || onglet === 'depenses') && (
        <section className="carte">
          <div className="entete-section">
            <h2>{onglet === 'sorties' ? 'Sorties et apports d’espèces' : 'Dépenses payées par le tiroir'}</h2>
            {ouverte && (
              <div className="actions-ligne">
                {onglet === 'sorties' ? (
                  <>
                    <button className="bouton bouton-discret" onClick={() => nouveau('apport')}>+ Apport</button>
                    <button className="bouton bouton-principal" onClick={() => nouveau('sortie')}>− Sortie / versement</button>
                  </>
                ) : (
                  <button className="bouton bouton-principal" onClick={() => nouveau('depense')}>Nouvelle dépense</button>
                )}
              </div>
            )}
          </div>
          {(onglet === 'sorties' ? sorties : depenses).length === 0 ? (
            <Vide>{onglet === 'sorties' ? 'Aucune sortie ni apport.' : 'Aucune dépense payée par le tiroir.'}</Vide>
          ) : (
            <table className="tableau">
              <thead>
                <tr><th>Heure</th><th>Motif</th><th className="col-secondaire">{onglet === 'sorties' ? 'Compte' : 'Poste'}</th><th className="nombre">Montant</th></tr>
              </thead>
              <tbody>
                {(onglet === 'sorties' ? sorties : depenses).map((m, i) => (
                  <tr key={i} className={m.statut.startsWith('annul') ? 'ligne-annulee' : ''}>
                    <td>{heure(m.cree_le)}</td>
                    <td>
                      {m.type === 'apport' ? <Pastille ton="vert">Apport</Pastille> : m.type === 'sortie' ? <Pastille ton="or">Sortie</Pastille> : null} {m.motif}
                    </td>
                    <td className="col-secondaire">{(m.type === 'depense' ? m.poste : m.compte) ?? '—'}</td>
                    <td className="nombre">{m.type === 'apport' ? '+ ' : '− '}{montant(m.montant)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {journal && onglet === 'remboursements' && (
        <section className="carte">
          {annulations.length === 0 ? (
            <Vide>Aucune vente annulée dans cette session.</Vide>
          ) : (
            <table className="tableau">
              <thead>
                <tr><th>Ticket</th><th>Annulée à</th><th className="col-secondaire">Motif</th><th className="nombre">Montant</th></tr>
              </thead>
              <tbody>
                {annulations.map((v) => (
                  <tr key={v.id}>
                    <td><strong>{v.numero}</strong></td>
                    <td>{v.annulee_le ? heure(v.annulee_le) : '—'}</td>
                    <td className="col-secondaire">{v.motif_annulation ?? '—'}</td>
                    <td className="nombre">{montant(v.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {onglet === 'clotures' && (
        <section className="carte">
          {clotures.length === 0 ? (
            <Vide>Aucune clôture pour l’instant.</Vide>
          ) : (
            <div className="defilement-horizontal">
              <table className="tableau">
                <thead>
                  <tr>
                    <th>Z</th><th>Caisse</th><th>Clôturée le</th><th className="col-secondaire">Caissier</th>
                    <th className="nombre">Ventes</th><th className="nombre">Écart</th><th aria-label="Réimprimer" />
                  </tr>
                </thead>
                <tbody>
                  {clotures.map((c) => (
                    <tr key={c.id}>
                      <td><strong>n° {c.numero_z}</strong></td>
                      <td>{c.caisse}</td>
                      <td>{new Date(c.cloturee_le).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Abidjan' })}</td>
                      <td className="col-secondaire">{c.caissier ?? '—'}</td>
                      <td className="nombre">{montant(c.total_ventes ?? 0)}<div className="secondaire">{c.nombre_ventes ?? 0} tickets</div></td>
                      <td className={`nombre ${Number(c.ecart) !== 0 ? 'texte-negatif' : ''}`}>
                        {Number(c.ecart) === 0 ? <Pastille ton="vert">Juste</Pastille> : montant(c.ecart)}
                        {c.motif_ecart && <div className="secondaire">{c.motif_ecart}</div>}
                      </td>
                      <td>
                        <button className="bouton-lien" onClick={() => void reimprimerZ(c)}>Réimprimer</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <Fenetre
        titre={saisie?.type === 'depense' ? 'Dépense payée par le tiroir' : saisie?.type === 'sortie' ? 'Sortie d’espèces (versement)' : 'Apport d’espèces'}
        ouverte={!!saisie}
        onFermer={() => setSaisie(null)}
      >
        {saisie && (
          <form className="formulaire" onSubmit={enregistrer}>
            <Alerte>{erreur}</Alerte>
            <div className="grille-2">
              <Champ label="Montant">
                <input value={saisie.montant} onChange={(e) => setSaisie({ ...saisie, montant: e.target.value })} inputMode={clavierMontant()} required autoFocus />
              </Champ>
              {saisie.type === 'depense' ? (
                <Champ label="Poste">
                  <select value={saisie.poste} onChange={(e) => setSaisie({ ...saisie, poste: e.target.value })}>
                    {options.postes.map((p) => (
                      <option key={p.id} value={p.id}>{p.libelle}</option>
                    ))}
                  </select>
                </Champ>
              ) : (
                <Champ label={saisie.type === 'sortie' ? 'Vers' : 'Depuis'}>
                  <select value={saisie.compte} onChange={(e) => setSaisie({ ...saisie, compte: e.target.value })} required>
                    <option value="">Choisir…</option>
                    {destinations.map((c) => (
                      <option key={c.id} value={c.id}>{c.nom}</option>
                    ))}
                  </select>
                </Champ>
              )}
            </div>
            <Champ label="Motif">
              <input
                value={saisie.motif}
                onChange={(e) => setSaisie({ ...saisie, motif: e.target.value })}
                required
                minLength={3}
                placeholder={saisie.type === 'depense' ? 'Sachets, transport, eau…' : saisie.type === 'sortie' ? 'Versement à la banque, remise au gérant…' : 'Monnaie pour le rendu…'}
              />
            </Champ>
            <Champ label="Référence" aide="Facultatif : n° de reçu, de bordereau…">
              <input value={saisie.reference} onChange={(e) => setSaisie({ ...saisie, reference: e.target.value })} maxLength={60} />
            </Champ>
            <p className="secondaire">Le montant est pris en compte dans les espèces attendues à la clôture.</p>
            <button className="bouton bouton-principal">Enregistrer</button>
          </form>
        )}
      </Fenetre>
    </>
  );
}
