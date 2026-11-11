import { BoutonsExport } from '../../components/Export';
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { deviseCourante, enUnites, montant } from '../../lib/argent';
import { quantite, telechargerCsv, useMagasinCourant, useMagasins } from '../../lib/stock';
import { Alerte, EnTetePage, MontantFort, Pastille, Vide } from '../../components/ui';

interface LigneEtat {
  produit_id: string;
  code: string;
  designation: string;
  unite: string;
  statut: string;
  seuil_min: number | null;
  seuil_max: number | null;
  prix_vente: number;
  quantite: number | string;
  cout_moyen: number | string;
  valeur: number | string;
}

function etatLigne(l: LigneEtat): { ton: 'vert' | 'or' | 'rouge' | 'gris'; libelle: string } {
  const q = Number(l.quantite);
  if (q < 0) return { ton: 'rouge', libelle: 'Négatif' };
  if (q === 0) return { ton: l.seuil_min != null ? 'rouge' : 'gris', libelle: 'Rupture' };
  if (l.seuil_min != null && q <= l.seuil_min) return { ton: 'or', libelle: 'Sous le minimum' };
  if (l.seuil_max != null && q > l.seuil_max) return { ton: 'gris', libelle: 'Surstock' };
  return { ton: 'vert', libelle: 'Disponible' };
}

export function EtatStock() {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const magasins = useMagasins(org);
  const [magasinTravail] = useMagasinCourant(org, magasins);
  const [magasin, setMagasin] = useState<string>('');
  const [lignes, setLignes] = useState<LigneEtat[]>([]);
  const [filtre, setFiltre] = useState('');
  const [masquerVides, setMasquerVides] = useState(true);
  const [erreur, setErreur] = useState('');
  const [majLe, setMajLe] = useState<Date | null>(null);

  useEffect(() => {
    if (magasinTravail && magasin === '') setMagasin(magasinTravail);
  }, [magasinTravail, magasin]);

  useEffect(() => {
    if (!magasin) return;
    void supabase
      .rpc('etat_stock', { p_org: org, p_magasin: magasin === 'tous' ? null : magasin })
      .then(({ data, error }) => {
        if (error) return setErreur(messageErreur(error));
        setLignes((data ?? []) as LigneEtat[]);
        setMajLe(new Date());
      });
  }, [org, magasin]);

  const visibles = useMemo(() => {
    const f = filtre.trim().toLowerCase();
    return lignes.filter(
      (l) =>
        (!masquerVides || Number(l.quantite) !== 0 || l.seuil_min != null) &&
        (l.statut !== 'arrete' || Number(l.quantite) !== 0) &&
        (!f || l.designation.toLowerCase().includes(f) || l.code.toLowerCase().includes(f)),
    );
  }, [lignes, filtre, masquerVides]);
  const totalValeur = visibles.reduce((s, l) => s + Number(l.valeur), 0);
  const nomMagasin = magasin === 'tous' ? 'Tous les magasins' : magasins.find((m) => m.id === magasin)?.nom ?? '';

  return (
    <>
      <EnTetePage
        icone="📦" titre="État du stock"
        sousTitre="Quantités et valeur au coût moyen pondéré (CMP). Chaque quantité résulte des mouvements enregistrés."
        actions={
          <div className="actions-entete">
            <BoutonsExport
              disabled={!visibles.length}
              onExport={(format) =>
                telechargerCsv(
                `stock-${nomMagasin}-${new Date().toISOString().slice(0, 10)}.csv`,
                ['Code', 'Désignation', 'Unité', 'Quantité', `CMP (${deviseCourante().code})`, `Valeur (${deviseCourante().code})`, 'Stock minimum', 'État'],
                visibles.map((l) => [l.code, l.designation, l.unite, Number(l.quantite), enUnites(l.cout_moyen), enUnites(l.valeur), l.seuil_min, etatLigne(l).libelle]),
                  format,
                )
              }
            />
          </div>
        }
      />
      <Alerte>{erreur}</Alerte>
      <section className="carte filtres">
        <label className="champ">
          <span className="champ-label">Magasin</span>
          <select value={magasin} onChange={(e) => setMagasin(e.target.value)}>
            {magasins.length > 1 && <option value="tous">Tous les magasins</option>}
            {magasins.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nom}
              </option>
            ))}
          </select>
        </label>
        <label className="champ">
          <span className="champ-label">Filtrer</span>
          <input type="search" value={filtre} onChange={(e) => setFiltre(e.target.value)} placeholder="Nom ou code" />
        </label>
        <label className="case case-alignee">
          <input type="checkbox" checked={masquerVides} onChange={(e) => setMasquerVides(e.target.checked)} />
          Masquer les produits sans stock ni minimum
        </label>
      </section>

      <section className="tuiles">
        <div className="tuile">
          <span className="tuile-valeur"><MontantFort v={totalValeur} /></span>
          <span className="tuile-libelle">valeur du stock affiché (au CMP)</span>
        </div>
        <div className="tuile">
          <span className="tuile-valeur">{visibles.filter((l) => Number(l.quantite) > 0).length}</span>
          <span className="tuile-libelle">produits en stock</span>
        </div>
        <div className="tuile tuile-attention">
          <span className="tuile-valeur">{visibles.filter((l) => ['Rupture', 'Sous le minimum', 'Négatif'].includes(etatLigne(l).libelle)).length}</span>
          <span className="tuile-libelle">ruptures ou sous le minimum</span>
        </div>
      </section>

      <section className="carte">
        {visibles.length === 0 ? (
          <Vide>Aucun stock enregistré. Commencez par une réception.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Produit</th>
                  <th className="nombre">Quantité</th>
                  <th className="nombre col-secondaire">CMP</th>
                  <th className="nombre">Valeur</th>
                  <th className="nombre col-secondaire">Minimum</th>
                  <th>État</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((l) => {
                  const e = etatLigne(l);
                  return (
                    <tr key={l.produit_id}>
                      <td>
                        <strong>{l.designation}</strong>
                        <div className="secondaire code">{l.code}</div>
                      </td>
                      <td className="nombre">
                        {quantite(l.quantite)} <span className="secondaire">{l.unite}</span>
                      </td>
                      <td className="nombre col-secondaire">{montant(l.cout_moyen)}</td>
                      <td className="nombre">{montant(l.valeur)}</td>
                      <td className="nombre col-secondaire">{l.seuil_min ?? '—'}</td>
                      <td>
                        <Pastille ton={e.ton}>{e.libelle}</Pastille>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {majLe && (
          <p className="secondaire">
            {nomMagasin} — actualisé à {majLe.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}. Valeur = quantité ×
            coût moyen pondéré, frais d’approche inclus.
          </p>
        )}
      </section>
    </>
  );
}
