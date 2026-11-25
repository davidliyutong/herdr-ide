import { build } from 'esbuild';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
// channels to the core only).
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

// The core, for the app's utility process (backend/hosts/electron), with
// the backend's packages bundled (pnpm -C backend install first); node-pty,
// a native module, stays a package of the app, loaded when an ssh login
// needs it. ws's optional native helpers are not there and need not be.
await build({
  entryPoints: ['../backend/hosts/electron/main.ts'],
  outfile: 'dist/core.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // ES module builds first: jsonc-parser's main is UMD, which hides its
  // modules from the bundler.
  mainFields: ['module', 'main'],
  external: ['node-pty', 'bufferutil', 'utf-8-validate'],
  // CommonJS packages in an ES module bundle require what they need.
  banner: { js: "import { createRequire as __coreRequire } from 'node:module'; const require = __coreRequire(import.meta.url);" },
  logLevel: 'warning',
});

// macOS: the Secure Enclave helper (helper/build.mjs), which the packaged app
// carries in Contents/Helpers and the development run finds here. Without
// swiftc the rest still builds, and the app runs without Touch ID unlocks;
// electron-builder's beforePack refuses to package a Mac app without it.
if (process.platform === 'darwin') {
  if (await swiftcFound()) await buildHelper('dist/helper');
  else console.warn('warning: swiftc not found (Xcode command line tools): the Secure Enclave helper is not built');
}
