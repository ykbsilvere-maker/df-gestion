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
import { useComptes } from '../../lib/tresorerie';
import { useImpression } from '../../impression/impression';
import { useIdentite } from '../../lib/identite';
import { useDemandeCreation } from '../../lib/demande';

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
  repartition: 'valeur' | 'quantite' | 'poids';
  reglement: 'comptant' | 'credit';
  echeance: string | null;
  compte_paiement_id: string | null;
  annoncee: boolean;
  annonce_le: string | null;
  ecarts_controle: { designation: string; attendu: number | null; compte: number; ecart: number; prix_attendu: number | null; prix: number }[] | null;
}

interface FraisReception {
  id: string;
  nature: 'transport' | 'manutention' | 'douane' | 'taxes' | 'autres';
  libelle: string | null;
  montant: number | string;
  compte_id: string | null;
}

const NATURES_FRAIS: Record<FraisReception['nature'], string> = {
  transport: 'Transport',
  manutention: 'Manutention',
  douane: 'Douane',
  taxes: 'Taxes non récupérables',
  autres: 'Autres frais',
};

interface LigneReception {
  id: string;
  produit_id: string;
  quantite: number | string;
  prix_unitaire: number | string;
  numero_lot: string | null;
  date_peremption: string | null;
  cout_unitaire: number | string | null;
  poids: number | string | null;
  quantite_attendue: number | string | null;
  prix_attendu: number | string | null;
  quantite_comptee: number | string | null;
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
  useDemandeCreation(peutCreer && !!magasin, () => void nouvelle());

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
                      {r.statut === 'brouillon' && r.annoncee ? (
                        <Pastille ton="or">Arrivage attendu</Pastille>
                      ) : (
                        <Pastille ton={STATUTS[r.statut].ton}>{STATUTS[r.statut].libelle}</Pastille>
                      )}
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
  const { comptes } = useComptes(org);
  const { imprimer } = useImpression();
  const { identite } = useIdentite();
  const [frais, setFrais] = useState<FraisReception[]>([]);
  const [r, setR] = useState<Reception | null>(null);
  const [lignes, setLignes] = useState<LigneReception[]>([]);
  const [produits, setProduits] = useState<Record<string, Produit>>({});
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [envoi, setEnvoi] = useState(false);

