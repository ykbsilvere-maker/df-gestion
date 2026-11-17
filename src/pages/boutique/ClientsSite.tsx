import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { clavierMontant, lireMontant, montant } from '../../lib/argent';
import { Alerte, Champ, EnTetePage, Fenetre, Pastille, Vide } from '../../components/ui';
import { StatutCommandePastille } from './Boutique';
import { QrOffre, type OffreQr } from './QrOffre';
import type { StatutCommande } from './commun';

/* ------------------------------------------------------------------------------------------
 * Clients du site DF Marché : tous les comptes, leur photo, leurs commandes chez nous,
 * et les bons de réduction (avec QR code) qu'on leur réserve.
 * ---------------------------------------------------------------------------------------- */

interface ClientSite {
  id: string;
  nom: string;
  email: string;
  telephone: string | null;
  commune: string | null;
  photo_path: string | null;
  inscrit_le: string;
  commandes: number;
  achats: number;
  derniere_commande: string | null;
  codes: number;
}

interface FicheClient {
  id: string;
  nom: string;
  email: string;
  telephone: string | null;
  adresse: string | null;
  repere: string | null;
  commune: string | null;
  photo_path: string | null;
  inscrit_le: string;
  slug: string | null;
  commandes: { id: string; numero: string; created_at: string; total: number; statut: StatutCommande; mode: string; code_promo: string | null; remise: number }[];
  codes: (OffreQr & { id: string; utilisations: number; actif: boolean })[];
}

export const photoClient = (p: string | null) => (p ? supabase.storage.from('clients').getPublicUrl(p).data.publicUrl : null);

const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

