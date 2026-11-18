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

type AAccepter = { id: string; numero: string; mode: 'retrait' | 'livraison'; client: string };
type Etat = {
  nombre: number;
  a_affecter: number;
  en_attente?: number;
  a_accepter?: number;
  a_accepter_liste?: AAccepter[];
  a_livrer?: number;
  gerante: boolean;
};
type Compteurs = { nombre: number; a_affecter: number; en_attente: number; a_accepter: number; a_livrer: number };

/** Une commande affectée et pas encore acceptée revient toutes les 2 minutes. */
const RAPPEL_MS = 120000;

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
  const n = (v: unknown) => Number(v) || 0;
  const c: Compteurs = {
    nombre: n(e.nombre),
    a_affecter: e.gerante ? n(e.a_affecter) : 0,
    en_attente: e.gerante ? 0 : n(e.en_attente),
    a_accepter: n(e.a_accepter),
    a_livrer: e.gerante ? n(e.a_livrer) : 0,
  };
  const total = c.nombre + c.a_affecter + c.en_attente + c.a_livrer;
  return { c, total };
}

const pluriel = (n: number) => (n > 1 ? 's' : '');

/**
 * Fenêtre « comme une messagerie », en haut de l'écran.
 * - Gérante : nouvelles commandes à affecter, livraisons prêtes à confirmer.
 * - Caissière : nouvelle commande en ligne (simple information) ; commande qui lui est affectée :
 *   la fenêtre revient toutes les 2 minutes, avec son et vibration, tant qu'elle n'a pas touché « Accepter ».
 */
