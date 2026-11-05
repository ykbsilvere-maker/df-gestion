import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { dateHeure, messageErreur } from '../lib/format';
import { ACTIONS, MODULES, type Caisse, type Invitation, type Magasin, type Membre, type Profil, type Role } from '../lib/types';
import { Alerte, Champ, EnTetePage, Fenetre, Pastille, Vide } from '../components/ui';
import { Identifiants } from '../components/Identifiants';
import { genererMotDePasse, gererCompte, messageIdentifiants } from '../lib/comptes';

interface Donnees {
  membres: Membre[];
  profils: Record<string, Profil>;
  magasinsParMembre: Record<string, string[]>;
  caissesParMembre: Record<string, string[]>;
  ajustements: Record<string, Record<string, boolean>>;
  invitations: Invitation[];
  magasins: Magasin[];
  caisses: Caisse[];
  roles: Role[];
  droitsRoles: Record<string, Set<string>>;
}

type Fenetres =
  | { type: 'inviter' }
  | { type: 'modifier'; membre: Membre }
  | { type: 'desactiver'; membre: Membre }
  | { type: 'droits'; membre: Membre }
  | { type: 'motdepasse'; membre: Membre }
  | { type: 'identifiants'; texte: string }
  | null;

function grouper<T>(lignes: T[], cle: (l: T) => string, valeur: (l: T) => string): Record<string, string[]> {
  const r: Record<string, string[]> = {};
  for (const l of lignes) (r[cle(l)] ??= []).push(valeur(l));
  return r;
}

