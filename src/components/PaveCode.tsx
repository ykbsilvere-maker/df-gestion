import { useEffect, useState } from 'react';

/**
 * Pavé numérique « comme Wave » : 4 points, validation automatique au 4e chiffre.
 * Le clavier du PC fonctionne aussi (chiffres, Retour arrière).
 */
export function PaveCode({
  onComplet,
  occupe,
  erreur,
  remiseAZero,
}: {
  onComplet: (code: string) => void;
  occupe?: boolean;
  erreur?: string;
  /** Change de valeur pour vider le pavé (après une erreur ou à l'étape suivante). */
  remiseAZero?: unknown;
}) {
  const [code, setCode] = useState('');
  const [secousse, setSecousse] = useState(false);

  useEffect(() => {
    setCode('');
  }, [remiseAZero]);
  useEffect(() => {
    if (!erreur) return;
    setCode('');
    setSecousse(true);
    const t = window.setTimeout(() => setSecousse(false), 450);
    return () => window.clearTimeout(t);
  }, [erreur, remiseAZero]);

  function taper(c: string) {
    if (occupe || code.length >= 4) return;
    const n = code + c;
    setCode(n);
    if (n.length === 4) window.setTimeout(() => onComplet(n), 120);
  }

  useEffect(() => {
    const touche = (e: KeyboardEvent) => {
      const cible = e.target as HTMLElement | null;
      if (cible && (cible.tagName === 'INPUT' || cible.tagName === 'TEXTAREA' || cible.tagName === 'SELECT')) return;
      if (/^[0-9]$/.test(e.key)) taper(e.key);
      else if (e.key === 'Backspace') setCode((x) => x.slice(0, -1));
    };
    window.addEventListener('keydown', touche);
    return () => window.removeEventListener('keydown', touche);
  });

  return (
    <div className="pave-code">
      <div className={`pave-points ${secousse ? 'secousse' : ''}`} aria-live="polite" aria-label={`${code.length} chiffre(s) sur 4`}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={i < code.length ? 'plein' : ''} />
        ))}
      </div>
      <p className="pave-message" role={erreur ? 'alert' : undefined}>
        {occupe ? 'Vérification…' : erreur || ' '}
      </p>
      <div className="pave-touches">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((t) => (
          <button key={t} type="button" onClick={() => taper(t)} disabled={occupe}>
            {t}
          </button>
        ))}
        <span />
        <button type="button" onClick={() => taper('0')} disabled={occupe}>
          0
        </button>
        <button type="button" className="pave-effacer" onClick={() => setCode((x) => x.slice(0, -1))} disabled={occupe || !code} aria-label="Effacer">
          ⌫
        </button>
      </div>
    </div>
  );
}
