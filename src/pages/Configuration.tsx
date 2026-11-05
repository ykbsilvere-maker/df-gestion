import { useState, type FormEvent } from 'react';
import { Alerte, Champ } from '../components/ui';
import { MarqueDecodeur } from '../components/Marque';
import { Scanner } from '../components/Scanner';
import {
  decoderCode,
  effacerConfiguration,
  enregistrerConfiguration,
  lireConfiguration,
  verifierConfiguration,
  type ConfigServeur,
} from '../lib/config';

type Mode = 'code' | 'qr' | 'manuel';

/**
 * Premier lancement (APK ou site sans fichier de configuration) : on indique une fois
 * l'adresse du serveur, en scannant le QR code de l'administrateur, en collant le code
 * reçu (WhatsApp, SMS) ou en saisissant l'adresse et la clé publique.
 */
export function Configuration({ retour }: { retour?: () => void }) {
  const actuelle = lireConfiguration();
  const [mode, setMode] = useState<Mode>('code');
  const [code, setCode] = useState('');
  const [url, setUrl] = useState(actuelle?.url ?? '');
  const [cle, setCle] = useState('');
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);

  async function appliquer(c: ConfigServeur | null) {
    setErreur('');
    if (!c) return setErreur('Code ou informations illisibles : vérifiez ce que vous avez copié.');
    setEnvoi(true);
    const probleme = await verifierConfiguration(c);
    setEnvoi(false);
    if (probleme) return setErreur(probleme);
    enregistrerConfiguration(c);
    window.location.replace('/');
  }

  function soumettre(e: FormEvent) {
    e.preventDefault();
    if (mode === 'code') void appliquer(decoderCode(code));
    else void appliquer({ url: url.trim().replace(/\/+$/, ''), cle: cle.trim() });
  }

  return (
    <div className="page-accueil-public">
      <section className="panneau-public">
        <MarqueDecodeur sousTitre="Configuration de l’application" />

        <form className="carte formulaire" onSubmit={soumettre}>
          <h1>Configurer l’application</h1>
          <p className="sous-titre">
            À faire une seule fois sur cet appareil. Demandez le code ou le QR code à votre administrateur (menu
            Administration de son application).
          </p>
          <div className="onglets onglets-compacts" role="tablist">
            {(
              [
                ['code', 'Coller le code'],
                ['qr', 'Scanner le QR code'],
                ['manuel', 'Adresse et clé'],
              ] as [Mode, string][]
            ).map(([m, libelle]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                className={mode === m ? 'actif' : ''}
                onClick={() => {
                  setMode(m);
                  setErreur('');
                }}
              >
                {libelle}
              </button>
            ))}
          </div>
          <Alerte>{erreur}</Alerte>

          {mode === 'code' && (
            <Champ label="Code de configuration" aide="Il commence par DFG1. Collez tout le message si besoin : le code y est retrouvé.">
              <textarea rows={4} value={code} onChange={(e) => setCode(e.target.value)} autoFocus spellCheck={false} />
            </Champ>
          )}
          {mode === 'qr' && <Scanner qr onFermer={() => setMode('code')} onCode={(texte) => void appliquer(decoderCode(texte))} />}
          {mode === 'manuel' && (
            <>
              <Champ label="Adresse du projet Supabase" aide="Supabase > Project Settings > API : « Project URL ».">
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" inputMode="url" autoCapitalize="none" spellCheck={false} />
              </Champ>
              <Champ label="Clé publique (anon ou publishable)" aide="Jamais la clé secrète « service_role ».">
                <textarea rows={3} value={cle} onChange={(e) => setCle(e.target.value)} spellCheck={false} autoCapitalize="none" />
              </Champ>
            </>
          )}

          {mode !== 'qr' && (
            <button className="bouton bouton-principal bouton-plein" disabled={envoi}>
              {envoi ? 'Vérification…' : 'Enregistrer et continuer'}
            </button>
          )}
          <div className="liens-formulaire">
            {retour && (
              <button type="button" className="bouton-lien" onClick={retour}>
                Annuler
              </button>
            )}
            {actuelle?.source === 'appareil' && (
              <button
                type="button"
                className="bouton-lien lien-danger"
                onClick={() => {
                  effacerConfiguration();
                  window.location.replace('/');
                }}
              >
                Oublier le serveur actuel
              </button>
            )}
          </div>
        </form>
        {actuelle && <p className="note-publique">Serveur actuel : {actuelle.url}</p>}
      </section>
    </div>
  );
}
