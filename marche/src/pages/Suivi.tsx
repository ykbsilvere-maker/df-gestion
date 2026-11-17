import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { appeler, type Suivi as DonneesSuivi } from '../api';
import { Chargement, Erreur, fcfa, lienWhatsapp } from '../composants';
import { mesCommandes } from '../panier';
import { CartePaiement, LogoPaiement, moyen } from '../paiement';
import { envoyerJustificatif } from './Commande';

const ETAPES = [
  ['passee', 'Reçue', '📨'],
  ['confirmee', 'Confirmée', '👍'],
  ['prete', 'Prête', '📦'],
  ['expediee', 'En route', '🛵'],
  ['livree', 'Livrée', '✅'],
] as const;

const PHRASES: Record<DonneesSuivi['statut'], string> = {
  nouvelle: 'La boutique a reçu votre commande et va la confirmer.',
  confirmee: 'Commande confirmée : la boutique la prépare.',
  prete: 'Votre commande est prête.',
  en_livraison: 'Votre commande est en route : le livreur vous appellera.',
  livree: 'Commande livrée. Merci ! Donnez votre avis sur les produits.',
  annulee: 'Commande annulée.',
};

function Notation({ code, ligne, onFait }: { code: string; ligne: DonneesSuivi['lignes'][number]; onFait: () => void }) {
  const [note, setNote] = useState(ligne.avis ?? 0);
  const [texte, setTexte] = useState('');
  const [etat, setEtat] = useState<'' | 'envoi' | 'ok' | string>(ligne.avis ? 'ok' : '');
  async function envoyer(e: FormEvent) {
    e.preventDefault();
    if (!note) return;
    setEtat('envoi');
    try {
      await appeler('deposer_avis', { p_code: code, p_produit: ligne.produit_id, p_note: note, p_commentaire: texte || null });
      setEtat('ok');
      onFait();
    } catch (x) {
      setEtat((x as Error).message);
    }
  }
  return (
    <form className="notation" onSubmit={envoyer}>
      <span>{ligne.designation}</span>
      <span className="choix-etoiles" role="radiogroup" aria-label={`Note pour ${ligne.designation}`}>
        {[1, 2, 3, 4, 5].map((i) => (
          <button key={i} type="button" role="radio" aria-checked={note === i} className={i <= note ? 'pleine' : ''} onClick={() => setNote(i)} aria-label={`${i} étoile${i > 1 ? 's' : ''}`}>★</button>
        ))}
      </span>
      {etat === 'ok' ? (
        <span className="merci">Merci pour votre avis ✓</span>
      ) : (
        <>
          <input value={texte} onChange={(e) => setTexte(e.target.value)} maxLength={600} placeholder="Votre commentaire (facultatif)" />
          <button className="bouton" disabled={!note || etat === 'envoi'}>Publier</button>
          {etat && etat !== 'envoi' && <small className="alerte">{etat}</small>}
        </>
      )}
    </form>
  );
}

