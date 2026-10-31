const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// Packaging reads the same brand definitions imported by the launcher.
const source = readFileSync(join(__dirname, '../web/src/brand.ts'), 'utf8');
function brand(key) {
  const value = source.match(new RegExp(`export const ${key} = '([^']+)'`))?.[1];
  if (!value) throw new Error(`Missing brand constant: ${key}`);
  return value;
}
const slug = brand('APP_SLUG');
const name = brand('APP_NAME');
const arch = process.env.DESKTOP_ARCH || process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);
const goArch = arch === 'x64' ? 'amd64' : 'arm64';

module.exports = {
  appId: `dev.${slug}.desktop`,
  productName: name,
  artifactName: '${productName}-${version}-mac-${arch}.${ext}',
  directories: { output: '../dist/desktop' },
  files: ['dist/main.cjs', 'package.json'],
  extraMetadata: {
    name: `${slug}-desktop`,
    version: process.env.VERSION || require('./package.json').version,
  },
  extraResources: [
    { from: `../dist/${slug}-darwin-${goArch}`, to: `bin/${slug}` },
    { from: '../LICENSE', to: 'LICENSE' },
    { from: '../THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
  ],
  asar: true,
  npmRebuild: false,
  mac: {
    icon: 'assets/icon.icns',
    category: 'public.app-category.developer-tools',
    target: ['dmg'],
    identity: '-',
    notarize: false,
    hardenedRuntime: true,
  },
  dmg: {
    icon: 'assets/icon.icns',
    contents: [
      { x: 140, y: 180, type: 'file' },
      { x: 420, y: 180, type: 'link', path: '/Applications' },
    ],
  },
};
