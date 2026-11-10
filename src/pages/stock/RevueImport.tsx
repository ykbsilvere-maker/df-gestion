import { useEffect, useMemo, useRef, useState } from 'react';
import { cleFichier, type Analyse, type LigneImport } from '../../lib/importTableur';

type Champ = 'designation' | 'prix_achat' | 'prix_vente' | 'quantite' | 'fournisseur';
const LIBELLES: Record<Champ, string> = {
  designation: 'Désignation',
  prix_achat: 'Prix d’achat',
  prix_vente: 'Prix de vente',
  quantite: 'Quantité',
  fournisseur: 'Fournisseur',
};
const PAR_PAGE = 40;

function Vignette({ image }: { image: LigneImport['image'] }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!image) return setUrl('');
    const u = URL.createObjectURL(new Blob([image.octets.slice().buffer as ArrayBuffer], { type: image.type }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [image]);
  return url ? <img src={url} alt="" /> : <span aria-hidden>📷</span>;
}

async function imageDe(f: File): Promise<NonNullable<LigneImport['image']>> {
  return { octets: new Uint8Array(await f.arrayBuffer()), type: f.type || 'image/jpeg' };
}

/**
 * Vérification avant l'import : chaque ligne du fichier, avec un menu pour le fournisseur et un
 * bouton pour prendre la photo sur l'ordinateur (ou le téléphone). Les modifications restent
 * dans l'import ; le fichier Excel n'est pas changé.
 */
export function RevueLignes({
  analyse,
  type,
  fournisseurs,
  onChange,
}: {
  analyse: Analyse;
  type: 'catalogue' | 'approvisionnement';
  fournisseurs: string[];
  onChange: (a: Analyse) => void;
}) {
  const [terme, setTerme] = useState('');
  const [nombre, setNombre] = useState(PAR_PAGE);
  const [message, setMessage] = useState('');
  const plusieurs = useRef<HTMLInputElement>(null);
  const champs: Champ[] = type === 'catalogue' ? ['designation', 'prix_achat', 'prix_vente', 'fournisseur'] : ['designation', 'quantite', 'prix_achat', 'fournisseur'];
  const avecPhoto = type === 'catalogue';

  const options = useMemo(() => {
    const noms = new Map<string, string>();
    for (const n of [...fournisseurs, ...analyse.lignes.map((l) => String(l.valeurs.fournisseur ?? ''))]) {
      const t = n.trim();
      if (t && !noms.has(cleFichier(t))) noms.set(cleFichier(t), t);
    }
    return [...noms.values()].sort((a, b) => a.localeCompare(b, 'fr'));
  }, [fournisseurs, analyse.lignes]);

  const visibles = useMemo(() => {
    const t = cleFichier(terme);
    return analyse.lignes.map((l, i) => ({ l, i })).filter(({ l }) => !t || cleFichier(`${l.valeurs.designation ?? ''} ${l.valeurs.code ?? ''}`).includes(t));
  }, [analyse.lignes, terme]);

  function modifier(i: number, maj: (l: LigneImport) => LigneImport) {
    const lignes = analyse.lignes.map((l, k) => (k === i ? maj(l) : l));
    onChange({ ...analyse, lignes, images: lignes.filter((l) => l.image).length });
  }
  const valeur = (i: number, cle: string, v: string) => modifier(i, (l) => ({ ...l, valeurs: { ...l.valeurs, [cle]: v === '' ? null : v } }));

  /** Plusieurs photos d'un coup : rattachées par nom (code, code-barres, désignation ou nom indiqué). */
  async function photosGroupees(liste: FileList | null) {
    if (!liste?.length) return;
    const index = new Map<string, number>();
    analyse.lignes.forEach((l, i) => {
      for (const v of [l.valeurs.photo, l.valeurs.code, l.valeurs.code_barres, l.valeurs.designation]) if (v) index.set(cleFichier(String(v)), i);
    });
    const lignes = [...analyse.lignes];
    let ok = 0;
    const perdues: string[] = [];
    for (const f of Array.from(liste)) {
      const i = index.get(cleFichier(f.name));
      if (i === undefined) perdues.push(f.name);
      else {
        lignes[i] = { ...lignes[i]!, image: await imageDe(f) };
        ok++;
      }
    }
    onChange({ ...analyse, lignes, images: lignes.filter((l) => l.image).length });
    setMessage(`${ok} photo${ok > 1 ? 's' : ''} rattachée${ok > 1 ? 's' : ''}${perdues.length ? ` · sans article du même nom : ${perdues.join(', ')}` : ''}.`);
  }

  return (
    <div className="revue-import">
      <div className="revue-outils">
        {analyse.lignes.length > 8 && (
          <input type="search" value={terme} onChange={(e) => { setTerme(e.target.value); setNombre(PAR_PAGE); }} placeholder="Chercher un article…" aria-label="Chercher un article" />
        )}
        {avecPhoto && (
          <>
            <input ref={plusieurs} type="file" accept="image/*" multiple hidden onChange={(e) => { void photosGroupees(e.target.files); e.target.value = ''; }} />
            <button type="button" className="bouton bouton-discret" onClick={() => plusieurs.current?.click()} title="Images nommées comme les articles (code, code-barres ou désignation)">
              🖼️ Plusieurs photos d’un coup
            </button>
          </>
        )}
      </div>
      {message && <p className="secondaire petit-texte">{message}</p>}
      <div className="defilement-horizontal">
        <table className="tableau revue-tableau">
          <thead>
            <tr>
              <th>Ligne</th>
              {avecPhoto && <th>Photo</th>}
              {champs.map((c) => (
                <th key={c}>{LIBELLES[c]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibles.slice(0, nombre).map(({ l, i }) => (
              <tr key={l.numero}>
                <td className="secondaire">{l.numero}</td>
                {avecPhoto && (
                  <td>
                    <label className={`revue-photo${l.image ? ' avec' : ''}`} title={l.image ? 'Changer la photo' : 'Choisir la photo sur l’appareil'}>
                      <input
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          if (f) {
                            const image = await imageDe(f);
                            modifier(i, (x) => ({ ...x, image }));
                          }
                        }}
                      />
                      <Vignette image={l.image} />
                    </label>
                    {l.image && (
                      <button type="button" className="revue-retirer" onClick={() => modifier(i, (x) => ({ ...x, image: undefined }))} aria-label="Retirer la photo">
                        ✕
                      </button>
                    )}
                  </td>
                )}
                {champs.map((c) => (
                  <td key={c}>
                    {c === 'fournisseur' ? (
                      <select value={String(l.valeurs.fournisseur ?? '')} onChange={(e) => valeur(i, 'fournisseur', e.target.value)} aria-label="Fournisseur">
                        <option value="">{type === 'catalogue' ? '—' : 'Habituel / par défaut'}</option>
                        {options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={c === 'designation' ? 'revue-texte' : 'revue-nombre'}
                        inputMode={c === 'designation' ? undefined : 'decimal'}
                        value={String(l.valeurs[c] ?? '')}
                        onChange={(e) => valeur(i, c, e.target.value)}
                        aria-label={LIBELLES[c]}
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visibles.length > nombre && (
        <button type="button" className="bouton bouton-discret" onClick={() => setNombre((n) => n + PAR_PAGE)}>
          Afficher {Math.min(PAR_PAGE, visibles.length - nombre)} lignes de plus ({visibles.length - nombre} restantes)
        </button>
      )}
    </div>
  );
}
