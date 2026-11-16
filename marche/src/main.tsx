import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow/700.css';
import '@fontsource/barlow/800.css';
import './marche.css';
import { EnTete, Pied } from './composants';
import { Accueil, ListeBoutiques, Recherche } from './pages/Catalogue';
import { Boutique, Produit } from './pages/Boutique';
import { Commander, Panier } from './pages/Commande';
import { MesCommandes, Suivi } from './pages/Suivi';

function Cadre() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return (
    <>
      <EnTete />
      <main className="page">
        <Outlet />
      </main>
      <Pied />
    </>
  );
}

function Introuvable() {
  return (
    <section className="bloc">
      <h1>Page introuvable</h1>
      <p><Link to="/">Retour à l’accueil</Link></p>
    </section>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Cadre />}>
          <Route index element={<Accueil />} />
          <Route path="soldes" element={<Recherche soldes />} />
          <Route path="recherche" element={<Recherche />} />
          <Route path="boutiques" element={<ListeBoutiques />} />
          <Route path="boutique/:slug" element={<Boutique />} />
          <Route path="produit/:id" element={<Produit />} />
          <Route path="panier" element={<Panier />} />
          <Route path="commander/:slug" element={<Commander />} />
          <Route path="suivi/:code" element={<Suivi />} />
          <Route path="mes-commandes" element={<MesCommandes />} />
          <Route path="*" element={<Introuvable />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
