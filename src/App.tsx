import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { FournisseurSession, useSession } from './lib/session';
import { configurationManquante } from './lib/supabase';
import { Coquille } from './components/Coquille';
import { Connexion } from './pages/Connexion';
import { NouveauMotDePasse } from './pages/NouveauMotDePasse';
import { CreerEntreprise } from './pages/CreerEntreprise';
import { Accueil } from './pages/Accueil';
import { Magasins } from './pages/Magasins';
import { Utilisateurs } from './pages/Utilisateurs';
import { Journal } from './pages/Journal';
import { Personnalisation } from './pages/Personnalisation';
import { Catalogue } from './pages/Catalogue';
import { EtiquettesPage } from './pages/EtiquettesPage';
import { FournisseurIdentite } from './lib/identite';
import { FournisseurImpression } from './impression/impression';
import { MonCompte } from './pages/MonCompte';
import { StockPage } from './pages/stock/StockPage';
import { EtatStock } from './pages/stock/EtatStock';
import { AlertesStock } from './pages/stock/AlertesStock';
import { FicheReception, ListeReceptions } from './pages/stock/Receptions';
import { Transferts } from './pages/stock/Transferts';
import { Sorties } from './pages/stock/Sorties';
import { FicheInventaire, ListeInventaires } from './pages/stock/Inventaires';
import { Mouvements } from './pages/stock/Mouvements';
import { Fournisseurs } from './pages/stock/Fournisseurs';
import { ImportExcel } from './pages/stock/ImportExcel';
import { CaissePage } from './caisse/CaissePage';
import { SuiviCaisse } from './caisse/SuiviCaisse';
import { ExtractionVentes } from './pages/rapports/ExtractionVentes';
import { CoutsDeRevient, FicheFournisseur, FournisseursModule } from './pages/fournisseurs/FournisseursModule';
import { Budget } from './pages/pilotage/Budget';
import { Tresorerie } from './pages/pilotage/Tresorerie';
import { Creances, FicheClient, TresorerieModule } from './pages/pilotage/Creances';
import { Approvisionnement } from './pages/pilotage/Approvisionnement';
import { FicheDevis, ListeDevis } from './pages/Devis';
import { Rentabilite } from './pages/pilotage/Rentabilite';
import { VueEnsemble } from './pages/pilotage/VueEnsemble';
import { Comptabilite } from './pages/pilotage/Comptabilite';
import { Soldes } from './pages/pilotage/Soldes';
import { Administration } from './pages/Administration';
import { Configuration } from './pages/Configuration';
import { ChoisirCode } from './pages/ChoisirCode';

function Chargement() {
  return (
    <div className="chargement" role="status">
      Chargement…
    </div>
  );
}

/**
 * Redirige selon l'état : non connecté → connexion ; mot de passe provisoire → choix
 * d'un mot de passe ; sans entreprise → console d'administration (administrateur
 * général) ou page de création / d'attente.
 */
function Protege({ children }: { children: ReactNode }) {
  const { session, chargement, organisations, mdpProvisoire, codeAChoisir, adminGeneral } = useSession();
  if (chargement) return <Chargement />;
  if (!session) return <Navigate to="/connexion" replace />;
  if (codeAChoisir) return <Navigate to="/choisir-code" replace />;
  if (mdpProvisoire) return <Navigate to="/nouveau-mot-de-passe" replace />;
  if (organisations.length === 0) return <Navigate to={adminGeneral ? '/administration' : '/creer-entreprise'} replace />;
  return <>{children}</>;
}

