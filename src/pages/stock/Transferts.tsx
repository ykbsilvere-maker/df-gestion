import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { nouvelleCle, quantite, useMagasinCourant, useMagasins } from '../../lib/stock';
import { Alerte, Champ, EnTetePage, Vide } from '../../components/ui';
import { RechercheProduit, type ProduitTrouve } from '../../components/RechercheProduit';

interface Ligne {
  produit: ProduitTrouve;
  disponible: number;
  quantite: string;
}

interface TransfertListe {
  id: string;
  numero: string;
  magasin_source_id: string;
  magasin_destination_id: string;
  note: string | null;
  created_at: string;
}

export function Transferts() {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const magasins = useMagasins(org);
  const [magasinTravail] = useMagasinCourant(org, magasins);
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [note, setNote] = useState('');
  const [cle, setCle] = useState(nouvelleCle());
  const [historique, setHistorique] = useState<TransfertListe[]>([]);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [envoi, setEnvoi] = useState(false);

  useEffect(() => {
    if (!source && magasinTravail) setSource(magasinTravail);
  }, [magasinTravail, source]);
  // La destination doit toujours être un autre magasin que la source.
  useEffect(() => {
    if (!source || magasins.length < 2) return;
    if (!destination || destination === source) setDestination(magasins.find((m) => m.id !== source)?.id ?? '');
  }, [magasins, source, destination]);

  async function chargerHistorique() {
    const { data } = await supabase.from('transferts').select('*').eq('organisation_id', org).order('created_at', { ascending: false }).limit(20);
    setHistorique((data ?? []) as TransfertListe[]);
  }
  useEffect(() => {
    void chargerHistorique();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  async function ajouter(p: ProduitTrouve) {
    const existante = lignes.find((l) => l.produit.id === p.id);
    if (existante) {
      setLignes(lignes.map((l) => (l === existante ? { ...l, quantite: String(Number(l.quantite || 0) + 1) } : l)));
      return;
    }
    const { data } = await supabase.from('stocks').select('quantite').eq('magasin_id', source).eq('produit_id', p.id).maybeSingle();
    setLignes([...lignes, { produit: p, disponible: Number(data?.quantite ?? 0), quantite: '1' }]);
  }

  async function valider() {
    setErreur('');
    setInfo('');
    if (!source || !destination || source === destination) return setErreur('Choisissez deux magasins différents.');
    const contenu = lignes
      .map((l) => ({ produit_id: l.produit.id, quantite: Number(l.quantite.replace(',', '.')) }))
      .filter((l) => l.quantite > 0);
    if (!contenu.length) return setErreur('Ajoutez au moins un produit.');
    setEnvoi(true);
    const { data, error } = await supabase.rpc('transferer_stock', {
      p_org: org,
      p_source: source,
      p_destination: destination,
      p_lignes: contenu,
      p_note: note || null,
      p_cle: cle,
    });
    setEnvoi(false);
    if (error) return setErreur(messageErreur(error));
    setInfo(`Transfert ${data as string} enregistré.`);
    setLignes([]);
    setNote('');
    setCle(nouvelleCle());
    await chargerHistorique();
  }

  const nom = (id: string) => magasins.find((m) => m.id === id)?.nom ?? '—';

  if (magasins.length < 2)
    return (
      <>
        <EnTetePage titre="Transferts" />
        <Vide>Il faut au moins deux magasins accessibles pour transférer du stock.</Vide>
      </>
    );

  return (
    <>
      <EnTetePage icone="🔁" titre="Transferts entre magasins" sousTitre="La marchandise sort du magasin de départ et entre dans le magasin d’arrivée, au même coût." />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      <section className="carte formulaire">
        <div className="grille-2">
          <Champ label="Depuis">
            <select value={source} onChange={(e) => { setSource(e.target.value); setLignes([]); }}>
              {magasins.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nom}
                </option>
              ))}
            </select>
          </Champ>
          <Champ label="Vers">
            <select value={destination} onChange={(e) => setDestination(e.target.value)}>
              {magasins.filter((m) => m.id !== source).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nom}
                </option>
              ))}
            </select>
          </Champ>
        </div>
        <RechercheProduit org={org} onChoisir={(p) => void ajouter(p)} />
        {lignes.length > 0 && (
          <table className="tableau tableau-saisie">
            <thead>
              <tr>
                <th>Produit</th>
                <th className="nombre">Disponible</th>
                <th className="nombre">À transférer</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {lignes.map((l, i) => (
                <tr key={l.produit.id}>
                  <td>{l.produit.designation}</td>
                  <td className="nombre">{quantite(l.disponible)}</td>
                  <td className="nombre">
                    <input
                      className="champ-nombre"
                      inputMode="decimal"
                      value={l.quantite}
                      onChange={(e) => setLignes(lignes.map((x, j) => (j === i ? { ...x, quantite: e.target.value } : x)))}
                      aria-label={`Quantité à transférer ${l.produit.designation}`}
                    />
                  </td>
                  <td>
                    <button className="bouton-lien lien-danger" onClick={() => setLignes(lignes.filter((_, j) => j !== i))}>
                      Retirer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Champ label="Note">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex. réassort du samedi" />
        </Champ>
        <button className="bouton bouton-principal" disabled={envoi || !lignes.length} onClick={() => void valider()}>
          {envoi ? 'Transfert…' : 'Valider le transfert'}
        </button>
      </section>

      <section className="carte">
        <h2>Derniers transferts</h2>
        {historique.length === 0 ? (
          <Vide>Aucun transfert.</Vide>
        ) : (
          <ul className="liste-simple">
            {historique.map((t) => (
              <li key={t.id}>
                <span>
                  <span className="code">{t.numero}</span> · {nom(t.magasin_source_id)} → {nom(t.magasin_destination_id)}
                  {t.note && <span className="secondaire"> · {t.note}</span>}
                </span>
                <time>{new Date(t.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
