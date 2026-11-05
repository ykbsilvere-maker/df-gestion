import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { montant } from '../../lib/argent';
import { quantite, useMagasinCourant, useMagasins } from '../../lib/stock';
import type { Categorie, Produit } from '../../lib/types';
import { Alerte, Champ, EnTetePage, Fenetre, MontantFort, Pastille, Vide } from '../../components/ui';
import { RechercheProduit, type ProduitTrouve } from '../../components/RechercheProduit';

interface Inventaire {
  id: string;
  numero: string;
  magasin_id: string;
  categorie_id: string | null;
  statut: 'en_cours' | 'valide' | 'annule';
  ecart_valeur: number | string | null;
  created_at: string;
  valide_le: string | null;
}

interface LigneInventaire {
  produit_id: string;
  quantite_theorique: number | string;
  quantite_comptee: number | string | null;
  quantite_systeme: number | string | null;
  ecart: number | string | null;
  ecart_valeur: number | string | null;
}

const STATUTS = {
  en_cours: { ton: 'or', libelle: 'En cours' },
  valide: { ton: 'vert', libelle: 'Validé' },
  annule: { ton: 'gris', libelle: 'Annulé' },
} as const;

export function ListeInventaires() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const magasins = useMagasins(org);
  const [magasin, setMagasin] = useMagasinCourant(org, magasins);
  const [categories, setCategories] = useState<Categorie[]>([]);
  const [liste, setListe] = useState<Inventaire[]>([]);
  const [ouverture, setOuverture] = useState(false);
  const [categorie, setCategorie] = useState('');
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    void supabase.from('inventaires').select('*').eq('organisation_id', org).order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => setListe((data ?? []) as Inventaire[]));
    void supabase.from('categories').select('*').eq('organisation_id', org).order('nom')
      .then(({ data }) => setCategories((data ?? []) as Categorie[]));
  }, [org]);

  async function ouvrir() {
    setErreur('');
    const { data, error } = await supabase.rpc('ouvrir_inventaire', { p_org: org, p_magasin: magasin, p_categorie: categorie || null });
    if (error) return setErreur(messageErreur(error));
    naviguer(`/stock/inventaires/${data as string}`);
  }

  const nom = (id: string) => magasins.find((m) => m.id === id)?.nom ?? '—';

  return (
    <>
      <EnTetePage
        icone="📋"
        titre="Inventaires"
        sousTitre="Comptage physique des produits d’un magasin. À la validation, les écarts deviennent des mouvements de stock valorisés."
        actions={
          peut('stock.creer') && (
            <button className="bouton bouton-principal" onClick={() => setOuverture(true)}>
              Nouvel inventaire
            </button>
          )
        }
      />
      <Alerte>{erreur}</Alerte>
      <section className="carte">
        {liste.length === 0 ? (
          <Vide>Aucun inventaire.</Vide>
        ) : (
          <table className="tableau">
            <thead>
              <tr>
                <th>N°</th>
                <th>Date</th>
                <th className="col-secondaire">Magasin</th>
                <th className="nombre">Écart valorisé</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {liste.map((i) => (
                <tr key={i.id} className="ligne-cliquable" onClick={() => naviguer(`/stock/inventaires/${i.id}`)}>
                  <td className="code">{i.numero}</td>
                  <td>{new Date(i.created_at).toLocaleDateString('fr-FR')}</td>
                  <td className="col-secondaire">{nom(i.magasin_id)}</td>
                  <td className="nombre">{i.ecart_valeur != null ? montant(i.ecart_valeur) : '—'}</td>
                  <td>
                    <Pastille ton={STATUTS[i.statut].ton}>{STATUTS[i.statut].libelle}</Pastille>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <Fenetre titre="Nouvel inventaire" ouverte={ouverture} onFermer={() => setOuverture(false)}>
        <div className="formulaire">
          <Alerte>{erreur}</Alerte>
          <Champ label="Magasin">
            <select value={magasin} onChange={(e) => setMagasin(e.target.value)}>
              {magasins.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nom}
                </option>
              ))}
            </select>
          </Champ>
          <Champ label="Portée" aide="Un inventaire partiel par catégorie (rayon) est plus rapide et peut se faire chaque semaine.">
            <select value={categorie} onChange={(e) => setCategorie(e.target.value)}>
              <option value="">Tous les produits</option>
              {categories.filter((c) => c.actif).map((c) => (
                <option key={c.id} value={c.id}>
                  Catégorie : {c.nom}
                </option>
              ))}
            </select>
          </Champ>
          <button className="bouton bouton-principal" onClick={() => void ouvrir()}>
            Ouvrir l’inventaire
          </button>
        </div>
      </Fenetre>
    </>
  );
}

export function FicheInventaire() {
  const { id } = useParams();
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const magasins = useMagasins(org);
  const [inv, setInv] = useState<Inventaire | null>(null);
  const [lignes, setLignes] = useState<LigneInventaire[]>([]);
  const [produits, setProduits] = useState<Record<string, Produit>>({});
  const [parScan, setParScan] = useState(true);
  const [aveugle, setAveugle] = useState(false);
  const [filtre, setFiltre] = useState<'tous' | 'non_comptes' | 'ecarts'>('tous');
  const [dernier, setDernier] = useState('');
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);

  const charger = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.from('inventaires').select('*').eq('id', id!).single(),
      supabase.from('inventaires_lignes').select('*').eq('inventaire_id', id!),
    ]);
    if (a.error) return setErreur(messageErreur(a.error));
    setInv(a.data as Inventaire);
    const ls = (b.data ?? []) as LigneInventaire[];
    setLignes(ls);
    const ids = ls.map((l) => l.produit_id);
    if (ids.length) {
      const { data } = await supabase.from('produits').select('*').in('id', ids);
      setProduits(Object.fromEntries(((data ?? []) as Produit[]).map((p) => [p.id, p])));
    }
  }, [id]);

  useEffect(() => {
    void charger();
  }, [charger]);

  const enCours = inv?.statut === 'en_cours';
  const peutCompter = enCours && peut('stock.creer');

  async function compter(produitId: string, valeur: number, ajouter: boolean) {
    setErreur('');
    const { data, error } = await supabase.rpc('compter_inventaire', {
      p_inventaire: id,
      p_produit: produitId,
      p_quantite: valeur,
      p_ajouter: ajouter,
    });
    if (error) return setErreur(messageErreur(error));
    const nouvelle = Number(data);
    if (!lignes.some((l) => l.produit_id === produitId)) await charger();
    else setLignes((ls) => ls.map((l) => (l.produit_id === produitId ? { ...l, quantite_comptee: nouvelle } : l)));
    return nouvelle;
  }

  async function scanne(p: ProduitTrouve) {
    if (parScan) {
      const n = await compter(p.id, 1, true);
      if (n !== undefined) setDernier(`${p.designation} : ${quantite(n)} compté(s)`);
    } else {
      const saisie = window.prompt(`Quantité comptée pour « ${p.designation} »`);
      if (saisie === null) return;
      const v = Number(saisie.replace(',', '.'));
      if (v >= 0) {
        await compter(p.id, v, false);
        setDernier(`${p.designation} : ${quantite(v)}`);
      }
    }
  }

  async function valider() {
    if (!inv || envoi) return;
    const nonComptes = lignes.filter((l) => l.quantite_comptee == null).length;
    const msg = `Valider l’inventaire ${inv.numero} ?\n\n${lignes.length - nonComptes} produit(s) compté(s). ${
      nonComptes ? `${nonComptes} produit(s) non compté(s) ne seront pas ajustés.\n` : ''
    }Les écarts seront enregistrés comme mouvements de stock.`;
    if (!window.confirm(msg)) return;
    setEnvoi(true);
    const { error } = await supabase.rpc('valider_inventaire', { p_inventaire: inv.id });
    setEnvoi(false);
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

  async function annuler() {
    if (!inv || !window.confirm('Annuler cet inventaire ? Les comptages saisis seront abandonnés.')) return;
    const { error } = await supabase.rpc('annuler_inventaire', { p_inventaire: inv.id });
    if (error) return setErreur(messageErreur(error));
    naviguer('/stock/inventaires');
  }

  const visibles = useMemo(() => {
    const triees = [...lignes].sort((a, b) => (produits[a.produit_id]?.designation ?? '').localeCompare(produits[b.produit_id]?.designation ?? ''));
    if (filtre === 'non_comptes') return triees.filter((l) => l.quantite_comptee == null);
    if (filtre === 'ecarts')
      return triees.filter((l) =>
        l.quantite_comptee != null &&
        Number(l.quantite_comptee) !== Number(inv?.statut === 'valide' ? l.quantite_systeme : l.quantite_theorique),
      );
    return triees;
  }, [lignes, produits, filtre, inv]);

  if (!inv) return <EnTetePage titre="Inventaire" sousTitre="Chargement…" />;
  const comptes = lignes.filter((l) => l.quantite_comptee != null).length;
  const nomMagasin = magasins.find((m) => m.id === inv.magasin_id)?.nom ?? '';

  return (
    <>
      <EnTetePage
        titre={`Inventaire ${inv.numero}`}
        sousTitre={`${nomMagasin} · ouvert le ${new Date(inv.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`}
        actions={
          <>
            <Pastille ton={STATUTS[inv.statut].ton}>{STATUTS[inv.statut].libelle}</Pastille>
            <button className="bouton bouton-discret" onClick={() => naviguer('/stock/inventaires')}>
              Retour
            </button>
          </>
        }
      />
      <Alerte>{erreur}</Alerte>

      {inv.statut === 'valide' && (
        <section className="tuiles">
          <div className="tuile">
            <span className="tuile-valeur"><MontantFort v={inv.ecart_valeur ?? 0} /></span>
            <span className="tuile-libelle">écart total valorisé au coût moyen</span>
          </div>
          <div className="tuile">
            <span className="tuile-valeur">{lignes.filter((l) => Number(l.ecart ?? 0) !== 0).length}</span>
            <span className="tuile-libelle">produits ajustés</span>
          </div>
        </section>
      )}

      {peutCompter && (
        <section className="carte formulaire">
          <div className="barre-comptage">
            <label className="case">
              <input type="checkbox" checked={parScan} onChange={(e) => setParScan(e.target.checked)} />
              Chaque scan compte 1 article
            </label>
            <label className="case">
              <input type="checkbox" checked={aveugle} onChange={(e) => setAveugle(e.target.checked)} />
              Comptage à l’aveugle (masquer les quantités attendues)
            </label>
          </div>
          <RechercheProduit org={org} onChoisir={(p) => void scanne(p)} autoFocus placeholder="Scanner chaque article, ou chercher un produit…" />
          {dernier && <p className="dernier-scan">✓ {dernier}</p>}
        </section>
      )}

      <section className="carte">
        <div className="carte-entete">
          <h2>
            {comptes} / {lignes.length} produits comptés
          </h2>
          <select value={filtre} onChange={(e) => setFiltre(e.target.value as typeof filtre)} aria-label="Filtre" className="select-compact">
            <option value="tous">Tous</option>
            <option value="non_comptes">Non comptés</option>
            <option value="ecarts">Avec écart</option>
          </select>
        </div>
        <div className="defilement-horizontal">
          <table className="tableau tableau-saisie">
            <thead>
              <tr>
                <th>Produit</th>
                {!(aveugle && enCours) && <th className="nombre">{inv.statut === 'valide' ? 'Stock enregistré' : 'Attendu'}</th>}
                <th className="nombre">Compté</th>
                {!(aveugle && enCours) && <th className="nombre">Écart</th>}
                {inv.statut === 'valide' && <th className="nombre">Valeur</th>}
              </tr>
            </thead>
            <tbody>
              {visibles.map((l) => {
                const p = produits[l.produit_id];
                const reference = Number(inv.statut === 'valide' ? l.quantite_systeme : l.quantite_theorique);
                const ecart = inv.statut === 'valide' ? Number(l.ecart ?? 0) : l.quantite_comptee == null ? null : Number(l.quantite_comptee) - reference;
                return (
                  <tr key={l.produit_id}>
                    <td>
                      <strong>{p?.designation ?? '…'}</strong>
                      <div className="secondaire">{p?.unite}</div>
                    </td>
                    {!(aveugle && enCours) && <td className="nombre">{quantite(reference)}</td>}
                    <td className="nombre">
                      {peutCompter ? (
                        <input
                          className="champ-nombre"
                          inputMode="decimal"
                          key={`${l.produit_id}-${l.quantite_comptee}`}
                          defaultValue={l.quantite_comptee == null ? '' : quantite(l.quantite_comptee)}
                          placeholder="—"
                          onBlur={(e) => {
                            const brut = e.target.value.trim();
                            if (brut === '') return;
                            const v = Number(brut.replace(/\s/g, '').replace(',', '.'));
                            if (v >= 0 && v !== Number(l.quantite_comptee)) void compter(l.produit_id, v, false);
                          }}
                          aria-label={`Quantité comptée ${p?.designation ?? ''}`}
                        />
                      ) : l.quantite_comptee == null ? (
                        <span className="secondaire">non compté</span>
                      ) : (
                        quantite(l.quantite_comptee)
                      )}
                    </td>
                    {!(aveugle && enCours) && (
                      <td className={`nombre ${ecart && ecart < 0 ? 'texte-negatif' : ecart && ecart > 0 ? 'texte-positif' : ''}`}>
                        {ecart == null ? '—' : `${ecart > 0 ? '+' : ''}${quantite(ecart)}`}
                      </td>
                    )}
                    {inv.statut === 'valide' && <td className="nombre">{montant(l.ecart_valeur ?? 0)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {enCours && (
          <div className="actions-piece">
            {peut('stock.creer') && (
              <button className="bouton-lien lien-danger" onClick={() => void annuler()}>
                Annuler l’inventaire
              </button>
            )}
            {peut('stock.valider') && (
              <button className="bouton bouton-principal" disabled={envoi || comptes === 0} onClick={() => void valider()}>
                {envoi ? 'Validation…' : 'Valider l’inventaire'}
              </button>
            )}
          </div>
        )}
        {enCours && (
          <p className="secondaire">
            L’écart final est calculé à la validation, par rapport au stock du moment : les ventes faites pendant le comptage sont prises en compte.
          </p>
        )}
      </section>
    </>
  );
}
