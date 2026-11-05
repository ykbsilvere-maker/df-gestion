import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { VerrouInactivite, verrouillerMaintenant } from './VerrouInactivite';
import { useSession } from '../lib/session';
import { useIdentite } from '../lib/identite';
import { identifiantAffiche } from '../lib/acces';

type Groupe = 'vendre' | 'stock' | 'pilotage' | 'reglages';
const GROUPES: Record<Groupe, string> = { vendre: 'Vendre', stock: 'Stock et achats', pilotage: 'Pilotage', reglages: 'Réglages' };
const LIENS: { vers: string; libelle: string; permission?: string | string[]; admin?: boolean; icone: string; groupe?: Groupe }[] = [
  { vers: '/administration', libelle: 'Administration', admin: true, icone: '🛡️' },
  { vers: '/', libelle: 'Accueil', icone: '🏠' },
  { vers: '/caisse', libelle: 'Caisse', permission: 'caisse.creer', icone: '🛒', groupe: 'vendre' },
  { vers: '/catalogue', libelle: 'Catalogue', permission: 'catalogue.consulter', icone: '🛍️', groupe: 'vendre' },
  { vers: '/devis', libelle: 'Devis', permission: 'ventes.valider', icone: '📄', groupe: 'vendre' },
  { vers: '/rapports/ventes', libelle: 'Ventes', permission: ['ventes.exporter', 'rapports.consulter'], icone: '📊', groupe: 'vendre' },
  { vers: '/stock', libelle: 'Stock', permission: 'stock.consulter', icone: '📦', groupe: 'stock' },
  { vers: '/fournisseurs', libelle: 'Fournisseurs', permission: ['fournisseurs.consulter', 'achats.consulter'], icone: '🚚', groupe: 'stock' },
  { vers: '/budget', libelle: 'Budget', permission: 'budget.consulter', icone: '📒', groupe: 'pilotage' },
  { vers: '/tresorerie', libelle: 'Trésorerie', permission: 'tresorerie.consulter', icone: '💰', groupe: 'pilotage' },
  { vers: '/rentabilite', libelle: 'Rentabilité', permission: 'rentabilite.consulter', icone: '📈', groupe: 'pilotage' },
  { vers: '/comptabilite', libelle: 'Comptabilité', permission: 'comptabilite.consulter', icone: '📚', groupe: 'pilotage' },
  { vers: '/soldes', libelle: 'Soldes', permission: 'promotions.consulter', icone: '🏷️', groupe: 'pilotage' },
  { vers: '/magasins', libelle: 'Magasins', permission: 'magasins.consulter', icone: '🏪', groupe: 'reglages' },
  { vers: '/utilisateurs', libelle: 'Utilisateurs', permission: 'utilisateurs.consulter', icone: '👥', groupe: 'reglages' },
  { vers: '/journal', libelle: 'Journal', permission: 'audit.consulter', icone: '📜', groupe: 'reglages' },
  { vers: '/personnalisation', libelle: 'Personnalisation', permission: 'administration.consulter', icone: '🎨', groupe: 'reglages' },
  { vers: '/compte', libelle: 'Mon compte', icone: '👤', groupe: 'reglages' },
];

/** Sur téléphone : 4 raccourcis en bas d'écran, le reste dans « Plus ». */
const MAX_MOBILE = 4;

