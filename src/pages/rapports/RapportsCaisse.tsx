import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { useIdentite } from '../../lib/identite';
import { dateHeure, messageErreur } from '../../lib/format';
import { enUnites, montant } from '../../lib/argent';
import { useMagasins } from '../../lib/stock';
import { useMagasinGlobal } from '../../lib/magasinGlobal';
import { exporterClasseur, toutCharger, type FormatExport } from '../../lib/export';
import { RapportCaisse, type RapportSession } from '../../impression/RapportCaisse';
import { Recu, type VenteRecu } from '../../impression/Recu';
import { useImpressionCaisse } from '../../caisse/impressionCaisse';
import { BoutonsExport } from '../../components/Export';
import { Alerte, Champ, EnTetePage, Pastille, Vide } from '../../components/ui';

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
interface Ticket {
  id: string;
  numero: string;
  date_vente: string;
  total: number;
  statut: string;
  client_nom: string | null;
  magasin_id: string;
  caissier_id: string | null;
}

const moisCourant = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const moisSuivant = (m: string) => {
  const [a, b] = m.split('-').map(Number) as [number, number];
  return b === 12 ? `${a + 1}-01` : `${a}-${String(b + 1).padStart(2, '0')}`;
};
const nomMois = (m: string) => new Date(`${m}-15T12:00:00`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

/**
 * Rapports de caisse à la demande : rien n'est archivé en fichier, tout se régénère depuis les
 * données (rapports Z des mois passés, récapitulatif mensuel, reçus des ventes déjà faites).
 */
export function RapportsCaisse() {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const { identite } = useIdentite();
  const { imprimerA4 } = useImpressionCaisse();
  const magasins = useMagasins(org);
  const magasinGlobal = useMagasinGlobal();
  const [onglet, setOnglet] = useState<'clotures' | 'recus'>('clotures');
  const [mois, setMois] = useState(moisCourant());
  const [clotures, setClotures] = useState<Cloture[]>([]);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [caissiers, setCaissiers] = useState<Record<string, string>>({});
  const [terme, setTerme] = useState('');
  const [affiches, setAffiches] = useState(100);
  const [erreur, setErreur] = useState('');
  const [occupe, setOccupe] = useState('');

  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase.rpc('historique_clotures', { p_org: org, p_limite: 500 });
      if (error) return setErreur(messageErreur(error));
      setClotures((data ?? []) as Cloture[]);
    })();
  }, [org]);

  const chargerTickets = useCallback(async () => {
    setTickets(null);
    setErreur('');
    try {
      const liste = await toutCharger<Ticket>((d, f) => {
        let q = supabase
          .from('ventes')
          .select('id, numero, date_vente, total, statut, client_nom, magasin_id, caissier_id')
          .eq('organisation_id', org)
          .gte('date_vente', `${mois}-01T00:00:00Z`)
          .lt('date_vente', `${moisSuivant(mois)}-01T00:00:00Z`)
          .order('date_vente', { ascending: false })
          .range(d, f);
        if (magasinGlobal) q = q.eq('magasin_id', magasinGlobal);
        return q;
      });
      setTickets(liste);
      setAffiches(100);
      const ids = [...new Set(liste.map((t) => t.caissier_id).filter((x): x is string => !!x))];
      if (ids.length) {
        const { data } = await supabase.from('profils').select('id, nom_complet').in('id', ids.slice(0, 200));
        setCaissiers(Object.fromEntries(((data ?? []) as { id: string; nom_complet: string }[]).map((p) => [p.id, p.nom_complet])));
      }
    } catch (e) {
      setErreur(messageErreur(e));
      setTickets([]);
    }
  }, [org, mois, magasinGlobal]);
  useEffect(() => {
    if (onglet === 'recus') void chargerTickets();
  }, [onglet, chargerTickets]);

  const duMois = useMemo(() => clotures.filter((c) => c.cloturee_le?.slice(0, 7) === mois).sort((a, b) => a.cloturee_le.localeCompare(b.cloturee_le)), [clotures, mois]);
  const totalMois = {
    tickets: duMois.reduce((s, c) => s + Number(c.nombre_ventes ?? 0), 0),
    ventes: duMois.reduce((s, c) => s + Number(c.total_ventes ?? 0), 0),
    attendues: duMois.reduce((s, c) => s + Number(c.especes_attendues ?? 0), 0),
    comptees: duMois.reduce((s, c) => s + Number(c.especes_comptees ?? 0), 0),
    ecart: duMois.reduce((s, c) => s + Number(c.ecart ?? 0), 0),
  };
  const nomMagasin = (id: string) => magasins.find((m) => m.id === id)?.nom ?? '';
  const filtres = (tickets ?? []).filter((t) => !terme || `${t.numero} ${t.client_nom ?? ''}`.toLowerCase().includes(terme.toLowerCase()));

  async function rapportZ(c: Cloture) {
    if (!identite) return;
    setOccupe(c.id);
    const { data, error } = await supabase.rpc('rapport_session', { p_session: c.id });
    setOccupe('');
    if (error) return setErreur(messageErreur(error));
    await imprimerA4(
      <RapportCaisse identite={identite} rapport={data as RapportSession} format="thermique_80" caisse={c.caisse} caissier={c.caissier ?? undefined} ouverteLe={c.ouverte_le} />,
    );
  }

  async function recapitulatif() {
    await imprimerA4(
      <div className="recap-caisse">
        <header>
          <strong>{identite?.organisation.nom ?? organisation!.nom}</strong>
          <h1>Récapitulatif des caisses — {nomMois(mois)}</h1>
          <p>
            {duMois.length} clôture{duMois.length > 1 ? 's' : ''} · édité le {dateHeure(new Date().toISOString())}
          </p>
        </header>
        <table>
          <thead>
            <tr>
              <th>Z n°</th><th>Caisse</th><th>Caissier</th><th>Clôturée le</th><th className="n">Tickets</th><th className="n">Ventes</th>
              <th className="n">Espèces attendues</th><th className="n">Espèces comptées</th><th className="n">Écart</th>
            </tr>
          </thead>
          <tbody>
            {duMois.map((c) => (
              <tr key={c.id}>
                <td>{c.numero_z}</td><td>{c.caisse}</td><td>{c.caissier ?? ''}</td><td>{dateHeure(c.cloturee_le)}</td>
                <td className="n">{Number(c.nombre_ventes ?? 0)}</td><td className="n">{montant(Number(c.total_ventes ?? 0))}</td>
                <td className="n">{montant(c.especes_attendues)}</td><td className="n">{montant(c.especes_comptees)}</td><td className="n">{montant(c.ecart)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>Total du mois</td>
              <td className="n">{totalMois.tickets}</td><td className="n">{montant(totalMois.ventes)}</td>
              <td className="n">{montant(totalMois.attendues)}</td><td className="n">{montant(totalMois.comptees)}</td><td className="n">{montant(totalMois.ecart)}</td>
            </tr>
          </tfoot>
        </table>
        <div className="rapport-signatures">
          <div><strong>Le caissier / La caissière</strong><span>&nbsp;</span><i>Nom, date et signature</i></div>
          <div><strong>Le gérant</strong><span>&nbsp;</span><i>Nom, date et signature</i></div>
        </div>
      </div>,
    );
  }

  function exporterClotures(format: FormatExport) {
    exporterClasseur(
      `clotures-caisse-${mois}`,
      [
        {
          nom: 'Clôtures',
          titre: [`Clôtures de caisse — ${nomMois(mois)}`],
          entetes: ['Z n°', 'Caisse', 'Caissier', 'Ouverte le', 'Clôturée le', 'Tickets', 'Ventes', 'Espèces attendues', 'Espèces comptées', 'Écart', 'Motif de l’écart'],
          lignes: duMois.map((c) => [c.numero_z, c.caisse, c.caissier, dateHeure(c.ouverte_le), dateHeure(c.cloturee_le), Number(c.nombre_ventes ?? 0), enUnites(Number(c.total_ventes ?? 0)), enUnites(c.especes_attendues), enUnites(c.especes_comptees), enUnites(c.ecart), c.motif_ecart]),
          totaux: ['Total', '', '', '', '', totalMois.tickets, enUnites(totalMois.ventes), enUnites(totalMois.attendues), enUnites(totalMois.comptees), enUnites(totalMois.ecart), ''],
          largeurs: [8, 16, 22, 18, 18, 9, 14, 16, 16, 12, 28],
        },
      ],
      format,
    );
  }

  function exporterTickets(format: FormatExport) {
    exporterClasseur(
      `tickets-${mois}`,
      [
        {
          nom: 'Tickets',
          titre: [`Tickets de caisse — ${nomMois(mois)}`, magasinGlobal ? nomMagasin(magasinGlobal) : 'Tous les magasins'],
          entetes: ['Ticket', 'Date', 'Magasin', 'Caissier', 'Client', 'Statut', 'Total'],
          lignes: filtres.map((t) => [t.numero, dateHeure(t.date_vente), nomMagasin(t.magasin_id), t.caissier_id ? caissiers[t.caissier_id] ?? '' : '', t.client_nom, t.statut === 'annulee' ? 'Annulé' : 'Validé', enUnites(t.total)]),
          totaux: ['Total (hors annulés)', '', '', '', '', '', enUnites(filtres.filter((t) => t.statut !== 'annulee').reduce((s, t) => s + Number(t.total), 0))],
          largeurs: [16, 18, 22, 22, 22, 10, 14],
        },
      ],
      format,
    );
  }

  /** Reçu d'une vente déjà faite : régénéré à partir des lignes et des règlements enregistrés. */
  async function recu(t: Ticket) {
    if (!identite) return;
    setOccupe(t.id);
    const [l, r] = await Promise.all([
      supabase.from('ventes_lignes').select('ligne, designation, quantite, prix_unitaire, remise').eq('vente_id', t.id).order('ligne'),
      supabase.from('reglements').select('libelle, montant, montant_recu, reference, statut').eq('vente_id', t.id),
    ]);
    setOccupe('');
    if (l.error || r.error) return setErreur(messageErreur(l.error ?? r.error));
    const vente: VenteRecu = {
      numero: t.numero,
      date: new Date(t.date_vente),
      caissier: t.caissier_id ? caissiers[t.caissier_id] : undefined,
      magasin: nomMagasin(t.magasin_id) || undefined,
      client: t.client_nom ?? undefined,
      lignes: ((l.data ?? []) as { designation: string; quantite: number; prix_unitaire: number; remise: number }[]).map((x) => ({
        designation: x.designation,
        quantite: Number(x.quantite),
        prix_unitaire: Number(x.prix_unitaire),
        remise: Number(x.remise) || undefined,
      })),
      reglements: ((r.data ?? []) as { libelle: string; montant: number; montant_recu: number | null; reference: string | null; statut: string }[])
        .filter((x) => x.statut !== 'annule')
        .map((x) => ({ moyen: x.libelle, montant: Number(x.montant), montant_recu: x.montant_recu == null ? undefined : Number(x.montant_recu), reference: x.reference ?? undefined })),
    };
    await imprimerA4(
      <>
        <p className="duplicata">
          DUPLICATA{t.statut === 'annulee' ? ' — VENTE ANNULÉE' : ''} · réédité le {dateHeure(new Date().toISOString())}
        </p>
        <Recu identite={identite} vente={vente} format="thermique_80" />
      </>,
    );
  }

  return (
    <>
      <EnTetePage
        icone="🧾"
        titre="Rapports de caisse"
        sousTitre="Retrouvez et réimprimez à tout moment les rapports de clôture (Z) des mois passés, le récapitulatif du mois et le reçu de n’importe quelle vente. Rien n’est à conserver : tout se régénère."
        actions={
          <Champ label="Mois">
            <input type="month" value={mois} max={moisCourant()} onChange={(e) => e.target.value && setMois(e.target.value)} />
          </Champ>
        }
      />
      <nav className="onglets onglets-compacts" role="tablist">
        <button type="button" role="tab" aria-selected={onglet === 'clotures'} className={onglet === 'clotures' ? 'actif' : ''} onClick={() => setOnglet('clotures')}>
          🔒 Clôtures (rapports Z)
        </button>
        <button type="button" role="tab" aria-selected={onglet === 'recus'} className={onglet === 'recus' ? 'actif' : ''} onClick={() => setOnglet('recus')}>
          🧾 Reçus des ventes
        </button>
      </nav>
      <Alerte>{erreur}</Alerte>

      {onglet === 'clotures' && (
        <section className="carte">
          <div className="filtres-ligne">
            <strong>
              {duMois.length} clôture{duMois.length > 1 ? 's' : ''} en {nomMois(mois)} · {montant(totalMois.ventes)}
            </strong>
            <div className="actions-entete">
              <button type="button" className="bouton bouton-principal" disabled={!duMois.length} onClick={() => void recapitulatif()}>
                🖨️ Récapitulatif du mois (A4)
              </button>
              <BoutonsExport onExport={exporterClotures} disabled={!duMois.length} />
            </div>
          </div>
          {duMois.length === 0 ? (
            <Vide>Aucune caisse clôturée ce mois-là.</Vide>
          ) : (
            <div className="defilement-horizontal">
              <table className="tableau">
                <thead>
                  <tr>
                    <th>Z n°</th><th>Caisse</th><th>Caissier</th><th>Clôturée le</th><th className="nombre">Tickets</th><th className="nombre">Ventes</th><th className="nombre">Écart</th><th />
                  </tr>
                </thead>
                <tbody>
                  {duMois.map((c) => (
                    <tr key={c.id}>
                      <td><strong>{c.numero_z}</strong></td>
                      <td>{c.caisse}</td>
                      <td>{c.caissier ?? '—'}</td>
                      <td>{dateHeure(c.cloturee_le)}</td>
                      <td className="nombre">{Number(c.nombre_ventes ?? 0)}</td>
                      <td className="nombre">{montant(Number(c.total_ventes ?? 0))}</td>
                      <td className={`nombre ${Number(c.ecart) !== 0 ? 'texte-negatif' : ''}`}>{montant(c.ecart)}</td>
                      <td>
                        <button type="button" className="bouton bouton-discret bouton-petit" disabled={occupe === c.id} onClick={() => void rapportZ(c)}>
                          {occupe === c.id ? '…' : '🖨️ Rapport Z'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="secondaire petit-texte">Chaque rapport Z se termine par les cadres de signature du caissier (ou de la caissière) et du gérant.</p>
        </section>
      )}

      {onglet === 'recus' && (
        <section className="carte">
          <div className="filtres-ligne">
            <input type="search" value={terme} onChange={(e) => { setTerme(e.target.value); setAffiches(100); }} placeholder="Numéro de ticket ou client…" aria-label="Chercher un ticket" />
            <div className="actions-entete">
              <BoutonsExport onExport={exporterTickets} disabled={!filtres.length} />
            </div>
          </div>
          {tickets === null ? (
            <p className="secondaire">Chargement des tickets…</p>
          ) : filtres.length === 0 ? (
            <Vide>Aucune vente trouvée pour {nomMois(mois)}.</Vide>
          ) : (
            <>
              <div className="defilement-horizontal">
                <table className="tableau">
                  <thead>
                    <tr><th>Ticket</th><th>Date</th><th>Magasin</th><th>Caissier</th><th>Client</th><th className="nombre">Total</th><th /></tr>
                  </thead>
                  <tbody>
                    {filtres.slice(0, affiches).map((t) => (
                      <tr key={t.id}>
                        <td><strong>{t.numero}</strong> {t.statut === 'annulee' && <Pastille ton="rouge">Annulé</Pastille>}</td>
                        <td>{dateHeure(t.date_vente)}</td>
                        <td>{nomMagasin(t.magasin_id)}</td>
                        <td>{t.caissier_id ? caissiers[t.caissier_id] ?? '—' : '—'}</td>
                        <td>{t.client_nom ?? ''}</td>
                        <td className="nombre">{montant(t.total)}</td>
                        <td>
                          <button type="button" className="bouton bouton-discret bouton-petit" disabled={occupe === t.id} onClick={() => void recu(t)}>
                            {occupe === t.id ? '…' : '🧾 Reçu'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pagination">
                <span>
                  {Math.min(affiches, filtres.length).toLocaleString('fr-FR')} sur {filtres.length.toLocaleString('fr-FR')} ticket{filtres.length > 1 ? 's' : ''}
                </span>
                {filtres.length > affiches && (
                  <>
                    <button type="button" className="bouton bouton-discret" onClick={() => setAffiches(affiches + 200)}>Suivants</button>
                    <button type="button" className="bouton bouton-principal" onClick={() => setAffiches(filtres.length)}>Tout afficher</button>
                  </>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