  const charger = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      supabase.from('receptions').select('*').eq('id', id!).single(),
      supabase.from('receptions_lignes').select('*').eq('reception_id', id!).order('created_at'),
      supabase.from('receptions_frais').select('*').eq('reception_id', id!).order('created_at'),
    ]);
    if (a.error) return setErreur(messageErreur(a.error));
    setR(a.data as Reception);
    setFrais((c.data ?? []) as FraisReception[]);
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
  // Arrivage annoncé : la valeur suit les quantités comptées (les lignes non comptées gardent l'attendu).
  const qteRetenue = useCallback(
    (l: LigneReception) => (r?.annoncee && r.statut === 'brouillon' && l.quantite_comptee !== null ? Number(l.quantite_comptee) : Number(l.quantite)),
    [r],
  );
  const totalMarchandises = useMemo(
    () => lignes.reduce((s, l) => s + qteRetenue(l) * Number(l.prix_unitaire), 0),
    [lignes, qteRetenue],
  );
  const totalFrais = Number(r?.frais_approche ?? 0);

  /** Coût de revient unitaire estimé, même calcul que la validation (répartition des frais au choix). */
  const coutEstime = useCallback(
    (l: LigneReception): number | null => {
      if (!r) return null;
      const q = Number(l.quantite);
      const pu = Number(l.prix_unitaire);
      if (!totalFrais) return pu;
      const totalQ = lignes.reduce((t, x) => t + Number(x.quantite), 0);
      if (r.repartition === 'quantite') return pu + totalFrais / totalQ;
      if (r.repartition === 'poids') {
        const totalP = lignes.reduce((t, x) => t + Number(x.poids ?? 0), 0);
        if (!totalP || !Number(l.poids)) return null;
        return pu + (totalFrais * Number(l.poids)) / totalP / q;
      }
      return totalMarchandises > 0 ? pu + (totalFrais * pu) / totalMarchandises : pu + totalFrais / totalQ;
    },
    [r, lignes, totalFrais, totalMarchandises],
  );

  async function ajouterFrais() {
    if (!r) return;
    const nature = frais.some((f) => f.nature === 'transport') ? 'manutention' : 'transport';
    const saisie = window.prompt(`Montant des frais (${NATURES_FRAIS[nature]}) — vous pourrez changer la nature ensuite`);
    const v = saisie ? lireMontant(saisie) : null;
    if (!v || v <= 0) return;
    const { error } = await supabase.from('receptions_frais').insert({
      organisation_id: org,
      reception_id: r.id,
      nature,
      montant: v,
      compte_id: comptes[0]?.id ?? null,
    });
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

  async function majFrais(f: FraisReception, champs: Partial<FraisReception>) {
    setFrais((fs) => fs.map((x) => (x.id === f.id ? { ...x, ...champs } : x)));
    const { error } = await supabase.from('receptions_frais').update(champs).eq('id', f.id);
    if (error) setErreur(messageErreur(error));
    await charger();
  }

  async function supprimerFrais(f: FraisReception) {
    const { error } = await supabase.from('receptions_frais').delete().eq('id', f.id);
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

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
      // Scanner à nouveau le même article ajoute une unité (au comptage pour un arrivage annoncé).
      if (r?.annoncee) await majLigne(existante, { quantite_comptee: Number(existante.quantite_comptee ?? 0) + 1 });
      else await majLigne(existante, { quantite: Number(existante.quantite) + 1 });
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
      // Pendant le comptage d'un arrivage annoncé, un article non prévu est compté directement.
      ...(r!.annoncee ? { quantite_comptee: 1 } : {}),
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

  async function annoncer() {
    if (!r) return;
    if (!window.confirm('Annoncer cet arrivage ? Le chargé du stock comptera les articles à la livraison ; les écarts seront affichés avant validation.')) return;
    const { error } = await supabase.rpc('annoncer_reception', { p_reception: r.id });
    if (error) return setErreur(messageErreur(error));
    setInfo('Arrivage annoncé : il apparaît dans la liste des réceptions comme « Arrivage attendu ».');
    await charger();
  }

  async function toutConforme() {
    const aCompter = lignes.filter((l) => l.quantite_comptee === null && l.quantite_attendue !== null);
    for (const l of aCompter) await majLigne(l, { quantite_comptee: Number(l.quantite_attendue) });
    await charger();
  }

  async function imprimerFiche() {
    if (!r) return;
    const f = fournisseurs.find((x) => x.id === r.fournisseur_id);
    const mag = magasins.find((m) => m.id === r.magasin_id);
    await imprimer(
      <div className="rapport-a4 fiche-stockage">
        <header className="rapport-entete">
          <div>
            <strong>{identite?.organisation.nom ?? organisation!.nom}</strong>
            <h1>Fiche de stockage — contrôle de livraison</h1>
            <p>
              Réception {r.numero} · {new Date(r.date_reception).toLocaleDateString('fr-FR')} · {mag?.nom ?? ''}
            </p>
            <p>
              Fournisseur : <strong>{f?.nom ?? 'non précisé'}</strong> · BL / facture : {r.reference ?? '…………………'}
            </p>
          </div>
          {identite?.logoUrl && <img src={identite.logoUrl} alt="" />}
        </header>
        <table className="rapport-tableau">
          <thead>
            <tr>
              <th>Code</th>
              <th>Désignation</th>
              <th>Unité</th>
              <th className="nombre">Attendu</th>
              <th className="nombre">Compté</th>
              <th className="nombre">Écart</th>
              <th>Lot / péremption</th>
              <th>Emplacement · observations</th>
            </tr>
          </thead>
          <tbody>
            {lignes.map((l) => {
              const p = produits[l.produit_id];
              const attendu = l.quantite_attendue ?? (r.annoncee ? null : l.quantite);
              const compte = l.quantite_comptee;
              return (
                <tr key={l.id}>
                  <td>{p?.code}</td>
                  <td>{p?.designation}</td>
                  <td>{p?.unite}</td>
                  <td className="nombre">{attendu === null ? '—' : quantite(attendu)}</td>
                  <td className="nombre case-saisie">{compte === null ? '' : quantite(compte)}</td>
                  <td className="nombre case-saisie">{compte === null || attendu === null ? '' : quantite(Number(compte) - Number(attendu))}</td>
                  <td className="case-saisie">{[l.numero_lot, l.date_peremption && new Date(l.date_peremption).toLocaleDateString('fr-FR')].filter(Boolean).join(' · ')}</td>
                  <td className="case-saisie" />
                </tr>
              );
            })}
            {Array.from({ length: 3 }).map((_, i) => (
              <tr key={`v${i}`}>
                <td className="case-saisie" colSpan={8}>&nbsp;</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="signatures">
          <div>Livreur<br /><span>Nom et signature</span></div>
          <div>Chargé du stock<br /><span>Nom et signature</span></div>
          <div>Gérant<br /><span>Visa</span></div>
        </div>
        <footer className="rapport-pied">À agrafer au bordereau de livraison · imprimé le {new Date().toLocaleString('fr-FR')} · DF Gestion</footer>
      </div>,
      'a4',
    );
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
            {brouillon && r.annoncee ? <Pastille ton="or">Arrivage attendu</Pastille> : <Pastille ton={STATUTS[r.statut].ton}>{STATUTS[r.statut].libelle}</Pastille>}
            <button className="bouton bouton-discret" onClick={() => void imprimerFiche()} disabled={!lignes.length}>
              🖨️ Fiche de stockage
            </button>
            {brouillon && !r.annoncee && modifiable && lignes.length > 0 && (
              <button className="bouton bouton-discret" onClick={() => void annoncer()}>
                📣 Annoncer l’arrivage
              </button>
            )}
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
            <Champ label="Règlement du fournisseur">
              <select value={r.reglement} onChange={(e) => void majEntete({ reglement: e.target.value as Reception['reglement'] })}>
                <option value="comptant">Payé comptant</option>
                <option value="credit">À crédit (dette fournisseur)</option>
              </select>
            </Champ>
            {r.reglement === 'comptant' ? (
              <Champ label="Payé depuis" aide="Le montant des marchandises sort de ce compte">
                <select value={r.compte_paiement_id ?? ''} onChange={(e) => void majEntete({ compte_paiement_id: e.target.value || null })}>
                  <option value="">Non précisé</option>
                  {comptes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nom}
                    </option>
                  ))}
                </select>
              </Champ>
            ) : (
              <Champ label="Échéance de paiement">
                <input type="date" value={r.echeance ?? ''} onChange={(e) => void majEntete({ echeance: e.target.value || null })} />
              </Champ>
            )}
            <Champ label="Répartition des frais">
              <select value={r.repartition} onChange={(e) => void majEntete({ repartition: e.target.value as Reception['repartition'] })}>
                <option value="valeur">Selon la valeur (par défaut)</option>
                <option value="quantite">Selon la quantité</option>
                <option value="poids">Selon le poids</option>
              </select>
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
                  {r.annoncee && <th className="nombre">Attendu</th>}
                  <th className="nombre">{r.annoncee ? (brouillon ? 'Compté' : 'Reçu') : 'Quantité'}</th>
                  {r.annoncee && brouillon && <th className="nombre">Écart</th>}
                  <th className="nombre">Prix d’achat unitaire</th>
                  <th>Lot / péremption</th>
                  {r.repartition === 'poids' && <th className="nombre">Poids total (kg)</th>}
                  <th className="nombre">Montant</th>
                  <th className="nombre">{r.statut === 'validee' ? 'Coût de revient' : 'Coût de revient estimé'}</th>
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
                      {r.annoncee && <td className="nombre">{l.quantite_attendue === null ? <Pastille ton="or">Non prévu</Pastille> : quantite(l.quantite_attendue)}</td>}
                      <td className="nombre">
                        {modifiable && r.annoncee ? (
                          <input
                            className={`champ-nombre ${l.quantite_comptee === null ? 'champ-a-compter' : ''}`}
                            inputMode="decimal"
                            placeholder="à compter"
                            defaultValue={l.quantite_comptee === null ? '' : quantite(l.quantite_comptee)}
                            key={`c-${l.id}-${l.quantite_comptee}`}
                            onBlur={(e) => {
                              const brut = e.target.value.replace(/\s/g, '').replace(',', '.');
                              if (brut === '') return;
                              const v = Number(brut);
                              if (v >= 0 && v !== Number(l.quantite_comptee)) void majLigne(l, { quantite_comptee: v });
                            }}
                            aria-label={`Quantité comptée ${p?.designation ?? ''}`}
                          />
                        ) : modifiable ? (
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
                          quantite(r.annoncee && brouillon ? l.quantite_comptee ?? 0 : l.quantite)
                        )}
                      </td>
                      {r.annoncee && brouillon && (
                        <td className="nombre">
                          {l.quantite_comptee === null ? (
                            <span className="secondaire">—</span>
                          ) : (() => {
                              const ec = Number(l.quantite_comptee) - Number(l.quantite_attendue ?? 0);
                              return ec === 0 ? <Pastille ton="vert">Conforme</Pastille> : <Pastille ton={ec < 0 ? 'rouge' : 'or'}>{ec > 0 ? '+' : ''}{quantite(ec)}</Pastille>;
                            })()}
                        </td>
                      )}
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
                      {r.repartition === 'poids' && (
                        <td className="nombre">
                          {modifiable ? (
                            <input
                              className="champ-nombre"
                              inputMode="decimal"
                              defaultValue={l.poids === null ? '' : quantite(l.poids)}
                              key={`w-${l.id}-${l.poids}`}
                              onBlur={(e) => {
                                const v = Number(e.target.value.replace(/\s/g, '').replace(',', '.'));
                                if (v >= 0 && v !== Number(l.poids)) void majLigne(l, { poids: v });
                              }}
                              aria-label={`Poids ${p?.designation ?? ''}`}
                            />
                          ) : l.poids === null ? '—' : quantite(l.poids)}
                        </td>
                      )}
                      <td className="nombre">{montant(qteRetenue(l) * Number(l.prix_unitaire))}</td>
                      <td className="nombre">
                        {r.statut === 'validee'
                          ? montant(Math.round(Number(l.cout_unitaire ?? 0)))
                          : (() => {
                              const c = coutEstime(l);
                              return c === null ? <span className="secondaire">poids ?</span> : montant(Math.round(c));
                            })()}
                      </td>
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
          <div className="frais-detail">
            <span>Frais d’approche (transport, manutention, douane…)</span>
            {frais.length === 0 && totalFrais > 0 && <strong>{montant(totalFrais)}</strong>}
            {frais.map((f) => (
              <div key={f.id} className="frais-ligne">
                {modifiable ? (
                  <>
                    <select value={f.nature} onChange={(e) => void majFrais(f, { nature: e.target.value as FraisReception['nature'] })} aria-label="Nature des frais">
                      {Object.entries(NATURES_FRAIS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                    <input
                      className="champ-nombre champ-prix"
                      inputMode={clavierMontant()}
                      defaultValue={montant(f.montant, '')}
                      key={`f-${f.id}-${f.montant}`}
                      onBlur={(e) => {
                        const v = lireMontant(e.target.value) ?? 0;
                        if (v > 0 && v !== Number(f.montant)) void majFrais(f, { montant: v });
                      }}
                      aria-label="Montant des frais"
                    />
                    <select value={f.compte_id ?? ''} onChange={(e) => void majFrais(f, { compte_id: e.target.value || null })} aria-label="Payé depuis">
                      <option value="">Payé depuis…</option>
                      {comptes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.nom}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="bouton-lien lien-danger" onClick={() => void supprimerFrais(f)}>
                      Retirer
                    </button>
                  </>
                ) : (
                  <span>
                    {NATURES_FRAIS[f.nature]} · <strong>{montant(f.montant)}</strong>
                    {f.compte_id && <span className="secondaire"> · {comptes.find((c) => c.id === f.compte_id)?.nom}</span>}
                  </span>
                )}
              </div>
            ))}
            {modifiable && (
              <button type="button" className="bouton bouton-discret" onClick={() => void ajouterFrais()}>
                + Ajouter des frais
              </button>
            )}
            {frais.length > 0 && <strong>Total frais : {montant(totalFrais)}</strong>}
          </div>
          <div className="total-piece">
            <span>Coût total de la réception</span>
            <strong>{montant(totalMarchandises + totalFrais)}</strong>
          </div>
          <p className="secondaire">
            Les frais sont répartis sur les articles {r.repartition === 'valeur' ? 'selon leur valeur' : r.repartition === 'quantite' ? 'selon la quantité' : 'selon le poids'} et
            intégrés au coût de revient, puis au coût moyen du stock. {r.reglement === 'credit' ? 'À la validation, le montant des marchandises devient une dette envers le fournisseur.' : ''}
          </p>
        </div>

        {brouillon && r.annoncee && (
          <Alerte type="info">
            Arrivage annoncé le {r.annonce_le ? new Date(r.annonce_le).toLocaleString('fr-FR') : ''} : comptez chaque article reçu (0 s’il manque).
            {' '}{lignes.filter((l) => l.quantite_comptee === null).length} ligne(s) restent à compter.{' '}
            {modifiable && lignes.some((l) => l.quantite_comptee === null) && (
              <button type="button" className="bouton-lien" onClick={() => void toutConforme()}>
                Tout est conforme à l’attendu
              </button>
            )}
          </Alerte>
        )}
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
      {r.statut === 'validee' && r.ecarts_controle && r.ecarts_controle.length > 0 && (
        <section className="carte">
          <h2>Écarts constatés à la livraison</h2>
          <table className="tableau">
            <thead>
              <tr>
                <th>Produit</th>
                <th className="nombre">Attendu</th>
                <th className="nombre">Reçu</th>
                <th className="nombre">Écart</th>
                <th className="nombre col-secondaire">Prix attendu → retenu</th>
              </tr>
            </thead>
            <tbody>
              {r.ecarts_controle.map((e, i) => (
                <tr key={i}>
                  <td>{e.designation}</td>
                  <td className="nombre">{e.attendu === null ? 'non prévu' : quantite(e.attendu)}</td>
                  <td className="nombre">{quantite(e.compte)}</td>
                  <td className={`nombre ${Number(e.ecart) < 0 ? 'texte-negatif' : ''}`}>{Number(e.ecart) > 0 ? '+' : ''}{quantite(e.ecart)}</td>
                  <td className="nombre col-secondaire">
                    {e.prix_attendu === null || Number(e.prix_attendu) === Number(e.prix) ? montant(e.prix) : `${montant(e.prix_attendu)} → ${montant(e.prix)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
