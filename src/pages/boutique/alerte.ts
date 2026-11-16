import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';

/** Petit « ding » (deux notes) joué à l'arrivée d'une commande en ligne. */
function ding() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      const t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.4);
    });
    window.setTimeout(() => void ctx.close(), 1200);
  } catch {
    /* son indisponible */
  }
}

/**
 * Nombre de commandes en ligne à confirmer, relu toutes les 45 secondes. Une nouvelle commande
 * fait sonner l'application, s'affiche dans le titre de l'onglet et, si l'utilisateur l'a
 * autorisé, en notification du téléphone ou de l'ordinateur.
 */
export function useCommandesWeb(org: string | undefined, autorise: boolean): number {
  const [n, setN] = useState(0);
  const precedent = useRef<number | null>(null);
  useEffect(() => {
    if (!org || !autorise) return setN(0);
    let actif = true;
    async function lire() {
      if (document.visibilityState === 'hidden' && precedent.current !== null && Math.random() < 0.5) return;
      const { data, error } = await supabase.rpc('commandes_web_a_traiter', { p_org: org });
      if (!actif || error) return;
      const v = Number((data as { nouvelles?: number })?.nouvelles ?? 0);
      if (precedent.current !== null && v > precedent.current) {
        ding();
        try {
          if ('Notification' in window && Notification.permission === 'granted')
            new Notification('Nouvelle commande en ligne', { body: 'Ouvrez « Boutique en ligne » pour la confirmer.', icon: '/icone-192.png' });
        } catch {
          /* notifications indisponibles */
        }
      }
      precedent.current = v;
      setN(v);
    }
    void lire();
    const id = window.setInterval(() => void lire(), 45000);
    return () => {
      actif = false;
      window.clearInterval(id);
    };
  }, [org, autorise]);
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = n > 0 ? `(${n}) ${base}` : base;
  }, [n]);
  return n;
}
