import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { montant } from '../../lib/argent';
import { dateFr } from '../../lib/tresorerie';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { Alerte, Champ, EnTetePage, Fenetre, MontantFort, Pastille, Vide } from '../../components/ui';

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

interface Situation {
  id: string;
  achats: number;
  total_achats: number;
  total_paye: number;
  reste_du: number;
  prochaine_echeance: string | null;
  dernier_achat: string | null;
}

export function Fournisseurs() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const { fournisseurs, charger, creer } = useFournisseurs(org);
  const [edition, setEdition] = useState<Partial<Fournisseur> | null>(null);
  const [erreur, setErreur] = useState('');
  const [situation, setSituation] = useState<Record<string, Situation>>({});
  const voitSituation = peut('fournisseurs.consulter') || peut('achats.consulter');

  useEffect(() => {
    if (!voitSituation) return;
    void supabase.rpc('situation_fournisseurs', { p_org: org }).then(({ data }) => {
      setSituation(Object.fromEntries(((data ?? []) as Situation[]).map((x) => [x.id, x])));
    });
  }, [org, voitSituation, fournisseurs]);
  const totalDu = Object.values(situation).reduce((t, x) => t + Number(x.reste_du), 0);

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
        sousTitre="Fiches, achats, dettes et paiements. Touchez un fournisseur pour voir son historique et le payer."
        actions={
          (peut('fournisseurs.creer') || peut('stock.creer') || peut('achats.creer')) && (
            <button className="bouton bouton-principal" onClick={() => setEdition({ actif: true })}>
              Nouveau fournisseur
            </button>
          )
        }
      />
      {voitSituation && (
        <section className="tuiles">
          <div className="tuile tuile-fixe">
            <span className="tuile-valeur"><MontantFort v={totalDu} /></span>
            <span className="tuile-libelle">reste dû aux fournisseurs</span>
          </div>
          <div className="tuile tuile-fixe">
            <span className="tuile-valeur">{fournisseurs.filter((f) => f.actif).length}</span>
            <span className="tuile-libelle">fournisseurs actifs</span>
          </div>
        </section>
      )}
      <section className="carte">
        {fournisseurs.length === 0 ? (
          <Vide>Aucun fournisseur.</Vide>
        ) : (
          <table className="tableau">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Téléphone</th>
                {voitSituation && <th className="nombre col-secondaire">Achats</th>}
                {voitSituation && <th className="nombre">Reste dû</th>}
                {voitSituation && <th className="col-secondaire">Échéance</th>}
                <th>Statut</th>
                <th aria-label="Modifier" />
              </tr>
            </thead>
            <tbody>
              {fournisseurs.map((f) => {
                const s = situation[f.id];
                const enRetard = s?.prochaine_echeance && s.prochaine_echeance < new Date().toISOString().slice(0, 10);
                return (
                  <tr key={f.id} className="ligne-cliquable" onClick={() => (voitSituation ? naviguer(`/fournisseurs/${f.id}`) : setEdition(f))}>
                    <td>
                      <strong>{f.nom}</strong>
                      {f.adresse && <div className="secondaire">{f.adresse}</div>}
                    </td>
                    <td>{f.telephone ?? '—'}</td>
                    {voitSituation && <td className="nombre col-secondaire">{montant(s?.total_achats ?? 0)}</td>}
                    {voitSituation && <td className="nombre">{Number(s?.reste_du ?? 0) > 0 ? <strong>{montant(s!.reste_du)}</strong> : '—'}</td>}
                    {voitSituation && (
                      <td className="col-secondaire">
                        {s?.prochaine_echeance ? <Pastille ton={enRetard ? 'rouge' : 'or'}>{dateFr(s.prochaine_echeance)}</Pastille> : '—'}
                      </td>
                    )}
                    <td>{f.actif ? <Pastille ton="vert">Actif</Pastille> : <Pastille ton="gris">Inactif</Pastille>}</td>
                    <td>
                      <button
                        type="button"
                        className="bouton-lien"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEdition(f);
                        }}
                      >
                        Modifier
                      </button>
                    </td>
                  </tr>
                );
              })}
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
