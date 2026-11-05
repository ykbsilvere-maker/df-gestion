import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { dateHeure, differences, libelleAction, messageErreur } from '../lib/format';
import type { LigneAudit, Profil } from '../lib/types';
import { Alerte, Champ, EnTetePage, Vide } from '../components/ui';

const PAR_PAGE = 50;

const FAMILLES: { valeur: string; libelle: string }[] = [
  { valeur: '', libelle: 'Toutes les opérations' },
  { valeur: 'session.', libelle: 'Connexions et déconnexions' },
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
  return String(v);
}

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

  const charger = useCallback(async () => {
    if (!org) return;
    let q = supabase
      .from('journal_audit')
      .select('*')
      .eq('organisation_id', org)
      .order('id', { ascending: false })
      .range(page * PAR_PAGE, page * PAR_PAGE + PAR_PAGE); // une ligne de plus pour savoir s'il reste des pages
    if (famille) q = q.like('action', `${famille}%`);
    if (utilisateur) q = q.eq('user_id', utilisateur);
    if (du) q = q.gte('created_at', `${du}T00:00:00Z`);
    if (au) q = q.lte('created_at', `${au}T23:59:59.999Z`);
    const { data, error } = await q;
    if (error) return setErreur(messageErreur(error));
    const rows = (data ?? []) as LigneAudit[];
    setEncore(rows.length > PAR_PAGE);
    setLignes(rows.slice(0, PAR_PAGE));
  }, [org, page, famille, utilisateur, du, au]);

  useEffect(() => {
    void charger();
  }, [charger]);

  const nom = (id: string | null) => (id ? profils[id]?.nom_complet || profils[id]?.email || 'Utilisateur' : 'Système');
  const filtre = (fn: () => void) => {
    fn();
    setPage(0);
  };

  return (
    <>
      <EnTetePage
        icone="📜" titre="Journal d’audit"
        sousTitre="Toutes les opérations sensibles, horodatées (heure d’Abidjan). Ce journal ne peut être ni modifié ni effacé."
      />
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
                    <span className="journal-action">{libelleAction(l.action)}</span>
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
                            .map(([k, v]) => `${k} : ${valeurLisible(v)}`)
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
                                <td>{c.champ}</td>
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
        <div className="pagination">
          <button className="bouton bouton-discret" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Plus récentes
          </button>
          <span>Page {page + 1}</span>
          <button className="bouton bouton-discret" disabled={!encore} onClick={() => setPage(page + 1)}>
            Plus anciennes
          </button>
        </div>
      </section>
    </>
  );
}
