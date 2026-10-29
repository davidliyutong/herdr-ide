import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { APP_NAME } from './src/brand';

const core = process.env.WEBHERDR_CORE ?? 'http://127.0.0.1:7780';

// index.html title and the PWA manifest come from src/brand.ts.
function brand(): Plugin {
  const manifest = JSON.stringify(
    {
      name: APP_NAME,
      short_name: APP_NAME,
      start_url: '/',
      display: 'standalone',
      display_override: ['window-controls-overlay', 'standalone'],
      background_color: '#0e1116',
      theme_color: '#0e1116',
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    },
    null,
    2,
  );
  return {
    name: 'brand',
    transformIndexHtml: (html) => html.replaceAll('%APP_NAME%', APP_NAME),
    configureServer(server) {
      server.middlewares.use('/manifest.webmanifest', (_req, res) => {
        res.setHeader('Content-Type', 'application/manifest+json');
        res.end(manifest);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: manifest });
      // dist/ is emptied on build but must keep a tracked file for go:embed.
      this.emitFile({ type: 'asset', fileName: '.gitkeep', source: '' });
    },
  };
}

export default defineConfig({
  plugins: [react(), brand()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
    // Licenses of the bundled dependencies, shipped inside the embedded UI.
    license: { fileName: 'licenses.md' },
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: core, ws: true },
      '/api': { target: core },
      '/m': { target: core, ws: true },
    },
  },
});
