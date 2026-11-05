import { DEVISES } from '../lib/argent';

/** Liste des monnaies proposées (XOF en premier). */
export function ChoixDevise({ valeur, onChange, disabled }: { valeur: string; onChange: (code: string) => void; disabled?: boolean }) {
  return (
    <select value={valeur} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label="Monnaie">
      {Object.values(DEVISES).map((d) => (
        <option key={d.code} value={d.code}>
          {d.drapeau} {d.code} — {d.libelle}
        </option>
      ))}
    </select>
  );
}
