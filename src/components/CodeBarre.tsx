import { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

/** Format JsBarcode adapté au code : EAN-13 / EAN-8 / UPC si la clé est valide, sinon CODE128. */
export function formatCode(code: string): 'EAN13' | 'EAN8' | 'UPC' | 'CODE128' {
  if (/^\d{13}$/.test(code) && cleValide(code)) return 'EAN13';
  if (/^\d{8}$/.test(code) && cleValide(code)) return 'EAN8';
  if (/^\d{12}$/.test(code) && cleValide('0' + code)) return 'UPC';
  return 'CODE128';
}

/** Vérifie la clé de contrôle GS1 (EAN-8, EAN-13, UPC-A préfixé de 0). */
export function cleValide(code: string): boolean {
  const chiffres = code.split('').map(Number);
  const cle = chiffres.pop()!;
  const somme = chiffres
    .reverse()
    .reduce((s, c, i) => s + c * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (somme % 10)) % 10 === cle;
}

export function CodeBarre({
  code,
  hauteur = 40,
  largeurBarre = 1.6,
  taillePolice = 13,
  className,
}: {
  code: string;
  hauteur?: number;
  largeurBarre?: number;
  taillePolice?: number;
  className?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, code, {
        format: formatCode(code),
        height: hauteur,
        width: largeurBarre,
        fontSize: taillePolice,
        margin: 0,
        textMargin: 1,
        background: 'transparent',
        font: 'monospace',
      });
    } catch {
      JsBarcode(ref.current, code, { format: 'CODE128', height: hauteur, width: largeurBarre, fontSize: taillePolice, margin: 0 });
    }
  }, [code, hauteur, largeurBarre, taillePolice]);
  return <svg ref={ref} className={className} role="img" aria-label={`Code-barres ${code}`} />;
}
