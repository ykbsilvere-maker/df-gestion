import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { messageErreur } from '../../lib/format';
import { montant } from '../../lib/argent';
import { useSession } from '../../lib/session';
import { useIdentite } from '../../lib/identite';
import { useImpression } from '../../impression/impression';
import type { MoyenPaiement } from '../../caisse/local';
import type { VenteRecu } from '../../impression/Recu';
import { Alerte, Champ, Pastille, Vide } from '../../components/ui';
import { libellePaiement, STATUTS_PAIEMENT, type Paiement, type StatutCommande, type StatutPaiement } from './commun';
import { StatutCommandePastille, type DetailCommande } from './Boutique';
import { BonCommandeWeb } from './BonCommande';

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
  a_moi: boolean;
  caissier_nom: string | null;
}

const CODES: Record<Paiement, string> = { livraison: 'especes', wave: 'wave', orange_money: 'orange_money', mtn: 'mtn_momo', moov: 'moov_money', djamo: 'djamo', autre: '' };

/**
 * À la caisse : les commandes DF Marché à remettre au client (les retraits arrivent ici dès qu'ils sont
 * passés). La caissière vérifie le paiement Mobile Money sur le téléphone de la boutique, le confirme,
 * puis encaisse : la commande devient une vente de la session (stock, rapport de caisse, comptabilité)
 * et le ticket de caisse s'imprime. Les frais de livraison restent hors vente.
 */
/** Lignes du ticket : la remise du code promo répartie au prorata (le reste sur la dernière ligne). */
function repartirRemise(d: DetailCommande) {
  const total = Number(d.remise ?? 0);
  let reste = total;
  return d.lignes.map((l, i) => {
    const part = i === d.lignes.length - 1 ? reste : Math.floor((total * Number(l.montant)) / Math.max(1, Number(d.sous_total)));
    reste -= part;
    return { designation: l.designation, quantite: Number(l.quantite), prix_unitaire: Number(l.prix_unitaire), remise: part };
  });
}

