import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { montant } from '../../lib/argent';
import { telechargerFichier } from '../../lib/excel';
import { marcheUrl } from './commun';

export interface OffreQr {
  code: string;
  type: 'pourcent' | 'montant';
  valeur: number;
  minimum?: number | null;
  fin?: string | null;
  libelle?: string | null;
}

const remise = (k: OffreQr) => (k.type === 'pourcent' ? `−${k.valeur} %` : `−${montant(Number(k.valeur))}`);

/** Lien de l'offre : ouvert sur le téléphone, il mène à la boutique ; scanné en caisse, il applique la remise. */
export const lienOffre = (slug: string, code: string) => marcheUrl(`/offre/${slug}/${code}`);

/** Carte « bon de réduction » (1080 × 1350) avec le QR code, prête à envoyer sur WhatsApp. */
async function dessinerCarte(k: OffreQr, slug: string, boutique: string, client?: string | null): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  c.width = 1080;
  c.height = 1350;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  // Bandeau vert en haut
  const grad = g.createLinearGradient(0, 0, 1080, 0);
  grad.addColorStop(0, '#0f5132');
  grad.addColorStop(1, '#16a34a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1080, 300);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.font = '600 44px system-ui, sans-serif';
  g.fillText(boutique, 540, 95);
  g.font = '900 120px system-ui, sans-serif';
  g.fillText(remise(k), 540, 225);
  g.font = '500 36px system-ui, sans-serif';
  g.fillStyle = '#d1fae5';
  g.fillText(k.libelle || 'Bon de réduction', 540, 275);
  // QR code
  const qr = document.createElement('canvas');
  await QRCode.toCanvas(qr, lienOffre(slug, k.code), { width: 640, margin: 1, color: { dark: '#0b1f14', light: '#ffffff' } });
  g.drawImage(qr, 220, 350, 640, 640);
  g.fillStyle = '#111827';
  g.font = '800 64px ui-monospace, monospace';
  g.fillText(k.code, 540, 1075);
  g.font = '500 34px system-ui, sans-serif';
  g.fillStyle = '#374151';
  const conditions = [
    client ? `Réservé à ${client}` : null,
    Number(k.minimum) > 0 ? `Dès ${montant(Number(k.minimum))} d'achat` : null,
    k.fin ? `Jusqu'au ${new Date(k.fin).toLocaleDateString('fr-FR')}` : null,
  ].filter(Boolean).join(' · ');
  if (conditions) g.fillText(conditions, 540, 1135);
  g.fillStyle = '#16a34a';
  g.font = '600 34px system-ui, sans-serif';
  g.fillText('Montrez ce QR code en caisse ou commandez sur DF Marché', 540, 1215);
  g.fillStyle = '#9ca3af';
  g.font = '400 28px system-ui, sans-serif';
  g.fillText(marcheUrl().replace(/^https?:\/\//, ''), 540, 1280);
  return c;
}

/** Aperçu du QR code d'un code promo, à télécharger ou partager au client. */
export function QrOffre({ offre, slug, boutique, client }: { offre: OffreQr; slug: string; boutique: string; client?: string | null }) {
  const [image, setImage] = useState<string | null>(null);
  const [info, setInfo] = useState('');
  useEffect(() => {
    let actif = true;
    void dessinerCarte(offre, slug, boutique, client).then((c) => actif && setImage(c.toDataURL('image/png')));
    return () => {
      actif = false;
    };
  }, [offre, slug, boutique, client]);

  const nom = `bon-${offre.code.toLowerCase()}.png`;
  const octets = () => {
    const b = atob(image!.split(',')[1]!);
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  };
  const texte = `${boutique} vous offre ${remise(offre)} avec le code ${offre.code}. Montrez ce QR code en caisse ou commandez ici : ${lienOffre(slug, offre.code)}`;

  async function partager() {
    if (!image) return;
    try {
      const fichier = new File([octets().slice().buffer as ArrayBuffer], nom, { type: 'image/png' });
      if (navigator.canShare?.({ files: [fichier] })) {
        await navigator.share({ files: [fichier], text: texte, title: 'Bon de réduction' });
        return;
      }
      if (navigator.share) {
        await navigator.share({ text: texte, title: 'Bon de réduction' });
        return;
      }
    } catch {
      /* partage annulé */
      return;
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(texte)}`, '_blank', 'noopener');
  }

  return (
    <div className="qr-offre">
      {image ? <img src={image} alt={`QR code du bon ${offre.code}`} className="qr-offre-image" /> : <div className="qr-offre-image qr-offre-chargement" />}
      <div className="qr-offre-actions">
        <button type="button" className="bouton bouton-principal" disabled={!image} onClick={() => void partager()}>
          📤 Envoyer au client
        </button>
        <button
          type="button"
          className="bouton bouton-discret"
          disabled={!image}
          onClick={() => {
            telechargerFichier(nom, 'image/png', octets());
            setInfo('Image enregistrée.');
          }}
        >
          ⬇️ Télécharger
        </button>
        <a className="bouton bouton-whatsapp" href={`https://wa.me/?text=${encodeURIComponent(texte)}`} target="_blank" rel="noreferrer">
          WhatsApp
        </a>
      </div>
      {info && <p className="secondaire">{info}</p>}
    </div>
  );
}
