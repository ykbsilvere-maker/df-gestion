import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { montant } from '../../lib/argent';
import { LIBELLES_MOUVEMENTS, nouvelleCle, quantite, TYPES_SORTIE_MANUELLE, useMagasinCourant, useMagasins } from '../../lib/stock';
import { Alerte, Champ, EnTetePage, Vide } from '../../components/ui';
import { RechercheProduit, type ProduitTrouve } from '../../components/RechercheProduit';

interface Mouvement {
  id: number;
  type: string;
  quantite: number | string;
  valeur: number | string;
  motif: string | null;
  produit_id: string;
  created_at: string;
}

interface LotDispo {
  lot_id: string;
  quantite: number;
  numero: string;
  date_peremption: string | null;
}

export function Sorties() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const magasins = useMagasins(org);
  const [magasin, setMagasin] = useMagasinCourant(org, magasins);
  const [produit, setProduit] = useState<ProduitTrouve | null>(null);
  const [disponible, setDisponible] = useState(0);
  const [lots, setLots] = useState<LotDispo[]>([]);
  const [lot, setLot] = useState('');
  const [type, setType] = useState('perte');
  const [qte, setQte] = useState('');
  const [motif, setMotif] = useState('');
  const [cle, setCle] = useState(nouvelleCle());
  const [recents, setRecents] = useState<(Mouvement & { designation?: string })[]>([]);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const peutAjuster = peut('stock.valider');

  async function chargerRecents() {
    if (!magasin) return;
    const { data } = await supabase
      .from('mouvements_stock')
      .select('id, type, quantite, valeur, motif, produit_id, created_at')
      .eq('organisation_id', org)
      .eq('magasin_id', magasin)
      .in('type', TYPES_SORTIE_MANUELLE.map((t) => t.code))
      .order('id', { ascending: false })
      .limit(15);
    const mv = (data ?? []) as Mouvement[];
    const ids = [...new Set(mv.map((m) => m.produit_id))];
    const { data: p } = ids.length ? await supabase.from('produits').select('id, designation').in('id', ids) : { data: [] };
    const noms = new Map(((p ?? []) as { id: string; designation: string }[]).map((x) => [x.id, x.designation]));
    setRecents(mv.map((m) => ({ ...m, designation: noms.get(m.produit_id) })));
  }

  useEffect(() => {
    void chargerRecents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [magasin]);

  useEffect(() => {
    if (!produit || !magasin) return;
    void (async () => {
      const { data } = await supabase.from('stocks').select('quantite').eq('magasin_id', magasin).eq('produit_id', produit.id).maybeSingle();
      setDisponible(Number(data?.quantite ?? 0));
      const { data: sl } = await supabase
        .from('stocks_lots')
        .select('lot_id, quantite, lots(numero, date_peremption)')
        .eq('magasin_id', magasin)
        .eq('produit_id', produit.id)
        .gt('quantite', 0);
      setLots(
        ((sl ?? []) as unknown as { lot_id: string; quantite: number; lots: { numero: string; date_peremption: string | null } }[]).map((x) => ({
          lot_id: x.lot_id,
          quantite: Number(x.quantite),
          numero: x.lots?.numero ?? '',
          date_peremption: x.lots?.date_peremption ?? null,
        })),
      );
      setLot('');
    })();
  }, [produit, magasin]);

  async function enregistrer(e: FormEvent) {
    e.preventDefault();
    if (!produit || envoi) return;
    setErreur('');
    setInfo('');
    const q = Number(qte.replace(',', '.'));
    if (!(q > 0)) return setErreur('Indiquez une quantité positive.');
    setEnvoi(true);
    const { error } = await supabase.rpc('enregistrer_mouvement_manuel', {
      p_org: org,
      p_magasin: magasin,
      p_produit: produit.id,
      p_type: type,
      p_quantite: q,
      p_motif: motif,
      p_lot: lot || null,
      p_cle: cle,
    });
    setEnvoi(false);
    if (error) return setErreur(messageErreur(error));
    setInfo(`${LIBELLES_MOUVEMENTS[type]} enregistré(e) : ${quantite(q)} ${produit.unite} de « ${produit.designation} ».`);
    setProduit(null);
    setQte('');
    setMotif('');
    setCle(nouvelleCle());
    await chargerRecents();
  }

  return (
    <>
      <EnTetePage
        icone="📤" titre="Sorties et ajustements"
        sousTitre="Pertes, casses, vols, avaries, produits périmés, consommation interne. Chaque mouvement est motivé, valorisé et inscrit au journal."
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      <form className="carte formulaire" onSubmit={enregistrer}>
        <div className="grille-2">
          <Champ label="Magasin">
            <select value={magasin} onChange={(e) => setMagasin(e.target.value)}>
              {magasins.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nom}
                </option>
              ))}
            </select>
          </Champ>
          <Champ label="Nature">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES_SORTIE_MANUELLE.filter((t) => !t.ajustement || peutAjuster).map((t) => (
                <option key={t.code} value={t.code}>
                  {t.libelle}
                </option>
              ))}
            </select>
          </Champ>
        </div>
        {produit ? (
          <div className="produit-choisi">
            <div>
              <strong>{produit.designation}</strong>
              <div className="secondaire">
                Stock actuel : {quantite(disponible)} {produit.unite}
              </div>
            </div>
            <button type="button" className="bouton-lien" onClick={() => setProduit(null)}>
              Changer
            </button>
          </div>
        ) : (
          <RechercheProduit org={org} onChoisir={setProduit} />
        )}
        {lots.length > 0 && (
          <Champ label="Lot concerné" aide="Facultatif ; recommandé pour un produit périmé">
            <select value={lot} onChange={(e) => setLot(e.target.value)}>
              <option value="">Sans précision de lot</option>
              {lots.map((l) => (
                <option key={l.lot_id} value={l.lot_id}>
                  {[l.numero || 'Lot', l.date_peremption && `péremption ${new Date(l.date_peremption).toLocaleDateString('fr-FR')}`].filter(Boolean).join(' · ')} — {quantite(l.quantite)}
                </option>
              ))}
            </select>
          </Champ>
        )}
        <div className="grille-2">
          <Champ label="Quantité">
            <input value={qte} onChange={(e) => setQte(e.target.value)} inputMode="decimal" required />
          </Champ>
          <Champ label="Motif (obligatoire)">
            <input value={motif} onChange={(e) => setMotif(e.target.value)} required minLength={3} placeholder="Ex. carton abîmé à la livraison" />
          </Champ>
        </div>
        <button className="bouton bouton-principal" disabled={envoi || !produit}>
          {envoi ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </form>

      <section className="carte">
        <h2>Derniers mouvements de ce magasin</h2>
        {recents.length === 0 ? (
          <Vide>Aucune sortie ni ajustement.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Nature</th>
                  <th>Produit</th>
                  <th className="nombre">Quantité</th>
                  <th className="nombre">Valeur</th>
                  <th className="col-secondaire">Motif</th>
                </tr>
              </thead>
              <tbody>
                {recents.map((m) => (
                  <tr key={m.id}>
                    <td>{new Date(m.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td>{LIBELLES_MOUVEMENTS[m.type]}</td>
                    <td>{m.designation}</td>
                    <td className="nombre">{quantite(m.quantite)}</td>
                    <td className="nombre">{montant(m.valeur)}</td>
                    <td className="col-secondaire">{m.motif}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
