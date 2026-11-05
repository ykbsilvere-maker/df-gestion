import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { clavierMontant, lireMontant, montant } from '../../lib/argent';
import { quantite } from '../../lib/stock';
import { aujourdhui, dateFr, useComptes } from '../../lib/tresorerie';
import { Alerte, Champ, EnTetePage, Fenetre, MontantFort, Pastille, Vide } from '../../components/ui';
import type { Fournisseur } from '../stock/Fournisseurs';

/** Module « Fournisseurs et coût de revient » : onglets. */
export function FournisseursModule() {
  return (
    <>
      <nav className="onglets" aria-label="Fournisseurs">
        <NavLink to="/fournisseurs" end>
          <span className="onglet-icone" aria-hidden>🚚</span>Fournisseurs
        </NavLink>
        <NavLink to="/fournisseurs/couts">
          <span className="onglet-icone" aria-hidden>🧮</span>Coût de revient
        </NavLink>
      </nav>
      <Outlet />
    </>
  );
}

interface Achat {
  reception_id: string;
  numero: string;
  date_reception: string;
  echeance: string | null;
  montant: number;
  paye: number;
  reste: number;
}
interface Paiement {
  id: string;
  date_paiement: string;
  montant: number;
  statut: 'enregistre' | 'annule';
  reference: string | null;
  note: string | null;
  compte: string | null;
  reception: string | null;
}
interface PrixPaye {
  designation: string;
  date_reception: string;
  numero: string;
  quantite: number;
  prix_unitaire: number;
  cout_unitaire: number | null;
}

