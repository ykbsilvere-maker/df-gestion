import { exporterClasseur, toutCharger, type FormatExport } from '../lib/export';
import { BoutonsExport, Pagination } from '../components/Export';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { appareilLisible, dateHeure, differences, iconeAction, libelleAction, libelleChamp, messageErreur } from '../lib/format';
import { imprimerPageA4 } from '../impression/impression';
import type { LigneAudit, Profil } from '../lib/types';
import { Alerte, Champ, EnTetePage, Vide } from '../components/ui';

const PAR_PAGE = 50;

const FAMILLES: { valeur: string; libelle: string }[] = [
  { valeur: '', libelle: 'Toutes les opérations' },
  { valeur: 'session.', libelle: 'Connexions et déconnexions' },
  { valeur: 'connexion.', libelle: 'Connexions par code d’entrée' },
  { valeur: 'journee.', libelle: 'Ouverture et clôture de la journée' },
  { valeur: 'sessions_caisse.', libelle: 'Ouverture et clôture des caisses' },
  { valeur: 'ventes.', libelle: 'Ventes annulées' },
  { valeur: 'produits.', libelle: 'Articles du catalogue' },
  { valeur: 'receptions.', libelle: 'Réceptions de marchandises' },
  { valeur: 'inventaires.', libelle: 'Inventaires' },
  { valeur: 'import.', libelle: 'Imports Excel' },
  { valeur: 'activite.', libelle: 'Activité : modules, impressions, exports' },
  { valeur: 'membres.', libelle: 'Utilisateurs' },
  { valeur: 'membre_', libelle: 'Périmètres et droits individuels' },
  { valeur: 'invitations.', libelle: 'Invitations' },
  { valeur: 'magasins.', libelle: 'Magasins' },
  { valeur: 'caisses.', libelle: 'Caisses' },
  { valeur: 'organisations.', libelle: 'Entreprise' },
];

function valeurLisible(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:/.test(v)) return dateHeure(v);
  return String(v);
}

/** Résumé en une ligne, lisible sans ouvrir le détail. */
function resume(l: LigneAudit): string {
  const c = l.contexte ?? {};
  if (/^(session|connexion)\./.test(l.action)) {
    const appareil = typeof c.appareil === 'string' ? c.appareil : '';
    return [appareil, appareilLisible(c.navigateur as string | undefined)].filter((x) => x && x !== 'Navigateur').join(' — ') || (l.action.includes('code_entree') ? 'Code établissement + matricule' : '');
  }
  if (l.action.startsWith('activite.')) return String(c.module ?? c.document ?? c.fichier ?? '');
  if (typeof c.motif === 'string') return `Motif : ${c.motif}`;
  const etat = l.apres ?? l.avant ?? {};
  const nom = etat.designation ?? etat.nom ?? etat.libelle ?? etat.nom_complet ?? etat.entreprise ?? etat.reference;
  if (l.action === 'import.catalogue') return `${etat.crees ?? 0} créés · ${etat.mis_a_jour ?? 0} mis à jour · ${etat.erreurs ?? 0} erreurs`;
  if (l.action === 'journee.cloturee') return `${etat.nombre_ventes ?? 0} ventes · ${Number(etat.total_ventes ?? 0).toLocaleString('fr-FR')} F`;
  const diff = l.avant && l.apres ? differences(l.avant, l.apres).map((d) => libelleChamp(d.champ)).slice(0, 3).join(', ') : '';
  return [typeof nom === 'string' ? nom : '', diff && `modifié : ${diff}`].filter(Boolean).join(' — ');
}

