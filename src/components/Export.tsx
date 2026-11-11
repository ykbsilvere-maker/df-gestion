import { useState } from 'react';
import type { FormatExport } from '../lib/export';

/** Deux boutons d'export : Excel et PDF. L'export porte sur toutes les lignes, pas seulement la page affichée. */
export function BoutonsExport({ onExport, disabled }: { onExport: (format: FormatExport) => void | Promise<void>; disabled?: boolean }) {
  const [enCours, setEnCours] = useState<FormatExport | null>(null);
  const lancer = async (f: FormatExport) => {
    setEnCours(f);
    try {
      await onExport(f);
    } finally {
      setEnCours(null);
    }
  };
  return (
    <>
      <button type="button" className="bouton bouton-discret" disabled={disabled || !!enCours} onClick={() => void lancer('xlsx')}>
        {enCours === 'xlsx' ? 'Préparation…' : '⬇️ Excel'}
      </button>
      <button type="button" className="bouton bouton-discret" disabled={disabled || !!enCours} onClick={() => void lancer('pdf')}>
        {enCours === 'pdf' ? 'Préparation…' : '📄 PDF'}
      </button>
    </>
  );
}

/** Pages « précédent / suivant », avec la possibilité de tout dérouler d'un coup. */
export function Pagination({
  page,
  encore,
  tout,
  nombre,
  setPage,
  setTout,
  precedent = 'Précédents',
  suivant = 'Suivants',
}: {
  page: number;
  encore: boolean;
  tout: boolean;
  nombre: number;
  setPage: (p: number) => void;
  setTout: (t: boolean) => void;
  precedent?: string;
  suivant?: string;
}) {
  if (tout)
    return (
      <div className="pagination">
        <span>
          <strong>{nombre.toLocaleString('fr-FR')}</strong> ligne{nombre > 1 ? 's' : ''} affichée{nombre > 1 ? 's' : ''} (tout)
        </span>
        <button type="button" className="bouton bouton-discret" onClick={() => { setPage(0); setTout(false); }}>
          Revenir aux pages
        </button>
      </div>
    );
  return (
    <div className="pagination">
      <button type="button" className="bouton bouton-discret" disabled={page === 0} onClick={() => setPage(page - 1)}>
        {precedent}
      </button>
      <span>Page {page + 1}</span>
      <button type="button" className="bouton bouton-discret" disabled={!encore} onClick={() => setPage(page + 1)}>
        {suivant}
      </button>
      {(encore || page > 0) && (
        <button type="button" className="bouton bouton-principal" onClick={() => setTout(true)}>
          Tout afficher
        </button>
      )}
    </div>
  );
}
