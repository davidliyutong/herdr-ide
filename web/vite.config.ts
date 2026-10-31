import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { APP_NAME } from './src/brand';

const core = process.env.HERDR_IDE_CORE ?? 'http://127.0.0.1:7780';

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

// The bundled terminal font is not an npm package, so Vite's license list
// leaves it out (src/terminal/fonts/README.md).
function fontLicense(): Plugin {
  return {
    name: 'font-license',
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        const out = bundle['licenses.md'];
        if (out?.type !== 'asset') return;
        const ofl = readFileSync(new URL('./src/terminal/fonts/OFL.txt', import.meta.url), 'utf8').trim();
        out.source = `${String(out.source).trimEnd()}\n\n## JetBrains Mono - 2.304 (OFL-1.1)\n\n${ofl}\n`;
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), brand(), fontLicense()],
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
      '/m': {
        target: core,
        ws: true,
        // Pages of GUI windows are the app itself.
        bypass: (req) => (/^\/m\/[^/]+\/gui\/\d+\/?(\?|$)/.test(req.url ?? '') ? '/index.html' : undefined),
      },
    },
  },
});
