import { supabase } from './supabase';
import { deposerImage } from './images';

/**
 * Après validation, le logo joint à la demande est déposé dans l'espace de la nouvelle
 * entreprise (le gérant principal a alors le droit d'écrire ses images), puis la copie
 * gardée dans la demande est effacée. Sans effet si rien n'est à transférer.
 */
export async function transfererLogoDemande(d: { id: string; statut: string; logo: string | null; organisation_id: string | null }): Promise<void> {
  if (d.statut !== 'validee' || !d.logo || !d.organisation_id) return;
  const blob = await (await fetch(d.logo)).blob();
  const chemin = await deposerImage('logos', d.organisation_id, 'logo', blob);
  const { error } = await supabase.from('organisations').update({ logo_path: chemin }).eq('id', d.organisation_id).is('logo_path', null);
  if (error) throw error;
  await supabase.rpc('demande_logo_transfere', { p_id: d.id });
}

/** Une fois par session, pour un gérant principal dont la demande vient d'être validée. */
export async function reprendreLogoDemande(): Promise<void> {
  const cle = 'dfg_logo_demande_verifie';
  try {
    if (sessionStorage.getItem(cle)) return;
    sessionStorage.setItem(cle, '1');
  } catch {
    /* stockage indisponible : on vérifie quand même */
  }
  const { data, error } = await supabase.rpc('ma_demande');
  if (error || !data) return;
  await transfererLogoDemande(data as { id: string; statut: string; logo: string | null; organisation_id: string | null });
}