export function Coquille() {
  const { organisation, organisations, choisirOrganisation, peut, deconnecter, session, adminGeneral } = useSession();
  const { identite } = useIdentite();
  const liens = LIENS.filter((l) =>
    l.admin
      ? adminGeneral
      : l.vers === '/'
        ? !!organisation
        : !l.permission || (Array.isArray(l.permission) ? l.permission.some((p) => peut(p)) : peut(l.permission)),
  );
  const [menuMobile, setMenuMobile] = useState(false);
  const emplacement = useLocation();
  useEffect(() => setMenuMobile(false), [emplacement.pathname]);
  // La caisse occupe tout l'écran : seul le panier défile.
  const pleinEcran = emplacement.pathname === '/caisse';
  // Chaque page repart du haut (le contenu défile dans son cadre, pas la fenêtre).
  const cadre = useRef<HTMLElement>(null);
  useEffect(() => cadre.current?.scrollTo({ top: 0 }), [emplacement.pathname]);

  const principaux = liens.length > MAX_MOBILE + 1 ? liens.slice(0, MAX_MOBILE) : liens;
  const autres = liens.length > MAX_MOBILE + 1 ? liens.slice(MAX_MOBILE) : [];
  const logo = identite?.logoUrl;
  const page = [...liens].reverse().find((l) => (l.vers === '/' ? emplacement.pathname === '/' : emplacement.pathname.startsWith(l.vers)));
  const nomUtilisateur = (session?.user.user_metadata?.nom_complet as string | undefined) || identifiantAffiche(session?.user.email);

  const lien = (l: (typeof liens)[number]) => (
    <NavLink key={l.vers} to={l.vers} end={l.vers === '/'}>
      <span className="nav-icone" aria-hidden>
        {l.icone}
      </span>
      <span className="nav-libelle">{l.libelle}</span>
    </NavLink>
  );

  return (
    <div className={`app ${pleinEcran ? 'app-plein' : ''}`}>
      <aside className="app-menu">
        <div className="app-marque">
          {logo ? (
            <span className="logo-client">
              <img src={logo} alt="" />
            </span>
          ) : (
            <img src="/icone.svg" alt="" width={34} height={34} />
          )}
          <div>
            <strong>{organisation?.nom ?? 'Le Décodeur Financier'}</strong>
            <span>{organisation?.role_libelle ?? (adminGeneral ? 'Administrateur général' : '')}</span>
          </div>
        </div>
        {organisations.length > 1 && (
          <select
            className="choix-entreprise"
            value={organisation?.organisation_id}
            onChange={(e) => choisirOrganisation(e.target.value)}
            aria-label="Changer d’entreprise"
          >
            {organisations.map((o) => (
              <option key={o.organisation_id} value={o.organisation_id}>
                {o.nom}
              </option>
            ))}
          </select>
        )}
        <nav className="app-nav">
          {liens.map((l, i) => (
            <Fragment key={l.vers}>
              {l.groupe && l.groupe !== liens[i - 1]?.groupe && <span className="titre-groupe">{GROUPES[l.groupe]}</span>}
              {lien(l)}
            </Fragment>
          ))}
        </nav>
        <div className="app-menu-pied">
          <span className="propulse">
            <img src="/icone.svg" alt="" />
            Propulsé par Le Décodeur Financier
          </span>
        </div>
      </aside>

      <header className="app-entete">
        <div className="app-entete-marque">
          {logo ? (
            <span className="logo-client">
              <img src={logo} alt="" />
            </span>
          ) : (
            <img src="/icone.svg" alt="" width={30} height={30} />
          )}
          <strong>{organisation?.nom ?? 'DF Gestion'}</strong>
        </div>
        <div className="app-entete-titre">
          <span aria-hidden>{page?.icone}</span>
          {page?.libelle}
        </div>
        <div className="app-entete-actions">
          <button type="button" className="entete-bouton" onClick={verrouillerMaintenant} title="Verrouiller (code d’entrée)" aria-label="Verrouiller">
            🔒
          </button>
          <Link to="/compte" className="entete-utilisateur" title={nomUtilisateur}>
            <span className="avatar-matricule">{nomUtilisateur.charAt(0).toUpperCase()}</span>
            <span className="entete-nom">{nomUtilisateur}</span>
          </Link>
          <button type="button" className="entete-bouton" onClick={() => void deconnecter()} title="Se déconnecter" aria-label="Se déconnecter">
            ⏻
          </button>
        </div>
      </header>

      <main ref={cadre} className={`app-contenu ${pleinEcran ? 'contenu-plein' : ''}`}>
        <Outlet />
      </main>

      <nav className="app-onglets">
        {principaux.map((l) => lien(l))}
        {autres.length > 0 && (
          <button
            type="button"
            className={`bouton-plus ${menuMobile || autres.some((l) => emplacement.pathname.startsWith(l.vers)) ? 'active' : ''}`}
            onClick={() => setMenuMobile(!menuMobile)}
            aria-expanded={menuMobile}
          >
            <span className="nav-icone" aria-hidden>
              ☰
            </span>
            <span className="nav-libelle">Plus</span>
          </button>
        )}
      </nav>
      {menuMobile && (
        <div className="app-plus" role="menu" onClick={() => setMenuMobile(false)}>
          <div className="app-plus-feuille" onClick={(e) => e.stopPropagation()}>
            <div className="app-plus-poignee" />
            <div className="app-plus-grille">
              {autres.map((l) => (
                <NavLink key={l.vers} to={l.vers} role="menuitem">
                  <span className="nav-icone" aria-hidden>
                    {l.icone}
                  </span>
                  <span className="nav-libelle">{l.libelle}</span>
                </NavLink>
              ))}
            </div>
            <button type="button" className="bouton bouton-discret bouton-plein" onClick={() => void deconnecter()}>
              ⏻ Se déconnecter
            </button>
          </div>
        </div>
      )}
      <VerrouInactivite />
    </div>
  );
}
