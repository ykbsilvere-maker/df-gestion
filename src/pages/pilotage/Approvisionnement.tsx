import { LogoCompte } from '../../components/LogoMoyen';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { montant } from '../../lib/argent';
import { quantite, useMagasins } from '../../lib/stock';
import { TYPES_COMPTE, type TypeCompte } from '../../lib/tresorerie';
import { Alerte, Champ, EnTetePage, MontantFort, Pastille, Vide } from '../../components/ui';

interface Ligne {
  id: string;
  code: string;
  designation: string;
  unite: string;
  stock: number;
  vendu: number;
  ca: number;
  marge: number;
  rythme: number;
  classe: 'A' | 'B' | 'C';
  couverture_jours: number | null;
  quantite_proposee: number;
  priorite: number;
  dernier_prix: number | null;
  cout: number | null;
  fournisseur_id: string | null;
  fournisseur: string | null;
  seuil_min: number | null;
}
interface Treso {
  comptes: { id: string; nom: string; type: TypeCompte; solde: number; actif: boolean }[];
  total: number;
  dettes_30_jours: number;
  budget_restant: number;
  liquidite: number;
}

const PRIORITES: Record<number, { ton: 'rouge' | 'or' | 'vert' | 'gris'; libelle: string }> = {
  1: { ton: 'rouge', libelle: 'Rupture' },
  2: { ton: 'or', libelle: 'Important' },
  3: { ton: 'vert', libelle: 'Utile' },
  4: { ton: 'gris', libelle: 'Secondaire' },
};

