import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { useIdentite } from '../../lib/identite';
import { messageErreur } from '../../lib/format';
import { clavierMontant, enUnites, lireMontant, montant } from '../../lib/argent';
import { aujourdhui, dateFr, useComptes } from '../../lib/tresorerie';
import { exporterClasseur, type FormatExport } from '../../lib/export';
import { useImpression } from '../../impression/impression';
import { useDemandeCreation } from '../../lib/demande';
import { BoutonsExport } from '../../components/Export';
import { Alerte, Champ, EnTetePage, Fenetre, MontantFort, Pastille, Vide } from '../../components/ui';
import { ETAPES, type DossierCredit, type Procedure } from './documents';
import { PapierEntete, Signature, dateCourrier } from './papier';
import { Echeance, EtapePastille } from './Credits';

/* ------------------------------------------------------------------------------------------
 * Fichier clients du module « Crédits clients » : on enregistre le client une fois (particulier
 * ou entreprise, NCC/RCCM), puis on le retrouve dans les crédits, la balance âgée, les relevés
 * et les relances.
 * ---------------------------------------------------------------------------------------- */

export type TypeClient = 'particulier' | 'entreprise';

export interface Client {
  id: string;
  nom: string;
  type_client: TypeClient;
  telephone: string | null;
  email: string | null;
  adresse: string | null;
  contact: string | null;
  ncc: string | null;
  rccm: string | null;
  piece_identite: string | null;
  plafond_credit: number | null;
  delai_paiement: number;
  note: string | null;
  actif: boolean;
  exemple?: boolean;
}

interface ClientFichier extends Client {
  encours: number;
  echu: number;
  retard: number;
  etape: number;
  dossiers: number;
}

/** Les droits utiles du fichier clients, lus une fois. */
function useDroitsClients() {
  const { peut } = useSession();
  return {
    voirComptes: peut('tresorerie.consulter') || peut('ventes.valider'),
    creer: peut('clients.creer') || peut('tresorerie.creer'),
    modifier: peut('clients.modifier') || peut('tresorerie.creer'),
    tenir: peut('tresorerie.creer') || peut('ventes.valider'),
    encaisser: peut('tresorerie.creer'),
    annuler: peut('tresorerie.valider'),
    exemples: peut('ventes.valider') && peut('clients.creer'),
  };
}

export function TypeClientPastille({ c }: { c: Pick<Client, 'type_client' | 'exemple'> }) {
  return (
    <>
      <span className={`type-client type-client-${c.type_client}`}>{c.type_client === 'particulier' ? 'Particulier' : 'Entreprise'}</span>
      {c.exemple && <span className="badge-test" title="Client d’exemple : sans effet sur le stock, la trésorerie et la comptabilité">TEST</span>}
    </>
  );
}

/** « RCCM … · NCC … · CNI … » pour un client. */
export function identifiants(c: Pick<Client, 'ncc' | 'rccm' | 'piece_identite'>): string {
  return [c.rccm && `RCCM ${c.rccm}`, c.ncc && `NCC ${c.ncc}`, c.piece_identite].filter(Boolean).join(' · ');
}

const CLIENT_VIDE: Partial<Client> = { type_client: 'entreprise', delai_paiement: 30, actif: true };

/**
 * Fenêtre de saisie d'un client. Un particulier (personne physique) n'a en général ni NCC ni
 * RCCM : on lui demande s'il en a un, et les champs n'apparaissent que si la réponse est oui.
 */
