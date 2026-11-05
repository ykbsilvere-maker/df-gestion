import { Fragment, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
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

  const principaux = liens.length > MAX_MOBILE + 1 ? liens.slice(0, MAX_MOBILE) : liens;
  const autres = liens.length > MAX_MOBILE + 1 ? liens.slice(MAX_MOBILE) : [];
  const logo = identite?.logoUrl;
  // La caisse occupe tout l'écran, sans défilement de page : seul le panier défile.
  const pleinEcran = emplacement.pathname === '/caisse';

  return (
    <div className={`coquille ${pleinEcran ? 'coquille-plein' : ''}`}>
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
          {liens.map((l, i) => (
            <Fragment key={l.vers}>
              {l.groupe && l.groupe !== liens[i - 1]?.groupe && <span className="titre-groupe">{GROUPES[l.groupe]}</span>}
              <NavLink to={l.vers} end={l.vers === '/'}>
                <span className="nav-icone" aria-hidden>
                  {l.icone}
                </span>
                {l.libelle}
              </NavLink>
            </Fragment>
          ))}
        </nav>

        <div className="pied-barre">
          <span className="email-courant">{identifiantAffiche(session?.user.email)}</span>
          <button type="button" className="bouton-lien" onClick={() => void deconnecter()}>
            Se déconnecter
          </button>
          <span className="propulse">
            <img src="/icone.svg" alt="" />
            Propulsé par Le Décodeur Financier
          </span>
        </div>
      </aside>

      <main className={`contenu ${pleinEcran ? 'contenu-plein' : ''}`}>
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
