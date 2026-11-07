import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';
import { reduireImage } from '../lib/images';
import { REGIMES, type RegimeFiscal } from '../lib/types';
import { Alerte, Champ, Pastille } from '../components/ui';
import { ChoixDevise } from '../components/ChoixDevise';
import { ChoixModules } from '../components/ChoixModules';
import { MarqueDecodeur } from '../components/Marque';
import { transfererLogoDemande } from '../lib/demandeOuverture';

export interface Demande {
  id: string;
  statut: 'en_attente' | 'ajournee' | 'validee' | 'refusee';
  nom_entreprise: string;
  activite: string;
  date_creation: string | null;
  rccm: string | null;
  ncc: string | null;
  regime_fiscal: RegimeFiscal;
  nom_gerant: string;
  telephone: string;
  email_contact: string | null;
  ville: string | null;
  adresse: string | null;
  devise: string;
  nom_magasin: string;
  modules_desactives: string[];
  a_logo: boolean;
  logo: string | null;
  motif: string | null;
  organisation_id: string | null;
  soumise_le: string;
  traitee_le: string | null;
}

type Fiche = Omit<Demande, 'id' | 'statut' | 'a_logo' | 'motif' | 'organisation_id' | 'soumise_le' | 'traitee_le'>;

const VIDE: Fiche = {
  nom_entreprise: '',
  activite: '',
  date_creation: '',
  rccm: '',
  ncc: '',
  regime_fiscal: 'non_precise',
  nom_gerant: '',
  telephone: '',
  email_contact: '',
  ville: 'Abidjan',
  adresse: '',
  devise: 'XOF',
  nom_magasin: 'Magasin principal',
  modules_desactives: [],
  logo: null,
};

async function versDataUrl(blob: Blob): Promise<string> {
  return new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => ko(new Error('Lecture de l’image impossible.'));
    r.readAsDataURL(blob);
  });
}

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Africa/Abidjan' }) : '';

/**
 * Parcours du nouveau client : il présente son entreprise, envoie sa demande, puis suit
 * la réponse de Décodeur Financier (validée, ajournée avec la correction demandée, ou refusée).
 */
