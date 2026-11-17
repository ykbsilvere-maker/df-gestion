import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow/700.css';
import '@fontsource/barlow/800.css';
import './marche.css';
import { Annonces, BarreOnglets, EnTete, Pied } from './composants';
import { Accueil, Favoris, ListeBoutiques, Rayons, Recherche } from './pages/Catalogue';
import { Boutique, Produit } from './pages/Boutique';
import { Commander, Panier } from './pages/Commande';
import { MesCommandes, Suivi } from './pages/Suivi';

const CIBLES_ONDE =
  'button, .bouton, .carte-boutique, .tuile-rayon, .raccourcis .rond, .liste-commandes a, .encart-boutique, .pastille-lien, .entete-sous a, .rond-lien, .affiche';

/** Onde qui part du doigt (ou de la souris) sur tout ce qui se touche. */
document.addEventListener(
  'pointerdown',
  (e) => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(CIBLES_ONDE);
    if (!el || (el as HTMLButtonElement).disabled) return;
    const r = el.getBoundingClientRect();
    const t = Math.max(r.width, r.height) * 2.2;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.classList.add('a-onde');
    const v = document.createElement('span');
    v.className = 'vague';
    v.style.cssText = `width:${t}px;height:${t}px;left:${e.clientX - r.left - t / 2}px;top:${e.clientY - r.top - t / 2}px`;
    el.appendChild(v);
    window.setTimeout(() => v.remove(), 650);
  },
  { passive: true },
);

function Cadre() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return (
    <>
      <EnTete />
      <main className="page" key={pathname.startsWith('/rayons') ? '/rayons' : pathname}>
        <Outlet />
      </main>
      <Pied />
      <BarreOnglets />
      <Annonces />
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
          <Route path="rayons" element={<Rayons />} />
          <Route path="rayons/:nom" element={<Rayons />} />
          <Route path="favoris" element={<Favoris />} />
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
