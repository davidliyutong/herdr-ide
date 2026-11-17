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
      background_color: '#0a0a0a',
      theme_color: '#0a0a0a',
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

// The bundled terminal font, terminal emulator, VSCodium logo and the AI
// services' marks are not npm packages the UI imports, so Vite's license
// list leaves them out (src/terminal/fonts/README.md,
// scripts/fetch-ghostty-vt.sh, src/assets/vscodium/README.md,
// src/assets/ai-logos/README.md). Monaco bundles code of other projects,
// whose notices it ships beside its license. The grammars code is colored
// with (@shikijs/langs) are those of the collection tm-grammars, built from
// many projects' grammars: its notices name each one's license. They are
// read from that package, a development dependency of the version
// @shikijs/langs was built from, which nothing else uses.
const grammarsVersion = (): string =>
  (JSON.parse(readFileSync(new URL('./node_modules/tm-grammars/package.json', import.meta.url), 'utf8')) as { version: string }).version;

function bundledLicenses(): Plugin {
  return {
    name: 'bundled-licenses',
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        const out = bundle['licenses.md'];
        if (out?.type !== 'asset') return;
        const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').trim();
        out.source =
          `${String(out.source).trimEnd()}\n\n## JetBrains Mono - 2.304 (OFL-1.1)\n\n${read('./src/terminal/fonts/OFL.txt')}\n` +
          `\n## libghostty-vt (Ghostty cf5519b22f91, MIT)\n\n${read('./src/vt/LICENSE')}\n` +
          `\n## VSCodium logo (VSCodium ca7f7b44b5e5, MIT)\n\n${read('./src/assets/vscodium/LICENSE')}\n` +
          `\n## AI service marks (Lobe Icons, @lobehub/icons-static-svg 1.102.0, MIT)\n\n${read('./src/assets/ai-logos/LICENSE')}\n` +
          `\n## Third-party notices of monaco-editor\n\n${read('./node_modules/monaco-editor/ThirdPartyNotices.txt')}\n` +
          `\n## Third-party notices of the code grammars (tm-grammars ${grammarsVersion()}, through Shiki)\n\n${read('./node_modules/tm-grammars/NOTICE')}\n`;
      },
    },
  };
}

// KaTeX's stylesheet offers each font as woff2, woff and ttf. Every browser
// the UI runs in reads woff2, so the others stay out of the bundle (and the
// binary that embeds it). Runs before Vite resolves the stylesheet's URLs.
function katexWoff2(): Plugin {
  return {
    name: 'katex-woff2',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]katex[\\/]dist[\\/]katex(\.min)?\.css$/.test(id)) return;
      return code.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, '');
    },
  };
}

// Chunks made only of packages' code are shipped without source maps:
// Monaco (src/plugins/monaco.ts), the code grammars and their highlighter
// (src/highlight; a grammar is data), KaTeX. Their maps would be most of
// the embedded UI's size, for code that is not ours. A chunk with a module
// of the app keeps its map.
function monacoWithoutMaps(): Plugin {
  const ours = (id: string) => !/[\\/]node_modules[\\/]/.test(id) && !id.startsWith('\0');
  return {
    name: 'monaco-without-maps',
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        for (const out of Object.values(bundle)) {
          if (out.type !== 'chunk' || !Object.keys(out.modules).length || Object.keys(out.modules).some(ours)) continue;
          delete bundle[`${out.fileName}.map`];
          out.map = null;
          out.code = out.code.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');
        }
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), brand(), bundledLicenses(), katexWoff2(), monacoWithoutMaps()],
  worker: { plugins: () => [monacoWithoutMaps()] },
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
      // The terminals' WebSocket (and the ssh login's) under /api.
      '/api': { target: core, ws: true },
      '/m': {
        target: core,
        ws: true,
        // Pages of GUI windows are the app itself.
        bypass: (req) => (/^\/m\/[^/]+\/gui\/\d+\/?(\?|$)/.test(req.url ?? '') ? '/index.html' : undefined),
      },
    },
  },
});
