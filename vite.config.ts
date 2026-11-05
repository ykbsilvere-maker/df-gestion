import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// `vite build --mode apk` : version embarquée dans l'application Android (sans service worker :
// les fichiers sont déjà dans l'application).
export default defineConfig(({ mode }) => ({
  build: mode === 'apk' ? { outDir: 'dist-apk' } : undefined,
  // Version affichée et jointe aux rapports d'erreur.
  define: { __VERSION_APP__: JSON.stringify(process.env.npm_package_version ?? '') },
  plugins: [
    react(),
    mode !== 'apk' && VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icone.svg', 'apple-touch-icon.png', 'marque/logo-decodeur.png'],
      manifest: {
        name: 'Le Décodeur Financier — Gestion',
        short_name: 'DF Gestion',
        description: 'Caisse, stock et pilotage pour boutiques et supérettes',
        lang: 'fr',
        start_url: '/',
        display: 'standalone',
        background_color: '#F4F4F3',
        theme_color: '#141414',
        icons: [
          { src: 'icone-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icone-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icone-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        // config.js est modifiable après publication : jamais figé dans le cache d'installation.
        globIgnores: ['config.js'],
        // Police Barlow et images comprises : l'application s'affiche pareil hors ligne.
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        // Les appels à Supabase ne sont jamais servis depuis le cache.
        navigateFallbackDenylist: [/^\/auth\//, /^\/rest\//, /^\/storage\//],
        runtimeCaching: [
          {
            urlPattern: /\/config\.js$/,
            handler: 'NetworkFirst',
            options: { cacheName: 'configuration', networkTimeoutSeconds: 3 },
          },
          {
            // Logos et photos : disponibles sur les reçus même sans réseau.
            urlPattern: /\/storage\/v1\/object\/public\//,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'images-entreprise', expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 } },
          },
        ],
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
}));
