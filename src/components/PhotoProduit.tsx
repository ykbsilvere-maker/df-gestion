import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { messageErreur } from '../lib/format';
import { Fenetre } from './ui';

/**
 * Photos des produits : espace privé « produits » (visible seulement par les membres de l'entreprise),
 * affichées par adresses signées. Les images sont réduites (800 px, JPEG) avant l'envoi.
 */

const cache = new Map<string, { url: string; expire: number }>();

export async function urlPhoto(chemin: string | null | undefined): Promise<string | null> {
  if (!chemin) return null;
  const c = cache.get(chemin);
  if (c && c.expire > Date.now()) return c.url;
  const { data } = await supabase.storage.from('produits').createSignedUrl(chemin, 3600);
  if (!data?.signedUrl) return null;
  cache.set(chemin, { url: data.signedUrl, expire: Date.now() + 50 * 60 * 1000 });
  return data.signedUrl;
}

export function usePhoto(chemin: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let actif = true;
    void urlPhoto(chemin).then((u) => actif && setUrl(u));
    return () => {
      actif = false;
    };
  }, [chemin]);
  return url;
}

export function Vignette({ chemin, taille = 44, alt = '' }: { chemin: string | null | undefined; taille?: number; alt?: string }) {
  const url = usePhoto(chemin);
  return (
    <span className="vignette" style={{ width: taille, height: taille }}>
      {url ? <img src={url} alt={alt} loading="lazy" /> : <span aria-hidden>📦</span>}
    </span>
  );
}

export async function reduire(source: Blob | HTMLCanvasElement, cote = 800): Promise<Blob> {
  let canvas: HTMLCanvasElement;
  if (source instanceof HTMLCanvasElement) canvas = source;
  else {
    const img = await createImageBitmap(source);
    const r = Math.min(1, cote / Math.max(img.width, img.height));
    canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * r);
    canvas.height = Math.round(img.height * r);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  }
  return new Promise((ok, ko) => canvas.toBlob((b) => (b ? ok(b) : ko(new Error('Image illisible'))), 'image/jpeg', 0.82));
}

function Camera({ onPhoto, onFermer }: { onPhoto: (c: HTMLCanvasElement) => void; onFermer: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [erreur, setErreur] = useState('');
  useEffect(() => {
    let flux: MediaStream | null = null;
    void navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false })
      .then((f) => {
        flux = f;
        if (video.current) {
          video.current.srcObject = f;
          void video.current.play();
        }
      })
      .catch(() => setErreur('Caméra indisponible : autorisez l’accès ou choisissez une image.'));
    return () => flux?.getTracks().forEach((t) => t.stop());
  }, []);
  function prendre() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const r = Math.min(1, 800 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * r);
    c.height = Math.round(v.videoHeight * r);
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    onPhoto(c);
  }
  return (
    <div className="camera-photo">
      {erreur ? <p className="texte-negatif">{erreur}</p> : <video ref={video} playsInline muted />}
      <div className="actions-piece">
        <button type="button" className="bouton bouton-discret" onClick={onFermer}>Fermer</button>
        {!erreur && <button type="button" className="bouton bouton-principal" onClick={prendre}>📸 Prendre la photo</button>}
      </div>
    </div>
  );
}

const MAX_PHOTOS = 9; // la principale + 8 dans la galerie

function TuilePhoto({ chemin, principale, modifiable, onPrincipale, onRetirer, onDecaler }: {
  chemin: string;
  principale: boolean;
  modifiable: boolean;
  onPrincipale: () => void;
  onRetirer: () => void;
  onDecaler: (sens: -1 | 1) => void;
}) {
  const url = usePhoto(chemin);
  return (
    <figure className={`tuile-photo ${principale ? 'principale' : ''}`}>
      {url ? <img src={url} alt="" loading="lazy" /> : <span className="tuile-photo-attente" aria-hidden>…</span>}
      {principale && <figcaption>Principale</figcaption>}
      {modifiable && (
        <div className="tuile-photo-actions">
          {!principale && <button type="button" title="Mettre en photo principale" aria-label="Mettre en photo principale" onClick={onPrincipale}>★</button>}
          {!principale && <button type="button" title="Avancer" aria-label="Avancer" onClick={() => onDecaler(-1)}>‹</button>}
          {!principale && <button type="button" title="Reculer" aria-label="Reculer" onClick={() => onDecaler(1)}>›</button>}
          <button type="button" title="Retirer" aria-label="Retirer cette photo" className="retirer" onClick={onRetirer}>✕</button>
        </div>
      )}
    </figure>
  );
}

/**
 * Photos de la fiche produit : une photo principale (catalogue, caisse, cartes de DF Marché) et une galerie
 * de 8 photos de plus (page du produit sur DF Marché). Prendre avec l'appareil ou choisir plusieurs images d'un coup.
 */
