import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOMAIN, SLUG } from '../../backend/shared/lib/brand';
import { handleSiteRequest, renderInstallScript, type SiteEnv } from './worker';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const INSTALL_SH_PATH = join(REPO_ROOT, 'scripts', 'install.sh');
const PUBLIC_DIR = join(import.meta.dir, '..', 'public');
const INDEX_HTML_PATH = join(PUBLIC_DIR, 'index.html');
const COPY_JS_PATH = join(PUBLIC_DIR, 'copy.js');
const STYLE_CSS_PATH = join(PUBLIC_DIR, 'style.css');
const WRANGLER_PATH = join(import.meta.dir, '..', 'wrangler.jsonc');

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

async function runInstall(args: string[], env: Record<string, string | undefined>) {
  const proc = Bun.spawn(['/bin/sh', INSTALL_SH_PATH, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
}

function fakeEnv(githubRepo?: string): SiteEnv {
  const html = readFileSync(INDEX_HTML_PATH, 'utf8');
  const js = readFileSync(COPY_JS_PATH, 'utf8');
  const css = readFileSync(STYLE_CSS_PATH, 'utf8');
  return {
    GITHUB_REPO: githubRepo,
    ASSETS: {
      async fetch(req) {
        const u = new URL(typeof req === 'string' ? req : req.url);
        if (u.pathname === '/' || u.pathname === '/index.html') {
          return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        if (u.pathname === '/copy.js') {
          return new Response(js, { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
        }
        if (u.pathname === '/style.css') {
          return new Response(css, { status: 200, headers: { 'Content-Type': 'text/css; charset=utf-8' } });
        }
        return new Response('Not Found', { status: 404 });
      },
    },
  };
}

function expectAllSecurityHeaders(res: Response) {
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
  const csp = res.headers.get('Content-Security-Policy') ?? '';
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("style-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-inline');
}

describe('veldr.app worker routes', () => {
  const rawInstall = readFileSync(INSTALL_SH_PATH, 'utf8');

  test('wrangler.jsonc routes all asset requests through the worker first', () => {
    const raw = readFileSync(WRANGLER_PATH, 'utf8');
    // Strip trailing commas (JSONC) before parsing.
    const parsed = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')) as {
      workers_dev?: boolean;
      assets?: { run_worker_first?: unknown };
    };
    expect(parsed.assets?.run_worker_first).toBe(true);
    expect(parsed.workers_dev).toBe(false);
  });

  test('serves the shared install.sh at /cli/install.sh for GET and HEAD', async () => {
    const res = await handleSiteRequest(new Request(`https://${DOMAIN}/cli/install.sh`), fakeEnv(), rawInstall);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expectAllSecurityHeaders(res);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    const text = await res.text();
    expect(text).toBe(rawInstall);

    const head = await handleSiteRequest(new Request(`https://${DOMAIN}/cli/install.sh`, { method: 'HEAD' }), fakeEnv(), rawInstall);
    expect(head.status).toBe(200);
    expectAllSecurityHeaders(head);
    expect(await head.text()).toBe('');

    const post = await handleSiteRequest(new Request(`https://${DOMAIN}/cli/install.sh`, { method: 'POST' }), fakeEnv(), rawInstall);
    expect(post.status).toBe(405);
    expectAllSecurityHeaders(post);
    expect(post.headers.get('Allow')).toBe('GET, HEAD');
  });

  test('allows overriding GITHUB_REPO via Worker environment variables safely', () => {
    const overridden = renderInstallScript(rawInstall, 'acme/custom-repo');
    expect(overridden).toContain('DEFAULT_REPO="acme/custom-repo"');
    // Rejects malformed repo strings and leaves default intact.
    expect(renderInstallScript(rawInstall, 'bad/../repo')).toBe(rawInstall);
  });

  test('redirects www.<domain> on / and /cli/install.sh to apex with security headers', async () => {
    for (const path of ['/', '/cli/install.sh?x=1']) {
      const redir = await handleSiteRequest(new Request(`https://www.${DOMAIN}${path}`), fakeEnv(), rawInstall);
      expect(redir.status).toBe(308);
      expect(redir.headers.get('Location')).toBe(`https://${DOMAIN}${path}`);
      expectAllSecurityHeaders(redir);
    }

    const home = await handleSiteRequest(new Request(`https://${DOMAIN}/`), fakeEnv(), rawInstall);
    expect(home.status).toBe(200);
    expectAllSecurityHeaders(home);
    const html = await home.text();
    expect(html).toContain('/cli/install.sh');
    expect(html).toContain('src="/copy.js"');
    expect(html).toContain('href="/style.css"');
    expect(html).not.toMatch(/<script(?:\s[^>]*)?>\s*[^<]/i);
    expect(html).not.toMatch(/<style[\s>]/i);

    const js = await handleSiteRequest(new Request(`https://${DOMAIN}/copy.js`), fakeEnv(), rawInstall);
    expect(js.status).toBe(200);
    expectAllSecurityHeaders(js);
    expect(await js.text()).toContain('copy-btn');

    const css = await handleSiteRequest(new Request(`https://${DOMAIN}/style.css`), fakeEnv(), rawInstall);
    expect(css.status).toBe(200);
    expectAllSecurityHeaders(css);
  });
});

describe.skipIf(process.platform === 'win32')('shared CLI install.sh execution', () => {
  test('installs verified CLI archive from a release server and rejects tampered digests', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cli-install-test-'));
    const platform = 'linux-amd64';
    const fakeCli = `#!/bin/sh\nif [ "\${1:-}" = "version" ]; then echo "${SLUG} v0.6.0-test"; exit 0; fi\nexit 0\n`;
    const member = `${SLUG}-${platform}/${SLUG}`;
    const archiveName = `${SLUG}-${platform}.tar.gz`;
    const validArchive = await new Bun.Archive({ [member]: fakeCli }, { compress: 'gzip' }).bytes();
    const validSums = `${sha256(validArchive)}  ${archiveName}\n${sha256(fakeCli)}  ${member}\n`;

    let mode: 'valid' | 'bad-archive' | 'bad-exe' = 'valid';
    const seenPaths: string[] = [];

    const srv = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const p = new URL(req.url).pathname;
        seenPaths.push(p);
        if (p.endsWith('/SHA256SUMS')) {
          if (mode === 'bad-archive') return new Response(`${'0'.repeat(64)}  ${archiveName}\n${sha256(fakeCli)}  ${member}\n`);
          if (mode === 'bad-exe') return new Response(`${sha256(validArchive)}  ${archiveName}\n${'f'.repeat(64)}  ${member}\n`);
          return new Response(validSums);
        }
        if (p.endsWith(`/${archiveName}`)) return new Response(validArchive);
        return new Response('not found', { status: 404 });
      },
    });

    try {
      const binDir = join(tmp, 'bin');
      const baseEnv: Record<string, string | undefined> = {
        ...process.env,
        HOME: tmp,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        VELDR_GITHUB_URL: `http://127.0.0.1:${srv.port}`,
        VELDR_TEST_OS: 'Linux',
        VELDR_TEST_ARCH: 'x86_64',
      };

      // 1. Latest release install succeeds and sets 0755.
      const ok = await runInstall(['--bin-dir', binDir], baseEnv);
      expect(ok.exitCode).toBe(0);
      expect(seenPaths).toContain(`/davidliyutong/${SLUG}/releases/latest/download/SHA256SUMS`);
      const installed = join(binDir, SLUG);
      expect(existsSync(installed)).toBe(true);
      expect(statSync(installed).mode & 0o777).toBe(0o755);
      expect(ok.stdout).toContain(`${SLUG} v0.6.0-test`);

      // 2. Explicit --version normalizes bare semver to v<semver>.
      seenPaths.length = 0;
      const pinned = await runInstall(['--version', '0.6.0', '--bin-dir', binDir], baseEnv);
      expect(pinned.exitCode).toBe(0);
      expect(seenPaths).toContain(`/davidliyutong/${SLUG}/releases/download/v0.6.0/SHA256SUMS`);

      // 3. Tampered archive digest is rejected without touching target directory.
      const badDir1 = join(tmp, 'bad1');
      mode = 'bad-archive';
      const bad1 = await runInstall(['--bin-dir', badDir1], baseEnv);
      expect(bad1.exitCode).not.toBe(0);
      expect(bad1.stderr).toContain('SHA-256 mismatch');
      expect(existsSync(join(badDir1, SLUG))).toBe(false);

      // 4. Tampered inner executable digest is rejected without installing.
      const badDir2 = join(tmp, 'bad2');
      mode = 'bad-exe';
      const bad2 = await runInstall(['--bin-dir', badDir2], baseEnv);
      expect(bad2.exitCode).not.toBe(0);
      expect(bad2.stderr).toContain('SHA-256 mismatch');
      expect(existsSync(join(badDir2, SLUG))).toBe(false);
    } finally {
      await srv.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('wget fallback checks exit status, blocks HTTPS->HTTP redirects, and stages safely', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cli-install-wget-'));
    try {
      // Build a PATH directory with POSIX tools + our fake wget, without curl.
      const fakeBin = join(tmp, 'fakebin');
      mkdirSync(fakeBin, { recursive: true });
      for (const tool of [
        'sh',
        'awk',
        'sed',
        'grep',
        'head',
        'wc',
        'tr',
        'cut',
        'cat',
        'mkdir',
        'chmod',
        'mv',
        'rm',
        'mktemp',
        'tar',
        // GNU gunzip on Linux is a /bin/sh wrapper that execs gzip via PATH.
        'gzip',
        'gunzip',
        'uname',
        'sha256sum',
        'shasum',
        'openssl',
      ]) {
        for (const dir of ['/usr/bin', '/bin']) {
          const p = join(dir, tool);
          if (existsSync(p)) {
            symlinkSync(p, join(fakeBin, tool));
            break;
          }
        }
      }

      // Case 1: wget writes partial stdout and exits non-zero -> must fail (not masked by head).
      const wgetPath = join(fakeBin, 'wget');
      writeFileSync(
        wgetPath,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "GNU Wget 1.25"; exit 0; fi
if [ "$1" = "--help" ]; then echo "  --no-config  -S"; exit 0; fi
printf 'partial-data'
exit 8
`,
      );
      chmodSync(wgetPath, 0o755);

      const baseEnv: Record<string, string | undefined> = {
        HOME: tmp,
        PATH: fakeBin,
        VELDR_RELEASE_URL: 'https://releases.example.test/v0.6.0',
        VELDR_TEST_OS: 'Linux',
        VELDR_TEST_ARCH: 'x86_64',
      };
      const failDir = join(tmp, 'fail');
      const partialFail = await runInstall(['--bin-dir', failDir], baseEnv);
      expect(partialFail.exitCode).not.toBe(0);
      expect(partialFail.stderr).toContain('failed to download');
      expect(existsSync(join(failDir, SLUG))).toBe(false);

      // Case 2: wget sees an HTTPS -> HTTP redirect -> must refuse downgrade before using output.
      writeFileSync(
        wgetPath,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "GNU Wget 1.25"; exit 0; fi
if [ "$1" = "--help" ]; then echo "  --no-config  -S"; exit 0; fi
printf '  HTTP/1.1 302 Found\r\n  Location: http://evil.example.test/SHA256SUMS\r\n' >&2
exit 8
`,
      );
      chmodSync(wgetPath, 0o755);

      const downDir = join(tmp, 'downgrade');
      const downRes = await runInstall(['--bin-dir', downDir], baseEnv);
      expect(downRes.exitCode).not.toBe(0);
      expect(downRes.stderr).toContain('refused non-HTTPS redirect');
      expect(existsSync(join(downDir, SLUG))).toBe(false);

      // Case 3: wget follows an allowed redirect and installs safely via mktemp staging.
      const platform = 'linux-amd64';
      const fakeCli = `#!/bin/sh\nif [ "\${1:-}" = "version" ]; then echo "${SLUG} v0.6.0-wget"; exit 0; fi\nexit 0\n`;
      const member = `${SLUG}-${platform}/${SLUG}`;
      const archiveName = `${SLUG}-${platform}.tar.gz`;
      const validArchive = await new Bun.Archive({ [member]: fakeCli }, { compress: 'gzip' }).bytes();
      const validSums = `${sha256(validArchive)}  ${archiveName}\n${sha256(fakeCli)}  ${member}\n`;
      const sumsFile = join(tmp, 'sums');
      const archFile = join(tmp, 'arch.tar.gz');
      writeFileSync(sumsFile, validSums);
      writeFileSync(archFile, validArchive);

      writeFileSync(
        wgetPath,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "GNU Wget 1.25"; exit 0; fi
if [ "$1" = "--help" ]; then echo "  --no-config  -S"; exit 0; fi
url=""
for a in "$@"; do url="$a"; done
case "$url" in
  https://releases.example.test/*/SHA256SUMS)
    printf '  HTTP/1.1 302 Found\r\n  Location: https://cdn.example.test/SHA256SUMS\r\n' >&2
    exit 8
    ;;
  https://cdn.example.test/SHA256SUMS)
    printf '  HTTP/1.1 200 OK\r\n' >&2
    cat "${sumsFile}"
    exit 0
    ;;
  https://releases.example.test/*/${archiveName})
    printf '  HTTP/1.1 200 OK\r\n' >&2
    cat "${archFile}"
    exit 0
    ;;
  *)
    exit 8
    ;;
esac
`,
      );
      chmodSync(wgetPath, 0o755);

      const okDir = join(tmp, 'ok-wget');
      const okRes = await runInstall(['--bin-dir', okDir], baseEnv);
      expect(okRes.stderr).toBe('');
      expect(okRes.exitCode).toBe(0);
      expect(okRes.stdout).toContain(`${SLUG} v0.6.0-wget`);
      expect(existsSync(join(okDir, SLUG))).toBe(true);
      expect(statSync(join(okDir, SLUG)).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