export function CommandesCaisse({ org, sessionId, moyens, enLigne, onImprimer, commandeInitiale }: {
  org: string;
  /** Ouverte depuis la fiche d'une commande : elle est choisie d'office. */
  commandeInitiale?: string | null;
  sessionId: string;
  moyens: MoyenPaiement[];
  enLigne: boolean;
  /** Imprime le ticket de caisse de la vente créée (format du poste). */
  onImprimer?: (v: VenteRecu) => void | Promise<void>;
}) {
  const { peut } = useSession();
  const { identite } = useIdentite();
  const { imprimer } = useImpression();
  const [liste, setListe] = useState<Ligne[] | null>(null);
  const [choisie, setChoisie] = useState<Ligne | null>(null);
  const [detail, setDetail] = useState<DetailCommande | null>(null);
  const [capture, setCapture] = useState<string | null>(null);
  const [refus, setRefus] = useState<string | null>(null);
  const [moyen, setMoyen] = useState('');
  const [reference, setReference] = useState('');
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [coches, setCoches] = useState<Record<number, boolean>>({});
  const actifs = moyens.filter((m) => m.actif);

  const charger = useCallback(async () => {
    // Seulement les commandes affectées : la gérante choisit la caissière qui rassemble chaque commande.
    const { data, error } = await supabase.rpc('commandes_caisse', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    setListe((data as { commandes: Ligne[] }).commandes ?? []);
  }, [org]);
  useEffect(() => {
    if (enLigne) void charger();
  }, [charger, enLigne]);
  const dejaChoisie = useRef(false);
  useEffect(() => {
    if (dejaChoisie.current || !commandeInitiale || !liste) return;
    const c = liste.find((x) => x.id === commandeInitiale);
    if (c) {
      dejaChoisie.current = true;
      choisir(c);
    } else if (liste) {
      dejaChoisie.current = true;
      setErreur('Cette commande n’est pas dans vos commandes à remettre : elle doit vous être affectée par la gérante.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liste, commandeInitiale]);

  const chargerDetail = useCallback(async (id: string) => {
    const { data, error } = await supabase.rpc('commande_web_detail', { p_id: id });
    if (error) return setErreur(messageErreur(error));
    const d = data as DetailCommande;
    setDetail(d);
    setCapture(null);
    if (d.justificatif_path) {
      const { data: u } = await supabase.storage.from('justificatifs').createSignedUrl(d.justificatif_path, 3600);
      setCapture(u?.signedUrl ?? null);
    }
  }, []);

  function choisir(c: Ligne) {
    setChoisie(c);
    setCoches({});
    setDetail(null);
    setRefus(null);
    setErreur('');
    setInfo('');
    setReference('');
    setMoyen(actifs.find((m) => m.code === CODES[c.paiement])?.id ?? actifs.find((m) => m.nature === 'especes')?.id ?? actifs[0]?.id ?? '');
    void chargerDetail(c.id);
  }

  async function verifier(recu: boolean) {
    if (!choisie) return;
    setEnCours(true);
    setErreur('');
    const { error } = await supabase.rpc('verifier_paiement_commande', { p_id: choisie.id, p_recu: recu, p_motif: recu ? null : refus });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    setRefus(null);
    if (recu) {
      setInfo(`Paiement ${libellePaiement(choisie.paiement, detail?.paiement_libelle)} confirmé : vous pouvez remettre et encaisser.`);
      setChoisie({ ...choisie, paiement_statut: 'confirme' });
      await chargerDetail(choisie.id);
    } else {
      setInfo('Paiement signalé comme non reçu : le client le voit sur son suivi.');
      setChoisie(null);
    }
    await charger();
  }

  function imprimerBon() {
    if (detail) void imprimer(<BonCommandeWeb c={detail} o={identite?.organisation} logoUrl={identite?.logoUrl ?? null} />, 'a4');
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
    const m = actifs.find((x) => x.id === moyen);
    if (detail && onImprimer) {
      await onImprimer({
        numero: v.numero,
        date: new Date(),
        client: `${detail.client_nom} (${detail.numero})`,
        lignes: repartirRemise(detail),
        reglements: [{
          moyen: m?.libelle ?? libellePaiement(detail.paiement, detail.paiement_libelle),
          montant: Number(detail.sous_total) - Number(detail.remise ?? 0),
          reference: reference.trim() || detail.reference_paiement || detail.numero_payeur || undefined,
        }],
      });
    }
    setChoisie(null);
    setDetail(null);
    await charger();
  }

  const peutVerifier = (c: Ligne) => peut('boutique.valider') || c.a_moi;
  const toutCoche = !!detail && detail.lignes.every((_, i) => coches[i]);

  async function marquerPrete() {
    if (!choisie) return;
    setEnCours(true);
    setErreur('');
    const { error } = await supabase.rpc('avancer_commande_web', { p_id: choisie.id, p_statut: 'prete', p_motif: null });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    setInfo(`Commande ${choisie.numero} rassemblée et vérifiée : elle attend le client.`);
    setChoisie({ ...choisie, statut: 'prete' });
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
        <Vide>Aucune commande ne vous est affectée. La gérante choisit, dans « Boutique en ligne », la caissière qui rassemble chaque commande : vous recevez alors une notification.</Vide>
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
                      {!c.a_moi && c.caissier_nom ? ` · affectée à ${c.caissier_nom}` : ''}
                    </small>
                  </span>
                  <span className="credit-reste">
                    {montant(c.total)}
                    <StatutCommandePastille s={c.statut} />
                  </span>
                </button>
                {choisie?.id === c.id && (
                  <form className="formulaire credit-encaissement" onSubmit={encaisser}>
                    {detail && (
                      <div className="rassemblement">
                        <p className="rassemblement-titre">
                          <strong>🧺 Rassembler et vérifier</strong>
                          <span>{detail.lignes.filter((_, i) => coches[i]).length} / {detail.lignes.length}</span>
                        </p>
                        <ul>
                          {detail.lignes.map((l, i) => (
                            <li key={i} className={coches[i] ? 'coche' : ''}>
                              <label>
                                <input type="checkbox" checked={!!coches[i]} onChange={(e) => setCoches({ ...coches, [i]: e.target.checked })} />
                                <span className="rassemblement-qte">{Number(l.quantite)} ×</span>
                                <span>{l.designation}</span>
                                {Number(l.stock) < Number(l.quantite) && <Pastille ton="rouge">stock {Number(l.stock)}</Pastille>}
                              </label>
                            </li>
                          ))}
                        </ul>
                        {c.statut === 'confirmee' && (
                          <button type="button" className="bouton bouton-principal" disabled={enCours || !toutCoche} onClick={() => void marquerPrete()}>
                            ✅ Tout est rassemblé : commande prête
                          </button>
                        )}
                      </div>
                    )}
                    {bloquee ? (
                      <div className="verification-paiement">
                        <p>
                          <strong>Paiement {libellePaiement(c.paiement, detail?.paiement_libelle)}</strong>{' '}
                          <Pastille ton={STATUTS_PAIEMENT[c.paiement_statut].ton}>{STATUTS_PAIEMENT[c.paiement_statut].libelle}</Pastille>
                        </p>
                        {detail && (
                          <dl className="details-commande">
                            <dt>Montant attendu</dt><dd><strong>{montant(detail.total)}</strong></dd>
                            <dt>Payé depuis</dt><dd>{detail.numero_payeur ?? '—'}</dd>
                            <dt>Vers</dt><dd>{detail.numero_boutique ?? '—'}</dd>
                            {detail.reference_paiement && (<><dt>Référence</dt><dd>{detail.reference_paiement}</dd></>)}
                          </dl>
                        )}
                        {capture ? (
                          <a href={capture} target="_blank" rel="noreferrer" className="justificatif-paiement">
                            {detail?.justificatif_path?.endsWith('.pdf') ? '📄 Ouvrir la capture (PDF)' : <img src={capture} alt="Capture du paiement envoyée par le client" />}
                          </a>
                        ) : detail ? <p className="secondaire">Pas de capture jointe : vérifiez avec le numéro et la référence.</p> : null}
                        {peutVerifier(c) ? (
                          refus === null ? (
                            <>
                              <p className="secondaire">Vérifiez sur le téléphone de la boutique que la somme est arrivée, puis confirmez.</p>
                              <div className="actions-piece">
                                <button type="button" className="bouton bouton-principal" disabled={enCours} onClick={() => void verifier(true)}>✅ Paiement reçu</button>
                                <button type="button" className="bouton bouton-discret" onClick={() => setRefus('')}>Pas reçu</button>
                              </div>
                            </>
                          ) : (
                            <div className="grille-2">
                              <Champ label="Ce qui ne va pas (visible par le client)">
                                <input value={refus} onChange={(e) => setRefus(e.target.value)} minLength={3} maxLength={300} autoFocus placeholder="Montant non reçu sur le numéro Orange Money…" />
                              </Champ>
                              <div className="actions-piece">
                                <button type="button" className="bouton bouton-discret" onClick={() => setRefus(null)}>Retour</button>
                                <button type="button" className="bouton bouton-principal" disabled={enCours || refus.trim().length < 3} onClick={() => void verifier(false)}>Signaler</button>
                              </div>
                            </div>
                          )
                        ) : (
                          <Alerte>Le responsable doit d’abord confirmer ce paiement dans « Boutique en ligne ».</Alerte>
                        )}
                      </div>
                    ) : (
                      <>
                        <p className="secondaire">
                          {c.paiement === 'livraison'
                            ? <>Le client paie maintenant les articles{Number(detail?.remise) > 0 ? ` (code ${detail?.code_promo} : −${montant(detail?.remise)})` : ''}.
                              {detail?.especes_remis ? <span className="monnaie-a-preparer"> 💵 Il donnera <b>{montant(detail.especes_remis)}</b> : préparez <b>{montant(Number(detail.especes_remis) - Number(detail.sous_total) + Number(detail.remise ?? 0))}</b> de monnaie.</span> : null}</>
                            : <>Déjà payé par {libellePaiement(c.paiement, detail?.paiement_libelle)} <Pastille ton="vert">reçu</Pastille>{detail?.reference_paiement ? ` · réf. ${detail.reference_paiement}` : ''}</>}
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
                              <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} placeholder={detail?.reference_paiement ?? 'Numéro du payeur ou de la transaction'} />
                            </Champ>
                          )}
                        </div>
                      </>
                    )}
                    <div className="actions-piece">
                      <Link to={`/boutique/commandes/${c.id}`} className="bouton-lien">Voir la commande</Link>
                      <button type="button" className="bouton bouton-discret" disabled={!detail} onClick={imprimerBon}>🧾 {c.paiement_statut === 'confirme' ? 'Reçu' : 'Bon'} (copie)</button>
                      <button type="button" className="bouton bouton-discret" onClick={() => setChoisie(null)}>Fermer</button>
                      {!bloquee && (
                        <button className="bouton bouton-principal" disabled={enCours || (c.statut === 'confirmee' && !toutCoche)} title={c.statut === 'confirmee' && !toutCoche ? 'Cochez d’abord chaque article rassemblé' : undefined}>
                          Remettre et encaisser
                        </button>
                      )}
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
