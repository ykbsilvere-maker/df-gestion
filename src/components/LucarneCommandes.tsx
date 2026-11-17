import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { lireConfiguration } from '../lib/config';
import { pontAndroid } from '../lib/android';

/** Deux notes douces, comme une messagerie. */
function son() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [988, 1319].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.36);
    });
    window.setTimeout(() => void ctx.close(), 1200);
  } catch {
    /* son indisponible */
  }
}

type Etat = { nombre: number; a_affecter: number; en_attente?: number; gerante: boolean };
type Compteurs = { nombre: number; a_affecter: number; en_attente: number };

/** Jeton de ce téléphone : l'APK interroge le serveur toutes les 15 minutes, même fermée. */
function jetonAppareil(): string {
  const cle = 'dfg_jeton_appareil';
  try {
    let j = localStorage.getItem(cle);
    if (!j) {
      const o = new Uint8Array(24);
      crypto.getRandomValues(o);
      j = Array.from(o, (x) => x.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(cle, j);
    }
    return j;
  } catch {
    return '';
  }
}

/** Ce qui doit être signalé, selon le rôle. */
function lecture(e: Etat) {
  const c: Compteurs = { nombre: Number(e.nombre) || 0, a_affecter: e.gerante ? Number(e.a_affecter) || 0 : 0, en_attente: e.gerante ? 0 : Number(e.en_attente) || 0 };
  const total = c.nombre + c.a_affecter + c.en_attente;
  return { c, total };
}

/**
 * Petite fenêtre « Vous avez N commandes en ligne », à l'ouverture de l'application et à chaque
 * nouvelle commande : pour la gérante, les commandes à affecter ; pour la caissière, celles qui
 * lui sont affectées (à rassembler et vérifier). Son, vibration et notification du téléphone.
 */
export function LucarneCommandes({ org, actif }: { org: string | undefined; actif: boolean }) {
  const [etat, setEtat] = useState<Etat | null>(null);
  const [visible, setVisible] = useState(false);
  const [sortie, setSortie] = useState(false);
  const precedent = useRef<Compteurs | null>(null);
  const minuteur = useRef<number | undefined>(undefined);
  const naviguer = useNavigate();


  const montrer = () => {
    setSortie(false);
    setVisible(true);
    window.clearTimeout(minuteur.current);
    minuteur.current = window.setTimeout(() => fermer(), 14000);
  };
  const fermer = () => {
    setSortie(true);
    window.setTimeout(() => setVisible(false), 260);
  };

  useEffect(() => {
    if (!org || !actif) return;
    let arret = false;
    precedent.current = null;
    const lire = async () => {
      const { data, error } = await supabase.rpc('commandes_caisse_attente', { p_org: org });
      if (arret || error || !data) return;
      const e = data as Etat;
      const { c, total } = lecture(e);
      const avant = precedent.current;
      precedent.current = c;
      setEtat(e);
      const pluriel = (n: number) => (n > 1 ? 's' : '');
      // Ce qui a changé, du plus important au moins important.
      const texte = c.nombre > (avant?.nombre ?? 0) || (avant === null && c.nombre > 0)
        ? `${c.nombre} commande${pluriel(c.nombre)} affectée${pluriel(c.nombre)} à vous : rassemblez et vérifiez les articles`
        : c.a_affecter > 0
          ? `${c.a_affecter} commande${pluriel(c.a_affecter)} à affecter à une caissière`
          : c.en_attente > 0
            ? `${c.en_attente} nouvelle${pluriel(c.en_attente)} commande${pluriel(c.en_attente)} en ligne, en attente d’affectation`
            : `${c.nombre} commande${pluriel(c.nombre)} à rassembler et vérifier`;
      const hausse = avant !== null && (c.nombre > avant.nombre || c.a_affecter > avant.a_affecter || c.en_attente > avant.en_attente);
      // À l'ouverture de l'application (et de la caisse) : la fenêtre s'affiche s'il y a des commandes.
      if (avant === null && total > 0) {
        montrer();
        pontAndroid()?.notifier?.('Commandes en ligne', `Vous avez ${texte}.`, total);
      } else if (hausse) {
        montrer();
        son();
        navigator.vibrate?.([140, 90, 140]);
        pontAndroid()?.notifier?.('Nouvelle commande en ligne', `Vous avez ${texte}.`, total);
        try {
          if (!pontAndroid() && 'Notification' in window && Notification.permission === 'granted' && document.hidden)
            new Notification('DF Gestion — commande en ligne', { body: `Vous avez ${texte}.`, icon: '/icone-192.png' });
        } catch {
          /* notifications indisponibles */
        }
      } else if (total === 0 && avant && avant.nombre + avant.a_affecter + avant.en_attente > 0) {
        pontAndroid()?.notifier?.('', '', 0);
      }
    };
    // Téléphone Android : vérification en arrière-plan, même application fermée.
    const pont = pontAndroid();
    const conf = lireConfiguration();
    const jeton = pont?.veilleCommandes ? jetonAppareil() : '';
    if (pont?.veilleCommandes && conf && jeton)
      void supabase.rpc('enregistrer_appareil', { p_org: org, p_jeton: jeton }).then(({ error }) => {
        if (!error) pont.veilleCommandes!(conf.url, conf.cle, jeton);
      });
    void lire();
    const id = window.setInterval(() => void lire(), 20000);
    const auRetour = () => document.visibilityState === 'visible' && void lire();
    document.addEventListener('visibilitychange', auRetour);
    try {
      if (!pontAndroid() && 'Notification' in window && Notification.permission === 'default')
        void Notification.requestPermission().catch(() => undefined);
    } catch {
      /* rien */
    }
    return () => {
      arret = true;
      window.clearInterval(id);
      window.clearTimeout(minuteur.current);
      document.removeEventListener('visibilitychange', auRetour);
    };
  }, [org, actif]);

  if (!visible || !etat) return null;
  const { c, total: n } = lecture(etat);
  if (n === 0) return null;
  const aAffecter = c.a_affecter;
  const miennes = c.nombre;
  const ouvrir = () => {
    fermer();
    naviguer(aAffecter > 0 ? '/boutique' : '/caisse?commandes=1');
  };

  return (
    <div className={`lucarne ${sortie ? 'lucarne-sortie' : ''}`} role="alert" aria-live="assertive">
      <button type="button" className="lucarne-corps" onClick={ouvrir}>
        <span className="lucarne-icone" aria-hidden>
          🛍️<span className="lucarne-pastille">{n}</span>
        </span>
        <span className="lucarne-texte">
          <span className="lucarne-entete">
            <strong>DF Gestion</strong> · maintenant
          </span>
          <span className="lucarne-titre">
            Vous avez {n} commande{n > 1 ? 's' : ''} en ligne
          </span>
          <span className="lucarne-detail">
            {aAffecter > 0
              ? `${aAffecter} à affecter : choisissez la caissière qui la rassemble.`
              : miennes > 0
                ? `Veuillez rassembler et vérifier ${miennes > 1 ? 'les articles de ces commandes' : 'les articles de la commande'}.`
                : 'La gérante va l’affecter : vous serez prévenue dès qu’elle vous est confiée.'}
            {aAffecter > 0 && miennes > 0 && ` ${miennes} vous ${miennes > 1 ? 'sont affectées' : 'est affectée'}.`}
          </span>
        </span>
      </button>
      <div className="lucarne-actions">
        <button type="button" onClick={fermer}>
          Plus tard
        </button>
        <button type="button" className="lucarne-voir" onClick={ouvrir}>
          {aAffecter > 0 ? 'Affecter' : 'Voir'}
        </button>
      </div>
    </div>
  );
}
