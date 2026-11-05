import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { useIdentite } from '../../lib/identite';
import { messageErreur } from '../../lib/format';
import { clavierMontant, lireMontant, montant } from '../../lib/argent';
import { aujourdhui, dateFr, useComptes } from '../../lib/tresorerie';
import { useImpression } from '../../impression/impression';
import { classeurXlsx, telechargerFichier, TYPE_XLSX } from '../../lib/excel';
import { enUnites } from '../../lib/argent';
import { Alerte, Champ, EnTetePage, Fenetre, MontantFort, Pastille, Vide } from '../../components/ui';

/** Module Trésorerie : comptes, créances clients, approvisionnement. */
export function TresorerieModule() {
  const { peut } = useSession();
  return (
    <>
      <nav className="onglets" aria-label="Trésorerie">
        <NavLink to="/tresorerie" end>
          <span className="onglet-icone" aria-hidden>💰</span>Comptes
        </NavLink>
        <NavLink to="/tresorerie/creances">
          <span className="onglet-icone" aria-hidden>📨</span>Créances clients
        </NavLink>
        {(peut('achats.creer') || peut('stock.creer') || peut('fournisseurs.consulter')) && (
          <NavLink to="/tresorerie/approvisionnement">
            <span className="onglet-icone" aria-hidden>🛒</span>Approvisionnement
          </NavLink>
        )}
      </nav>
      <Outlet />
    </>
  );
}

interface LigneBalance {
  id: string;
  nom: string;
  telephone: string | null;
  plafond_credit: number | null;
  total: number;
  non_echu: number;
  j30: number;
  j60: number;
  j90: number;
  plus90: number;
  retard_max: number | null;
  derniere_relance: string | null;
  niveau_relance: number | null;
}
interface Client {
  id: string;
  nom: string;
  telephone: string | null;
  email: string | null;
  adresse: string | null;
  contact: string | null;
  ncc: string | null;
  plafond_credit: number | null;
  delai_paiement: number;
  note: string | null;
  actif: boolean;
}

const TRANCHES: { cle: keyof LigneBalance; libelle: string }[] = [
  { cle: 'non_echu', libelle: 'Non échu' },
  { cle: 'j30', libelle: '1–30 j' },
  { cle: 'j60', libelle: '31–60 j' },
  { cle: 'j90', libelle: '61–90 j' },
  { cle: 'plus90', libelle: '+ 90 j' },
];

