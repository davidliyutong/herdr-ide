import { build } from 'esbuild';
import { buildHelper, swiftcFound } from './helper/build.mjs';

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

// macOS: the Secure Enclave helper (helper/build.mjs), which the packaged app
// carries in Contents/Helpers and the development run finds here. Without
// swiftc the rest still builds, and the app runs without Touch ID unlocks;
// electron-builder's beforePack refuses to package a Mac app without it.
if (process.platform === 'darwin') {
  if (await swiftcFound()) await buildHelper('dist/helper');
  else console.warn('warning: swiftc not found (Xcode command line tools): the Secure Enclave helper is not built');
}