export function FicheFournisseur() {
  const { id } = useParams();
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const { comptes } = useComptes(org);
  const [f, setF] = useState<Fournisseur | null>(null);
  const [h, setH] = useState<{ achats: Achat[]; paiements: Paiement[]; prix: PrixPaye[] } | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [paiement, setPaiement] = useState<{ reception: string; montant: string; compte: string; date: string; reference: string } | null>(null);

  const charger = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.from('fournisseurs').select('*').eq('id', id!).single(),
      supabase.rpc('historique_fournisseur', { p_fournisseur: id }),
    ]);
    if (a.error) return setErreur(messageErreur(a.error));
    if (b.error) return setErreur(messageErreur(b.error));
    setF(a.data as Fournisseur);
    setH(b.data as { achats: Achat[]; paiements: Paiement[]; prix: PrixPaye[] });
  }, [id]);
  useEffect(() => {
    void charger();
  }, [charger]);

  const totaux = useMemo(() => {
    const achats = h?.achats ?? [];
    const total = achats.reduce((t, a) => t + Number(a.montant), 0);
    const paye = (h?.paiements ?? []).filter((p) => p.statut === 'enregistre').reduce((t, p) => t + Number(p.montant), 0);
    return { total, paye, reste: Math.max(total - paye, 0) };
  }, [h]);

  async function payer(e: FormEvent) {
    e.preventDefault();
    if (!paiement) return;
    setErreur('');
    const m = lireMontant(paiement.montant);
    if (!m || m <= 0) return setErreur('Indiquez le montant payé.');
    const { error } = await supabase.rpc('payer_fournisseur', {
      p_org: org,
      p_fournisseur: id,
      p_reception: paiement.reception || null,
      p_montant: m,
      p_compte: paiement.compte,
      p_date: paiement.date,
      p_reference: paiement.reference || null,
      p_note: null,
    });
    if (error) return setErreur(messageErreur(error));
    setPaiement(null);
    setInfo('Paiement enregistré. Il sort du compte choisi en trésorerie.');
    await charger();
  }

  async function annulerPaiement(p: Paiement) {
    const motif = window.prompt('Motif de l’annulation du paiement');
    if (!motif?.trim()) return;
    const { error } = await supabase.rpc('annuler_paiement_fournisseur', { p_paiement: p.id, p_motif: motif.trim() });
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

  if (!f || !h) return <EnTetePage titre="Fournisseur" sousTitre={erreur || 'Chargement…'} />;
  const peutPayer = peut('fournisseurs.creer') || peut('achats.creer');
  const aujourd = aujourdhui();

  return (
    <>
      <EnTetePage
        icone="🚚"
        titre={f.nom}
        sousTitre={[f.telephone, f.email, f.adresse].filter(Boolean).join(' · ') || 'Fiche fournisseur'}
        actions={
          <>
            {peutPayer && totaux.reste > 0 && (
              <button
                className="bouton bouton-principal"
                onClick={() => {
                  const premier = h.achats.find((a) => Number(a.reste) > 0);
                  setPaiement({
                    reception: premier?.reception_id ?? '',
                    montant: premier ? montant(premier.reste, '') : '',
                    compte: comptes[0]?.id ?? '',
                    date: aujourd,
                    reference: '',
                  });
                }}
              >
                Enregistrer un paiement
              </button>
            )}
            <button className="bouton bouton-discret" onClick={() => naviguer('/fournisseurs')}>
              Retour
            </button>
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      <section className="tuiles">
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur"><MontantFort v={totaux.total} /></span>
          <span className="tuile-libelle">achats ({h.achats.length})</span>
        </div>
        <div className="tuile tuile-fixe">
          <span className="tuile-valeur"><MontantFort v={totaux.paye} /></span>
          <span className="tuile-libelle">payé</span>
        </div>
        <div className={`tuile tuile-fixe ${totaux.reste > 0 ? 'tuile-alerte' : ''}`}>
          <span className="tuile-valeur"><MontantFort v={totaux.reste} /></span>
          <span className="tuile-libelle">reste dû</span>
        </div>
      </section>

      <section className="carte">
        <h2>Achats</h2>
        {h.achats.length === 0 ? (
          <Vide>Aucune réception validée pour ce fournisseur.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Réception</th>
                  <th>Date</th>
                  <th className="nombre">Montant</th>
                  <th className="nombre col-secondaire">Payé</th>
                  <th className="nombre">Reste dû</th>
                  <th>Échéance</th>
                </tr>
              </thead>
              <tbody>
                {h.achats.map((a) => (
                  <tr key={a.reception_id} className="ligne-cliquable" onClick={() => naviguer(`/stock/receptions/${a.reception_id}`)}>
                    <td><strong>{a.numero}</strong></td>
                    <td>{dateFr(a.date_reception)}</td>
                    <td className="nombre">{montant(a.montant)}</td>
                    <td className="nombre col-secondaire">{montant(a.paye)}</td>
                    <td className="nombre">{Number(a.reste) > 0 ? <strong>{montant(a.reste)}</strong> : <Pastille ton="vert">Soldé</Pastille>}</td>
                    <td>
                      {Number(a.reste) > 0 && a.echeance ? (
                        <Pastille ton={a.echeance < aujourd ? 'rouge' : 'or'}>{dateFr(a.echeance)}</Pastille>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="carte">
        <h2>Paiements</h2>
        {h.paiements.length === 0 ? (
          <Vide>Aucun paiement.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Compte</th>
                  <th className="col-secondaire">Réception</th>
                  <th className="col-secondaire">Référence</th>
                  <th className="nombre">Montant</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {h.paiements.map((p) => (
                  <tr key={p.id} className={p.statut === 'annule' ? 'ligne-annulee' : ''}>
                    <td>{dateFr(p.date_paiement)}</td>
                    <td>{p.compte ?? <span className="secondaire">non précisé</span>}</td>
                    <td className="col-secondaire">{p.reception ?? '—'}</td>
                    <td className="col-secondaire">{p.reference ?? p.note ?? '—'}</td>
                    <td className="nombre">{montant(p.montant)}</td>
                    <td>
                      {p.statut === 'enregistre' && (peut('fournisseurs.modifier') || peut('achats.modifier')) && (
                        <button className="bouton-lien lien-danger" onClick={() => void annulerPaiement(p)}>
                          Annuler
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="carte">
        <h2>Prix payés dans le temps</h2>
        {h.prix.length === 0 ? (
          <Vide>Aucun prix enregistré.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau tableau-compact">
              <thead>
                <tr>
                  <th>Produit</th>
                  <th>Date</th>
                  <th className="col-secondaire">Réception</th>
                  <th className="nombre">Quantité</th>
                  <th className="nombre">Prix d’achat</th>
                  <th className="nombre">Coût de revient</th>
                </tr>
              </thead>
              <tbody>
                {h.prix.map((p, i) => (
                  <tr key={i}>
                    <td>{p.designation}</td>
                    <td>{dateFr(p.date_reception)}</td>
                    <td className="col-secondaire">{p.numero}</td>
                    <td className="nombre">{quantite(p.quantite)}</td>
                    <td className="nombre">{montant(p.prix_unitaire)}</td>
                    <td className="nombre">{p.cout_unitaire === null ? '—' : montant(Math.round(Number(p.cout_unitaire)))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Fenetre titre="Paiement au fournisseur" ouverte={!!paiement} onFermer={() => setPaiement(null)}>
        {paiement && (
          <form className="formulaire" onSubmit={payer}>
            <Alerte>{erreur}</Alerte>
            <Champ label="Réception concernée">
              <select
                value={paiement.reception}
                onChange={(e) => {
                  const a = h.achats.find((x) => x.reception_id === e.target.value);
                  setPaiement({ ...paiement, reception: e.target.value, montant: a ? montant(a.reste, '') : paiement.montant });
                }}
              >
                <option value="">Acompte général (sans réception)</option>
                {h.achats
                  .filter((a) => Number(a.reste) > 0)
                  .map((a) => (
                    <option key={a.reception_id} value={a.reception_id}>
                      {a.numero} — reste {montant(a.reste)}
                    </option>
                  ))}
              </select>
            </Champ>
            <div className="grille-2">
              <Champ label="Montant payé">
                <input value={paiement.montant} onChange={(e) => setPaiement({ ...paiement, montant: e.target.value })} inputMode={clavierMontant()} required />
              </Champ>
              <Champ label="Date">
                <input type="date" value={paiement.date} max={aujourd} onChange={(e) => setPaiement({ ...paiement, date: e.target.value })} />
              </Champ>
              <Champ label="Payé depuis">
                <select value={paiement.compte} onChange={(e) => setPaiement({ ...paiement, compte: e.target.value })} required>
                  {comptes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nom}
                    </option>
                  ))}
                </select>
              </Champ>
              <Champ label="Référence" aide="N° de transaction Wave, chèque, reçu…">
                <input value={paiement.reference} onChange={(e) => setPaiement({ ...paiement, reference: e.target.value })} maxLength={60} />
              </Champ>
            </div>
            <p className="secondaire">L’application enregistre le paiement déjà effectué ; elle ne déclenche aucun transfert.</p>
            <button className="bouton bouton-principal">Enregistrer le paiement</button>
          </form>
        )}
      </Fenetre>
    </>
  );
}

interface Cout {
  id: string;
  code: string;
  designation: string;
  prix_vente: number;
  prix_achat: number | null;
  stock: number | null;
  cout_moyen: number | null;
  dernier_cout: number | null;
  dernier_prix_achat: number | null;
  derniere_reception: string | null;
  fournisseur: string | null;
}

/** Coût de revient par produit, marge actuelle et prix de vente conseillé pour une marge visée. */
export function CoutsDeRevient() {
  const { organisation } = useSession();
  const org = organisation!.organisation_id;
  const [liste, setListe] = useState<Cout[]>([]);
  const [erreur, setErreur] = useState('');
  const [margeVisee, setMargeVisee] = useState(() => {
    try {
      return Number(localStorage.getItem('dfg-marge-visee')) || 30;
    } catch {
      return 30;
    }
  });
  const [filtre, setFiltre] = useState('');
  const [seulementSousMarge, setSeulementSousMarge] = useState(false);

  useEffect(() => {
    void supabase.rpc('couts_de_revient', { p_org: org }).then(({ data, error }) => {
      if (error) setErreur(messageErreur(error));
      else setListe((data ?? []) as Cout[]);
    });
  }, [org]);
  useEffect(() => {
    try {
      localStorage.setItem('dfg-marge-visee', String(margeVisee));
    } catch {
      /* stockage indisponible */
    }
  }, [margeVisee]);

  const lignes = useMemo(
    () =>
      liste
        .map((c) => {
          const cout = c.dernier_cout ?? c.cout_moyen ?? c.prix_achat;
          const pv = Number(c.prix_vente);
          const marge = cout === null || cout === undefined ? null : pv - Number(cout);
          const taux = marge === null || !pv ? null : (100 * marge) / pv;
          // Taux de marge sur le prix de vente : prix = coût ÷ (1 − taux)
          const conseille = cout === null || cout === undefined || margeVisee >= 100 ? null : Math.ceil(Number(cout) / (1 - margeVisee / 100) / 5) * 5;
          return { ...c, cout, marge, taux, conseille };
        })
        .filter((c) => !filtre || c.designation.toLowerCase().includes(filtre.toLowerCase()) || c.code?.toLowerCase().includes(filtre.toLowerCase()))
        .filter((c) => !seulementSousMarge || (c.taux !== null && c.taux < margeVisee)),
    [liste, margeVisee, filtre, seulementSousMarge],
  );

  return (
    <>
      <EnTetePage
        icone="🧮"
        titre="Coût de revient"
        sousTitre="Prix fournisseur + part du transport et des frais, par article. Comparez le prix de vente actuel au prix conseillé pour votre marge visée."
      />
      <Alerte>{erreur}</Alerte>
      <section className="carte">
        <div className="filtres">
          <Champ label="Rechercher">
            <input value={filtre} onChange={(e) => setFiltre(e.target.value)} placeholder="Nom ou code" />
          </Champ>
          <Champ label="Marge visée (% du prix de vente)">
            <input type="number" min={0} max={95} step={1} value={margeVisee} onChange={(e) => setMargeVisee(Math.min(95, Math.max(0, Number(e.target.value))))} />
          </Champ>
          <label className="case">
            <input type="checkbox" checked={seulementSousMarge} onChange={(e) => setSeulementSousMarge(e.target.checked)} /> Seulement sous la marge visée
          </label>
        </div>
        {lignes.length === 0 ? (
          <Vide>Aucun produit.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau tableau-compact">
              <thead>
                <tr>
                  <th>Produit</th>
                  <th className="col-secondaire">Dernier achat</th>
                  <th className="nombre col-secondaire">Prix d’achat</th>
                  <th className="nombre">Coût de revient</th>
                  <th className="nombre">Prix de vente</th>
                  <th className="nombre">Marge</th>
                  <th className="nombre">Prix conseillé</th>
                </tr>
              </thead>
              <tbody>
                {lignes.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.designation}</strong>
                      <div className="secondaire">{c.code}{c.stock !== null ? ` · stock ${quantite(c.stock)}` : ''}</div>
                    </td>
                    <td className="col-secondaire">
                      {c.derniere_reception ? `${dateFr(c.derniere_reception)}${c.fournisseur ? ` · ${c.fournisseur}` : ''}` : '—'}
                    </td>
                    <td className="nombre col-secondaire">{c.dernier_prix_achat === null ? '—' : montant(c.dernier_prix_achat)}</td>
                    <td className="nombre">{c.cout === null ? '—' : montant(c.cout)}</td>
                    <td className="nombre">{montant(c.prix_vente)}</td>
                    <td className={`nombre ${c.marge !== null && c.marge < 0 ? 'texte-negatif' : ''}`}>
                      {c.marge === null ? '—' : `${montant(c.marge)} (${Math.round(c.taux ?? 0)} %)`}
                    </td>
                    <td className="nombre">
                      {c.conseille === null ? '—' : (
                        <span className={c.conseille > Number(c.prix_vente) ? 'texte-alerte' : ''}>{montant(c.conseille)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="secondaire">
          Coût de revient = (prix d’achat × quantité + part des frais) ÷ quantité, d’après la dernière réception validée (à défaut le coût
          moyen du stock). Prix conseillé = coût ÷ (1 − marge visée), arrondi aux 5 supérieurs. En orange : le prix actuel est sous le prix conseillé.
        </p>
      </section>
    </>
  );
}
