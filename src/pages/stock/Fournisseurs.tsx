import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { Alerte, Champ, EnTetePage, Fenetre, Pastille, Vide } from '../../components/ui';

export interface Fournisseur {
  id: string;
  nom: string;
  telephone: string | null;
  email: string | null;
  adresse: string | null;
  ncc: string | null;
  note: string | null;
  actif: boolean;
}

export function useFournisseurs(org: string) {
  const [fournisseurs, setFournisseurs] = useState<Fournisseur[]>([]);
  const charger = useCallback(async () => {
    const { data } = await supabase.from('fournisseurs').select('*').eq('organisation_id', org).order('nom');
    setFournisseurs((data ?? []) as Fournisseur[]);
  }, [org]);
  useEffect(() => {
    void charger();
  }, [charger]);
  /** Renvoie le fournisseur créé, ou un message d'erreur. */
  const creer = useCallback(
    async (f: Partial<Fournisseur>): Promise<Fournisseur | string> => {
      const { data, error } = await supabase
        .from('fournisseurs')
        .insert({ organisation_id: org, nom: f.nom, telephone: f.telephone ?? null, email: f.email ?? null, adresse: f.adresse ?? null, ncc: f.ncc ?? null, note: f.note ?? null })
        .select('*')
        .single();
      if (error) return /duplicate key/.test(error.message) ? 'Un fournisseur porte déjà ce nom.' : messageErreur(error);
      await charger();
      return data as Fournisseur;
    },
    [org, charger],
  );
  return { fournisseurs, charger, creer };
}

export function Fournisseurs() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const { fournisseurs, charger, creer } = useFournisseurs(org);
  const [edition, setEdition] = useState<Partial<Fournisseur> | null>(null);
  const [erreur, setErreur] = useState('');

  async function enregistrer(e: FormEvent) {
    e.preventDefault();
    if (!edition) return;
    setErreur('');
    if (edition.id) {
      const { error } = await supabase
        .from('fournisseurs')
        .update({
          nom: edition.nom?.trim(),
          telephone: edition.telephone || null,
          email: edition.email || null,
          adresse: edition.adresse || null,
          ncc: edition.ncc || null,
          note: edition.note || null,
          actif: edition.actif ?? true,
        })
        .eq('id', edition.id);
      if (error) return setErreur(messageErreur(error));
      await charger();
    } else {
      const r = await creer({ ...edition, nom: edition.nom?.trim() });
      if (typeof r === 'string') return setErreur(r);
    }
    setEdition(null);
  }

  const maj = (cle: keyof Fournisseur) => (e: { target: { value: string } }) => setEdition({ ...edition, [cle]: e.target.value });

  return (
    <>
      <EnTetePage
        icone="🚚" titre="Fournisseurs"
        sousTitre="Coordonnées des fournisseurs. Les factures, dettes et paiements viendront avec le module tiers."
        actions={
          (peut('fournisseurs.creer') || peut('stock.creer') || peut('achats.creer')) && (
            <button className="bouton bouton-principal" onClick={() => setEdition({ actif: true })}>
              Nouveau fournisseur
            </button>
          )
        }
      />
      <section className="carte">
        {fournisseurs.length === 0 ? (
          <Vide>Aucun fournisseur.</Vide>
        ) : (
          <table className="tableau">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Téléphone</th>
                <th className="col-secondaire">E-mail</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {fournisseurs.map((f) => (
                <tr key={f.id} className="ligne-cliquable" onClick={() => setEdition(f)}>
                  <td>
                    <strong>{f.nom}</strong>
                    {f.adresse && <div className="secondaire">{f.adresse}</div>}
                  </td>
                  <td>{f.telephone ?? '—'}</td>
                  <td className="col-secondaire">{f.email ?? '—'}</td>
                  <td>{f.actif ? <Pastille ton="vert">Actif</Pastille> : <Pastille ton="gris">Inactif</Pastille>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <Fenetre titre={edition?.id ? 'Fournisseur' : 'Nouveau fournisseur'} ouverte={!!edition} onFermer={() => setEdition(null)}>
        {edition && (
          <form className="formulaire" onSubmit={enregistrer}>
            <Alerte>{erreur}</Alerte>
            <Champ label="Nom">
              <input value={edition.nom ?? ''} onChange={maj('nom')} required minLength={2} autoFocus />
            </Champ>
            <div className="grille-2">
              <Champ label="Téléphone">
                <input value={edition.telephone ?? ''} onChange={maj('telephone')} inputMode="tel" />
              </Champ>
              <Champ label="E-mail">
                <input type="email" value={edition.email ?? ''} onChange={maj('email')} />
              </Champ>
              <Champ label="NCC">
                <input value={edition.ncc ?? ''} onChange={maj('ncc')} maxLength={20} />
              </Champ>
              <Champ label="Adresse">
                <input value={edition.adresse ?? ''} onChange={maj('adresse')} />
              </Champ>
            </div>
            <Champ label="Note">
              <input value={edition.note ?? ''} onChange={maj('note')} placeholder="Conditions, jours de livraison…" />
            </Champ>
            {edition.id && (
              <label className="case">
                <input type="checkbox" checked={edition.actif ?? true} onChange={(e) => setEdition({ ...edition, actif: e.target.checked })} />
                Fournisseur actif
              </label>
            )}
            <button className="bouton bouton-principal">Enregistrer</button>
          </form>
        )}
      </Fenetre>
    </>
  );
}
