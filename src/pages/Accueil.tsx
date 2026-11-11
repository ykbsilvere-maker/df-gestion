import { useMagasinGlobal } from '../lib/magasinGlobal';
import { BandeauJournee, useJournee } from '../caisse/Journee';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { dateHeure, libelleAction } from '../lib/format';
import type { LigneAudit } from '../lib/types';
import { Ico, MontantFort } from '../components/ui';
import { TableauDeBord } from './TableauDeBord';

const salutation = () => {
  const h = Number(new Date().toLocaleString('fr-FR', { hour: 'numeric', hour12: false, timeZone: 'Africa/Abidjan' }));
  return h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir';
};

/** Actions en un geste : chaque tuile ouvre directement le formulaire de création. */
const ACTIONS: { vers: string; icone: string; libelle: string; droit: string | string[] }[] = [
  { vers: '/caisse', icone: '🔓', libelle: 'Ouvrir / Vendre', droit: 'caisse.creer' },
  { vers: '/catalogue?nouveau=1', icone: '🛍️', libelle: '+ Produit', droit: 'catalogue.creer' },
  { vers: '/stock/receptions?nouveau=1', icone: '📥', libelle: '+ Arrivage', droit: ['stock.creer', 'achats.creer'] },
  { vers: '/budget?nouveau=1', icone: '💸', libelle: '+ Dépense', droit: 'budget.creer' },
  { vers: '/devis?nouveau=1', icone: '📄', libelle: '+ Devis', droit: 'ventes.valider' },
  { vers: '/tresorerie/creances?nouveau=1', icone: '🧾', libelle: '+ Créance', droit: 'tresorerie.creer' },
  { vers: '/tresorerie/creances?nouveau=client', icone: '🙋', libelle: '+ Client', droit: 'clients.creer' },
  { vers: '/utilisateurs?nouveau=1', icone: '👤', libelle: '+ Employé', droit: 'utilisateurs.creer' },
  { vers: '/caisse/suivi', icone: '💼', libelle: 'Ma caisse', droit: 'caisse.creer' },
  { vers: '/stock', icone: '📦', libelle: 'Stock', droit: 'stock.consulter' },
  { vers: '/tresorerie', icone: '💰', libelle: 'Trésorerie', droit: 'tresorerie.consulter' },
  { vers: '/rapports/ventes', icone: '📊', libelle: 'Ventes', droit: ['ventes.exporter', 'rapports.consulter'] },
];

function ActionsRapides({ peut, gerantPrincipal }: { peut: (p: string) => boolean; gerantPrincipal: boolean }) {
  // Le gérant principal ne vend pas : sa tuile ouvre les caisses des caissiers ; pas de « Ma caisse ».
  const visibles = ACTIONS.filter((a) => (Array.isArray(a.droit) ? a.droit.some((d) => peut(d)) : peut(a.droit)))
    .filter((a) => !(gerantPrincipal && a.vers === '/caisse/suivi'))
    .map((a) => (gerantPrincipal && a.vers === '/caisse' ? { ...a, libelle: 'Ouvrir les caisses' } : a))
    .slice(0, 8);
  if (!visibles.length) return null;
  return (
    <nav className="actions-rapides" aria-label="Actions rapides">
      {visibles.map((a) => (
        <Link key={a.vers} to={a.vers} className="action-rapide">
          <span className="action-icone" aria-hidden>
            {a.icone}
          </span>
          <span>{a.libelle}</span>
        </Link>
      ))}
    </nav>
  );
}

export function Accueil() {
  const { organisation, peut, adminGeneral, session } = useSession();
  const magasinGlobal = useMagasinGlobal();
  const prenom = ((session?.user.user_metadata?.nom_complet as string | undefined) ?? '').trim().split(/\s+/)[0] ?? '';
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
          supabase.rpc('etat_stock', { p_org: org, p_magasin: magasinGlobal || null }),
          supabase.rpc('alertes_stock', { p_org: org, p_magasin: magasinGlobal || null }),
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
  }, [org, peut, magasinGlobal]);

  if (!organisation) return null;

  return (
    <>
      <section className="accueil-hero">
        <div>
          <span className="hero-salut">{salutation()}{prenom ? `, ${prenom}` : ''}</span>
          <strong className="hero-entreprise">{organisation.nom}</strong>
          <span className="hero-role">{organisation.role_libelle}</span>
        </div>
        {ventes && (
          <Link to={peut('caisse.creer') ? '/caisse' : '/rapports/ventes'} className="hero-ventes">
            <span>Ventes du jour</span>
            <MontantFort v={ventes.total} />
            <span>
              {ventes.nombre} ticket{ventes.nombre > 1 ? 's' : ''}
            </span>
          </Link>
        )}
      </section>

      {peut('caisse.valider') && <JourneeAccueil org={organisation.organisation_id} />}

      <ActionsRapides peut={peut} gerantPrincipal={organisation.role_code === 'proprietaire'} />

      {(peut('rapports.consulter') || peut('ventes.exporter')) && <TableauDeBord />}

      <section className="tuiles">
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

/** Le gérant arrive sur l'accueil : on lui propose d'ouvrir la journée si ce n'est pas fait. */
function JourneeAccueil({ org }: { org: string }) {
  const { etat, recharger } = useJournee(org);
  if (!etat || (etat.ouverte && etat.ouverte.date === etat.aujourdhui)) return null;
  return <BandeauJournee org={org} etat={etat} horsLigne={!navigator.onLine} onChange={() => void recharger()} />;
}
