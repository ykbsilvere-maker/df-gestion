import { classeurXlsx, telechargerFichier, TYPE_XLSX, type Feuille } from './excel';
import { classeurPdf, TYPE_PDF } from './pdf';

export type FormatExport = 'xlsx' | 'pdf';

let entreprise = '';
/** Nom de l'entreprise rappelé en tête des PDF. */
export function definirEntrepriseExport(nom: string | undefined) {
  entreprise = nom ?? '';
}

/** Même contenu en Excel (.xlsx) ou en PDF, selon le bouton choisi. */
export function exporterClasseur(nom: string, feuilles: Feuille[], format: FormatExport = 'xlsx'): boolean {
  const base = nom.replace(/\.(xlsx|csv|pdf)$/i, '');
  return format === 'pdf'
    ? telechargerFichier(`${base}.pdf`, TYPE_PDF, classeurPdf(feuilles, { entreprise }))
    : telechargerFichier(`${base}.xlsx`, TYPE_XLSX, classeurXlsx(feuilles));
}

/** Charge toutes les lignes d'une liste, par tranches de 1 000 (limite du serveur par requête). */
export async function toutCharger<T>(
  tranche: (debut: number, fin: number) => PromiseLike<{ data: unknown; error: unknown }>,
  max = 20000,
): Promise<T[]> {
  const res: T[] = [];
  for (let debut = 0; debut < max; debut += 1000) {
    const { data, error } = await tranche(debut, debut + 999);
    if (error) throw error;
    const lot = (data ?? []) as T[];
    res.push(...lot);
    if (lot.length < 1000) break;
  }
  return res;
}
