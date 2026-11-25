// Prints the part of THIRD_PARTY_NOTICES.md for the npm packages the core's
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
out.push('## The core in TypeScript (backend/)', '');
out.push(
  "The core's executable built from backend/ is the Bun runtime (https://github.com/oven-sh/bun, MIT; its LICENSE.md lists the libraries it includes, JavaScriptCore among them, LGPL-2.0) with the core's code and the npm packages below bundled. The desktop app runs the same core in Electron, with node-pty (and node-addon-api, which it is built with) beside it in the app. In the TypeScript build (backend/scripts/build.ts --machine ts) the same executable is also the machine side of its platform and carries that platform's herdr-core (Apache-2.0; its license and notices are in licenses/herdr-core/ of the release archive).",
);
for (const pkg of pkgs) {
  const dir = pkg.paths[0];
  const lic = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  out.push('', `### ${pkg.name} ${pkg.versions.join(', ')} (${pkg.license})`, '');
  if (lic) out.push('```text', readFileSync(join(dir, lic), 'utf8').replace(/\r\n?/g, '\n').trimEnd(), '```');
  else out.push('No license file found in the package.');
}
console.log(out.join('\n'));