export function FenetreClient({
  client: initial,
  onFermer,
  onEnregistre,
}: {
  client: Partial<Client> | null;
  onFermer: () => void;
  onEnregistre: (id: string) => void;
}) {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const [c, setC] = useState<Partial<Client>>(initial ?? CLIENT_VIDE);
  const [aIdentifiants, setAIdentifiants] = useState(false);
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);
  useEffect(() => {
    const v = initial ? { ...CLIENT_VIDE, ...initial } : CLIENT_VIDE;
    setC(v);
    setAIdentifiants(!!(v.ncc || v.rccm));
    setErreur('');
  }, [initial]);

  const particulier = c.type_client === 'particulier';
  const maj = (champs: Partial<Client>) => setC((x) => ({ ...x, ...champs }));

  async function enregistrer(e: FormEvent) {
    e.preventDefault();
    setErreur('');
    const garderIdentifiants = !particulier || aIdentifiants;
    const champs = {
      nom: c.nom?.trim(),
      type_client: c.type_client ?? 'entreprise',
      telephone: c.telephone?.trim() || null,
      email: c.email?.trim() || null,
      adresse: c.adresse?.trim() || null,
      contact: particulier ? null : c.contact?.trim() || null,
      ncc: garderIdentifiants ? c.ncc?.trim() || null : null,
      rccm: garderIdentifiants ? c.rccm?.trim() || null : null,
      piece_identite: particulier ? c.piece_identite?.trim() || null : null,
      plafond_credit: c.plafond_credit ?? null,
      delai_paiement: Number(c.delai_paiement ?? 30),
      note: c.note?.trim() || null,
    };
    if (!champs.nom || champs.nom.length < 2) return setErreur('Indiquez le nom du client.');
    if (particulier && aIdentifiants && !champs.ncc && !champs.rccm) return setErreur('Indiquez le NCC ou le RCCM, ou répondez « Non ».');
    setEnCours(true);
    const r = c.id
      ? await supabase.from('clients').update({ ...champs, actif: c.actif ?? true }).eq('id', c.id).select('id').single()
      : await supabase.from('clients').insert({ ...champs, organisation_id: org }).select('id').single();
    setEnCours(false);
    if (r.error) return setErreur(/duplicate/.test(r.error.message) ? 'Un client porte déjà ce nom.' : messageErreur(r.error));
    onEnregistre((r.data as { id: string }).id);
  }

  return (
    <Fenetre titre={c.id ? 'Modifier le client' : 'Nouveau client'} ouverte={!!initial} onFermer={onFermer} large>
      <form className="formulaire" onSubmit={enregistrer}>
        <Alerte>{erreur}</Alerte>
        <div className="choix-type-client" role="radiogroup" aria-label="Type de client">
          {(['particulier', 'entreprise'] as TypeClient[]).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={c.type_client === t}
              className={c.type_client === t ? 'actif' : ''}
              onClick={() => maj({ type_client: t })}
            >
              <span aria-hidden>{t === 'particulier' ? '🧑' : '🏢'}</span>
              <strong>{t === 'particulier' ? 'Particulier' : 'Entreprise'}</strong>
              <small>{t === 'particulier' ? 'Personne physique' : 'Société, commerce, administration'}</small>
            </button>
          ))}
        </div>

        <Champ label={particulier ? 'Nom et prénoms' : 'Raison sociale'}>
          <input value={c.nom ?? ''} onChange={(e) => maj({ nom: e.target.value })} required minLength={2} autoFocus />
        </Champ>
        <div className="grille-2">
          <Champ label="Téléphone">
            <input value={c.telephone ?? ''} onChange={(e) => maj({ telephone: e.target.value })} inputMode="tel" />
          </Champ>
          <Champ label="E-mail">
            <input type="email" value={c.email ?? ''} onChange={(e) => maj({ email: e.target.value })} />
          </Champ>
          {!particulier && (
            <Champ label="Personne à contacter">
              <input value={c.contact ?? ''} onChange={(e) => maj({ contact: e.target.value })} placeholder="Nom, fonction" />
            </Champ>
          )}
          <Champ label="Adresse">
            <input value={c.adresse ?? ''} onChange={(e) => maj({ adresse: e.target.value })} placeholder="Commune, quartier, repère" />
          </Champ>
        </div>

        <fieldset className="bloc-identifiants">
          <legend>Identification</legend>
          {particulier && (
            <div className="question-oui-non">
              <span>A-t-il un NCC ou un RCCM ?</span>
              <div className="segments" role="radiogroup" aria-label="A-t-il un NCC ou un RCCM ?">
                <button type="button" role="radio" aria-checked={aIdentifiants} className={aIdentifiants ? 'actif' : ''} onClick={() => setAIdentifiants(true)}>Oui</button>
                <button type="button" role="radio" aria-checked={!aIdentifiants} className={!aIdentifiants ? 'actif' : ''} onClick={() => setAIdentifiants(false)}>Non</button>
              </div>
            </div>
          )}
          <div className="grille-2">
            {(!particulier || aIdentifiants) && (
              <>
                <Champ label="NCC" aide="Numéro de compte contribuable">
                  <input value={c.ncc ?? ''} onChange={(e) => maj({ ncc: e.target.value })} maxLength={20} />
                </Champ>
                <Champ label="RCCM" aide="Registre du commerce">
                  <input value={c.rccm ?? ''} onChange={(e) => maj({ rccm: e.target.value })} maxLength={40} placeholder="CI-ABJ-…" />
                </Champ>
              </>
            )}
            {particulier && (
              <Champ label="Pièce d’identité" aide="Facultatif : CNI, passeport, carte consulaire…">
                <input value={c.piece_identite ?? ''} onChange={(e) => maj({ piece_identite: e.target.value })} maxLength={60} placeholder="CNI C00123456" />
              </Champ>
            )}
          </div>
        </fieldset>

        <fieldset className="bloc-identifiants">
          <legend>Conditions de crédit</legend>
          <div className="grille-2">
            <Champ label="Délai de paiement habituel (jours)" aide="Proposé à chaque nouveau crédit">
              <input type="number" min={0} max={365} value={c.delai_paiement ?? 30} onChange={(e) => maj({ delai_paiement: Number(e.target.value) })} />
            </Champ>
            <Champ label="Plafond de crédit" aide="Facultatif : au-delà, un motif est demandé">
              <input
                defaultValue={c.plafond_credit == null ? '' : montant(c.plafond_credit, '')}
                onBlur={(e) => maj({ plafond_credit: e.target.value.trim() ? lireMontant(e.target.value) : null })}
                inputMode={clavierMontant()}
              />
            </Champ>
          </div>
          <Champ label="Note">
            <input value={c.note ?? ''} onChange={(e) => maj({ note: e.target.value })} maxLength={300} placeholder="Garant, habitudes de paiement…" />
          </Champ>
        </fieldset>
        {c.id && (
          <label className="case">
            <input type="checkbox" checked={c.actif ?? true} onChange={(e) => maj({ actif: e.target.checked })} /> Client actif
          </label>
        )}
        <button className="bouton bouton-principal" disabled={enCours}>{enCours ? 'Enregistrement…' : 'Enregistrer le client'}</button>
      </form>
    </Fenetre>
  );
}