export function Creances() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const [au, setAu] = useState(aujourdhui());
  const [lignes, setLignes] = useState<LigneBalance[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [client, setClient] = useState<Partial<Client> | null>(null);
  const [creance, setCreance] = useState<Record<string, string> | null>(null);

  const charger = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.rpc('balance_agee', { p_org: org, p_au: au }),
      supabase.from('clients').select('*').eq('organisation_id', org).order('nom'),
    ]);
    if (a.error) return setErreur(messageErreur(a.error));
    setLignes(((a.data as { clients: LigneBalance[] }).clients ?? []) as LigneBalance[]);
    setClients((b.data ?? []) as Client[]);
  }, [org, au]);
  useEffect(() => {
    void charger();
  }, [charger]);

  const totaux = TRANCHES.map((t) => lignes.reduce((s, l) => s + Number(l[t.cle] ?? 0), 0));
  const total = lignes.reduce((s, l) => s + Number(l.total), 0);
  const echu = total - (totaux[0] ?? 0);

  async function enregistrerClient(e: FormEvent) {
    e.preventDefault();
    if (!client) return;
    const champs = {
      nom: client.nom?.trim(),
      telephone: client.telephone || null,
      email: client.email || null,
      adresse: client.adresse || null,
      contact: client.contact || null,
      ncc: client.ncc || null,
      plafond_credit: client.plafond_credit ?? null,
      delai_paiement: Number(client.delai_paiement ?? 30),
      note: client.note || null,
    };
    const { error } = client.id
      ? await supabase.from('clients').update({ ...champs, actif: client.actif ?? true }).eq('id', client.id)
      : await supabase.from('clients').insert({ ...champs, organisation_id: org });
    if (error) return setErreur(/duplicate/.test(error.message) ? 'Un client porte déjà ce nom.' : messageErreur(error));
    setClient(null);
    await charger();
  }

  async function enregistrerCreance(e: FormEvent) {
    e.preventDefault();
    if (!creance) return;
    const m = lireMontant(creance.montant ?? '');
    if (!m || m <= 0) return setErreur('Indiquez le montant.');
    const { error } = await supabase.rpc('enregistrer_creance', {
      p_org: org,
      p_client: creance.client,
      p_montant: m,
      p_date: creance.date,
      p_echeance: creance.echeance || null,
      p_libelle: creance.libelle || null,
      p_piece: creance.piece || null,
    });
    if (error) return setErreur(messageErreur(error));
    setCreance(null);
    setInfo('Créance enregistrée.');
    await charger();
  }

  function exporter() {
    const entetes = ['Client', 'Téléphone', ...TRANCHES.map((t) => t.libelle), 'Total dû', 'Retard max (j)', 'Dernière relance'];
    telechargerFichier(
      `balance-agee-${au}.xlsx`,
      TYPE_XLSX,
      classeurXlsx([
        {
          nom: 'Balance âgée',
          titre: [`${organisation!.nom} — Balance âgée des créances clients au ${dateFr(au)}`],
          entetes,
          lignes: lignes.map((l) => [l.nom, l.telephone ?? '', ...TRANCHES.map((t) => enUnites(l[t.cle] as number)), enUnites(l.total), l.retard_max ?? 0, l.derniere_relance ? dateFr(l.derniere_relance) : '']),
          totaux: ['Total', '', ...totaux.map((v) => enUnites(v)), enUnites(total), '', ''],
        },
      ]),
    );
  }

  return (
    <>
      <EnTetePage
        icone="📨"
        titre="Créances clients"
        sousTitre="Ce que vos clients vous doivent, par ancienneté. Touchez un client pour son relevé, une relance ou un encaissement."
        actions={
          <>
            {lignes.length > 0 && (
              <button className="bouton bouton-discret" onClick={exporter}>
                Excel
              </button>
            )}
            {peut('tresorerie.creer') && (
              <button className="bouton bouton-discret" onClick={() => setClient({ delai_paiement: 30, actif: true })}>
                Nouveau client
              </button>
            )}
            {peut('tresorerie.creer') && clients.length > 0 && (
              <button
                className="bouton bouton-principal"
                onClick={() => setCreance({ client: clients.find((c) => c.actif)?.id ?? '', date: aujourdhui(), montant: '' })}
              >
                Nouvelle créance
              </button>
            )}
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      <section className="tuiles">
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur"><MontantFort v={total} /></span>
          <span className="tuile-libelle">total à encaisser ({lignes.length} client{lignes.length > 1 ? 's' : ''})</span>
        </div>
        <div className={`tuile tuile-fixe ${echu > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur"><MontantFort v={echu} /></span>
          <span className="tuile-libelle">échu, à relancer</span>
        </div>
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur"><MontantFort v={totaux[4] ?? 0} /></span>
          <span className="tuile-libelle">plus de 90 jours de retard</span>
        </div>
      </section>

      <section className="carte">
        <div className="filtres-ligne">
          <Champ label="Situation au">
            <input type="date" value={au} max={aujourdhui()} onChange={(e) => e.target.value && setAu(e.target.value)} />
          </Champ>
        </div>
        {lignes.length === 0 ? (
          <Vide>Aucune créance en cours.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Client</th>
                  {TRANCHES.map((t) => (
                    <th key={t.cle} className="nombre">{t.libelle}</th>
                  ))}
                  <th className="nombre">Total dû</th>
                  <th className="col-secondaire">Relance</th>
                </tr>
              </thead>
              <tbody>
                {lignes.map((l) => (
                  <tr key={l.id} className="ligne-cliquable" onClick={() => naviguer(`/tresorerie/clients/${l.id}`)}>
                    <td>
                      <strong>{l.nom}</strong>
                      <div className="secondaire">{l.telephone ?? ''}{l.retard_max ? ` · ${l.retard_max} j de retard` : ''}</div>
                    </td>
                    {TRANCHES.map((t, i) => (
                      <td key={t.cle} className={`nombre ${i >= 3 && Number(l[t.cle]) > 0 ? 'texte-negatif' : ''}`}>
                        {Number(l[t.cle]) ? montant(l[t.cle] as number) : '—'}
                      </td>
                    ))}
                    <td className="nombre"><strong>{montant(l.total)}</strong></td>
                    <td className="col-secondaire">
                      {l.derniere_relance ? <Pastille ton="or">N{l.niveau_relance ?? 1} · {dateFr(l.derniere_relance)}</Pastille> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="ligne-total">
                  <td>Total</td>
                  {totaux.map((v, i) => (
                    <td key={i} className="nombre">{montant(v)}</td>
                  ))}
                  <td className="nombre">{montant(total)}</td>
                  <td className="col-secondaire" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <section className="carte">
        <h2>Clients</h2>
        {clients.length === 0 ? (
          <Vide>Aucun client. Créez-en un pour lui ouvrir un compte.</Vide>
        ) : (
          <table className="tableau">
            <thead>
              <tr><th>Nom</th><th>Téléphone</th><th className="col-secondaire">Délai</th><th className="nombre col-secondaire">Plafond</th><th aria-label="Modifier" /></tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} className="ligne-cliquable" onClick={() => naviguer(`/tresorerie/clients/${c.id}`)}>
                  <td><strong>{c.nom}</strong>{!c.actif && <span className="secondaire"> · inactif</span>}</td>
                  <td>{c.telephone ?? '—'}</td>
                  <td className="col-secondaire">{c.delai_paiement} j</td>
                  <td className="nombre col-secondaire">{c.plafond_credit === null ? '—' : montant(c.plafond_credit)}</td>
                  <td>
                    {peut('tresorerie.creer') && (
                      <button className="bouton-lien" onClick={(e) => { e.stopPropagation(); setClient(c); }}>Modifier</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Fenetre titre={client?.id ? 'Client' : 'Nouveau client'} ouverte={!!client} onFermer={() => setClient(null)}>
        {client && (
          <form className="formulaire" onSubmit={enregistrerClient}>
            <Alerte>{erreur}</Alerte>
            <Champ label="Nom ou raison sociale">
              <input value={client.nom ?? ''} onChange={(e) => setClient({ ...client, nom: e.target.value })} required minLength={2} autoFocus />
            </Champ>
            <div className="grille-2">
              <Champ label="Téléphone">
                <input value={client.telephone ?? ''} onChange={(e) => setClient({ ...client, telephone: e.target.value })} inputMode="tel" />
              </Champ>
              <Champ label="E-mail">
                <input type="email" value={client.email ?? ''} onChange={(e) => setClient({ ...client, email: e.target.value })} />
              </Champ>
              <Champ label="Contact">
                <input value={client.contact ?? ''} onChange={(e) => setClient({ ...client, contact: e.target.value })} placeholder="Personne à joindre" />
              </Champ>
              <Champ label="NCC">
                <input value={client.ncc ?? ''} onChange={(e) => setClient({ ...client, ncc: e.target.value })} maxLength={20} />
              </Champ>
              <Champ label="Délai de paiement (jours)">
                <input type="number" min={0} max={365} value={client.delai_paiement ?? 30} onChange={(e) => setClient({ ...client, delai_paiement: Number(e.target.value) })} />
              </Champ>
              <Champ label="Plafond de crédit" aide="Facultatif">
                <input
                  defaultValue={client.plafond_credit == null ? '' : montant(client.plafond_credit, '')}
                  onBlur={(e) => setClient({ ...client, plafond_credit: lireMontant(e.target.value) })}
                  inputMode={clavierMontant()}
                />
              </Champ>
            </div>
            <Champ label="Adresse">
              <input value={client.adresse ?? ''} onChange={(e) => setClient({ ...client, adresse: e.target.value })} />
            </Champ>
            {client.id && (
              <label className="case">
                <input type="checkbox" checked={client.actif ?? true} onChange={(e) => setClient({ ...client, actif: e.target.checked })} /> Client actif
              </label>
            )}
            <button className="bouton bouton-principal">Enregistrer</button>
          </form>
        )}
      </Fenetre>

      <Fenetre titre="Nouvelle créance" ouverte={!!creance} onFermer={() => setCreance(null)}>
        {creance && (
          <form className="formulaire" onSubmit={enregistrerCreance}>
            <Alerte>{erreur}</Alerte>
            <div className="grille-2">
              <Champ label="Client">
                <select value={creance.client} onChange={(e) => setCreance({ ...creance, client: e.target.value })} required>
                  {clients.filter((c) => c.actif).map((c) => (
                    <option key={c.id} value={c.id}>{c.nom}</option>
                  ))}
                </select>
              </Champ>
              <Champ label="Montant">
                <input value={creance.montant} onChange={(e) => setCreance({ ...creance, montant: e.target.value })} inputMode={clavierMontant()} required autoFocus />
              </Champ>
              <Champ label="Date">
                <input type="date" value={creance.date} max={aujourdhui()} onChange={(e) => setCreance({ ...creance, date: e.target.value })} />
              </Champ>
              <Champ label="Échéance" aide="Vide : date + délai du client">
                <input type="date" value={creance.echeance ?? ''} min={creance.date} onChange={(e) => setCreance({ ...creance, echeance: e.target.value })} />
              </Champ>
              <Champ label="Pièce" aide="N° de facture, de ticket…">
                <input value={creance.piece ?? ''} onChange={(e) => setCreance({ ...creance, piece: e.target.value })} maxLength={60} />
              </Champ>
              <Champ label="Objet">
                <input value={creance.libelle ?? ''} onChange={(e) => setCreance({ ...creance, libelle: e.target.value })} maxLength={160} placeholder="Livraison de riz, facture d’octobre…" />
              </Champ>
            </div>
            <button className="bouton bouton-principal">Enregistrer la créance</button>
          </form>
        )}
      </Fenetre>
    </>
  );
}

interface Releve {
  client: Client;
  creances: { id: string; date_creance: string; echeance: string; montant: number; libelle: string | null; piece: string | null; statut: string; motif_annulation: string | null; reste: number; jours_retard: number }[];
  encaissements: { id: string; date_encaissement: string; montant: number; compte: string; reference: string | null; statut: string; piece: string | null }[];
  relances: { niveau: number; date_relance: string; montant_du: number }[];
  solde: number;
  echu: number;
}

const TEXTES_RELANCE: Record<1 | 2 | 3, { titre: string; corps: string; fin: string }> = {
  1: {
    titre: 'Rappel de paiement',
    corps:
      'Sauf erreur ou omission de notre part, nous constatons que les factures ci-dessous restent impayées à ce jour. Il s’agit peut-être d’un simple oubli : nous vous remercions de bien vouloir procéder à leur règlement dans les meilleurs délais.',
    fin: 'Si votre paiement a été effectué entre-temps, merci de ne pas tenir compte de ce courrier.',
  },
  2: {
    titre: 'Deuxième relance',
    corps:
      'Malgré notre précédent rappel, les sommes ci-dessous ne nous sont toujours pas parvenues. Nous vous prions de régulariser votre situation sous huit (8) jours à compter de la réception de ce courrier.',
    fin: 'Nous restons à votre disposition pour convenir, si besoin, d’un échéancier de paiement.',
  },
  3: {
    titre: 'Mise en demeure de payer',
    corps:
      'Nos relances précédentes étant restées sans effet, nous vous mettons en demeure de nous régler les sommes ci-dessous sous huit (8) jours. À défaut, nous nous verrons contraints d’engager une procédure de recouvrement, les frais restant à votre charge.',
    fin: 'Ce courrier vaut mise en demeure.',
  },
};

export function FicheClient() {
  const { id } = useParams();
  const { organisation, peut } = useSession();
  const { identite } = useIdentite();
  const { imprimer } = useImpression();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const { comptes } = useComptes(org);
  const [r, setR] = useState<Releve | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [encaissement, setEncaissement] = useState<Record<string, string> | null>(null);

  const charger = useCallback(async () => {
    const { data, error } = await supabase.rpc('releve_client', { p_client: id });
    if (error) return setErreur(messageErreur(error));
    setR(data as Releve);
  }, [id]);
  useEffect(() => {
    void charger();
  }, [charger]);

  async function encaisser(e: FormEvent) {
    e.preventDefault();
    if (!encaissement) return;
    const m = lireMontant(encaissement.montant ?? '');
    if (!m || m <= 0) return setErreur('Indiquez le montant.');
    const { error } = await supabase.rpc('encaisser_creance', {
      p_org: org,
      p_client: id,
      p_creance: encaissement.creance || null,
      p_montant: m,
      p_compte: encaissement.compte,
      p_date: encaissement.date,
      p_reference: encaissement.reference || null,
      p_note: null,
    });
    if (error) return setErreur(messageErreur(error));
    setEncaissement(null);
    setInfo('Encaissement enregistré : il entre dans le compte choisi.');
    await charger();
  }

  async function annuler(type: 'creance' | 'encaissement', idLigne: string) {
    const motif = window.prompt('Motif de l’annulation');
    if (!motif?.trim()) return;
    const { error } =
      type === 'creance'
        ? await supabase.rpc('annuler_creance', { p_creance: idLigne, p_motif: motif.trim() })
        : await supabase.rpc('annuler_encaissement', { p_encaissement: idLigne, p_motif: motif.trim() });
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

  async function relancer(niveau: 1 | 2 | 3) {
    if (!r) return;
    const { error } = await supabase.rpc('enregistrer_relance', { p_client: id, p_niveau: niveau });
    if (error) return setErreur(messageErreur(error));
    const t = TEXTES_RELANCE[niveau];
    const echues = r.creances.filter((c) => c.statut === 'ouverte' && Number(c.reste) > 0 && c.jours_retard > 0);
    const o = identite?.organisation;
    await imprimer(
      <div className="rapport-a4 lettre">
        <header className="lettre-entete">
          <div>
            {identite?.logoUrl && <img src={identite.logoUrl} alt="" />}
            <strong>{o?.nom ?? organisation!.nom}</strong>
            <div>{[o?.adresse, o?.ville].filter(Boolean).join(', ')}</div>
            <div>{[o?.telephone, o?.email].filter(Boolean).join(' · ')}</div>
          </div>
          <div className="lettre-destinataire">
            <strong>{r.client.nom}</strong>
            {r.client.contact && <div>À l’attention de {r.client.contact}</div>}
            {r.client.adresse && <div>{r.client.adresse}</div>}
            {r.client.telephone && <div>{r.client.telephone}</div>}
          </div>
        </header>
        <p className="lettre-date">{o?.ville ? `${o.ville}, le ` : 'Le '}{new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
        <p><strong>Objet : {t.titre}</strong></p>
        <p>Madame, Monsieur,</p>
        <p>{t.corps}</p>
        <table className="rapport-tableau">
          <thead>
            <tr><th>Pièce</th><th>Date</th><th>Échéance</th><th className="nombre">Retard</th><th className="nombre">Reste dû</th></tr>
          </thead>
          <tbody>
            {echues.map((c) => (
              <tr key={c.id}>
                <td>{c.piece ?? c.libelle ?? '—'}</td>
                <td>{dateFr(c.date_creance)}</td>
                <td>{dateFr(c.echeance)}</td>
                <td className="nombre">{c.jours_retard} j</td>
                <td className="nombre">{montant(c.reste)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={4}>Total échu</td><td className="nombre">{montant(r.echu)}</td></tr>
          </tfoot>
        </table>
        <p>{t.fin}</p>
        <p>Nous vous prions d’agréer, Madame, Monsieur, l’expression de nos salutations distinguées.</p>
        <div className="lettre-signature">
          <div>La Direction</div>
          <div className="lettre-ligne-signature" />
        </div>
      </div>,
      'a4',
    );
    setInfo(`Relance de niveau ${niveau} enregistrée et prête à imprimer.`);
    await charger();
  }

  async function imprimerReleve() {
    if (!r) return;
    await imprimer(
      <div className="rapport-a4">
        <header className="rapport-entete">
          <div>
            <strong>{identite?.organisation.nom ?? organisation!.nom}</strong>
            <h1>Relevé de compte client</h1>
            <p>{r.client.nom} · au {new Date().toLocaleDateString('fr-FR')}</p>
          </div>
          {identite?.logoUrl && <img src={identite.logoUrl} alt="" />}
        </header>
        <table className="rapport-tableau">
          <thead>
            <tr><th>Date</th><th>Opération</th><th className="nombre">Débit</th><th className="nombre">Crédit</th></tr>
          </thead>
          <tbody>
            {[
              ...r.creances.filter((c) => c.statut === 'ouverte').map((c) => ({ d: c.date_creance, l: `${c.piece ?? ''} ${c.libelle ?? ''} (échéance ${dateFr(c.echeance)})`, debit: Number(c.montant), credit: 0 })),
              ...r.encaissements.filter((e) => e.statut === 'enregistre').map((e) => ({ d: e.date_encaissement, l: `Règlement ${e.compte}${e.reference ? ` · ${e.reference}` : ''}`, debit: 0, credit: Number(e.montant) })),
            ]
              .sort((a, b) => a.d.localeCompare(b.d))
              .map((x, i) => (
                <tr key={i}>
                  <td>{dateFr(x.d)}</td>
                  <td>{x.l}</td>
                  <td className="nombre">{x.debit ? montant(x.debit) : ''}</td>
                  <td className="nombre">{x.credit ? montant(x.credit) : ''}</td>
                </tr>
              ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={3}>Solde dû</td><td className="nombre">{montant(r.solde)}</td></tr>
          </tfoot>
        </table>
      </div>,
      'a4',
    );
  }

  if (!r) return <EnTetePage titre="Client" sousTitre={erreur || 'Chargement…'} />;
  const ouvertes = r.creances.filter((c) => c.statut === 'ouverte' && Number(c.reste) > 0);
  const prochainNiveau = (Math.min(3, (r.relances[0]?.niveau ?? 0) + 1) as 1 | 2 | 3);

  return (
    <>
      <EnTetePage
        icone="👤"
        titre={r.client.nom}
        sousTitre={[r.client.telephone, r.client.email, r.client.adresse].filter(Boolean).join(' · ') || 'Compte client'}
        actions={
          <>
            <button className="bouton bouton-discret" onClick={() => void imprimerReleve()}>Relevé</button>
            {peut('tresorerie.creer') && r.echu > 0 && (
              <button className="bouton bouton-discret" onClick={() => void relancer(prochainNiveau)}>
                ✉️ Relance {prochainNiveau === 3 ? '(mise en demeure)' : `n° ${prochainNiveau}`}
              </button>
            )}
            {peut('tresorerie.creer') && r.solde > 0 && (
              <button
                className="bouton bouton-principal"
                onClick={() => setEncaissement({ creance: ouvertes[ouvertes.length - 1]?.id ?? '', montant: '', compte: comptes[0]?.id ?? '', date: aujourdhui() })}
              >
                Encaisser
              </button>
            )}
            <button className="bouton bouton-discret" onClick={() => naviguer('/tresorerie/creances')}>Retour</button>
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      <section className="tuiles">
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur"><MontantFort v={r.solde} /></span>
          <span className="tuile-libelle">solde dû</span>
        </div>
        <div className={`tuile tuile-fixe ${r.echu > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur"><MontantFort v={r.echu} /></span>
          <span className="tuile-libelle">échu</span>
        </div>
        {r.client.plafond_credit !== null && (
          <div className={`tuile tuile-fixe ${r.solde > Number(r.client.plafond_credit) ? 'tuile-alerte' : ''}`}>
            <span className="tuile-valeur"><MontantFort v={r.client.plafond_credit} /></span>
            <span className="tuile-libelle">plafond de crédit</span>
          </div>
        )}
      </section>

      <section className="carte">
        <h2>Créances</h2>
        {r.creances.length === 0 ? (
          <Vide>Aucune créance.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr><th>Date</th><th>Pièce / objet</th><th>Échéance</th><th className="nombre">Montant</th><th className="nombre">Reste</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {r.creances.map((c) => (
                  <tr key={c.id} className={c.statut === 'annulee' ? 'ligne-annulee' : ''}>
                    <td>{dateFr(c.date_creance)}</td>
                    <td>{[c.piece, c.libelle].filter(Boolean).join(' · ') || '—'}</td>
                    <td>
                      {Number(c.reste) > 0 && c.jours_retard > 0 ? <Pastille ton={c.jours_retard > 60 ? 'rouge' : 'or'}>{dateFr(c.echeance)} · {c.jours_retard} j</Pastille> : dateFr(c.echeance)}
                    </td>
                    <td className="nombre">{montant(c.montant)}</td>
                    <td className="nombre">{c.statut === 'annulee' ? '—' : Number(c.reste) ? <strong>{montant(c.reste)}</strong> : <Pastille ton="vert">Soldée</Pastille>}</td>
                    <td>
                      {c.statut === 'ouverte' && peut('tresorerie.valider') && (
                        <button className="bouton-lien lien-danger" onClick={() => void annuler('creance', c.id)}>Annuler</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="carte">
        <h2>Encaissements</h2>
        {r.encaissements.length === 0 ? (
          <Vide>Aucun encaissement.</Vide>
        ) : (
          <table className="tableau">
            <thead>
              <tr><th>Date</th><th>Compte</th><th className="col-secondaire">Référence</th><th className="nombre">Montant</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {r.encaissements.map((e) => (
                <tr key={e.id} className={e.statut === 'annule' ? 'ligne-annulee' : ''}>
                  <td>{dateFr(e.date_encaissement)}</td>
                  <td>{e.compte}</td>
                  <td className="col-secondaire">{[e.reference, e.piece].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="nombre">{montant(e.montant)}</td>
                  <td>
                    {e.statut === 'enregistre' && peut('tresorerie.valider') && (
                      <button className="bouton-lien lien-danger" onClick={() => void annuler('encaissement', e.id)}>Annuler</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {r.relances.length > 0 && (
        <section className="carte">
          <h2>Relances envoyées</h2>
          <ul className="liste-simple">
            {r.relances.map((x, i) => (
              <li key={i}>
                {dateFr(x.date_relance)} — {TEXTES_RELANCE[x.niveau as 1 | 2 | 3].titre} ({montant(x.montant_du)} dû)
              </li>
            ))}
          </ul>
        </section>
      )}

      <Fenetre titre="Encaissement" ouverte={!!encaissement} onFermer={() => setEncaissement(null)}>
        {encaissement && (
          <form className="formulaire" onSubmit={encaisser}>
            <Alerte>{erreur}</Alerte>
            <Champ label="Créance réglée">
              <select
                value={encaissement.creance}
                onChange={(e) => {
                  const c = ouvertes.find((x) => x.id === e.target.value);
                  setEncaissement({ ...encaissement, creance: e.target.value, montant: c ? montant(c.reste, '') : encaissement.montant });
                }}
              >
                <option value="">Les plus anciennes d’abord</option>
                {ouvertes.map((c) => (
                  <option key={c.id} value={c.id}>{c.piece ?? dateFr(c.date_creance)} — reste {montant(c.reste)}</option>
                ))}
              </select>
            </Champ>
            <div className="grille-2">
              <Champ label="Montant reçu">
                <input value={encaissement.montant} onChange={(e) => setEncaissement({ ...encaissement, montant: e.target.value })} inputMode={clavierMontant()} required autoFocus />
              </Champ>
              <Champ label="Date">
                <input type="date" value={encaissement.date} max={aujourdhui()} onChange={(e) => setEncaissement({ ...encaissement, date: e.target.value })} />
              </Champ>
              <Champ label="Reçu sur">
                <select value={encaissement.compte} onChange={(e) => setEncaissement({ ...encaissement, compte: e.target.value })} required>
                  {comptes.map((c) => (
                    <option key={c.id} value={c.id}>{c.nom}</option>
                  ))}
                </select>
              </Champ>
              <Champ label="Référence" aide="N° de transaction Wave, chèque…">
                <input value={encaissement.reference ?? ''} onChange={(e) => setEncaissement({ ...encaissement, reference: e.target.value })} maxLength={60} />
              </Champ>
            </div>
            <button className="bouton bouton-principal">Enregistrer l’encaissement</button>
          </form>
        )}
      </Fenetre>
    </>
  );
}