export function PhotoProduit({
  org,
  produitId,
  chemin,
  photos = [],
  modifiable,
  onChange,
  onPhotos,
}: {
  org: string;
  produitId: string;
  chemin: string | null;
  photos?: string[];
  modifiable: boolean;
  onChange: (chemin: string | null) => void;
  onPhotos?: (photos: string[]) => void;
}) {
  const fichier = useRef<HTMLInputElement>(null);
  const [camera, setCamera] = useState(false);
  const [envoi, setEnvoi] = useState('');
  const [erreur, setErreur] = useState('');
  const toutes = [chemin, ...photos].filter((x): x is string => !!x);
  const place = MAX_PHOTOS - toutes.length;

  async function enregistrer(principale: string | null, galerie: string[]) {
    const { error } = await supabase.from('produits').update({ photo_path: principale, photos: galerie }).eq('id', produitId);
    if (error) throw error;
    onChange(principale);
    onPhotos?.(galerie);
  }

  async function envoyer(sources: (Blob | HTMLCanvasElement)[]) {
    setErreur('');
    const liste = sources.slice(0, Math.max(0, place));
    if (liste.length < sources.length) setErreur(`${MAX_PHOTOS} photos au plus : ${sources.length - liste.length} image(s) ignorée(s).`);
    const nouveaux: string[] = [];
    try {
      for (const [i, source] of liste.entries()) {
        setEnvoi(`Envoi ${i + 1}/${liste.length}…`);
        const image = await reduire(source, 1000);
        const c = `${org}/${produitId}-${Date.now()}-${i}.jpg`;
        const { error } = await supabase.storage.from('produits').upload(c, image, { contentType: 'image/jpeg', upsert: true });
        if (error) throw error;
        nouveaux.push(c);
      }
      if (nouveaux.length) {
        const principale = chemin ?? nouveaux[0]!;
        await enregistrer(principale, [...photos, ...nouveaux.filter((c) => c !== principale)]);
      }
    } catch (e) {
      setErreur(messageErreur(e));
      if (nouveaux.length) void supabase.storage.from('produits').remove(nouveaux);
    } finally {
      setEnvoi('');
      setCamera(false);
    }
  }

  async function action(fn: () => Promise<void>) {
    setErreur('');
    try {
      await fn();
    } catch (e) {
      setErreur(messageErreur(e));
    }
  }

  const retirer = (c: string) =>
    action(async () => {
      if (!window.confirm('Retirer cette photo ?')) return;
      if (c === chemin) {
        const [suivante, ...reste] = photos;
        await enregistrer(suivante ?? null, reste);
      } else await enregistrer(chemin, photos.filter((x) => x !== c));
      void supabase.storage.from('produits').remove([c]);
    });
  const principale = (c: string) =>
    action(() => enregistrer(c, [...(chemin ? [chemin] : []), ...photos.filter((x) => x !== c)]));
  const decaler = (c: string, sens: -1 | 1) =>
    action(async () => {
      const i = photos.indexOf(c);
      const j = i + sens;
      if (j < 0 || j >= photos.length) return;
      const g = [...photos];
      [g[i], g[j]] = [g[j]!, g[i]!];
      await enregistrer(chemin, g);
    });

  return (
    <section className="photo-produit galerie">
      <div className="photo-actions">
        <strong>Photos du produit {toutes.length > 0 && <span className="secondaire">({toutes.length}/{MAX_PHOTOS})</span>}</strong>
        <span className="secondaire">La première est la photo principale (catalogue, caisse, cartes du site). Les autres forment la galerie de la page du produit sur DF Marché.</span>
        {erreur && <span className="texte-negatif">{erreur}</span>}
      </div>
      <div className="grille-photos">
        {toutes.map((c) => (
          <TuilePhoto key={c} chemin={c} principale={c === chemin} modifiable={modifiable}
            onPrincipale={() => void principale(c)} onRetirer={() => void retirer(c)} onDecaler={(s) => void decaler(c, s)} />
        ))}
        {modifiable && place > 0 && (
          <div className="tuile-ajout">
            <button type="button" disabled={!!envoi} onClick={() => fichier.current?.click()}>
              <span aria-hidden>🖼️</span>{envoi || (toutes.length ? 'Ajouter des photos' : 'Choisir des photos')}
            </button>
            <button type="button" disabled={!!envoi} onClick={() => setCamera(true)}><span aria-hidden>📸</span>Prendre</button>
          </div>
        )}
        {!toutes.length && !modifiable && <div className="photo-cadre"><span aria-hidden>📦</span></div>}
      </div>
      <input
        ref={fichier}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const f = Array.from(e.target.files ?? []) as File[];
          e.target.value = '';
          if (f.length) void envoyer(f);
        }}
      />
      <Fenetre titre="Photo du produit" ouverte={camera} onFermer={() => setCamera(false)}>
        {camera && <Camera onPhoto={(c) => void envoyer([c])} onFermer={() => setCamera(false)} />}
      </Fenetre>
    </section>
  );
}
