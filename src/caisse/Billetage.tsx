import { deviseCourante, libelleCoupure, montant } from '../lib/argent';

export interface LigneBilletage {
  valeur: number;
  nombre: number;
}

/** Coupures de la devise (billets puis pièces), avec une clé stable. */
export function coupuresDevise() {
  const d = deviseCourante();
  return [
    ...d.billets.map((v) => ({ cle: `b${v}`, valeur: v, piece: false })),
    ...d.pieces.map((v) => ({ cle: `p${v}`, valeur: v, piece: true })),
  ];
}

export const totalBilletage = (n: Record<string, number>) =>
  coupuresDevise().reduce((s, c) => s + c.valeur * (n[c.cle] || 0), 0);

/** Pour le serveur : [{ valeur, nombre }] (billets et pièces de même valeur regroupés). */
export function versLignes(n: Record<string, number>): LigneBilletage[] {
  const parValeur = new Map<number, number>();
  for (const c of coupuresDevise()) if (n[c.cle]) parValeur.set(c.valeur, (parValeur.get(c.valeur) ?? 0) + n[c.cle]!);
  return [...parValeur.entries()].map(([valeur, nombre]) => ({ valeur, nombre }));
}

/** Comptage du fond, coupure par coupure : − nombre +, sous-total, total. */
export function Billetage({ nombres, onChange }: { nombres: Record<string, number>; onChange: (n: Record<string, number>) => void }) {
  const coupures = coupuresDevise();
  const fixer = (cle: string, v: number) => onChange({ ...nombres, [cle]: Math.max(0, Math.floor(v || 0)) });
  return (
    <div className="billetage">
      {(['billets', 'pieces'] as const).map((groupe) => (
        <div key={groupe} className="billetage-groupe">
          <span className="billetage-titre">{groupe === 'billets' ? '💵 Billets' : '🪙 Pièces'}</span>
          {coupures
            .filter((c) => c.piece === (groupe === 'pieces'))
            .map((c) => {
              const n = nombres[c.cle] ?? 0;
              return (
                <div key={c.cle} className={`billetage-ligne ${n > 0 ? 'rempli' : ''}`}>
                  <span className="billetage-valeur">{libelleCoupure(c.valeur)}</span>
                  <div className="choix-quantite petit">
                    <button type="button" aria-label={`Moins de ${libelleCoupure(c.valeur)}`} disabled={!n} onClick={() => fixer(c.cle, n - 1)}>
                      −
                    </button>
                    <input
                      inputMode="numeric"
                      value={n || ''}
                      placeholder="0"
                      aria-label={`Nombre de ${libelleCoupure(c.valeur)}`}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => fixer(c.cle, Number(e.target.value.replace(/\D/g, '')))}
                    />
                    <button type="button" aria-label={`Plus de ${libelleCoupure(c.valeur)}`} onClick={() => fixer(c.cle, n + 1)}>
                      +
                    </button>
                  </div>
                  <span className="billetage-sous-total">{n ? montant(c.valeur * n, '') : ''}</span>
                </div>
              );
            })}
        </div>
      ))}
      <div className="billetage-total">
        <span>Total compté</span>
        <strong>{montant(totalBilletage(nombres))}</strong>
      </div>
    </div>
  );
}
