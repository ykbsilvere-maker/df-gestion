import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { clavierMontant, lireMontant, montant } from '../../lib/argent';
import { quantite, useMagasinCourant, useMagasins } from '../../lib/stock';
import type { Produit } from '../../lib/types';
import { Alerte, Champ, EnTetePage, Pastille, Vide } from '../../components/ui';
import { RechercheProduit, type ProduitTrouve } from '../../components/RechercheProduit';
import { useFournisseurs } from './Fournisseurs';

interface Reception {
  id: string;
  numero: string;
  magasin_id: string;
  fournisseur_id: string | null;
  date_reception: string;
  reference: string | null;
  frais_approche: number | string;
  note: string | null;
  statut: 'brouillon' | 'validee' | 'annulee';
  valide_le: string | null;
  created_at: string;
}

interface LigneReception {
  id: string;
  produit_id: string;
  quantite: number | string;
  prix_unitaire: number | string;
  numero_lot: string | null;
  date_peremption: string | null;
  cout_unitaire: number | string | null;
  created_at: string;
}

const STATUTS = {
  brouillon: { ton: 'or', libelle: 'Brouillon' },
  validee: { ton: 'vert', libelle: 'Validée' },
  annulee: { ton: 'gris', libelle: 'Annulée' },
} as const;

