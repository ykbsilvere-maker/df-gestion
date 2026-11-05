import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { useIdentite } from '../lib/identite';
import { messageErreur } from '../lib/format';
import { clavierMontant, lireMontant, montant } from '../lib/argent';
import { quantite, useMagasinCourant, useMagasins } from '../lib/stock';
import { dateFr } from '../lib/tresorerie';
import { useImpression } from '../impression/impression';
import { Alerte, Champ, EnTetePage, Pastille, Vide } from '../components/ui';
import { RechercheProduit, type ProduitTrouve } from '../components/RechercheProduit';
import { useDemandeCreation } from '../lib/demande';

type Statut = 'brouillon' | 'envoye' | 'accepte' | 'refuse' | 'converti';
interface Devis {
  id: string;
  magasin_id: string;
  type: 'devis' | 'proforma';
  numero: string;
  client_id: string | null;
  client_nom: string | null;
  client_contact: string | null;
  date_devis: string;
  validite: string;
  statut: Statut;
  conditions: string | null;
  note: string | null;
  total: number;
  total_remises: number;
}
interface LigneDevis {
  id: string;
  produit_id: string | null;
  designation: string;
  quantite: number | string;
  prix_unitaire: number;
  remise: number;
  ordre: number;
}

const STATUTS: Record<Statut, { ton: 'gris' | 'or' | 'vert' | 'rouge'; libelle: string }> = {
  brouillon: { ton: 'gris', libelle: 'Brouillon' },
  envoye: { ton: 'or', libelle: 'Envoyé' },
  accepte: { ton: 'vert', libelle: 'Accepté' },
  refuse: { ton: 'rouge', libelle: 'Refusé' },
  converti: { ton: 'vert', libelle: 'Transformé en vente' },
};