const isoJour = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function Journal() {
  const { organisation } = useSession();
  const org = organisation?.organisation_id;
  const [lignes, setLignes] = useState<LigneAudit[]>([]);
  const [profils, setProfils] = useState<Record<string, Profil>>({});
  const [famille, setFamille] = useState('');
  const [utilisateur, setUtilisateur] = useState('');
  const [du, setDu] = useState('');
  const [au, setAu] = useState('');
  const [page, setPage] = useState(0);
  const [tout, setTout] = useState(false);
  const [encore, setEncore] = useState(false);
  const [ouverte, setOuverte] = useState<number | null>(null);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    if (!org) return;
    void (async () => {
      const { data: mb } = await supabase.from('membres').select('user_id').eq('organisation_id', org);
      const ids = (mb ?? []).map((m: { user_id: string }) => m.user_id);
      const { data } = await supabase.from('profils').select('*').in('id', ids);
      setProfils(Object.fromEntries(((data ?? []) as Profil[]).map((p) => [p.id, p])));
    })();
  }, [org]);

  const requete = useCallback(
    (debut: number, fin: number) => {
      let q = supabase.from('journal_audit').select('*').eq('organisation_id', org as string).order('id', { ascending: false }).range(debut, fin);
      if (famille) q = q.like('action', `${famille}%`);
      if (utilisateur) q = q.eq('user_id', utilisateur);
      if (du) q = q.gte('created_at', `${du}T00:00:00Z`);
      if (au) q = q.lte('created_at', `${au}T23:59:59.999Z`);
      return q;
    },
    [org, famille, utilisateur, du, au],
  );
  const charger = useCallback(async () => {
    if (!org) return;
    if (tout) {
      try {
        setLignes(await toutCharger<LigneAudit>(requete));
        setEncore(false);
      } catch (e) {
        setErreur(messageErreur(e));
      }
      return;
    }
    const { data, error } = await requete(page * PAR_PAGE, page * PAR_PAGE + PAR_PAGE); // une ligne de plus pour savoir s'il reste des pages
    if (error) return setErreur(messageErreur(error));
    const rows = (data ?? []) as LigneAudit[];
    setEncore(rows.length > PAR_PAGE);
    setLignes(rows.slice(0, PAR_PAGE));
  }, [org, page, tout, requete]);

  useEffect(() => {
    void charger();
  }, [charger]);

  const nom = (id: string | null) => (id ? profils[id]?.nom_complet || profils[id]?.email || 'Utilisateur' : 'Système');
  const filtre = (fn: () => void) => {
    fn();
    setPage(0);
  };
  const periode = (jours: number) =>
    filtre(() => {
      const fin = new Date();
      const debut = new Date(fin.getTime() - (jours - 1) * 86400000);
      setDu(isoJour(debut));
      setAu(isoJour(fin));
    });

  /** Export de la page affichée (avec les filtres) pour l'archiver ou la remettre à un contrôleur. */
  /** Toutes les lignes qui répondent aux filtres, pas seulement la page affichée. */
  async function exporter(format: FormatExport = 'xlsx') {
    let toutes: LigneAudit[];
    try {
      toutes = tout ? lignes : await toutCharger<LigneAudit>(requete);
    } catch (e) {
      return setErreur(messageErreur(e));
    }
    exporterClasseur(
      `Piste-audit-${isoJour(new Date())}.xlsx`,
      [
        {
          nom: 'Piste d’audit',
          entetes: ['Date et heure', 'Opération', 'Utilisateur', 'Détail', 'Référence'],
          lignes: toutes.map((l) => [dateHeure(l.created_at), libelleAction(l.action), nom(l.user_id), resume(l), `#${l.id}`]),
          titre: ['Piste d’audit', [du && `du ${du}`, au && `au ${au}`].filter(Boolean).join(' ') || 'Toutes les dates'],
          largeurs: [20, 36, 26, 60, 12],
        },
      ],
      format,
    );
  }

  return (
    <>
      <EnTetePage
        icone="📜" titre="Piste d’audit"
        sousTitre="Qui a fait quoi, quand et depuis quel appareil : connexions, caisses, journées, articles, stock, utilisateurs. Horodaté (heure d’Abidjan), ni modifiable ni effaçable."
        actions={
          <div className="actions-entete">
            <BoutonsExport onExport={exporter} disabled={!lignes.length} />
            <button type="button" className="bouton bouton-discret" onClick={() => void imprimerPageA4('Piste d’audit')} disabled={!lignes.length}>🖨️ Imprimer (A4)</button>
          </div>
        }
      />
      <div className="audit-raccourcis">
        <button type="button" className="bouton bouton-discret bouton-petit" onClick={() => periode(1)}>Aujourd’hui</button>
        <button type="button" className="bouton bouton-discret bouton-petit" onClick={() => periode(7)}>7 jours</button>
        <button type="button" className="bouton bouton-discret bouton-petit" onClick={() => periode(30)}>30 jours</button>
        <button type="button" className={`bouton bouton-petit ${famille === 'session.' ? 'bouton-principal' : 'bouton-discret'}`} onClick={() => filtre(() => setFamille(famille === 'session.' ? '' : 'session.'))}>🔑 Connexions</button>
        <button type="button" className={`bouton bouton-petit ${famille === 'sessions_caisse.' ? 'bouton-principal' : 'bouton-discret'}`} onClick={() => filtre(() => setFamille(famille === 'sessions_caisse.' ? '' : 'sessions_caisse.'))}>🛒 Caisses</button>
        {(famille || utilisateur || du || au) && (
          <button type="button" className="bouton-lien" onClick={() => filtre(() => { setFamille(''); setUtilisateur(''); setDu(''); setAu(''); })}>Tout afficher</button>
        )}
      </div>
      <Alerte>{erreur}</Alerte>

      <section className="carte filtres">
        <Champ label="Opérations">
          <select value={famille} onChange={(e) => filtre(() => setFamille(e.target.value))}>
            {FAMILLES.map((f) => (
              <option key={f.valeur} value={f.valeur}>
                {f.libelle}
              </option>
            ))}
          </select>
        </Champ>
        <Champ label="Utilisateur">
          <select value={utilisateur} onChange={(e) => filtre(() => setUtilisateur(e.target.value))}>
            <option value="">Tous</option>
            {Object.values(profils).map((p) => (
              <option key={p.id} value={p.id}>
                {p.nom_complet || p.email}
              </option>
            ))}
          </select>
        </Champ>
        <Champ label="Du">
          <input type="date" value={du} onChange={(e) => filtre(() => setDu(e.target.value))} />
        </Champ>
        <Champ label="Au">
          <input type="date" value={au} onChange={(e) => filtre(() => setAu(e.target.value))} />
        </Champ>
      </section>

      <section className="carte">
        {lignes.length === 0 ? (
          <Vide>Aucune opération pour ces critères.</Vide>
        ) : (
          <ul className="journal">
            {lignes.map((l) => {
              const diff = differences(l.avant, l.apres);
              const motif = l.contexte?.motif as string | undefined;
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    className="journal-ligne"
                    onClick={() => setOuverte(ouverte === l.id ? null : l.id)}
                    aria-expanded={ouverte === l.id}
                  >
                    <time>{dateHeure(l.created_at)}</time>
                    <span className="journal-action">
                      <span aria-hidden>{iconeAction(l.action)} </span>
                      {libelleAction(l.action)}
                      {resume(l) && <small>{resume(l)}</small>}
                    </span>
                    <span className="journal-auteur">{nom(l.user_id)}</span>
                  </button>
                  {ouverte === l.id && (
                    <div className="journal-detail">
                      {motif && (
                        <p>
                          <strong>Motif :</strong> {motif}
                        </p>
                      )}
                      {l.contexte && !motif && (
                        <p className="secondaire">
                          {Object.entries(l.contexte)
                            .map(([k, v]) => `${libelleChamp(k)} : ${k === 'navigateur' ? appareilLisible(String(v)) || valeurLisible(v) : valeurLisible(v)}`)
                            .join(' · ')}
                        </p>
                      )}
                      {diff.length > 0 && (
                        <table className="tableau tableau-compact">
                          <thead>
                            <tr>
                              <th>Champ</th>
                              <th>Avant</th>
                              <th>Après</th>
                            </tr>
                          </thead>
                          <tbody>
                            {diff.map((c) => (
                              <tr key={c.champ}>
                                <td>{libelleChamp(c.champ)}</td>
                                <td>{valeurLisible(c.avant)}</td>
                                <td>{valeurLisible(c.apres)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      <p className="secondaire">Référence : #{l.id}</p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <Pagination page={page} encore={encore} tout={tout} nombre={lignes.length} setPage={setPage} setTout={setTout} precedent="Plus récentes" suivant="Plus anciennes" />
      </section>
    </>
  );
}