function Avatar({ nom, photo, grand = false }: { nom: string; photo: string | null; grand?: boolean }) {
  const url = photoClient(photo);
  return (
    <span className={`avatar-client ${grand ? 'avatar-grand' : ''}`} aria-hidden>
      {url ? <img src={url} alt="" loading="lazy" /> : nom.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

function genererCode(nom: string) {
  const lettres = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += lettres[Math.floor(Math.random() * lettres.length)];
  const base = nom.normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8) || 'CLIENT';
  return `${base}-${s}`;
}

export function ClientsSite() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const [q, setQ] = useState('');
  const [liste, setListe] = useState<ClientSite[] | null>(null);
  const [fiche, setFiche] = useState<FicheClient | null>(null);
  const [nomBoutique, setNomBoutique] = useState(organisation?.nom ?? '');
  const [bon, setBon] = useState<{ type: 'pourcent' | 'montant'; valeur: string; fin: string; libelle: string } | null>(null);
  const [qr, setQr] = useState<OffreQr | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');

  const charger = useCallback(async (terme: string) => {
    const { data, error } = await supabase.rpc('clients_marche_liste', { p_org: org, p_q: terme.trim() || null });
    if (error) return setErreur(messageErreur(error));
    setListe(data as ClientSite[]);
  }, [org]);
  useEffect(() => {
    const t = window.setTimeout(() => void charger(q), q ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [charger, q]);
  useEffect(() => {
    void supabase.rpc('vitrine_lire', { p_org: org }).then(({ data }) => {
      const n = (data as { vitrine: { nom: string } | null } | null)?.vitrine?.nom;
      if (n) setNomBoutique(n);
    });
  }, [org]);

  async function ouvrir(id: string) {
    setErreur('');
    const { data, error } = await supabase.rpc('client_marche_detail', { p_org: org, p_id: id });
    if (error) return setErreur(messageErreur(error));
    setFiche(data as FicheClient);
  }

  async function creerBon(e: FormEvent) {
    e.preventDefault();
    if (!fiche || !bon) return;
    const valeur = bon.type === 'pourcent' ? Number(bon.valeur) : lireMontant(bon.valeur);
    if (!valeur || valeur <= 0 || (bon.type === 'pourcent' && valeur > 90)) return setErreur('Remise invalide (90 % au plus).');
    const code = genererCode(fiche.nom);
    const { data, error } = await supabase.rpc('code_promo_enregistrer', {
      p_org: org,
      p: { code, libelle: bon.libelle || `Bon fidélité ${fiche.nom.split(' ')[0]}`, type: bon.type, valeur, minimum: 0, fin: bon.fin || null, max_utilisations: 1, compte_id: fiche.id, visible: false, actif: true },
    });
    if (error) return setErreur(messageErreur(error));
    setBon(null);
    setInfo(`Bon ${code} créé pour ${fiche.nom}.`);
    await ouvrir(fiche.id);
    void charger(q);
    setQr(data as OffreQr);
  }

  return (
    <>
      <EnTetePage
        titre="👥 Clients du site"
        sousTitre="Tous les comptes créés sur DF Marché : coordonnées, commandes passées chez vous et bons de réduction avec QR code à leur envoyer."
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      <div className="recherche-large">
        <span aria-hidden>🔍</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, e-mail ou téléphone" aria-label="Rechercher un client" />
        {q && <button type="button" className="bouton-lien" onClick={() => setQ('')}>Effacer</button>}
      </div>
      <section className="carte">
        {!liste ? (
          <p className="secondaire">Chargement…</p>
        ) : !liste.length ? (
          <Vide>{q ? 'Aucun compte ne correspond.' : 'Aucun compte client pour l’instant. Ils apparaissent dès qu’un client s’inscrit sur DF Marché.'}</Vide>
        ) : (
          <ul className="clients-grille">
            {liste.map((c, i) => (
              <li key={c.id} style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}>
                <button type="button" className="client-carte" onClick={() => void ouvrir(c.id)}>
                  <Avatar nom={c.nom} photo={c.photo_path} />
                  <span className="client-carte-texte">
                    <strong>{c.nom}</strong>
                    <small>{c.email}</small>
                    <small>{c.telephone ?? c.commune ?? `Inscrit le ${date(c.inscrit_le)}`}</small>
                  </span>
                  <span className="client-carte-chiffres">
                    {Number(c.commandes) > 0 ? <Pastille ton="vert">{c.commandes} cmd</Pastille> : <Pastille ton="gris">nouveau</Pastille>}
                    {Number(c.achats) > 0 && <small>{montant(c.achats)}</small>}
                    {Number(c.codes) > 0 && <small>🎟️ {c.codes}</small>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Fenetre titre={fiche?.nom ?? 'Client'} ouverte={!!fiche} onFermer={() => setFiche(null)} large>
        {fiche && (
          <div className="fiche-client-site">
            <div className="fiche-client-entete">
              <Avatar nom={fiche.nom} photo={fiche.photo_path} grand />
              <div>
                <h3>{fiche.nom}</h3>
                <p>
                  <a href={`mailto:${fiche.email}`}>{fiche.email}</a>
                  {fiche.telephone && <> · <a href={`tel:${fiche.telephone}`}>{fiche.telephone}</a></>}
                </p>
                <p className="secondaire">
                  Client depuis le {date(fiche.inscrit_le)}
                  {fiche.commune ? ` · ${fiche.commune}` : ''}
                  {fiche.adresse ? ` · ${fiche.adresse}` : ''}
                </p>
              </div>
            </div>

            <h4>🎟️ Bons de réduction</h4>
            {fiche.codes.length === 0 ? (
              <p className="secondaire">Aucun bon pour ce client.</p>
            ) : (
              <ul className="bons-client">
                {fiche.codes.map((k) => (
                  <li key={k.id} className={k.actif ? '' : 'code-eteint'}>
                    <span>
                      <strong>{k.type === 'pourcent' ? `−${k.valeur} %` : `−${montant(k.valeur)}`}</strong> · <code>{k.code}</code>
                      <small> {k.utilisations > 0 ? `utilisé ${k.utilisations} fois` : 'pas encore utilisé'}</small>
                    </span>
                    {fiche.slug && k.actif && <button type="button" className="bouton bouton-discret" onClick={() => setQr(k)}>▦ QR code</button>}
                  </li>
                ))}
              </ul>
            )}
            {peut('boutique.modifier') && fiche.slug && (
              bon ? (
                <form className="formulaire bon-rapide" onSubmit={creerBon}>
                  <div className="choix-segment">
                    <button type="button" className={bon.type === 'pourcent' ? 'actif' : ''} onClick={() => setBon({ ...bon, type: 'pourcent', valeur: '10' })}>%</button>
                    <button type="button" className={bon.type === 'montant' ? 'actif' : ''} onClick={() => setBon({ ...bon, type: 'montant', valeur: '1000' })}>FCFA</button>
                  </div>
                  <div className="grille-2">
                    <Champ label={bon.type === 'pourcent' ? 'Remise (%)' : 'Remise (FCFA)'}>
                      <input value={bon.valeur} onChange={(e) => setBon({ ...bon, valeur: e.target.value })} inputMode={bon.type === 'montant' ? clavierMontant() : 'numeric'} required />
                    </Champ>
                    <Champ label="Valable jusqu’au"><input type="date" value={bon.fin} onChange={(e) => setBon({ ...bon, fin: e.target.value })} /></Champ>
                  </div>
                  <Champ label="Nom du bon (facultatif)"><input value={bon.libelle} maxLength={80} onChange={(e) => setBon({ ...bon, libelle: e.target.value })} placeholder="Merci pour votre fidélité" /></Champ>
                  <div className="actions-piece">
                    <button type="button" className="bouton bouton-discret" onClick={() => setBon(null)}>Annuler</button>
                    <button className="bouton bouton-principal">Créer le bon et son QR code</button>
                  </div>
                </form>
              ) : (
                <button type="button" className="bouton bouton-principal" onClick={() => setBon({ type: 'pourcent', valeur: '10', fin: '', libelle: '' })}>
                  + Offrir un bon de réduction (QR code)
                </button>
              )
            )}
            {!fiche.slug && <p className="secondaire">Publiez d’abord votre boutique (« Ma vitrine ») pour créer des bons.</p>}

            <h4>🛍️ Commandes chez vous</h4>
            {fiche.commandes.length === 0 ? (
              <p className="secondaire">Aucune commande dans votre boutique pour l’instant.</p>
            ) : (
              <ul className="commandes-client">
                {fiche.commandes.map((c) => (
                  <li key={c.id}>
                    <Link to={`/boutique/commandes/${c.id}`}>
                      <span>
                        <strong>{c.numero}</strong> · {date(c.created_at)}
                        {c.code_promo && <small> · 🎟️ {c.code_promo}</small>}
                      </span>
                      <span>
                        {montant(c.total)} <StatutCommandePastille s={c.statut} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Fenetre>

      <Fenetre titre={qr ? `Bon ${qr.code}` : 'QR code'} ouverte={!!qr} onFermer={() => setQr(null)}>
        {qr && fiche?.slug && <QrOffre offre={qr} slug={fiche.slug} boutique={nomBoutique} client={fiche.nom} />}
      </Fenetre>
    </>
  );
}