/** Boutons « Créer / Supprimer les exemples » (réservés aux responsables). */
function BoutonsExemples({ existent, onFait, onInfo, onErreur }: { existent: boolean; onFait: () => void; onInfo: (m: string) => void; onErreur: (m: string) => void }) {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const [enCours, setEnCours] = useState(false);
  async function lancer(creer: boolean) {
    if (!creer && !window.confirm('Supprimer tous les clients, crédits et créances d’exemple ?')) return;
    setEnCours(true);
    const { data, error } = await supabase.rpc(creer ? 'creer_exemples_credits' : 'supprimer_exemples_credits', { p_org: org });
    setEnCours(false);
    if (error) return onErreur(messageErreur(error));
    const r = data as { clients: number; credits?: number };
    onInfo(
      creer
        ? `${r.clients} clients et ${r.credits ?? 0} crédits d’exemple créés, marqués TEST : ils n’entrent ni dans le stock, ni dans la trésorerie, ni dans la comptabilité.`
        : `Exemples supprimés (${r.clients} clients).`,
    );
    onFait();
  }
  return existent ? (
    <button className="bouton bouton-discret" disabled={enCours} onClick={() => void lancer(false)}>🧹 Supprimer les exemples</button>
  ) : (
    <button className="bouton bouton-discret" disabled={enCours} onClick={() => void lancer(true)} title="Crée 3 clients et 5 crédits à différents stades de retard">
      🧪 Créer des exemples
    </button>
  );
}

/* ------------------------------------------------------------------------------------------
 * Onglet « Clients »
 * ---------------------------------------------------------------------------------------- */

type FiltreClients = 'tous' | 'credit' | 'retard' | 'particulier' | 'entreprise' | 'inactifs';
const FILTRES_CLIENTS: { cle: FiltreClients; libelle: string }[] = [
  { cle: 'tous', libelle: 'Tous' },
  { cle: 'credit', libelle: 'Avec un encours' },
  { cle: 'retard', libelle: 'En retard' },
  { cle: 'particulier', libelle: 'Particuliers' },
  { cle: 'entreprise', libelle: 'Entreprises' },
  { cle: 'inactifs', libelle: 'Inactifs' },
];

