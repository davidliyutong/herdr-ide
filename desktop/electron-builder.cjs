const { execFileSync } = require('node:child_process');
const { existsSync, statSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Arch } = require('electron-builder');

// Packaging reads the same brand definitions imported by the launcher.
const source = readFileSync(join(__dirname, '../web/src/brand.ts'), 'utf8');
function brand(key) {
  const value = source.match(new RegExp(`export const ${key} = '([^']+)'`))?.[1];
  if (!value) throw new Error(`Missing brand constant: ${key}`);
  return value;
}
const slug = brand('APP_SLUG');
const name = brand('APP_NAME');
// The same as APP_ID in src/platform.ts: the domain reversed and "desktop".
const appId = `${brand('APP_DOMAIN').split('.').reverse().join('.')}.desktop`;
const arch = process.env.DESKTOP_ARCH || process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported architecture: ${arch}`);

// Stage 2 inputs staged in ../dist/desktop-stage by scripts/desktop.sh:
//   - bin/<slug>[.exe]: the Stage 1 compiled Bun hub executable for this
//     desktop OS and architecture (placed in Contents/Helpers/<slug> on
//     macOS so Hardened Runtime signs it with JIT entitlements, and in
//     resources/bin/ on Linux and Windows);
//   - machines/: all 6 Stage 1 POSIX release archives (<slug>-<key>.tar.gz)
//     and SHA256SUMS, so every desktop build (release and dev, macOS,
//     Windows and Linux) deploys the exact same verified Stage 1 binaries as
//     the CLI;
//   - licenses/: third-party notices extracted from Stage 1.
const STAGE = '../dist/desktop-stage';
const ALL_MACHINE_KEYS = ['linux-amd64', 'linux-arm64', 'linux-amd64-musl', 'linux-arm64-musl', 'darwin-amd64', 'darwin-arm64'];

// macOS: the Secure Enclave helper, a universal app bundle helper/build.mjs
// made in dist/helper, placed in the app's Contents/Helpers (src/enclave.ts
// helperPath), where signing the app signs it with the hardened runtime.
const helper = `${name} Enclave.app`;
const helperOf = `dist/helper/${helper}`;
const withHelper = process.platform === 'darwin';
const developerId = !!(process.env.CSC_LINK || process.env.CSC_NAME);

// The app's version: its hub's (VERSION, from scripts/version.sh), which is
// a tag or git describe's output. A bundle version must be semver, so a
// version without a tag (a bare commit, "dev") becomes a prerelease of 0.0.0.
function appVersion() {
  const v = (process.env.VERSION || require('./package.json').version).replace(/^v/, '');
  return /^\d+\.\d+\.\d+([-+].*)?$/.test(v) ? v : `0.0.0-${v.replace(/[^0-9A-Za-z.-]/g, '-')}`;
}

function homepage() {
  if (process.env.GITHUB_REPOSITORY) return `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}`;
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: __dirname, encoding: 'utf8' }).trim();
    return url.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '') || undefined;
  } catch {
    return undefined;
  }
}

const nonMacBinResource =
  process.env.DESKTOP_OS === 'mac' || (!process.env.DESKTOP_OS && process.platform === 'darwin')
    ? []
    : [{ from: `${STAGE}/bin`, to: 'bin' }];

module.exports = {
  appId,
  productName: name,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  directories: { output: '../dist/desktop' },
  files: ['dist/main.cjs', 'dist/preload.cjs', 'dist/frames.cjs', 'assets/icon.png', 'package.json'],
  extraMetadata: {
    name: `${slug}-desktop`,
    version: appVersion(),
    homepage: homepage(),
    desktopName: `${slug}.desktop`,
  },
  extraResources: [
    { from: `${STAGE}/licenses/herdr-core`, to: 'licenses/herdr-core' },
    { from: `${STAGE}/licenses/herdr-detect`, to: 'licenses/herdr-detect' },
    { from: `${STAGE}/licenses/encoder`, to: 'licenses/encoder' },
    { from: '../LICENSE', to: 'LICENSE' },
    { from: '../THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
    { from: `${STAGE}/licenses/licenses.md`, to: 'licenses.md' },
    { from: `${STAGE}/machines`, to: 'machines' },
    ...nonMacBinResource,
  ],
  beforePack: async (context) => {
    const packing = Arch[context.arch];
    if (packing !== arch) {
      throw new Error(`Packaging ${packing} with ${arch} stage; set DESKTOP_ARCH=${packing} (scripts/desktop.sh does)`);
    }
    const hubFile = context.electronPlatformName === 'win32' ? `${STAGE}/bin/${slug}.exe` : `${STAGE}/bin/${slug}`;
    const needed = [
      'dist/main.cjs',
      'dist/preload.cjs',
      'dist/frames.cjs',
      hubFile,
      `${STAGE}/machines/SHA256SUMS`,
      `${STAGE}/licenses/herdr-core/LICENSE`,
      `${STAGE}/licenses/licenses.md`,
      ...ALL_MACHINE_KEYS.map((k) => `${STAGE}/machines/${slug}-${k}.tar.gz`),
    ];
    if (context.electronPlatformName === 'darwin' && withHelper) needed.push(`${helperOf}/Contents/MacOS/${name} Enclave`);
    for (const file of needed) {
      const full = join(__dirname, file);
      if (!existsSync(full)) throw new Error(`Missing ${file}; build it with scripts/desktop.sh`);
    }
    if (context.electronPlatformName !== 'win32') {
      const st = statSync(join(__dirname, `${STAGE}/bin/${slug}`));
      if (!(st.mode & 0o111)) throw new Error(`${STAGE}/bin/${slug} is not executable`);
    }
  },
  asar: true,
  npmRebuild: false,
  mac: {
    icon: 'assets/icon.icns',
    category: 'public.app-category.developer-tools',
    target: ['dmg', 'zip'],
    identity: developerId ? undefined : '-',
    notarize: developerId && !!process.env.APPLE_ID,
    hardenedRuntime: true,
    extraFiles: [
      { from: `${STAGE}/bin/${slug}`, to: `Helpers/${slug}` },
      ...(withHelper ? [{ from: helperOf, to: `Helpers/${helper}` }] : []),
    ],
    extendInfo: {
      CFBundleDocumentTypes: [
        { CFBundleTypeName: 'Folder', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'None', LSItemContentTypes: ['public.folder'] },
      ],
    },
  },
  dmg: {
    icon: 'assets/icon.icns',
    contents: [
      { x: 140, y: 180, type: 'file' },
      { x: 420, y: 180, type: 'link', path: '/Applications' },
    ],
  },
  win: {
    icon: 'assets/icon.ico',
    target: ['nsis'],
  },
  linux: {
    category: 'Development',
    target: ['AppImage', 'deb'],
    executableName: slug,
    syncDesktopName: true,
    maintainer: `${name} contributors`,
    mimeTypes: ['inode/directory'],
  },
  deb: {
    depends: [
      'libgtk-3-0',
      'libnotify4',
      'libnss3',
      'libxss1',
      'libxtst6',
      'xdg-utils',
      'libatspi2.0-0',
      'libuuid1',
      'libsecret-1-0',
      'libasound2',
    ],
    recommends: ['openssh-client'],
  },
};
