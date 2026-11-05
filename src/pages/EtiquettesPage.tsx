import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { useIdentite } from '../lib/identite';
import { messageErreur } from '../lib/format';
import type { Produit } from '../lib/types';
import { Alerte, Champ, EnTetePage } from '../components/ui';
import { PLANCHES, PlancheEtiquettes, type Etiquette } from '../impression/Etiquettes';
import { useImpression } from '../impression/impression';

interface Ligne {
  produit: Produit;
  codes: string[];
  code: string;
  quantite: number;
}

/** Impression d'étiquettes code-barres + prix sur planches A4 autocollantes. */
export function EtiquettesPage() {
  const { peut } = useSession();
  const { identite } = useIdentite();
  const { imprimer } = useImpression();
  const etat = useLocation().state as { produits?: string[] } | null;
  const naviguer = useNavigate();
  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [format, setFormat] = useState(PLANCHES[0]!.code);
  const [debut, setDebut] = useState(1);
  const [afficherPrix, setAfficherPrix] = useState(true);
  const [afficherNom, setAfficherNom] = useState(true);
  const [erreur, setErreur] = useState('');

  async function charger(ids: string[]) {
    if (!ids.length) return setLignes([]);
    const [p, c] = await Promise.all([
      supabase.from('produits').select('*').in('id', ids).order('designation'),
      supabase.from('codes_barres').select('produit_id, code, created_at').in('produit_id', ids).order('created_at'),
    ]);
    if (p.error) return setErreur(messageErreur(p.error));
    const codes = (c.data ?? []) as { produit_id: string; code: string }[];
    setLignes(
      (p.data as Produit[]).map((produit) => {
        const siens = codes.filter((x) => x.produit_id === produit.id).map((x) => x.code);
        return { produit, codes: siens, code: siens[0] ?? '', quantite: 1 };
      }),
    );
  }

  useEffect(() => {
    void charger(etat?.produits ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function creerCode(l: Ligne) {
    setErreur('');
    const { error } = await supabase.rpc('generer_code_barres', { p_produit: l.produit.id });
    if (error) return setErreur(messageErreur(error));
    await charger(lignes.map((x) => x.produit.id));
  }

  const planche = PLANCHES.find((p) => p.code === format)!;
  const etiquettes: Etiquette[] = useMemo(
    () =>
      lignes
        .filter((l) => l.code)
        .flatMap((l) =>
          Array.from({ length: Math.max(0, l.quantite) }, () => ({
            designation: l.produit.designation,
            prix: Number(l.produit.prix_vente),
            code: l.code,
          })),
        ),
    [lignes],
  );
  const sansCode = lignes.filter((l) => !l.code).length;
  const parFeuille = planche.colonnes * planche.rangees;

  return (
    <>
      <EnTetePage
        icone="🏷️" titre="Étiquettes code-barres"
        sousTitre="Planches autocollantes A4. Indiquez le nombre d’étiquettes par produit, puis imprimez."
        actions={
          <button className="bouton bouton-discret" onClick={() => naviguer('/catalogue')}>
            Retour au catalogue
          </button>
        }
      />
      <Alerte>{erreur}</Alerte>
      {lignes.length === 0 && (
        <Alerte type="info">Sélectionnez des produits dans le catalogue (cases à cocher), puis « Étiquettes ».</Alerte>
      )}

      <div className="grille-personnalisation">
        <div className="colonne-formulaire">
          <section className="carte">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Produit</th>
                  <th>Code-barres</th>
                  <th className="nombre">Nombre</th>
                </tr>
              </thead>
              <tbody>
                {lignes.map((l, i) => (
                  <tr key={l.produit.id}>
                    <td>{l.produit.designation}</td>
                    <td>
                      {l.codes.length > 1 ? (
                        <select
                          value={l.code}
                          onChange={(e) => setLignes(lignes.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))}
                        >
                          {l.codes.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      ) : l.code ? (
                        <span className="code">{l.code}</span>
                      ) : peut('catalogue.modifier') || peut('catalogue.creer') ? (
                        <button className="bouton-lien" onClick={() => void creerCode(l)}>
                          Créer un code
                        </button>
                      ) : (
                        <span className="secondaire">aucun</span>
                      )}
                    </td>
                    <td className="nombre">
                      <input
                        type="number"
                        min={0}
                        max={500}
                        value={l.quantite}
                        onChange={(e) =>
                          setLignes(lignes.map((x, j) => (j === i ? { ...x, quantite: Math.max(0, Number(e.target.value)) } : x)))
                        }
                        className="champ-nombre"
                        aria-label={`Nombre d’étiquettes pour ${l.produit.designation}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sansCode > 0 && <p className="secondaire">{sansCode} produit(s) sans code-barres ne seront pas imprimés.</p>}
          </section>

          <section className="carte formulaire">
            <Champ label="Planche">
              <select value={format} onChange={(e) => setFormat(e.target.value)}>
                {PLANCHES.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.libelle}
                  </option>
                ))}
              </select>
            </Champ>
            <Champ label="Commencer à l’étiquette n°" aide="Pour réutiliser une planche déjà entamée">
              <input type="number" min={1} max={parFeuille} value={debut} onChange={(e) => setDebut(Number(e.target.value) || 1)} />
            </Champ>
            <label className="case">
              <input type="checkbox" checked={afficherPrix} onChange={(e) => setAfficherPrix(e.target.checked)} />
              Afficher le prix
            </label>
            <label className="case">
              <input type="checkbox" checked={afficherNom} onChange={(e) => setAfficherNom(e.target.checked)} />
              Afficher le nom de la boutique
            </label>
            <button
              className="bouton bouton-principal"
              disabled={etiquettes.length === 0}
              onClick={() =>
                void imprimer(
                  <PlancheEtiquettes
                    format={planche}
                    debut={debut}
                    etiquettes={etiquettes}
                    nomBoutique={afficherNom ? identite?.organisation.nom : undefined}
                    afficherPrix={afficherPrix}
                  />,
                  'a4',
                )
              }
            >
              Imprimer {etiquettes.length} étiquette{etiquettes.length > 1 ? 's' : ''}
            </button>
          </section>
        </div>

        <aside className="colonne-apercu">
          <section className="carte">
            <h2>Aperçu (1re feuille)</h2>
            <div className="cadre-planche">
              <PlancheEtiquettes
                format={planche}
                debut={debut}
                etiquettes={etiquettes.slice(0, parFeuille - debut + 1)}
                nomBoutique={afficherNom ? identite?.organisation.nom : undefined}
                afficherPrix={afficherPrix}
                apercu
              />
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
