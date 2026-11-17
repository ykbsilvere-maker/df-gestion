import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { useMagasins } from '../../lib/stock';
import { messageErreur } from '../../lib/format';
import { clavierMontant, lireMontant, montant } from '../../lib/argent';
import { Alerte, Champ, EnTetePage, Fenetre, MontantFort, Pastille, Vide } from '../../components/ui';
import { Vignette, reduire } from '../../components/PhotoProduit';
import { useIdentite } from '../../lib/identite';
import { useImpression } from '../../impression/impression';
import { BonCommandeWeb } from './BonCommande';
import {
  PAIEMENTS,
  STATUTS,
  STATUTS_PAIEMENT,
  lienWhatsapp,
  marcheUrl,
  messageClient,
  type Paiement,
  libellePaiement,
  type StatutCommande,
  type StatutPaiement,
} from './commun';

/* ==========================================================================================
 * Module « Boutique en ligne » : les commandes reçues sur DF Marché, les produits publiés
 * et la vitrine de la boutique (présentation, photos, localisation, paiement, livraison).
 * ======================================================================================== */

export function BoutiqueModule() {
  const { peut } = useSession();
  return (
    <>
      <nav className="onglets" aria-label="Boutique en ligne">
        <NavLink to="/boutique" end>
          <span className="onglet-icone" aria-hidden>🛍️</span>Commandes
        </NavLink>
        <NavLink to="/boutique/produits">
          <span className="onglet-icone" aria-hidden>🏷️</span>Produits en ligne
        </NavLink>
        {peut('boutique.modifier') && (
          <NavLink to="/boutique/vitrine">
            <span className="onglet-icone" aria-hidden>🏪</span>Ma vitrine
          </NavLink>
        )}
      </nav>
      <Outlet />
    </>
  );
}

/* ------------------------------------------------------------------------------------------
 * Commandes
 * ---------------------------------------------------------------------------------------- */

interface CommandeLigneListe {
  id: string;
  numero: string;
  client_nom: string;
  client_telephone: string;
  mode: 'livraison' | 'retrait';
  zone: string | null;
  souhaite_le: string | null;
  total: number;
  paiement: Paiement;
  paiement_statut: StatutPaiement;
  justificatif: boolean;
  statut: StatutCommande;
  created_at: string;
  articles: number;
}

const FILTRES: { cle: string; libelle: string }[] = [
  { cle: 'en_cours', libelle: 'À traiter' },
  { cle: 'nouvelle', libelle: 'Nouvelles' },
  { cle: 'livree', libelle: 'Livrées' },
  { cle: 'annulee', libelle: 'Annulées' },
  { cle: 'toutes', libelle: 'Toutes' },
];

const heure = (d: string | null) =>
  d ? new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export function StatutCommandePastille({ s }: { s: StatutCommande }) {
  const x = STATUTS[s];
  return <Pastille ton={x.ton}>{x.icone} {x.libelle}</Pastille>;
}