/** Console réservée à l'administrateur général (accessible même sans entreprise). */
function ProtegeAdmin({ children }: { children: ReactNode }) {
  const { session, chargement, mdpProvisoire, adminGeneral } = useSession();
  if (chargement) return <Chargement />;
  if (!session) return <Navigate to="/connexion" replace />;
  if (mdpProvisoire) return <Navigate to="/nouveau-mot-de-passe" replace />;
  if (!adminGeneral) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function ChangerServeur() {
  const naviguer = useNavigate();
  return <Configuration retour={() => naviguer('/connexion')} />;
}

/** Masque une page sans le droit requis (la base refuserait de toute façon les données). */
function AvecDroit({ permission, children }: { permission: string | string[]; children: ReactNode }) {
  const { peut } = useSession();
  const liste = Array.isArray(permission) ? permission : [permission];
  return liste.some((p) => peut(p)) ? <>{children}</> : <Navigate to="/" replace />;
}

function Routes_() {
  const { session, chargement } = useSession();
  return (
    <Routes>
      <Route
        path="/connexion"
        element={chargement ? <Chargement /> : session ? <Navigate to="/" replace /> : <Connexion />}
      />
      <Route path="/nouveau-mot-de-passe" element={<NouveauMotDePasse />} />
      <Route path="/choisir-code" element={chargement ? <Chargement /> : session ? <ChoisirCode /> : <Navigate to="/connexion" replace />} />
      <Route path="/configuration" element={<ChangerServeur />} />
      <Route
        element={
          <ProtegeAdmin>
            <FournisseurIdentite>
              <Coquille />
            </FournisseurIdentite>
          </ProtegeAdmin>
        }
      >
        <Route path="administration" element={<Administration />} />
      </Route>
      <Route
        path="/creer-entreprise"
        element={chargement ? <Chargement /> : session ? <CreerEntreprise /> : <Navigate to="/connexion" replace />}
      />
      <Route
        element={
          <Protege>
            <FournisseurIdentite>
              <Coquille />
            </FournisseurIdentite>
          </Protege>
        }
      >
        <Route index element={<Accueil />} />
        <Route path="caisse" element={<AvecDroit permission="caisse.creer"><CaissePage /></AvecDroit>} />
        <Route path="caisse/suivi" element={<AvecDroit permission={['caisse.creer', 'caisse.consulter']}><SuiviCaisse /></AvecDroit>} />
        <Route path="magasins" element={<AvecDroit permission="magasins.consulter"><Magasins /></AvecDroit>} />
        <Route path="utilisateurs" element={<AvecDroit permission="utilisateurs.consulter"><Utilisateurs /></AvecDroit>} />
        <Route path="journal" element={<AvecDroit permission="audit.consulter"><Journal /></AvecDroit>} />
        <Route path="catalogue" element={<AvecDroit permission="catalogue.consulter"><Catalogue /></AvecDroit>} />
        <Route path="import" element={<AvecDroit permission={['catalogue.creer', 'catalogue.modifier', 'fournisseurs.creer', 'achats.creer', 'stock.creer']}><ImportExcel /></AvecDroit>} />
        <Route path="catalogue/etiquettes" element={<AvecDroit permission="catalogue.consulter"><EtiquettesPage /></AvecDroit>} />
        <Route path="stock" element={<AvecDroit permission="stock.consulter"><StockPage /></AvecDroit>}>
          <Route index element={<EtatStock />} />
          <Route path="alertes" element={<AlertesStock />} />
          <Route path="receptions" element={<ListeReceptions />} />
          <Route path="receptions/:id" element={<FicheReception />} />
          <Route path="transferts" element={<AvecDroit permission="stock.modifier"><Transferts /></AvecDroit>} />
          <Route path="sorties" element={<AvecDroit permission="stock.modifier"><Sorties /></AvecDroit>} />
          <Route path="inventaires" element={<ListeInventaires />} />
          <Route path="inventaires/:id" element={<FicheInventaire />} />
          <Route path="mouvements" element={<Mouvements />} />
          <Route path="fournisseurs" element={<Navigate to="/fournisseurs" replace />} />
          <Route path="approvisionnement" element={<Approvisionnement />} />
        </Route>
        <Route path="fournisseurs" element={<AvecDroit permission={['fournisseurs.consulter', 'achats.consulter']}><FournisseursModule /></AvecDroit>}>
          <Route index element={<Fournisseurs />} />
          <Route path="couts" element={<CoutsDeRevient />} />
          <Route path=":id" element={<FicheFournisseur />} />
        </Route>
        <Route path="budget" element={<AvecDroit permission="budget.consulter"><Budget /></AvecDroit>} />
        <Route path="tresorerie" element={<AvecDroit permission={['tresorerie.consulter', 'achats.creer', 'stock.creer']}><TresorerieModule /></AvecDroit>}>
          <Route index element={<AvecDroit permission="tresorerie.consulter"><Tresorerie /></AvecDroit>} />
          <Route path="creances" element={<AvecDroit permission="tresorerie.consulter"><Creances /></AvecDroit>} />
          <Route path="clients/:id" element={<AvecDroit permission="tresorerie.consulter"><FicheClient /></AvecDroit>} />
          <Route path="approvisionnement" element={<Approvisionnement />} />
        </Route>
        <Route path="vue-ensemble" element={<AvecDroit permission="rentabilite.consulter"><VueEnsemble /></AvecDroit>} />
        <Route path="rentabilite" element={<AvecDroit permission="rentabilite.consulter"><Rentabilite /></AvecDroit>} />
        <Route path="comptabilite" element={<AvecDroit permission="comptabilite.consulter"><Comptabilite /></AvecDroit>} />
        <Route path="soldes" element={<AvecDroit permission="promotions.consulter"><Soldes /></AvecDroit>} />
        <Route path="devis" element={<AvecDroit permission="ventes.valider"><ListeDevis /></AvecDroit>} />
        <Route path="devis/:id" element={<AvecDroit permission="ventes.valider"><FicheDevis /></AvecDroit>} />
        <Route path="rapports/ventes" element={<AvecDroit permission={['ventes.exporter', 'rapports.consulter']}><ExtractionVentes /></AvecDroit>} />
        <Route path="personnalisation" element={<AvecDroit permission="administration.consulter"><Personnalisation /></AvecDroit>} />
        <Route path="entreprise" element={<Navigate to="/personnalisation" replace />} />
        <Route path="compte" element={<MonCompte />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  if (configurationManquante) return <Configuration />;
  return (
    <BrowserRouter>
      <FournisseurSession>
        <FournisseurImpression>
          <Routes_ />
        </FournisseurImpression>
      </FournisseurSession>
    </BrowserRouter>
  );
}
