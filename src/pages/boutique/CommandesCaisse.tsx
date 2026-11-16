import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { messageErreur } from '../../lib/format';
import { montant } from '../../lib/argent';
import type { MoyenPaiement } from '../../caisse/local';
import { Alerte, Champ, Pastille, Vide } from '../../components/ui';
import { PAIEMENTS, STATUTS_PAIEMENT, type Paiement, type StatutCommande, type StatutPaiement } from './commun';
import { StatutCommandePastille } from './Boutique';

interface Ligne {
  id: string;
  numero: string;
  client_nom: string;
  client_telephone: string;
  mode: 'livraison' | 'retrait';
  zone: string | null;
  total: number;
  paiement: Paiement;
  paiement_statut: StatutPaiement;
  statut: StatutCommande;
  articles: number;
}

const CODES: Record<Paiement, string> = { livraison: 'especes', wave: 'wave', orange_money: 'orange_money', mtn: 'mtn_momo', moov: 'moov_money' };

/**
 * À la caisse : les commandes DF Marché confirmées à remettre au client. L'encaissement en fait une
 * vente de la session (stock, rapport de caisse, comptabilité). Les frais de livraison restent hors vente.
 */
export function CommandesCaisse({ org, sessionId, moyens, enLigne }: { org: string; sessionId: string; moyens: MoyenPaiement[]; enLigne: boolean }) {
  const [liste, setListe] = useState<Ligne[] | null>(null);
  const [choisie, setChoisie] = useState<Ligne | null>(null);
  const [moyen, setMoyen] = useState('');
  const [reference, setReference] = useState('');
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [enCours, setEnCours] = useState(false);
  const actifs = moyens.filter((m) => m.actif);

  const charger = useCallback(async () => {
    const { data, error } = await supabase.rpc('commandes_web_liste', { p_org: org, p_statut: 'en_cours' });
    if (error) return setErreur(messageErreur(error));
    setListe(((data as { commandes: Ligne[] }).commandes ?? []).filter((c) => c.statut !== 'nouvelle'));
  }, [org]);
  useEffect(() => {
    if (enLigne) void charger();
  }, [charger, enLigne]);

  function choisir(c: Ligne) {
    setChoisie(c);
    setErreur('');
    setInfo('');
    setReference('');
    setMoyen(actifs.find((m) => m.code === CODES[c.paiement])?.id ?? actifs.find((m) => m.nature === 'especes')?.id ?? actifs[0]?.id ?? '');
  }

  async function encaisser(e: FormEvent) {
    e.preventDefault();
    if (!choisie) return;
    setEnCours(true);
    setErreur('');
    const { data, error } = await supabase.rpc('encaisser_commande_web', {
      p_id: choisie.id, p_session: sessionId, p_moyen: moyen || null, p_reference: reference.trim() || null,
    });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    const v = data as { numero: string; total: number };
    setInfo(`Commande ${choisie.numero} remise et encaissée : ticket ${v.numero} (${montant(v.total)}).`);
    setChoisie(null);
    await charger();
  }

  if (!enLigne) return <Alerte type="info">Les commandes en ligne s’encaissent avec le réseau : reconnectez l’appareil.</Alerte>;

  return (
    <div className="credits-caisse">
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      {!liste ? (
        <Vide>Chargement…</Vide>
      ) : liste.length === 0 ? (
        <Vide>Aucune commande confirmée à remettre. Les nouvelles commandes se confirment dans « Boutique en ligne ».</Vide>
      ) : (
        <ul className="liste-credits-caisse">
          {liste.map((c) => {
            const bloquee = c.paiement !== 'livraison' && c.paiement_statut !== 'confirme';
            return (
              <li key={c.id} className={choisie?.id === c.id ? 'choisi' : ''}>
                <button type="button" className="credit-ligne" onClick={() => choisir(c)}>
                  <span>
                    <strong>{c.client_nom}</strong>
                    <small>
                      {c.numero} · {c.mode === 'livraison' ? `🛵 ${c.zone ?? ''}` : '🏪 retrait'} · {c.articles} article(s)
                    </small>
                  </span>
                  <span className="credit-reste">
                    {montant(c.total)}
                    <StatutCommandePastille s={c.statut} />
                  </span>
                </button>
                {choisie?.id === c.id && (
                  <form className="formulaire credit-encaissement" onSubmit={encaisser}>
                    {bloquee ? (
                      <Alerte>
                        Paiement {PAIEMENTS[c.paiement].libelle} : {STATUTS_PAIEMENT[c.paiement_statut].libelle.toLowerCase()}. Le responsable doit
                        d’abord le confirmer dans « Boutique en ligne ».
                      </Alerte>
                    ) : (
                      <>
                        <p className="secondaire">
                          {c.paiement === 'livraison'
                            ? 'Le client paie maintenant les articles.'
                            : <>Déjà payé par {PAIEMENTS[c.paiement].libelle} <Pastille ton="vert">reçu</Pastille></>}
                          {c.mode === 'livraison' && ' Les frais de livraison ne passent pas en caisse.'}
                        </p>
                        <div className="grille-2">
                          <Champ label="Encaissé par">
                            <select value={moyen} onChange={(e) => setMoyen(e.target.value)} required>
                              {actifs.map((m) => <option key={m.id} value={m.id}>{m.libelle}</option>)}
                            </select>
                          </Champ>
                          {actifs.find((m) => m.id === moyen)?.nature !== 'especes' && (
                            <Champ label="Référence">
                              <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} placeholder="Numéro du payeur ou de la transaction" />
                            </Champ>
                          )}
                        </div>
                      </>
                    )}
                    <div className="actions-piece">
                      <Link to={`/boutique/commandes/${c.id}`} className="bouton-lien">Voir la commande</Link>
                      <button type="button" className="bouton bouton-discret" onClick={() => setChoisie(null)}>Fermer</button>
                      {!bloquee && <button className="bouton bouton-principal" disabled={enCours}>Remettre et encaisser</button>}
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
