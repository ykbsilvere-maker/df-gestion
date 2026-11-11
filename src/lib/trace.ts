import { supabase } from './supabase';

/**
 * Trace d'activité pour la piste d'audit : module ouvert, fenêtre fermée, impression, export,
 * verrouillage… Envoi silencieux : une trace perdue (réseau, serveur pas à jour) ne gêne jamais le travail.
 */
let orgCourante: string | undefined;
const dernieres = new Map<string, number>();

export function definirOrgTrace(org: string | undefined) {
  orgCourante = org;
}

export function tracer(action: string, contexte?: Record<string, string | number | boolean | null>) {
  if (!orgCourante || !navigator.onLine) return;
  // Même geste répété coup sur coup : une seule ligne.
  const cle = `${action}|${JSON.stringify(contexte ?? {})}`;
  const maintenant = Date.now();
  if (maintenant - (dernieres.get(cle) ?? 0) < 20000) return;
  dernieres.set(cle, maintenant);
  if (dernieres.size > 200) dernieres.clear();
  void supabase.rpc('tracer', { p_org: orgCourante, p_action: `activite.${action}`, p_contexte: contexte ?? null }).then(
    () => undefined,
    () => undefined,
  );
}

if (typeof window !== 'undefined') {
  window.addEventListener('dfg-trace', (e) => {
    const d = (e as CustomEvent<{ action: string; contexte?: Record<string, string> }>).detail;
    if (d?.action) tracer(d.action, d.contexte);
  });
}