export function Approvisionnement() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const magasins = useMagasins(org);
  const [magasin, setMagasin] = useState('');
  const [analyse, setAnalyse] = useState(30);
  const [couverture, setCouverture] = useState(30);
  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [treso, setTreso] = useState<Treso | null>(null);
  const [choix, setChoix] = useState<Record<string, { coche: boolean; qte: number }>>({});
  const [erreur, setErreur] = useState('');
  const [occupe, setOccupe] = useState('');

  useEffect(() => {
    let actif = true;
    void supabase
      .rpc('proposition_approvisionnement', { p_org: org, p_magasin: magasin || null, p_jours_analyse: analyse, p_jours_couverture: couverture })
      .then(({ data, error }) => {
        if (!actif) return;
        if (error) return setErreur(messageErreur(error));
        const d = data as { lignes: Ligne[]; tresorerie: Treso | null };
        setLignes(d.lignes);
        setTreso(d.tresorerie);
        setChoix(Object.fromEntries(d.lignes.map((l) => [l.id, { coche: l.priorite <= 2, qte: Number(l.quantite_proposee) }])));
      });
    return () => {
      actif = false;
    };
  }, [org, magasin, analyse, couverture]);

  const prix = (l: Ligne) => Number(l.dernier_prix ?? l.cout ?? 0);
  const retenues = lignes.filter((l) => choix[l.id]?.coche && (choix[l.id]?.qte ?? 0) > 0);
  const totalRetenu = retenues.reduce((s, l) => s + prix(l) * (choix[l.id]?.qte ?? 0), 0);
  const parFournisseur = useMemo(() => {
    const g = new Map<string, { nom: string; id: string | null; lignes: Ligne[]; total: number }>();
    for (const l of retenues) {
      const cle = l.fournisseur_id ?? 'aucun';
      const e = g.get(cle) ?? { nom: l.fournisseur ?? 'Fournisseur à choisir', id: l.fournisseur_id, lignes: [], total: 0 };
      e.lignes.push(l);
      e.total += prix(l) * (choix[l.id]?.qte ?? 0);
      g.set(cle, e);
    }
    return [...g.values()].sort((a, b) => b.total - a.total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retenues, choix]);
  const disponible = treso ? Number(treso.liquidite) : null;

  async function creerArrivage(g: { id: string | null; nom: string; lignes: Ligne[] }) {
    const mag = magasin || magasins[0]?.id;
    if (!mag) return setErreur('Choisissez un magasin.');
    setOccupe(g.nom);
    setErreur('');
    const { data, error } = await supabase
      .from('receptions')
      .insert({ organisation_id: org, magasin_id: mag, fournisseur_id: g.id, note: 'Proposition d’approvisionnement', reglement: 'credit' })
      .select('id')
      .single();
    if (error || !data) {
      setOccupe('');
      return setErreur(messageErreur(error));
    }
    const rid = (data as { id: string }).id;
    const { error: e2 } = await supabase.from('receptions_lignes').insert(
      g.lignes.map((l) => ({ organisation_id: org, reception_id: rid, produit_id: l.id, quantite: choix[l.id]!.qte, prix_unitaire: prix(l) })),
    );
    if (e2) {
      setOccupe('');
      return setErreur(messageErreur(e2));
    }
    await supabase.rpc('annoncer_reception', { p_reception: rid });
    setOccupe('');
    naviguer(`/stock/receptions/${rid}`);
  }

  return (
    <>
      <EnTetePage
        icone="🛒"
        titre="Proposition d’approvisionnement"
        sousTitre="D’après le rythme des ventes et le stock restant : les produits à racheter en priorité, au dernier prix, face à votre trésorerie."
      />
      <Alerte>{erreur}</Alerte>

      {treso && (
        <section className="carte">
          <h2>Votre trésorerie pour acheter</h2>
          <div className="grille-comptes">
            {treso.comptes.filter((c) => c.actif).map((c) => (
              <div key={c.id} className="carte-compte">
                <span className="carte-compte-tete"><LogoCompte compte={c} /><strong>{c.nom}</strong></span>
                <span className={`carte-compte-solde ${c.solde < 0 ? 'texte-negatif' : ''}`}>{montant(c.solde)}</span>
              </div>
            ))}
          </div>
          <table className="tableau tableau-compact">
            <tbody>
              <tr><td>Total des comptes</td><td className="nombre">{montant(treso.total)}</td></tr>
              <tr><td>− Dettes fournisseurs à 30 jours</td><td className="nombre">{montant(treso.dettes_30_jours)}</td></tr>
              <tr><td>− Budget restant du mois</td><td className="nombre">{montant(treso.budget_restant)}</td></tr>
              <tr className="ligne-total"><td>= Disponible pour acheter</td><td className={`nombre ${treso.liquidite < 0 ? 'texte-negatif' : ''}`}>{montant(treso.liquidite)}</td></tr>
            </tbody>
          </table>
        </section>
      )}

      <section className="carte">
        <div className="filtres">
          <Champ label="Magasin">
            <select value={magasin} onChange={(e) => setMagasin(e.target.value)}>
              <option value="">Tous</option>
              {magasins.map((m) => (
                <option key={m.id} value={m.id}>{m.nom}</option>
              ))}
            </select>
          </Champ>
          <Champ label="Rythme calculé sur">
            <select value={analyse} onChange={(e) => setAnalyse(Number(e.target.value))}>
              {[14, 30, 60, 90].map((n) => (
                <option key={n} value={n}>{n} derniers jours</option>
              ))}
            </select>
          </Champ>
          <Champ label="Stock visé">
            <select value={couverture} onChange={(e) => setCouverture(Number(e.target.value))}>
              {[7, 15, 30, 45, 60].map((n) => (
                <option key={n} value={n}>{n} jours de vente</option>
              ))}
            </select>
          </Champ>
        </div>
        {lignes.length === 0 ? (
          <Vide>Rien à racheter : le stock couvre les ventes prévues.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau tableau-compact">
              <thead>
                <tr>
                  <th aria-label="Choisir" />
                  <th>Produit</th>
                  <th>Priorité</th>
                  <th className="nombre col-secondaire">Vendu</th>
                  <th className="nombre">Stock</th>
                  <th className="nombre col-secondaire">Couverture</th>
                  <th className="nombre">À commander</th>
                  <th className="nombre col-secondaire">Prix</th>
                  <th className="nombre">Montant</th>
                </tr>
              </thead>
              <tbody>
                {lignes.map((l) => {
                  const c = choix[l.id] ?? { coche: false, qte: 0 };
                  return (
                    <tr key={l.id} className={c.coche ? '' : 'ligne-inactive'}>
                      <td>
                        <input type="checkbox" checked={c.coche} onChange={(e) => setChoix({ ...choix, [l.id]: { ...c, coche: e.target.checked } })} aria-label={`Retenir ${l.designation}`} />
                      </td>
                      <td>
                        <strong>{l.designation}</strong>
                        <div className="secondaire">{l.code} · {l.fournisseur ?? 'fournisseur inconnu'} · classe {l.classe}</div>
                      </td>
                      <td><Pastille ton={PRIORITES[l.priorite]!.ton}>{PRIORITES[l.priorite]!.libelle}</Pastille></td>
                      <td className="nombre col-secondaire">{quantite(l.vendu)}</td>
                      <td className={`nombre ${Number(l.stock) <= 0 ? 'texte-negatif' : ''}`}>{quantite(l.stock)}</td>
                      <td className="nombre col-secondaire">{l.couverture_jours === null ? '—' : `${l.couverture_jours} j`}</td>
                      <td className="nombre">
                        <input
                          className="champ-nombre"
                          inputMode="decimal"
                          value={c.qte}
                          onChange={(e) => setChoix({ ...choix, [l.id]: { coche: true, qte: Math.max(0, Number(e.target.value.replace(',', '.')) || 0) } })}
                          aria-label={`Quantité ${l.designation}`}
                        />
                      </td>
                      <td className="nombre col-secondaire">{prix(l) ? montant(prix(l)) : '—'}</td>
                      <td className="nombre">{montant(prix(l) * c.qte)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="ligne-total">
                  <td colSpan={8}>Total retenu ({retenues.length} produits)</td>
                  <td className="nombre">{montant(totalRetenu)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {disponible !== null && totalRetenu > 0 && (
          totalRetenu > disponible ? (
            <Alerte>Le total dépasse le disponible de {montant(totalRetenu - disponible)} : retirez les produits secondaires ou négociez un paiement à crédit.</Alerte>
          ) : (
            <Alerte type="succes">Le total tient dans votre trésorerie : il restera {montant(disponible - totalRetenu)}.</Alerte>
          )
        )}
      </section>

      {parFournisseur.length > 0 && (
        <section className="carte">
          <h2>Par fournisseur</h2>
          <div className="grille-comptes">
            {parFournisseur.map((g) => (
              <div key={g.nom} className="carte-compte">
                <span className="carte-compte-tete"><span aria-hidden>🚚</span><strong>{g.nom}</strong></span>
                <span className="carte-compte-solde"><MontantFort v={g.total} /></span>
                <span className="secondaire">{g.lignes.length} produit{g.lignes.length > 1 ? 's' : ''}</span>
                {(peut('achats.creer') || peut('stock.creer')) && (
                  <button className="bouton bouton-principal bouton-petit" disabled={!!occupe} onClick={() => void creerArrivage(g)}>
                    {occupe === g.nom ? 'Création…' : 'Créer l’arrivage annoncé'}
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="secondaire">
            L’arrivage est créé à crédit chez le fournisseur (modifiable) ; le chargé du stock comptera les articles à la livraison.
          </p>
        </section>
      )}
    </>
  );
}
