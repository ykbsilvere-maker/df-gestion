import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { dateHeure, messageErreur } from '../lib/format';
import { montantEn } from '../lib/argent';
import { ChoixDevise } from '../components/ChoixDevise';
import { encoderCode, lireConfiguration } from '../lib/config';
import { genererMotDePasse, gererCompte, messageIdentifiants } from '../lib/comptes';
import { REGIMES, type RegimeFiscal } from '../lib/types';
import { Alerte, Champ, EnTetePage, Fenetre, Ico, MontantFort, Pastille, Vide } from '../components/ui';
import { Identifiants } from '../components/Identifiants';

interface LigneEntreprise {
  organisation_id: string;
  nom: string;
  ville: string | null;
  telephone: string | null;
  actif: boolean;
  creee_le: string;
  magasins: number;
  caisses: number;
  caisses_ouvertes: number;
  utilisateurs: number;
  gerants: { nom: string | null; email: string; derniere_connexion: string | null }[];
  gerants_en_attente: string[];
  ventes_jour: number;
  tickets_jour: number;
  ventes_mois: number;
  derniere_activite: string | null;
  devise: string;
}

type Fenetres =
  | { type: 'nouvelle' }
  | { type: 'gerant'; e: LigneEntreprise }
  | { type: 'motdepasse'; e: LigneEntreprise }
  | { type: 'suspendre'; e: LigneEntreprise }
  | { type: 'identifiants'; texte: string; titre: string }
  | null;

