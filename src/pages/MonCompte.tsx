import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur, nomAppareil } from '../lib/format';
import { Alerte, Champ, EnTetePage, Pastille } from '../components/ui';
import { estAccesEmploye, identifiantAffiche } from '../lib/acces';

export function MonCompte() {
  const { session, organisations, codeEntreeDefini } = useSession();
  const naviguer = useNavigate();
  const [nom, setNom] = useState('');
  const [telephone, setTelephone] = useState('');
  const [appareil, setAppareil] = useState(nomAppareil());
  const [mdp, setMdp] = useState('');
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const uid = session?.user.id;

  useEffect(() => {
    if (!uid) return;
    void supabase
      .from('profils')
      .select('nom_complet, telephone')
      .eq('id', uid)
      .single()
      .then(({ data }) => {
        setNom(data?.nom_complet ?? '');
        setTelephone(data?.telephone ?? '');
      });
  }, [uid]);

  async function enregistrerProfil(e: FormEvent) {
    e.preventDefault();
    setErreur('');
    setInfo('');
    const { error } = await supabase
      .from('profils')
      .update({ nom_complet: nom.trim() || null, telephone: telephone.trim() || null })
      .eq('id', uid!);
    try {
      localStorage.setItem('dfg_appareil', appareil.trim() || 'Navigateur');
    } catch {
      /* stockage indisponible */
    }
    if (error) setErreur(messageErreur(error));
    else setInfo('Profil enregistré.');
  }

  async function changerMotDePasse(e: FormEvent) {
    e.preventDefault();
    setErreur('');
    setInfo('');
    const minimum = estAccesEmploye(session?.user.email) ? 6 : 8;
    if (mdp.length < minimum) return setErreur(`Au moins ${minimum} caractères.`);
    const { error } = await supabase.auth.updateUser({ password: mdp });
    if (error) return setErreur(messageErreur(error));
    setMdp('');
    setInfo('Mot de passe modifié.');
  }

  return (
    <>
      <EnTetePage icone="👤" titre="Mon compte" sousTitre={identifiantAffiche(session?.user.email)} />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      <div className="grille-accueil">
        <form className="carte formulaire" onSubmit={enregistrerProfil}>
          <h2>Profil</h2>
          <Champ label="Nom et prénoms">
            <input value={nom} onChange={(e) => setNom(e.target.value)} />
          </Champ>
          <Champ label="Téléphone">
            <input value={telephone} onChange={(e) => setTelephone(e.target.value)} inputMode="tel" />
          </Champ>
          <Champ label="Nom de cet appareil" aide="Apparaît dans le journal des connexions (ex. Tablette caisse 1)">
            <input value={appareil} onChange={(e) => setAppareil(e.target.value)} maxLength={60} />
          </Champ>
          <button className="bouton bouton-principal">Enregistrer</button>
        </form>

        <section className="carte formulaire">
          <h2>🔢 Code d’entrée</h2>
          <p className="secondaire">
            4 chiffres, comme sur Wave. Il ouvre l’application à la connexion
            {estAccesEmploye(session?.user.email) ? '' : ' (pour les employés par matricule)'} et la déverrouille après 5 minutes sans activité.
          </p>
          <p>{codeEntreeDefini ? <Pastille ton="vert">Code d’entrée défini</Pastille> : <Pastille ton="or">Pas encore de code</Pastille>}</p>
          <button type="button" className="bouton bouton-principal" onClick={() => naviguer('/choisir-code')}>
            {codeEntreeDefini ? 'Modifier mon code' : 'Créer mon code'}
          </button>
        </section>

        {!estAccesEmploye(session?.user.email) && (
          <form className="carte formulaire" onSubmit={changerMotDePasse}>
            <h2>Mot de passe</h2>
            <Champ label="Nouveau mot de passe" aide="8 caractères minimum">
              <input type="password" value={mdp} onChange={(e) => setMdp(e.target.value)} autoComplete="new-password" />
            </Champ>
            <button className="bouton bouton-principal">Modifier</button>
          </form>
        )}

        <section className="carte">
          <h2>Mes entreprises</h2>
          <ul className="liste-simple">
            {organisations.map((o) => (
              <li key={o.organisation_id}>
                <span>{o.nom}</span>
                <span className="secondaire">{o.role_libelle}</span>
              </li>
            ))}
          </ul>
          <button className="bouton bouton-discret" onClick={() => naviguer('/creer-entreprise')}>
            Créer une autre entreprise
          </button>
        </section>
      </div>
    </>
  );
}
