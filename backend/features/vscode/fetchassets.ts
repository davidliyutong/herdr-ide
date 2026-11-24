// `fetch-assets [flags] DIR`: downloads and verifies the code-server
// releases and the extensions machines need into DIR, with a .sha256
// sidecar each, for carrying into an air-gapped network; the core there
// runs with --offline --seed-dir DIR (docs/features/09).
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CORE_BIN } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import { ALL_ASSETS, Artifacts, DEFAULT_EXTENSION_URL, DEFAULT_TARBALL_URL, DEFAULT_VERSION } from './artifacts.ts';

const USAGE = `usage: ${CORE_BIN} fetch-assets [flags] DIR

Downloads and verifies everything machines need, for carrying into an
air-gapped network. Then run: ${CORE_BIN} --offline --seed-dir DIR

  --platforms LIST             code-server builds (default ${ALL_ASSETS.join(',')})
  --code-server-version V      code-server release (default ${DEFAULT_VERSION})
  --code-server-url TEMPLATE   release download ({version}, {asset}, {file}; default ${DEFAULT_TARBALL_URL})
  --extension-url TEMPLATE     VSIX download ({publisher}, {name}, {version}, {file}; default ${DEFAULT_EXTENSION_URL})
  --seed-dir DIR               files already at hand, verified and copied (repeatable)
  --offline                    never download
`;

/** The command's flags (docs/reference.md lists them). */
export const FETCH_ASSETS_OPTIONS = {
  platforms: { type: 'string', default: ALL_ASSETS.join(',') },
  'code-server-version': { type: 'string', default: DEFAULT_VERSION },
  'code-server-url': { type: 'string', default: DEFAULT_TARBALL_URL },
  'extension-url': { type: 'string', default: DEFAULT_EXTENSION_URL },
  'seed-dir': { type: 'string', multiple: true, default: [] as string[] },
  offline: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/** Runs the command; the exit status (0, 1 on failure, 2 for a wrong
 * command line). The files written are printed on out. */
export async function fetchAssets(
  argv: string[],
  o: { logger: Logger; out?: (line: string) => void; err?: (text: string) => void; fetch?: typeof fetch; cacheDir?: string },
): Promise<number> {
  const out = o.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = o.err ?? ((t: string) => void process.stderr.write(t));
  let f;
  try {
    f = parseArgs({ args: argv, options: FETCH_ASSETS_OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    o.logger((e as Error).message);
    err(USAGE);
    return 2;
  }
  if (f.values.help || f.positionals.length !== 1) {
    err(USAGE);
    return 2;
  }
  const dir = f.positionals[0];
  const artifacts = new Artifacts({
    logger: o.logger,
    version: f.values['code-server-version'],
    tarballURL: f.values['code-server-url'],
    extensionURL: f.values['extension-url'],
    seedDirs: f.values['seed-dir'],
    offline: f.values.offline,
    cacheDir: o.cacheDir,
    fetch: o.fetch,
  });
  const { files, error } = await artifacts.fetchAssets(
    dir,
    f.values.platforms
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  );
  for (const file of files) out(join(dir, file));
  if (error) {
    o.logger(error.message);
    return 1;
  }
  return 0;
}
