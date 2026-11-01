import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron'],
});

// Sandboxed preloads may require only a few electron modules, so bundle it.
await build({
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron'],
});
