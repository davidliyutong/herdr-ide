// Checks that docs/reference.md documents every flag of the command line
// (serve's, the settings' flags among them, and fetch-assets') and every
// HTTP route of the core, composed as `serve` composes it
// (hosts/common/compose.ts) with placeholder inputs; run by scripts/check.sh.
//
//   bun scripts/reference.ts            fails, listing what is missing
//   bun scripts/reference.ts --list     prints the flags and routes
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { discard } from '#shared/lib/log.ts';
import { noAudit } from '#kernel/audit.ts';
import { Keybindings } from '#kernel/config/keybindings/index.ts';
import { hubModules } from '#kernel/config/registry.ts';
import { Settings, settingFlags } from '#kernel/config/settings/index.ts';
import { createHub } from '#kernel/hub.ts';
import { Guard } from '#kernel/http/guard.ts';
import { Machines } from '#kernel/machines/manager.ts';
import { Registry } from '#kernel/machines/registry.ts';
import { FETCH_ASSETS_OPTIONS } from '#features/vscode/fetchassets.ts';
import { describedFeatures, hostRoutes } from '#hosts/common/compose.ts';
import { OPTIONS } from '#hosts/bun/serve.ts';

const features = describedFeatures();
const modules = hubModules(features);
const settings = new Settings('', { modules });
const core = createHub({
  guard: new Guard({ allowedOrigins: [], proxySecret: '', logger: discard }),
  audit: noAudit,
  readOnly: false,
  logger: discard,
  machines: new Machines({
    specs: [],
    registry: Registry.memory(),
    logger: discard,
    dial: () => Promise.reject(new Error('no machines')),
  }),
  settings,
  features,
});
hostRoutes(core, { settings, keybindings: new Keybindings(''), readOnly: false, sshLogin: true, web: null })();

const flags = [...new Set([...Object.keys(OPTIONS), ...settingFlags(modules).map((f) => f.name), ...Object.keys(FETCH_ASSETS_OPTIONS)])]
  .filter((f) => f !== 'help')
  .map((f) => `--${f}`);

// A route as the document writes it: `METHOD /path/{param}`; one that
// takes a whole subtree (code-server's proxy, the web UI, the guard of
// every request) as its prefix with a trailing slash and no method.
const routes = [
  ...new Set(
    core.http.app.routes.map(({ method, path }) => {
      const doc = path.replace(/:([A-Za-z_]+)/g, '{$1}');
      if (doc.endsWith('/*')) return doc.slice(0, -1);
      return method === 'ALL' ? doc : `${method} ${doc}`;
    }),
  ),
];

if (process.argv.includes('--list')) {
  console.log([...flags, ...routes].join('\n'));
  process.exit(0);
}

const doc = readFileSync(join(REPO_ROOT, 'docs/reference.md'), 'utf8');
const lines = doc.split('\n');
const quoted = (s: string) => doc.includes(`\`${s}\``);
// A route may also be one of a group's: `METHOD /prefix/{name}` on a row
// that names its last segment in backticks.
const documented = (route: string) => {
  if (quoted(route)) return true;
  const slash = route.lastIndexOf('/');
  const group = route.slice(0, slash);
  const last = route.slice(slash + 1);
  return lines.some((l) => l.includes(`| \`${group}/{`) && l.includes(`\`${last}\``));
};

const missing = [
  ...flags.filter((f) => !quoted(f)).map((f) => `flag ${f} missing from docs/reference.md`),
  ...routes.filter((r) => !documented(r)).map((r) => `endpoint ${r} missing from docs/reference.md`),
];
if (routes.length < 20) missing.push(`found only ${routes.length} routes`);
if (flags.length < 20) missing.push(`found only ${flags.length} flags`);
for (const m of missing) console.log(m);
process.exit(missing.length ? 1 : 0);
