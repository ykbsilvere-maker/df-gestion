import { appareilLisible, nomAppareil } from './format';

/**
 * Jeton propre à cet appareil (navigateur ou application), gardé sur l'appareil.
 * Il sert à reconnaître un appareil approuvé par la gérante et à recevoir les alertes.
 * Le serveur n'en garde que l'empreinte.
 */
export function jetonAppareil(): string {
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

/** Nom lisible de l'appareil, montré à la gérante pour qu'elle le reconnaisse. */
export function libelleAppareil(): string {
  const nom = nomAppareil();
  const type = appareilLisible(navigator.userAgent);
  return [nom !== 'Navigateur' ? nom : '', type].filter(Boolean).join(' — ').slice(0, 120) || 'Appareil';
}

/** Numéro de la session Supabase (dans le jeton d'accès) : une nouvelle connexion = une nouvelle session. */
export function numeroSession(jeton: string | undefined): string {
  if (!jeton) return '';
  try {
    const charge = jeton.split('.')[1] ?? '';
    const json = JSON.parse(atob(charge.replace(/-/g, '+').replace(/_/g, '/'))) as { session_id?: string };
    return json.session_id ?? '';
  } catch {
    return '';
  }
}