export function DemandeEntreprise() {
  const { session, deconnecter, rechargerOrganisations, choisirOrganisation } = useSession();
  const naviguer = useNavigate();
  const [demande, setDemande] = useState<Demande | null | undefined>(undefined);
  const [edition, setEdition] = useState(false);
  const [f, setF] = useState<Fiche>(VIDE);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const fichierRef = useRef<HTMLInputElement>(null);

  const charger = useCallback(async () => {
    const { data, error } = await supabase.rpc('ma_demande');
    if (error) {
      setErreur(messageErreur(error));
      setDemande(null);
      return null;
    }
    const d = (data as Demande | null) ?? null;
    setDemande(d);
    return d;
  }, []);

  const entrer = useCallback(
    async (d: Demande) => {
      await supabase.rpc('accepter_invitations').then(undefined, () => undefined);
      await rechargerOrganisations().catch(() => undefined);
      if (d.organisation_id) {
        await transfererLogoDemande(d).catch(() => undefined);
        choisirOrganisation(d.organisation_id);
      }
      naviguer('/', { replace: true });
    },
    [choisirOrganisation, naviguer, rechargerOrganisations],
  );

  useEffect(() => {
    void charger().then((d) => {
      if (d?.statut === 'validee') void entrer(d);
    });
  }, [charger, entrer]);

  // En attente : on regarde toutes les 30 secondes si la réponse est arrivée.
  useEffect(() => {
    if (demande?.statut !== 'en_attente' || edition) return;
    const id = window.setInterval(() => {
      void charger().then((d) => {
        if (d?.statut === 'validee') void entrer(d);
      });
    }, 30000);
    return () => window.clearInterval(id);
  }, [demande?.statut, edition, charger, entrer]);

  function preparer(d: Demande | null) {
    const nomCompte = (session?.user.user_metadata as { nom_complet?: string } | undefined)?.nom_complet ?? '';
    setF(
      d
        ? {
            nom_entreprise: d.nom_entreprise,
            activite: d.activite,
            date_creation: d.date_creation ?? '',
            rccm: d.rccm ?? '',
            ncc: d.ncc ?? '',
            regime_fiscal: d.regime_fiscal,
            nom_gerant: d.nom_gerant,
            telephone: d.telephone,
            email_contact: d.email_contact ?? '',
            ville: d.ville ?? '',
            adresse: d.adresse ?? '',
            devise: d.devise,
            nom_magasin: d.nom_magasin,
            modules_desactives: d.modules_desactives ?? [],
            logo: d.logo,
          }
        : { ...VIDE, nom_gerant: nomCompte, email_contact: session?.user.email ?? '' },
    );
    setErreur('');
    setInfo('');
    setEdition(true);
  }

  useEffect(() => {
    if (demande === null) preparer(null);
    else if (demande?.statut === 'ajournee') preparer(demande);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demande]);

  const maj = (cle: keyof Fiche) => (e: { target: { value: string } }) => setF({ ...f, [cle]: e.target.value });

  async function choisirLogo(fichier: File | undefined) {
    if (!fichier) return;
    setErreur('');
    try {
      let url = await versDataUrl(await reduireImage(fichier, 400, 'image/png'));
      if (url.length > 380000) url = await versDataUrl(await reduireImage(fichier, 300, 'image/jpeg'));
      if (url.length > 380000) throw new Error('Logo trop lourd : choisissez une image plus petite.');
      setF((x) => ({ ...x, logo: url }));
    } catch (e) {
      setErreur(messageErreur(e));
    }
  }

  async function envoyer(e: FormEvent) {
    e.preventDefault();
    if (envoi) return;
    setEnvoi(true);
    setErreur('');
    const { error } = await supabase.rpc('soumettre_demande', { p: f });
    setEnvoi(false);
    if (error) return setErreur(messageErreur(error));
    setEdition(false);
    setInfo('Demande envoyée. Décodeur Financier l’étudie et vous appelle si besoin.');
    await charger();
  }

  async function invitation() {
    setEnvoi(true);
    const { data } = await supabase.rpc('accepter_invitations');
    await rechargerOrganisations().catch(() => undefined);
    setEnvoi(false);
    if (Number(data) > 0) naviguer('/', { replace: true });
    else setInfo('Aucune invitation à votre adresse pour le moment. Vérifiez l’adresse donnée à votre employeur.');
  }

  if (demande === undefined)
    return (
      <div className="chargement" role="status">
        Chargement…
      </div>
    );

  const pied = (
    <div className="liens-formulaire">
      <button type="button" className="bouton-lien" disabled={envoi} onClick={() => void invitation()}>
        Invité par votre employeur ? Rejoindre son entreprise
      </button>
      <button type="button" className="bouton-lien" onClick={() => void deconnecter()}>
        Se déconnecter
      </button>
    </div>
  );

  // ----- Suivi de la demande -----
  if (demande && !edition) {
    const ton = { en_attente: 'or', ajournee: 'or', validee: 'vert', refusee: 'rouge' } as const;
    const libelle = { en_attente: 'En cours d’étude', ajournee: 'À corriger', validee: 'Validée', refusee: 'Refusée' } as const;
    return (
      <div className="page-accueil-public">
        <section className="panneau-public panneau-large">
          <MarqueDecodeur sousTitre="Votre demande d’ouverture" />
          <div className="carte formulaire suivi-demande">
            <div className="suivi-demande-entete">
              <h1>{demande.nom_entreprise}</h1>
              <Pastille ton={ton[demande.statut]}>{libelle[demande.statut]}</Pastille>
            </div>
            <Alerte type="succes">{info}</Alerte>
            <Alerte>{erreur}</Alerte>
            {demande.statut === 'en_attente' && (
              <>
                <ol className="etapes-demande">
                  <li className="faite">Accès créés</li>
                  <li className="faite">Fiche de l’entreprise envoyée le {date(demande.soumise_le)}</li>
                  <li className="encours">Étude par Décodeur Financier : nous pouvons vous appeler au {demande.telephone}</li>
                  <li>Ouverture de votre application</li>
                </ol>
                <p className="secondaire">Cette page se met à jour toute seule. Vous pouvez aussi fermer l’application et revenir plus tard.</p>
                <div className="actions-demande">
                  <button type="button" className="bouton bouton-principal" disabled={envoi} onClick={() => void charger()}>
                    ↻ Actualiser
                  </button>
                  <button type="button" className="bouton bouton-discret" onClick={() => preparer(demande)}>
                    Modifier ma demande
                  </button>
                </div>
              </>
            )}
            {demande.statut === 'refusee' && (
              <>
                <Alerte>{`Motif : ${demande.motif ?? '—'}`}</Alerte>
                <p className="secondaire">Vous pouvez corriger les informations et envoyer une nouvelle demande.</p>
                <button type="button" className="bouton bouton-principal" onClick={() => preparer(demande)}>
                  Faire une nouvelle demande
                </button>
              </>
            )}
            {demande.statut === 'validee' && (
              <button type="button" className="bouton bouton-principal bouton-plein" onClick={() => void entrer(demande)}>
                Ouvrir mon application
              </button>
            )}
            {pied}
          </div>
        </section>
      </div>
    );
  }

  // ----- Fiche de l'entreprise -----
  return (
    <div className="page-accueil-public">
      <section className="panneau-public panneau-large">
        <MarqueDecodeur sousTitre="Présentez votre entreprise" />
        <form className="carte formulaire" onSubmit={envoyer}>
          <h1>{demande?.statut === 'ajournee' ? 'Corriger ma demande' : 'Mon entreprise'}</h1>
          <p className="sous-titre">
            Ces informations servent à ouvrir votre espace. Décodeur Financier valide la demande, puis vous en devenez le gérant
            principal : vous créerez ensuite les accès de vos employés.
          </p>
          {demande?.statut === 'ajournee' && <Alerte>{`Correction demandée : ${demande.motif ?? ''}`}</Alerte>}
          <Alerte>{erreur}</Alerte>

          <Champ label="Nom de l’entreprise">
            <input value={f.nom_entreprise} onChange={maj('nom_entreprise')} required minLength={2} maxLength={120} />
          </Champ>
          <Champ label="Activité" aide="Ce que fait l’entreprise : supérette, quincaillerie, pharmacie, restaurant…">
            <input value={f.activite} onChange={maj('activite')} required minLength={2} maxLength={300} />
          </Champ>

          <div className="logo-demande">
            <div className="logo-apercu">{f.logo ? <img src={f.logo} alt="Logo" /> : <span>Pas de logo</span>}</div>
            <div>
              <strong>Logo</strong>
              <p className="secondaire petit-texte">Facultatif : PNG ou JPEG. Il apparaîtra sur vos reçus.</p>
              <input ref={fichierRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void choisirLogo(e.target.files?.[0])} />
              <div className="actions-demande">
                <button type="button" className="bouton bouton-discret" onClick={() => fichierRef.current?.click()}>
                  {f.logo ? 'Changer' : 'Ajouter un logo'}
                </button>
                {f.logo && (
                  <button type="button" className="bouton-lien" onClick={() => setF({ ...f, logo: null })}>
                    Retirer
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="grille-2">
            <Champ label="RCCM" aide="Facultatif : laissez vide si vous n’en avez pas encore">
              <input value={f.rccm ?? ''} onChange={maj('rccm')} maxLength={40} placeholder="CI-ABJ-2024-B-…" />
            </Champ>
            <Champ label="Compte contribuable (NCC)" aide="Facultatif">
              <input value={f.ncc ?? ''} onChange={maj('ncc')} maxLength={20} />
            </Champ>
            <Champ label="Date de création">
              <input type="date" value={f.date_creation ?? ''} onChange={maj('date_creation')} max={new Date().toISOString().slice(0, 10)} />
            </Champ>
            <Champ label="Régime d’imposition">
              <select value={f.regime_fiscal} onChange={maj('regime_fiscal')}>
                {REGIMES.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.libelle}
                  </option>
                ))}
              </select>
            </Champ>
            <Champ label="Nom du gérant principal">
              <input value={f.nom_gerant} onChange={maj('nom_gerant')} required minLength={2} maxLength={120} autoComplete="name" />
            </Champ>
            <Champ label="Téléphone" aide="Pour vous joindre au sujet de la demande">
              <input value={f.telephone} onChange={maj('telephone')} required inputMode="tel" placeholder="07 00 00 00 00" autoComplete="tel" />
            </Champ>
            <Champ label="E-mail de l’entreprise" aide="Facultatif">
              <input type="email" value={f.email_contact ?? ''} onChange={maj('email_contact')} maxLength={200} />
            </Champ>
            <Champ label="Ville">
              <input value={f.ville ?? ''} onChange={maj('ville')} maxLength={80} />
            </Champ>
          </div>
          <Champ label="Adresse">
            <input value={f.adresse ?? ''} onChange={maj('adresse')} maxLength={200} placeholder="Quartier, rue, repère" />
          </Champ>
          <div className="grille-2">
            <Champ label="Nom du premier magasin">
              <input value={f.nom_magasin} onChange={maj('nom_magasin')} required minLength={2} maxLength={80} />
            </Champ>
            <Champ label="Monnaie">
              <ChoixDevise valeur={f.devise} onChange={(d) => setF({ ...f, devise: d })} />
            </Champ>
          </div>
          <fieldset className="sans-bordure">
            <legend className="libelle-champ">Modules souhaités</legend>
            <p className="secondaire petit-texte">Décochez ce dont vous n’avez pas besoin ; vous pourrez changer plus tard.</p>
            <ChoixModules desactives={f.modules_desactives} onChange={(m) => setF({ ...f, modules_desactives: m })} />
          </fieldset>

          <button className="bouton bouton-principal bouton-plein" disabled={envoi}>
            {envoi ? 'Envoi…' : demande?.statut === 'ajournee' ? 'Renvoyer ma demande' : 'Envoyer ma demande'}
          </button>
          {demande && demande.statut === 'en_attente' && (
            <button type="button" className="bouton-lien" onClick={() => setEdition(false)}>
              Annuler la modification
            </button>
          )}
          {pied}
        </form>
      </section>
    </div>
  );
}
