import { supabase } from './supabase';

/** Lit n'importe quelle image que le navigateur sait afficher (PNG, JPEG, WebP, GIF, BMP, SVG, AVIF…). */
async function decoder(fichier: File): Promise<{ source: CanvasImageSource; l: number; h: number; fermer: () => void }> {
  try {
    const b = await createImageBitmap(fichier);
    return { source: b, l: b.width, h: b.height, fermer: () => b.close() };
  } catch {
    const url = URL.createObjectURL(fichier);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      const l = img.naturalWidth || 600;
      const h = img.naturalHeight || 600;
      return { source: img, l, h, fermer: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      throw new Error('Image illisible par ce navigateur (ex. photo HEIC d’iPhone) : enregistrez-la en JPEG ou PNG, ou faites-en une capture d’écran.');
    }
  }
}

/** Zone utile : retire les marges transparentes ou de la couleur du fond (coins identiques). */
function zoneUtile(ctx: CanvasRenderingContext2D, l: number, h: number): { x: number; y: number; l: number; h: number } {
  const d = ctx.getImageData(0, 0, l, h).data;
  const px = (x: number, y: number) => (y * l + x) * 4;
  const coins = [px(0, 0), px(l - 1, 0), px(0, h - 1), px(l - 1, h - 1)];
  const ref = coins[0]!;
  const proche = (a: number, b: number) =>
    Math.abs(d[a]! - d[b]!) + Math.abs(d[a + 1]! - d[b + 1]!) + Math.abs(d[a + 2]! - d[b + 2]!) + Math.abs(d[a + 3]! - d[b + 3]!) < 40;
  const fondUni = coins.every((c) => proche(c, ref));
  const vide = (i: number) => d[i + 3]! < 12 || (fondUni && proche(i, ref));
  let x0 = l, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < l; x++)
      if (!vide(px(x, y))) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return { x: 0, y: 0, l, h };
  // Petite marge autour du logo (4 %), pour qu'il respire sans flotter dans le vide.
  const m = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04);
  const x = Math.max(0, x0 - m), y = Math.max(0, y0 - m);
  return { x, y, l: Math.min(l, x1 + m + 1) - x, h: Math.min(h, y1 + m + 1) - y };
}

/**
 * Prépare une image pour l'envoi, quelle que soit sa taille de départ : recadrage des marges vides,
 * réduction (côté le plus long ≤ tailleMax px), puis compression jusqu'à passer sous la limite
 * (PNG d'abord pour garder la transparence, puis JPEG si besoin). Aucune limite pour l'utilisateur.
 */
export async function reduireImage(
  fichier: File,
  tailleMax = 600,
  format: 'image/png' | 'image/jpeg' = 'image/png',
  limite = 450 * 1024,
): Promise<Blob> {
  if (fichier.type && !fichier.type.startsWith('image/')) throw new Error('Choisissez une image (photo, PNG, JPEG, logo…).');
  const img = await decoder(fichier);
  try {
    // 1. Recadrage sur une copie de travail (au plus 1 600 px pour rester rapide).
    const e0 = Math.min(1, 1600 / Math.max(img.l, img.h));
    const travail = document.createElement('canvas');
    travail.width = Math.max(1, Math.round(img.l * e0));
    travail.height = Math.max(1, Math.round(img.h * e0));
    const ct = travail.getContext('2d', { willReadFrequently: true })!;
    ct.drawImage(img.source, 0, 0, travail.width, travail.height);
    const z = zoneUtile(ct, travail.width, travail.height);

    // 2. Encodage à des tailles et qualités décroissantes jusqu'à passer sous la limite.
    const encoder = async (cote: number, type: 'image/png' | 'image/jpeg', qualite: number) => {
      const e = Math.min(1, cote / Math.max(z.l, z.h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(z.l * e));
      c.height = Math.max(1, Math.round(z.h * e));
      const cx = c.getContext('2d')!;
      if (type === 'image/jpeg') {
        cx.fillStyle = '#fff';
        cx.fillRect(0, 0, c.width, c.height);
      }
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(travail, z.x, z.y, z.l, z.h, 0, 0, c.width, c.height);
      return new Promise<Blob | null>((ok) => c.toBlob(ok, type, qualite));
    };
    const essais: [number, 'image/png' | 'image/jpeg', number][] = [];
    const cotes = [tailleMax, 512, 420, 360, 300, 240].filter((c, i, t) => c <= tailleMax && t.indexOf(c) === i);
    if (format === 'image/png') for (const c of cotes) essais.push([c, 'image/png', 1]);
    for (const c of cotes) for (const q of [0.88, 0.78, 0.68, 0.58]) essais.push([c, 'image/jpeg', q]);
    let meilleur: Blob | null = null;
    for (const [c, t, q] of essais) {
      const b = await encoder(c, t, q);
      if (!b) continue;
      if (b.size <= limite) return b;
      if (!meilleur || b.size < meilleur.size) meilleur = b;
    }
    if (meilleur && meilleur.size <= limite * 1.1) return meilleur;
    throw new Error('Image impossible à alléger suffisamment : essayez une autre image.');
  } finally {
    img.fermer();
  }
}

/** Phrase courte pour l'utilisateur : « 3,2 Mo → 84 Ko ». */
export function tailleLisible(octets: number): string {
  return octets >= 1024 * 1024 ? `${(octets / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo` : `${Math.max(1, Math.round(octets / 1024))} Ko`;
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
