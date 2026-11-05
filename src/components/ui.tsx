import { useEffect, useRef, type ReactNode } from 'react';
import { devise, deviseCourante, nombreMonnaie } from '../lib/argent';

export function Alerte({ type = 'erreur', children }: { type?: 'erreur' | 'succes' | 'info'; children: ReactNode }) {
  if (!children) return null;
  return (
    <div className={`alerte alerte-${type}`} role={type === 'erreur' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Champ({ label, aide, children }: { label: string; aide?: string; children: ReactNode }) {
  return (
    <label className="champ">
      <span className="champ-label">{label}</span>
      {children}
      {aide && <span className="champ-aide">{aide}</span>}
    </label>
  );
}

export function Fenetre({
  titre,
  ouverte,
  onFermer,
  children,
  large,
}: {
  titre: string;
  ouverte: boolean;
  onFermer: () => void;
  children: ReactNode;
  large?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (ouverte && !d.open) d.showModal();
    if (!ouverte && d.open) d.close();
  }, [ouverte]);
  return (
    <dialog ref={ref} className={`fenetre ${large ? 'fenetre-large' : ''}`} onClose={onFermer}>
      <div className="fenetre-entete">
        <h2>{titre}</h2>
        <button type="button" className="bouton-icone" onClick={onFermer} aria-label="Fermer">
          ×
        </button>
      </div>
      <div className="fenetre-corps">{ouverte && children}</div>
    </dialog>
  );
}

export function Pastille({ ton, children }: { ton: 'vert' | 'gris' | 'or' | 'rouge'; children: ReactNode }) {
  return <span className={`pastille pastille-${ton}`}>{children}</span>;
}

export function Vide({ children }: { children: ReactNode }) {
  return <p className="vide">{children}</p>;
}

export function EnTetePage({ titre, sousTitre, actions, icone }: { titre: string; sousTitre?: string; actions?: ReactNode; icone?: string }) {
  return (
    <header className="entete-page">
      <div>
        <h1>
          {icone && (
            <span className="titre-icone" aria-hidden>
              {icone}
            </span>
          )}
          {titre}
        </h1>
        {sousTitre && <p className="sous-titre">{sousTitre}</p>}
      </div>
      {actions && <div className="entete-actions">{actions}</div>}
    </header>
  );
}

/** Montant en grand (tuiles) : le chiffre en avant, la monnaie en plus petit. */
export function MontantFort({ v, code }: { v: number | string | null | undefined; code?: string | null }) {
  const d = code ? devise(code) : deviseCourante();
  return (
    <>
      {nombreMonnaie(v, d)}
      <span className="montant-devise"> {d.symbole}</span>
    </>
  );
}

/** Émoji décoratif : ignoré par les lecteurs d'écran, espacé du texte qui suit. */
export function Ico({ children }: { children: ReactNode }) {
  return (
    <span className="ico" aria-hidden>
      {children}
    </span>
  );
}
