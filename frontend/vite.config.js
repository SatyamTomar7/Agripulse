import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'AgriPulse',
        short_name: 'AgriPulse',
        description: 'Offline agribusiness marketplace',
        theme_color: '#166534',
        background_color: '#f8faf8',
        display: 'standalone'
      }
    })
  ],
  server: { port: 5173 }
});
