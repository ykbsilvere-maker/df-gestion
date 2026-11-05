import { supabase } from './supabase';

/**
 * Réduit une image côté navigateur (côté le plus long ≤ taillMax px) et la convertit
 * en PNG (transparence conservée) ou JPEG, pour des reçus et un chargement légers.
 */
export async function reduireImage(fichier: File, tailleMax = 600, format: 'image/png' | 'image/jpeg' = 'image/png'): Promise<Blob> {
  if (!/^image\/(png|jpeg|webp)$/.test(fichier.type)) throw new Error('Format accepté : PNG, JPEG ou WebP.');
  const bitmap = await createImageBitmap(fichier);
  const echelle = Math.min(1, tailleMax / Math.max(bitmap.width, bitmap.height));
  const l = Math.max(1, Math.round(bitmap.width * echelle));
  const h = Math.max(1, Math.round(bitmap.height * echelle));
  const canvas = document.createElement('canvas');
  canvas.width = l;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  if (format === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, l, h);
  }
  ctx.drawImage(bitmap, 0, 0, l, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, format, 0.86));
  if (!blob) throw new Error('Conversion de l’image impossible.');
  if (blob.size > 500 * 1024) throw new Error('Image trop lourde même après réduction (500 Ko maximum).');
  return blob;
}

/** Dépose une image dans le dossier de l'entreprise et renvoie son chemin. */
export async function deposerImage(espace: 'logos' | 'produits', organisationId: string, nom: string, blob: Blob): Promise<string> {
  const extension = blob.type === 'image/jpeg' ? 'jpg' : 'png';
  const chemin = `${organisationId}/${nom}-${Date.now()}.${extension}`;
  const { error } = await supabase.storage.from(espace).upload(chemin, blob, { contentType: blob.type, upsert: false });
  if (error) throw error;
  return chemin;
}

export async function supprimerImage(espace: 'logos' | 'produits', chemin: string | null | undefined) {
  if (!chemin) return;
  await supabase.storage.from(espace).remove([chemin]);
}