export function CommandesWeb() {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const [filtre, setFiltre] = useState('en_cours');
  const [donnees, setDonnees] = useState<{ commandes: CommandeLigneListe[]; compteurs: Record<string, number> | null; a_verifier: number } | null>(null);
  const [vitrine, setVitrine] = useState<{ slug: string; publiee: boolean } | null | undefined>(undefined);
  const [erreur, setErreur] = useState('');
  const [notif, setNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');

  const charger = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.rpc('commandes_web_liste', { p_org: org, p_statut: filtre === 'toutes' ? null : filtre }),
      supabase.rpc('vitrine_lire', { p_org: org }),
    ]);
    if (a.error) return setErreur(messageErreur(a.error));
    setDonnees(a.data as typeof donnees);
    if (!b.error) setVitrine(((b.data as { vitrine: { slug: string; publiee: boolean } | null }).vitrine) ?? null);
  }, [org, filtre]);
  useEffect(() => {
    void charger();
    const id = window.setInterval(() => void charger(), 45000);
    return () => window.clearInterval(id);
  }, [charger]);

  const cpt = donnees?.compteurs ?? {};
  const enCours = (cpt.nouvelle ?? 0) + (cpt.confirmee ?? 0) + (cpt.prete ?? 0) + (cpt.en_livraison ?? 0);
  const totalEnCours = (donnees?.commandes ?? []).filter((c) => !['livree', 'annulee'].includes(c.statut)).reduce((s, c) => s + Number(c.total), 0);

  return (
    <>
      <EnTetePage
        icone="🛍️"
        titre="Commandes en ligne"
        sousTitre="Les commandes passées sur DF Marché. Confirmez, préparez, livrez : l’encaissement se fait ensuite à la caisse."
        actions={
          <>
            {vitrine?.publiee && (
              <a className="bouton bouton-discret" href={marcheUrl(`/boutique/${vitrine.slug}`)} target="_blank" rel="noreferrer">
                🌐 Voir ma boutique
              </a>
            )}
            {notif === 'default' && (
              <button className="bouton bouton-discret" onClick={() => void Notification.requestPermission().then(setNotif)}>
                🔔 Être prévenu
              </button>
            )}
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      {vitrine === null && (
        <section className="carte appel-vitrine">
          <div>
            <h2>Votre boutique n’est pas encore en ligne</h2>
            <p className="secondaire">
              Présentez votre boutique, choisissez les produits à vendre en ligne et vos zones de livraison : vos clients commandent sur DF Marché,
              vous êtes prévenu ici.
            </p>
          </div>
          <Link className="bouton bouton-principal" to="/boutique/vitrine">Créer ma vitrine</Link>
        </section>
      )}
      <section className="tuiles">
        <div className={`tuile tuile-fixe ${(cpt.nouvelle ?? 0) > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur">{cpt.nouvelle ?? 0}</span>
          <span className="tuile-libelle">nouvelle{(cpt.nouvelle ?? 0) > 1 ? 's' : ''} à confirmer</span>
        </div>
        <div className={`tuile tuile-fixe ${(donnees?.a_verifier ?? 0) > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur">{donnees?.a_verifier ?? 0}</span>
          <span className="tuile-libelle">paiement{(donnees?.a_verifier ?? 0) > 1 ? 's' : ''} Mobile Money à vérifier</span>
        </div>
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur">{enCours}</span>
          <span className="tuile-libelle">en cours · <MontantFort v={totalEnCours} /></span>
        </div>
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur">{cpt.livree ?? 0}</span>
          <span className="tuile-libelle">livrée{(cpt.livree ?? 0) > 1 ? 's' : ''} au total</span>
        </div>
      </section>
      <section className="carte">
        <div className="filtres-ligne">
          <div className="segments" role="tablist" aria-label="Filtrer les commandes">
            {FILTRES.map((f) => (
              <button key={f.cle} type="button" role="tab" aria-selected={filtre === f.cle} className={filtre === f.cle ? 'actif' : ''} onClick={() => setFiltre(f.cle)}>
                {f.libelle}
              </button>
            ))}
          </div>
        </div>
        {!donnees ? (
          <Vide>Chargement…</Vide>
        ) : donnees.commandes.length === 0 ? (
          <Vide>{filtre === 'en_cours' ? 'Aucune commande à traiter pour le moment.' : 'Aucune commande.'}</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Commande</th>
                  <th>Client</th>
                  <th>Remise</th>
                  <th>Paiement</th>
                  <th className="nombre">Total</th>
                  <th>Étape</th>
                </tr>
              </thead>
              <tbody>
                {donnees.commandes.map((c) => (
                  <tr key={c.id} className={`ligne-cliquable ${c.statut === 'nouvelle' ? 'ligne-nouvelle' : ''}`} onClick={() => naviguer(`/boutique/commandes/${c.id}`)}>
                    <td>
                      <strong>{c.numero}</strong>
                      <div className="secondaire">{heure(c.created_at)} · {c.articles} article{Number(c.articles) > 1 ? 's' : ''}</div>
                    </td>
                    <td>
                      {c.client_nom}
                      <div className="secondaire">{c.client_telephone}</div>
                    </td>
                    <td>
                      {c.mode === 'livraison' ? `🛵 ${c.zone ?? 'Livraison'}` : '🏪 Retrait'}
                      <div className="secondaire">{c.souhaite_le ? `pour ${heure(c.souhaite_le)}` : 'dès que possible'}</div>
                    </td>
                    <td>
                      <span className="puce-paiement" style={{ borderColor: PAIEMENTS[c.paiement].couleur }}>{PAIEMENTS[c.paiement].libelle}</span>
                      {c.paiement !== 'livraison' && (
                        <div>
                          <Pastille ton={STATUTS_PAIEMENT[c.paiement_statut].ton}>{STATUTS_PAIEMENT[c.paiement_statut].libelle}</Pastille>
                          {c.justificatif && <span title="Capture du paiement jointe"> 📎</span>}
                        </div>
                      )}
                    </td>
                    <td className="nombre"><strong>{montant(c.total)}</strong></td>
                    <td><StatutCommandePastille s={c.statut} /></td>
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

export interface DetailCommande {
  id: string;
  organisation_id: string;
  numero: string;
  code_suivi: string;
  client_nom: string;
  client_telephone: string;
  client_email: string | null;
  mode: 'livraison' | 'retrait';
  zone_nom: string | null;
  adresse: string | null;
  repere: string | null;
  latitude: number | null;
  longitude: number | null;
  souhaite_le: string | null;
  note: string | null;
  sous_total: number;
  frais_livraison: number;
  total: number;
  paiement: Paiement;
  numero_payeur: string | null;
  reference_paiement: string | null;
  justificatif_path: string | null;
  paiement_statut: StatutPaiement;
  paiement_libelle?: string | null;
  statut: StatutCommande;
  motif: string | null;
  created_at: string;
  confirmee_le: string | null;
  prete_le: string | null;
  expediee_le: string | null;
  livree_le: string | null;
  annulee_le: string | null;
  lignes: { produit_id: string; designation: string; quantite: number; prix_unitaire: number; prix_normal: number; montant: number; stock: number }[];
  vente: { id: string; numero: string } | null;
  commandes_client: number;
  numero_boutique: string | null;
  paiement_confirme_le: string | null;
  confirme_par: string | null;
}

export function FicheCommandeWeb() {
  const { id } = useParams();
  const { peut, organisation } = useSession();
  const naviguer = useNavigate();
  const [c, setC] = useState<DetailCommande | null>(null);
  const [justificatif, setJustificatif] = useState<string | null>(null);
  const [nomBoutique, setNomBoutique] = useState(organisation?.nom ?? '');
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [motif, setMotif] = useState<null | { pour: 'annulee' | 'paiement'; texte: string }>(null);
  const [enCours, setEnCours] = useState(false);
  const peutValider = peut('boutique.valider');
  const { identite } = useIdentite();
  const { imprimer } = useImpression();

  const charger = useCallback(async () => {
    const { data, error } = await supabase.rpc('commande_web_detail', { p_id: id });
    if (error) return setErreur(messageErreur(error));
    const d = data as DetailCommande;
    setC(d);
    if (d.justificatif_path) {
      const { data: u } = await supabase.storage.from('justificatifs').createSignedUrl(d.justificatif_path, 3600);
      setJustificatif(u?.signedUrl ?? null);
    }
    const v = await supabase.rpc('vitrine_lire', { p_org: d.organisation_id });
    const nom = (v.data as { vitrine: { nom: string } | null } | null)?.vitrine?.nom;
    if (nom) setNomBoutique(nom);
  }, [id]);
  useEffect(() => {
    void charger();
  }, [charger]);

  async function avancer(statut: StatutCommande, m?: string) {
    if (!c) return;
    setEnCours(true);
    setErreur('');
    const { error } = await supabase.rpc('avancer_commande_web', { p_id: c.id, p_statut: statut, p_motif: m ?? null });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    setMotif(null);
    setInfo(`Commande ${STATUTS[statut].libelle.toLowerCase()}. Prévenez le client sur WhatsApp avec le bouton vert.`);
    await charger();
  }

  async function paiement(recu: boolean, m?: string) {
    if (!c) return;
    setEnCours(true);
    const { error } = await supabase.rpc('verifier_paiement_commande', { p_id: c.id, p_recu: recu, p_motif: m ?? null });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    setMotif(null);
    setInfo(recu ? 'Paiement confirmé.' : 'Paiement signalé comme non reçu : le client le voit sur son suivi.');
    await charger();
  }

  if (!c) return <EnTetePage titre="Commande" sousTitre={erreur || 'Chargement…'} />;
  const termine = c.statut === 'livree' || c.statut === 'annulee';
  const suivant: { statut: StatutCommande; libelle: string } | null =
    c.statut === 'nouvelle' ? { statut: 'confirmee', libelle: '👍 Confirmer la commande' }
    : c.statut === 'confirmee' ? { statut: 'prete', libelle: '📦 Commande prête' }
    : c.statut === 'prete' && c.mode === 'livraison' ? { statut: 'en_livraison', libelle: '🛵 Partie en livraison' }
    : null;
  const msg = messageClient({ ...c }, c.statut, nomBoutique, c.motif);
  const etapes: [string, string | null][] = [
    ['Reçue', c.created_at],
    ['Confirmée', c.confirmee_le],
    ['Prête', c.prete_le],
    ...(c.mode === 'livraison' ? ([['En livraison', c.expediee_le]] as [string, string | null][]) : []),
    [c.mode === 'livraison' ? 'Livrée' : 'Remise', c.livree_le],
  ];
  const ruptures = c.lignes.filter((l) => Number(l.stock) < Number(l.quantite));

  return (
    <>
      <EnTetePage
        icone={STATUTS[c.statut].icone}
        titre={`Commande ${c.numero}`}
        sousTitre={`${c.client_nom} · ${c.client_telephone} · reçue le ${heure(c.created_at)}`}
        actions={
          <>
            <button className="bouton bouton-discret" onClick={() => naviguer('/boutique')}>← Commandes</button>
            <a className="bouton bouton-whatsapp" href={lienWhatsapp(c.client_telephone, msg)} target="_blank" rel="noreferrer">
              WhatsApp au client
            </a>
            <a className="bouton bouton-discret" href={`tel:${c.client_telephone.replace(/\s/g, '')}`}>📞 Appeler</a>
            <button className="bouton bouton-discret" onClick={() => void imprimer(<BonCommandeWeb c={c} o={identite?.organisation} logoUrl={identite?.logoUrl ?? null} />, 'a4')}>
              🧾 {c.paiement_statut === 'confirme' ? 'Imprimer le reçu' : 'Imprimer le bon'}
            </button>
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      <section className="carte">
        <ol className="frise-commande">
          {etapes.map(([l, d], i) => (
            <li key={l} className={c.statut === 'annulee' ? 'annulee' : d ? 'faite' : i === etapes.findIndex(([, x]) => !x) ? 'courante' : ''}>
              <span className="frise-point" aria-hidden />
              <strong>{l}</strong>
              <small>{d ? heure(d) : ''}</small>
            </li>
          ))}
        </ol>
        {c.statut === 'annulee' && <p className="texte-negatif">Annulée le {heure(c.annulee_le)} — {c.motif}</p>}
        {!termine && peutValider && (
          <div className="actions-commande">
            {suivant && (
              <button className="bouton bouton-principal" disabled={enCours} onClick={() => void avancer(suivant.statut)}>{suivant.libelle}</button>
            )}
            {c.statut !== 'nouvelle' && (
              <span className="secondaire">
                {c.mode === 'livraison' ? 'À la livraison' : 'Au retrait'}, la caissière l’encaisse dans sa caisse (bouton « 🌐 Commandes en ligne ») :
                le stock sort et le reçu s’imprime.
              </span>
            )}
            <button className="bouton bouton-discret lien-danger" onClick={() => setMotif({ pour: 'annulee', texte: '' })}>Annuler la commande</button>
          </div>
        )}
        {c.vente && <p>Encaissée : ticket <strong>{c.vente.numero}</strong>.</p>}
      </section>

      <div className="grille-2 grille-commande">
        <section className="carte">
          <h2>Articles</h2>
          {ruptures.length > 0 && !termine && (
            <Alerte>Stock insuffisant pour : {ruptures.map((l) => l.designation).join(', ')}. Réapprovisionnez ou prévenez le client.</Alerte>
          )}
          <table className="tableau">
            <thead>
              <tr><th>Article</th><th className="nombre">Qté</th><th className="nombre">Prix</th><th className="nombre">Montant</th></tr>
            </thead>
            <tbody>
              {c.lignes.map((l) => (
                <tr key={l.produit_id}>
                  <td>
                    {l.designation}
                    <div className="secondaire">Stock : {Number(l.stock)}</div>
                  </td>
                  <td className="nombre">{Number(l.quantite)}</td>
                  <td className="nombre">
                    {montant(l.prix_unitaire)}
                    {Number(l.prix_unitaire) < Number(l.prix_normal) && <div className="secondaire prix-barre">{montant(l.prix_normal)}</div>}
                  </td>
                  <td className="nombre">{montant(l.montant)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td colSpan={3}>Articles</td><td className="nombre">{montant(c.sous_total)}</td></tr>
              {c.mode === 'livraison' && <tr><td colSpan={3}>Livraison ({c.zone_nom})</td><td className="nombre">{montant(c.frais_livraison)}</td></tr>}
              <tr className="ligne-total"><td colSpan={3}>Total</td><td className="nombre">{montant(c.total)}</td></tr>
            </tfoot>
          </table>
        </section>

        <div className="pile-boutique">
          <section className="carte">
            <h2>{c.mode === 'livraison' ? '🛵 Livraison' : '🏪 Retrait en boutique'}</h2>
            <dl className="details-commande">
              <dt>Client</dt>
              <dd>
                {c.client_nom} · <a href={`tel:${c.client_telephone}`}>{c.client_telephone}</a>
                {c.commandes_client > 0 && <div className="secondaire">Déjà {c.commandes_client} commande(s) livrée(s)</div>}
              </dd>
              {c.mode === 'livraison' && (
                <>
                  <dt>Adresse</dt>
                  <dd>
                    {c.zone_nom} — {c.adresse}
                    {c.repere && <div className="secondaire">Repère : {c.repere}</div>}
                    {c.latitude != null && c.longitude != null && (
                      <div><a href={`https://www.google.com/maps?q=${c.latitude},${c.longitude}`} target="_blank" rel="noreferrer">📍 Position sur la carte</a></div>
                    )}
                  </dd>
                </>
              )}
              <dt>Souhaitée</dt>
              <dd>{c.souhaite_le ? new Date(c.souhaite_le).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : 'Dès que possible'}</dd>
              {c.note && (<><dt>Note</dt><dd>{c.note}</dd></>)}
            </dl>
          </section>

          <section className="carte">
            <h2>Paiement : {libellePaiement(c.paiement, c.paiement_libelle)}</h2>
            {c.paiement === 'livraison' ? (
              <p className="secondaire">Le client paie à la {c.mode === 'livraison' ? 'livraison' : 'récupération'} ({montant(c.total)}).</p>
            ) : (
              <>
                <p>
                  <Pastille ton={STATUTS_PAIEMENT[c.paiement_statut].ton}>{STATUTS_PAIEMENT[c.paiement_statut].libelle}</Pastille>
                  {c.paiement_statut === 'confirme' && c.paiement_confirme_le && (
                    <span className="secondaire"> le {heure(c.paiement_confirme_le)}{c.confirme_par ? ` par ${c.confirme_par}` : ''}</span>
                  )}
                </p>
                <dl className="details-commande">
                  <dt>Payé depuis</dt><dd>{c.numero_payeur ?? '—'}</dd>
                  <dt>Vers</dt><dd>{c.numero_boutique ?? '—'} (numéro de la boutique)</dd>
                  {c.reference_paiement && (<><dt>Référence</dt><dd>{c.reference_paiement}</dd></>)}
                  <dt>Montant attendu</dt><dd><strong>{montant(c.total)}</strong></dd>
                </dl>
                {justificatif ? (
                  <a href={justificatif} target="_blank" rel="noreferrer" className="justificatif-paiement">
                    {c.justificatif_path?.endsWith('.pdf') ? '📄 Ouvrir le justificatif (PDF)' : <img src={justificatif} alt="Capture du paiement envoyée par le client" />}
                  </a>
                ) : (
                  <p className="secondaire">Pas encore de capture du paiement.</p>
                )}
                <p className="secondaire">Vérifiez sur le téléphone de la boutique que la somme est bien arrivée avant de confirmer.</p>
                {!termine && (peutValider || (c.mode === 'retrait' && peut('caisse.creer'))) && c.paiement_statut !== 'confirme' && (
                  <div className="actions-commande">
                    <button className="bouton bouton-principal" disabled={enCours} onClick={() => void paiement(true)}>✅ Paiement reçu</button>
                    <button className="bouton bouton-discret" onClick={() => setMotif({ pour: 'paiement', texte: '' })}>Pas reçu</button>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>

      <Fenetre titre={motif?.pour === 'annulee' ? 'Annuler la commande' : 'Paiement non reçu'} ouverte={!!motif} onFermer={() => setMotif(null)}>
        {motif && (
          <form
            className="formulaire"
            onSubmit={(e) => {
              e.preventDefault();
              if (motif.pour === 'annulee') void avancer('annulee', motif.texte);
              else void paiement(false, motif.texte);
            }}
          >
            <Champ label="Motif (visible par le client)">
              <input value={motif.texte} onChange={(e) => setMotif({ ...motif, texte: e.target.value })} required minLength={3} maxLength={300} autoFocus
                placeholder={motif.pour === 'annulee' ? 'Article en rupture, client injoignable…' : 'Montant non reçu sur le numéro Wave…'} />
            </Champ>
            <button className="bouton bouton-principal" disabled={enCours}>Valider</button>
          </form>
        )}
      </Fenetre>
    </>
  );
}

/* ------------------------------------------------------------------------------------------
 * Produits en ligne
 * ---------------------------------------------------------------------------------------- */

interface ProduitVitrine {
  id: string;
  code: string;
  designation: string;
  categorie: string | null;
  prix_vente: number;
  prix: number;
  photo: string | null;
  en_ligne: boolean;
  description_web: string | null;
  stock: number;
  disponible: number;
  commandes: number;
}

export function ProduitsEnLigne() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const modifier = peut('boutique.modifier');
  const [liste, setListe] = useState<ProduitVitrine[] | null>(null);
  const [filtre, setFiltre] = useState<'tous' | 'publies' | 'non' | 'sans_photo' | 'rupture'>('tous');
  const [recherche, setRecherche] = useState('');
  const [choix, setChoix] = useState<Set<string>>(new Set());
  const [edition, setEdition] = useState<ProduitVitrine | null>(null);
  const [texte, setTexte] = useState('');
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');

  const charger = useCallback(async () => {
    const { data, error } = await supabase.rpc('vitrine_produits', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    setListe(data as ProduitVitrine[]);
  }, [org]);
  useEffect(() => {
    void charger();
  }, [charger]);

  const visibles = useMemo(() => {
    const t = recherche.trim().toLowerCase();
    return (liste ?? []).filter((p) => {
      if (t && !`${p.designation} ${p.code} ${p.categorie ?? ''}`.toLowerCase().includes(t)) return false;
      switch (filtre) {
        case 'publies': return p.en_ligne;
        case 'non': return !p.en_ligne;
        case 'sans_photo': return p.en_ligne && !p.photo;
        case 'rupture': return p.en_ligne && Number(p.disponible) <= 0;
        default: return true;
      }
    });
  }, [liste, filtre, recherche]);

  async function publier(ids: string[], enLigne: boolean) {
    const { data, error } = await supabase.rpc('publier_produits', { p_org: org, p_produits: ids, p_en_ligne: enLigne });
    if (error) return setErreur(messageErreur(error));
    setInfo(`${data} produit(s) ${enLigne ? 'publié(s) sur DF Marché' : 'retiré(s) de DF Marché'}.`);
    setChoix(new Set());
    await charger();
  }

  async function enregistrerTexte(e: FormEvent) {
    e.preventDefault();
    if (!edition) return;
    const { error } = await supabase.rpc('description_produit_web', { p_produit: edition.id, p_texte: texte });
    if (error) return setErreur(messageErreur(error));
    setEdition(null);
    await charger();
  }

  const publies = (liste ?? []).filter((p) => p.en_ligne);
  const basculer = (id: string) => setChoix((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <>
      <EnTetePage
        icone="🏷️"
        titre="Produits en ligne"
        sousTitre="Choisissez ce qui est vendu sur DF Marché. Prix, soldes et stock viennent directement de DF Gestion : rien à ressaisir."
        actions={
          modifier && choix.size > 0 ? (
            <>
              <button className="bouton bouton-discret" onClick={() => void publier([...choix], false)}>Retirer ({choix.size})</button>
              <button className="bouton bouton-principal" onClick={() => void publier([...choix], true)}>Publier ({choix.size})</button>
            </>
          ) : undefined
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      <section className="tuiles">
        <div className="tuile tuile-fixe"><span className="tuile-valeur">{publies.length}</span><span className="tuile-libelle">produits en ligne sur {liste?.length ?? 0}</span></div>
        <div className={`tuile tuile-fixe ${publies.some((p) => !p.photo) ? 'tuile-alerte' : ''}`}><span className="tuile-valeur">{publies.filter((p) => !p.photo).length}</span><span className="tuile-libelle">sans photo (moins vendus)</span></div>
        <div className={`tuile tuile-fixe ${publies.some((p) => Number(p.disponible) <= 0) ? 'tuile-alerte' : ''}`}><span className="tuile-valeur">{publies.filter((p) => Number(p.disponible) <= 0).length}</span><span className="tuile-libelle">affichés « en rupture »</span></div>
      </section>
      <section className="carte">
        <div className="filtres-ligne">
          <div className="segments" role="tablist">
            {([['tous', 'Tous'], ['publies', 'En ligne'], ['non', 'Pas en ligne'], ['sans_photo', 'Sans photo'], ['rupture', 'En rupture']] as const).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={filtre === k} className={filtre === k ? 'actif' : ''} onClick={() => setFiltre(k)}>{l}</button>
            ))}
          </div>
          <input type="search" placeholder="Rechercher un produit…" value={recherche} onChange={(e) => setRecherche(e.target.value)} />
        </div>
        {!liste ? (
          <Vide>Chargement…</Vide>
        ) : visibles.length === 0 ? (
          <Vide>Aucun produit.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  {modifier && (
                    <th>
                      <input type="checkbox" aria-label="Tout choisir" checked={visibles.length > 0 && visibles.every((p) => choix.has(p.id))}
                        onChange={(e) => setChoix(e.target.checked ? new Set(visibles.map((p) => p.id)) : new Set())} />
                    </th>
                  )}
                  <th>Produit</th>
                  <th className="nombre">Prix en ligne</th>
                  <th className="nombre">Disponible</th>
                  <th className="nombre col-secondaire">Commandes</th>
                  <th>DF Marché</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((p) => (
                  <tr key={p.id}>
                    {modifier && <td><input type="checkbox" checked={choix.has(p.id)} onChange={() => basculer(p.id)} aria-label={`Choisir ${p.designation}`} /></td>}
                    <td>
                      <div className="produit-ligne">
                        <Vignette chemin={p.photo} taille={40} />
                        <div>
                          <strong>{p.designation}</strong>
                          <div className="secondaire">
                            {[p.code, p.categorie].filter(Boolean).join(' · ')}
                            {modifier && (
                              <> · <button className="bouton-lien" onClick={() => { setEdition(p); setTexte(p.description_web ?? ''); }}>
                                {p.description_web ? 'Modifier la description' : 'Ajouter une description'}
                              </button></>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="nombre">
                      <strong>{montant(p.prix)}</strong>
                      {Number(p.prix) < Number(p.prix_vente) && <div className="secondaire"><span className="prix-barre">{montant(p.prix_vente)}</span> 🏷️ solde</div>}
                    </td>
                    <td className="nombre">
                      {Number(p.disponible) > 0 ? Number(p.disponible) : <Pastille ton="rouge">Rupture</Pastille>}
                      {Number(p.stock) !== Number(p.disponible) && <div className="secondaire">stock {Number(p.stock)}, réservé {Number(p.stock) - Number(p.disponible)}</div>}
                    </td>
                    <td className="nombre col-secondaire">{p.commandes || '—'}</td>
                    <td>
                      {modifier ? (
                        <label className="interrupteur">
                          <input type="checkbox" checked={p.en_ligne} onChange={(e) => void publier([p.id], e.target.checked)} />
                          <span>{p.en_ligne ? 'En ligne' : 'Non'}</span>
                        </label>
                      ) : p.en_ligne ? <Pastille ton="vert">En ligne</Pastille> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="secondaire">
          Les photos se changent dans la fiche du produit (Catalogue). Un solde créé dans « Soldes » s’affiche aussitôt sur DF Marché avec une
          bannière et un compte à rebours, et disparaît à sa date de fin.
        </p>
      </section>
      <Fenetre titre={edition ? `Description en ligne — ${edition.designation}` : ''} ouverte={!!edition} onFermer={() => setEdition(null)}>
        <form className="formulaire" onSubmit={enregistrerTexte}>
          <Champ label="Description" aide="Ce que le client doit savoir : taille, couleur, garantie, conseils d’usage…">
            <textarea rows={7} maxLength={3000} value={texte} onChange={(e) => setTexte(e.target.value)} />
          </Champ>
          <button className="bouton bouton-principal">Enregistrer</button>
        </form>
      </Fenetre>
    </>
  );
}

/* ------------------------------------------------------------------------------------------
 * Ma vitrine
 * ---------------------------------------------------------------------------------------- */

interface Vitrine {
  slug: string;
  publiee: boolean;
  magasin_id: string;
  nom: string;
  activite: string | null;
  slogan: string | null;
  description: string | null;
  telephone: string | null;
  whatsapp: string | null;
  email: string | null;
  ville: string | null;
  commune: string | null;
  adresse: string | null;
  latitude: number | null;
  longitude: number | null;
  horaires: string | null;
  photos: string[];
  paiement_livraison: boolean;
  numero_wave: string | null;
  numero_orange: string | null;
  numero_mtn: string | null;
  numero_moov: string | null;
  numero_djamo?: string | null;
  lien_wave?: string | null;
  conditions?: string | null;
  autres_paiements?: AutrePaiement[];
  beneficiaire: string | null;
  retrait: boolean;
  livraison: boolean;
  delai_preparation: number;
  commande_minimum: number;
}
interface AutrePaiement { id?: string; libelle: string; numero: string; instructions?: string | null }
type MoyenOptionnel = 'numero_mtn' | 'numero_moov' | 'numero_djamo';
const OPTIONNELS: { champ: MoyenOptionnel; libelle: string; logo: string }[] = [
  { champ: 'numero_mtn', libelle: 'MTN MoMo', logo: '/paiement/mtn.svg' },
  { champ: 'numero_moov', libelle: 'Moov Money', logo: '/paiement/moov.png' },
  { champ: 'numero_djamo', libelle: 'Djamo', logo: '/paiement/djamo.png' },
];
interface Zone { id?: string; nom: string; frais: number; delai: string | null; actif: boolean }

const ACTIVITES = ['Supérette', 'Boutique de quartier', 'Téléphonie et électronique', 'Mode et vêtements', 'Beauté et cosmétiques', 'Pharmacie et parapharmacie',
  'Quincaillerie', 'Alimentation', 'Boissons', 'Librairie et papeterie', 'Maison et décoration', 'Pièces auto et moto', 'Autre'];

export function urlVitrine(chemin: string): string {
  const { data } = supabase.storage.from('vitrines').getPublicUrl(chemin);
  return data.publicUrl;
}

export function MaVitrine() {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const magasins = useMagasins(org);
  const [v, setV] = useState<Vitrine | null>(null);
  const [ajoutes, setAjoutes] = useState<MoyenOptionnel[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [stats, setStats] = useState<{ publies: number; actifs: number; sans_photo: number } | null>(null);
  const [nouvelle, setNouvelle] = useState<Zone>({ nom: '', frais: 1000, delai: '', actif: true });
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [enCours, setEnCours] = useState(false);

  const charger = useCallback(async () => {
    const { data, error } = await supabase.rpc('vitrine_lire', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    const r = data as { vitrine: Vitrine | null; zones: Zone[]; produits: typeof stats; slug_propose: string };
    setZones(r.zones);
    setStats(r.produits);
    setV(
      r.vitrine ?? {
        slug: r.slug_propose || 'ma-boutique', publiee: false, magasin_id: '', nom: organisation!.nom, activite: null, slogan: null,
        description: null, telephone: null, whatsapp: null, email: null, ville: 'Abidjan', commune: null, adresse: null, latitude: null,
        longitude: null, horaires: 'Lundi au samedi, 8 h – 20 h', photos: [], paiement_livraison: true, numero_wave: null, numero_orange: null,
        numero_mtn: null, numero_moov: null, numero_djamo: null, lien_wave: null, conditions: null, beneficiaire: null, retrait: true, livraison: true, delai_preparation: 2, commande_minimum: 0,
      },
    );
  }, [org, organisation]);
  useEffect(() => {
    void charger();
  }, [charger]);
  useEffect(() => {
    if (v && !v.magasin_id && magasins[0]) setV({ ...v, magasin_id: magasins[0].id });
  }, [magasins, v]);

  if (!v) return <EnTetePage titre="Ma vitrine" sousTitre={erreur || 'Chargement…'} />;
  const maj = (x: Partial<Vitrine>) => setV({ ...v, ...x });
  const majAutre = (i: number, x: Partial<AutrePaiement>) =>
    maj({ autres_paiements: (v.autres_paiements ?? []).map((a, j) => (j === i ? { ...a, ...x } : a)) });

  async function enregistrer(publier?: boolean) {
    setErreur('');
    setInfo('');
    setEnCours(true);
    const { error } = await supabase.rpc('vitrine_enregistrer', { p_org: org, p: { ...v, publiee: publier ?? v!.publiee } });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    setInfo(publier === true ? 'Votre boutique est en ligne sur DF Marché.' : publier === false ? 'Boutique retirée de DF Marché.' : 'Vitrine enregistrée.');
    await charger();
  }

  async function ajouterPhoto(f: File | undefined) {
    if (!f) return;
    setErreur('');
    try {
      const blob = await reduire(f, 1600);
      const chemin = `${org}/vitrine-${Date.now()}.jpg`;
      const { error } = await supabase.storage.from('vitrines').upload(chemin, blob, { contentType: 'image/jpeg' });
      if (error) return setErreur(messageErreur(error));
      maj({ photos: [...v!.photos, chemin].slice(0, 6) });
      setInfo('Photo ajoutée : pensez à enregistrer.');
    } catch (e) {
      setErreur(messageErreur(e));
    }
  }

  function maPosition() {
    if (!navigator.geolocation) return setErreur('Localisation indisponible sur cet appareil.');
    navigator.geolocation.getCurrentPosition(
      (p) => maj({ latitude: Math.round(p.coords.latitude * 1e6) / 1e6, longitude: Math.round(p.coords.longitude * 1e6) / 1e6 }),
      () => setErreur('Position refusée : autorisez la localisation, ou collez les coordonnées depuis Google Maps.'),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  async function enregistrerZone(z: Zone) {
    const { error } = await supabase.rpc('zone_livraison_enregistrer', { p_org: org, p: z });
    if (error) return setErreur(messageErreur(error));
    if (!z.id) setNouvelle({ nom: '', frais: 1000, delai: '', actif: true });
    await charger();
  }

  const carte =
    v.latitude != null && v.longitude != null
      ? `https://www.openstreetmap.org/export/embed.html?bbox=${v.longitude - 0.006},${v.latitude - 0.004},${v.longitude + 0.006},${v.latitude + 0.004}&layer=mapnik&marker=${v.latitude},${v.longitude}`
      : null;

  return (
    <>
      <EnTetePage
        icone="🏪"
        titre="Ma vitrine sur DF Marché"
        sousTitre="Ce que vos clients voient : présentation, photos, localisation, contact, moyens de paiement et livraison."
        actions={
          <>
            {v.publiee && (
              <a className="bouton bouton-discret" href={marcheUrl(`/boutique/${v.slug}`)} target="_blank" rel="noreferrer">🌐 Voir en ligne</a>
            )}
            <button className="bouton bouton-discret" disabled={enCours} onClick={() => void enregistrer()}>Enregistrer</button>
            {v.publiee ? (
              <button className="bouton bouton-discret lien-danger" disabled={enCours} onClick={() => void enregistrer(false)}>Retirer de DF Marché</button>
            ) : (
              <button className="bouton bouton-principal" disabled={enCours} onClick={() => void enregistrer(true)}>Mettre en ligne</button>
            )}
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      <section className="carte etat-vitrine">
        <div>
          {v.publiee ? <Pastille ton="vert">● En ligne</Pastille> : <Pastille ton="gris">Hors ligne</Pastille>}{' '}
          <span className="secondaire">Adresse : </span><strong>{marcheUrl(`/boutique/${v.slug}`)}</strong>
        </div>
        {stats && (
          <div className="secondaire">
            {stats.publies} produit(s) en ligne sur {stats.actifs} · <Link to="/boutique/produits">choisir les produits</Link>
            {stats.publies === 0 && ' — publiez au moins un produit pour recevoir des commandes'}
          </div>
        )}
      </section>

      <div className="grille-2 grille-vitrine">
        <section className="carte formulaire">
          <h2>Présentation</h2>
          <div className="grille-2">
            <Champ label="Nom affiché">
              <input value={v.nom} onChange={(e) => maj({ nom: e.target.value })} maxLength={80} />
            </Champ>
            <Champ label="Adresse sur DF Marché" aide="Lettres minuscules, chiffres et tirets">
              <input value={v.slug} onChange={(e) => maj({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} maxLength={40} />
            </Champ>
            <Champ label="Activité">
              <select value={v.activite ?? ''} onChange={(e) => maj({ activite: e.target.value || null })}>
                <option value="">Choisir…</option>
                {ACTIVITES.map((a) => <option key={a}>{a}</option>)}
              </select>
            </Champ>
            <Champ label="Magasin qui prépare les commandes" aide="Son stock est affiché en ligne">
              <select value={v.magasin_id} onChange={(e) => maj({ magasin_id: e.target.value })}>
                {magasins.map((m) => <option key={m.id} value={m.id}>{m.nom}</option>)}
              </select>
            </Champ>
          </div>
          <Champ label="Phrase d’accroche">
            <input value={v.slogan ?? ''} onChange={(e) => maj({ slogan: e.target.value })} maxLength={140} placeholder="Tout pour la maison, livré en 2 heures à Cocody" />
          </Champ>
          <Champ label="Présentation de la boutique">
            <textarea rows={5} value={v.description ?? ''} onChange={(e) => maj({ description: e.target.value })} maxLength={2000}
              placeholder="Depuis quand vous existez, ce que vous vendez, ce qui vous distingue…" />
          </Champ>
          <Champ label="Horaires">
            <input value={v.horaires ?? ''} onChange={(e) => maj({ horaires: e.target.value })} maxLength={300} />
          </Champ>

          <h2>Photos de la boutique</h2>
          <div className="photos-vitrine">
            {v.photos.map((p, i) => (
              <figure key={p}>
                <img src={urlVitrine(p)} alt={`Photo ${i + 1}`} />
                <button type="button" className="bouton-lien lien-danger" onClick={() => maj({ photos: v.photos.filter((x) => x !== p) })}>Retirer</button>
                {i === 0 && <figcaption>Photo principale</figcaption>}
              </figure>
            ))}
            {v.photos.length < 6 && (
              <label className="ajout-photo">
                <input type="file" accept="image/*" onChange={(e) => void ajouterPhoto(e.target.files?.[0])} hidden />
                <span aria-hidden>📷</span> Ajouter une photo
              </label>
            )}
          </div>
          <p className="secondaire">Devanture, intérieur, rayons : 6 photos au plus. La première sert de bannière. Le logo vient de Personnalisation.</p>

          <h2>Contact et localisation</h2>
          <div className="grille-2">
            <Champ label="Téléphone"><input value={v.telephone ?? ''} onChange={(e) => maj({ telephone: e.target.value })} inputMode="tel" /></Champ>
            <Champ label="WhatsApp" aide="Reçoit les messages des clients"><input value={v.whatsapp ?? ''} onChange={(e) => maj({ whatsapp: e.target.value })} inputMode="tel" /></Champ>
            <Champ label="E-mail"><input type="email" value={v.email ?? ''} onChange={(e) => maj({ email: e.target.value })} /></Champ>
            <Champ label="Ville"><input value={v.ville ?? ''} onChange={(e) => maj({ ville: e.target.value })} /></Champ>
            <Champ label="Commune / quartier"><input value={v.commune ?? ''} onChange={(e) => maj({ commune: e.target.value })} placeholder="Cocody Angré" /></Champ>
            <Champ label="Adresse, repère"><input value={v.adresse ?? ''} onChange={(e) => maj({ adresse: e.target.value })} placeholder="Carrefour Prestige, à côté de la pharmacie" /></Champ>
            <Champ label="Latitude"><input value={v.latitude ?? ''} onChange={(e) => maj({ latitude: e.target.value ? Number(e.target.value) : null })} inputMode="decimal" /></Champ>
            <Champ label="Longitude"><input value={v.longitude ?? ''} onChange={(e) => maj({ longitude: e.target.value ? Number(e.target.value) : null })} inputMode="decimal" /></Champ>
          </div>
          <button type="button" className="bouton bouton-discret" onClick={maPosition}>📍 Utiliser ma position actuelle (dans la boutique)</button>
          {carte && <iframe className="carte-osm" title="Localisation de la boutique" src={carte} loading="lazy" />}
        </section>

        <div className="pile-boutique">
          <section className="carte formulaire">
            <h2>Paiement</h2>
            <p className="secondaire">
              Le client paie directement sur vos numéros, puis indique le numéro qui a payé et joint la capture. DF Marché n’encaisse rien
              et ne demande jamais de code secret.
            </p>
            <label className="case"><input type="checkbox" checked={v.paiement_livraison} onChange={(e) => maj({ paiement_livraison: e.target.checked })} /> Paiement à la livraison ou au retrait</label>
            <div className="moyens-vitrine">
              <div className="moyen-vitrine">
                <img src="/paiement/wave.png" alt="" width={36} height={36} />
                <Champ label="Numéro Wave"><input value={v.numero_wave ?? ''} onChange={(e) => maj({ numero_wave: e.target.value })} inputMode="tel" placeholder="Vide = Wave non proposé" /></Champ>
              </div>
              <div className="moyen-vitrine">
                <img src="/paiement/orange.png" alt="" width={36} height={36} />
                <Champ label="Numéro Orange Money"><input value={v.numero_orange ?? ''} onChange={(e) => maj({ numero_orange: e.target.value })} inputMode="tel" placeholder="Vide = Orange Money non proposé" /></Champ>
              </div>
              {OPTIONNELS.filter((o) => ajoutes.includes(o.champ) || v[o.champ]).map((o) => (
                <div className="moyen-vitrine" key={o.champ}>
                  <img src={o.logo} alt="" width={36} height={36} />
                  <Champ label={`Numéro ${o.libelle}`}><input value={v[o.champ] ?? ''} onChange={(e) => maj({ [o.champ]: e.target.value } as Partial<Vitrine>)} inputMode="tel" /></Champ>
                  <button type="button" className="bouton-lien lien-danger" onClick={() => { maj({ [o.champ]: null } as Partial<Vitrine>); setAjoutes(ajoutes.filter((x) => x !== o.champ)); }}>Retirer</button>
                </div>
              ))}
              {(v.autres_paiements ?? []).map((a, i) => (
                <div className="moyen-vitrine autre" key={a.id ?? `n${i}`}>
                  <span className="logo-autre" aria-hidden>{(a.libelle || '?').slice(0, 1).toUpperCase()}</span>
                  <Champ label="Nom du moyen"><input value={a.libelle} maxLength={30} placeholder="Ex. Ria, Western Union, compte bancaire…" onChange={(e) => majAutre(i, { libelle: e.target.value })} /></Champ>
                  <Champ label="Numéro"><input value={a.numero} inputMode="tel" onChange={(e) => majAutre(i, { numero: e.target.value })} /></Champ>
                  <button type="button" className="bouton-lien lien-danger" onClick={() => maj({ autres_paiements: (v.autres_paiements ?? []).filter((_, j) => j !== i) })}>Retirer</button>
                </div>
              ))}
            </div>
            <div className="ajout-moyens">
              <span>+ Ajouter un moyen de paiement :</span>
              {OPTIONNELS.filter((o) => !ajoutes.includes(o.champ) && !v[o.champ]).map((o) => (
                <button type="button" key={o.champ} className="puce-moyen" onClick={() => setAjoutes([...ajoutes, o.champ])}>
                  <img src={o.logo} alt="" width={20} height={20} /> {o.libelle}
                </button>
              ))}
              {(v.autres_paiements ?? []).length < 5 && (
                <button type="button" className="puce-moyen" onClick={() => maj({ autres_paiements: [...(v.autres_paiements ?? []), { libelle: '', numero: '' }] })}>✚ Autre…</button>
              )}
            </div>
            <p className="secondaire">Seuls les moyens dont vous donnez le numéro sont proposés au client. Videz un numéro (ou « Retirer ») pour arrêter un moyen.</p>
            <Champ label="Lien de paiement Wave (facultatif)" aide="Votre lien marchand pay.wave.com : le bouton du site ouvre alors directement Wave avec votre compte">
              <input value={v.lien_wave ?? ''} onChange={(e) => maj({ lien_wave: e.target.value })} inputMode="url" placeholder="https://pay.wave.com/m/…" />
            </Champ>
            <Champ label="Nom du bénéficiaire affiché" aide="Le nom qui apparaît chez le client au moment du transfert">
              <input value={v.beneficiaire ?? ''} onChange={(e) => maj({ beneficiaire: e.target.value })} maxLength={80} />
            </Champ>
            <Champ label="Vos conditions de vente (facultatif)" aide="Retours, échanges, garantie… Affichées sur la page « Conditions » du site, avant les conditions générales">
              <textarea rows={4} value={v.conditions ?? ''} onChange={(e) => maj({ conditions: e.target.value })} maxLength={8000}
                placeholder="Ex. Échange possible sous 48 h avec le reçu, article non utilisé." />
            </Champ>
          </section>

          <section className="carte formulaire">
            <h2>Retrait et livraison</h2>
            <label className="case"><input type="checkbox" checked={v.retrait} onChange={(e) => maj({ retrait: e.target.checked })} /> Retrait en boutique (gratuit)</label>
            <label className="case"><input type="checkbox" checked={v.livraison} onChange={(e) => maj({ livraison: e.target.checked })} /> Livraison</label>
            <div className="grille-2">
              <Champ label="Temps de préparation (heures)"><input type="number" min={0} max={168} value={v.delai_preparation} onChange={(e) => maj({ delai_preparation: Number(e.target.value) })} /></Champ>
              <Champ label="Commande minimum">
                <input defaultValue={v.commande_minimum ? montant(v.commande_minimum, '') : ''} inputMode={clavierMontant()}
                  onBlur={(e) => maj({ commande_minimum: lireMontant(e.target.value) ?? 0 })} placeholder="0" />
              </Champ>
            </div>
            {v.livraison && (
              <>
                <h3>Zones et frais de livraison</h3>
                <table className="tableau tableau-compact">
                  <thead><tr><th>Commune / zone</th><th className="nombre">Frais</th><th>Délai</th><th>Active</th></tr></thead>
                  <tbody>
                    {zones.map((z) => (
                      <tr key={z.id}>
                        <td>{z.nom}</td>
                        <td className="nombre">{montant(z.frais)}</td>
                        <td>{z.delai ?? '—'}</td>
                        <td><input type="checkbox" checked={z.actif} onChange={(e) => void enregistrerZone({ ...z, actif: e.target.checked })} aria-label={`Zone ${z.nom} active`} /></td>
                      </tr>
                    ))}
                    <tr>
                      <td><input value={nouvelle.nom} onChange={(e) => setNouvelle({ ...nouvelle, nom: e.target.value })} placeholder="Yopougon" aria-label="Nouvelle zone" /></td>
                      <td><input className="nombre" value={nouvelle.frais} inputMode="numeric" onChange={(e) => setNouvelle({ ...nouvelle, frais: Number(e.target.value.replace(/\D/g, '')) })} aria-label="Frais" /></td>
                      <td><input value={nouvelle.delai ?? ''} onChange={(e) => setNouvelle({ ...nouvelle, delai: e.target.value })} placeholder="2 h" aria-label="Délai" /></td>
                      <td><button type="button" className="bouton bouton-discret" disabled={nouvelle.nom.trim().length < 2} onClick={() => void enregistrerZone(nouvelle)}>Ajouter</button></td>
                    </tr>
                  </tbody>
                </table>
                <p className="secondaire">Le client choisit sa zone : les frais s’ajoutent au panier. Ils sont payés avec la commande, ou au livreur.</p>
              </>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
