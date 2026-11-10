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

/** Bloc photo de la fiche produit : voir, prendre avec l'appareil, choisir dans la galerie, retirer. */
export function PhotoProduit({
  org,
  produitId,
  chemin,
  modifiable,
  onChange,
}: {
  org: string;
  produitId: string;
  chemin: string | null;
  modifiable: boolean;
  onChange: (chemin: string | null) => void;
}) {
  const url = usePhoto(chemin);
  const fichier = useRef<HTMLInputElement>(null);
  const [camera, setCamera] = useState(false);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState('');

  async function envoyer(source: Blob | HTMLCanvasElement) {
    setEnvoi(true);
    setErreur('');
    try {
      const image = await reduire(source);
      const nouveauChemin = `${org}/${produitId}-${Date.now()}.jpg`;
      const { error } = await supabase.storage.from('produits').upload(nouveauChemin, image, { contentType: 'image/jpeg', upsert: true });
      if (error) throw error;
      const { error: e2 } = await supabase.from('produits').update({ photo_path: nouveauChemin }).eq('id', produitId);
      if (e2) throw e2;
      if (chemin) void supabase.storage.from('produits').remove([chemin]);
      onChange(nouveauChemin);
    } catch (e) {
      setErreur(messageErreur(e));
    } finally {
      setEnvoi(false);
      setCamera(false);
    }
  }

  async function retirer() {
    if (!chemin || !window.confirm('Retirer la photo de ce produit ?')) return;
    const { error } = await supabase.from('produits').update({ photo_path: null }).eq('id', produitId);
    if (error) return setErreur(messageErreur(error));
    void supabase.storage.from('produits').remove([chemin]);
    onChange(null);
  }

  return (
    <section className="photo-produit">
      <div className="photo-cadre">{url ? <img src={url} alt="Photo du produit" /> : <span aria-hidden>📦</span>}</div>
      <div className="photo-actions">
        <strong>Photo du produit</strong>
        <span className="secondaire">Visible seulement dans l’application (catalogue, caisse).</span>
        {erreur && <span className="texte-negatif">{erreur}</span>}
        {modifiable && (
          <div className="actions-ligne">
            <button type="button" className="bouton bouton-discret" disabled={envoi} onClick={() => setCamera(true)}>📸 Prendre</button>
            <button type="button" className="bouton bouton-discret" disabled={envoi} onClick={() => fichier.current?.click()}>🖼️ Choisir</button>
            {chemin && <button type="button" className="bouton-lien lien-danger" onClick={() => void retirer()}>Retirer</button>}
            {envoi && <span className="secondaire">Envoi…</span>}
          </div>
        )}
        <input
          ref={fichier}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void envoyer(f);
          }}
        />
      </div>
      <Fenetre titre="Photo du produit" ouverte={camera} onFermer={() => setCamera(false)}>
        {camera && <Camera onPhoto={(c) => void envoyer(c)} onFermer={() => setCamera(false)} />}
      </Fenetre>
    </section>
  );
}
