import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow/700.css';
import '@fontsource/barlow/800.css';
import './styles.css';

// Saisie stable : la molette de la souris ne change jamais une quantité ou un montant par erreur.
document.addEventListener(
  'wheel',
  (e) => {
    const champ = document.activeElement;
    if (champ instanceof HTMLInputElement && champ.type === 'number' && e.target === champ) champ.blur();
  },
  { passive: true },
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
