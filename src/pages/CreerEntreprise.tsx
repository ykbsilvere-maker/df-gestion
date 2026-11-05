import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';
import { REGIMES, type RegimeFiscal } from '../lib/types';
import { ChoixDevise } from '../components/ChoixDevise';
import { Alerte, Champ } from '../components/ui';
import { ChoixModules } from '../components/ChoixModules';
import { identifiantAffiche } from '../lib/acces';

export function CreerEntreprise() {
  const { rechargerOrganisations, choisirOrganisation, deconnecter, organisations, plateforme, rechargerPlateforme, session, adminGeneral } =
    useSession();
  const naviguer = useNavigate();
  const [f, setF] = useState({
    nom: '',
    ncc: '',
    regime: 'non_precise' as RegimeFiscal,
    telephone: '',
    ville: 'Abidjan',
    adresse: '',
    magasin: 'Magasin principal',
    devise: 'XOF',
  });
  const [desactives, setDesactives] = useState<string[]>([]);
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const maj = (cle: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [cle]: e.target.value });

  async function devenirAdmin() {
    setEnvoi(true);
    setErreur('');
    const { error } = await supabase.rpc('devenir_admin_general');
    if (error) {
      setEnvoi(false);
      return setErreur(messageErreur(error));
    }
    await rechargerPlateforme();
    await rechargerOrganisations().catch(() => undefined);
    naviguer('/administration');
  }

  async function reessayer() {
    setEnvoi(true);
    await supabase.rpc('accepter_invitations').then(undefined, () => undefined);
    await rechargerOrganisations().catch(() => undefined);
    setEnvoi(false);
    naviguer('/');
  }

  // L'administrateur général sans entreprise travaille depuis sa console.
  if (adminGeneral && organisations.length === 0) return <Navigate to="/administration" replace />;

  if (!plateforme) {
    return (
      <div className="chargement" role="status">
        Chargement…
      </div>
    );
  }

  if (!plateforme.creation_entreprise_possible) {
    return (
      <div className="page-accueil-public">
        <section className="panneau-public">
          <div className="carte formulaire">
            <h1>Aucune entreprise active</h1>
            <p>
              Votre compte ({identifiantAffiche(session?.user.email)}) n’est rattaché à aucune entreprise active. Votre accès est créé par le gérant de
              votre entreprise ou par l’administrateur : vérifiez avec lui l’adresse e-mail qu’il a utilisée, ou si l’entreprise
              est suspendue.
            </p>
            <Alerte>{erreur}</Alerte>
            <button type="button" className="bouton bouton-principal bouton-plein" disabled={envoi} onClick={() => void reessayer()}>
              Réessayer
            </button>
            <div className="liens-formulaire">
              <button type="button" className="bouton-lien" onClick={() => void deconnecter()}>
                Se déconnecter
              </button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    if (envoi) return;
    setEnvoi(true);
    setErreur('');
    const { data, error } = await supabase.rpc('creer_organisation', {
      p_nom: f.nom,
      p_ncc: f.ncc || null,
      p_regime_fiscal: f.regime,
      p_telephone: f.telephone || null,
      p_adresse: f.adresse || null,
      p_ville: f.ville || null,
      p_nom_magasin: f.magasin,
      p_devise: f.devise,
    });
    if (error) {
      setEnvoi(false);
      return setErreur(messageErreur(error));
    }
    if (desactives.length) {
      const r = await supabase.rpc('definir_modules', { p_org: data as string, p_desactives: desactives });
      if (r.error) setErreur(`Entreprise créée, mais les modules n’ont pas été enregistrés : ${messageErreur(r.error)}`);
    }
    await rechargerOrganisations();
    choisirOrganisation(data as string);
    naviguer('/');
  }

  return (
    <div className="page-accueil-public">
      <section className="panneau-public panneau-large">
        {!plateforme.admin_existe && (
          <div className="carte formulaire premiere-installation">
            <h1>Première installation</h1>
            <p>
              Aucun administrateur général n’est encore désigné sur cette installation. Si c’est vous qui la gérez, devenez-le
              maintenant : vous créerez ensuite les entreprises de vos clients et l’accès de leurs gérants, et vous verrez toutes
              leurs informations.
            </p>
            <button type="button" className="bouton bouton-principal bouton-plein" disabled={envoi} onClick={() => void devenirAdmin()}>
              Devenir administrateur général
            </button>
          </div>
        )}
        <form className="carte formulaire" onSubmit={soumettre}>
          <h1>Créer mon entreprise</h1>
          <p className="sous-titre">
            Vous en serez le propriétaire. Un premier magasin et une première caisse sont créés automatiquement.
          </p>
          <Alerte>{erreur}</Alerte>
          <Champ label="Nom de l’entreprise">
            <input value={f.nom} onChange={maj('nom')} required minLength={2} maxLength={120} />
          </Champ>
          <div className="grille-2">
            <Champ label="Numéro de compte contribuable (NCC)" aide="Facultatif">
              <input value={f.ncc} onChange={maj('ncc')} maxLength={20} />
            </Champ>
            <Champ label="Régime d’imposition">
              <select value={f.regime} onChange={maj('regime')}>
                {REGIMES.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.libelle}
                  </option>
                ))}
              </select>
            </Champ>
            <Champ label="Téléphone">
              <input value={f.telephone} onChange={maj('telephone')} inputMode="tel" placeholder="+225 07 00 00 00 00" />
            </Champ>
            <Champ label="Ville">
              <input value={f.ville} onChange={maj('ville')} />
            </Champ>
          </div>
          <Champ label="Adresse">
            <input value={f.adresse} onChange={maj('adresse')} placeholder="Quartier, rue, repère" />
          </Champ>
          <Champ label="Monnaie" aide="XOF par défaut. Modifiable tant qu’aucun article n’est créé.">
            <ChoixDevise valeur={f.devise} onChange={(d) => setF({ ...f, devise: d })} />
          </Champ>
          <Champ label="Nom du premier magasin">
            <input value={f.magasin} onChange={maj('magasin')} required minLength={2} />
          </Champ>
          <fieldset className="sans-bordure">
            <legend className="libelle-champ">Modules à utiliser</legend>
            <p className="secondaire">Décochez ce dont vous n’avez pas besoin ; vous pourrez les activer plus tard dans Personnalisation.</p>
            <ChoixModules desactives={desactives} onChange={setDesactives} />
          </fieldset>
          <button className="bouton bouton-principal bouton-plein" disabled={envoi}>
            {envoi ? 'Création…' : 'Créer l’entreprise'}
          </button>
          <div className="liens-formulaire">
            {organisations.length > 0 ? (
              <button type="button" className="bouton-lien" onClick={() => naviguer('/')}>
                Annuler
              </button>
            ) : (
              <button type="button" className="bouton-lien" onClick={() => void deconnecter()}>
                Se déconnecter
              </button>
            )}
          </div>
        </form>
        <p className="note-publique">
          Vous travaillez pour une entreprise déjà inscrite ? Demandez à son gérant de vous inviter avec votre
          adresse e-mail, puis reconnectez-vous.
        </p>
      </section>
    </div>
  );
}