export function LucarneCommandes({ org, actif }: { org: string | undefined; actif: boolean }) {
  const [etat, setEtat] = useState<Etat | null>(null);
  const [visible, setVisible] = useState(false);
  const [sortie, setSortie] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const precedent = useRef<Compteurs | null>(null);
  const minuteur = useRef<number | undefined>(undefined);
  const visibleRef = useRef(false);
  const prochainRappel = useRef(0);
  const naviguer = useNavigate();

  const alerter = (titre: string, texte: string, total: number) => {
    son();
    navigator.vibrate?.([180, 90, 180, 90, 180]);
    pontAndroid()?.notifier?.(titre, texte, total);
    try {
      if (!pontAndroid() && 'Notification' in window && Notification.permission === 'granted' && document.hidden)
        new Notification(`DF Gestion — ${titre}`, { body: texte, icon: '/icone-192.png' });
    } catch {
      /* notifications indisponibles */
    }
  };
  const montrer = (persistante: boolean) => {
    setSortie(false);
    setVisible(true);
    visibleRef.current = true;
    window.clearTimeout(minuteur.current);
    if (!persistante) minuteur.current = window.setTimeout(() => fermer(), 15000);
  };
  const fermer = () => {
    window.clearTimeout(minuteur.current);
    visibleRef.current = false;
    setSortie(true);
    window.setTimeout(() => setVisible(false), 260);
  };

  const lireRef = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    if (!org || !actif) return;
    let arret = false;
    precedent.current = null;
    prochainRappel.current = 0;
    const lire = async () => {
      const { data, error } = await supabase.rpc('commandes_caisse_attente', { p_org: org });
      if (arret || error || !data) return;
      const e = data as Etat;
      const { c, total } = lecture(e);
      const avant = precedent.current;
      precedent.current = c;
      setEtat(e);
      const maintenant = Date.now();

      // 1. Commande affectée, pas encore acceptée : prioritaire, et revient toutes les 2 minutes.
      if (c.a_accepter > 0) {
        if (avant && c.a_accepter > avant.a_accepter) prochainRappel.current = 0; // nouvelle affectation : tout de suite
        if (maintenant >= prochainRappel.current) {
          prochainRappel.current = maintenant + RAPPEL_MS;
          montrer(true);
          alerter(
            'Commande affectée à vous',
            `${c.a_accepter} commande${pluriel(c.a_accepter)} à accepter : touchez « Accepter » puis rassemblez les articles.`,
            total + c.a_accepter,
          );
        }
        return;
      }
      prochainRappel.current = 0;

      const texte =
        c.a_livrer > (avant?.a_livrer ?? 0)
          ? `${c.a_livrer} commande${pluriel(c.a_livrer)} prête${pluriel(c.a_livrer)} à livrer : confirmez l’envoi`
          : c.nombre > (avant?.nombre ?? 0)
            ? `${c.nombre} commande${pluriel(c.nombre)} à rassembler et vérifier`
            : c.a_affecter > 0
              ? `${c.a_affecter} commande${pluriel(c.a_affecter)} à affecter à une caissière`
              : c.en_attente > 0
                ? `${c.en_attente} nouvelle${pluriel(c.en_attente)} commande${pluriel(c.en_attente)} en ligne, en attente d’affectation`
                : c.a_livrer > 0
                  ? `${c.a_livrer} livraison${pluriel(c.a_livrer)} à confirmer`
                  : `${c.nombre} commande${pluriel(c.nombre)} à rassembler et vérifier`;
      const hausse =
        avant !== null &&
        (c.nombre > avant.nombre || c.a_affecter > avant.a_affecter || c.en_attente > avant.en_attente || c.a_livrer > avant.a_livrer);
      if (avant === null && total > 0) {
        montrer(false);
        pontAndroid()?.notifier?.('Commandes en ligne', `Vous avez ${texte}.`, total);
      } else if (hausse) {
        montrer(false);
        alerter(c.a_livrer > avant!.a_livrer ? 'Livraison prête' : 'Nouvelle commande en ligne', `Vous avez ${texte}.`, total);
      } else if (total === 0 && avant && avant.nombre + avant.a_affecter + avant.en_attente + avant.a_livrer + avant.a_accepter > 0) {
        pontAndroid()?.notifier?.('', '', 0);
        if (visibleRef.current) fermer();
      }
    };
    lireRef.current = lire;
    // Téléphone Android : vérification en arrière-plan, même application fermée.
    const pont = pontAndroid();
    const conf = lireConfiguration();
    const jeton = pont?.veilleCommandes ? jetonAppareil() : '';
    if (pont?.veilleCommandes && conf && jeton)
      void supabase.rpc('enregistrer_appareil', { p_org: org, p_jeton: jeton }).then(({ error }) => {
        if (!error) pont.veilleCommandes!(conf.url, conf.cle, jeton);
      });
    void lire();
    const id = window.setInterval(() => void lire(), 12000);
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
  const { c, total } = lecture(etat);
  const liste = etat.a_accepter_liste ?? [];

  // Caissière : commande(s) à accepter.
  if (c.a_accepter > 0) {
    const accepter = async () => {
      setEnCours(true);
      for (const x of liste) await supabase.rpc('accepter_commande_web', { p_id: x.id });
      setEnCours(false);
      prochainRappel.current = 0;
      fermer();
      void lireRef.current();
      naviguer(liste.length === 1 ? `/caisse?commandes=1&commande=${liste[0]!.id}` : '/caisse?commandes=1');
    };
    const plusTard = () => {
      prochainRappel.current = Date.now() + RAPPEL_MS;
      fermer();
    };
    return (
      <div className={`lucarne lucarne-urgente ${sortie ? 'lucarne-sortie' : ''}`} role="alert" aria-live="assertive">
        <div className="lucarne-corps">
          <span className="lucarne-icone" aria-hidden>
            🧺<span className="lucarne-pastille">{c.a_accepter}</span>
          </span>
          <span className="lucarne-texte">
            <span className="lucarne-entete">
              <strong>DF Gestion</strong> · maintenant
            </span>
            <span className="lucarne-titre">
              {c.a_accepter} commande{pluriel(c.a_accepter)} affectée{pluriel(c.a_accepter)} à vous
            </span>
            <span className="lucarne-detail">
              {liste.slice(0, 3).map((x) => `${x.numero} · ${x.client} (${x.mode === 'livraison' ? '🛵 livraison' : '🏪 retrait'})`).join(' — ')}
              {liste.length > 3 ? ` … et ${liste.length - 3} autre(s)` : ''}
            </span>
            <span className="lucarne-detail lucarne-consigne">Acceptez, puis rassemblez et vérifiez les articles. Sans réponse, ce rappel revient dans 2 minutes.</span>
          </span>
        </div>
        <div className="lucarne-actions">
          <button type="button" onClick={plusTard}>
            Dans 2 min
          </button>
          <button type="button" className="lucarne-voir" disabled={enCours} onClick={() => void accepter()}>
            {enCours ? 'Un instant…' : '✅ Accepter'}
          </button>
        </div>
      </div>
    );
  }

  if (total === 0) return null;
  const aAffecter = c.a_affecter;
  const aLivrer = c.a_livrer;
  const miennes = c.nombre;
  const ouvrir = () => {
    fermer();
    naviguer(aAffecter > 0 || aLivrer > 0 ? '/boutique' : '/caisse?commandes=1');
  };
  const gerante = etat.gerante;

  return (
    <div className={`lucarne ${sortie ? 'lucarne-sortie' : ''}`} role="alert" aria-live="assertive">
      <button type="button" className="lucarne-corps" onClick={ouvrir}>
        <span className="lucarne-icone" aria-hidden>
          {aLivrer > 0 && aAffecter === 0 ? '🛵' : '🛍️'}<span className="lucarne-pastille">{total}</span>
        </span>
        <span className="lucarne-texte">
          <span className="lucarne-entete">
            <strong>DF Gestion</strong> · maintenant
          </span>
          <span className="lucarne-titre">
            {gerante
              ? aAffecter > 0
                ? `${aAffecter} commande${pluriel(aAffecter)} à affecter`
                : aLivrer > 0
                  ? `🛵 ${aLivrer} livraison${pluriel(aLivrer)} prête${pluriel(aLivrer)}`
                  : `🧺 ${miennes} commande${pluriel(miennes)} à rassembler`
              : miennes > 0
                ? `🧺 ${miennes} commande${pluriel(miennes)} à rassembler`
                : `🔔 ${c.en_attente} nouvelle${pluriel(c.en_attente)} commande${pluriel(c.en_attente)} en ligne`}
          </span>
          <span className="lucarne-detail">
            {gerante
              ? [
                  aAffecter > 0 ? 'Choisissez la caissière qui la rassemble.' : '',
                  aLivrer > 0 ? `${aLivrer} prête${pluriel(aLivrer)} à livrer : confirmez l’envoi.` : '',
                  miennes > 0 && aAffecter + aLivrer > 0 ? `${miennes} vous ${miennes > 1 ? 'sont affectées' : 'est affectée'}.` : '',
                ].filter(Boolean).join(' ') || 'Rassemblez et vérifiez les articles.'
              : miennes > 0
                ? 'Rassemblez et vérifiez les articles, puis marquez la commande « prête ».'
                : 'La gérante va l’affecter : vous serez prévenue dès qu’elle vous est confiée.'}
          </span>
        </span>
      </button>
      <div className="lucarne-actions">
        <button type="button" onClick={fermer}>
          Plus tard
        </button>
        <button type="button" className="lucarne-voir" onClick={ouvrir}>
          {aAffecter > 0 ? 'Affecter' : aLivrer > 0 ? 'Confirmer' : miennes > 0 ? 'Rassembler' : 'Voir'}
        </button>
      </div>
    </div>
  );
}
