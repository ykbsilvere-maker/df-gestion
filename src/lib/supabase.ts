import { createClient } from '@supabase/supabase-js';
import { lireConfiguration } from './config';

const config = lireConfiguration();

/** Aucune adresse de serveur connue : l'application affiche l'écran de configuration. */
export const configurationManquante = !config;
export const sourceConfiguration = config?.source ?? null;

export const supabase = createClient(config?.url ?? 'http://localhost', config?.cle ?? 'cle-absente', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