export function ListeDevis() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const magasins = useMagasins(org);
  const [magasin] = useMagasinCourant(org, magasins);
  const [liste, setListe] = useState<Devis[]>([]);
  const [erreur, setErreur] = useState('');
  useDemandeCreation(magasins.length > 0, () => void creer('devis'));

  useEffect(() => {
    void supabase
      .from('devis')
      .select('*')
      .eq('organisation_id', org)
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data, error }) => (error ? setErreur(messageErreur(error)) : setListe((data ?? []) as Devis[])));
  }, [org]);

  async function creer(type: 'devis' | 'proforma') {
    const mag = magasin || magasins[0]?.id;
    if (!mag) return;
    const { data, error } = await supabase.from('devis').insert({ organisation_id: org, magasin_id: mag, type }).select('id').single();
    if (error) return setErreur(messageErreur(error));
    naviguer(`/devis/${(data as { id: string }).id}`);
  }

  return (
    <>
      <EnTetePage
        icone="📄"
        titre="Devis et proformas"
        sousTitre="Préparez une offre de prix, imprimez-la, puis transformez-la en vente quand le client accepte."
        actions={
          peut('ventes.valider') && (
            <>
              <button className="bouton bouton-discret" onClick={() => void creer('proforma')}>Nouvelle proforma</button>
              <button className="bouton bouton-principal" onClick={() => void creer('devis')}>Nouveau devis</button>
            </>
          )
        }
      />
      <Alerte>{erreur}</Alerte>
      <section className="carte">
        {liste.length === 0 ? (
          <Vide>Aucun devis.</Vide>
        ) : (
          <table className="tableau">
            <thead>
              <tr><th>N°</th><th>Date</th><th>Client</th><th className="col-secondaire">Validité</th><th className="nombre">Total</th><th>Statut</th></tr>
            </thead>
            <tbody>
              {liste.map((d) => (
                <tr key={d.id} className="ligne-cliquable" onClick={() => naviguer(`/devis/${d.id}`)}>
                  <td className="code">{d.numero}</td>
                  <td>{dateFr(d.date_devis)}</td>
                  <td>{d.client_nom ?? '—'}</td>
                  <td className="col-secondaire">{dateFr(d.validite)}</td>
                  <td className="nombre">{montant(d.total)}</td>
                  <td><Pastille ton={STATUTS[d.statut].ton}>{STATUTS[d.statut].libelle}</Pastille></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

export function FicheDevis() {
  const { id } = useParams();
  const { organisation, peut } = useSession();
  const { identite } = useIdentite();
  const { imprimer } = useImpression();
  const org = organisation!.organisation_id;
  const naviguer = useNavigate();
  const [d, setD] = useState<Devis | null>(null);
  const [lignes, setLignes] = useState<LigneDevis[]>([]);
  const [clients, setClients] = useState<{ id: string; nom: string; telephone: string | null; adresse: string | null }[]>([]);
  const [erreur, setErreur] = useState('');

  const charger = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      supabase.from('devis').select('*').eq('id', id!).single(),
      supabase.from('devis_lignes').select('*').eq('devis_id', id!).order('ordre').order('created_at'),
      supabase.from('clients').select('id, nom, telephone, adresse').eq('organisation_id', org).eq('actif', true).order('nom'),
    ]);
    if (a.error) return setErreur(messageErreur(a.error));
    setD(a.data as Devis);
    setLignes((b.data ?? []) as LigneDevis[]);
    setClients((c.data ?? []) as typeof clients);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, org]);
  useEffect(() => {
    void charger();
  }, [charger]);

  const modifiable = !!d && (d.statut === 'brouillon' || d.statut === 'envoye') && peut('ventes.valider');

  async function maj(champs: Partial<Devis>) {
    if (!d) return;
    setD({ ...d, ...champs });
    const { error } = await supabase.from('devis').update(champs).eq('id', d.id);
    if (error) setErreur(messageErreur(error));
  }

  async function ajouter(p: ProduitTrouve) {
    if (!d) return;
    const { data: prod } = await supabase.from('produits').select('designation, prix_vente').eq('id', p.id).single();
    const { error } = await supabase.from('devis_lignes').insert({
      organisation_id: org,
      devis_id: d.id,
      produit_id: p.id,
      designation: (prod as { designation: string } | null)?.designation ?? p.designation,
      quantite: 1,
      prix_unitaire: Number((prod as { prix_vente: number } | null)?.prix_vente ?? 0),
      ordre: lignes.length,
    });
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

  async function ajouterLibre() {
    if (!d) return;
    const designation = window.prompt('Désignation (prestation, article hors catalogue…)');
    if (!designation?.trim()) return;
    const prix = lireMontant(window.prompt('Prix unitaire') ?? '') ?? 0;
    const { error } = await supabase.from('devis_lignes').insert({
      organisation_id: org,
      devis_id: d.id,
      designation: designation.trim(),
      quantite: 1,
      prix_unitaire: prix,
      ordre: lignes.length,
    });
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

  async function majLigne(l: LigneDevis, champs: Partial<LigneDevis>) {
    const { error } = await supabase.from('devis_lignes').update(champs).eq('id', l.id);
    if (error) setErreur(messageErreur(error));
    await charger();
  }

  async function supprimerLigne(l: LigneDevis) {
    const { error } = await supabase.from('devis_lignes').delete().eq('id', l.id);
    if (error) setErreur(messageErreur(error));
    await charger();
  }

  async function statut(s: Statut) {
    if (!d) return;
    const { error } = await supabase.rpc('changer_statut_devis', { p_devis: d.id, p_statut: s, p_vente: null });
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

  function enVente() {
    if (!d) return;
    const vendables = lignes.filter((l) => l.produit_id);
    if (!vendables.length) return setErreur('Aucune ligne du catalogue à encaisser.');
    try {
      localStorage.setItem(
        'dfg_panier_import',
        JSON.stringify({
          devis: d.id,
          numero: d.numero,
          client: d.client_nom,
          lignes: vendables.map((l) => ({
            produit_id: l.produit_id,
            designation: l.designation,
            unite: '',
            quantite: Number(l.quantite),
            prix_unitaire: Number(l.prix_unitaire),
            remise: Number(l.remise),
          })),
        }),
      );
    } catch {
      return setErreur('Impossible de préparer le panier sur cet appareil.');
    }
    naviguer('/caisse');
  }

  async function imprimerDevis() {
    if (!d) return;
    const o = identite?.organisation;
    const titre = d.type === 'proforma' ? 'Facture proforma' : 'Devis';
    await imprimer(
      <div className="rapport-a4 lettre">
        <header className="lettre-entete">
          <div>
            {identite?.logoUrl && <img src={identite.logoUrl} alt="" />}
            <strong>{o?.nom ?? organisation!.nom}</strong>
            <div>{[o?.adresse, o?.ville].filter(Boolean).join(', ')}</div>
            <div>{[o?.telephone, o?.email].filter(Boolean).join(' · ')}</div>
            <div>{[o?.ncc && `NCC ${o.ncc}`, o?.rccm && `RCCM ${o.rccm}`].filter(Boolean).join(' · ')}</div>
          </div>
          <div className="lettre-destinataire">
            <span className="secondaire">Client</span>
            <strong>{d.client_nom ?? '—'}</strong>
            {d.client_contact && <div>{d.client_contact}</div>}
          </div>
        </header>
        <h1 className="devis-titre">{titre} n° {d.numero}</h1>
        <p>Date : {dateFr(d.date_devis)} · Valable jusqu’au {dateFr(d.validite)}</p>
        <table className="rapport-tableau">
          <thead>
            <tr><th>Désignation</th><th className="nombre">Qté</th><th className="nombre">Prix unitaire</th><th className="nombre">Remise</th><th className="nombre">Montant</th></tr>
          </thead>
          <tbody>
            {lignes.map((l) => (
              <tr key={l.id}>
                <td>{l.designation}</td>
                <td className="nombre">{quantite(l.quantite)}</td>
                <td className="nombre">{montant(l.prix_unitaire)}</td>
                <td className="nombre">{Number(l.remise) ? montant(l.remise) : ''}</td>
                <td className="nombre">{montant(Math.round(Number(l.quantite) * Number(l.prix_unitaire)) - Number(l.remise))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {Number(d.total_remises) > 0 && <tr><td colSpan={4}>Dont remises</td><td className="nombre">{montant(d.total_remises)}</td></tr>}
            <tr><td colSpan={4}>Total à payer</td><td className="nombre">{montant(d.total)}</td></tr>
          </tfoot>
        </table>
        {d.conditions && <p><strong>Conditions :</strong> {d.conditions}</p>}
        {d.note && <p>{d.note}</p>}
        <div className="signatures">
          <div>Pour {o?.nom ?? organisation!.nom}<br /><span>Signature et cachet</span></div>
          <div />
          <div>Bon pour accord du client<br /><span>Date, nom et signature</span></div>
        </div>
      </div>,
      'a4',
    );
    if (d.statut === 'brouillon' && peut('ventes.valider')) await statut('envoye');
  }

  if (!d) return <EnTetePage titre="Devis" sousTitre={erreur || 'Chargement…'} />;

  return (
    <>
      <EnTetePage
        icone="📄"
        titre={`${d.type === 'proforma' ? 'Proforma' : 'Devis'} ${d.numero}`}
        sousTitre={`${STATUTS[d.statut].libelle} · valable jusqu’au ${dateFr(d.validite)}`}
        actions={
          <>
            <button className="bouton bouton-discret" onClick={() => void imprimerDevis()} disabled={!lignes.length}>🖨️ Imprimer</button>
            {d.statut !== 'converti' && peut('ventes.valider') && peut('caisse.creer') && (
              <button className="bouton bouton-principal" onClick={enVente} disabled={!lignes.length}>Transformer en vente</button>
            )}
            <button className="bouton bouton-discret" onClick={() => naviguer('/devis')}>Retour</button>
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      <section className="carte">
        <fieldset disabled={!modifiable} className="sans-bordure">
          <div className="grille-4">
            <Champ label="Type">
              <select value={d.type} onChange={(e) => void maj({ type: e.target.value as Devis['type'] })}>
                <option value="devis">Devis</option>
                <option value="proforma">Facture proforma</option>
              </select>
            </Champ>
            <Champ label="Client enregistré">
              <select
                value={d.client_id ?? ''}
                onChange={(e) => {
                  const c = clients.find((x) => x.id === e.target.value);
                  void maj({ client_id: c?.id ?? null, client_nom: c?.nom ?? d.client_nom, client_contact: c ? [c.telephone, c.adresse].filter(Boolean).join(' · ') : d.client_contact });
                }}
              >
                <option value="">Autre client</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.nom}</option>
                ))}
              </select>
            </Champ>
            <Champ label="Nom du client">
              <input defaultValue={d.client_nom ?? ''} key={`n-${d.client_nom}`} onBlur={(e) => void maj({ client_nom: e.target.value.trim() || null })} />
            </Champ>
            <Champ label="Contact">
              <input defaultValue={d.client_contact ?? ''} key={`c-${d.client_contact}`} onBlur={(e) => void maj({ client_contact: e.target.value.trim() || null })} placeholder="Téléphone, adresse" />
            </Champ>
            <Champ label="Date">
              <input type="date" value={d.date_devis} onChange={(e) => void maj({ date_devis: e.target.value })} />
            </Champ>
            <Champ label="Valable jusqu’au">
              <input type="date" value={d.validite} min={d.date_devis} onChange={(e) => void maj({ validite: e.target.value })} />
            </Champ>
          </div>
          <Champ label="Conditions" aide="Délai de livraison, acompte, mode de paiement…">
            <input defaultValue={d.conditions ?? ''} onBlur={(e) => void maj({ conditions: e.target.value.trim() || null })} maxLength={600} />
          </Champ>
        </fieldset>
      </section>
      <section className="carte">
        {modifiable && (
          <div className="champ-avec-bouton">
            <RechercheProduit org={org} onChoisir={(p) => void ajouter(p)} placeholder="Ajouter un produit du catalogue" />
            <button className="bouton bouton-discret" onClick={() => void ajouterLibre()}>+ Ligne libre</button>
          </div>
        )}
        {lignes.length === 0 ? (
          <Vide>Aucune ligne.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau tableau-saisie">
              <thead>
                <tr><th>Désignation</th><th className="nombre">Qté</th><th className="nombre">Prix unitaire</th><th className="nombre">Remise</th><th className="nombre">Montant</th>{modifiable && <th aria-label="Retirer" />}</tr>
              </thead>
              <tbody>
                {lignes.map((l) => (
                  <tr key={l.id}>
                    <td>{l.designation}{!l.produit_id && <span className="secondaire"> · hors catalogue</span>}</td>
                    <td className="nombre">
                      {modifiable ? (
                        <input className="champ-nombre" inputMode="decimal" defaultValue={quantite(l.quantite)} key={`q-${l.id}-${l.quantite}`}
                          onBlur={(e) => { const v = Number(e.target.value.replace(/\s/g, '').replace(',', '.')); if (v > 0 && v !== Number(l.quantite)) void majLigne(l, { quantite: v }); }} />
                      ) : quantite(l.quantite)}
                    </td>
                    <td className="nombre">
                      {modifiable ? (
                        <input className="champ-nombre champ-prix" inputMode={clavierMontant()} defaultValue={montant(l.prix_unitaire, '')} key={`p-${l.id}-${l.prix_unitaire}`}
                          onBlur={(e) => { const v = lireMontant(e.target.value) ?? 0; if (v !== Number(l.prix_unitaire)) void majLigne(l, { prix_unitaire: v }); }} />
                      ) : montant(l.prix_unitaire)}
                    </td>
                    <td className="nombre">
                      {modifiable ? (
                        <input className="champ-nombre champ-prix" inputMode={clavierMontant()} defaultValue={Number(l.remise) ? montant(l.remise, '') : ''} placeholder="0" key={`r-${l.id}-${l.remise}`}
                          onBlur={(e) => { const v = lireMontant(e.target.value) ?? 0; if (v !== Number(l.remise)) void majLigne(l, { remise: v }); }} />
                      ) : Number(l.remise) ? montant(l.remise) : '—'}
                    </td>
                    <td className="nombre">{montant(Math.round(Number(l.quantite) * Number(l.prix_unitaire)) - Number(l.remise))}</td>
                    {modifiable && (
                      <td><button className="bouton-lien lien-danger" onClick={() => void supprimerLigne(l)}>Retirer</button></td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="ligne-total">
                  <td colSpan={4}>Total (calculé)</td>
                  <td className="nombre">{montant(d.total)}</td>
                  {modifiable && <td />}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {peut('ventes.valider') && d.statut !== 'converti' && (
          <div className="actions-piece">
            {d.statut !== 'accepte' && <button className="bouton bouton-discret" onClick={() => void statut('accepte')}>Accepté par le client</button>}
            {d.statut !== 'refuse' && <button className="bouton-lien lien-danger" onClick={() => void statut('refuse')}>Refusé</button>}
          </div>
        )}
      </section>
    </>
  );
}