export function FichierClients() {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const droits = useDroitsClients();
  const naviguer = useNavigate();
  const [clients, setClients] = useState<ClientFichier[] | null>(null);
  const [filtre, setFiltre] = useState<FiltreClients>('tous');
  const [recherche, setRecherche] = useState('');
  const [edition, setEdition] = useState<Partial<Client> | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  useDemandeCreation(clients !== null, () => setEdition(CLIENT_VIDE));

  const charger = useCallback(async () => {
    const { data, error } = await supabase.rpc('fichier_clients', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    setClients((data ?? []) as ClientFichier[]);
  }, [org]);
  useEffect(() => {
    void charger();
  }, [charger]);

  const tous = clients ?? [];
  const visibles = useMemo(() => {
    const t = recherche.trim().toLowerCase();
    return tous
      .filter((c) => {
        switch (filtre) {
          case 'credit': return Number(c.encours) > 0;
          case 'retard': return Number(c.echu) > 0;
          case 'particulier': return c.actif && c.type_client === 'particulier';
          case 'entreprise': return c.actif && c.type_client === 'entreprise';
          case 'inactifs': return !c.actif;
          default: return c.actif;
        }
      })
      .filter((c) => !t || `${c.nom} ${c.telephone ?? ''} ${c.ncc ?? ''} ${c.rccm ?? ''} ${c.contact ?? ''}`.toLowerCase().includes(t));
  }, [tous, filtre, recherche]);

  const actifs = tous.filter((c) => c.actif);
  const encours = tous.reduce((s, c) => s + Number(c.encours), 0);
  const echu = tous.reduce((s, c) => s + Number(c.echu), 0);
  const contentieux = tous.filter((c) => Number(c.encours) > 0 && c.etape >= 3).length;
  const exemples = tous.some((c) => c.exemple);

  function exporter(format: FormatExport = 'xlsx') {
    exporterClasseur(
      `fichier-clients-${aujourdhui()}`,
      [
        {
          nom: 'Fichier clients',
          titre: [`${organisation!.nom} — Fichier clients au ${dateFr(aujourdhui())}`],
          entetes: ['Client', 'Type', 'Téléphone', 'E-mail', 'Adresse', 'Contact', 'NCC', 'RCCM', 'Pièce d’identité', 'Délai (j)', 'Plafond', 'Encours', 'Dont en retard', 'Étape', 'Crédits'],
          lignes: visibles.map((c) => [
            c.nom, c.type_client === 'particulier' ? 'Particulier' : 'Entreprise', c.telephone, c.email, c.adresse, c.contact, c.ncc, c.rccm,
            c.piece_identite, Number(c.delai_paiement), c.plafond_credit == null ? '' : enUnites(c.plafond_credit), enUnites(c.encours),
            enUnites(c.echu), Number(c.encours) > 0 ? ETAPES[c.etape]!.titre : '', Number(c.dossiers),
          ]),
          totaux: ['Total', '', '', '', '', '', '', '', '', '', '', enUnites(visibles.reduce((s, c) => s + Number(c.encours), 0)),
            enUnites(visibles.reduce((s, c) => s + Number(c.echu), 0)), '', ''],
        },
      ],
      format,
    );
  }

  return (
    <>
      <EnTetePage
        icone="👥"
        titre="Fichier clients"
        sousTitre="Enregistrez le client une fois : vous le retrouvez dans ses crédits, la balance âgée, les relevés et les relances."
        actions={
          <>
            {droits.exemples && clients && <BoutonsExemples existent={exemples} onFait={() => void charger()} onInfo={setInfo} onErreur={setErreur} />}
            <BoutonsExport onExport={exporter} disabled={!visibles.length} />
            {droits.creer && (
              <button className="bouton bouton-principal" onClick={() => setEdition(CLIENT_VIDE)}>Nouveau client</button>
            )}
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      <section className="tuiles">
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur">{actifs.length}</span>
          <span className="tuile-libelle">
            client{actifs.length > 1 ? 's' : ''} actif{actifs.length > 1 ? 's' : ''} · {actifs.filter((c) => c.type_client === 'particulier').length} particulier(s)
          </span>
        </div>
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur"><MontantFort v={encours} /></span>
          <span className="tuile-libelle">encours total à encaisser</span>
        </div>
        <div className={`tuile tuile-fixe ${echu > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur"><MontantFort v={echu} /></span>
          <span className="tuile-libelle">dont en retard</span>
        </div>
        <div className={`tuile tuile-fixe ${contentieux > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur">{contentieux}</span>
          <span className="tuile-libelle">client{contentieux > 1 ? 's' : ''} en mise en demeure ou contentieux</span>
        </div>
      </section>
      <section className="carte">
        <div className="filtres-ligne">
          <div className="segments" role="tablist" aria-label="Filtrer les clients">
            {FILTRES_CLIENTS.map((f) => (
              <button key={f.cle} type="button" role="tab" aria-selected={filtre === f.cle} className={filtre === f.cle ? 'actif' : ''} onClick={() => setFiltre(f.cle)}>
                {f.libelle}
              </button>
            ))}
          </div>
          <input type="search" placeholder="Nom, téléphone, NCC, RCCM…" value={recherche} onChange={(e) => setRecherche(e.target.value)} aria-label="Rechercher un client" />
        </div>
        {!clients ? (
          <Vide>Chargement…</Vide>
        ) : visibles.length === 0 ? (
          <Vide>
            {tous.length === 0
              ? 'Aucun client. Créez votre premier client, ou des exemples pour essayer le module.'
              : 'Aucun client dans ce filtre.'}
          </Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Client</th>
                  <th className="col-secondaire">Identification</th>
                  <th className="col-secondaire">Conditions</th>
                  <th className="nombre">Encours</th>
                  <th>Situation</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visibles.map((c) => (
                  <tr
                    key={c.id}
                    className={`${droits.voirComptes ? 'ligne-cliquable' : ''} ${c.actif ? '' : 'ligne-annulee'}`}
                    onClick={() => droits.voirComptes && naviguer(`/credits/clients/${c.id}`)}
                  >
                    <td>
                      <strong>{c.nom}</strong> <TypeClientPastille c={c} />
                      <div className="secondaire">{[c.telephone, c.contact].filter(Boolean).join(' · ') || '—'}</div>
                    </td>
                    <td className="col-secondaire">{identifiants(c) || <span className="secondaire">—</span>}</td>
                    <td className="col-secondaire">
                      {c.delai_paiement} j
                      <div className="secondaire">{c.plafond_credit == null ? 'Sans plafond' : `Plafond ${montant(c.plafond_credit)}`}</div>
                    </td>
                    <td className="nombre">
                      {Number(c.encours) > 0 ? <strong>{montant(c.encours)}</strong> : '—'}
                      {Number(c.echu) > 0 && <div className="secondaire texte-negatif">{montant(c.echu)} en retard</div>}
                    </td>
                    <td>
                      {Number(c.encours) > 0 ? <EtapePastille etape={c.etape} /> : <Pastille ton="gris">Rien à payer</Pastille>}
                      {Number(c.dossiers) > 0 && <div className="secondaire">{c.dossiers} crédit{Number(c.dossiers) > 1 ? 's' : ''}</div>}
                    </td>
                    <td>
                      {droits.modifier && (
                        <button className="bouton-lien" onClick={(e) => { e.stopPropagation(); setEdition(c); }}>Modifier</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <FenetreClient
        client={edition}
        onFermer={() => setEdition(null)}
        onEnregistre={(id) => {
          const nouveau = !edition?.id;
          setEdition(null);
          setInfo(nouveau ? 'Client enregistré : il est disponible pour un nouveau crédit.' : 'Client mis à jour.');
          void charger();
          if (nouveau && droits.voirComptes) naviguer(`/credits/clients/${id}`);
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------------------------------
 * Onglet « Balance âgée »
 * ---------------------------------------------------------------------------------------- */

interface LigneBalance {
  id: string;
  nom: string;
  telephone: string | null;
  type_client: TypeClient;
  exemple: boolean;
  plafond_credit: number | null;
  total: number;
  non_echu: number;
  j30: number;
  j60: number;
  j90: number;
  plus90: number;
  retard_max: number | null;
  pieces: number;
  etape: number;
  derniere_relance: string | null;
  niveau_relance: number | null;
}

type CleTranche = 'non_echu' | 'j30' | 'j60' | 'j90' | 'plus90';
export const TRANCHES: { cle: CleTranche; libelle: string }[] = [
  { cle: 'non_echu', libelle: 'Non échu' },
  { cle: 'j30', libelle: '1–30 j' },
  { cle: 'j60', libelle: '31–60 j' },
  { cle: 'j90', libelle: '61–90 j' },
  { cle: 'plus90', libelle: '+ 90 j' },
];

const pourcent = (v: number, total: number) => (total > 0 ? `${Math.round((v / total) * 1000) / 10} %` : '—');

export function BalanceAgee() {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const droits = useDroitsClients();
  const naviguer = useNavigate();
  const [au, setAu] = useState(aujourdhui());
  const [lignes, setLignes] = useState<LigneBalance[] | null>(null);
  const [sansExemples, setSansExemples] = useState(false);
  const [clients, setClients] = useState<{ id: string; nom: string }[]>([]);
  const [creance, setCreance] = useState<Record<string, string> | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  useDemandeCreation(lignes !== null, () => nouvelleCreance());

  const charger = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.rpc('balance_agee', { p_org: org, p_au: au }),
      supabase.from('clients').select('id, nom').eq('organisation_id', org).eq('actif', true).order('nom'),
    ]);
    if (a.error) return setErreur(messageErreur(a.error));
    setLignes(((a.data as { clients: LigneBalance[] }).clients ?? []) as LigneBalance[]);
    setClients((b.data ?? []) as typeof clients);
  }, [org, au]);
  useEffect(() => {
    void charger();
  }, [charger]);

  function nouvelleCreance() {
    setErreur('');
    setCreance({ client: '', date: aujourdhui(), montant: '' });
  }

  const avecExemples = (lignes ?? []).some((l) => l.exemple);
  const vues = (lignes ?? []).filter((l) => !sansExemples || !l.exemple);
  const totaux = TRANCHES.map((t) => vues.reduce((s, l) => s + Number(l[t.cle] ?? 0), 0));
  const total = vues.reduce((s, l) => s + Number(l.total), 0);
  const echu = total - (totaux[0] ?? 0);
  const plus60 = (totaux[3] ?? 0) + (totaux[4] ?? 0);

  async function enregistrerCreance(e: FormEvent) {
    e.preventDefault();
    if (!creance) return;
    const m = lireMontant(creance.montant ?? '');
    if (!creance.client) return setErreur('Choisissez le client.');
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
    setInfo('Créance enregistrée : elle apparaît dans la balance âgée et le relevé du client.');
    await charger();
  }

  function exporter(format: FormatExport = 'xlsx') {
    const entetes = ['Client', 'Type', 'Téléphone', ...TRANCHES.map((t) => t.libelle), 'Total dû', 'Retard max (j)', 'Étape', 'Dernière relance'];
    exporterClasseur(
      `balance-agee-${au}`,
      [
        {
          nom: 'Balance âgée',
          titre: [`${organisation!.nom} — Balance âgée des créances clients au ${dateFr(au)}`],
          entetes,
          lignes: [
            ...vues.map((l) => [
              l.nom, l.type_client === 'particulier' ? 'Particulier' : 'Entreprise', l.telephone ?? '', ...TRANCHES.map((t) => enUnites(l[t.cle])),
              enUnites(l.total), l.retard_max ?? 0, ETAPES[l.etape]!.titre, l.derniere_relance ? dateFr(l.derniere_relance) : '',
            ]),
            ['Part du total', '', '', ...totaux.map((v) => pourcent(v, total)), '100 %', '', '', ''],
          ],
          totaux: ['Total', '', '', ...totaux.map((v) => enUnites(v)), enUnites(total), '', '', ''],
        },
      ],
      format,
    );
  }

  return (
    <>
      <EnTetePage
        icone="📊"
        titre="Balance âgée des créances"
        sousTitre="Ce que chaque client doit, rangé par ancienneté du retard. Touchez un client pour son relevé et ses relances."
        actions={
          <>
            <BoutonsExport onExport={exporter} disabled={!vues.length} />
            {droits.tenir && (
              <button className="bouton bouton-discret" onClick={nouvelleCreance} title="Une dette antérieure au logiciel, une facture hors caisse…">
                Créance existante
              </button>
            )}
            {droits.tenir && (
              <button className="bouton bouton-principal" onClick={() => naviguer('/credits/nouveau')}>Nouveau crédit</button>
            )}
          </>
        }
      />
      <Alerte>{erreur && !creance ? erreur : ''}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      <section className="tuiles">
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur"><MontantFort v={total} /></span>
          <span className="tuile-libelle">total à encaisser · {vues.length} client{vues.length > 1 ? 's' : ''}</span>
        </div>
        <div className={`tuile tuile-fixe ${echu > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur"><MontantFort v={echu} /></span>
          <span className="tuile-libelle">échu · {pourcent(echu, total)} du total</span>
        </div>
        <div className={`tuile tuile-fixe ${plus60 > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur"><MontantFort v={plus60} /></span>
          <span className="tuile-libelle">plus de 60 jours · risque d’impayé</span>
        </div>
      </section>

      {total > 0 && (
        <section className="carte">
          <h2>Répartition par ancienneté</h2>
          <div className="barre-anciennete" role="img" aria-label="Répartition des créances par ancienneté">
            {TRANCHES.map((t, i) =>
              totaux[i] ? (
                <span key={t.cle} className={`tranche-${t.cle}`} style={{ flexGrow: totaux[i] }} title={`${t.libelle} : ${montant(totaux[i]!)}`} />
              ) : null,
            )}
          </div>
          <ul className="legende-anciennete">
            {TRANCHES.map((t, i) => (
              <li key={t.cle}>
                <span className={`pastille-tranche tranche-${t.cle}`} aria-hidden />
                {t.libelle} <strong>{montant(totaux[i] ?? 0)}</strong> <span className="secondaire">{pourcent(totaux[i] ?? 0, total)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="carte">
        <div className="filtres-ligne">
          <Champ label="Situation au">
            <input type="date" value={au} max={aujourdhui()} onChange={(e) => e.target.value && setAu(e.target.value)} />
          </Champ>
          {avecExemples && (
            <label className="case">
              <input type="checkbox" checked={sansExemples} onChange={(e) => setSansExemples(e.target.checked)} /> Masquer les exemples (TEST)
            </label>
          )}
        </div>
        {!lignes ? (
          <Vide>Chargement…</Vide>
        ) : vues.length === 0 ? (
          <Vide>Aucune créance en cours à cette date.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau tableau-balance">
              <thead>
                <tr>
                  <th>Client</th>
                  {TRANCHES.map((t) => (
                    <th key={t.cle} className="nombre">{t.libelle}</th>
                  ))}
                  <th className="nombre">Total dû</th>
                  <th>Étape</th>
                  <th className="col-secondaire">Relance</th>
                </tr>
              </thead>
              <tbody>
                {vues.map((l) => (
                  <tr key={l.id} className="ligne-cliquable" onClick={() => naviguer(`/credits/clients/${l.id}`)}>
                    <td>
                      <strong>{l.nom}</strong> {l.exemple && <span className="badge-test">TEST</span>}
                      <div className="secondaire">
                        {[l.telephone, `${l.pieces} pièce${l.pieces > 1 ? 's' : ''}`, l.retard_max ? `${l.retard_max} j de retard` : null].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    {TRANCHES.map((t, i) => (
                      <td key={t.cle} className={`nombre ${i >= 3 && Number(l[t.cle]) > 0 ? 'texte-negatif' : ''}`}>
                        {Number(l[t.cle]) ? montant(l[t.cle]) : '—'}
                      </td>
                    ))}
                    <td className="nombre"><strong>{montant(l.total)}</strong></td>
                    <td><EtapePastille etape={l.etape} /></td>
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
                  <td />
                  <td className="col-secondaire" />
                </tr>
                <tr className="ligne-part">
                  <td>Part du total</td>
                  {totaux.map((v, i) => (
                    <td key={i} className="nombre">{pourcent(v, total)}</td>
                  ))}
                  <td className="nombre">100 %</td>
                  <td />
                  <td className="col-secondaire" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <Fenetre titre="Créance existante" ouverte={!!creance} onFermer={() => setCreance(null)}>
        {creance && (
          <form className="formulaire" onSubmit={enregistrerCreance}>
            <p className="secondaire">
              Pour une dette antérieure au logiciel ou une facture établie hors caisse. Pour des articles remis à crédit, utilisez plutôt
              « Nouveau crédit » : le stock et la procédure de relance suivent.
            </p>
            <Alerte>{erreur}</Alerte>
            <div className="grille-2">
              <Champ label="Client" aide={clients.length ? undefined : 'Enregistrez d’abord le client dans l’onglet Clients'}>
                <select value={creance.client} onChange={(e) => setCreance({ ...creance, client: e.target.value })} required>
                  <option value="">Choisir…</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>{c.nom}</option>
                  ))}
                </select>
              </Champ>
              <Champ label="Montant">
                <input value={creance.montant} onChange={(e) => setCreance({ ...creance, montant: e.target.value })} inputMode={clavierMontant()} required />
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
                <input value={creance.libelle ?? ''} onChange={(e) => setCreance({ ...creance, libelle: e.target.value })} maxLength={160} placeholder="Reprise du cahier de crédit, facture d’octobre…" />
              </Champ>
            </div>
            <button className="bouton bouton-principal">Enregistrer la créance</button>
          </form>
        )}
      </Fenetre>
    </>
  );
}

/* ------------------------------------------------------------------------------------------
 * Fiche client : relevé de compte, crédits, relances, encaissements
 * ---------------------------------------------------------------------------------------- */

interface Releve {
  client: Client;
  creances: {
    id: string;
    credit_id: string | null;
    date_creance: string;
    echeance: string;
    montant: number;
    libelle: string | null;
    piece: string | null;
    statut: string;
    motif_annulation: string | null;
    reste: number;
    jours_retard: number;
  }[];
  encaissements: { id: string; date_encaissement: string; montant: number; compte: string; reference: string | null; statut: string; piece: string | null }[];
  relances: { niveau: number; date_relance: string; montant_du: number }[];
  solde: number;
  echu: number;
}

export const TEXTES_RELANCE: Record<1 | 2 | 3 | 4, { titre: string; corps: string; fin: string }> = {
  1: {
    titre: 'Relance amiable',
    corps:
      'Sauf erreur ou omission de notre part, nous constatons que les sommes ci-dessous restent impayées à ce jour. Il s’agit peut-être d’un simple oubli : nous vous remercions de bien vouloir procéder à leur règlement dans les meilleurs délais.',
    fin: 'Si votre paiement a été effectué entre-temps, merci de ne pas tenir compte de ce courrier.',
  },
  2: {
    titre: 'Seconde relance',
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
  4: {
    titre: 'Dernier avis avant recouvrement contentieux',
    corps:
      'Notre mise en demeure est restée sans effet : les sommes ci-dessous restent impayées. Sans règlement intégral sous quarante-huit (48) heures, le dossier sera transmis pour recouvrement contentieux.',
    fin: 'Les frais de recouvrement pourront être mis à votre charge dans les limites prévues par la loi.',
  },
};

export function FicheClient() {
  const { id } = useParams();
  const { organisation } = useSession();
  const droits = useDroitsClients();
  const { identite } = useIdentite();
  const { imprimer } = useImpression();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const { comptes } = useComptes(org);
  const [r, setR] = useState<Releve | null>(null);
  const [dossiers, setDossiers] = useState<DossierCredit[]>([]);
  const [procedure, setProcedure] = useState<Procedure | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [encaissement, setEncaissement] = useState<Record<string, string> | null>(null);
  const [edition, setEdition] = useState<Partial<Client> | null>(null);

  const charger = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.rpc('releve_client', { p_client: id }),
      supabase.rpc('credits_liste', { p_org: org, p_magasin: null }),
    ]);
    if (a.error) return setErreur(messageErreur(a.error));
    setR(a.data as Releve);
    if (!b.error) {
      const l = b.data as { dossiers: DossierCredit[]; procedure: Procedure };
      setDossiers((l.dossiers ?? []).filter((d) => d.client_id === id));
      setProcedure(l.procedure);
    }
  }, [id, org]);
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

  async function relancer(niveau: 1 | 2 | 3 | 4) {
    if (!r) return;
    const { error } = await supabase.rpc('enregistrer_relance', { p_client: id, p_niveau: niveau });
    if (error) return setErreur(messageErreur(error));
    const t = TEXTES_RELANCE[niveau];
    const echues = r.creances.filter((c) => c.statut === 'ouverte' && Number(c.reste) > 0 && c.jours_retard > 0);
    const o = identite?.organisation;
    await imprimer(
      <PapierEntete o={o} logoUrl={identite?.logoUrl ?? null} destinataire={r.client} lettre>
        <p className="lettre-date">{dateCourrier(o)}</p>
        <p className="lettre-objet"><span>Objet :</span> {t.titre}</p>
        {niveau >= 3 && <p className="lettre-mention">Lettre remise en main propre contre décharge</p>}
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
        <Signature />
        {niveau >= 3 && (
          <div className="signatures signatures-2 decharge">
            <div>Reçu le<br /><span>Date</span></div>
            <div>Le client<br /><span>Nom et signature (décharge)</span></div>
          </div>
        )}
      </PapierEntete>,
      'a4',
    );
    setInfo(`${t.titre} enregistrée et prête à imprimer.`);
    await charger();
  }

  async function imprimerReleve() {
    if (!r) return;
    const o = identite?.organisation;
    const mouvements = [
      ...r.creances.filter((c) => c.statut === 'ouverte').map((c) => ({
        d: c.date_creance,
        l: `${[c.piece, c.libelle].filter(Boolean).join(' · ') || 'Créance'} (échéance ${dateFr(c.echeance)})`,
        debit: Number(c.montant),
        credit: 0,
      })),
      ...r.encaissements.filter((e) => e.statut === 'enregistre').map((e) => ({
        d: e.date_encaissement,
        l: `Règlement ${e.compte}${e.reference ? ` · ${e.reference}` : ''}`,
        debit: 0,
        credit: Number(e.montant),
      })),
    ].sort((a, b) => a.d.localeCompare(b.d));
    let solde = 0;
    await imprimer(
      <PapierEntete
        o={o}
        logoUrl={identite?.logoUrl ?? null}
        titre="Relevé de compte client"
        reference={<>au {dateFr(aujourdhui())}</>}
      >
        <div className="bloc-infos">
          <div><span>Client</span><strong>{r.client.nom}</strong>{r.client.telephone && <small>{r.client.telephone}</small>}</div>
          <div><span>Identification</span><strong>{identifiants(r.client) || '—'}</strong></div>
          <div><span>Solde dû</span><strong>{montant(r.solde)}</strong></div>
          <div><span>Dont échu</span><strong>{montant(r.echu)}</strong></div>
        </div>
        <table className="rapport-tableau">
          <thead>
            <tr><th>Date</th><th>Opération</th><th className="nombre">Débit</th><th className="nombre">Crédit</th><th className="nombre">Solde</th></tr>
          </thead>
          <tbody>
            {mouvements.map((x, i) => {
              solde += x.debit - x.credit;
              return (
                <tr key={i}>
                  <td>{dateFr(x.d)}</td>
                  <td>{x.l}</td>
                  <td className="nombre">{x.debit ? montant(x.debit) : ''}</td>
                  <td className="nombre">{x.credit ? montant(x.credit) : ''}</td>
                  <td className="nombre">{montant(solde)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr><td colSpan={4}>Solde dû</td><td className="nombre">{montant(r.solde)}</td></tr>
          </tfoot>
        </table>
        <p className="secondaire">Merci de vérifier ce relevé et de nous signaler toute différence dans les huit (8) jours.</p>
      </PapierEntete>,
      'a4',
    );
  }

  if (!r) return <EnTetePage titre="Client" sousTitre={erreur || 'Chargement…'} />;
  const ouvertes = r.creances.filter((c) => c.statut === 'ouverte' && Number(c.reste) > 0);
  const derniere = r.relances[0]?.niveau ?? 0;
  const retardMax = Math.max(0, ...ouvertes.map((c) => c.jours_retard));
  const etape = procedure ? [procedure.palier_1, procedure.palier_2, procedure.palier_3, procedure.palier_4].filter((s) => retardMax >= s).length : 0;
  // Le courrier suit la procédure : au moins l'étape atteinte, et jamais en dessous de la relance précédente.
  const prochainNiveau = Math.min(4, Math.max(1, etape, derniere + 1)) as 1 | 2 | 3 | 4;
  const numeroDossier = (cid: string | null) => dossiers.find((d) => d.id === cid)?.numero;

  return (
    <>
      <EnTetePage
        icone={r.client.type_client === 'particulier' ? '🧑' : '🏢'}
        titre={r.client.nom}
        sousTitre={[r.client.telephone, r.client.email, r.client.adresse].filter(Boolean).join(' · ') || 'Compte client'}
        actions={
          <>
            <button className="bouton bouton-discret" onClick={() => naviguer('/credits/clients')}>← Clients</button>
            {droits.modifier && <button className="bouton bouton-discret" onClick={() => setEdition(r.client)}>Modifier</button>}
            <button className="bouton bouton-discret" onClick={() => void imprimerReleve()}>🖨️ Relevé</button>
            {droits.tenir && r.echu > 0 && (
              <button className="bouton bouton-discret" onClick={() => void relancer(prochainNiveau)}>
                ✉️ {TEXTES_RELANCE[prochainNiveau].titre}
              </button>
            )}
            {droits.tenir && !r.client.exemple && (
              <button className="bouton bouton-discret" onClick={() => naviguer(`/credits/nouveau?client=${r.client.id}`)}>Nouveau crédit</button>
            )}
            {droits.encaisser && r.solde > 0 && (
              <button
                className="bouton bouton-principal"
                onClick={() => setEncaissement({ creance: ouvertes[ouvertes.length - 1]?.id ?? '', montant: '', compte: comptes[0]?.id ?? '', date: aujourdhui() })}
              >
                Encaisser
              </button>
            )}
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      <section className="carte fiche-identite">
        <div><span>Type</span><strong><TypeClientPastille c={r.client} /></strong></div>
        {r.client.contact && <div><span>Contact</span><strong>{r.client.contact}</strong></div>}
        <div><span>{r.client.type_client === 'particulier' ? 'NCC / RCCM' : 'RCCM / NCC'}</span><strong>{[r.client.rccm && `RCCM ${r.client.rccm}`, r.client.ncc && `NCC ${r.client.ncc}`].filter(Boolean).join(' · ') || (r.client.type_client === 'particulier' ? 'Aucun' : '—')}</strong></div>
        {r.client.type_client === 'particulier' && <div><span>Pièce d’identité</span><strong>{r.client.piece_identite || '—'}</strong></div>}
        <div><span>Délai habituel</span><strong>{r.client.delai_paiement} jours</strong></div>
        <div><span>Plafond</span><strong>{r.client.plafond_credit == null ? 'Aucun' : montant(r.client.plafond_credit)}</strong></div>
        {r.client.note && <div className="fiche-note"><span>Note</span><strong>{r.client.note}</strong></div>}
      </section>

      <section className="tuiles">
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur"><MontantFort v={r.solde} /></span>
          <span className="tuile-libelle">solde dû</span>
        </div>
        <div className={`tuile tuile-fixe ${r.echu > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur"><MontantFort v={r.echu} /></span>
          <span className="tuile-libelle">échu{retardMax > 0 ? ` · ${retardMax} j de retard` : ''}</span>
        </div>
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur">{r.solde > 0 ? <EtapePastille etape={etape} /> : <Pastille ton="vert">À jour</Pastille>}</span>
          <span className="tuile-libelle">étape de la procédure{derniere ? ` · dernière relance n° ${derniere}` : ''}</span>
        </div>
        {r.client.plafond_credit !== null && (
          <div className={`tuile tuile-fixe ${r.solde > Number(r.client.plafond_credit) ? 'tuile-alerte' : ''}`}>
            <span className="tuile-valeur"><MontantFort v={Math.max(0, Number(r.client.plafond_credit) - r.solde)} /></span>
            <span className="tuile-libelle">encore disponible sous le plafond</span>
          </div>
        )}
      </section>

      <section className="carte">
        <h2>Crédits du client</h2>
        {dossiers.length === 0 ? (
          <Vide>Aucun crédit pour ce client.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr><th>Dossier</th><th>Échéance</th><th>Étape</th><th className="nombre">Total</th><th className="nombre">Reste dû</th><th className="col-secondaire">Suivi par</th></tr>
              </thead>
              <tbody>
                {dossiers.map((d) => (
                  <tr key={d.id} className="ligne-cliquable" onClick={() => naviguer(`/credits/${d.id}`)}>
                    <td><Link to={`/credits/${d.id}`} onClick={(e) => e.stopPropagation()}>{d.numero}</Link><div className="secondaire">{dateFr(d.date_credit)} · {d.articles} article{d.articles > 1 ? 's' : ''}</div></td>
                    <td>{d.statut === 'brouillon' ? <Pastille ton="gris">Brouillon</Pastille> : d.statut === 'annule' ? <Pastille ton="gris">Annulé</Pastille> : <Echeance d={d} />}</td>
                    <td>{d.statut === 'valide' && Number(d.reste) > 0 ? <EtapePastille etape={d.etape} /> : '—'}</td>
                    <td className="nombre">{montant(d.total)}</td>
                    <td className="nombre"><strong>{montant(d.reste)}</strong></td>
                    <td className="col-secondaire">{d.responsable ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="carte">
        <h2>Relevé : créances</h2>
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
                    <td>
                      {[c.piece, c.libelle].filter(Boolean).join(' · ') || '—'}
                      {c.credit_id && (
                        <div className="secondaire"><Link to={`/credits/${c.credit_id}`}>Crédit {numeroDossier(c.credit_id) ?? ''} →</Link></div>
                      )}
                    </td>
                    <td>
                      {Number(c.reste) > 0 && c.jours_retard > 0 ? <Pastille ton={c.jours_retard > 60 ? 'rouge' : 'or'}>{dateFr(c.echeance)} · {c.jours_retard} j</Pastille> : dateFr(c.echeance)}
                    </td>
                    <td className="nombre">{montant(c.montant)}</td>
                    <td className="nombre">{c.statut === 'annulee' ? '—' : Number(c.reste) ? <strong>{montant(c.reste)}</strong> : <Pastille ton="vert">Soldée</Pastille>}</td>
                    <td>
                      {c.statut === 'ouverte' && !c.credit_id && droits.annuler && (
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
        <h2>Règlements reçus</h2>
        {r.encaissements.length === 0 ? (
          <Vide>Aucun règlement.</Vide>
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
                    {e.statut === 'enregistre' && droits.annuler && (
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
                {dateFr(x.date_relance)} — {TEXTES_RELANCE[x.niveau as 1 | 2 | 3 | 4]?.titre ?? `Relance n° ${x.niveau}`} ({montant(x.montant_du)} dû)
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

      <FenetreClient
        client={edition}
        onFermer={() => setEdition(null)}
        onEnregistre={() => {
          setEdition(null);
          setInfo('Client mis à jour.');
          void charger();
        }}
      />
    </>
  );
}
