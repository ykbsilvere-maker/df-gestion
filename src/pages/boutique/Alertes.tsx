import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { pontAndroid } from '../../lib/android';
import { Alerte, EnTetePage, Pastille } from '../../components/ui';

/* ------------------------------------------------------------------------------------------
 * Mes notifications : le Telegram de la personne, relié au robot DF Gestion par l'administrateur
 * (gérant principal) ou par la gérante (employés), et les notifications de l'écran du téléphone.
 * ---------------------------------------------------------------------------------------- */

interface MonTelegram {
  robot: string | null;
  relie: boolean;
  telegram: string | null;
  otp: boolean;
  en_attente: boolean;
  ancienne_alerte: boolean;
  gerant: boolean;
}

export function MesAlertes() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const gerante = peut('boutique.administrer') || peut('boutique.affecter');
  const [etat, setEtat] = useState<MonTelegram | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const [permission, setPermission] = useState<string>(() => ('Notification' in window ? Notification.permission : 'indisponible'));
  const android = !!pontAndroid()?.veilleCommandes;

  async function charger() {
    const { data, error } = await supabase.rpc('mon_telegram', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    setEtat(data as MonTelegram);
  }
  useEffect(() => {
    void charger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  async function essai() {
    setErreur('');
    setInfo('');
    setEnvoi(true);
    const { error } = await supabase.rpc('mon_telegram_essai', { p_org: org });
    setEnvoi(false);
    if (error) return setErreur(messageErreur(error));
    setInfo('Message d’essai envoyé : regardez votre Telegram.');
  }
  async function arreterAncienne() {
    const { error } = await supabase.rpc('alerte_whatsapp_supprimer', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    setInfo('Ancienne alerte CallMeBot arrêtée.');
    await charger();
  }

  const recus = gerante
    ? ['Chaque nouvelle commande en ligne', 'Commande acceptée par la caissière', 'Commande prête, en livraison, livrée et encaissée', 'Commande annulée']
    : ['Chaque nouvelle commande en ligne du magasin', 'La commande qui vous est affectée (à accepter)'];
  const qui = etat?.gerant ? 'L’administrateur' : 'La gérante principale';

  return (
    <>
      <EnTetePage titre="🔔 Mes notifications" sousTitre="Les commandes en ligne arrivent sur votre Telegram, au même endroit que vos codes OTP." />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      <section className="carte alertes-carte">
        <h2>✈️ Telegram</h2>
        {!etat ? (
          <p className="secondaire">Chargement…</p>
        ) : etat.relie ? (
          <div className="notif-etat notif-ok">
            <span className="notif-pastille" aria-hidden>✓</span>
            <div>
              <strong>Relié au robot {etat.robot ?? 'DF Gestion'}</strong>
              <span>{etat.telegram ? `Compte ${etat.telegram}` : 'Votre compte Telegram'} · {etat.otp ? '🔐 code OTP à chaque connexion' : 'sans code OTP'}</span>
            </div>
          </div>
        ) : etat.en_attente ? (
          <div className="notif-etat notif-attente">
            <span className="notif-pastille" aria-hidden>…</span>
            <div>
              <strong>Lien d’activation envoyé</strong>
              <span>Ouvrez sur votre téléphone le lien reçu, puis touchez « Démarrer » dans Telegram.</span>
            </div>
          </div>
        ) : (
          <div className="notif-etat notif-non">
            <span className="notif-pastille" aria-hidden>!</span>
            <div>
              <strong>Pas encore relié</strong>
              <span>{qui} relie votre Telegram : vous recevez un lien d’activation, vous l’ouvrez et touchez « Démarrer ». Rien d’autre à régler.</span>
            </div>
          </div>
        )}
        <ul className="notif-liste">
          {recus.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {etat?.relie && (
          <button type="button" className="bouton bouton-discret" disabled={envoi} onClick={() => void essai()}>
            {envoi ? 'Envoi…' : 'Recevoir un message d’essai'}
          </button>
        )}
        {etat?.ancienne_alerte && (
          <p className="secondaire petit">
            Une ancienne alerte CallMeBot est encore active{etat.relie ? ' (elle ne sert plus : le robot la remplace)' : ''}.{' '}
            <button type="button" className="bouton-lien" onClick={() => void arreterAncienne()}>L’arrêter</button>
          </p>
        )}
      </section>

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

    </>
  );
}
