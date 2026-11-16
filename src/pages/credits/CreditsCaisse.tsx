import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { useIdentite } from '../../lib/identite';
import { messageErreur } from '../../lib/format';
import { clavierMontant, lireMontant, montant } from '../../lib/argent';
import { useImpression } from '../../impression/impression';
import type { MoyenPaiement } from '../../caisse/local';
import { Alerte, Champ, Vide } from '../../components/ui';
import { RecuReglement, type DetailCredit, type DossierCredit } from './documents';
import { Echeance, EtapePastille } from './Credits';

/**
 * À la caisse : les crédits dont la caissière assure le suivi (tous pour un responsable).
 * Un règlement en espèces entre dans le tiroir et compte dans les espèces attendues à la clôture.
 */
export function CreditsCaisse({ org, sessionId, moyens, enLigne }: { org: string; sessionId: string; moyens: MoyenPaiement[]; enLigne: boolean }) {
  const { session } = useSession();
  const { identite } = useIdentite();
  const { imprimer } = useImpression();
  const [dossiers, setDossiers] = useState<DossierCredit[] | null>(null);
  const [toutVoir, setToutVoir] = useState(false);
  const [voirTout, setVoirTout] = useState(false);
  const [choisi, setChoisi] = useState<DossierCredit | null>(null);
  const [form, setForm] = useState({ montant: '', moyen: '', reference: '' });
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [enCours, setEnCours] = useState(false);
  const actifs = moyens.filter((m) => m.actif);

  const charger = useCallback(async () => {
    const { data, error } = await supabase.rpc('credits_liste', { p_org: org, p_magasin: null });
    if (error) return setErreur(messageErreur(error));
    const r = data as { dossiers: DossierCredit[]; tout_voir: boolean };
    setToutVoir(r.tout_voir);
    setDossiers(r.dossiers.filter((d) => d.statut === 'valide' && Number(d.reste) > 0));
  }, [org]);
  useEffect(() => {
    if (enLigne) void charger();
  }, [charger, enLigne]);

  const visibles = (dossiers ?? []).filter((d) => voirTout || d.moi);

  function choisir(d: DossierCredit) {
    setChoisi(d);
    setErreur('');
    setInfo('');
    setForm({ montant: montant(d.reste, ''), moyen: actifs.find((m) => m.nature === 'especes')?.id ?? actifs[0]?.id ?? '', reference: '' });
  }

  async function encaisser(e: FormEvent) {
    e.preventDefault();
    if (!choisi) return;
    const m = lireMontant(form.montant);
    if (!m || m <= 0) return setErreur('Indiquez le montant reçu.');
    setEnCours(true);
    setErreur('');
    const { data, error } = await supabase.rpc('encaisser_credit', {
      p_credit: choisi.id,
      p_montant: m,
      p_moyen: form.moyen,
      p_session: sessionId,
      p_reference: form.reference.trim() || null,
    });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    const reste = Number((data as { reste: number }).reste);
    const moyen = actifs.find((x) => x.id === form.moyen);
    setInfo(`${montant(m)} reçus de ${choisi.client} (${choisi.numero}).${reste === 0 ? ' Crédit soldé.' : ` Reste ${montant(reste)}.`}${moyen?.nature === 'especes' ? ' Les espèces comptent dans votre tiroir.' : ''}`);
    const credit = choisi;
    setChoisi(null);
    await charger();
    const detail = await supabase.rpc('credit_detail', { p_credit: credit.id });
    if (!detail.error && window.confirm('Imprimer le reçu de règlement pour le client ?')) {
      await imprimer(
        <RecuReglement
          d={detail.data as DetailCredit}
          o={identite?.organisation}
          logoUrl={identite?.logoUrl ?? null}
          reglement={{ montant: m, moyen: moyen?.libelle ?? '', reference: form.reference.trim() || null, reste, par: session?.user.user_metadata?.nom_complet ?? '' }}
        />,
        'a4',
      );
    }
  }

  if (!enLigne) return <Alerte type="info">Les crédits clients s’encaissent avec le réseau : reconnectez l’appareil.</Alerte>;

  return (
    <div className="credits-caisse">
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      {toutVoir && (
        <div className="segments" role="tablist" aria-label="Dossiers affichés">
          <button type="button" role="tab" aria-selected={!voirTout} className={!voirTout ? 'actif' : ''} onClick={() => setVoirTout(false)}>Mes dossiers</button>
          <button type="button" role="tab" aria-selected={voirTout} className={voirTout ? 'actif' : ''} onClick={() => setVoirTout(true)}>Tous les crédits</button>
        </div>
      )}
      {!dossiers ? (
        <Vide>Chargement…</Vide>
      ) : visibles.length === 0 ? (
        <Vide>Aucun crédit à encaisser{voirTout ? '' : ' parmi les dossiers qui vous sont confiés'}.</Vide>
      ) : (
        <ul className="liste-credits-caisse">
          {visibles.map((d) => (
            <li key={d.id} className={choisi?.id === d.id ? 'choisi' : ''}>
              <button type="button" className="credit-ligne" onClick={() => choisir(d)}>
                <span>
                  <strong>{d.client}</strong>
                  <small>{d.numero} · <Echeance d={d} /></small>
                </span>
                <span className="credit-reste">
                  {montant(d.reste)}
                  {d.jours_retard > 0 && <EtapePastille etape={d.etape} />}
                </span>
              </button>
              {choisi?.id === d.id && (
                <form className="formulaire credit-encaissement" onSubmit={encaisser}>
                  <div className="grille-2">
                    <Champ label="Montant reçu">
                      <input value={form.montant} onChange={(e) => setForm({ ...form, montant: e.target.value })} inputMode={clavierMontant()} required autoFocus />
                    </Champ>
                    <Champ label="Moyen de paiement">
                      <select value={form.moyen} onChange={(e) => setForm({ ...form, moyen: e.target.value })} required>
                        {actifs.map((m) => (
                          <option key={m.id} value={m.id}>{m.libelle}</option>
                        ))}
                      </select>
                    </Champ>
                  </div>
                  {actifs.find((m) => m.id === form.moyen)?.nature !== 'especes' && (
                    <Champ label="Référence de la transaction">
                      <input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} maxLength={60} />
                    </Champ>
                  )}
                  <div className="actions-piece">
                    <Link to={`/credits/${d.id}`} className="bouton-lien">Voir le dossier</Link>
                    <button type="button" className="bouton bouton-discret" onClick={() => setChoisi(null)}>Fermer</button>
                    <button className="bouton bouton-principal" disabled={enCours}>Encaisser</button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
