import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../lib/session';
import { useIdentite } from '../lib/identite';

const LIENS: { vers: string; libelle: string; permission?: string | string[]; admin?: boolean; icone: string }[] = [
  { vers: '/administration', libelle: 'Administration', admin: true, icone: '🛡️' },
  { vers: '/', libelle: 'Accueil', icone: '🏠' },
  { vers: '/caisse', libelle: 'Caisse', permission: 'caisse.creer', icone: '🛒' },
  { vers: '/catalogue', libelle: 'Catalogue', permission: 'catalogue.consulter', icone: '🛍️' },
  { vers: '/stock', libelle: 'Stock', permission: 'stock.consulter', icone: '📦' },
  { vers: '/fournisseurs', libelle: 'Fournisseurs', permission: ['fournisseurs.consulter', 'achats.consulter'], icone: '🚚' },
  { vers: '/rapports/ventes', libelle: 'Ventes', permission: ['ventes.exporter', 'rapports.consulter'], icone: '📊' },
  { vers: '/budget', libelle: 'Budget', permission: 'budget.consulter', icone: '📒' },
  { vers: '/tresorerie', libelle: 'Trésorerie', permission: 'tresorerie.consulter', icone: '💰' },
  { vers: '/magasins', libelle: 'Magasins', permission: 'magasins.consulter', icone: '🏪' },
  { vers: '/utilisateurs', libelle: 'Utilisateurs', permission: 'utilisateurs.consulter', icone: '👥' },
  { vers: '/journal', libelle: 'Journal', permission: 'audit.consulter', icone: '📜' },
  { vers: '/personnalisation', libelle: 'Personnalisation', permission: 'administration.consulter', icone: '🎨' },
  { vers: '/compte', libelle: 'Mon compte', icone: '👤' },
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

  const principaux = liens.length > MAX_MOBILE + 1 ? liens.slice(0, MAX_MOBILE) : liens;
  const autres = liens.length > MAX_MOBILE + 1 ? liens.slice(MAX_MOBILE) : [];
  const logo = identite?.logoUrl;

  return (
    <div className="coquille">
      <aside className="barre-laterale">
        <div className="marque marque-client">
          {logo ? (
            <span className="logo-client">
              <img src={logo} alt="" />
            </span>
          ) : (
            <img src="/icone.svg" alt="" width={32} height={32} />
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

        <nav className="navigation">
          {liens.map((l) => (
            <NavLink key={l.vers} to={l.vers} end={l.vers === '/'}>
              <span className="nav-icone" aria-hidden>
                {l.icone}
              </span>
              {l.libelle}
            </NavLink>
          ))}
        </nav>

        <div className="pied-barre">
          <span className="email-courant">{session?.user.email}</span>
          <button type="button" className="bouton-lien" onClick={() => void deconnecter()}>
            Se déconnecter
          </button>
          <span className="propulse">
            <img src="/icone.svg" alt="" />
            Propulsé par Le Décodeur Financier
          </span>
        </div>
      </aside>

      <main className="contenu">
        <Outlet />
      </main>

      <nav className="navigation-mobile">
        {principaux.map((l) => (
          <NavLink key={l.vers} to={l.vers} end={l.vers === '/'}>
            <span className="nav-icone" aria-hidden>
              {l.icone}
            </span>
            <span>{l.libelle}</span>
          </NavLink>
        ))}
        {autres.length > 0 && (
          <button
            type="button"
            className={`bouton-plus ${autres.some((l) => emplacement.pathname.startsWith(l.vers)) ? 'active' : ''}`}
            onClick={() => setMenuMobile(!menuMobile)}
            aria-expanded={menuMobile}
          >
            <span className="nav-icone" aria-hidden>
              ☰
            </span>
            <span>Plus</span>
          </button>
        )}
      </nav>
      {menuMobile && (
        <div className="menu-mobile" role="menu">
          {autres.map((l) => (
            <NavLink key={l.vers} to={l.vers} role="menuitem">
              <span className="nav-icone" aria-hidden>
                {l.icone}
              </span>
              {l.libelle}
            </NavLink>
          ))}
          <button type="button" className="bouton-lien" onClick={() => void deconnecter()}>
            Se déconnecter
          </button>
        </div>
      )}
    </div>
  );
}
