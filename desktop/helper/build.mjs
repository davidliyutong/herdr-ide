// Builds the Secure Enclave helper (Enclave.swift) as an app bundle,
// "<app name> Enclave.app", for both Mac architectures in one universal
// executable: electron-builder copies it into the app's Contents/Helpers
// (electron-builder.cjs) and signs it there with the app; unpackaged
// development runs it from desktop/dist/helper (src/enclave.ts helperPath).
// It is signed ad hoc here so that the development run's bundle is whole.
// macOS only (swiftc, lipo and codesign of the Xcode command line tools).
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const ARCHES = ['arm64', 'x86_64'];

/** The brand constant key of web/src/brand.ts, read as electron-builder.cjs does. */
async function brand(key) {
  const source = await readFile(join(here, '../../web/src/brand.ts'), 'utf8');
  const value = source.match(new RegExp(`export const ${key} = '([^']+)'`))?.[1];
  if (!value) throw new Error(`Missing brand constant: ${key}`);
  return value;
}

/** The app's version as a bundle version (its leading x.y.z). */
async function bundleVersion() {
  const pkg = JSON.parse(await readFile(join(here, '../package.json'), 'utf8'));
  return /^v?(\d+\.\d+\.\d+)/.exec(process.env.VERSION || pkg.version)?.[1] ?? '0.0.0';
}

/**
 * Whether swiftc can be run here. xcode-select -p first: without the Xcode
 * command line tools /usr/bin/swiftc is a stub that offers to install them,
 * which a build must not set off.
 */
export async function swiftcFound() {
  try {
    await run('xcode-select', ['-p']);
    await run('xcrun', ['--find', 'swiftc']);
    return true;
  } catch {
    return false;
  }
}

/** Builds the helper's bundle into outDir; its path. */
export async function buildHelper(outDir) {
  const name = `${await brand('APP_NAME')} Enclave`;
  // The app's id (src/platform.ts APP_ID) and the helper's under it.
  const id = `dev.${await brand('APP_SLUG')}.desktop.enclave`;
  const plist = (await readFile(join(here, 'Info.plist'), 'utf8'))
    .replaceAll('@NAME@', name)
    .replaceAll('@ID@', id)
    .replaceAll('@VERSION@', await bundleVersion());
  const tmp = await mkdtemp(join(tmpdir(), 'enclave-helper-'));
  try {
    await Promise.all(
      ARCHES.map((arch) =>
        run('swiftc', ['-O', '-target', `${arch}-apple-macos12`, '-o', join(tmp, arch), join(here, 'Enclave.swift')], {
          maxBuffer: 16 << 20,
        }),
      ),
    );
    const bundle = join(outDir, `${name}.app`);
    await rm(bundle, { recursive: true, force: true });
    await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true });
    await run('lipo', ['-create', '-output', join(bundle, 'Contents', 'MacOS', name), ...ARCHES.map((arch) => join(tmp, arch))]);
    await writeFile(join(bundle, 'Contents', 'Info.plist'), plist);
    await run('codesign', ['--force', '--sign', '-', '--options', 'runtime', bundle]);
    return bundle;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
