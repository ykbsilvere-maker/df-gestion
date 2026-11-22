import { classeurXlsx, telechargerFichier, TYPE_XLSX, type Feuille } from './excel';
import { classeurPdf, TYPE_PDF } from './pdf';
import { documentWord, TYPE_DOCX } from './word';

export type FormatExport = 'xlsx' | 'pdf' | 'docx';

let entreprise = '';
/** Nom de l'entreprise rappelé en tête des PDF. */
export function definirEntrepriseExport(nom: string | undefined) {
  entreprise = nom ?? '';
}

/** Même contenu en Excel (.xlsx), PDF ou Word (.docx), selon le bouton choisi. */
export function exporterClasseur(nom: string, feuilles: Feuille[], format: FormatExport = 'xlsx'): boolean {
  const base = nom.replace(/\.(xlsx|csv|pdf|docx)$/i, '');
  if (format === 'pdf') return telechargerFichier(`${base}.pdf`, TYPE_PDF, classeurPdf(feuilles, { entreprise }));
  if (format === 'docx') return telechargerFichier(`${base}.docx`, TYPE_DOCX, documentWord(feuilles, { entreprise }));
  return telechargerFichier(`${base}.xlsx`, TYPE_XLSX, classeurXlsx(feuilles));
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
