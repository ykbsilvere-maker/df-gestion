import { LogoCompte } from '../../components/LogoMoyen';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { clavierMontant, lireMontant, montant } from '../../lib/argent';
import { aujourdhui, dateFr, TYPES_COMPTE, type CompteTresorerie, type TypeCompte } from '../../lib/tresorerie';
import { Alerte, Champ, EnTetePage, Fenetre, MontantFort, Pastille, Vide } from '../../components/ui';

interface CompteSolde extends CompteTresorerie {
  solde: number;
  entrees_mois: number;
  sorties_mois: number;
  dernier_rapprochement: { date: string; ecart: number } | null;
}
interface Etat {
  comptes: CompteSolde[];
  total: number;
  dettes_30_jours: number;
  budget_restant: number;
  liquidite: number;
  virements_en_attente: number;
}
interface Mouvement {
  date_flux: string;
  nature: string;
  libelle: string;
  montant: number;
  operations: number;
}
interface Virement {
  id: string;
  date_virement: string;
  compte_source_id: string;
  compte_destination_id: string;
  montant: number;
  frais: number;
  reference: string | null;
  statut: 'en_attente' | 'valide' | 'annule';
}

const debutMois = () => `${aujourdhui().slice(0, 7)}-01`;

export function Tresorerie() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const [etat, setEtat] = useState<Etat | null>(null);
  const [virements, setVirements] = useState<Virement[]>([]);
  const [caisses, setCaisses] = useState<{ id: string; nom: string }[]>([]);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [compteOuvert, setCompteOuvert] = useState<CompteSolde | null>(null);
  const [periode, setPeriode] = useState({ du: debutMois(), au: aujourdhui() });
  const [mouvements, setMouvements] = useState<{ solde_debut: number; solde_fin: number; mouvements: Mouvement[] } | null>(null);
  const [virement, setVirement] = useState<Record<string, string> | null>(null);
  const [rapprochement, setRapprochement] = useState<{ compte: CompteSolde; date: string; solde: string; justification: string } | null>(null);
  const [edition, setEdition] = useState<Partial<CompteTresorerie> | null>(null);

  const charger = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      supabase.rpc('tresorerie', { p_org: org }),
      supabase.from('virements').select('*').eq('organisation_id', org).order('date_virement', { ascending: false }).order('created_at', { ascending: false }).limit(30),
      supabase.from('caisses').select('id, nom').eq('organisation_id', org).order('nom'),
    ]);
    if (a.error) return setErreur(messageErreur(a.error));
    setEtat(a.data as Etat);
    setVirements((b.data ?? []) as Virement[]);
    setCaisses((c.data ?? []) as { id: string; nom: string }[]);
  }, [org]);
  useEffect(() => {
    void charger();
  }, [charger]);

  useEffect(() => {
    if (!compteOuvert) return setMouvements(null);
    void supabase
      .rpc('mouvements_tresorerie', { p_compte: compteOuvert.id, p_debut: periode.du, p_fin: periode.au })
      .then(({ data, error }) => (error ? setErreur(messageErreur(error)) : setMouvements(data as typeof mouvements)));
  }, [compteOuvert, periode]);

  const comptes = etat?.comptes ?? [];
  const actifs = comptes.filter((c) => c.actif);
  const nomCompte = (id: string) => comptes.find((c) => c.id === id)?.nom ?? '—';

  async function saisirVirement(e: FormEvent) {
    e.preventDefault();
    if (!virement) return;
    const m = lireMontant(virement.montant ?? '');
    if (!m || m <= 0) return setErreur('Indiquez le montant.');
    const { data, error } = await supabase.rpc('saisir_virement', {
      p_org: org,
      p_source: virement.source,
      p_destination: virement.destination,
      p_montant: m,
      p_frais: lireMontant(virement.frais ?? '') ?? 0,
      p_date: virement.date,
      p_reference: virement.reference || null,
      p_note: virement.note || null,
    });
    if (error) return setErreur(messageErreur(error));
    setVirement(null);
    setInfo((data as { statut: string }).statut === 'valide' ? 'Virement enregistré.' : 'Virement enregistré : en attente de validation.');
    await charger();
  }

  async function validerVirement(v: Virement) {
    const { error } = await supabase.rpc('valider_virement', { p_virement: v.id });
    if (error) return setErreur(messageErreur(error));
    await charger();
  }
  async function annulerVirement(v: Virement) {
    const motif = window.prompt('Motif de l’annulation du virement');
    if (!motif?.trim()) return;
    const { error } = await supabase.rpc('annuler_virement', { p_virement: v.id, p_motif: motif.trim() });
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

  async function rapprocher(e: FormEvent) {
    e.preventDefault();
    if (!rapprochement) return;
    const s = lireMontant(rapprochement.solde);
    if (s === null) return setErreur('Indiquez le solde constaté.');
    const { data, error } = await supabase.rpc('rapprocher_compte', {
      p_compte: rapprochement.compte.id,
      p_date: rapprochement.date,
      p_solde_constate: s,
      p_justification: rapprochement.justification || null,
    });
    if (error) return setErreur(messageErreur(error));
    const ecart = Number((data as { ecart: number }).ecart);
    setRapprochement(null);
    setInfo(ecart === 0 ? 'Rapprochement enregistré : aucun écart.' : `Rapprochement enregistré : écart de ${montant(ecart)} ajusté.`);
    await charger();
  }

  async function enregistrerCompte(e: FormEvent) {
    e.preventDefault();
    if (!edition) return;
    const champs = {
      nom: edition.nom?.trim(),
      type: edition.type ?? 'autre',
      caisse_id: edition.caisse_id || null,
      numero: edition.numero || null,
      solde_initial: Number(edition.solde_initial ?? 0),
      date_ouverture: edition.date_ouverture ?? aujourdhui(),
      ordre: edition.ordre ?? 100,
    };
    const { error } = edition.id
      ? await supabase.from('comptes_tresorerie').update({ ...champs, actif: edition.actif ?? true }).eq('id', edition.id)
      : await supabase.from('comptes_tresorerie').insert({ ...champs, organisation_id: org });
    if (error) return setErreur(/duplicate/.test(error.message) ? 'Un compte porte déjà ce nom.' : messageErreur(error));
    setEdition(null);
    await charger();
  }

  return (
    <>
      <EnTetePage
        icone="💰"
        titre="Trésorerie"
        sousTitre="Combien d’argent vous avez, où il se trouve, et si vous pouvez payer ce qui arrive."
        actions={
          <>
            {peut('tresorerie.modifier') && (
              <button className="bouton bouton-discret" onClick={() => setEdition({ type: 'caisse_centrale', solde_initial: 0, date_ouverture: aujourdhui(), actif: true })}>
                Nouveau compte
              </button>
            )}
            {peut('tresorerie.creer') && actifs.length > 1 && (
              <button
                className="bouton bouton-principal"
                onClick={() => setVirement({ source: actifs[0]!.id, destination: actifs[1]!.id, date: aujourdhui(), montant: '', frais: '' })}
              >
                Virement
              </button>
            )}
          </>
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      {etat && (
        <section className="tuiles">
          <div className="tuile tuile-fixe">
            <span className="tuile-valeur"><MontantFort v={etat.total} /></span>
            <span className="tuile-libelle">total des comptes</span>
          </div>
          <div className="tuile tuile-fixe">
            <span className="tuile-valeur"><MontantFort v={etat.dettes_30_jours} /></span>
            <span className="tuile-libelle">dettes fournisseurs à 30 jours</span>
          </div>
          <div className="tuile tuile-fixe">
            <span className="tuile-valeur"><MontantFort v={etat.budget_restant} /></span>
            <span className="tuile-libelle">budget restant du mois</span>
          </div>
          <div className={`tuile tuile-fixe ${etat.liquidite < 0 ? 'tuile-alerte' : ''}`}>
            <span className="tuile-valeur"><MontantFort v={etat.liquidite} /></span>
            <span className="tuile-libelle">{etat.liquidite < 0 ? '⚠️ liquidité négative' : 'liquidité disponible'}</span>
          </div>
        </section>
      )}
      {etat && etat.liquidite < 0 && (
        <Alerte>
          Attention : avec les dettes fournisseurs des 30 prochains jours et le budget restant, il manquera {montant(-etat.liquidite)}.
        </Alerte>
      )}

      <section className="grille-comptes">
        {comptes.map((c) => (
          <button key={c.id} type="button" className={`carte-compte ${c.actif ? '' : 'carte-compte-inactive'} ${compteOuvert?.id === c.id ? 'carte-compte-active' : ''}`} onClick={() => setCompteOuvert(compteOuvert?.id === c.id ? null : c)}>
            <span className="carte-compte-tete">
              <LogoCompte compte={c} />
              <strong>{c.nom}</strong>
            </span>
            <span className={`carte-compte-solde ${c.solde < 0 ? 'texte-negatif' : ''}`}>{montant(c.solde)}</span>
            <span className="secondaire">
              + {montant(c.entrees_mois)} · − {montant(c.sorties_mois)} ce mois
            </span>
            {c.dernier_rapprochement && (
              <span className="secondaire">Rapproché le {dateFr(c.dernier_rapprochement.date)}</span>
            )}
          </button>
        ))}
      </section>

      {compteOuvert && (
        <section className="carte">
          <div className="entete-section">
            <h2>
              <LogoCompte compte={compteOuvert} /> {compteOuvert.nom}
            </h2>
            <div className="actions-ligne">
              {peut('tresorerie.valider') && (
                <button
                  className="bouton bouton-discret"
                  onClick={() => setRapprochement({ compte: compteOuvert, date: aujourdhui(), solde: '', justification: '' })}
                >
                  Rapprocher
                </button>
              )}
              {peut('tresorerie.modifier') && (
                <button className="bouton bouton-discret" onClick={() => setEdition(compteOuvert)}>
                  Modifier le compte
                </button>
              )}
            </div>
          </div>
          <div className="filtres-ligne">
            <Champ label="Du">
              <input type="date" value={periode.du} max={periode.au} onChange={(e) => setPeriode({ ...periode, du: e.target.value })} />
            </Champ>
            <Champ label="Au">
              <input type="date" value={periode.au} min={periode.du} onChange={(e) => setPeriode({ ...periode, au: e.target.value })} />
            </Champ>
          </div>
          {!mouvements ? (
            <Vide>Chargement…</Vide>
          ) : (
            <div className="defilement-horizontal">
              <table className="tableau tableau-compact">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Opération</th>
                    <th className="nombre">Entrée</th>
                    <th className="nombre">Sortie</th>
                    <th className="nombre">Solde</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="ligne-total">
                    <td colSpan={4}>Solde au {dateFr(periode.du)}</td>
                    <td className="nombre">{montant(mouvements.solde_debut)}</td>
                  </tr>
                  {(() => {
                    let solde = Number(mouvements.solde_debut);
                    return mouvements.mouvements.map((m, i) => {
                      solde += Number(m.montant);
                      return (
                        <tr key={i}>
                          <td>{dateFr(m.date_flux)}</td>
                          <td>
                            {m.libelle}
                            {m.operations > 1 && <span className="secondaire"> · {m.operations} opérations</span>}
                          </td>
                          <td className="nombre">{Number(m.montant) > 0 ? montant(m.montant) : ''}</td>
                          <td className="nombre">{Number(m.montant) < 0 ? montant(-m.montant) : ''}</td>
                          <td className={`nombre ${solde < 0 ? 'texte-negatif' : ''}`}>{montant(solde)}</td>
                        </tr>
                      );
                    });
                  })()}
                  <tr className="ligne-total">
                    <td colSpan={4}>Solde au {dateFr(periode.au)}</td>
                    <td className="nombre">{montant(mouvements.solde_fin)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="carte">
        <h2>Virements</h2>
        {virements.length === 0 ? (
          <Vide>Aucun virement. Exemple : versement de la caisse à la banque, Wave vers la banque.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>De → vers</th>
                  <th className="col-secondaire">Référence</th>
                  <th className="nombre">Montant</th>
                  <th>Statut</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {virements.map((v) => (
                  <tr key={v.id} className={v.statut === 'annule' ? 'ligne-annulee' : ''}>
                    <td>{dateFr(v.date_virement)}</td>
                    <td>
                      {nomCompte(v.compte_source_id)} → {nomCompte(v.compte_destination_id)}
                    </td>
                    <td className="col-secondaire">{v.reference ?? '—'}</td>
                    <td className="nombre">
                      {montant(v.montant)}
                      {Number(v.frais) > 0 && <div className="secondaire">frais {montant(v.frais)}</div>}
                    </td>
                    <td>
                      {v.statut === 'valide' ? <Pastille ton="vert">Validé</Pastille> : v.statut === 'en_attente' ? <Pastille ton="or">En attente</Pastille> : <Pastille ton="gris">Annulé</Pastille>}
                    </td>
                    <td className="actions-ligne">
                      {v.statut === 'en_attente' && peut('tresorerie.valider') && (
                        <button className="bouton-lien" onClick={() => void validerVirement(v)}>
                          Valider
                        </button>
                      )}
                      {v.statut !== 'annule' && peut('tresorerie.valider') && (
                        <button className="bouton-lien lien-danger" onClick={() => void annulerVirement(v)}>
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
        <p className="secondaire">
          Aucun mouvement n’est déclenché sur Wave, Orange Money ou la banque : l’application enregistre ce qui a été fait, avec sa référence.
        </p>
      </section>

      <Fenetre titre="Virement entre comptes" ouverte={!!virement} onFermer={() => setVirement(null)}>
        {virement && (
          <form className="formulaire" onSubmit={saisirVirement}>
            <Alerte>{erreur}</Alerte>
            <div className="grille-2">
              <Champ label="Depuis">
                <select value={virement.source} onChange={(e) => setVirement({ ...virement, source: e.target.value })}>
                  {actifs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nom} ({montant(c.solde)})
                    </option>
                  ))}
                </select>
              </Champ>
              <Champ label="Vers">
                <select value={virement.destination} onChange={(e) => setVirement({ ...virement, destination: e.target.value })}>
                  {actifs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nom}
                    </option>
                  ))}
                </select>
              </Champ>
              <Champ label="Montant">
                <input value={virement.montant} onChange={(e) => setVirement({ ...virement, montant: e.target.value })} inputMode={clavierMontant()} required autoFocus />
              </Champ>
              <Champ label="Frais de transfert" aide="Payés en plus par le compte de départ">
                <input value={virement.frais} onChange={(e) => setVirement({ ...virement, frais: e.target.value })} inputMode={clavierMontant()} placeholder="0" />
              </Champ>
              <Champ label="Date">
                <input type="date" value={virement.date} max={aujourdhui()} onChange={(e) => setVirement({ ...virement, date: e.target.value })} />
              </Champ>
              <Champ label="Référence" aide="N° de bordereau, de transaction…">
                <input value={virement.reference ?? ''} onChange={(e) => setVirement({ ...virement, reference: e.target.value })} maxLength={60} />
              </Champ>
            </div>
            {!peut('tresorerie.valider') && <p className="secondaire">Le virement restera en attente jusqu’à sa validation par le propriétaire.</p>}
            <button className="bouton bouton-principal">Enregistrer le virement</button>
          </form>
        )}
      </Fenetre>

      <Fenetre titre={`Rapprochement — ${rapprochement?.compte.nom ?? ''}`} ouverte={!!rapprochement} onFermer={() => setRapprochement(null)}>
        {rapprochement && (
          <form className="formulaire" onSubmit={rapprocher}>
            <Alerte>{erreur}</Alerte>
            <p>
              Comptez la caisse ou lisez le relevé Wave / bancaire, puis indiquez le solde réel. Solde calculé aujourd’hui :{' '}
              <strong>{montant(rapprochement.compte.solde)}</strong>.
            </p>
            <div className="grille-2">
              <Champ label="Date du constat">
                <input type="date" value={rapprochement.date} max={aujourdhui()} onChange={(e) => setRapprochement({ ...rapprochement, date: e.target.value })} />
              </Champ>
              <Champ label="Solde constaté">
                <input value={rapprochement.solde} onChange={(e) => setRapprochement({ ...rapprochement, solde: e.target.value })} inputMode={clavierMontant()} required autoFocus />
              </Champ>
            </div>
            {(() => {
              const s = lireMontant(rapprochement.solde);
              const ecart = s === null || rapprochement.date !== aujourdhui() ? null : s - rapprochement.compte.solde;
              return ecart !== null && ecart !== 0 ? <Alerte type="info">Écart de {montant(ecart)} : indiquez sa justification.</Alerte> : null;
            })()}
            <Champ label="Justification de l’écart">
              <input
                value={rapprochement.justification}
                onChange={(e) => setRapprochement({ ...rapprochement, justification: e.target.value })}
                placeholder="Frais Wave non saisis, erreur de rendu…"
                maxLength={300}
              />
            </Champ>
            <button className="bouton bouton-principal">Enregistrer le rapprochement</button>
          </form>
        )}
      </Fenetre>

      <Fenetre titre={edition?.id ? 'Compte de trésorerie' : 'Nouveau compte'} ouverte={!!edition} onFermer={() => setEdition(null)}>
        {edition && (
          <form className="formulaire" onSubmit={enregistrerCompte}>
            <Alerte>{erreur}</Alerte>
            <div className="grille-2">
              <Champ label="Nom">
                <input value={edition.nom ?? ''} onChange={(e) => setEdition({ ...edition, nom: e.target.value })} required minLength={2} maxLength={60} autoFocus />
              </Champ>
              <Champ label="Type">
                <select value={edition.type} onChange={(e) => setEdition({ ...edition, type: e.target.value as TypeCompte })}>
                  {Object.entries(TYPES_COMPTE).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.libelle}
                    </option>
                  ))}
                </select>
              </Champ>
              {edition.type === 'caisse' && (
                <Champ label="Tiroir de la caisse" aide="Ses ventes en espèces arrivent sur ce compte">
                  <select value={edition.caisse_id ?? ''} onChange={(e) => setEdition({ ...edition, caisse_id: e.target.value || null })}>
                    <option value="">Toutes les caisses</option>
                    {caisses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nom}
                      </option>
                    ))}
                  </select>
                </Champ>
              )}
              <Champ label="Numéro" aide="N° de compte ou de téléphone (facultatif)">
                <input value={edition.numero ?? ''} onChange={(e) => setEdition({ ...edition, numero: e.target.value })} maxLength={40} />
              </Champ>
              <Champ label="Solde d’ouverture">
                <input
                  defaultValue={montant(edition.solde_initial ?? 0, '')}
                  onBlur={(e) => setEdition({ ...edition, solde_initial: lireMontant(e.target.value) ?? 0 })}
                  inputMode={clavierMontant()}
                />
              </Champ>
              <Champ label="Date d’ouverture" aide="Les opérations sont comptées à partir de cette date">
                <input type="date" value={edition.date_ouverture ?? aujourdhui()} onChange={(e) => setEdition({ ...edition, date_ouverture: e.target.value })} />
              </Champ>
            </div>
            {edition.id && (
              <label className="case">
                <input type="checkbox" checked={edition.actif ?? true} onChange={(e) => setEdition({ ...edition, actif: e.target.checked })} /> Compte actif
              </label>
            )}
            <button className="bouton bouton-principal">Enregistrer</button>
          </form>
        )}
      </Fenetre>
    </>
  );
}
