import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Site public DF Marché : `vite build -c vite.marche.config.ts` → dist-marche/
export default defineConfig({
  root: fileURLToPath(new URL('./marche', import.meta.url)),
  publicDir: fileURLToPath(new URL('./marche/public', import.meta.url)),
  build: { outDir: fileURLToPath(new URL('./dist-marche', import.meta.url)), emptyOutDir: true },
  plugins: [react()],
});
