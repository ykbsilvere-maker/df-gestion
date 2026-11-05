import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';
import type { Caisse, Magasin } from '../lib/types';
import { Alerte, Champ, EnTetePage, Fenetre, Pastille, Vide } from '../components/ui';

type Edition =
  | { type: 'magasin'; magasin?: Magasin }
  | { type: 'caisse'; magasinId: string; caisse?: Caisse }
  | null;

export function Magasins() {
  const { organisation, peut } = useSession();
  const org = organisation?.organisation_id;
  const [magasins, setMagasins] = useState<Magasin[]>([]);
  const [caisses, setCaisses] = useState<Caisse[]>([]);
  const [erreur, setErreur] = useState('');
  const [edition, setEdition] = useState<Edition>(null);

  const charger = useCallback(async () => {
    if (!org) return;
    const [m, c] = await Promise.all([
      supabase.from('magasins').select('*').eq('organisation_id', org).order('code'),
      supabase.from('caisses').select('*').eq('organisation_id', org).order('code'),
    ]);
    if (m.error || c.error) return setErreur(messageErreur(m.error ?? c.error));
    setMagasins(m.data as Magasin[]);
    setCaisses(c.data as Caisse[]);
  }, [org]);

  useEffect(() => {
    void charger();
  }, [charger]);

  async function basculer(table: 'magasins' | 'caisses', id: string, actif: boolean) {
    setErreur('');
    const { error } = await supabase.from(table).update({ actif }).eq('id', id);
    if (error) setErreur(messageErreur(error));
    await charger();
  }

  return (
    <>
      <EnTetePage
        icone="🏪" titre="Magasins et caisses"
        sousTitre="Chaque caisse appartient à un magasin. Un élément désactivé reste dans l’historique."
        actions={
          peut('magasins.creer') && (
            <button className="bouton bouton-principal" onClick={() => setEdition({ type: 'magasin' })}>
              Ajouter un magasin
            </button>
          )
        }
      />
      <Alerte>{erreur}</Alerte>
      {magasins.length === 0 && <Vide>Aucun magasin accessible.</Vide>}

      <div className="liste-cartes">
        {magasins.map((m) => {
          const sesCaisses = caisses.filter((c) => c.magasin_id === m.id);
          return (
            <section key={m.id} className={`carte ${m.actif ? '' : 'carte-inactive'}`}>
              <div className="carte-entete">
                <div>
                  <h2>
                    {m.nom} <span className="code">{m.code}</span>
                  </h2>
                  <p className="sous-titre">{[m.adresse, m.ville, m.telephone].filter(Boolean).join(' · ') || '—'}</p>
                </div>
                <div className="actions-ligne">
                  {!m.actif && <Pastille ton="gris">Désactivé</Pastille>}
                  {peut('magasins.modifier') && (
                    <>
                      <button className="bouton bouton-discret" onClick={() => setEdition({ type: 'magasin', magasin: m })}>
                        Modifier
                      </button>
                      <button className="bouton bouton-discret" onClick={() => void basculer('magasins', m.id, !m.actif)}>
                        {m.actif ? 'Désactiver' : 'Réactiver'}
                      </button>
                    </>
                  )}
                </div>
              </div>

              <table className="tableau">
                <thead>
                  <tr>
                    <th>Caisse</th>
                    <th>Code</th>
                    <th>Statut</th>
                    {peut('magasins.modifier') && <th aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {sesCaisses.map((c) => (
                    <tr key={c.id}>
                      <td>{c.nom}</td>
                      <td className="code">{c.code}</td>
                      <td>{c.actif ? <Pastille ton="vert">Active</Pastille> : <Pastille ton="gris">Désactivée</Pastille>}</td>
                      {peut('magasins.modifier') && (
                        <td className="cellule-actions">
                          <button
                            className="bouton-lien"
                            onClick={() => setEdition({ type: 'caisse', magasinId: m.id, caisse: c })}
                          >
                            Modifier
                          </button>
                          <button className="bouton-lien" onClick={() => void basculer('caisses', c.id, !c.actif)}>
                            {c.actif ? 'Désactiver' : 'Réactiver'}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {sesCaisses.length === 0 && (
                    <tr>
                      <td colSpan={4} className="vide">
                        Aucune caisse
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {peut('magasins.creer') && m.actif && (
                <button className="bouton bouton-discret" onClick={() => setEdition({ type: 'caisse', magasinId: m.id })}>
                  Ajouter une caisse
                </button>
              )}
            </section>
          );
        })}
      </div>

      <Fenetre
        titre={
          edition?.type === 'magasin'
            ? edition.magasin
              ? 'Modifier le magasin'
              : 'Nouveau magasin'
            : edition?.caisse
              ? 'Modifier la caisse'
              : 'Nouvelle caisse'
        }
        ouverte={!!edition}
        onFermer={() => setEdition(null)}
      >
        {edition?.type === 'magasin' && org && (
          <FormulaireMagasin
            org={org}
            magasin={edition.magasin}
            suggestion={`MAG${String(magasins.length + 1).padStart(2, '0')}`}
            onFini={async () => {
              setEdition(null);
              await charger();
            }}
          />
        )}
        {edition?.type === 'caisse' && org && (
          <FormulaireCaisse
            org={org}
            magasinId={edition.magasinId}
            caisse={edition.caisse}
            suggestion={`CAISSE${String(caisses.filter((c) => c.magasin_id === edition.magasinId).length + 1).padStart(2, '0')}`}
            onFini={async () => {
              setEdition(null);
              await charger();
            }}
          />
        )}
      </Fenetre>
    </>
  );
}

function FormulaireMagasin({
  org,
  magasin,
  suggestion,
  onFini,
}: {
  org: string;
  magasin?: Magasin;
  suggestion: string;
  onFini: () => void;
}) {
  const [f, setF] = useState({
    code: magasin?.code ?? suggestion,
    nom: magasin?.nom ?? '',
    adresse: magasin?.adresse ?? '',
    ville: magasin?.ville ?? '',
    telephone: magasin?.telephone ?? '',
  });
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    if (envoi) return;
    setEnvoi(true);
    const valeurs = {
      code: f.code.trim().toUpperCase(),
      nom: f.nom.trim(),
      adresse: f.adresse || null,
      ville: f.ville || null,
      telephone: f.telephone || null,
    };
    const { error } = magasin
      ? await supabase.from('magasins').update(valeurs).eq('id', magasin.id)
      : await supabase.from('magasins').insert({ ...valeurs, organisation_id: org });
    setEnvoi(false);
    if (error) return setErreur(messageErreur(error));
    onFini();
  }

  return (
    <form className="formulaire" onSubmit={soumettre}>
      <Alerte>{erreur}</Alerte>
      <div className="grille-2">
        <Champ label="Code" aide="Ex. MAG02">
          <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required pattern="[A-Za-z0-9_\-]{2,20}" />
        </Champ>
        <Champ label="Nom">
          <input value={f.nom} onChange={(e) => setF({ ...f, nom: e.target.value })} required minLength={2} />
        </Champ>
        <Champ label="Ville">
          <input value={f.ville} onChange={(e) => setF({ ...f, ville: e.target.value })} />
        </Champ>
        <Champ label="Téléphone">
          <input value={f.telephone} onChange={(e) => setF({ ...f, telephone: e.target.value })} inputMode="tel" />
        </Champ>
      </div>
      <Champ label="Adresse">
        <input value={f.adresse} onChange={(e) => setF({ ...f, adresse: e.target.value })} />
      </Champ>
      <button className="bouton bouton-principal" disabled={envoi}>
        Enregistrer
      </button>
    </form>
  );
}

function FormulaireCaisse({
  org,
  magasinId,
  caisse,
  suggestion,
  onFini,
}: {
  org: string;
  magasinId: string;
  caisse?: Caisse;
  suggestion: string;
  onFini: () => void;
}) {
  const [code, setCode] = useState(caisse?.code ?? suggestion);
  const [nom, setNom] = useState(caisse?.nom ?? '');
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    if (envoi) return;
    setEnvoi(true);
    const valeurs = { code: code.trim().toUpperCase(), nom: nom.trim() };
    const { error } = caisse
      ? await supabase.from('caisses').update(valeurs).eq('id', caisse.id)
      : await supabase.from('caisses').insert({ ...valeurs, organisation_id: org, magasin_id: magasinId });
    setEnvoi(false);
    if (error) return setErreur(messageErreur(error));
    onFini();
  }

  return (
    <form className="formulaire" onSubmit={soumettre}>
      <Alerte>{erreur}</Alerte>
      <Champ label="Code">
        <input value={code} onChange={(e) => setCode(e.target.value)} required pattern="[A-Za-z0-9_\-]{2,20}" />
      </Champ>
      <Champ label="Nom" aide="Ex. Caisse entrée, Caisse 2">
        <input value={nom} onChange={(e) => setNom(e.target.value)} required minLength={2} />
      </Champ>
      <button className="bouton bouton-principal" disabled={envoi}>
        Enregistrer
      </button>
    </form>
  );
}