/** Console de l'administrateur général : toutes les entreprises clientes, en consultation. */
export function Administration() {
  const { plateforme, rechargerPlateforme, rechargerOrganisations, choisirOrganisation } = useSession();
  const naviguer = useNavigate();
  const [lignes, setLignes] = useState<LigneEntreprise[] | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [fenetre, setFenetre] = useState<Fenetres>(null);

  const charger = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_tableau_de_bord');
    if (error) return setErreur(messageErreur(error));
    setLignes(
      (data as LigneEntreprise[]).map((l) => ({
        ...l,
        ventes_jour: Number(l.ventes_jour),
        tickets_jour: Number(l.tickets_jour),
        ventes_mois: Number(l.ventes_mois),
      })),
    );
  }, []);
  useEffect(() => void charger(), [charger]);

  async function apres(message: string) {
    setInfo(message);
    setErreur('');
    await Promise.all([charger(), rechargerOrganisations().catch(() => undefined)]);
  }

  async function ouvrir(e: LigneEntreprise) {
    await rechargerOrganisations().catch(() => undefined);
    choisirOrganisation(e.organisation_id);
    naviguer('/');
  }

  const actives = (lignes ?? []).filter((l) => l.actif);
  // Les montants ne s'additionnent qu'à l'intérieur d'une même monnaie.
  const parDevise = new Map<string, { jour: number; mois: number }>();
  for (const l of actives) {
    const t = parDevise.get(l.devise) ?? { jour: 0, mois: 0 };
    t.jour += l.ventes_jour;
    t.mois += l.ventes_mois;
    parDevise.set(l.devise, t);
  }
  const devises = [...parDevise.entries()].sort(([a], [b]) => (a === 'XOF' ? -1 : b === 'XOF' ? 1 : a.localeCompare(b)));
  const totaux = {
    tickets: actives.reduce((s, l) => s + l.tickets_jour, 0),
    caissesOuvertes: actives.reduce((s, l) => s + l.caisses_ouvertes, 0),
  };
  const valeurs = (cle: 'jour' | 'mois') =>
    devises.length === 0 ? (
      <MontantFort v={0} code="XOF" />
    ) : (
      devises.map(([d, t]) => (
        <span key={d} className="tuile-ligne">
          <MontantFort v={t[cle]} code={d} />
        </span>
      ))
    );

  return (
    <>
      <EnTetePage
        icone="🛡️"
        titre="Administration générale"
        sousTitre="Toutes vos entreprises clientes, en consultation. Les gérants principaux gèrent leurs caisses et leurs employés."
        actions={
          <button className="bouton bouton-principal" onClick={() => setFenetre({ type: 'nouvelle' })}>
            Nouvelle entreprise
          </button>
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      <section className="tuiles">
        <div className="tuile">
          <span className="tuile-icone" aria-hidden>🏢</span>
          <span className="tuile-valeur">{actives.length}</span>
          <span className="tuile-libelle">entreprise{actives.length > 1 ? 's' : ''} active{actives.length > 1 ? 's' : ''}</span>
        </div>
        <div className="tuile tuile-ventes">
          <span className="tuile-icone" aria-hidden>💰</span>
          <span className="tuile-valeur">{valeurs('jour')}</span>
          <span className="tuile-libelle">ventes du jour ({totaux.tickets} ticket{totaux.tickets > 1 ? 's' : ''})</span>
        </div>
        <div className="tuile">
          <span className="tuile-icone" aria-hidden>📅</span>
          <span className="tuile-valeur">{valeurs('mois')}</span>
          <span className="tuile-libelle">ventes du mois</span>
        </div>
        <div className="tuile">
          <span className="tuile-icone" aria-hidden>🧾</span>
          <span className="tuile-valeur">{totaux.caissesOuvertes}</span>
          <span className="tuile-libelle">caisse{totaux.caissesOuvertes > 1 ? 's' : ''} ouverte{totaux.caissesOuvertes > 1 ? 's' : ''}</span>
        </div>
      </section>

      <section className="carte">
        <div className="carte-entete">
          <h2>
            <Ico>🏢</Ico>
            Entreprises
          </h2>
          <button type="button" className="bouton-lien" onClick={() => void charger()}>
            Actualiser
          </button>
        </div>
        {!lignes ? (
          <p>Chargement…</p>
        ) : lignes.length === 0 ? (
          <Vide>Aucune entreprise pour l’instant. Créez la première avec l’accès de son gérant principal.</Vide>
        ) : (
          <div className="liste-entreprises">
            {lignes.map((e) => (
              <article key={e.organisation_id} className={`fiche-entreprise ${e.actif ? '' : 'carte-inactive'}`}>
                <header>
                  <div>
                    <h3>{e.nom}</h3>
                    <span className="secondaire">
                      {[e.ville, e.telephone].filter(Boolean).join(' · ') || '—'} · créée le {dateHeure(e.creee_le).split(' ')[0]}
                    </span>
                  </div>
                  {e.actif ? <Pastille ton="vert">Active</Pastille> : <Pastille ton="rouge">Suspendue</Pastille>}
                </header>
                <dl className="chiffres-entreprise">
                  <div>
                    <dt>Aujourd’hui</dt>
                    <dd>
                      {montantEn(e.ventes_jour, e.devise)} <small>({e.tickets_jour} ticket{e.tickets_jour > 1 ? 's' : ''})</small>
                    </dd>
                  </div>
                  <div>
                    <dt>Ce mois</dt>
                    <dd>{montantEn(e.ventes_mois, e.devise)}</dd>
                  </div>
                  <div>
                    <dt>Caisses</dt>
                    <dd>
                      {e.caisses_ouvertes} ouverte{e.caisses_ouvertes > 1 ? 's' : ''} / {e.caisses}
                    </dd>
                  </div>
                  <div>
                    <dt>Utilisateurs</dt>
                    <dd>
                      {e.utilisateurs} · {e.magasins} magasin{e.magasins > 1 ? 's' : ''}
                    </dd>
                  </div>
                </dl>
                <div className="gerants">
                  <span className="champ-label">Gérant principal</span>
                  {e.gerants.map((g) => (
                    <div key={g.email}>
                      <strong>{g.nom || g.email}</strong>
                      {g.nom && <span className="secondaire"> {g.email}</span>}
                      <span className="secondaire"> · dernière connexion : {g.derniere_connexion ? dateHeure(g.derniere_connexion) : 'jamais'}</span>
                    </div>
                  ))}
                  {e.gerants_en_attente.map((m) => (
                    <div key={m}>
                      {m} <Pastille ton="or">pas encore connecté</Pastille>
                    </div>
                  ))}
                  {!e.gerants.length && !e.gerants_en_attente.length && <span className="secondaire">Aucun</span>}
                </div>
                <div className="actions-ligne">
                  <button type="button" className="bouton bouton-discret" onClick={() => void ouvrir(e)}>
                    Ouvrir
                  </button>
                  <button type="button" className="bouton-lien" onClick={() => setFenetre({ type: 'gerant', e })}>
                    Ajouter un gérant
                  </button>
                  {e.gerants.length > 0 && (
                    <button type="button" className="bouton-lien" onClick={() => setFenetre({ type: 'motdepasse', e })}>
                      Mot de passe du gérant
                    </button>
                  )}
                  {e.actif ? (
                    <button type="button" className="bouton-lien lien-danger" onClick={() => setFenetre({ type: 'suspendre', e })}>
                      Suspendre
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="bouton-lien"
                      onClick={() =>
                        void supabase.rpc('admin_reactiver_entreprise', { p_org: e.organisation_id }).then(({ error }) =>
                          error ? setErreur(messageErreur(error)) : apres(`${e.nom} est réactivée.`),
                        )
                      }
                    >
                      Réactiver
                    </button>
                  )}
                </div>
                {e.derniere_activite && <p className="secondaire">Dernière activité : {dateHeure(e.derniere_activite)}</p>}
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="grille-2">
        <ConfigurerTelephone />
        <section className="carte">
          <h2>
            <Ico>⚙️</Ico>
            Règles de la plateforme
          </h2>
          <label className="case case-longue">
            <input
              type="checkbox"
              checked={!!plateforme?.inscription_libre}
              onChange={(ev) =>
                void supabase.rpc('admin_definir_inscription_libre', { p_libre: ev.target.checked }).then(async ({ error }) => {
                  if (error) return setErreur(messageErreur(error));
                  await rechargerPlateforme();
                  setInfo(ev.target.checked ? 'Inscription libre ouverte.' : 'Inscription libre fermée.');
                })
              }
            />
            Inscription libre : toute personne peut créer sa propre entreprise
          </label>
          <p className="secondaire">
            Fermée (recommandé) : seul l’administrateur général crée les entreprises et l’accès de leur gérant principal.
          </p>
        </section>
      </div>

      <Fenetre
        titre={
          fenetre?.type === 'nouvelle'
            ? 'Nouvelle entreprise'
            : fenetre?.type === 'gerant'
              ? `Ajouter un gérant — ${fenetre.e.nom}`
              : fenetre?.type === 'motdepasse'
                ? `Mot de passe du gérant — ${fenetre.e.nom}`
                : fenetre?.type === 'suspendre'
                  ? `Suspendre ${fenetre.e.nom}`
                  : fenetre?.type === 'identifiants'
                    ? fenetre.titre
                    : ''
        }
        ouverte={!!fenetre}
        onFermer={() => setFenetre(null)}
      >
        {fenetre?.type === 'nouvelle' && (
          <FormulaireEntreprise
            onFini={async (r) => {
              await apres(r.message);
              setFenetre(r.texte ? { type: 'identifiants', titre: 'Identifiants à transmettre', texte: r.texte } : null);
            }}
          />
        )}
        {fenetre?.type === 'gerant' && (
          <FormulaireGerant
            entreprise={fenetre.e}
            onFini={async (r) => {
              await apres(r.message);
              setFenetre(r.texte ? { type: 'identifiants', titre: 'Identifiants à transmettre', texte: r.texte } : null);
            }}
          />
        )}
        {fenetre?.type === 'motdepasse' && (
          <FormulaireReinitialisation
            entreprise={fenetre.e}
            onFini={async (texte) => {
              await apres('Mot de passe réinitialisé.');
              setFenetre({ type: 'identifiants', titre: 'Nouveaux identifiants à transmettre', texte });
            }}
          />
        )}
        {fenetre?.type === 'suspendre' && (
          <FormulaireSuspension
            entreprise={fenetre.e}
            onFini={async () => {
              setFenetre(null);
              await apres(`${fenetre.e.nom} est suspendue : ses utilisateurs n’ont plus accès.`);
            }}
          />
        )}
        {fenetre?.type === 'identifiants' && <Identifiants texte={fenetre.texte} />}
      </Fenetre>
    </>
  );
}

/** Création de l'accès (mot de passe provisoire) ; repli sur l'invitation si la fonction serveur manque. */
async function creerAcces(email: string, nom: string, motDePasse: string, entreprise: string) {
  const r = await gererCompte('creer', email, motDePasse, nom);
  if (r.ok) return { message: `Accès créé pour ${email}.`, texte: messageIdentifiants({ nom, entreprise, email, motDePasse }) };
  if (r.statut === 'existe') return { message: `${email} avait déjà un compte : accès ajouté, il se connecte avec son mot de passe habituel.` };
  if (r.absente)
    return {
      message: `Invitation enregistrée pour ${email}. ${r.message} En attendant, la personne crée elle-même son compte avec cette adresse : elle sera rattachée automatiquement.`,
    };
  return { message: `Invitation enregistrée, mais l’accès n’a pas pu être créé : ${r.message}` };
}

function ChampsAcces({
  v,
  maj,
}: {
  v: { gerantNom: string; gerantEmail: string; motDePasse: string };
  maj: (cle: 'gerantNom' | 'gerantEmail' | 'motDePasse', valeur: string) => void;
}) {
  return (
    <fieldset className="groupe">
      <legend>Gérant principal (tous les droits sur son entreprise)</legend>
      <Champ label="Nom et prénoms">
        <input value={v.gerantNom} onChange={(e) => maj('gerantNom', e.target.value)} required autoComplete="off" />
      </Champ>
      <Champ label="Adresse e-mail (identifiant)">
        <input type="email" value={v.gerantEmail} onChange={(e) => maj('gerantEmail', e.target.value)} required autoComplete="off" />
      </Champ>
      <Champ label="Mot de passe provisoire" aide="Il le remplacera à sa première connexion.">
        <div className="champ-avec-bouton">
          <input value={v.motDePasse} onChange={(e) => maj('motDePasse', e.target.value)} minLength={8} required autoComplete="off" />
          <button type="button" className="bouton bouton-discret" onClick={() => maj('motDePasse', genererMotDePasse())}>
            Générer
          </button>
        </div>
      </Champ>
    </fieldset>
  );
}

function FormulaireEntreprise({ onFini }: { onFini: (r: { message: string; texte?: string }) => Promise<void> }) {
  const [v, setV] = useState({
    nom: '',
    ville: 'Abidjan',
    telephone: '',
    adresse: '',
    ncc: '',
    regime: 'non_precise' as RegimeFiscal,
    devise: 'XOF',
    magasin: 'Magasin principal',
    gerantNom: '',
    gerantEmail: '',
    motDePasse: genererMotDePasse(),
  });
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const maj = (cle: keyof typeof v, valeur: string) => setV((x) => ({ ...x, [cle]: valeur }));

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    if (envoi) return;
    setEnvoi(true);
    setErreur('');
    const email = v.gerantEmail.trim().toLowerCase();
    const { error } = await supabase.rpc('admin_creer_entreprise', {
      p_nom: v.nom,
      p_gerant_email: email,
      p_ncc: v.ncc || null,
      p_regime_fiscal: v.regime,
      p_telephone: v.telephone || null,
      p_adresse: v.adresse || null,
      p_ville: v.ville || null,
      p_nom_magasin: v.magasin,
      p_devise: v.devise,
    });
    if (error) {
      setEnvoi(false);
      return setErreur(messageErreur(error));
    }
    const r = await creerAcces(email, v.gerantNom.trim(), v.motDePasse, v.nom.trim());
    setEnvoi(false);
    await onFini({ message: `Entreprise « ${v.nom.trim()} » créée. ${r.message}`, texte: r.texte });
  }

  return (
    <form className="formulaire" onSubmit={soumettre}>
      <Alerte>{erreur}</Alerte>
      <Champ label="Nom de l’entreprise">
        <input value={v.nom} onChange={(e) => maj('nom', e.target.value)} required minLength={2} maxLength={120} />
      </Champ>
      <div className="grille-2">
        <Champ label="Ville">
          <input value={v.ville} onChange={(e) => maj('ville', e.target.value)} />
        </Champ>
        <Champ label="Téléphone">
          <input value={v.telephone} onChange={(e) => maj('telephone', e.target.value)} inputMode="tel" />
        </Champ>
        <Champ label="NCC" aide="Facultatif">
          <input value={v.ncc} onChange={(e) => maj('ncc', e.target.value)} maxLength={20} />
        </Champ>
        <Champ label="Régime d’imposition">
          <select value={v.regime} onChange={(e) => maj('regime', e.target.value)}>
            {REGIMES.map((r) => (
              <option key={r.code} value={r.code}>
                {r.libelle}
              </option>
            ))}
          </select>
        </Champ>
      </div>
      <Champ label="Monnaie" aide="XOF par défaut. Modifiable par le gérant tant qu’aucun article n’est créé.">
        <ChoixDevise valeur={v.devise} onChange={(d) => maj('devise', d)} />
      </Champ>
      <Champ label="Nom du premier magasin" aide="Une première caisse y est créée ; le gérant ajoute les autres.">
        <input value={v.magasin} onChange={(e) => maj('magasin', e.target.value)} required minLength={2} />
      </Champ>
      <ChampsAcces v={v} maj={maj} />
      <button className="bouton bouton-principal bouton-plein" disabled={envoi}>
        {envoi ? 'Création…' : 'Créer l’entreprise et l’accès du gérant'}
      </button>
    </form>
  );
}

function FormulaireGerant({
  entreprise,
  onFini,
}: {
  entreprise: LigneEntreprise;
  onFini: (r: { message: string; texte?: string }) => Promise<void>;
}) {
  const [v, setV] = useState({ gerantNom: '', gerantEmail: '', motDePasse: genererMotDePasse() });
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    setEnvoi(true);
    const email = v.gerantEmail.trim().toLowerCase();
    const { error } = await supabase.rpc('admin_ajouter_gerant', { p_org: entreprise.organisation_id, p_email: email });
    if (error) {
      setEnvoi(false);
      return setErreur(messageErreur(error));
    }
    const r = await creerAcces(email, v.gerantNom.trim(), v.motDePasse, entreprise.nom);
    setEnvoi(false);
    await onFini(r);
  }

  return (
    <form className="formulaire" onSubmit={soumettre}>
      <Alerte>{erreur}</Alerte>
      <p className="secondaire">Si la personne a déjà un compte, elle est rattachée tout de suite : elle garde son mot de passe.</p>
      <ChampsAcces v={v} maj={(cle, valeur) => setV((x) => ({ ...x, [cle]: valeur }))} />
      <button className="bouton bouton-principal bouton-plein" disabled={envoi}>
        {envoi ? 'Enregistrement…' : 'Ajouter le gérant'}
      </button>
    </form>
  );
}

function FormulaireReinitialisation({ entreprise, onFini }: { entreprise: LigneEntreprise; onFini: (texte: string) => Promise<void> }) {
  const [email, setEmail] = useState(entreprise.gerants[0]?.email ?? '');
  const [motDePasse, setMotDePasse] = useState(genererMotDePasse());
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    setEnvoi(true);
    const r = await gererCompte('reinitialiser', email, motDePasse);
    setEnvoi(false);
    if (!r.ok) return setErreur(r.message);
    const g = entreprise.gerants.find((x) => x.email === email);
    await onFini(messageIdentifiants({ nom: g?.nom ?? undefined, entreprise: entreprise.nom, email, motDePasse }));
  }

  return (
    <form className="formulaire" onSubmit={soumettre}>
      <Alerte>{erreur}</Alerte>
      <Champ label="Gérant">
        <select value={email} onChange={(e) => setEmail(e.target.value)}>
          {entreprise.gerants.map((g) => (
            <option key={g.email} value={g.email}>
              {g.nom ? `${g.nom} — ${g.email}` : g.email}
            </option>
          ))}
        </select>
      </Champ>
      <Champ label="Nouveau mot de passe provisoire">
        <div className="champ-avec-bouton">
          <input value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} minLength={8} required />
          <button type="button" className="bouton bouton-discret" onClick={() => setMotDePasse(genererMotDePasse())}>
            Générer
          </button>
        </div>
      </Champ>
      <button className="bouton bouton-principal bouton-plein" disabled={envoi}>
        {envoi ? 'Réinitialisation…' : 'Réinitialiser le mot de passe'}
      </button>
    </form>
  );
}

function FormulaireSuspension({ entreprise, onFini }: { entreprise: LigneEntreprise; onFini: () => Promise<void> }) {
  const [motif, setMotif] = useState('');
  const [erreur, setErreur] = useState('');
  async function soumettre(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.rpc('admin_suspendre_entreprise', { p_org: entreprise.organisation_id, p_motif: motif });
    if (error) return setErreur(messageErreur(error));
    await onFini();
  }
  return (
    <form className="formulaire" onSubmit={soumettre}>
      <p>
        Les utilisateurs de {entreprise.nom} n’auront plus accès à rien (y compris les caisses). Leurs données sont conservées et
        vous pourrez réactiver l’entreprise à tout moment.
      </p>
      <Alerte>{erreur}</Alerte>
      <Champ label="Motif *">
        <textarea rows={2} value={motif} onChange={(e) => setMotif(e.target.value)} maxLength={300} placeholder="Abonnement impayé, fin de contrat…" />
      </Champ>
      <button className="bouton bouton-danger bouton-plein" disabled={motif.trim().length < 3}>
        Suspendre l’entreprise
      </button>
    </form>
  );
}

/** QR code et code texte à scanner / coller au premier lancement de l'application sur un téléphone. */
function ConfigurerTelephone() {
  const config = lireConfiguration();
  const [image, setImage] = useState('');
  const [copie, setCopie] = useState(false);
  const code = config ? encoderCode(config) : '';
  useEffect(() => {
    // Bibliothèque chargée seulement ici (elle n'alourdit pas le reste de l'application).
    if (code)
      void import('qrcode').then((QRCode) =>
        QRCode.toDataURL(code, { margin: 1, width: 220, errorCorrectionLevel: 'M' }).then(setImage),
      );
  }, [code]);
  if (!config) return null;
  return (
    <section className="carte configurer-telephone">
      <h2>
        <Ico>📲</Ico>
        Configurer un téléphone
      </h2>
      <p className="secondaire">
        Au premier lancement de l’application Android (ou du site sur un nouvel appareil), scannez ce QR code ou collez le code.
        Il ne contient que l’adresse du serveur et la clé publique.
      </p>
      {image && <img src={image} alt="QR code de configuration" width={180} height={180} />}
      <code className="code-configuration">{code}</code>
      <button type="button" className="bouton bouton-discret" onClick={() => void navigator.clipboard?.writeText(code).then(() => setCopie(true))}>
        {copie ? 'Code copié' : 'Copier le code'}
      </button>
    </section>
  );
}
