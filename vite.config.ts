import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  server: {
    allowedHosts: ['.trycloudflare.com'],
    proxy: { '/api': 'http://localhost:8787' },
  },
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['favicon.svg'],
    manifest: {
      name: 'PanelApp', short_name: 'PanelApp',
      description: 'Preparación sanitaria panelera',
      theme_color: '#173b2c', background_color: '#f8f7f1',
      display: 'standalone', start_url: '/',
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
    },
    workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2,json}'], navigateFallback: '/index.html' },
  })],
});
