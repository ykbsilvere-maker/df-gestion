import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Garde-fou (incident 1.3, pages blanches) : un effet React écrit « useEffect(() => expression) »
// renvoie la valeur de l'expression. Si c'est une promesse (scrollTo() dans les navigateurs récents,
// un appel réseau…), React la prend pour une fonction de nettoyage et toute l'application plante
// au changement de page. Les effets doivent toujours avoir un corps entre accolades.
function fichiers(dossier: string): string[] {
  return readdirSync(dossier).flatMap((n) => {
    const c = join(dossier, n);
    return statSync(c).isDirectory() ? fichiers(c) : /\.tsx?$/.test(n) ? [c] : [];
  });
}

describe('Effets React', () => {
  it('ont toujours un corps entre accolades', () => {
    const fautifs: string[] = [];
    for (const f of fichiers('src')) {
      const lignes = readFileSync(f, 'utf8').split('\n');
      lignes.forEach((l, i) => {
        if (/use(Layout)?Effect\(\s*(async\s*)?\(\)\s*=>\s*(?!\{)\S/.test(l)) fautifs.push(`${f}:${i + 1}`);
      });
    }
    expect(fautifs).toEqual([]);
  });
});