export function Suivi() {
  const { code } = useParams();
  const [params] = useSearchParams();
  const [s, setS] = useState<DonneesSuivi | null>(null);
  const [erreur, setErreur] = useState('');
  const [depot, setDepot] = useState(params.get('justificatif') === 'echec' ? 'La capture n’a pas pu être envoyée : réessayez ci-dessous.' : '');
  const charger = useCallback(() => {
    appeler<DonneesSuivi>('marche_suivi', { p_code: code }).then(setS).catch((e: Error) => setErreur(e.message));
  }, [code]);
  useEffect(() => {
    charger();
    const id = window.setInterval(charger, 60000);
    document.title = `Commande ${code} — DF Marché`;
    return () => window.clearInterval(id);
  }, [charger, code]);

  if (erreur) return <Erreur>{erreur}</Erreur>;
  if (!s) return <Chargement />;
  const lien = `${window.location.origin}/suivi/${s.code_suivi}`;
  const wa = s.boutique.whatsapp;
  const messageBoutique =
    `Bonjour ${s.boutique.nom}, je viens de passer la commande ${s.numero} sur DF Marché (${fcfa(s.total)}, ` +
    `${s.mode === 'livraison' ? `livraison ${s.zone ?? ''}` : 'retrait en boutique'}, paiement ${moyen(s.paiement).libelle}).\nSuivi : ${lien}`;
  const etapes = ETAPES.filter(([k]) => s.mode === 'livraison' || k !== 'expediee');
  const attentePaiement = s.paiement !== 'livraison' && s.paiement_statut !== 'confirme' && s.statut !== 'annulee' && s.statut !== 'livree';

  async function deposer(f: File | undefined) {
    if (!f || !s) return;
    setDepot('Envoi…');
    try {
      await envoyerJustificatif(s.id, s.code_suivi, f);
      setDepot('Capture envoyée ✓ La boutique va vérifier le paiement.');
      charger();
    } catch (x) {
      setDepot((x as Error).message);
    }
  }

  return (
    <section className="suivi">
      {params.get('nouvelle') && (
        <div className="bloc felicitations">
          <p className="grand-emoji" aria-hidden>🎉</p>
          <h1>Commande envoyée à {s.boutique.nom} !</h1>
          <p>Gardez votre code de suivi : <strong className="code">{s.code_suivi}</strong></p>
          {wa && (
            <a className="bouton bouton-whatsapp large" href={lienWhatsapp(wa, messageBoutique)} target="_blank" rel="noreferrer">
              Prévenir la boutique sur WhatsApp
            </a>
          )}
          <p className="secondaire petit">La boutique est déjà avertie dans son logiciel ; le message WhatsApp accélère la confirmation.</p>
        </div>
      )}
      <div className="bloc">
        <div className="suivi-tete">
          <div>
            <h2>Commande {s.numero}</h2>
            <p className="secondaire">chez <Link to={`/boutique/${s.boutique.slug}`}>{s.boutique.nom}</Link> · code {s.code_suivi}</p>
          </div>
          <strong className="suivi-total">{fcfa(s.total)}</strong>
        </div>
        <p className={`phrase-statut ${s.statut}`}>{PHRASES[s.statut]}{s.statut === 'annulee' && s.motif ? ` Motif : ${s.motif}` : ''}</p>
        {s.statut !== 'annulee' && (
          <ol className="frise">
            {etapes.map(([k, l, i]) => (
              <li key={k} className={s.dates[k] ? 'faite' : ''}>
                <span aria-hidden>{i}</span>
                <strong>{l}</strong>
                <small>{s.dates[k] ? new Date(s.dates[k]!).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</small>
              </li>
            ))}
          </ol>
        )}
      </div>

      {attentePaiement && (
        <div className={`bloc paiement-attente ${s.paiement_statut === 'refuse' ? 'refuse' : ''}`}>
          <h2>Paiement {moyen(s.paiement).libelle}</h2>
          {s.paiement_statut === 'refuse' && <p className="alerte">La boutique n’a pas reçu le paiement{s.motif ? ` : ${s.motif}` : ''}. Vérifiez et renvoyez la capture.</p>}
          {s.boutique.numero_paiement && (
            <CartePaiement m={moyen(s.paiement)} numero={s.boutique.numero_paiement} montant={s.total} beneficiaire={s.boutique.beneficiaire} lienWave={s.boutique.lien_wave} />
          )}
          {(s.numero_payeur || s.reference_paiement) && (
            <p className="secondaire">Payé depuis {s.numero_payeur ?? '—'}{s.reference_paiement ? ` · réf. ${s.reference_paiement}` : ''}</p>
          )}
          <p>{s.justificatif ? '📎 Capture reçue : la boutique vérifie le paiement.' : 'Pas encore de capture du paiement.'}</p>
          <label className="depot">
            <input type="file" accept="image/*,application/pdf" onChange={(e) => void deposer(e.target.files?.[0])} />
            <span>{s.justificatif ? 'Envoyer une autre capture' : '📎 Joindre la capture du paiement'}</span>
          </label>
          {depot && <p className="secondaire">{depot}</p>}
        </div>
      )}

      {s.paiement !== 'livraison' && s.paiement_statut === 'confirme' && (
        <div className="bloc paiement-confirme">
          <LogoPaiement m={moyen(s.paiement)} taille={44} />
          <div>
            <strong>Paiement {moyen(s.paiement).libelle} confirmé ✓</strong>
            <small>
              {s.paiement_confirme_le ? `le ${new Date(s.paiement_confirme_le).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
              {s.reference_paiement ? ` · réf. ${s.reference_paiement}` : ''}
            </small>
          </div>
          <Link className="bouton bouton-principal" to={`/recu/${s.code_suivi}`}>🧾 Mon reçu</Link>
        </div>
      )}

      <div className="bloc">
        <h2>Détail</h2>
        <table className="detail-commande">
          <tbody>
            {s.lignes.map((l) => (
              <tr key={l.produit_id}><td>{Number(l.quantite)} × <Link to={`/produit/${l.produit_id}`}>{l.designation}</Link></td><td>{fcfa(l.montant)}</td></tr>
            ))}
            {s.mode === 'livraison' && <tr><td>Livraison {s.zone}</td><td>{fcfa(s.frais_livraison)}</td></tr>}
            <tr className="total"><td>Total</td><td>{fcfa(s.total)}</td></tr>
          </tbody>
        </table>
        <p className="secondaire">
          {s.mode === 'livraison' ? `🛵 Livraison : ${s.zone ?? ''}, ${s.adresse ?? ''}` : `🏪 Retrait : ${[s.boutique.adresse, s.boutique.commune].filter(Boolean).join(', ')}`}
          {s.souhaite_le && ` · souhaitée le ${new Date(s.souhaite_le).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`}
        </p>
        <p className="actions-suivi">
          {wa && <a className="bouton bouton-whatsapp" href={lienWhatsapp(wa, `Bonjour ${s.boutique.nom}, au sujet de ma commande ${s.numero} : `)} target="_blank" rel="noreferrer">WhatsApp</a>}
          {s.boutique.telephone && <a className="bouton" href={`tel:${s.boutique.telephone.replace(/\s/g, '')}`}>📞 Appeler la boutique</a>}
          <Link className="bouton" to={`/recu/${s.code_suivi}`}>🧾 {s.paiement_statut === 'confirme' ? 'Télécharger le reçu' : 'Bon de commande'}</Link>
          <button className="bouton" onClick={() => void navigator.clipboard?.writeText(lien)}>🔗 Copier le lien de suivi</button>
        </p>
      </div>

      {s.statut === 'livree' && (
        <div className="bloc">
          <h2>Votre avis</h2>
          <p className="secondaire">Il aide les autres clients. Seul votre prénom et l’initiale de votre nom apparaissent.</p>
          {s.lignes.map((l) => <Notation key={l.produit_id} code={s.code_suivi} ligne={l} onFait={() => undefined} />)}
        </div>
      )}
    </section>
  );
}

export function MesCommandes() {
  const naviguer = useNavigate();
  const [code, setCode] = useState('');
  const liste = mesCommandes();
  useEffect(() => {
    document.title = 'Mes commandes — DF Marché';
  }, []);
  return (
    <section className="rayon">
      <div className="rayon-titre"><h1>Mes commandes</h1></div>
      <form className="bloc trouver-commande" onSubmit={(e) => { e.preventDefault(); if (code.trim()) naviguer(`/suivi/${code.trim().toUpperCase()}`); }}>
        <label>Suivre une commande avec son code<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Ex. 7F3A9C21" maxLength={12} /></label>
        <button className="bouton bouton-principal">Suivre</button>
      </form>
      {liste.length ? (
        <ul className="liste-commandes">
          {liste.map((c) => (
            <li key={c.code}>
              <Link to={`/suivi/${c.code}`}>
                <strong>{c.numero}</strong> · {c.boutique}
                <small>{new Date(c.date).toLocaleDateString('fr-FR')} · {fcfa(c.total)}</small>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="vide">Les commandes passées depuis ce téléphone s’affichent ici.</p>
      )}
    </section>
  );
}
