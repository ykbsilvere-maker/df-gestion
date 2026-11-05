import { useEffect, useRef, useState } from 'react';
import type { IScannerControls } from '@zxing/browser';
import { Alerte } from './ui';

/**
 * Lecture de code-barres par la caméra (arrière de préférence).
 * Les lecteurs USB/Bluetooth n'en ont pas besoin : ils « tapent » le code suivi d'Entrée
 * dans le champ de recherche, qui le traite directement.
 */
export function Scanner({ onCode, onFermer, qr = false }: { onCode: (code: string) => void; onFermer: () => void; qr?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [erreur, setErreur] = useState('');
  const fini = useRef(false);
  // Référence stable : la caméra ne redémarre pas à chaque rendu du parent.
  const rappel = useRef(onCode);
  rappel.current = onCode;

  useEffect(() => {
    let controles: IScannerControls | undefined;
    let annule = false;
    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setErreur('Caméra indisponible sur cet appareil ou ce navigateur (HTTPS requis).');
        return;
      }
      try {
        const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
          import('@zxing/browser'),
          import('@zxing/library'),
        ]);
        const indices = new Map();
        indices.set(DecodeHintType.POSSIBLE_FORMATS, qr ? [BarcodeFormat.QR_CODE] : [
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
          BarcodeFormat.CODE_128,
          BarcodeFormat.CODE_39,
          BarcodeFormat.ITF,
        ]);
        const lecteur = new BrowserMultiFormatReader(indices);
        if (annule || !video.current) return;
        controles = await lecteur.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' } } },
          video.current,
          (resultat) => {
            if (resultat && !fini.current) {
              fini.current = true;
              navigator.vibrate?.(80);
              controles?.stop();
              rappel.current(resultat.getText());
            }
          },
        );
        if (annule) controles.stop();
      } catch (e) {
        const nom = (e as { name?: string }).name;
        setErreur(
          nom === 'NotAllowedError'
            ? 'Accès à la caméra refusé. Autorisez-le dans les réglages du navigateur.'
            : 'Impossible de démarrer la caméra.',
        );
      }
    })();
    return () => {
      annule = true;
      controles?.stop();
    };
  }, []);

  return (
    <div className="scanner">
      <Alerte>{erreur}</Alerte>
      {!erreur && (
        <div className="scanner-cadre">
          <video ref={video} muted playsInline />
          <div className="scanner-viseur" aria-hidden />
        </div>
      )}
      <p className="secondaire">{qr ? 'Placez le QR code dans le cadre.' : 'Placez le code-barres dans le cadre, à 10–20 cm, bien éclairé.'}</p>
      <button type="button" className="bouton bouton-discret" onClick={onFermer}>
        Fermer
      </button>
    </div>
  );
}
