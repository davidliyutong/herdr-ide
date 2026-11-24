const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
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
const goArch = arch === 'x64' ? 'amd64' : 'arm64';
// The core scripts/build.sh built for a platform (Go's names), placed at
// bin/<slug> in the app's resources, outside ASAR.
const goos = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
const exe = (platform) => (platform === 'win32' ? '.exe' : '');
const coreOf = (platform) => `../dist/${slug}-${goos[platform]}-${goArch}${exe(platform)}`;
const core = (platform) => [{ from: coreOf(platform), to: `bin/${slug}${exe(platform)}` }];
// macOS: the Secure Enclave helper, a universal app bundle helper/build.mjs
// made in dist/helper, placed in the app's Contents/Helpers (src/enclave.ts
// helperPath), where signing the app signs it with the hardened runtime.
// Only a Mac builds it (swiftc): a macOS --dir app packaged elsewhere, to
// check the packaging, goes without.
const helper = `${name} Enclave.app`;
const helperOf = `dist/helper/${helper}`;
const withHelper = process.platform === 'darwin';
// macOS: a Developer ID signature when the signing step has a certificate
// (CSC_LINK, or CSC_NAME of the keychain's), notarized with APPLE_ID,
// APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID; ad hoc otherwise.
const developerId = !!(process.env.CSC_LINK || process.env.CSC_NAME);

// The project's page, which a Debian package names: the repository the
// release workflow runs in, else this checkout's origin.
function homepage() {
  if (process.env.GITHUB_REPOSITORY) return `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}`;
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: __dirname, encoding: 'utf8' }).trim();
    return url.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '') || undefined;
  } catch {
    return undefined;
  }
}

module.exports = {
  appId,
  productName: name,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  directories: { output: '../dist/desktop' },
  files: ['dist/main.cjs', 'dist/preload.cjs', 'assets/icon.png', 'package.json'],
  extraMetadata: {
    name: `${slug}-desktop`,
    // Release tags (vX.Y.Z) stay as is in the core; app metadata takes semver.
    version: (process.env.VERSION || require('./package.json').version).replace(/^v/, ''),
    homepage: homepage(),
    // Linux: Electron's app id (Wayland) and window class (X11), the name of
    // the desktop entry (linux.syncDesktopName) and of its launcher badge.
    desktopName: `${slug}.desktop`,
  },
  extraResources: [
    // Written by scripts/fetch-hc from the herdr-core release the core embeds.
    { from: '../dist/hc/licenses', to: 'licenses/herdr-core' },
    { from: '../licenses/herdr-detect', to: 'licenses/herdr-detect' },
    { from: '../licenses/encoder', to: 'licenses/encoder' },
    { from: '../LICENSE', to: 'LICENSE' },
    { from: '../THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
    { from: '../web/dist/licenses.md', to: 'licenses.md' },
  ],
  // The core is built for DESKTOP_ARCH and the platform being packaged;
  // refuse to put it into an Electron app for another architecture (e.g. a
  // manual --x64 run) or package without it.
  beforePack: async (context) => {
    const packing = Arch[context.arch];
    if (packing !== arch) {
      throw new Error(`Packaging ${packing} with ${goArch} binaries; set DESKTOP_ARCH=${packing} (scripts/desktop.sh does)`);
    }
    const needed = [coreOf(context.electronPlatformName), '../dist/hc/licenses/LICENSE', '../web/dist/licenses.md'];
    if (context.electronPlatformName === 'darwin' && withHelper) needed.push(`${helperOf}/Contents/MacOS/${name} Enclave`);
    for (const file of needed) {
      if (!existsSync(join(__dirname, file))) throw new Error(`Missing ${file}; build it with scripts/desktop.sh`);
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
    extraResources: core('darwin'),
    extraFiles: withHelper ? [{ from: helperOf, to: `Helpers/${helper}` }] : [],
    // Folders dropped on the Dock icon become workspaces (src/folders.ts). Rank
    // None: the app accepts dropped folders but never becomes their opener.
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
  // A per-user installer (no administrator rights), unsigned.
  win: {
    icon: 'assets/icon.ico',
    target: ['nsis'],
    extraResources: core('win32'),
  },
  // Linux takes its icon sizes (16 to 1024 px) from the ICNS.
  linux: {
    category: 'Development',
    target: ['AppImage', 'deb'],
    executableName: slug,
    syncDesktopName: true,
    maintainer: `${name} contributors`,
    // Offered in file managers' Open With for folders, which become
    // workspaces on the local machine (src/platform.ts foldersOf).
    mimeTypes: ['inode/directory'],
    extraResources: core('linux'),
  },
  deb: {
    // electron-builder's defaults and ALSA, which Electron links and a
    // minimal system lacks (libasound2t64 provides it on newer releases).
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
    // SSH machines need the OpenSSH client.
    recommends: ['openssh-client'],
  },
};
