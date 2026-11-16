import { NavLink, Outlet } from 'react-router-dom';
import { useSession } from '../../lib/session';

/**
 * Module Trésorerie : comptes et approvisionnement. Les créances clients (fichier clients,
 * balance âgée, relevés, relances) sont dans le module « Crédits clients » depuis la 3.4.
 */
export function TresorerieModule() {
  const { peut } = useSession();
  return (
    <>
      <nav className="onglets" aria-label="Trésorerie">
        <NavLink to="/tresorerie" end>
          <span className="onglet-icone" aria-hidden>💰</span>Comptes
        </NavLink>
        {(peut('achats.creer') || peut('stock.creer') || peut('fournisseurs.consulter')) && (
          <NavLink to="/tresorerie/approvisionnement">
            <span className="onglet-icone" aria-hidden>🛒</span>Approvisionnement
          </NavLink>
        )}
      </nav>
      <Outlet />
    </>
  );
}
