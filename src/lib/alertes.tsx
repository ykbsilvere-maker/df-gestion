import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

/**
 * Alertes d'équipe en direct : quand quelqu'un ouvre ou clôture une caisse ou la journée,
 * les autres personnes connectées de l'entreprise voient un message. Rien n'est stocké :
 * la trace durable reste la piste d'audit.
 */
export interface AlerteEquipe {
  id: number;
  icone: string;
  texte: string;
  auteur: string;
  heure: string;
}

const canaux = new Map<string, ReturnType<typeof supabase.channel>>();
function canal(org: string) {
  let c = canaux.get(org);
  if (!c) {
    c = supabase.channel(`equipe-${org}`, { config: { broadcast: { self: false } } });
    canaux.set(org, c);
  }
  return c;
}

/** Prévient les autres personnes connectées de l'entreprise. Sans effet si le réseau manque. */
export function annoncer(org: string | undefined, icone: string, texte: string, auteur: string) {
  if (!org) return;
  try {
    void canal(org).send({ type: 'broadcast', event: 'alerte', payload: { icone, texte, auteur } });
  } catch {
    /* une alerte perdue ne doit jamais bloquer l'opération */
  }
}

export function AlertesEquipe({ org }: { org: string | undefined }) {
  const [alertes, setAlertes] = useState<AlerteEquipe[]>([]);
  const numero = useRef(0);
  useEffect(() => {
    if (!org) return;
    const c = canal(org);
    c.on('broadcast', { event: 'alerte' }, ({ payload }) => {
      const p = payload as { icone?: string; texte?: string; auteur?: string };
      if (!p?.texte) return;
      const a: AlerteEquipe = {
        id: ++numero.current,
        icone: String(p.icone ?? '🔔').slice(0, 4),
        texte: String(p.texte).slice(0, 200),
        auteur: String(p.auteur ?? '').slice(0, 80),
        heure: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      };
      setAlertes((l) => [...l.slice(-3), a]);
      try {
        navigator.vibrate?.(120);
      } catch {
        /* sans vibreur */
      }
      window.setTimeout(() => setAlertes((l) => l.filter((x) => x.id !== a.id)), 15000);
    }).subscribe();
    return () => {
      void supabase.removeChannel(c);
      canaux.delete(org);
    };
  }, [org]);
  if (!alertes.length) return null;
  return (
    <div className="alertes-equipe" role="status" aria-live="polite">
      {alertes.map((a) => (
        <div key={a.id} className="alerte-equipe">
          <span className="alerte-equipe-icone" aria-hidden>{a.icone}</span>
          <div>
            <strong>{a.texte}</strong>
            <small>{a.auteur ? `${a.auteur} · ` : ''}{a.heure}</small>
          </div>
          <button type="button" className="bouton-icone" onClick={() => setAlertes((l) => l.filter((x) => x.id !== a.id))} aria-label="Fermer">×</button>
        </div>
      ))}
    </div>
  );
}
