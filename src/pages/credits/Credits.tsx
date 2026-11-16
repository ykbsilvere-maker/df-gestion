import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { useIdentite } from '../../lib/identite';
import { messageErreur } from '../../lib/format';
import { clavierMontant, lireMontant, montant } from '../../lib/argent';
import { quantite, useMagasins } from '../../lib/stock';
import { aujourdhui, dateFr, useComptes } from '../../lib/tresorerie';
import { useMagasinGlobal } from '../../lib/magasinGlobal';
import { exporterClasseur, type FormatExport } from '../../lib/export';
import { useImpression } from '../../impression/impression';
import { BoutonsExport } from '../../components/Export';
import { RechercheProduit, type ProduitTrouve } from '../../components/RechercheProduit';
import { Alerte, Champ, EnTetePage, Fenetre, MontantFort, Pastille, Vide } from '../../components/ui';
import {
  ACTIONS_SUIVI,
  BonCredit,
  ETAPES,
  LettreCredit,
  ReleveCredit,
  seuils,
  type DetailCredit,
  type DossierCredit,
  type Procedure,
} from './documents';

/** Ajoute n jours à une date AAAA-MM-JJ. */
function plusJours(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const ecartJours = (de: string, a: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86400000);
const DUREES = [7, 15, 30, 45, 60, 90];

/** Échéance lisible : « dans 5 j », « aujourd’hui », « 12 j de retard ». */
export function Echeance({ d }: { d: Pick<DossierCredit, 'echeance' | 'jours_restants' | 'jours_retard' | 'reste' | 'statut'> }) {
  if (d.statut === 'valide' && Number(d.reste) === 0) return <Pastille ton="vert">Soldé</Pastille>;
  if (d.jours_retard > 0) return <Pastille ton={d.jours_retard >= 30 ? 'rouge' : 'or'}>{dateFr(d.echeance)} · {d.jours_retard} j de retard</Pastille>;
  return (
    <span>
      {dateFr(d.echeance)}
      <span className="secondaire"> · {d.jours_restants === 0 ? 'aujourd’hui' : `dans ${d.jours_restants} j`}</span>
    </span>
  );
}

export function EtapePastille({ etape }: { etape: number }) {
  const e = ETAPES[Math.max(0, Math.min(4, etape))]!;
  return <Pastille ton={e.ton}>{e.court}</Pastille>;
}

/** Module « Crédits clients ». */
export function CreditsModule() {
  const { peut } = useSession();
  return (
    <>
      <nav className="onglets" aria-label="Crédits clients">
        <NavLink to="/credits" end>
          <span className="onglet-icone" aria-hidden>📂</span>Dossiers
        </NavLink>
        {peut('ventes.valider') && (
          <NavLink to="/credits/nouveau">
            <span className="onglet-icone" aria-hidden>➕</span>Nouveau crédit
          </NavLink>
        )}
        <NavLink to="/credits/procedure">
          <span className="onglet-icone" aria-hidden>🪜</span>Procédure de relance
        </NavLink>
      </nav>
      <Outlet />
    </>
  );
}

type Filtre = 'suivre' | 'retard' | 'mes' | 'brouillons' | 'soldes' | 'tous';
const FILTRES: { cle: Filtre; libelle: string }[] = [
  { cle: 'suivre', libelle: 'À encaisser' },
  { cle: 'retard', libelle: 'En retard' },
  { cle: 'mes', libelle: 'Mes dossiers' },
  { cle: 'brouillons', libelle: 'Brouillons' },
  { cle: 'soldes', libelle: 'Soldés' },
  { cle: 'tous', libelle: 'Tous' },
];

export function ListeCredits() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const magasin = useMagasinGlobal();
  const naviguer = useNavigate();
  const [donnees, setDonnees] = useState<{ dossiers: DossierCredit[]; tout_voir: boolean; procedure: Procedure } | null>(null);
  const [filtre, setFiltre] = useState<Filtre>('suivre');
  const [recherche, setRecherche] = useState('');
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    void supabase.rpc('credits_liste', { p_org: org, p_magasin: magasin || null }).then(({ data, error }) => {
      if (error) return setErreur(messageErreur(error));
      const r = data as { dossiers: DossierCredit[]; tout_voir: boolean; procedure: Procedure };
      setDonnees(r);
      if (!r.tout_voir) setFiltre('mes');
    });
  }, [org, magasin]);

  const tous = donnees?.dossiers ?? [];
  const enCours = tous.filter((d) => d.statut === 'valide' && Number(d.reste) > 0);
  const visibles = useMemo(() => {
    const t = recherche.trim().toLowerCase();
    return tous
      .filter((d) => {
        switch (filtre) {
          case 'suivre': return d.statut === 'valide' && Number(d.reste) > 0;
          case 'retard': return d.statut === 'valide' && Number(d.reste) > 0 && d.jours_retard > 0;
          case 'mes': return d.moi && d.statut === 'valide';
          case 'brouillons': return d.statut === 'brouillon';
          case 'soldes': return d.statut === 'valide' && Number(d.reste) === 0;
          default: return true;
        }
      })
      .filter((d) => !t || `${d.numero} ${d.client} ${d.telephone ?? ''} ${d.responsable ?? ''}`.toLowerCase().includes(t));
  }, [tous, filtre, recherche]);

  const totalEnCours = enCours.reduce((s, d) => s + Number(d.reste), 0);
  const echu = enCours.filter((d) => d.jours_retard > 0);
  const totalEchu = echu.reduce((s, d) => s + Number(d.reste), 0);
  const promesses = enCours.filter((d) => d.promesse).length;
  const aRappeler = enCours.filter((d) => d.jours_retard === 0 && d.jours_restants <= (donnees?.procedure.jours_rappel ?? 3)).length;

  function exporter(format: FormatExport = 'xlsx') {
    exporterClasseur(
      `credits-clients-${aujourdhui()}`,
      [
        {
          nom: 'Crédits clients',
          titre: [`${organisation!.nom} — Crédits clients au ${dateFr(aujourdhui())}`, `Filtre : ${FILTRES.find((f) => f.cle === filtre)!.libelle}`],
          entetes: ['N°', 'Client', 'Téléphone', 'Magasin', 'Accordé le', 'Durée (j)', 'Échéance', 'Retard (j)', 'Étape', 'Total', 'Réglé', 'Reste dû', 'Suivi par'],
          lignes: visibles.map((d) => [
            d.numero, d.client, d.telephone, d.magasin, dateFr(d.date_credit), Number(d.duree_jours), dateFr(d.echeance),
            Number(d.jours_retard), d.statut === 'brouillon' ? 'Brouillon' : ETAPES[d.etape]!.titre, Number(d.total), Number(d.paye),
            Number(d.reste), d.responsable,
          ]),
          totaux: ['Total', '', '', '', '', '', '', '', '', visibles.reduce((s, d) => s + Number(d.total), 0),
            visibles.reduce((s, d) => s + Number(d.paye), 0), visibles.reduce((s, d) => s + Number(d.reste), 0), ''],
        },
      ],
      format,
    );
  }

  return (
    <>
      <EnTetePage
        icone="🤝"
        titre="Crédits clients"
        sousTitre={donnees?.tout_voir ? 'Articles remis à crédit, échéances et relances' : 'Les dossiers dont vous assurez le suivi'}
        actions={
          <>
            <BoutonsExport onExport={exporter} disabled={!visibles.length} />
            {peut('ventes.valider') && (
              <button className="bouton bouton-principal" onClick={() => naviguer('/credits/nouveau')}>Nouveau crédit</button>
            )}
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      <section className="tuiles">
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur"><MontantFort v={totalEnCours} /></span>
          <span className="tuile-libelle">à encaisser · {enCours.length} dossier{enCours.length > 1 ? 's' : ''}</span>
        </div>
        <div className={`tuile tuile-fixe ${totalEchu > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur"><MontantFort v={totalEchu} /></span>
          <span className="tuile-libelle">en retard · {echu.length} dossier{echu.length > 1 ? 's' : ''}</span>
        </div>
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur">{aRappeler}</span>
          <span className="tuile-libelle">échéance{aRappeler > 1 ? 's' : ''} proche{aRappeler > 1 ? 's' : ''} à rappeler</span>
        </div>
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur">{promesses}</span>
          <span className="tuile-libelle">promesse{promesses > 1 ? 's' : ''} de paiement attendue{promesses > 1 ? 's' : ''}</span>
        </div>
      </section>
      <section className="carte">
        <div className="filtres-ligne">
          <div className="segments" role="tablist" aria-label="Filtrer les dossiers">
            {FILTRES.filter((f) => donnees?.tout_voir || f.cle === 'mes' || f.cle === 'retard' || f.cle === 'soldes').map((f) => (
              <button key={f.cle} type="button" role="tab" aria-selected={filtre === f.cle} className={filtre === f.cle ? 'actif' : ''} onClick={() => setFiltre(f.cle)}>
                {f.libelle}
              </button>
            ))}
          </div>
          <input type="search" placeholder="Client, n° de dossier, téléphone…" value={recherche} onChange={(e) => setRecherche(e.target.value)} aria-label="Rechercher" />
        </div>
        {!donnees ? (
          <Vide>Chargement…</Vide>
        ) : visibles.length === 0 ? (
          <Vide>{tous.length === 0 ? 'Aucun crédit pour le moment.' : 'Aucun dossier dans ce filtre.'}</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Dossier</th>
                  <th>Client</th>
                  <th>Échéance</th>
                  <th>Étape</th>
                  <th className="nombre">Total</th>
                  <th className="nombre">Reste dû</th>
                  <th className="col-secondaire">Suivi par</th>
                  <th className="col-secondaire">Dernière démarche</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((d) => (
                  <tr key={d.id} className="ligne-cliquable" onClick={() => naviguer(`/credits/${d.id}`)}>
                    <td>
                      <Link to={`/credits/${d.id}`} onClick={(e) => e.stopPropagation()}>{d.numero}</Link>
                      <div className="secondaire">{d.articles} article{d.articles > 1 ? 's' : ''} · {d.magasin}</div>
                    </td>
                    <td>
                      {d.client}
                      {d.telephone && <div className="secondaire">{d.telephone}</div>}
                    </td>
                    <td>{d.statut === 'brouillon' ? <Pastille ton="gris">Brouillon</Pastille> : <Echeance d={d} />}</td>
                    <td>{d.statut === 'valide' && Number(d.reste) > 0 ? <EtapePastille etape={d.etape} /> : '—'}</td>
                    <td className="nombre">{montant(d.total)}</td>
                    <td className="nombre">
                      <strong>{montant(d.reste)}</strong>
                      {d.statut === 'valide' && Number(d.total) > 0 && (
                        <div className="jauge" title={`${Math.round((Number(d.paye) / Number(d.total)) * 100)} % réglé`}>
                          <span style={{ width: `${Math.round((Number(d.paye) / Number(d.total)) * 100)}%` }} />
                        </div>
                      )}
                    </td>
                    <td className="col-secondaire">{d.responsable ?? '—'}{d.moi && <span className="secondaire"> (vous)</span>}</td>
                    <td className="col-secondaire">
                      {d.promesse ? (
                        <>🤝 Promesse au {dateFr(d.promesse)}</>
                      ) : d.derniere_action ? (
                        <>{ACTIONS_SUIVI[d.derniere_action.action]?.icone} {dateFr(d.derniere_action.created_at)}</>
                      ) : (
                        '—'
                      )}
                    </td>
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

interface LigneSaisie {
  produit_id: string;
  designation: string;
  quantite: number;
  prix_unitaire: number;
  remise: number;
}
interface Situation {
  plafond: number | null;
  delai: number;
  encours: number;
  echu: number;
  retard: number;
  etape: number;
  bloque: boolean;
  disponible: number | null;
}

/** Préparer un crédit (ou reprendre un brouillon) : client, articles, durée ⇄ échéance, suivi. */
export function FormulaireCredit() {
  const { id } = useParams();
  const { organisation, session } = useSession();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const magasins = useMagasins(org);
  const magasinGlobal = useMagasinGlobal();
  const [magasin, setMagasin] = useState('');
  const [clients, setClients] = useState<{ id: string; nom: string; telephone: string | null; delai_paiement: number }[]>([]);
  const [client, setClient] = useState('');
  const [situation, setSituation] = useState<Situation | null>(null);
  const [duree, setDuree] = useState(30);
  const [echeance, setEcheance] = useState(plusJours(aujourdhui(), 30));
  const [lignes, setLignes] = useState<LigneSaisie[]>([]);
  const [stocks, setStocks] = useState<Record<string, number>>({});
  const [personnes, setPersonnes] = useState<{ id: string; nom: string; role: string }[]>([]);
  const [responsable, setResponsable] = useState(session?.user.id ?? '');
  const [note, setNote] = useState('');
  const [motif, setMotif] = useState('');
  const [demandeMotif, setDemandeMotif] = useState('');
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);
  // Un brouillon déjà enregistré (motif demandé, erreur) est repris au lieu d'en créer un autre.
  const [brouillon, setBrouillon] = useState<string | null>(id ?? null);

  useEffect(() => {
    void supabase.from('clients').select('id, nom, telephone, delai_paiement').eq('organisation_id', org).eq('actif', true).order('nom')
      .then(({ data }) => setClients((data ?? []) as typeof clients));
  }, [org]);
  useEffect(() => {
    if (!magasin && magasins.length) setMagasin(magasinGlobal && magasins.some((m) => m.id === magasinGlobal) ? magasinGlobal : magasins[0]!.id);
  }, [magasins, magasin, magasinGlobal]);

  // Reprise d'un brouillon.
  useEffect(() => {
    if (!id) return;
    void supabase.rpc('credit_detail', { p_credit: id }).then(({ data, error }) => {
      if (error) return setErreur(messageErreur(error));
      const d = data as DetailCredit;
      if (d.dossier.statut !== 'brouillon') return naviguer(`/credits/${id}`, { replace: true });
      setMagasin(d.dossier.magasin_id);
      setClient(d.client.id);
      setEcheance(d.dossier.echeance);
      setDuree(ecartJours(aujourdhui(), d.dossier.echeance));
      setResponsable(d.dossier.responsable_id ?? '');
      setNote(d.dossier.note ?? '');
      setLignes(d.lignes.map((l) => ({ produit_id: l.produit_id, designation: l.designation, quantite: Number(l.quantite), prix_unitaire: Number(l.prix_unitaire), remise: Number(l.remise) })));
    });
  }, [id, naviguer]);

  useEffect(() => {
    if (!magasin) return;
    void supabase.rpc('personnes_suivi_credit', { p_org: org, p_magasin: magasin }).then(({ data }) => {
      const p = (data ?? []) as typeof personnes;
      setPersonnes(p);
      setResponsable((r) => (p.some((x) => x.id === r) ? r : (p[0]?.id ?? '')));
    });
  }, [org, magasin]);

  useEffect(() => {
    setSituation(null);
    if (!client) return;
    void supabase.rpc('situation_client_credit', { p_client: client }).then(({ data }) => setSituation(data as Situation));
  }, [client]);

  const ids = lignes.map((l) => l.produit_id).join(',');
  useEffect(() => {
    if (!magasin || !ids) return setStocks({});
    void supabase.from('stocks').select('produit_id, quantite').eq('magasin_id', magasin).in('produit_id', ids.split(','))
      .then(({ data }) => setStocks(Object.fromEntries((data ?? []).map((s: { produit_id: string; quantite: number }) => [s.produit_id, Number(s.quantite)]))));
  }, [magasin, ids]);

  const total = lignes.reduce((s, l) => s + Math.round(l.quantite * l.prix_unitaire) - l.remise, 0);
  const manques = lignes.filter((l) => (stocks[l.produit_id] ?? 0) < lignes.filter((x) => x.produit_id === l.produit_id).reduce((s, x) => s + x.quantite, 0));
  const depassePlafond = situation?.plafond != null && Number(situation.encours) + total > Number(situation.plafond);

  function choisirDuree(n: number) {
    const v = Math.max(0, Math.min(365, Math.round(n || 0)));
    setDuree(v);
    setEcheance(plusJours(aujourdhui(), v));
  }
  function choisirEcheance(iso: string) {
    if (!iso) return;
    setEcheance(iso);
    setDuree(ecartJours(aujourdhui(), iso));
  }
  function choisirClient(cid: string) {
    setClient(cid);
    const c = clients.find((x) => x.id === cid);
    if (c && !id) choisirDuree(c.delai_paiement);
  }
  async function ajouter(p: ProduitTrouve) {
    setLignes((ls) => {
      const i = ls.findIndex((l) => l.produit_id === p.id);
      if (i >= 0) return ls.map((l, k) => (k === i ? { ...l, quantite: l.quantite + 1 } : l));
      return [...ls, { produit_id: p.id, designation: p.designation, quantite: 1, prix_unitaire: Number(p.prix_vente), remise: 0 }];
    });
  }
  const maj = (i: number, champs: Partial<LigneSaisie>) => setLignes((ls) => ls.map((l, k) => (k === i ? { ...l, ...champs } : l)));

  async function enregistrer(valider: boolean, e?: FormEvent) {
    e?.preventDefault();
    setErreur('');
    if (!client) return setErreur('Choisissez le client.');
    if (!lignes.length) return setErreur('Ajoutez au moins un article.');
    if (duree < 0 || duree > 365) return setErreur('La durée de paiement va de 0 à 365 jours.');
    setEnCours(true);
    const { data, error } = await supabase.rpc('enregistrer_credit', {
      p: {
        id: brouillon,
        organisation_id: org,
        magasin_id: magasin,
        client_id: client,
        duree_jours: duree,
        echeance,
        responsable_id: responsable || null,
        note: note.trim() || null,
        lignes: lignes.map((l) => ({ produit_id: l.produit_id, quantite: l.quantite, prix_unitaire: l.prix_unitaire, remise: l.remise })),
      },
    });
    if (error) {
      setEnCours(false);
      return setErreur(messageErreur(error));
    }
    const credit = data as string;
    setBrouillon(credit);
    if (valider) {
      const v = await supabase.rpc('valider_credit', { p_credit: credit, p_motif: motif.trim() || null });
      if (v.error) {
        setEnCours(false);
        const m = messageErreur(v.error);
        if (/motif/i.test(m) && !motif.trim()) return setDemandeMotif(m);
        return setErreur(`${m} Le dossier est gardé en brouillon.`);
      }
    }
    setEnCours(false);
    naviguer(`/credits/${credit}`);
  }

  return (
    <>
      <EnTetePage icone="🤝" titre={id ? 'Reprendre le brouillon' : 'Nouveau crédit'} sousTitre="Articles remis au client, date de paiement et personne chargée du suivi" />
      <Alerte>{erreur}</Alerte>
      <form onSubmit={(e) => void enregistrer(true, e)}>
        <section className="carte">
          <h2>Client et paiement</h2>
          <div className="grille-4">
            <Champ label="Client">
              <select value={client} onChange={(e) => choisirClient(e.target.value)} required>
                <option value="">Choisir…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.nom}{c.telephone ? ` · ${c.telephone}` : ''}</option>
                ))}
              </select>
            </Champ>
            <Champ label="Magasin qui remet les articles">
              <select value={magasin} onChange={(e) => setMagasin(e.target.value)}>
                {magasins.map((m) => (
                  <option key={m.id} value={m.id}>{m.nom}</option>
                ))}
              </select>
            </Champ>
            <Champ label="Durée de paiement (jours)" aide="La date de paiement se calcule toute seule">
              <input type="number" min={0} max={365} value={duree} onChange={(e) => choisirDuree(Number(e.target.value))} />
            </Champ>
            <Champ label="Date de paiement" aide="… ou choisissez la date : la durée suit">
              <input type="date" min={aujourdhui()} max={plusJours(aujourdhui(), 365)} value={echeance} onChange={(e) => choisirEcheance(e.target.value)} required />
            </Champ>
          </div>
          <div className="puces-durees" role="group" aria-label="Durées courantes">
            {DUREES.map((n) => (
              <button key={n} type="button" className={`puce-montant ${duree === n ? 'active' : ''}`} onClick={() => choisirDuree(n)}>{n} jours</button>
            ))}
          </div>
          {situation && (
            <div className={`situation-client ${situation.bloque || depassePlafond ? 'alerte' : ''}`}>
              <div><span>Doit déjà</span><strong>{montant(situation.encours)}</strong></div>
              <div><span>Dont en retard</span><strong>{montant(situation.echu)}</strong>{situation.retard > 0 && <small>{situation.retard} j · {ETAPES[situation.etape]!.titre}</small>}</div>
              <div><span>Plafond</span><strong>{situation.plafond == null ? 'Aucun' : montant(situation.plafond)}</strong></div>
              <div><span>Avec ce crédit</span><strong>{montant(Number(situation.encours) + total)}</strong></div>
              {situation.bloque && <p className="situation-message">⛔ La procédure bloque les nouveaux crédits pour ce client : un motif sera demandé.</p>}
              {!situation.bloque && depassePlafond && <p className="situation-message">⚠️ Le plafond sera dépassé : un motif sera demandé.</p>}
            </div>
          )}
        </section>

        <section className="carte">
          <h2>Articles remis à crédit</h2>
          <RechercheProduit org={org} onChoisir={(p) => void ajouter(p)} placeholder="Scanner ou chercher un article à ajouter" />
          {lignes.length === 0 ? (
            <Vide>Aucun article : scannez ou cherchez les articles que le client emporte.</Vide>
          ) : (
            <div className="defilement-horizontal">
              <table className="tableau tableau-saisie">
                <thead>
                  <tr><th>Article</th><th className="nombre">En stock</th><th className="nombre">Qté</th><th className="nombre">Prix unitaire</th><th className="nombre">Remise</th><th className="nombre">Montant</th><th aria-label="Retirer" /></tr>
                </thead>
                <tbody>
                  {lignes.map((l, i) => (
                    <tr key={l.produit_id}>
                      <td>{l.designation}</td>
                      <td className="nombre">
                        {manques.includes(l) ? <Pastille ton="rouge">{quantite(stocks[l.produit_id] ?? 0)}</Pastille> : quantite(stocks[l.produit_id] ?? 0)}
                      </td>
                      <td className="nombre">
                        <input className="champ-nombre" inputMode="decimal" value={l.quantite}
                          onChange={(e) => { const v = Number(e.target.value.replace(',', '.')); if (v >= 0) maj(i, { quantite: v }); }} aria-label={`Quantité de ${l.designation}`} />
                      </td>
                      <td className="nombre">
                        <input className="champ-nombre champ-prix" inputMode={clavierMontant()} defaultValue={montant(l.prix_unitaire, '')}
                          onBlur={(e) => maj(i, { prix_unitaire: lireMontant(e.target.value) ?? l.prix_unitaire })} aria-label={`Prix de ${l.designation}`} />
                      </td>
                      <td className="nombre">
                        <input className="champ-nombre champ-prix" inputMode={clavierMontant()} defaultValue={l.remise ? montant(l.remise, '') : ''} placeholder="0"
                          onBlur={(e) => maj(i, { remise: lireMontant(e.target.value) ?? 0 })} aria-label={`Remise sur ${l.designation}`} />
                      </td>
                      <td className="nombre">{montant(Math.round(l.quantite * l.prix_unitaire) - l.remise)}</td>
                      <td><button type="button" className="bouton-lien lien-danger" onClick={() => setLignes((ls) => ls.filter((_, k) => k !== i))}>Retirer</button></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="ligne-total"><td colSpan={5}>Total du crédit</td><td className="nombre">{montant(total)}</td><td /></tr>
                </tfoot>
              </table>
            </div>
          )}
          {manques.length > 0 && <Alerte type="info">Stock insuffisant pour certains articles : le crédit ne pourra pas être validé tant que le stock du magasin ne suffit pas.</Alerte>}
        </section>

        <section className="carte">
          <h2>Suivi du dossier</h2>
          <div className="grille-2">
            <Champ label="Suivi confié à" aide="Elle verra le dossier, encaissera à sa caisse et fera les relances">
              <select value={responsable} onChange={(e) => setResponsable(e.target.value)}>
                {personnes.map((p) => (
                  <option key={p.id} value={p.id}>{p.id === session?.user.id ? `Moi-même (${p.nom})` : `${p.nom} · ${p.role}`}</option>
                ))}
              </select>
            </Champ>
            <Champ label="Conditions ou note" aide="Imprimée sur le bon de crédit">
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Ex. : paiement en deux fois, livraison comprise…" />
            </Champ>
          </div>
          {demandeMotif && (
            <div className="bloc-motif">
              <Alerte type="info">{demandeMotif}</Alerte>
              <Champ label="Motif pour accorder quand même">
                <input value={motif} onChange={(e) => setMotif(e.target.value)} maxLength={300} autoFocus placeholder="Ex. : client fidèle, garantie reçue…" />
              </Champ>
            </div>
          )}
          <div className="actions-piece">
            <button type="button" className="bouton bouton-discret" disabled={enCours} onClick={() => void enregistrer(false)}>Garder en brouillon</button>
            <button className="bouton bouton-principal" disabled={enCours || !lignes.length || manques.length > 0 || (!!demandeMotif && motif.trim().length < 3)}>
              Accorder le crédit · {montant(total)}
            </button>
          </div>
          <p className="secondaire">En accordant le crédit, les articles sortent du stock et la créance du client est ouverte jusqu’au {dateFr(echeance)}.</p>
        </section>
      </form>
    </>
  );
}

/** Frise des étapes de la procédure, avec l'étape atteinte par le dossier. */
function FriseProcedure({ d }: { d: DetailCredit }) {
  const s = seuils(d.procedure);
  const x = d.dossier;
  const actif = x.statut === 'valide' && Number(x.reste) > 0;
  const prochaine = x.etape < 4 ? s[x.etape + 1]! - x.jours_retard : null;
  return (
    <section className="carte">
      <h2>Procédure de recouvrement</h2>
      <ol className="frise-procedure">
        {ETAPES.map((e, i) => (
          <li key={i} className={`${actif && i === x.etape ? 'en-cours' : ''} ${actif && i < x.etape ? 'passee' : ''}`}>
            <span className="frise-point" aria-hidden>{i === 0 ? '✓' : i}</span>
            <strong>{e.titre}</strong>
            <small>{i === 0 ? 'Avant l’échéance' : `Dès ${s[i]} j de retard`}</small>
          </li>
        ))}
      </ol>
      {actif && (
        <p className="conseil-procedure">
          <strong>{ETAPES[x.etape]!.titre} :</strong> {ETAPES[x.etape]!.conseil}
          {x.jours_retard === 0 && x.jours_restants >= 0 && ` Échéance ${x.jours_restants === 0 ? 'aujourd’hui' : `dans ${x.jours_restants} jour${x.jours_restants > 1 ? 's' : ''}`}.`}
          {x.jours_retard > 0 && prochaine !== null && ` Étape suivante (${ETAPES[x.etape + 1]!.titre.toLowerCase()}) dans ${prochaine} jour${prochaine > 1 ? 's' : ''}.`}
          {x.etape >= d.procedure.blocage_palier && x.etape > 0 && ' Les nouveaux crédits de ce client sont bloqués.'}
        </p>
      )}
    </section>
  );
}

/** Fiche d'un dossier : situation, procédure, articles, règlements, démarches. */
export function FicheCredit() {
  const { id } = useParams();
  const { organisation, peut } = useSession();
  const { identite } = useIdentite();
  const { imprimer } = useImpression();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const { comptes } = useComptes(peut('tresorerie.creer') ? org : undefined);
  const [d, setD] = useState<DetailCredit | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [fenetre, setFenetre] = useState<null | 'encaisser' | 'demarche' | 'confier' | 'relance' | 'valider'>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [personnes, setPersonnes] = useState<{ id: string; nom: string; role: string }[]>([]);

  const charger = useCallback(async () => {
    const { data, error } = await supabase.rpc('credit_detail', { p_credit: id });
    if (error) return setErreur(messageErreur(error));
    setD(data as DetailCredit);
  }, [id]);
  useEffect(() => {
    void charger();
  }, [charger]);

  if (!d) return <EnTetePage titre="Crédit" sousTitre={erreur || 'Chargement…'} />;
  const x = d.dossier;
  const o = identite?.organisation;
  const logo = identite?.logoUrl ?? null;
  const enCours = x.statut === 'valide' && Number(x.reste) > 0;
  const responsable = peut('ventes.valider');
  const peutSuivre = responsable || peut('tresorerie.creer') || x.moi;
  const niveauConseille = Math.max(1, x.etape);

  /** Lance l'appel ; renvoie le message d'erreur, ou null si tout s'est bien passé. */
  async function executer(f: () => PromiseLike<{ error: unknown }>, succes: string): Promise<string | null> {
    setErreur('');
    setInfo('');
    const { error } = await f();
    if (error) {
      const m = messageErreur(error);
      setErreur(m);
      return m;
    }
    setFenetre(null);
    setForm({});
    setInfo(succes);
    await charger();
    return null;
  }

  async function encaisser(e: FormEvent) {
    e.preventDefault();
    const m = lireMontant(form.montant ?? '');
    if (!m || m <= 0) return setErreur('Indiquez le montant reçu.');
    await executer(
      () => supabase.rpc('encaisser_credit', { p_credit: x.id, p_montant: m, p_compte: form.compte, p_reference: form.reference || null }),
      'Règlement enregistré : il entre dans le compte choisi.',
    );
  }

  async function relancer(niveau: number) {
    const echec = await executer(
      () => supabase.rpc('suivre_credit', { p_credit: x.id, p_action: niveau === 0 ? 'rappel' : 'relance', p_niveau: niveau, p_note: form.note || null }),
      niveau === 0 ? 'Rappel noté et prêt à imprimer.' : 'Relance notée au dossier et au compte du client.',
    );
    if (!echec) await imprimer(<LettreCredit d={d!} niveau={niveau} o={o} logoUrl={logo} />, 'a4');
  }

  async function noter(e: FormEvent) {
    e.preventDefault();
    const action = form.action || 'appel';
    await executer(
      () => supabase.rpc('suivre_credit', {
        p_credit: x.id,
        p_action: action,
        p_niveau: 0,
        p_note: form.note || null,
        p_date_promesse: action === 'promesse' ? form.date || null : null,
        p_montant_promis: action === 'promesse' ? lireMontant(form.montant ?? '') : null,
      }),
      'Démarche notée au dossier.',
    );
  }

  async function ouvrirConfier() {
    const { data } = await supabase.rpc('personnes_suivi_credit', { p_org: org, p_magasin: x.magasin_id });
    setPersonnes((data ?? []) as typeof personnes);
    setForm({ responsable: x.responsable_id ?? '' });
    setFenetre('confier');
  }

  async function valider(e?: FormEvent) {
    e?.preventDefault();
    const echec = await executer(() => supabase.rpc('valider_credit', { p_credit: x.id, p_motif: form.motif?.trim() || null }), 'Crédit accordé : les articles sont sortis du stock.');
    if (echec && /motif/i.test(echec) && fenetre !== 'valider') setFenetre('valider');
  }

  async function annuler() {
    const motif = window.prompt(x.statut === 'brouillon' ? 'Motif de l’abandon du brouillon' : 'Motif de l’annulation (les articles reviennent en stock)');
    if (!motif?.trim()) return;
    const echec = await executer(() => supabase.rpc('annuler_credit', { p_credit: x.id, p_motif: motif.trim() }), 'Dossier annulé.');
    if (!echec && x.statut === 'brouillon') naviguer('/credits');
  }

  return (
    <>
      <EnTetePage
        icone="🤝"
        titre={`Crédit ${x.numero} · ${d.client.nom}`}
        sousTitre={
          x.statut === 'brouillon'
            ? 'Brouillon : pas encore accordé'
            : x.statut === 'annule'
              ? `Annulé${x.motif_annulation ? ` · ${x.motif_annulation}` : ''}`
              : `Accordé le ${dateFr(x.date_credit)} pour ${x.duree_jours} jours · suivi par ${x.responsable ?? '—'}${x.moi ? ' (vous)' : ''}`
        }
        actions={
          <>
            {x.statut !== 'annule' && (
              <button className="bouton bouton-discret" onClick={() => void imprimer(<BonCredit d={d} o={o} logoUrl={logo} />, 'a4')}>🖨️ Bon de crédit</button>
            )}
            {x.statut === 'valide' && (
              <button className="bouton bouton-discret" onClick={() => void imprimer(<ReleveCredit d={d} o={o} logoUrl={logo} />, 'a4')}>Relevé</button>
            )}
            <button className="bouton bouton-discret" onClick={() => naviguer('/credits')}>Retour</button>
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      {x.statut === 'brouillon' && responsable && (
        <section className="carte carte-action">
          <p>Ce dossier n’est pas encore accordé : les articles sont toujours en stock.</p>
          <div className="actions-piece">
            <button className="bouton-lien lien-danger" onClick={() => void annuler()}>Abandonner</button>
            <button className="bouton bouton-discret" onClick={() => naviguer(`/credits/${x.id}/modifier`)}>Modifier</button>
            <button className="bouton bouton-principal" onClick={() => void valider()}>Accorder le crédit · {montant(x.total)}</button>
          </div>
        </section>
      )}

      <section className="tuiles">
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur"><MontantFort v={x.total} /></span>
          <span className="tuile-libelle">total · {d.lignes.length} article{d.lignes.length > 1 ? 's' : ''}</span>
        </div>
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur"><MontantFort v={x.paye} /></span>
          <span className="tuile-libelle">déjà réglé</span>
        </div>
        <div className={`tuile tuile-fixe ${x.jours_retard > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur"><MontantFort v={x.reste} /></span>
          <span className="tuile-libelle">reste dû</span>
        </div>
        <div className={`tuile tuile-fixe ${x.jours_retard > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur">{dateFr(x.echeance)}</span>
          <span className="tuile-libelle">
            {x.statut !== 'valide' ? 'date de paiement prévue' : Number(x.reste) === 0 ? 'soldé' : x.jours_retard > 0 ? `${x.jours_retard} jours de retard` : x.jours_restants === 0 ? 'échéance aujourd’hui' : `échéance dans ${x.jours_restants} j`}
          </span>
        </div>
      </section>

      {x.statut === 'valide' && <FriseProcedure d={d} />}

      {enCours && peutSuivre && (
        <section className="carte">
          <h2>Que faire maintenant ?</h2>
          <div className="actions-suivi">
            {peut('tresorerie.creer') ? (
              <button className="bouton bouton-principal" onClick={() => { setForm({ montant: montant(x.reste, ''), compte: comptes[0]?.id ?? '' }); setFenetre('encaisser'); }}>💰 Encaisser un règlement</button>
            ) : (
              x.moi && <Link className="bouton bouton-principal" to="/caisse">💰 Encaisser à ma caisse</Link>
            )}
            {x.jours_retard === 0 ? (
              <button className="bouton bouton-discret" onClick={() => void relancer(0)}>🔔 Rappel avant échéance</button>
            ) : (
              <button className="bouton bouton-discret" onClick={() => { setForm({ niveau: String(niveauConseille) }); setFenetre('relance'); }}>
                ✉️ Lettre : {ETAPES[niveauConseille]!.titre.toLowerCase()}
              </button>
            )}
            <button className="bouton bouton-discret" onClick={() => { setForm({ action: 'appel', date: plusJours(aujourdhui(), 7) }); setFenetre('demarche'); }}>📞 Noter une démarche</button>
            {responsable && <button className="bouton bouton-discret" onClick={() => void ouvrirConfier()}>👤 Confier le suivi</button>}
          </div>
        </section>
      )}

      <div className="grille-fiche">
        <section className="carte">
          <h2>Articles remis</h2>
          <table className="tableau tableau-compact">
            <thead>
              <tr><th>Article</th><th className="nombre">Qté</th><th className="nombre">Prix</th><th className="nombre">Montant</th></tr>
            </thead>
            <tbody>
              {d.lignes.map((l) => (
                <tr key={l.id}>
                  <td>{l.designation}{Number(l.remise) > 0 && <span className="secondaire"> · remise {montant(l.remise)}</span>}</td>
                  <td className="nombre">{quantite(l.quantite)}</td>
                  <td className="nombre">{montant(l.prix_unitaire)}</td>
                  <td className="nombre">{montant(l.montant)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="ligne-total"><td colSpan={3}>Total</td><td className="nombre">{montant(x.total)}</td></tr>
            </tfoot>
          </table>
          {x.note && <p className="secondaire">Conditions : {x.note}</p>}
          {x.motif_exception && <p className="secondaire">Accordé par exception : {x.motif_exception}</p>}
        </section>

        <section className="carte">
          <h2>Client</h2>
          <ul className="liste-simple">
            <li><span>Téléphone</span><strong>{d.client.telephone ?? '—'}</strong></li>
            <li><span>Adresse</span><strong>{d.client.adresse ?? '—'}</strong></li>
            <li><span>Doit au total (tous crédits)</span><strong>{montant(d.client.encours)}</strong></li>
            <li><span>Plafond de crédit</span><strong>{d.client.plafond_credit == null ? 'Aucun' : montant(d.client.plafond_credit)}</strong></li>
          </ul>
          {peut('tresorerie.consulter') && <p><Link to={`/tresorerie/clients/${d.client.id}`}>Relevé de compte complet du client →</Link></p>}
        </section>
      </div>

      {x.statut === 'valide' && (
        <section className="carte">
          <h2>Règlements reçus</h2>
          {d.encaissements.length === 0 ? (
            <Vide>Aucun règlement pour le moment.</Vide>
          ) : (
            <table className="tableau">
              <thead>
                <tr><th>Date</th><th>Reçu sur</th><th className="col-secondaire">Référence</th><th className="col-secondaire">Par</th><th className="nombre">Montant</th></tr>
              </thead>
              <tbody>
                {d.encaissements.map((e) => (
                  <tr key={e.id} className={e.statut === 'annule' ? 'ligne-annulee' : ''}>
                    <td>{dateFr(e.date)}</td>
                    <td>{e.compte}{e.a_la_caisse && <span className="secondaire"> · à la caisse</span>}</td>
                    <td className="col-secondaire">{e.reference ?? '—'}</td>
                    <td className="col-secondaire">{e.par ?? '—'}</td>
                    <td className="nombre">{montant(e.montant)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {x.statut === 'valide' && (
        <section className="carte">
          <h2>Démarches de suivi</h2>
          {d.suivi.length === 0 ? (
            <Vide>Aucune démarche notée.</Vide>
          ) : (
            <ul className="liste-suivi">
              {d.suivi.map((s) => (
                <li key={s.id}>
                  <span className="suivi-icone" aria-hidden>{ACTIONS_SUIVI[s.action]?.icone}</span>
                  <div>
                    <strong>
                      {s.action === 'relance' ? `Lettre : ${ETAPES[s.niveau]!.titre.toLowerCase()}` : ACTIONS_SUIVI[s.action]?.libelle}
                      {s.action === 'promesse' && s.date_promesse && ` pour le ${dateFr(s.date_promesse)}${s.montant_promis ? ` (${montant(s.montant_promis)})` : ''}`}
                    </strong>
                    {s.note && <p>{s.note}</p>}
                    <small>{new Date(s.le).toLocaleString('fr-FR', { timeZone: 'Africa/Abidjan' })} · {s.par ?? '—'} · reste dû {montant(s.reste_du)}{s.jours_retard > 0 ? ` · ${s.jours_retard} j de retard` : ''}</small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {x.statut === 'valide' && Number(x.paye) === 0 && peut('ventes.annuler') && (
        <p className="actions-piece">
          <button className="bouton-lien lien-danger" onClick={() => void annuler()}>Annuler ce crédit (les articles reviennent en stock)</button>
        </p>
      )}

      <Fenetre titre="Encaisser un règlement" ouverte={fenetre === 'encaisser'} onFermer={() => setFenetre(null)}>
        <form className="formulaire" onSubmit={encaisser}>
          <Alerte>{erreur}</Alerte>
          <div className="grille-2">
            <Champ label={`Montant reçu (reste ${montant(x.reste)})`}>
              <input value={form.montant ?? ''} onChange={(e) => setForm({ ...form, montant: e.target.value })} inputMode={clavierMontant()} required autoFocus />
            </Champ>
            <Champ label="Reçu sur">
              <select value={form.compte ?? ''} onChange={(e) => setForm({ ...form, compte: e.target.value })} required>
                {comptes.map((c) => (
                  <option key={c.id} value={c.id}>{c.nom}</option>
                ))}
              </select>
            </Champ>
          </div>
          <Champ label="Référence" aide="N° de transaction Wave, Orange Money, chèque…">
            <input value={form.reference ?? ''} onChange={(e) => setForm({ ...form, reference: e.target.value })} maxLength={60} />
          </Champ>
          <button className="bouton bouton-principal">Enregistrer le règlement</button>
        </form>
      </Fenetre>

      <Fenetre titre="Lettre de relance" ouverte={fenetre === 'relance'} onFermer={() => setFenetre(null)}>
        <div className="formulaire">
          <Alerte>{erreur}</Alerte>
          <p>Le dossier a <strong>{x.jours_retard} jours de retard</strong> : la procédure conseille l’étape « {ETAPES[niveauConseille]!.titre} ».</p>
          <Champ label="Lettre à imprimer">
            <select value={form.niveau ?? String(niveauConseille)} onChange={(e) => setForm({ ...form, niveau: e.target.value })}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>{ETAPES[n]!.titre}{n === niveauConseille ? ' (conseillée)' : ''}</option>
              ))}
            </select>
          </Champ>
          <Champ label="Note pour le dossier (facultatif)">
            <input value={form.note ?? ''} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} placeholder="Ex. : remise en main propre au gérant du restaurant" />
          </Champ>
          <button className="bouton bouton-principal" onClick={() => void relancer(Number(form.niveau ?? niveauConseille))}>Noter et imprimer la lettre</button>
        </div>
      </Fenetre>

      <Fenetre titre="Noter une démarche" ouverte={fenetre === 'demarche'} onFermer={() => setFenetre(null)}>
        <form className="formulaire" onSubmit={noter}>
          <Alerte>{erreur}</Alerte>
          <Champ label="Démarche">
            <select value={form.action ?? 'appel'} onChange={(e) => setForm({ ...form, action: e.target.value })}>
              {(['appel', 'visite', 'message', 'promesse', 'note'] as const).map((a) => (
                <option key={a} value={a}>{ACTIONS_SUIVI[a]!.libelle}</option>
              ))}
            </select>
          </Champ>
          {form.action === 'promesse' && (
            <div className="grille-2">
              <Champ label="Le client paiera le">
                <input type="date" min={aujourdhui()} value={form.date ?? ''} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
              </Champ>
              <Champ label="Montant promis">
                <input value={form.montant ?? ''} onChange={(e) => setForm({ ...form, montant: e.target.value })} inputMode={clavierMontant()} placeholder={montant(x.reste, '')} />
              </Champ>
            </div>
          )}
          <Champ label="Ce qui a été dit ou convenu">
            <input value={form.note ?? ''} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} />
          </Champ>
          <button className="bouton bouton-principal">Noter au dossier</button>
        </form>
      </Fenetre>

      <Fenetre titre="Confier le suivi" ouverte={fenetre === 'confier'} onFermer={() => setFenetre(null)}>
        <form className="formulaire" onSubmit={(e) => { e.preventDefault(); void executer(() => supabase.rpc('confier_credit', { p_credit: x.id, p_responsable: form.responsable }), 'Suivi confié.'); }}>
          <Alerte>{erreur}</Alerte>
          <Champ label="Personne chargée du suivi" aide="Elle verra ce dossier, encaissera à sa caisse et fera les relances">
            <select value={form.responsable ?? ''} onChange={(e) => setForm({ ...form, responsable: e.target.value })} required>
              {personnes.map((p) => (
                <option key={p.id} value={p.id}>{p.nom} · {p.role}</option>
              ))}
            </select>
          </Champ>
          <button className="bouton bouton-principal">Confier</button>
        </form>
      </Fenetre>

      <Fenetre titre="Accorder le crédit par exception" ouverte={fenetre === 'valider'} onFermer={() => setFenetre(null)}>
        <form className="formulaire" onSubmit={(e) => void valider(e)}>
          <Alerte type="info">{erreur}</Alerte>
          <Champ label="Motif">
            <input value={form.motif ?? ''} onChange={(e) => setForm({ ...form, motif: e.target.value })} maxLength={300} required minLength={3} autoFocus placeholder="Ex. : client fidèle, garantie reçue…" />
          </Champ>
          <button className="bouton bouton-principal">Accorder quand même</button>
        </form>
      </Fenetre>
    </>
  );
}

/** Réglage de la procédure de recouvrement. */
export function ProcedureCredit() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const [p, setP] = useState<Procedure | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const modifiable = peut('ventes.valider') && peut('clients.modifier');

  useEffect(() => {
    void supabase.rpc('procedure_credit', { p_org: org }).then(({ data }) => setP(data as Procedure));
  }, [org]);

  async function enregistrer(e: FormEvent) {
    e.preventDefault();
    if (!p) return;
    setErreur('');
    const { data, error } = await supabase.rpc('regler_procedure_credit', { p_org: org, p });
    if (error) return setErreur(messageErreur(error));
    setP(data as Procedure);
    setInfo('Procédure enregistrée : elle s’applique à tous les dossiers.');
  }

  if (!p) return <EnTetePage titre="Procédure de relance" sousTitre="Chargement…" />;
  const champ = (cle: keyof Procedure) => (
    <input type="number" min={cle === 'jours_rappel' ? 0 : 1} max={365} value={p[cle]} disabled={!modifiable}
      onChange={(e) => setP({ ...p, [cle]: Number(e.target.value) })} aria-label={cle} />
  );

  return (
    <>
      <EnTetePage icone="🪜" titre="Procédure de relance" sousTitre="Ce qu’il faut faire, et quand, lorsqu’un client paie en retard" />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      <form className="carte" onSubmit={enregistrer}>
        <ol className="procedure-etapes">
          <li>
            <div><strong>Rappel avant échéance</strong><p>{ETAPES[0]!.conseil}</p></div>
            <label className="champ-jours">{champ('jours_rappel')} jours avant</label>
          </li>
          {[1, 2, 3, 4].map((n) => (
            <li key={n}>
              <div><strong>{ETAPES[n]!.titre}</strong><p>{ETAPES[n]!.conseil}</p></div>
              <label className="champ-jours">dès {champ(`palier_${n}` as keyof Procedure)} jours de retard</label>
            </li>
          ))}
        </ol>
        <Champ label="Bloquer les nouveaux crédits d’un client à partir de l’étape" aide="Le responsable peut toujours accorder un crédit en donnant un motif, qui reste au dossier">
          <select value={p.blocage_palier} disabled={!modifiable} onChange={(e) => setP({ ...p, blocage_palier: Number(e.target.value) })}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>{ETAPES[n]!.titre}</option>
            ))}
            <option value={5}>Ne jamais bloquer</option>
          </select>
        </Champ>
        {modifiable && (
          <div className="actions-piece">
            <button className="bouton bouton-principal">Enregistrer la procédure</button>
          </div>
        )}
      </form>
    </>
  );
}
