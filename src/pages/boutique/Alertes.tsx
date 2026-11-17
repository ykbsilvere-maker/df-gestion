import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { pontAndroid } from '../../lib/android';
import { Alerte, Champ, EnTetePage, Pastille } from '../../components/ui';

/* ------------------------------------------------------------------------------------------
 * Mes alertes : WhatsApp automatique (CallMeBot) et notifications du téléphone.
 * Chaque personne active ses propres alertes : la gérante pour les nouvelles commandes,
 * la caissière pour les commandes qui lui sont affectées.
 * ---------------------------------------------------------------------------------------- */

interface Etat {
  configuree: boolean;
  telephone?: string;
  actif?: boolean;
  updated_at?: string;
}

export function MesAlertes() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const gerante = peut('boutique.valider');
  const [etat, setEtat] = useState<Etat | null>(null);
  const [tel, setTel] = useState('');
  const [cle, setCle] = useState('');
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [permission, setPermission] = useState<string>(() => ('Notification' in window ? Notification.permission : 'indisponible'));
  const android = !!pontAndroid()?.veilleCommandes;

  async function charger() {
    const { data, error } = await supabase.rpc('alerte_whatsapp_lire', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    const e = data as Etat;
    setEtat(e);
    if (e.telephone) setTel(e.telephone.replace(/^\+225/, ''));
  }
  useEffect(() => {
    void charger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  async function enregistrer(e: FormEvent, actif = true) {
    e.preventDefault();
    setErreur('');
    setInfo('');
    setEnCours(true);
    const { error } = await supabase.rpc('alerte_whatsapp_enregistrer', { p_org: org, p_telephone: tel, p_cle: cle.trim() || null, p_actif: actif });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    setCle('');
    setInfo(actif ? 'Alertes WhatsApp actives. Touchez « Envoyer un essai » pour vérifier.' : 'Alertes WhatsApp en pause.');
    await charger();
  }
  async function tester() {
    setErreur('');
    const { error } = await supabase.rpc('alerte_whatsapp_tester', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    setInfo('Message d’essai envoyé : il arrive sur votre WhatsApp en quelques secondes.');
  }
  async function supprimer() {
    const { error } = await supabase.rpc('alerte_whatsapp_supprimer', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    setTel('');
    setInfo('Alertes WhatsApp supprimées.');
    await charger();
  }

  return (
    <>
      <EnTetePage
        titre="🔔 Mes alertes de commandes"
        sousTitre={gerante
          ? 'Soyez prévenue de chaque nouvelle commande en ligne : sur l’écran du téléphone et par WhatsApp.'
          : 'Soyez prévenue dès qu’une commande vous est affectée : sur l’écran du téléphone et par WhatsApp.'}
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      <section className="carte alertes-carte">
        <h2>📱 Sur l’écran du téléphone</h2>
        {android ? (
          <p>
            <Pastille ton="vert">active</Pastille> L’application vérifie les commandes même fermée (toutes les 15 minutes environ) et affiche la
            notification sur l’écran verrouillé, avec son et vibration. Ouverte, la fenêtre apparaît tout de suite.
          </p>
        ) : permission === 'granted' ? (
          <p><Pastille ton="vert">active</Pastille> Ce navigateur affiche une notification quand une commande arrive, tant que DF Gestion est ouvert.</p>
        ) : permission === 'indisponible' ? (
          <p className="secondaire">Ce navigateur n’affiche pas de notifications. Installez l’application Android DF Gestion pour les recevoir même fermée.</p>
        ) : (
          <button
            type="button"
            className="bouton bouton-principal"
            onClick={() => void Notification.requestPermission().then((p) => setPermission(p)).catch(() => undefined)}
          >
            Autoriser les notifications
          </button>
        )}
        {!android && <p className="secondaire petit">Pour être prévenue application fermée, installez la dernière version de l’APK DF Gestion.</p>}
      </section>

      <section className="carte alertes-carte">
        <h2>
          💬 Par WhatsApp, automatiquement{' '}
          {etat?.configuree && (etat.actif ? <Pastille ton="vert">active</Pastille> : <Pastille ton="gris">en pause</Pastille>)}
        </h2>
        <p className="secondaire">
          {gerante ? 'À chaque nouvelle commande' : 'À chaque commande qui vous est affectée'}, vous recevez un message WhatsApp sur votre
          propre numéro (numéro de commande, total, retrait ou livraison). Le service gratuit CallMeBot envoie le message ; il ne voit
          ni vos clients ni vos codes.
        </p>
        {!etat?.configuree && (
          <ol className="etapes-alerte">
            <li>
              Ouvrez la page <a href="https://www.callmebot.com/blog/free-api-whatsapp-messages/" target="_blank" rel="noreferrer">CallMeBot WhatsApp</a> et
              enregistrez dans vos contacts le numéro du robot indiqué en haut de la page.
            </li>
            <li>Depuis votre WhatsApp, envoyez-lui ce message : <code>I allow callmebot to send me messages</code></li>
            <li>Il vous répond « API Activated… Your APIKEY is 123456 ». Collez cette clé ci-dessous avec votre numéro.</li>
          </ol>
        )}
        <form className="formulaire" onSubmit={(e) => void enregistrer(e)}>
          <div className="grille-2">
            <Champ label="Votre numéro WhatsApp">
              <input value={tel} onChange={(e) => setTel(e.target.value)} inputMode="tel" placeholder="07 57 00 00 00" required />
            </Champ>
            <Champ label={etat?.configuree ? 'Nouvelle clé CallMeBot (facultatif)' : 'Clé CallMeBot (apikey)'} aide="Gardée sur le serveur, jamais affichée.">
              <input value={cle} onChange={(e) => setCle(e.target.value)} inputMode="numeric" autoComplete="off" placeholder={etat?.configuree ? '••••••' : '123456'} required={!etat?.configuree} />
            </Champ>
          </div>
          <div className="actions-piece">
            {etat?.configuree && (
              <>
                <button type="button" className="bouton-lien lien-danger" onClick={() => void supprimer()}>Supprimer</button>
                {etat.actif ? (
                  <button type="button" className="bouton bouton-discret" onClick={(e) => void enregistrer(e as unknown as FormEvent, false)}>Mettre en pause</button>
                ) : null}
                <button type="button" className="bouton bouton-discret" onClick={() => void tester()}>Envoyer un essai</button>
              </>
            )}
            <button className="bouton bouton-principal" disabled={enCours}>{etat?.configuree ? (etat.actif ? 'Enregistrer' : 'Réactiver') : 'Activer les alertes WhatsApp'}</button>
          </div>
        </form>
      </section>
    </>
  );
}
