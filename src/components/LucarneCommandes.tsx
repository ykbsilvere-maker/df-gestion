import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
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

type Etat = { nombre: number; a_affecter: number; gerante: boolean };

/**
 * Petite fenêtre « Vous avez N commandes en ligne », à l'ouverture de l'application et à chaque
 * nouvelle commande : pour la gérante, les commandes à affecter ; pour la caissière, celles qui
 * lui sont affectées (à rassembler et vérifier). Son, vibration et notification du téléphone.
 */
export function LucarneCommandes({ org, actif }: { org: string | undefined; actif: boolean }) {
  const [etat, setEtat] = useState<Etat | null>(null);
  const [visible, setVisible] = useState(false);
  const [sortie, setSortie] = useState(false);
  const precedent = useRef<number | null>(null);
  const minuteur = useRef<number | undefined>(undefined);
  const naviguer = useNavigate();

  const total = (e: Etat | null) => (e ? (e.gerante ? Number(e.a_affecter) : 0) + Number(e.nombre) : 0);

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
      const n = total(e);
      const avant = precedent.current;
      precedent.current = n;
      setEtat(e);
      const texte = e.gerante && Number(e.a_affecter) > 0
        ? `${e.a_affecter} commande${Number(e.a_affecter) > 1 ? 's' : ''} à affecter à une caissière`
        : `${e.nombre} commande${Number(e.nombre) > 1 ? 's' : ''} à rassembler et vérifier`;
      // À l'ouverture de l'application : la fenêtre s'affiche s'il y a des commandes.
      if (avant === null && n > 0) {
        montrer();
        pontAndroid()?.notifier?.('Commandes en ligne', `Vous avez ${texte}.`, n);
      } else if (avant !== null && n > avant) {
        montrer();
        son();
        navigator.vibrate?.([140, 90, 140]);
        pontAndroid()?.notifier?.('Nouvelle commande en ligne', `Vous avez ${texte}.`, n);
        try {
          if (!pontAndroid() && 'Notification' in window && Notification.permission === 'granted' && document.hidden)
            new Notification('DF Gestion — commande en ligne', { body: `Vous avez ${texte}.`, icon: '/icone-192.png' });
        } catch {
          /* notifications indisponibles */
        }
      } else if (n === 0 && avant) {
        pontAndroid()?.notifier?.('', '', 0);
      }
    };
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

  if (!visible || !etat || total(etat) === 0) return null;
  const aAffecter = etat.gerante ? Number(etat.a_affecter) : 0;
  const miennes = Number(etat.nombre);
  const n = total(etat);
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
              : `Veuillez rassembler et vérifier ${miennes > 1 ? 'les articles de ces commandes' : 'les articles de la commande'}.`}
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