export function ListeReceptions() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const magasins = useMagasins(org);
  const [magasin] = useMagasinCourant(org, magasins);
  const { fournisseurs } = useFournisseurs(org);
  const [liste, setListe] = useState<(Reception & { total: number })[]>([]);
  const [erreur, setErreur] = useState('');
  const peutCreer = peut('stock.creer') || peut('achats.creer');

  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase
        .from('receptions')
        .select('*')
        .eq('organisation_id', org)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) return setErreur(messageErreur(error));
      const rec = (data ?? []) as Reception[];
      const { data: lignes } = rec.length
        ? await supabase.from('receptions_lignes').select('reception_id, quantite, prix_unitaire').in('reception_id', rec.map((r) => r.id))
        : { data: [] };
      const totaux = new Map<string, number>();
      for (const l of (lignes ?? []) as { reception_id: string; quantite: number; prix_unitaire: number }[])
        totaux.set(l.reception_id, (totaux.get(l.reception_id) ?? 0) + Number(l.quantite) * Number(l.prix_unitaire));
      setListe(rec.map((r) => ({ ...r, total: (totaux.get(r.id) ?? 0) + Number(r.frais_approche) })));
    })();
  }, [org]);

  async function nouvelle() {
    if (!magasin) return;
    const { data, error } = await supabase
      .from('receptions')
      .insert({ organisation_id: org, magasin_id: magasin })
      .select('id')
      .single();
    if (error) return setErreur(messageErreur(error));
    naviguer(`/stock/receptions/${data.id}`);
  }

  const nom = (id: string | null, liste_: { id: string; nom: string }[]) => liste_.find((x) => x.id === id)?.nom ?? '—';

  return (
    <>
      <EnTetePage
        icone="📥" titre="Réceptions"
        sousTitre="Entrées de marchandises fournisseurs. Le brouillon se complète au scan, puis la validation met le stock à jour."
        actions={
          peutCreer && (
            <button className="bouton bouton-principal" onClick={() => void nouvelle()} disabled={!magasin}>
              Nouvelle réception
            </button>
          )
        }
      />
      <Alerte>{erreur}</Alerte>
      <section className="carte">
        {liste.length === 0 ? (
          <Vide>Aucune réception.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  <th>N°</th>
                  <th>Date</th>
                  <th className="col-secondaire">Magasin</th>
                  <th>Fournisseur</th>
                  <th className="nombre">Montant</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {liste.map((r) => (
                  <tr key={r.id} className="ligne-cliquable" onClick={() => naviguer(`/stock/receptions/${r.id}`)}>
                    <td className="code">{r.numero}</td>
                    <td>{new Date(r.date_reception).toLocaleDateString('fr-FR')}</td>
                    <td className="col-secondaire">{nom(r.magasin_id, magasins)}</td>
                    <td>{nom(r.fournisseur_id, fournisseurs)}</td>
                    <td className="nombre">{montant(r.total)}</td>
                    <td>
                      <Pastille ton={STATUTS[r.statut].ton}>{STATUTS[r.statut].libelle}</Pastille>
                    </td>
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

export function FicheReception() {
  const { id } = useParams();
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const magasins = useMagasins(org);
  const { fournisseurs, creer: creerFournisseur } = useFournisseurs(org);
  const [r, setR] = useState<Reception | null>(null);
  const [lignes, setLignes] = useState<LigneReception[]>([]);
  const [produits, setProduits] = useState<Record<string, Produit>>({});
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [envoi, setEnvoi] = useState(false);

  const charger = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.from('receptions').select('*').eq('id', id!).single(),
      supabase.from('receptions_lignes').select('*').eq('reception_id', id!).order('created_at'),
    ]);
    if (a.error) return setErreur(messageErreur(a.error));
    setR(a.data as Reception);
    const ls = (b.data ?? []) as LigneReception[];
    setLignes(ls);
    const manquants = ls.map((l) => l.produit_id).filter((pid) => !produits[pid]);
    if (manquants.length) {
      const { data } = await supabase.from('produits').select('*').in('id', manquants);
      setProduits((p) => ({ ...p, ...Object.fromEntries(((data ?? []) as Produit[]).map((x) => [x.id, x])) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    void charger();
  }, [charger]);

  const brouillon = r?.statut === 'brouillon';
  const modifiable = brouillon && (peut('stock.creer') || peut('achats.creer'));
  const totalMarchandises = useMemo(
    () => lignes.reduce((s, l) => s + Number(l.quantite) * Number(l.prix_unitaire), 0),
    [lignes],
  );

  async function majEntete(champs: Partial<Reception>) {
    if (!r) return;
    setR({ ...r, ...champs });
    const { error } = await supabase.from('receptions').update(champs).eq('id', r.id);
    if (error) setErreur(messageErreur(error));
  }

  async function ajouter(p: ProduitTrouve) {
    setErreur('');
    const existante = lignes.find((l) => l.produit_id === p.id && !l.numero_lot && !l.date_peremption);
    if (existante) {
      // Scanner à nouveau le même article ajoute une unité.
      await majLigne(existante, { quantite: Number(existante.quantite) + 1 });
      return;
    }
    const { data: prod } = await supabase.from('produits').select('*').eq('id', p.id).single();
    const produit = prod as Produit;
    setProduits((x) => ({ ...x, [produit.id]: produit }));
    const { error } = await supabase.from('receptions_lignes').insert({
      organisation_id: org,
      reception_id: r!.id,
      produit_id: p.id,
      quantite: 1,
      prix_unitaire: Number(produit.prix_achat ?? 0),
    });
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

  async function majLigne(l: LigneReception, champs: Partial<LigneReception>) {
    setLignes((ls) => ls.map((x) => (x.id === l.id ? { ...x, ...champs } : x)));
    const { error } = await supabase.from('receptions_lignes').update(champs).eq('id', l.id);
    if (error) {
      setErreur(messageErreur(error));
      await charger();
    }
  }

  async function supprimerLigne(l: LigneReception) {
    const { error } = await supabase.from('receptions_lignes').delete().eq('id', l.id);
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

  async function valider() {
    if (!r || envoi) return;
    if (!window.confirm(`Valider la réception ${r.numero} ? Le stock sera mis à jour et la réception ne sera plus modifiable.`)) return;
    setEnvoi(true);
    setErreur('');
    const { error } = await supabase.rpc('valider_reception', { p_reception: r.id });
    setEnvoi(false);
    if (error) return setErreur(messageErreur(error));
    setInfo('Réception validée : le stock est à jour.');
    await charger();
  }

  async function annuler() {
    if (!r || !window.confirm('Annuler ce brouillon de réception ?')) return;
    const { error } = await supabase.rpc('annuler_reception', { p_reception: r.id });
    if (error) return setErreur(messageErreur(error));
    naviguer('/stock/receptions');
  }

  async function nouveauFournisseur() {
    const nom = window.prompt('Nom du fournisseur');
    if (!nom?.trim()) return;
    const f = await creerFournisseur({ nom: nom.trim() });
    if (typeof f === 'string') return setErreur(f);
    await majEntete({ fournisseur_id: f.id });
  }

  if (!r) return <EnTetePage titre="Réception" sousTitre="Chargement…" />;

  return (
    <>
      <EnTetePage
        titre={`Réception ${r.numero}`}
        sousTitre={
          brouillon
            ? 'Brouillon enregistré automatiquement. Scannez les articles reçus, vérifiez quantités et prix, puis validez.'
            : r.statut === 'validee'
              ? `Validée le ${new Date(r.valide_le!).toLocaleString('fr-FR')}`
              : 'Réception annulée'
        }
        actions={
          <>
            <Pastille ton={STATUTS[r.statut].ton}>{STATUTS[r.statut].libelle}</Pastille>
            <button className="bouton bouton-discret" onClick={() => naviguer('/stock/receptions')}>
              Retour
            </button>
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      <section className="carte">
        <fieldset disabled={!modifiable} className="sans-bordure">
          <div className="grille-4">
            <Champ label="Magasin">
              <select value={r.magasin_id} onChange={(e) => void majEntete({ magasin_id: e.target.value })}>
                {magasins.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nom}
                  </option>
                ))}
              </select>
            </Champ>
            <Champ label="Fournisseur">
              <div className="champ-avec-bouton">
                <select value={r.fournisseur_id ?? ''} onChange={(e) => void majEntete({ fournisseur_id: e.target.value || null })}>
                  <option value="">Non précisé</option>
                  {fournisseurs.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.nom}
                    </option>
                  ))}
                </select>
                <button type="button" className="bouton bouton-discret" onClick={() => void nouveauFournisseur()} title="Nouveau fournisseur">
                  +
                </button>
              </div>
            </Champ>
            <Champ label="Date de réception">
              <input type="date" value={r.date_reception} onChange={(e) => void majEntete({ date_reception: e.target.value })} />
            </Champ>
            <Champ label="N° BL / facture fournisseur">
              <input defaultValue={r.reference ?? ''} onBlur={(e) => void majEntete({ reference: e.target.value.trim() || null })} />
            </Champ>
          </div>
        </fieldset>
      </section>

      <section className="carte">
        {modifiable && <RechercheProduit org={org} onChoisir={(p) => void ajouter(p)} autoFocus />}
        {lignes.length === 0 ? (
          <Vide>Aucun article. Scannez ou cherchez le premier produit reçu.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau tableau-saisie">
              <thead>
                <tr>
                  <th>Produit</th>
                  <th className="nombre">Quantité</th>
                  <th className="nombre">Prix d’achat unitaire</th>
                  <th>Lot / péremption</th>
                  <th className="nombre">Montant</th>
                  {r.statut === 'validee' && <th className="nombre">Coût de revient</th>}
                  {modifiable && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {lignes.map((l) => {
                  const p = produits[l.produit_id];
                  return (
                    <tr key={l.id}>
                      <td>
                        <strong>{p?.designation ?? '…'}</strong>
                        <div className="secondaire">{p?.unite}</div>
                      </td>
                      <td className="nombre">
                        {modifiable ? (
                          <input
                            className="champ-nombre"
                            inputMode="decimal"
                            defaultValue={quantite(l.quantite)}
                            key={`q-${l.id}-${l.quantite}`}
                            onBlur={(e) => {
                              const v = Number(e.target.value.replace(/\s/g, '').replace(',', '.'));
                              if (v > 0 && v !== Number(l.quantite)) void majLigne(l, { quantite: v });
                            }}
                            aria-label={`Quantité ${p?.designation ?? ''}`}
                          />
                        ) : (
                          quantite(l.quantite)
                        )}
                      </td>
                      <td className="nombre">
                        {modifiable ? (
                          <input
                            className="champ-nombre champ-prix"
                            inputMode={clavierMontant()}
                            defaultValue={montant(l.prix_unitaire, '')}
                            key={`p-${l.id}-${l.prix_unitaire}`}
                            onBlur={(e) => {
                              const v = lireMontant(e.target.value) ?? 0;
                              if (v !== Number(l.prix_unitaire)) void majLigne(l, { prix_unitaire: v });
                            }}
                            aria-label={`Prix d'achat ${p?.designation ?? ''}`}
                          />
                        ) : (
                          montant(l.prix_unitaire)
                        )}
                      </td>
                      <td>
                        {p?.gere_peremption || l.numero_lot || l.date_peremption ? (
                          modifiable ? (
                            <div className="lot-saisie">
                              <input
                                placeholder="N° lot"
                                defaultValue={l.numero_lot ?? ''}
                                onBlur={(e) => void majLigne(l, { numero_lot: e.target.value.trim() || null })}
                              />
                              <input
                                type="date"
                                defaultValue={l.date_peremption ?? ''}
                                onChange={(e) => void majLigne(l, { date_peremption: e.target.value || null })}
                                aria-label="Date de péremption"
                              />
                            </div>
                          ) : (
                            <span className="secondaire">
                              {[l.numero_lot, l.date_peremption && new Date(l.date_peremption).toLocaleDateString('fr-FR')]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          )
                        ) : (
                          <span className="secondaire">—</span>
                        )}
                      </td>
                      <td className="nombre">{montant(Number(l.quantite) * Number(l.prix_unitaire))}</td>
                      {r.statut === 'validee' && <td className="nombre">{montant(l.cout_unitaire ?? 0)}</td>}
                      {modifiable && (
                        <td>
                          <button className="bouton-lien lien-danger" onClick={() => void supprimerLigne(l)} aria-label="Retirer la ligne">
                            Retirer
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="totaux-piece">
          <div>
            <span>Marchandises</span>
            <strong>{montant(totalMarchandises)}</strong>
          </div>
          <div>
            <span>Frais d’approche (transport, manutention…)</span>
            {modifiable ? (
              <input
                className="champ-nombre champ-prix"
                inputMode={clavierMontant()}
                defaultValue={montant(r.frais_approche, '')}
                onBlur={(e) => void majEntete({ frais_approche: lireMontant(e.target.value) ?? 0 })}
                aria-label="Frais d'approche"
              />
            ) : (
              <strong>{montant(r.frais_approche)}</strong>
            )}
          </div>
          <div className="total-piece">
            <span>Coût total de la réception</span>
            <strong>{montant(totalMarchandises + Number(r.frais_approche))}</strong>
          </div>
          <p className="secondaire">
            Les frais d’approche sont répartis sur les articles au prorata de leur valeur et intégrés au coût moyen.
          </p>
        </div>

        {brouillon && (
          <div className="actions-piece">
            {modifiable && (
              <button className="bouton-lien lien-danger" onClick={() => void annuler()}>
                Annuler le brouillon
              </button>
            )}
            {(peut('stock.valider') || peut('achats.valider')) && (
              <button className="bouton bouton-principal" disabled={envoi || lignes.length === 0} onClick={() => void valider()}>
                {envoi ? 'Validation…' : 'Valider la réception'}
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
