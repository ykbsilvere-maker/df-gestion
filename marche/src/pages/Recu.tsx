import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { appeler, type FicheBoutique, type Suivi } from '../api';
import { Chargement, Erreur, fcfa } from '../composants';
import { LogoPaiement, moyen } from '../paiement';

const date = (d: string | null | undefined, heure = true) =>
  d
    ? new Date(d).toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        ...(heure ? { hour: '2-digit', minute: '2-digit' } : {}),
      })
    : '—';

const STATUTS_PAIEMENT: Record<Suivi['paiement_statut'], string> = {
  a_la_livraison: 'À régler au retrait / à la livraison',
  a_verifier: 'En cours de vérification par la boutique',
  confirme: 'Paiement confirmé',
  refuse: 'Paiement non reçu',
};

/**
 * Reçu imprimable (ou à enregistrer en PDF) : « REÇU DE PAIEMENT » une fois le paiement
 * confirmé par la boutique, sinon « BON DE COMMANDE ». Les références de la transaction y figurent.
 */
export function Recu() {
  const { code } = useParams();
  const [params] = useSearchParams();
  const [s, setS] = useState<Suivi | null>(null);
  const [erreur, setErreur] = useState('');
  useEffect(() => {
    appeler<Suivi>('marche_suivi', { p_code: code })
      .then((x) => {
        setS(x);
        document.title = `${x.paiement_statut === 'confirme' ? 'Reçu' : 'Bon de commande'} ${x.numero} — ${x.boutique.nom}`;
      })
      .catch((e: Error) => setErreur(e.message));
  }, [code]);
  useEffect(() => {
    if (s && params.get('imprimer')) window.setTimeout(() => window.print(), 400);
  }, [s, params]);

  if (erreur) return <Erreur>{erreur}</Erreur>;
  if (!s) return <Chargement />;
  const confirme = s.paiement_statut === 'confirme';
  const m = moyen(s.paiement);
  const enLigne = s.paiement !== 'livraison';

  return (
    <section className="page-recu">
      <div className="barre-recu non-imprime">
        <Link className="bouton" to={`/suivi/${s.code_suivi}`}>← Retour au suivi</Link>
        <button className="bouton bouton-principal" onClick={() => window.print()}>⬇ Télécharger (PDF) / imprimer</button>
      </div>
      <p className="secondaire non-imprime aide-recu">Pour l’enregistrer : touchez « Télécharger », puis choisissez « Enregistrer au format PDF ».</p>

      <article className={`recu ${confirme ? 'confirme' : ''}`}>
        <header className="recu-tete">
          <div>
            <strong className="recu-boutique">{s.boutique.nom}</strong>
            <small>{[s.boutique.adresse, s.boutique.commune, s.boutique.ville].filter(Boolean).join(', ')}</small>
            {s.boutique.telephone && <small>Tél. {s.boutique.telephone}</small>}
          </div>
          <div className="recu-titre">
            <h1>{confirme ? 'REÇU DE PAIEMENT' : 'BON DE COMMANDE'}</h1>
            <span>N° {s.numero}</span>
            <small>du {date(s.created_at)}</small>
          </div>
        </header>

        <div className="recu-parties">
          <div>
            <span>Client</span>
            <strong>{s.client_nom}</strong>
            <small>{s.client_telephone}</small>
          </div>
          <div>
            <span>{s.mode === 'livraison' ? 'Livraison' : 'Retrait en boutique'}</span>
            <strong>{s.mode === 'livraison' ? s.zone ?? '' : s.boutique.nom}</strong>
            <small>{s.mode === 'livraison' ? [s.adresse, s.repere].filter(Boolean).join(' · ') : [s.boutique.adresse, s.boutique.commune].filter(Boolean).join(', ')}</small>
          </div>
        </div>

        <table className="recu-lignes">
          <thead>
            <tr><th>Article</th><th>Qté</th><th>P.U.</th><th>Montant</th></tr>
          </thead>
          <tbody>
            {s.lignes.map((l) => (
              <tr key={l.produit_id}>
                <td>{l.designation}</td>
                <td>{Number(l.quantite)}</td>
                <td>{fcfa(l.prix_unitaire)}</td>
                <td>{fcfa(l.montant)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={3}>Sous-total</td><td>{fcfa(s.sous_total)}</td></tr>
            {s.mode === 'livraison' && <tr><td colSpan={3}>Frais de livraison</td><td>{fcfa(s.frais_livraison)}</td></tr>}
            <tr className="recu-total"><td colSpan={3}>TOTAL</td><td>{fcfa(s.total)}</td></tr>
          </tfoot>
        </table>

        <div className="recu-paiement">
          <LogoPaiement m={m} taille={46} />
          <dl>
            <dt>Mode de paiement</dt>
            <dd>{enLigne ? m.libelle : s.mode === 'retrait' ? 'Au retrait (espèces ou Mobile Money)' : 'À la livraison (espèces ou Mobile Money)'}</dd>
            {enLigne && <><dt>Payé au</dt><dd>{s.boutique.numero_paiement ?? '—'} ({s.boutique.beneficiaire})</dd></>}
            {s.numero_payeur && <><dt>Depuis le numéro</dt><dd>{s.numero_payeur}</dd></>}
            {s.reference_paiement && <><dt>Référence transaction</dt><dd className="ref">{s.reference_paiement}</dd></>}
            <dt>Statut</dt>
            <dd className={`statut-p ${s.paiement_statut}`}>
              {STATUTS_PAIEMENT[s.paiement_statut]}
              {confirme && s.paiement_confirme_le ? ` le ${date(s.paiement_confirme_le)}` : ''}
            </dd>
            {s.vente && <><dt>Ticket de caisse</dt><dd>{s.vente}</dd></>}
          </dl>
        </div>

        {confirme && <div className="tampon" aria-hidden>PAYÉ</div>}

        <footer className="recu-pied">
          <div>
            <span>Code de suivi</span>
            <strong className="code">{s.code_suivi}</strong>
          </div>
          <p>
            {confirme
              ? 'Paiement vérifié et confirmé par la boutique. Conservez ce reçu.'
              : 'Ce bon n’est pas une preuve de paiement : le reçu est disponible une fois le paiement confirmé par la boutique.'}
          </p>
          <small>Commande passée sur DF Marché · {window.location.host}/suivi/{s.code_suivi}</small>
        </footer>
      </article>
    </section>
  );
}

const CGV_PAR_DEFAUT: [string, string][] = [
  ['Commande', 'La commande est envoyée directement à la boutique choisie. Elle devient ferme lorsque la boutique la confirme. Les prix et le stock affichés sont ceux de la caisse de la boutique au moment de la commande.'],
  ['Prix', 'Les prix sont en francs CFA (F CFA), toutes taxes comprises. Les frais de livraison éventuels sont indiqués avant la validation, selon la zone choisie.'],
  ['Paiement', 'Vous payez directement la boutique : à la livraison ou au retrait (espèces ou Mobile Money), ou en ligne par Mobile Money sur le numéro officiel de la boutique affiché sur le site. Indiquez le numéro qui a payé et la référence de la transaction. La boutique vérifie puis confirme le paiement ; votre reçu est alors disponible. Ne communiquez jamais votre code secret à qui que ce soit.'],
  ['Livraison et retrait', 'Le délai de préparation est indiqué sur la page de la boutique. En livraison, le livreur vous appelle avant de passer. En retrait, présentez votre numéro ou votre code de suivi à la caisse.'],
  ['Annulation et retours', 'Vous pouvez demander l’annulation tant que la commande n’est pas expédiée, en contactant la boutique. Les retours et échanges suivent les règles de la boutique : contactez-la dans les 48 heures suivant la réception, avec votre reçu.'],
  ['Données personnelles', 'Votre nom, votre téléphone et votre adresse servent uniquement à traiter la commande. Ils sont transmis à la boutique et à personne d’autre.'],
];

export function Conditions() {
  const [params] = useSearchParams();
  const slug = params.get('boutique');
  const [v, setV] = useState<FicheBoutique | null>(null);
  const [ouvert, setOuvert] = useState(0);
  useEffect(() => {
    document.title = 'Conditions générales de vente — DF Marché';
    if (slug) appeler<FicheBoutique>('marche_boutique', { p_slug: slug }).then(setV).catch(() => undefined);
  }, [slug]);
  const sections: [string, string][] = v?.conditions ? [[`Conditions de ${v.nom}`, v.conditions], ...CGV_PAR_DEFAUT] : CGV_PAR_DEFAUT;
  return (
    <section className="rayon page-conditions">
      <div className="rayon-titre"><h1>Conditions générales de vente</h1></div>
      {v && <p className="secondaire">Pour les commandes passées chez <Link to={`/boutique/${v.slug}`}>{v.nom}</Link>.</p>}
      <div className="accordeon">
        {sections.map(([t, texte], i) => (
          <div key={t} className={`accordeon-item ${ouvert === i ? 'ouvert' : ''}`}>
            <button type="button" aria-expanded={ouvert === i} onClick={() => setOuvert(ouvert === i ? -1 : i)}>
              <span>{t}</span>
              <span aria-hidden className="signe">{ouvert === i ? '−' : '+'}</span>
            </button>
            {ouvert === i && <div className="accordeon-corps">{texte.split('\n').map((p, j) => <p key={j}>{p}</p>)}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}
