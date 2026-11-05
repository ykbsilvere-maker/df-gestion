import { NavLink, Outlet } from 'react-router-dom';
import { useSession } from '../../lib/session';

const ONGLETS: { vers: string; libelle: string; icone: string; permission?: string; fin?: boolean }[] = [
  { vers: '/stock', libelle: 'État du stock', icone: '📊', fin: true },
  { vers: '/stock/alertes', libelle: 'Alertes', icone: '⚠️' },
  { vers: '/stock/receptions', libelle: 'Réceptions', icone: '📥' },
  { vers: '/stock/transferts', libelle: 'Transferts', icone: '🔁', permission: 'stock.modifier' },
  { vers: '/stock/sorties', libelle: 'Sorties et ajustements', icone: '📤', permission: 'stock.modifier' },
  { vers: '/stock/inventaires', libelle: 'Inventaires', icone: '📋' },
  { vers: '/stock/mouvements', libelle: 'Mouvements', icone: '🔄' },
  { vers: '/stock/fournisseurs', libelle: 'Fournisseurs', icone: '🚚' },
];

/** Module Stock : onglets partagés par toutes les pages du module. */
export function StockPage() {
  const { peut } = useSession();
  return (
    <>
      <nav className="onglets" aria-label="Stock">
        {ONGLETS.filter((o) => !o.permission || peut(o.permission)).map((o) => (
          <NavLink key={o.vers} to={o.vers} end={o.fin}>
            <span className="onglet-icone" aria-hidden>
              {o.icone}
            </span>
            {o.libelle}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
