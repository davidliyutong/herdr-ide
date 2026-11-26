// The machine's downloads (curl, else wget) run without the user's
// configuration files: a .curlrc or .wgetrc that sends the file elsewhere
// or through a proxy that is not there changes nothing (curl -q first, an
// empty WGETRC and GNU wget's --no-config). Against a server on loopback;
// stand-ins of the tools record what they were given.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download, downloadURL } from './artifacts.ts';
import { lookPath } from './programs.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

const tempDir = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'artifacts-')));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

const PAYLOAD = Buffer.from('the payload\n'.repeat(100));
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A server on loopback that answers PAYLOAD. */
function serve(): string {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(PAYLOAD) });
  cleanups.push(() => void server.stop(true));
  return `http://127.0.0.1:${server.port}/x.tgz`;
}

/** A home whose configuration files would send a download nowhere: to
 * /dev/null, through a proxy nothing listens on. */
function hostileHome(): string {
  const home = tempDir();
  writeFileSync(join(home, '.curlrc'), '-o /dev/null\n--proxy http://127.0.0.1:1\n');
  writeFileSync(join(home, '.wgetrc'), 'output_document = /dev/null\nuse_proxy = on\nhttp_proxy = http://127.0.0.1:1/\n');
  return home;
}

/** A directory for PATH holding only the program at real, as name. */
function only(name: string, real: string): string {
  const dir = tempDir();
  symlinkSync(real, join(dir, name));
  return dir;
}

const run = (dir: string, url: string, env: Record<string, string>) =>
  download({ root: join(dir, 'root') }, url, { env, signal: AbortSignal.timeout(30_000), max: 1 << 20, timeoutMs: 30_000 });

describe("the machine's downloads", () => {
  const curl = lookPath('curl');
  const wget = lookPath('wget');

  test('curl reads no .curlrc', async () => {
    const real = await curl;
    if (!real) return;
    const home = hostileHome();
    const s = await run(home, serve(), { HOME: home, PATH: only('curl', real) });
    expect(s.digest).toBe(sha256(PAYLOAD));
    expect(readFileSync(s.file).equals(PAYLOAD)).toBe(true);
  });

  test('wget reads no .wgetrc', async () => {
    const real = await wget;
    if (!real) return;
    const home = hostileHome();
    // Without curl beside it.
    const s = await run(home, serve(), { HOME: home, PATH: only('wget', real) });
    expect(s.digest).toBe(sha256(PAYLOAD));
  });

  // What the tools are given, as stand-ins record it: curl -q first and
  // only http(s), redirects included; wget with an empty WGETRC (a regular
  // file: GNU wget refuses /dev/null), and --no-config when its help says
  // it has it (GNU wget), not otherwise (BusyBox's). The help is read
  // untranslated: the stand-in, like GNU wget's Chinese translation, leaves
  // the line out in another locale.
  const standIn = (name: string, help: string): { dir: string; log: string } => {
    const dir = tempDir();
    const log = join(dir, 'log');
    writeFileSync(
      join(dir, name),
      `#!/bin/sh
if [ "$1" = "--help" ]; then
  if [ "$LC_ALL" = "C" ]; then printf '%s\\n' '${help}'; else printf '%s\\n' 'translated'; fi
  exit 0
fi
printf '%s\\n' "$@" > "${log}.argv"
/usr/bin/env > "${log}.env"
if [ -n "$WGETRC" ] && [ -f "$WGETRC" ] && [ ! -s "$WGETRC" ]; then echo "$WGETRC" > "${log}.rc"; fi
while [ $# -gt 0 ]; do
  case "$1" in -o|-O) shift; printf 'stand-in' > "$1";; esac
  shift
done
exit 0
`,
    );
    chmodSync(join(dir, name), 0o755);
    return { dir, log };
  };

  for (const tc of [
    { name: 'curl', help: '', want: ['-q', '-fsSL', '--retry', '2', '--proto', '=http,https', '--proto-redir', '=http,https', '-o'] },
    { name: 'wget', help: '       --no-config               do not read any config file', want: ['--no-config', '-q', '-O'] },
    { name: 'wget', help: 'BusyBox v1.36.1 multi-call binary.', want: ['-q', '-O'] },
  ])
    test(`${tc.name} ${tc.help ? `(${tc.help.trim().split(' ')[0]})` : ''} is given no configuration`.trim(), async () => {
      const { dir, log } = standIn(tc.name, tc.help);
      const home = hostileHome();
      const url = 'https://mirror.example/npm/x.tgz';
      const s = await run(home, url, { HOME: home, PATH: dir, KEEP: '1', LANG: 'zh_CN.UTF-8', LANGUAGE: 'zh_CN' });
      expect(readFileSync(s.file, 'utf8')).toBe('stand-in');
      const argv = readFileSync(`${log}.argv`, 'utf8').trim().split('\n');
      expect(argv.slice(0, tc.want.length)).toEqual(tc.want);
      expect(argv.slice(-1)).toEqual([url]);
      const env = readFileSync(`${log}.env`, 'utf8');
      // The user's environment otherwise, its locale too.
      expect(env).toContain('KEEP=1');
      expect(env).toContain('LANG=zh_CN.UTF-8');
      expect(env).not.toContain('LC_ALL');
      if (tc.name === 'wget') {
        const rc = readFileSync(`${log}.rc`, 'utf8').trim();
        expect(env).toContain(`WGETRC=${rc}`);
        expect(rc.startsWith(join(home, 'root', '.download-'))).toBe(true);
        // Removed with the download.
        expect(() => readFileSync(rc)).toThrow();
      } else expect(env).not.toContain('WGETRC');
    });

  // A URL with credentials never reaches a command line.
  test('a URL with user information, a query or a fragment is refused before any tool runs', async () => {
    const { dir, log } = standIn('curl', '');
    for (const url of ['https://u:p@mirror.example/x.tgz', 'https://mirror.example/x.tgz?token=t', 'https://mirror.example/x.tgz#f']) {
      let msg = '';
      try {
        await run(tempDir(), url, { PATH: dir });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain('bad download URL');
      expect(msg).not.toMatch(/u:p|token=t|#f/);
    }
    expect(() => readFileSync(`${log}.argv`)).toThrow();
    expect(downloadURL('https://mirror.example/x.tgz').href).toBe('https://mirror.example/x.tgz');
  });

  // What a failed download says names the URL by its origin and path only.
  test("a failure's message names the URL by its origin and path", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'bin'));
    writeFileSync(
      join(dir, 'bin', 'curl'),
      '#!/bin/sh\necho "curl: (22) https://u:s3cret@mirror.example/a?token=t0ken: 403" >&2\nexit 22\n',
    );
    chmodSync(join(dir, 'bin', 'curl'), 0o755);
    let msg = '';
    try {
      await run(dir, 'https://mirror.example/npm/x.tgz', { PATH: join(dir, 'bin') });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('download https://mirror.example/npm/x.tgz: exit status 22');
    expect(msg).toContain('https://mirror.example/a');
    expect(msg).not.toMatch(/s3cret|t0ken/);
  });
});
