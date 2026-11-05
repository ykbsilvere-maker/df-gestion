import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { dateHeure, libelleAction } from '../lib/format';
import type { LigneAudit } from '../lib/types';
import { EnTetePage, Ico, MontantFort } from '../components/ui';

export function Accueil() {
  const { organisation, peut, adminGeneral } = useSession();
  const naviguer = useNavigate();
  // L'administrateur général arrive sur sa console à chaque nouvelle session.
  useEffect(() => {
    if (!adminGeneral) return;
    try {
      if (sessionStorage.getItem('dfg_console_vue')) return;
      sessionStorage.setItem('dfg_console_vue', '1');
    } catch {
      return;
    }
    naviguer('/administration', { replace: true });
  }, [adminGeneral, naviguer]);
  const [compteurs, setCompteurs] = useState({ magasins: 0, caisses: 0, membres: 0, invitations: 0 });
  const [dernieres, setDernieres] = useState<LigneAudit[]>([]);
  const [stock, setStock] = useState<{ valeur: number; alertes: number } | null>(null);
  const [ventes, setVentes] = useState<{ nombre: number; total: number } | null>(null);
  const org = organisation?.organisation_id;

  useEffect(() => {
    if (!org) return;
    const compter = async (table: string, filtre?: (q: any) => any) => {
      let q: any = supabase.from(table).select('*', { count: 'exact', head: true }).eq('organisation_id', org);
      if (filtre) q = filtre(q);
      const { count } = await q;
      return count ?? 0;
    };
    void (async () => {
      const [magasins, caisses, membres, invitations] = await Promise.all([
        compter('magasins', (q) => q.eq('actif', true)),
        compter('caisses', (q) => q.eq('actif', true)),
        compter('membres', (q) => q.eq('actif', true)),
        compter('invitations', (q) => q.eq('statut', 'en_attente')),
      ]);
      setCompteurs({ magasins, caisses, membres, invitations });
      if (peut('stock.consulter')) {
        const [etat, alertes] = await Promise.all([
          supabase.rpc('etat_stock', { p_org: org }),
          supabase.rpc('alertes_stock', { p_org: org }),
        ]);
        setStock({
          valeur: ((etat.data ?? []) as { valeur: number }[]).reduce((s, l) => s + Number(l.valeur), 0),
          alertes: ((alertes.data ?? []) as { niveau: string }[]).filter((a) => a.niveau !== 'info').length,
        });
      }
      if (peut('ventes.consulter') || peut('caisse.consulter')) {
        const { data } = await supabase.rpc('ventes_du_jour', { p_org: org });
        const l = ((data ?? []) as { nombre: number; total: number }[])[0];
        setVentes({ nombre: Number(l?.nombre ?? 0), total: Number(l?.total ?? 0) });
      }
      if (peut('audit.consulter')) {
        const { data } = await supabase
          .from('journal_audit')
          .select('*')
          .eq('organisation_id', org)
          .order('id', { ascending: false })
          .limit(6);
        setDernieres((data ?? []) as LigneAudit[]);
      }
    })();
  }, [org, peut]);

  if (!organisation) return null;

  return (
    <>
      <EnTetePage titre={organisation.nom} sousTitre={`Connecté en tant que ${organisation.role_libelle.toLowerCase()}`} />

      <section className="tuiles">
        {ventes && (
          <Link to={peut('caisse.creer') ? '/caisse' : '/'} className="tuile tuile-ventes">
            <span className="tuile-icone" aria-hidden>💰</span>
            <span className="tuile-valeur">
              <MontantFort v={ventes.total} />
            </span>
            <span className="tuile-libelle">
              ventes du jour ({ventes.nombre} ticket{ventes.nombre > 1 ? 's' : ''})
            </span>
          </Link>
        )}
        {stock && (
          <Link to="/stock" className="tuile">
            <span className="tuile-icone" aria-hidden>📦</span>
            <span className="tuile-valeur">
              <MontantFort v={stock.valeur} />
            </span>
            <span className="tuile-libelle">valeur du stock (au coût moyen)</span>
          </Link>
        )}
        {stock && stock.alertes > 0 && (
          <Link to="/stock/alertes" className="tuile tuile-attention">
            <span className="tuile-icone" aria-hidden>⚠️</span>
            <span className="tuile-valeur">{stock.alertes}</span>
            <span className="tuile-libelle">alerte{stock.alertes > 1 ? 's' : ''} de stock</span>
          </Link>
        )}
        <Link to="/magasins" className="tuile">
          <span className="tuile-icone" aria-hidden>🏪</span>
          <span className="tuile-valeur">{compteurs.magasins}</span>
          <span className="tuile-libelle">magasin{compteurs.magasins > 1 ? 's' : ''} actif{compteurs.magasins > 1 ? 's' : ''}</span>
        </Link>
        <Link to="/magasins" className="tuile">
          <span className="tuile-icone" aria-hidden>🧾</span>
          <span className="tuile-valeur">{compteurs.caisses}</span>
          <span className="tuile-libelle">caisse{compteurs.caisses > 1 ? 's' : ''}</span>
        </Link>
        {peut('utilisateurs.consulter') && (
          <Link to="/utilisateurs" className="tuile">
            <span className="tuile-icone" aria-hidden>👥</span>
            <span className="tuile-valeur">{compteurs.membres}</span>
            <span className="tuile-libelle">utilisateur{compteurs.membres > 1 ? 's' : ''} actif{compteurs.membres > 1 ? 's' : ''}</span>
          </Link>
        )}
        {peut('utilisateurs.consulter') && compteurs.invitations > 0 && (
          <Link to="/utilisateurs" className="tuile tuile-attention">
            <span className="tuile-icone" aria-hidden>✉️</span>
            <span className="tuile-valeur">{compteurs.invitations}</span>
            <span className="tuile-libelle">invitation{compteurs.invitations > 1 ? 's' : ''} en attente</span>
          </Link>
        )}
      </section>

      <div className="grille-accueil">
        {peut('utilisateurs.creer') ? (
          <section className="carte">
            <h2>
              <Ico>🚀</Ico>
              Mise en route
            </h2>
            <ol className="etapes">
              <li className="etape-faite">Créer l’entreprise et le premier magasin</li>
              <li>
                <Link to="/personnalisation">Personnaliser : logo, informations, modèle de reçu</Link>
              </li>
              <li>
                <Link to="/catalogue">Créer le catalogue et ses codes-barres</Link>
              </li>
              <li>
                <Link to="/utilisateurs">Inviter vos employés avec le bon rôle</Link>
              </li>
              <li>
                <Link to="/stock/receptions">Saisir le stock de départ par une réception ou un inventaire</Link>
              </li>
              <li>
                <Link to="/caisse">Ouvrir la caisse et faire la première vente</Link>
              </li>
            </ol>
          </section>
        ) : (
          <section className="carte">
            <h2>
              <Ico>🔑</Ico>
              Votre accès
            </h2>
            <p>
              Vous êtes rattaché à <strong>{organisation.nom}</strong> en tant que{' '}
              <strong>{organisation.role_libelle.toLowerCase()}</strong>
              {organisation.tous_magasins ? ', pour tous les magasins.' : ', pour les magasins qui vous ont été attribués.'}
            </p>
            <p className="secondaire">
              {organisation.role_code === 'admin_general'
                ? 'Consultation seulement : les ventes, le stock et les utilisateurs sont gérés par le gérant de l’entreprise.'
                : 'Pour toute question sur vos accès, adressez-vous à votre gérant.'}
            </p>
          </section>
        )}

        {peut('audit.consulter') && (
          <section className="carte">
            <div className="carte-entete">
              <h2>
                <Ico>🕒</Ico>
                Dernières opérations
              </h2>
              <Link to="/journal">Tout voir</Link>
            </div>
            <ul className="liste-simple">
              {dernieres.map((l) => (
                <li key={l.id}>
                  <span>{libelleAction(l.action)}</span>
                  <time>{dateHeure(l.created_at)}</time>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
