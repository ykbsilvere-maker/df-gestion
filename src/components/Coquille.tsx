import { imprimerPageA4 } from '../impression/impression';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AlertesEquipe } from '../lib/alertes';
import { definirOrgTrace, tracer } from '../lib/trace';
import { useMagasins } from '../lib/stock';
import { choisirMagasinGlobal, useMagasinGlobal } from '../lib/magasinGlobal';
import { VerrouInactivite, verrouillerMaintenant } from './VerrouInactivite';
import { FiletSecurite } from './FiletSecurite';
import { useSession } from '../lib/session';
import { useIdentite } from '../lib/identite';
import { identifiantAffiche } from '../lib/acces';
import { reprendreLogoDemande } from '../lib/demandeOuverture';

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
  { vers: '/vue-ensemble', libelle: 'Vue d’ensemble', permission: 'rentabilite.consulter', icone: '🏬', groupe: 'pilotage' },
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
const PRIORITE_MOBILE = ['/caisse', '/stock', '/', '/catalogue'];
const rangMobile = (vers: string) => {
  const i = PRIORITE_MOBILE.indexOf(vers);
  return i < 0 ? PRIORITE_MOBILE.length : i;
};

export function Coquille() {
  const { organisation, organisations, choisirOrganisation, peut, deconnecter, session, adminGeneral, plateforme } = useSession();
  const demandes = Number(plateforme?.demandes_en_attente ?? 0);
  // Nouveau gérant principal : le logo joint à sa demande rejoint son entreprise.
  useEffect(() => {
    if (organisation?.role_code === 'proprietaire') void reprendreLogoDemande().catch(() => undefined);
  }, [organisation?.role_code]);
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
  const naviguer = useNavigate();
  const magasinsVisibles = useMagasins(organisation?.organisation_id);
  const magasinGlobal = useMagasinGlobal();
  useEffect(() => {
    // Magasin retenu qui n'existe plus (ou autre entreprise) : retour à « Tous ».
    if (magasinGlobal && magasinsVisibles.length && !magasinsVisibles.some((m) => m.id === magasinGlobal)) choisirMagasinGlobal('');
  }, [magasinGlobal, magasinsVisibles]);
  // Fenêtres façon Windows (ordinateur) : modules ouverts dans la barre des tâches, fenêtre réduite ou agrandie.
  const [ouvertes, setOuvertes] = useState<string[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('dfg_fenetres') ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  const [reduite, setReduite] = useState(false);
  const [agrandie, setAgrandie] = useState(false);
  // Animation de sortie (aspiration vers le Dock, ou fondu à la fermeture) avant d'agir.
  const [sortie, setSortie] = useState<null | 'reduire' | 'fermer'>(null);
  const animerPuis = (type: 'reduire' | 'fermer', suite: () => void) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce), (max-width: 860px)').matches) return suite();
    setSortie(type);
    window.setTimeout(() => {
      setSortie(null);
      suite();
    }, type === 'reduire' ? 420 : 220);
  };
  useEffect(() => {
    setMenuMobile(false);
  }, [emplacement.pathname]);
  // La caisse occupe tout l'écran : seul le panier défile.
  const pleinEcran = emplacement.pathname === '/caisse';
  // Chaque page repart du haut (le contenu défile dans son cadre, pas la fenêtre).
  const cadre = useRef<HTMLElement>(null);
  // Attention : scrollTo() renvoie une promesse dans les navigateurs récents ; un effet ne doit
  // jamais la renvoyer (React la prendrait pour une fonction de nettoyage et planterait).
  useEffect(() => {
    if (cadre.current) cadre.current.scrollTop = 0;
  }, [emplacement.pathname]);

  // Sur téléphone (et dans l'APK), la caisse et le stock passent devant : c'est l'usage principal.
  const ordreMobile = [...liens].sort((a, b) => rangMobile(a.vers) - rangMobile(b.vers));
  const principaux = ordreMobile.length > MAX_MOBILE + 1 ? ordreMobile.slice(0, MAX_MOBILE) : ordreMobile;
  const autres = ordreMobile.length > MAX_MOBILE + 1 ? ordreMobile.slice(MAX_MOBILE) : [];
  const logo = identite?.logoUrl;
  const page = [...liens].reverse().find((l) => (l.vers === '/' ? emplacement.pathname === '/' : emplacement.pathname.startsWith(l.vers)));
  const versPage = page?.vers ?? '/';
  const idOrg = organisation?.organisation_id;
  useEffect(() => {
    definirOrgTrace(idOrg);
    if (idOrg && page) tracer('module_ouvert', { module: page.libelle });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idOrg, versPage]);
  useEffect(() => {
    setReduite(false);
    setOuvertes((l) => (l.includes(versPage) ? l : [...l, versPage].slice(-8)));
  }, [versPage, emplacement.key]);
  useEffect(() => {
    try {
      sessionStorage.setItem('dfg_fenetres', JSON.stringify(ouvertes));
    } catch {
      /* stockage indisponible */
    }
  }, [ouvertes]);
  const fenetresOuvertes = ouvertes.map((v) => liens.find((l) => l.vers === v)).filter((l): l is (typeof liens)[number] => !!l);
  const fermerFenetre = (vers: string) => {
    tracer('fenetre_fermee', { module: liens.find((l) => l.vers === vers)?.libelle ?? vers });
    const reste = ouvertes.filter((v) => v !== vers);
    setOuvertes(reste);
    if (vers !== versPage) return;
    const suivante = reste[reste.length - 1];
    if (suivante) naviguer(suivante);
    else setReduite(true);
  };
  // Fermeture depuis le Dock : dès l'appui (sans attendre le relâchement), l'icône se replie puis disparaît.
  const [fermant, setFermant] = useState<string | null>(null);
  const fermerDepuisDock = (vers: string) => {
    if (fermant) return;
    setFermant(vers);
    window.setTimeout(() => {
      setFermant(null);
      fermerFenetre(vers);
    }, 190);
  };
  const nomUtilisateur = (session?.user.user_metadata?.nom_complet as string | undefined) || identifiantAffiche(session?.user.email);

  const lien = (l: (typeof liens)[number]) => (
    <NavLink key={l.vers} to={l.vers} end={l.vers === '/'}>
      <span className="nav-icone" aria-hidden>
        {l.icone}
      </span>
      <span className="nav-libelle">{l.libelle}</span>
      {l.vers === '/administration' && demandes > 0 && (
        <span className="nav-badge" aria-label={`${demandes} demande(s) à traiter`}>
          {demandes}
        </span>
      )}
    </NavLink>
  );

  return (
    <div className={`app ${pleinEcran ? 'app-plein' : ''} ${agrandie ? 'app-agrandie' : ''}`}>
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
          {magasinsVisibles.length > 1 && (
            <label className={`entete-magasin ${magasinGlobal ? 'precis' : ''}`} title="Magasin affiché">
              <span aria-hidden>🏬</span>
              <select value={magasinGlobal} onChange={(e) => choisirMagasinGlobal(e.target.value)} aria-label="Magasin affiché">
                <option value="">Tous les magasins</option>
                {magasinsVisibles.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nom}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!pleinEcran && (
            <button type="button" className="entete-bouton" onClick={() => void imprimerPageA4()} title="Imprimer cette page (A4)" aria-label="Imprimer cette page sur A4">
              🖨️
            </button>
          )}
          <button type="button" className="entete-bouton" onClick={() => { tracer('verrouillage'); verrouillerMaintenant(); }} title="Verrouiller (code d’entrée)" aria-label="Verrouiller">
            🔒
          </button>
          <Link to="/compte" className="entete-utilisateur" title={nomUtilisateur}>
            <span className="avatar-matricule">{nomUtilisateur.charAt(0).toUpperCase()}</span>
            <span className="entete-nom">{nomUtilisateur}</span>
          </Link>
          <button type="button" className="entete-bouton" onClick={() => void deconnecter()} title="Se déconnecter" aria-label="Se déconnecter">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <path d="M12 3v8" />
              <path d="M6.3 6.8a8 8 0 1 0 11.4 0" />
            </svg>
          </button>
        </div>
      </header>

      <div className="bureau">
        <div className={`fenetre-app ${reduite ? 'fenetre-reduite' : ''} ${sortie ? `fenetre-sort-${sortie}` : ''}`}>
          <div className="fenetre-app-barre" onDoubleClick={() => setAgrandie(!agrandie)}>
            <span className="feux" onDoubleClick={(e) => e.stopPropagation()}>
              <button type="button" className="feu feu-rouge" onClick={() => animerPuis('fermer', () => fermerFenetre(versPage))} title="Fermer" aria-label="Fermer la fenêtre">
                <span aria-hidden>×</span>
              </button>
              <button type="button" className="feu feu-jaune" onClick={() => animerPuis('reduire', () => { tracer('fenetre_reduite', { module: page?.libelle ?? '' }); setReduite(true); })} title="Réduire" aria-label="Réduire la fenêtre">
                <span aria-hidden>−</span>
              </button>
              <button type="button" className="feu feu-vert" onClick={() => setAgrandie(!agrandie)} title={agrandie ? 'Restaurer' : 'Agrandir'} aria-label={agrandie ? 'Restaurer la fenêtre' : 'Agrandir la fenêtre'}>
                <span aria-hidden>{agrandie ? '↙' : '↗'}</span>
              </button>
            </span>
            <span className="fenetre-app-titre">
              <span aria-hidden>{page?.icone} </span>
              {page?.libelle ?? 'DF Gestion'}
            </span>
            <span className="feux-equilibre" aria-hidden />
          </div>
          <main ref={cadre} className={`app-contenu ${pleinEcran ? 'contenu-plein' : ''}`}>
            {/* Une erreur dans un module n'emporte plus le menu ni l'en-tête. */}
            <FiletSecurite key={emplacement.pathname} niveau="page">
              <Outlet />
            </FiletSecurite>
          </main>
        </div>
        {reduite && (
          <div className="bureau-icones">
            {liens.map((l) => (
              <button
                key={l.vers}
                type="button"
                className="bureau-icone"
                onClick={() => {
                  setReduite(false);
                  if (l.vers !== versPage) naviguer(l.vers);
                }}
              >
                <span aria-hidden>{l.icone}</span>
                {l.libelle}
              </button>
            ))}
          </div>
        )}
        <div className="barre-taches" role="toolbar" aria-label="Fenêtres ouvertes">
          <button type="button" className="tache tache-bureau" onClick={() => setReduite(!reduite)} title="Afficher le bureau">
            ⊞
          </button>
          {fenetresOuvertes.map((l) => (
            <span
              key={l.vers}
              data-nom={l.libelle}
              className={`tache ${!reduite && l.vers === versPage ? 'active' : ''} ${fermant === l.vers ? 'tache-sort' : ''}`}
              onAuxClick={(e) => e.button === 1 && fermerDepuisDock(l.vers)}
              onContextMenu={(e) => {
                e.preventDefault();
                fermerDepuisDock(l.vers);
              }}
            >
              <button
                type="button"
                onClick={() => {
                  if (l.vers === versPage) return setReduite(!reduite);
                  setReduite(false);
                  naviguer(l.vers);
                }}
              >
                <span aria-hidden>{l.icone} </span>
                {l.libelle}
              </button>
              <button type="button" className="tache-fermer" onPointerDown={(e) => { e.preventDefault(); fermerDepuisDock(l.vers); }} onClick={(e) => e.detail === 0 && fermerDepuisDock(l.vers)} aria-label={`Fermer ${l.libelle}`} title="Fermer (ou clic droit sur l’icône)">
                ✕
              </button>
            </span>
          ))}
        </div>
      </div>
      <AlertesEquipe org={organisation?.organisation_id} />

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
              🚪 Se déconnecter
            </button>
          </div>
        </div>
      )}
      <VerrouInactivite />
    </div>
  );
}
