import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { deviseCourante, enUnites, montant } from '../../lib/argent';
import { LIBELLES_MOUVEMENTS, quantite, telechargerCsv, useMagasins } from '../../lib/stock';
import { Alerte, Champ, EnTetePage, Vide } from '../../components/ui';
import { RechercheProduit, type ProduitTrouve } from '../../components/RechercheProduit';

interface Mouvement {
  id: number;
  magasin_id: string;
  produit_id: string;
  type: string;
  quantite: number | string;
  cout_unitaire: number | string;
  valeur: number | string;
  quantite_apres: number | string | null;
  piece_type: string | null;
  motif: string | null;
  cree_par: string | null;
  created_at: string;
}

const PAR_PAGE = 50;

export function Mouvements() {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const magasins = useMagasins(org);
  const [magasin, setMagasin] = useState('');
  const [type, setType] = useState('');
  const [produit, setProduit] = useState<ProduitTrouve | null>(null);
  const [du, setDu] = useState('');
  const [au, setAu] = useState('');
  const [page, setPage] = useState(0);
  const [lignes, setLignes] = useState<Mouvement[]>([]);
  const [encore, setEncore] = useState(false);
  const [noms, setNoms] = useState<Record<string, string>>({});
  const [auteurs, setAuteurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState('');

  const requete = useCallback(
    (limite: number, decalage: number) => {
      let q = supabase
        .from('mouvements_stock')
        .select('*')
        .eq('organisation_id', org)
        .order('id', { ascending: false })
        .range(decalage, decalage + limite);
      if (magasin) q = q.eq('magasin_id', magasin);
      if (type) q = q.eq('type', type);
      if (produit) q = q.eq('produit_id', produit.id);
      if (du) q = q.gte('created_at', `${du}T00:00:00Z`);
      if (au) q = q.lte('created_at', `${au}T23:59:59.999Z`);
      return q;
    },
    [org, magasin, type, produit, du, au],
  );

  async function completerNoms(mv: Mouvement[]) {
    const ids = [...new Set(mv.map((m) => m.produit_id))].filter((i) => !noms[i]);
    const users = [...new Set(mv.map((m) => m.cree_par).filter(Boolean) as string[])].filter((i) => !auteurs[i]);
    const [p, u] = await Promise.all([
      ids.length ? supabase.from('produits').select('id, designation').in('id', ids) : Promise.resolve({ data: [] }),
      users.length ? supabase.from('profils').select('id, nom_complet, email').in('id', users) : Promise.resolve({ data: [] }),
    ]);
    const n = { ...noms, ...Object.fromEntries(((p.data ?? []) as { id: string; designation: string }[]).map((x) => [x.id, x.designation])) };
    const a = { ...auteurs, ...Object.fromEntries(((u.data ?? []) as { id: string; nom_complet: string | null; email: string }[]).map((x) => [x.id, x.nom_complet || x.email])) };
    setNoms(n);
    setAuteurs(a);
    return { n, a };
  }

  useEffect(() => {
    void (async () => {
      const { data, error } = await requete(PAR_PAGE, page * PAR_PAGE);
      if (error) return setErreur(messageErreur(error));
      const mv = (data ?? []) as Mouvement[];
      setEncore(mv.length > PAR_PAGE);
      const visibles = mv.slice(0, PAR_PAGE);
      setLignes(visibles);
      await completerNoms(visibles);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requete, page]);

  async function exporter() {
    const { data } = await requete(5000, 0);
    const mv = (data ?? []) as Mouvement[];
    const { n, a } = await completerNoms(mv);
    telechargerCsv(
      `mouvements-stock-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Date', 'Magasin', 'Produit', 'Nature', 'Quantité', `Coût unitaire (${deviseCourante().code})`, `Valeur (${deviseCourante().code})`, 'Stock après', 'Motif', 'Auteur'],
      mv.map((m) => [
        new Date(m.created_at).toLocaleString('fr-FR'),
        magasins.find((x) => x.id === m.magasin_id)?.nom,
        n[m.produit_id],
        LIBELLES_MOUVEMENTS[m.type],
        Number(m.quantite),
        enUnites(m.cout_unitaire),
        enUnites(m.valeur),
        m.quantite_apres == null ? '' : Number(m.quantite_apres),
        m.motif,
        m.cree_par ? a[m.cree_par] : '',
      ]),
    );
  }

  const reinitialiser = (fn: () => void) => {
    fn();
    setPage(0);
  };

  return (
    <>
      <EnTetePage
        icone="🔄" titre="Mouvements de stock"
        sousTitre="Registre complet et non modifiable : chaque entrée, sortie, transfert et ajustement, avec son coût et son auteur."
        actions={
          <button className="bouton bouton-discret" onClick={() => void exporter()} disabled={!lignes.length}>
            Exporter (Excel)
          </button>
        }
      />
      <Alerte>{erreur}</Alerte>
      <section className="carte filtres">
        <Champ label="Magasin">
          <select value={magasin} onChange={(e) => reinitialiser(() => setMagasin(e.target.value))}>
            <option value="">Tous</option>
            {magasins.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nom}
              </option>
            ))}
          </select>
        </Champ>
        <Champ label="Nature">
          <select value={type} onChange={(e) => reinitialiser(() => setType(e.target.value))}>
            <option value="">Toutes</option>
            {Object.entries(LIBELLES_MOUVEMENTS).map(([code, libelle]) => (
              <option key={code} value={code}>
                {libelle}
              </option>
            ))}
          </select>
        </Champ>
        <Champ label="Du">
          <input type="date" value={du} onChange={(e) => reinitialiser(() => setDu(e.target.value))} />
        </Champ>
        <Champ label="Au">
          <input type="date" value={au} onChange={(e) => reinitialiser(() => setAu(e.target.value))} />
        </Champ>
        <div className="champ filtre-produit">
          <span className="champ-label">Produit</span>
          {produit ? (
            <div className="produit-choisi produit-choisi-compact">
              <strong>{produit.designation}</strong>
              <button type="button" className="bouton-lien" onClick={() => reinitialiser(() => setProduit(null))}>
                Retirer
              </button>
            </div>
          ) : (
            <RechercheProduit org={org} onChoisir={(p) => reinitialiser(() => setProduit(p))} placeholder="Tous les produits" />
          )}
        </div>
      </section>
      <section className="carte">
        {lignes.length === 0 ? (
          <Vide>Aucun mouvement pour ces critères.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Produit</th>
                  <th>Nature</th>
                  <th className="nombre">Quantité</th>
                  <th className="nombre col-secondaire">Coût unitaire</th>
                  <th className="nombre">Valeur</th>
                  <th className="nombre col-secondaire">Stock après</th>
                  <th className="col-secondaire">Motif / auteur</th>
                </tr>
              </thead>
              <tbody>
                {lignes.map((m) => (
                  <tr key={m.id}>
                    <td>{new Date(m.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td>
                      {noms[m.produit_id] ?? '…'}
                      {!magasin && magasins.length > 1 && (
                        <div className="secondaire">{magasins.find((x) => x.id === m.magasin_id)?.nom}</div>
                      )}
                    </td>
                    <td>{LIBELLES_MOUVEMENTS[m.type]}</td>
                    <td className={`nombre ${Number(m.quantite) < 0 ? 'texte-negatif' : 'texte-positif'}`}>
                      {Number(m.quantite) > 0 ? '+' : ''}
                      {quantite(m.quantite)}
                    </td>
                    <td className="nombre col-secondaire">{montant(m.cout_unitaire)}</td>
                    <td className="nombre">{montant(m.valeur)}</td>
                    <td className="nombre col-secondaire">{m.quantite_apres == null ? '—' : quantite(m.quantite_apres)}</td>
                    <td className="col-secondaire">
                      {m.motif}
                      {m.cree_par && <div className="secondaire">{auteurs[m.cree_par]}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pagination">
          <button className="bouton bouton-discret" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Plus récents
          </button>
          <span>Page {page + 1}</span>
          <button className="bouton bouton-discret" disabled={!encore} onClick={() => setPage(page + 1)}>
            Plus anciens
          </button>
        </div>
      </section>
    </>
  );
}