export function Utilisateurs() {
  const { organisation, peut, session } = useSession();
  const org = organisation?.organisation_id;
  const [d, setD] = useState<Donnees | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [fenetre, setFenetre] = useState<Fenetres>(null);
  const [afficherInactifs, setAfficherInactifs] = useState(false);

  const charger = useCallback(async () => {
    if (!org) return;
    const parOrg = (t: string) => supabase.from(t).select('*').eq('organisation_id', org);
    const [mb, mm, mc, mp, inv, mag, cai, rol, rp] = await Promise.all([
      parOrg('membres').order('created_at'),
      parOrg('membre_magasins'),
      parOrg('membre_caisses'),
      parOrg('membre_permissions'),
      parOrg('invitations').eq('statut', 'en_attente').order('created_at', { ascending: false }),
      parOrg('magasins').order('code'),
      parOrg('caisses').order('code'),
      supabase.from('roles').select('*').order('ordre'),
      supabase.from('role_permissions').select('*'),
    ]);
    const echec = [mb, mm, mc, mp, inv, mag, cai, rol, rp].find((r) => r.error);
    if (echec?.error) return setErreur(messageErreur(echec.error));
    const membres = mb.data as Membre[];
    const pr = await supabase
      .from('profils')
      .select('*')
      .in(
        'id',
        membres.map((m) => m.user_id),
      );
    const ajustements: Record<string, Record<string, boolean>> = {};
    for (const a of mp.data as { membre_id: string; permission_code: string; accorde: boolean }[])
      (ajustements[a.membre_id] ??= {})[a.permission_code] = a.accorde;
    const droitsRoles: Record<string, Set<string>> = {};
    for (const r of rp.data as { role_code: string; permission_code: string }[])
      (droitsRoles[r.role_code] ??= new Set()).add(r.permission_code);

    setD({
      membres,
      profils: Object.fromEntries(((pr.data ?? []) as Profil[]).map((p) => [p.id, p])),
      magasinsParMembre: grouper(mm.data as { membre_id: string; magasin_id: string }[], (l) => l.membre_id, (l) => l.magasin_id),
      caissesParMembre: grouper(mc.data as { membre_id: string; caisse_id: string }[], (l) => l.membre_id, (l) => l.caisse_id),
      ajustements,
      invitations: inv.data as Invitation[],
      magasins: mag.data as Magasin[],
      caisses: cai.data as Caisse[],
      roles: rol.data as Role[],
      droitsRoles,
    });
  }, [org]);

  useEffect(() => {
    void charger();
  }, [charger]);

  async function appeler(fn: string, params: Record<string, unknown>, succes: string) {
    setErreur('');
    setInfo('');
    const { error } = await supabase.rpc(fn, params);
    if (error) {
      setErreur(messageErreur(error));
      return false;
    }
    setInfo(succes);
    await charger();
    return true;
  }

  async function envoyerReinitialisation(email: string | null) {
    if (!email) return;
    setErreur('');
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/nouveau-mot-de-passe`,
    });
    if (error) setErreur(messageErreur(error));
    else setInfo(`Lien de réinitialisation envoyé à ${email}.`);
  }

  const libelleRole = useMemo(
    () => Object.fromEntries((d?.roles ?? []).map((r) => [r.code, r.libelle])),
    [d?.roles],
  );
  const codeMagasin = useMemo(
    () => Object.fromEntries((d?.magasins ?? []).map((m) => [m.id, m.code])),
    [d?.magasins],
  );

  if (!d || !organisation) return <EnTetePage icone="👥" titre="Utilisateurs" sousTitre="Chargement…" />;

  const visibles = d.membres.filter((m) => afficherInactifs || m.actif);
  const peutModifier = peut('utilisateurs.modifier');
  const estProprietaire = organisation.role_code === 'proprietaire';

  return (
    <>
      <EnTetePage
        titre="Utilisateurs"
        sousTitre="Les droits sont vérifiés par le serveur à chaque opération. Désactiver un compte coupe son accès immédiatement et conserve son historique."
        actions={
          peut('utilisateurs.creer') && (
            <button className="bouton bouton-principal" onClick={() => setFenetre({ type: 'inviter' })}>
              Inviter un utilisateur
            </button>
          )
        }
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      <section className="carte">
        <div className="carte-entete">
          <h2>Comptes</h2>
          <label className="case">
            <input type="checkbox" checked={afficherInactifs} onChange={(e) => setAfficherInactifs(e.target.checked)} />
            Afficher les comptes désactivés
          </label>
        </div>
        <div className="defilement-horizontal">
          <table className="tableau">
            <thead>
              <tr>
                <th>Utilisateur</th>
                <th>Rôle</th>
                <th>Magasins</th>
                <th>Dernière connexion</th>
                <th>Statut</th>
                {peutModifier && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {visibles.map((m) => {
                const p = d.profils[m.user_id];
                const soiMeme = m.user_id === session?.user.id;
                const protege = m.role_code === 'proprietaire' && !estProprietaire;
                const nbAjustements = Object.keys(d.ajustements[m.id] ?? {}).length;
                return (
                  <tr key={m.id} className={m.actif ? '' : 'ligne-inactive'}>
                    <td>
                      <strong>{p?.nom_complet || '—'}</strong>
                      {soiMeme && <span className="mention"> (vous)</span>}
                      <div className="secondaire">{p?.email}</div>
                    </td>
                    <td>
                      {libelleRole[m.role_code]}
                      {nbAjustements > 0 && (
                        <div className="secondaire">
                          {nbAjustements} droit{nbAjustements > 1 ? 's' : ''} ajusté{nbAjustements > 1 ? 's' : ''}
                        </div>
                      )}
                    </td>
                    <td>
                      {m.tous_magasins || m.role_code === 'proprietaire'
                        ? 'Tous'
                        : (d.magasinsParMembre[m.id] ?? []).map((id) => codeMagasin[id]).join(', ') || 'Aucun'}
                    </td>
                    <td>{dateHeure(m.derniere_connexion)}</td>
                    <td>
                      {m.actif ? (
                        <Pastille ton="vert">Actif</Pastille>
                      ) : (
                        <span title={m.motif_desactivation ?? ''}>
                          <Pastille ton="gris">Désactivé</Pastille>
                          <div className="secondaire">{dateHeure(m.desactive_le)}</div>
                        </span>
                      )}
                    </td>
                    {peutModifier && (
                      <td className="cellule-actions">
                        {!soiMeme && !protege && (
                          <>
                            {m.actif && (
                              <>
                                <button className="bouton-lien" onClick={() => setFenetre({ type: 'modifier', membre: m })}>
                                  Rôle et magasins
                                </button>
                                {m.role_code !== 'proprietaire' && (
                                  <button className="bouton-lien" onClick={() => setFenetre({ type: 'droits', membre: m })}>
                                    Droits
                                  </button>
                                )}
                                <button className="bouton-lien" onClick={() => setFenetre({ type: 'motdepasse', membre: m })}>
                                  Mot de passe
                                </button>
                                <button
                                  className="bouton-lien lien-danger"
                                  onClick={() => setFenetre({ type: 'desactiver', membre: m })}
                                >
                                  Désactiver
                                </button>
                              </>
                            )}
                            {!m.actif && (
                              <button
                                className="bouton-lien"
                                onClick={() => void appeler('reactiver_membre', { p_membre: m.id }, 'Compte réactivé.')}
                              >
                                Réactiver
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="carte">
        <h2>Invitations en attente</h2>
        {d.invitations.length === 0 ? (
          <Vide>Aucune invitation en attente.</Vide>
        ) : (
          <table className="tableau">
            <thead>
              <tr>
                <th>E-mail</th>
                <th>Rôle prévu</th>
                <th>Envoyée le</th>
                {peutModifier && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {d.invitations.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  <td>{libelleRole[i.role_code]}</td>
                  <td>{dateHeure(i.created_at)}</td>
                  {peutModifier && (
                    <td className="cellule-actions">
                      <button
                        className="bouton-lien lien-danger"
                        onClick={() => void appeler('annuler_invitation', { p_invitation: i.id }, 'Invitation annulée.')}
                      >
                        Annuler
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="secondaire">
          La personne invitée crée son compte avec cette adresse e-mail sur l’application ; elle est rattachée à
          l’entreprise dès sa première connexion.
        </p>
      </section>

      <Fenetre
        titre={
          fenetre?.type === 'inviter'
            ? 'Inviter un utilisateur'
            : fenetre?.type === 'modifier'
              ? 'Rôle et magasins'
              : fenetre?.type === 'desactiver'
                ? 'Désactiver le compte'
                : fenetre?.type === 'motdepasse'
                  ? 'Mot de passe'
                  : fenetre?.type === 'identifiants'
                    ? 'Identifiants à transmettre'
                    : 'Droits individuels'
        }
        ouverte={!!fenetre}
        onFermer={() => setFenetre(null)}
        large={fenetre?.type === 'droits'}
      >
        {fenetre?.type === 'inviter' && (
          <FormulaireRole
            d={d}
            estProprietaire={estProprietaire}
            appelantTousMagasins={organisation.tous_magasins}
            avecEmail
            onValider={async (v) => {
              const ok = await appeler(
                'inviter_membre',
                {
                  p_org: org,
                  p_email: v.email,
                  p_role: v.role,
                  p_tous_magasins: v.tousMagasins,
                  p_magasins: v.magasins,
                  p_caisses: v.caisses,
                },
                `Invitation enregistrée pour ${v.email}.`,
              );
              if (!ok) return;
              if (!v.creerAcces) return setFenetre(null);
              const r = await gererCompte('creer', v.email, v.motDePasse, v.nom);
              if (r.ok) {
                setInfo(`Accès créé pour ${v.email}.`);
                setFenetre({
                  type: 'identifiants',
                  texte: messageIdentifiants({ nom: v.nom, entreprise: organisation.nom, email: v.email, motDePasse: v.motDePasse }),
                });
              } else {
                setInfo(
                  r.statut === 'existe'
                    ? `${v.email} avait déjà un compte : il est rattaché et se connecte avec son mot de passe habituel.`
                    : `Invitation enregistrée pour ${v.email}. ${r.message}${r.absente ? ' La personne crée elle-même son compte avec cette adresse.' : ''}`,
                );
                setFenetre(null);
              }
              await charger();
            }}
          />
        )}
        {fenetre?.type === 'modifier' && (
          <FormulaireRole
            d={d}
            estProprietaire={estProprietaire}
            appelantTousMagasins={organisation.tous_magasins}
            initial={{
              role: fenetre.membre.role_code,
              tousMagasins: fenetre.membre.tous_magasins,
              magasins: d.magasinsParMembre[fenetre.membre.id] ?? [],
              caisses: d.caissesParMembre[fenetre.membre.id] ?? [],
            }}
            onValider={async (v) => {
              const ok = await appeler(
                'modifier_membre',
                {
                  p_membre: fenetre.membre.id,
                  p_role: v.role,
                  p_tous_magasins: v.tousMagasins,
                  p_magasins: v.magasins,
                  p_caisses: v.caisses,
                },
                'Rôle et magasins mis à jour.',
              );
              if (ok) setFenetre(null);
            }}
          />
        )}
        {fenetre?.type === 'desactiver' && (
          <FormulaireDesactivation
            nom={d.profils[fenetre.membre.user_id]?.nom_complet || d.profils[fenetre.membre.user_id]?.email || ''}
            onValider={async (motif) => {
              const ok = await appeler(
                'desactiver_membre',
                { p_membre: fenetre.membre.id, p_motif: motif },
                'Compte désactivé : l’accès est coupé.',
              );
              if (ok) setFenetre(null);
            }}
          />
        )}
        {fenetre?.type === 'motdepasse' && (
          <FormulaireMotDePasse
            email={d.profils[fenetre.membre.user_id]?.email ?? ''}
            onLien={async (email) => {
              await envoyerReinitialisation(email);
              setFenetre(null);
            }}
            onProvisoire={async (email, motDePasse) => {
              const r = await gererCompte('reinitialiser', email, motDePasse);
              if (!r.ok) return r.message;
              setInfo('Mot de passe réinitialisé.');
              setFenetre({
                type: 'identifiants',
                texte: messageIdentifiants({
                  nom: d.profils[fenetre.membre.user_id]?.nom_complet ?? undefined,
                  entreprise: organisation.nom,
                  email,
                  motDePasse,
                }),
              });
              return null;
            }}
          />
        )}
        {fenetre?.type === 'identifiants' && <Identifiants texte={fenetre.texte} />}
        {fenetre?.type === 'droits' && (
          <GrilleModules
            membre={fenetre.membre}
            droitsRole={d.droitsRoles[fenetre.membre.role_code] ?? new Set()}
            ajustements={d.ajustements[fenetre.membre.id] ?? {}}
            mesDroits={new Set(organisation.permissions)}
            onAppliquer={(permissions) =>
              appeler(
                'definir_permissions_membre',
                { p_membre: fenetre.membre.id, p_permissions: permissions },
                'Droits enregistrés. Ils s’appliquent sur son appareil dans les 30 secondes.',
              )
            }
          />
        )}
        {fenetre?.type === 'droits' && fenetre.membre.role_code !== 'proprietaire' && (
          <details className="reglage-fin">
            <summary>Réglage fin, action par action</summary>
          <MatriceDroits
            membre={fenetre.membre}
            droitsRole={d.droitsRoles[fenetre.membre.role_code] ?? new Set()}
            ajustements={d.ajustements[fenetre.membre.id] ?? {}}
            mesDroits={new Set(organisation.permissions)}
            onChanger={(permission, accorde) =>
              appeler(
                'definir_permission_membre',
                { p_membre: fenetre.membre.id, p_permission: permission, p_accorde: accorde },
                'Droit mis à jour.',
              )
            }
          />
          </details>
        )}
      </Fenetre>
    </>
  );
}

interface ValeursRole {
  email: string;
  nom: string;
  creerAcces: boolean;
  motDePasse: string;
  role: string;
  tousMagasins: boolean;
  magasins: string[];
  caisses: string[];
}

function FormulaireRole({
  d,
  estProprietaire,
  appelantTousMagasins,
  avecEmail,
  initial,
  onValider,
}: {
  d: Donnees;
  estProprietaire: boolean;
  appelantTousMagasins: boolean;
  avecEmail?: boolean;
  initial?: Omit<ValeursRole, 'email' | 'nom' | 'creerAcces' | 'motDePasse'>;
  onValider: (v: ValeursRole) => Promise<void>;
}) {
  const [v, setV] = useState<ValeursRole>({
    email: '',
    nom: '',
    creerAcces: true,
    motDePasse: genererMotDePasse(),
    role: initial?.role ?? 'caissier',
    tousMagasins: initial?.tousMagasins ?? false,
    magasins: initial?.magasins ?? [],
    caisses: initial?.caisses ?? [],
  });
  const [envoi, setEnvoi] = useState(false);
  const roles = d.roles.filter((r) => r.code !== 'proprietaire' || estProprietaire);
  const magasinsActifs = d.magasins.filter((m) => m.actif);

  function basculer(liste: 'magasins' | 'caisses', id: string) {
    const actuel = new Set(v[liste]);
    if (actuel.has(id)) actuel.delete(id);
    else actuel.add(id);
    let caisses = liste === 'caisses' ? [...actuel] : v.caisses;
    const magasins = liste === 'magasins' ? [...actuel] : v.magasins;
    // Une caisse n'a de sens que dans un magasin attribué.
    if (!v.tousMagasins) caisses = caisses.filter((c) => magasins.includes(d.caisses.find((x) => x.id === c)?.magasin_id ?? ''));
    setV({ ...v, magasins, caisses });
  }

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    if (envoi) return;
    setEnvoi(true);
    await onValider({ ...v, email: v.email.trim().toLowerCase(), magasins: v.tousMagasins ? [] : v.magasins });
    setEnvoi(false);
  }

  const proprietaire = v.role === 'proprietaire';

  return (
    <form className="formulaire" onSubmit={soumettre}>
      {avecEmail && (
        <>
          <Champ label="Nom et prénoms">
            <input value={v.nom} onChange={(e) => setV({ ...v, nom: e.target.value })} autoComplete="off" />
          </Champ>
          <Champ label="Adresse e-mail de la personne (identifiant)">
            <input type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} required autoComplete="off" />
          </Champ>
          <label className="case">
            <input type="checkbox" checked={v.creerAcces} onChange={(e) => setV({ ...v, creerAcces: e.target.checked })} />
            Créer son accès maintenant avec un mot de passe provisoire
          </label>
          {v.creerAcces && (
            <Champ label="Mot de passe provisoire" aide="La personne le remplace à sa première connexion.">
              <div className="champ-avec-bouton">
                <input value={v.motDePasse} onChange={(e) => setV({ ...v, motDePasse: e.target.value })} minLength={8} required autoComplete="off" />
                <button type="button" className="bouton bouton-discret" onClick={() => setV({ ...v, motDePasse: genererMotDePasse() })}>
                  Générer
                </button>
              </div>
            </Champ>
          )}
        </>
      )}
      <Champ label="Rôle">
        <select value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })}>
          {roles.map((r) => (
            <option key={r.code} value={r.code}>
              {r.libelle}
            </option>
          ))}
        </select>
      </Champ>

      {proprietaire ? (
        <Alerte type="info">Un propriétaire a accès à tous les magasins et à tous les droits.</Alerte>
      ) : (
        <fieldset className="groupe">
          <legend>Magasins et caisses accessibles</legend>
          <label className="case">
            <input
              type="checkbox"
              checked={v.tousMagasins}
              disabled={!appelantTousMagasins}
              onChange={(e) => setV({ ...v, tousMagasins: e.target.checked })}
            />
            Tous les magasins, y compris ceux créés plus tard
          </label>
          {magasinsActifs.map((m) => {
            const coche = v.tousMagasins || v.magasins.includes(m.id);
            return (
              <div key={m.id} className="perimetre-magasin">
                <label className="case">
                  <input
                    type="checkbox"
                    checked={coche}
                    disabled={v.tousMagasins}
                    onChange={() => basculer('magasins', m.id)}
                  />
                  <strong>{m.nom}</strong> <span className="code">{m.code}</span>
                </label>
                {coche && (
                  <div className="perimetre-caisses">
                    {d.caisses
                      .filter((c) => c.magasin_id === m.id && c.actif)
                      .map((c) => (
                        <label key={c.id} className="case case-petite">
                          <input type="checkbox" checked={v.caisses.includes(c.id)} onChange={() => basculer('caisses', c.id)} />
                          {c.nom}
                        </label>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
          <p className="champ-aide">Aucune caisse cochée : la personne peut utiliser toutes les caisses de ses magasins.</p>
        </fieldset>
      )}
      <button className="bouton bouton-principal" disabled={envoi}>
        {avecEmail ? (v.creerAcces ? 'Créer l’accès' : 'Inviter') : 'Enregistrer'}
      </button>
    </form>
  );
}

function FormulaireMotDePasse({
  email,
  onProvisoire,
  onLien,
}: {
  email: string;
  onProvisoire: (email: string, motDePasse: string) => Promise<string | null>;
  onLien: (email: string) => Promise<void>;
}) {
  const [motDePasse, setMotDePasse] = useState(genererMotDePasse());
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);
  async function soumettre(e: FormEvent) {
    e.preventDefault();
    setEnvoi(true);
    setErreur((await onProvisoire(email, motDePasse)) ?? '');
    setEnvoi(false);
  }
  return (
    <form className="formulaire" onSubmit={soumettre}>
      <p>
        Nouveau mot de passe provisoire pour <strong>{email}</strong> : la personne en choisira un autre à sa prochaine connexion.
      </p>
      <Alerte>{erreur}</Alerte>
      <Champ label="Mot de passe provisoire">
        <div className="champ-avec-bouton">
          <input value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} minLength={8} required />
          <button type="button" className="bouton bouton-discret" onClick={() => setMotDePasse(genererMotDePasse())}>
            Générer
          </button>
        </div>
      </Champ>
      <button className="bouton bouton-principal bouton-plein" disabled={envoi}>
        {envoi ? 'Réinitialisation…' : 'Réinitialiser le mot de passe'}
      </button>
      <div className="liens-formulaire">
        <button type="button" className="bouton-lien" onClick={() => void onLien(email)}>
          Envoyer plutôt un lien par e-mail
        </button>
      </div>
    </form>
  );
}

function FormulaireDesactivation({ nom, onValider }: { nom: string; onValider: (motif: string) => Promise<void> }) {
  const [motif, setMotif] = useState('');
  const [envoi, setEnvoi] = useState(false);
  return (
    <form
      className="formulaire"
      onSubmit={async (e) => {
        e.preventDefault();
        if (envoi) return;
        setEnvoi(true);
        await onValider(motif.trim());
        setEnvoi(false);
      }}
    >
      <p>
        <strong>{nom}</strong> perdra immédiatement l’accès aux données de l’entreprise, sur tous ses appareils. Son
        historique d’opérations est conservé et le compte pourra être réactivé.
      </p>
      <Champ label="Motif (obligatoire, inscrit au journal d’audit)">
        <input value={motif} onChange={(e) => setMotif(e.target.value)} required minLength={3} placeholder="Ex. fin de contrat" />
      </Champ>
      <button className="bouton bouton-danger" disabled={envoi}>
        Désactiver le compte
      </button>
    </form>
  );
}

function MatriceDroits({
  membre,
  droitsRole,
  ajustements,
  mesDroits,
  onChanger,
}: {
  membre: Membre;
  droitsRole: Set<string>;
  ajustements: Record<string, boolean>;
  mesDroits: Set<string>;
  onChanger: (permission: string, accorde: boolean | null) => Promise<boolean>;
}) {
  const [occupe, setOccupe] = useState<string | null>(null);

  async function cliquer(code: string) {
    if (occupe) return;
    const parRole = droitsRole.has(code);
    const ajust = ajustements[code];
    // Cycle : défaut du rôle → inverse du défaut → défaut du rôle.
    const suivant = ajust === undefined ? !parRole : null;
    setOccupe(code);
    await onChanger(code, suivant);
    setOccupe(null);
  }

  return (
    <div>
      <p className="secondaire">
        Cliquez sur une case pour ajouter ou retirer un droit par rapport au rôle. Un second clic revient au droit du
        rôle. Vous ne pouvez pas déléguer un droit que vous n’avez pas.
      </p>
      <div className="legende">
        <span className="droit droit-role">✓</span> accordé par le rôle
        <span className="droit droit-ajoute">+</span> ajouté
        <span className="droit droit-retire">−</span> retiré
      </div>
      <div className="defilement-horizontal">
        <table className="tableau tableau-matrice">
          <thead>
            <tr>
              <th>Module</th>
              {ACTIONS.map((a) => (
                <th key={a.code}>{a.libelle}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MODULES.map((m) => (
              <tr key={m.code}>
                <th scope="row">{m.libelle}</th>
                {ACTIONS.map((a) => {
                  const code = `${m.code}.${a.code}`;
                  const parRole = droitsRole.has(code);
                  const ajust = ajustements[code];
                  const effectif = ajust ?? parRole;
                  const classe =
                    ajust === true ? 'droit-ajoute' : ajust === false ? 'droit-retire' : parRole ? 'droit-role' : 'droit-aucun';
                  const symbole = ajust === true ? '+' : ajust === false ? '−' : parRole ? '✓' : '';
                  const interdit = !mesDroits.has(code);
                  return (
                    <td key={a.code}>
                      <button
                        type="button"
                        className={`droit ${classe}`}
                        disabled={interdit || occupe === code}
                        onClick={() => void cliquer(code)}
                        aria-label={`${m.libelle} — ${a.libelle} : ${effectif ? 'autorisé' : 'non autorisé'}`}
                        title={interdit ? 'Vous n’avez pas ce droit' : undefined}
                      >
                        {symbole}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {membre.tous_magasins && <p className="secondaire">Accès à tous les magasins.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------
// Grille par module : Aucun / Voir / Saisir / Valider
// ---------------------------------------------------------------------

type Niveau = 'aucun' | 'voir' | 'saisir' | 'valider';

/** Actions réglées par la grille. « supprimer » et « administrer » restent au réglage fin. */
const ACTIONS_NIVEAU: Record<Niveau, string[]> = {
  aucun: [],
  voir: ['consulter', 'exporter'],
  saisir: ['consulter', 'exporter', 'creer', 'modifier'],
  valider: ['consulter', 'exporter', 'creer', 'modifier', 'valider', 'annuler', 'cloturer'],
};
const ACTIONS_GRILLE = ACTIONS_NIVEAU.valider;
const NIVEAUX: { code: Niveau; libelle: string }[] = [
  { code: 'aucun', libelle: 'Aucun' },
  { code: 'voir', libelle: 'Voir' },
  { code: 'saisir', libelle: 'Saisir' },
  { code: 'valider', libelle: 'Valider' },
];

/** Profils prêts à l'emploi : niveau par module, les autres modules à « Aucun ». */
const PROFILS: { libelle: string; aide: string; niveaux: Partial<Record<string, Niveau>> }[] = [
  {
    libelle: 'Caissier (TPE)',
    aide: 'Caisse et encaissement, catalogue en lecture seule.',
    niveaux: { caisse: 'saisir', catalogue: 'voir', clients: 'saisir' },
  },
  {
    libelle: 'Gestionnaire de stock',
    aide: 'Catalogue, stock, réceptions et fournisseurs, sans la caisse.',
    niveaux: { catalogue: 'valider', stock: 'valider', achats: 'saisir', fournisseurs: 'saisir' },
  },
  {
    libelle: 'Comptable',
    aide: 'Ventes, rapports et comptabilité, sans saisie en caisse.',
    niveaux: { ventes: 'voir', rapports: 'valider', comptabilite: 'valider', caisse: 'voir', stock: 'voir', achats: 'voir', fournisseurs: 'voir' },
  },
  {
    libelle: 'Gérant',
    aide: 'Tout le magasin au quotidien, sans l’administration de l’entreprise.',
    niveaux: {
      magasins: 'voir', utilisateurs: 'saisir', audit: 'voir', catalogue: 'valider', stock: 'valider', achats: 'valider',
      caisse: 'valider', ventes: 'valider', clients: 'valider', fournisseurs: 'valider', rapports: 'voir',
    },
  },
];

function niveauDe(effectifs: Set<string>, module: string): Niveau | null {
  const actifs = ACTIONS_GRILLE.filter((a) => effectifs.has(`${module}.${a}`));
  for (const n of ['aucun', 'voir', 'saisir', 'valider'] as Niveau[]) {
    const attendu = ACTIONS_NIVEAU[n];
    if (attendu.length === actifs.length && attendu.every((a) => actifs.includes(a))) return n;
  }
  return null; // réglage personnalisé
}

function GrilleModules({
  membre,
  droitsRole,
  ajustements,
  mesDroits,
  onAppliquer,
}: {
  membre: Membre;
  droitsRole: Set<string>;
  ajustements: Record<string, boolean>;
  mesDroits: Set<string>;
  onAppliquer: (permissions: string[]) => Promise<boolean>;
}) {
  const [occupe, setOccupe] = useState(false);
  const effectifs = useMemo(() => {
    const e = new Set<string>();
    for (const m of MODULES)
      for (const a of ACTIONS) {
        const code = `${m.code}.${a.code}`;
        if (ajustements[code] ?? droitsRole.has(code)) e.add(code);
      }
    return e;
  }, [ajustements, droitsRole]);

  if (membre.role_code === 'proprietaire') {
    return <p className="secondaire">Un propriétaire a toujours accès à tous les modules.</p>;
  }

  /** Remplace les actions de la grille pour les modules donnés ; les droits que vous n'avez pas restent inchangés. */
  function calculer(niveaux: Record<string, Niveau>): string[] {
    const r = new Set(effectifs);
    for (const [module, niveau] of Object.entries(niveaux))
      for (const a of ACTIONS_GRILLE) {
        const code = `${module}.${a}`;
        if (!mesDroits.has(code)) continue;
        if (ACTIONS_NIVEAU[niveau].includes(a)) r.add(code);
        else r.delete(code);
      }
    return [...r].sort();
  }

  async function appliquer(niveaux: Record<string, Niveau>) {
    if (occupe) return;
    setOccupe(true);
    await onAppliquer(calculer(niveaux));
    setOccupe(false);
  }

  const peutRegler = (module: string, n: Niveau) => ACTIONS_NIVEAU[n].every((a) => mesDroits.has(`${module}.${a}`));

  return (
    <div className="grille-modules">
      <p className="secondaire">
        Choisissez ce que cette personne peut faire dans chaque module. Le changement s’applique sur son téléphone ou sa
        caisse dans les 30 secondes, sans qu’elle ait à se reconnecter.
      </p>
      <div className="profils-rapides">
        {PROFILS.map((p) => (
          <button
            key={p.libelle}
            type="button"
            className="puce"
            title={p.aide}
            disabled={occupe}
            onClick={() =>
              void appliquer(Object.fromEntries(MODULES.map((m) => [m.code, p.niveaux[m.code] ?? 'aucun'])) as Record<string, Niveau>)
            }
          >
            {p.libelle}
          </button>
        ))}
      </div>
      <div className="defilement-horizontal">
        <table className="grille-droits">
          <tbody>
            {MODULES.map((m) => {
              const actuel = niveauDe(effectifs, m.code);
              return (
                <tr key={m.code}>
                  <th scope="row">{m.libelle}</th>
                  <td>
                    <div className="niveaux" role="radiogroup" aria-label={m.libelle}>
                      {NIVEAUX.map((n) => (
                        <button
                          key={n.code}
                          type="button"
                          role="radio"
                          aria-checked={actuel === n.code}
                          className={`niveau ${actuel === n.code ? 'niveau-actif' : ''}`}
                          disabled={occupe || !peutRegler(m.code, n.code)}
                          title={peutRegler(m.code, n.code) ? undefined : 'Vous n’avez pas ces droits vous-même'}
                          onClick={() => void appliquer({ [m.code]: n.code })}
                        >
                          {n.libelle}
                        </button>
                      ))}
                      {actuel === null && <span className="niveau-perso">Personnalisé</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="secondaire">
        Voir : consulter et exporter. Saisir : en plus, créer et modifier. Valider : en plus, valider, annuler et clôturer.
        Supprimer et administrer se règlent dans le réglage fin.
      </p>
    </div>
  );
}
