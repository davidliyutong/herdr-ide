// Prints the part of THIRD_PARTY_NOTICES.md for the npm packages the hub's
// executable bundles (the backend's production dependencies, with what
// they depend on) and for the runtime it is built with (scripts/notices.sh
// writes the file).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Pkg {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
}

const p = Bun.spawnSync(['pnpm', 'licenses', 'list', '--prod', '--json'], { cwd: join(import.meta.dir, '..'), stderr: 'inherit' });
if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
const byLicense = JSON.parse(p.stdout.toString()) as Record<string, Omit<Pkg, 'license'>[]>;
const pkgs: Pkg[] = Object.entries(byLicense)
  .flatMap(([license, list]) => list.map((x) => ({ ...x, license })))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const out: string[] = [];
out.push('## The hub in TypeScript (backend/)', '');
out.push(
  "The hub's executable built from backend/ is the Bun runtime (https://github.com/oven-sh/bun, MIT; its LICENSE.md lists the libraries it includes, JavaScriptCore among them, LGPL-2.0) with the hub's code and the npm packages below bundled. Both the command line and the desktop app run this Stage 1 compiled executable (`serve` and `desktop`), which on Linux and macOS is also the machine side of its platform (`node`) and carries that platform's herdr-core (Apache-2.0; its license and notices are in licenses/herdr-core/ of the release archive).",
);
// The licenses of packages that a package's own build bundles into its
// files without their license texts (the MCP server SDK's validators), as
// their packages declare them: a bundled package that is not here fails
// the script, so an upgrade that bundles another one is noticed.
const BUNDLED_LICENSES: Record<string, string> = {
  '@cfworker/json-schema': 'MIT',
  ajv: 'MIT',
  'ajv-formats': 'MIT',
  'content-type': 'MIT',
  'fast-deep-equal': 'MIT',
  'fast-uri': 'BSD-3-Clause',
  'json-schema-traverse': 'MIT',
};

/** The packages bundled into dir's dist/ (name@version), from the region
 * comments its bundler leaves (//#region ../../node_modules/.pnpm/…). */
function bundledIn(dir: string): string[] {
  const found = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(join(dir, 'dist')).filter((f) => f.endsWith('.mjs'));
  } catch {
    return [];
  }
  for (const f of files) {
    const re = /\/\/#region \S*node_modules\/\.pnpm\/[^/\s]+\/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g;
    const text = readFileSync(join(dir, 'dist', f), 'utf8');
    for (const m of text.matchAll(re)) {
      const at = text.lastIndexOf('.pnpm/', m.index! + m[0].length);
      const spec = text.slice(at + 6, text.indexOf('/', at + 6)); // ajv-formats@3.0.1_ajv@8.18.0
      const version = /@([^@_]+)(?:_|$)/.exec(spec.startsWith('@') ? spec.slice(1) : spec)?.[1] ?? '';
      found.add(`${m[1]} ${version}`);
    }
  }
  return [...found].sort();
}

for (const pkg of pkgs) {
  const dir = pkg.paths[0];
  const lic = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  out.push('', `### ${pkg.name} ${pkg.versions.join(', ')} (${pkg.license})`, '');
  if (lic) out.push('```text', readFileSync(join(dir, lic), 'utf8').replace(/\r\n?/g, '\n').trimEnd(), '```');
  else out.push('No license file found in the package.');
  const bundled = bundledIn(dir);
  if (bundled.length > 0) {
    const named = bundled.map((b) => {
      const name = b.slice(0, b.lastIndexOf(' '));
      const license = BUNDLED_LICENSES[name];
      if (!license) throw new Error(`${pkg.name} bundles ${name}, whose license scripts/notices.ts does not name`);
      return `${b} (${license})`;
    });
    out.push('', `Its files bundle, without their license texts: ${named.join(', ')}.`);
  }
}
console.log(out.join('\n'));
