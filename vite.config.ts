import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['logo-192.png', 'logo-512.png', 'apple-touch-icon.png', 'favicon-32.png', 'sw-notifications.js'],
      manifest: {
        id: '/',
        lang: 'pt-BR',
        name: 'LMS Education Platform',
        short_name: 'IV',
        description: 'Plataforma de gestão do LMS Education Platform',
        theme_color: '#0f1117',
        background_color: '#0f1117',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'icon-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
          {
            src: 'logo-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: 'logo-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
        shortcuts: [
          {
            name: 'Dashboard',
            short_name: 'Dashboard',
            url: '/',
            icons: [{ src: 'logo-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Turmas',
            short_name: 'Turmas',
            url: '/turmas',
            icons: [{ src: 'logo-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Calendário',
            short_name: 'Calendário',
            url: '/calendario',
            icons: [{ src: 'logo-192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/],
        // Ensure the new SW activates immediately on refresh, so critical
        // bug fixes (especially WebRTC playback fixes) reach mobile users
        // without requiring them to fully close all PWA tabs.
        skipWaiting: true,
        clientsClaim: true,
        // Inject our notification handlers into the generated SW
        importScripts: ['sw-notifications.js'],
        runtimeCaching: [
          // ── Google Fonts ────────────────────────────────────────────────────
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'gstatic-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // ── Supabase REST (read-only endpoints) — StaleWhileRevalidate ──────
          // Serves cached data immediately while refreshing in the background.
          // Avoids blank screens on flaky mobile connections.
          // NOTE: Do NOT set fetchOptions.credentials here — Supabase uses
          // Access-Control-Allow-Origin: * and the browser blocks credentialed
          // requests against wildcard origins (CORS preflight failure). Auth is
          // handled via the Authorization: Bearer header by the Supabase client,
          // so cookie-based credentials are not needed.
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'supabase-api-cache',
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 10 }, // 10 min max age
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // ── Supabase Auth endpoints — NetworkFirst (never serve stale auth) ─
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/auth\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-auth-cache',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // ── Static images (avatars, assets) ─────────────────────────────────
          {
            urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp|ico)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'image-cache',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 }, // 30 days
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Supabase is the heaviest dep — isolate it for better long-term caching.
          // Safe to split: no circular dependency with other chunks.
          if (id.includes('@supabase')) return 'vendor-supabase';
          // Lucide icons — large but tree-shaken; safe to split (no React import at
          // module init; icons are pure functions). Separate chunk avoids busting
          // the icon cache on every app change.
          if (id.includes('lucide-react')) return 'vendor-lucide';
          // All other node_modules — including React, react-dom, react-router,
          // @tanstack/react-query, scheduler, react-is, localforage, etc. — go
          // into a single `vendor` chunk.
          //
          // We intentionally do NOT split React into its own chunk because the
          // React ecosystem has many internal cross-dependencies (scheduler,
          // react-is, @tanstack/query-core …) that Rollup resolves in different
          // node_modules/ sub-paths. Splitting creates circular chunk references
          // ("vendor → vendor-react → vendor") that cause React.createContext to
          // be undefined at runtime on some module evaluation orders.
          if (id.includes('node_modules')) return 'vendor';
        },
      },
    },
  },
  server: {
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
      },
    },
  },
});
