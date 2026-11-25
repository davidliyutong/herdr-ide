import { build } from 'esbuild';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { buildHelper, swiftcFound } from './helper/build.mjs';

// node-pty 1.1.0 ships its macOS spawn-helper without the executable bit
// (its tarball's mode is 0644), so every spawn fails with "posix_spawnp
// failed": give it back to the installed copy, which development runs and
// packaging use. A copy of its own: the package manager's store links the
// file, whose mode it shares.
const prebuilds = 'node_modules/node-pty/prebuilds';
if (existsSync(prebuilds))
  for (const dir of readdirSync(prebuilds).filter((d) => d.startsWith('darwin-'))) {
    const helper = `${prebuilds}/${dir}/spawn-helper`;
    if (!existsSync(helper) || statSync(helper).mode & 0o111) continue;
    const bytes = readFileSync(helper);
    unlinkSync(helper);
    writeFileSync(helper, bytes, { mode: 0o755 });
  }

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron'],
});

// Sandboxed preloads may require only a few electron modules, so bundle
// them: the main window's, and the app's other windows' (their frames'
// channels to the hub only).
for (const [entry, out] of [
  ['src/preload.ts', 'dist/preload.cjs'],
  ['src/framePreload.ts', 'dist/frames.cjs'],
]) {
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: 'node',
    target: 'node22',
    external: ['electron'],
  });
}

// The hub, for the app's utility process (backend/hosts/electron), with
// the backend's packages bundled (pnpm -C backend install first); node-pty,
// a native module, stays a package of the app, loaded when an ssh login
// needs it. ws's optional native helpers (bufferutil, utf-8-validate) are
// not shipped: they are bundled as modules that fail to load, which ws
// takes as their absence, so the hub never looks for a module the app
// does not carry (a search that leaves the app's directory would find one
// anyone could put there). Nothing but Node's own modules and node-pty is
// loaded at run time: checked below.
const SHIPPED = new Set(['node-pty']);
const notShipped = {
  name: 'not-shipped',
  setup(b) {
    b.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, (a) => ({ path: a.path, namespace: 'not-shipped' }));
    b.onLoad({ filter: /.*/, namespace: 'not-shipped' }, (a) => ({
      contents: `throw Object.assign(new Error(${JSON.stringify(a.path + ' is not shipped')}), { code: 'MODULE_NOT_FOUND' });`,
      loader: 'js',
    }));
  },
};
await build({
  entryPoints: ['../backend/hosts/electron/main.ts'],
  outfile: 'dist/hub.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // ES module builds first: jsonc-parser's main is UMD, which hides its
  // modules from the bundler.
  mainFields: ['module', 'main'],
  external: [...SHIPPED],
  plugins: [notShipped],
  // CommonJS packages in an ES module bundle require what they need.
  banner: { js: "import { createRequire as __hubRequire } from 'node:module'; const require = __hubRequire(import.meta.url);" },
  logLevel: 'warning',
});
const loaded = new Set(
  [...readFileSync('dist/hub.mjs', 'utf8').matchAll(/\b(?:require|__require|createRequire\([^()]*\))\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map(
    (m) => m[1],
  ),
);
const foreign = [...loaded].filter((m) => !isBuiltin(m) && !SHIPPED.has(m));
if (foreign.length) throw new Error(`dist/hub.mjs loads modules the app does not carry: ${foreign.join(', ')}`);

// macOS: the Secure Enclave helper (helper/build.mjs), which the packaged app
// carries in Contents/Helpers and the development run finds here. Without
// swiftc the rest still builds, and the app runs without Touch ID unlocks;
// electron-builder's beforePack refuses to package a Mac app without it.
if (process.platform === 'darwin') {
  if (await swiftcFound()) await buildHelper('dist/helper');
  else console.warn('warning: swiftc not found (Xcode command line tools): the Secure Enclave helper is not built');
}
