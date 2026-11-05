import { CodeBarre } from '../components/CodeBarre';
import { montant } from '../lib/argent';

export interface FormatPlanche {
  code: string;
  libelle: string;
  colonnes: number;
  rangees: number;
  largeur: number; // mm
  hauteur: number; // mm
  margeHaut: number; // mm
  margeGauche: number; // mm
}

/** Planches d'étiquettes autocollantes A4 courantes (dimensions en mm). */
export const PLANCHES: FormatPlanche[] = [
  { code: '3x8', libelle: '24 étiquettes (70 × 37 mm)', colonnes: 3, rangees: 8, largeur: 70, hauteur: 37.125, margeHaut: 0, margeGauche: 0 },
  { code: '3x7', libelle: '21 étiquettes (70 × 42,4 mm)', colonnes: 3, rangees: 7, largeur: 70, hauteur: 42.4, margeHaut: 0, margeGauche: 0 },
  { code: '4x10', libelle: '40 étiquettes (52,5 × 29,7 mm)', colonnes: 4, rangees: 10, largeur: 52.5, hauteur: 29.7, margeHaut: 0, margeGauche: 0 },
];

export interface Etiquette {
  designation: string;
  prix: number;
  code: string;
}

/**
 * Une ou plusieurs feuilles A4 d'étiquettes. `debut` permet de commencer à la n-ième
 * étiquette d'une planche déjà entamée.
 */
export function PlancheEtiquettes({
  format,
  debut = 1,
  etiquettes,
  nomBoutique,
  afficherPrix = true,
  apercu = false,
}: {
  format: FormatPlanche;
  debut?: number;
  etiquettes: Etiquette[];
  nomBoutique?: string;
  afficherPrix?: boolean;
  apercu?: boolean;
}) {
  const parFeuille = format.colonnes * format.rangees;
  const decalage = Math.min(Math.max(debut, 1), parFeuille) - 1;
  const cases: (Etiquette | null)[] = [...Array(decalage).fill(null), ...etiquettes];
  const feuilles: (Etiquette | null)[][] = [];
  for (let i = 0; i < cases.length; i += parFeuille) feuilles.push(cases.slice(i, i + parFeuille));
  if (feuilles.length === 0) feuilles.push([]);
  const petite = format.hauteur < 32;

  return (
    <>
      {feuilles.map((feuille, f) => (
        <div
          key={f}
          className={`planche-a4 ${apercu ? 'feuille-apercu' : ''}`}
          style={{
            gridTemplateColumns: `repeat(${format.colonnes}, ${format.largeur}mm)`,
            gridTemplateRows: `repeat(${format.rangees}, ${format.hauteur}mm)`,
            paddingTop: `${format.margeHaut}mm`,
            paddingLeft: `${format.margeGauche}mm`,
          }}
        >
          {Array.from({ length: parFeuille }, (_, i) => {
            const e = feuille[i];
            return (
              <div key={i} className={`etiquette ${petite ? 'etiquette-petite' : ''}`}>
                {e && (
                  <>
                    {nomBoutique && !petite && <div className="etiquette-boutique">{nomBoutique}</div>}
                    <div className="etiquette-designation">{e.designation}</div>
                    {afficherPrix && <div className="etiquette-prix">{montant(e.prix)}</div>}
                    <CodeBarre code={e.code} hauteur={petite ? 22 : 30} largeurBarre={petite ? 1.15 : 1.4} taillePolice={petite ? 9 : 11} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
