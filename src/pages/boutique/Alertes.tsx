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
  telephone?: string | null;
  whatsapp?: boolean;
  telegram?: string | null;
  actif?: boolean;
  updated_at?: string;
}
interface Resultat {
  recu: boolean;
  statut?: number | null;
  erreur?: string | null;
  texte?: string;
}

/** Lecture simple de la réponse du service d'envoi. */
function verdict(r: Resultat): { ok: boolean | null; texte: string } {
  if (!r.recu) return { ok: r.erreur ? false : null, texte: r.erreur || 'En attente de la réponse du service…' };
  if (r.erreur) return { ok: false, texte: r.erreur };
  const t = (r.texte || '').trim();
  const mauvais = /error|invalid|not\s+(allowed|authori[sz]ed|registered|found)|wrong|blocked|unauthori[sz]ed|limit|full/i.test(t);
  if (Number(r.statut) >= 400 || mauvais) return { ok: false, texte: t || `Réponse ${r.statut}` };
  return { ok: true, texte: t || 'Message accepté par le service.' };
}

export function MesAlertes() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const gerante = peut('boutique.valider');
  const [etat, setEtat] = useState<Etat | null>(null);
  const [tel, setTel] = useState('');
  const [cle, setCle] = useState('');
  const [telegram, setTelegram] = useState('');
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [resultats, setResultats] = useState<Resultat[] | null>(null);
  const [permission, setPermission] = useState<string>(() => ('Notification' in window ? Notification.permission : 'indisponible'));
  const android = !!pontAndroid()?.veilleCommandes;

  async function charger() {
    const { data, error } = await supabase.rpc('alerte_whatsapp_lire', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    const e = data as Etat;
    setEtat(e);
    setTel(e.telephone ? e.telephone.replace(/^\+225/, '') : '');
    setTelegram(e.telegram ?? '');
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
    const { error } = await supabase.rpc('alerte_whatsapp_enregistrer', {
      p_org: org, p_telephone: tel, p_cle: cle.trim() || null, p_actif: actif, p_telegram: telegram.trim() || null,
    });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    setCle('');
    setInfo(actif ? 'Alertes enregistrées. Touchez « Envoyer un essai » : le résultat réel s’affiche ici.' : 'Alertes en pause.');
    await charger();
  }
  async function tester() {
    setErreur('');
    setInfo('');
    setResultats([]);
    const { error } = await supabase.rpc('alerte_whatsapp_tester', { p_org: org });
    if (error) {
      setResultats(null);
      return setErreur(messageErreur(error));
    }
    // La réponse du service arrive en quelques secondes : on la relit.
    for (const attente of [2500, 3500, 5000]) {
      await new Promise((ok) => window.setTimeout(ok, attente));
      const { data } = await supabase.rpc('alerte_resultat', { p_org: org });
      const r = (data as Resultat[]) ?? [];
      setResultats(r);
      if (r.length && r.every((x) => x.recu || x.erreur)) break;
    }
  }
  async function supprimer() {
    const { error } = await supabase.rpc('alerte_whatsapp_supprimer', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    setTel('');
    setTelegram('');
    setResultats(null);
    setInfo('Alertes supprimées.');
    await charger();
  }

  const canaux = [etat?.whatsapp ? 'WhatsApp' : '', etat?.telegram ? 'Telegram' : ''].filter(Boolean);

  return (
    <>
      <EnTetePage
        titre="🔔 Mes alertes de commandes"
        sousTitre={gerante
          ? 'Soyez prévenue de chaque nouvelle commande et de chaque livraison prête : sur l’écran du téléphone et par message.'
          : 'Soyez prévenue dès qu’une commande vous est affectée : sur l’écran du téléphone et par message.'}
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
          💬 Message automatique{' '}
          {etat?.configuree && (etat.actif ? <Pastille ton="vert">actif · {canaux.join(' + ')}</Pastille> : <Pastille ton="gris">en pause</Pastille>)}
        </h2>
        <p className="secondaire">
          {gerante ? 'À chaque nouvelle commande et à chaque livraison prête' : 'À chaque commande qui vous est affectée'}, vous recevez un
          message sur votre téléphone (numéro de commande, total, retrait ou livraison). Le service gratuit CallMeBot l’envoie ; il ne voit
          ni vos clients ni vos codes.
        </p>
        <p className="note-alerte">
          ⚠️ Le robot <b>WhatsApp</b> gratuit de CallMeBot est <b>complet</b> : il n’accepte plus de nouvelles inscriptions pour le moment,
          c’est pourquoi aucune clé n’arrive. Utilisez <b>Telegram</b> (gratuit, 1 minute). Une clé WhatsApp déjà obtenue continue de fonctionner.
        </p>
        <form className="formulaire" onSubmit={(e) => void enregistrer(e)}>
          <h3 className="alerte-canal">✈️ Telegram <span className="secondaire">(recommandé)</span></h3>
          <ol className="etapes-alerte">
            <li>Installez Telegram et choisissez un <b>nom d’utilisateur</b> (Paramètres → Nom d’utilisateur, par exemple @awa_kone).</li>
            <li>
              Ouvrez le robot <a href="https://t.me/CallMeBot_txtbot" target="_blank" rel="noreferrer">@CallMeBot_txtbot</a> et envoyez-lui{' '}
              <code>/start</code> : il a alors le droit de vous écrire.
            </li>
            <li>Indiquez votre nom d’utilisateur ci-dessous, enregistrez, puis touchez « Envoyer un essai ».</li>
          </ol>
          <Champ label="Votre nom d’utilisateur Telegram">
            <input value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="@awa_kone" autoComplete="off" autoCapitalize="none" />
          </Champ>

          <details className="alerte-whatsapp" open={!!etat?.whatsapp}>
            <summary>💬 WhatsApp — si vous avez déjà une clé CallMeBot</summary>
            <div className="grille-2">
              <Champ label="Votre numéro WhatsApp">
                <input value={tel} onChange={(e) => setTel(e.target.value)} inputMode="tel" placeholder="07 57 00 00 00" />
              </Champ>
              <Champ label={etat?.whatsapp ? 'Nouvelle clé CallMeBot (facultatif)' : 'Clé CallMeBot (apikey)'} aide="Gardée sur le serveur, jamais affichée.">
                <input value={cle} onChange={(e) => setCle(e.target.value)} inputMode="numeric" autoComplete="off" placeholder={etat?.whatsapp ? '••••••' : '123456'} />
              </Champ>
            </div>
            <p className="secondaire petit">
              Clé obtenue en envoyant « I allow callmebot to send me messages » au robot indiqué sur{' '}
              <a href="https://www.callmebot.com/blog/free-api-whatsapp-messages/" target="_blank" rel="noreferrer">callmebot.com</a>, quand des places sont libres.
            </p>
          </details>

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
            <button className="bouton bouton-principal" disabled={enCours}>{etat?.configuree ? (etat.actif ? 'Enregistrer' : 'Réactiver') : 'Activer les alertes'}</button>
          </div>
        </form>
        {resultats && (
          <div className="resultat-essai" aria-live="polite">
            <strong>Résultat de l’essai</strong>
            {resultats.length === 0 ? (
              <p className="secondaire">Envoi en cours…</p>
            ) : (
              <ul>
                {resultats.map((r, i) => {
                  const v = verdict(r);
                  return (
                    <li key={i} className={v.ok === true ? 'ok' : v.ok === false ? 'ko' : ''}>
                      {v.ok === true ? '✅' : v.ok === false ? '❌' : '⏳'} {v.texte}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="secondaire petit">Rien reçu malgré ✅ ? Vérifiez que vous avez bien envoyé /start au robot Telegram (ou activé WhatsApp) avec ce même compte.</p>
          </div>
        )}
      </section>
    </>
  );
}
