import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOMAIN, SLUG } from '../../backend/shared/lib/brand';
import { handleSiteRequest, renderInstallScript, type SiteEnv } from './worker';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const INSTALL_SH_PATH = join(REPO_ROOT, 'scripts', 'install.sh');
const INDEX_HTML_PATH = join(import.meta.dir, '..', 'public', 'index.html');

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
  return {
    GITHUB_REPO: githubRepo,
    ASSETS: {
      async fetch(req) {
        const u = new URL(typeof req === 'string' ? req : req.url);
        if (u.pathname === '/' || u.pathname === '/index.html') {
          return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        return new Response('Not Found', { status: 404 });
      },
    },
  };
}

describe('veldr.app worker routes', () => {
  const rawInstall = readFileSync(INSTALL_SH_PATH, 'utf8');

  test('serves the shared install.sh at /cli/install.sh for GET and HEAD', async () => {
    const res = await handleSiteRequest(new Request(`https://${DOMAIN}/cli/install.sh`), fakeEnv(), rawInstall);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    const text = await res.text();
    expect(text).toBe(rawInstall);

    const head = await handleSiteRequest(new Request(`https://${DOMAIN}/cli/install.sh`, { method: 'HEAD' }), fakeEnv(), rawInstall);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');

    const post = await handleSiteRequest(new Request(`https://${DOMAIN}/cli/install.sh`, { method: 'POST' }), fakeEnv(), rawInstall);
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toBe('GET, HEAD');
  });

  test('allows overriding GITHUB_REPO via Worker environment variables safely', () => {
    const overridden = renderInstallScript(rawInstall, 'acme/custom-repo');
    expect(overridden).toContain('DEFAULT_REPO="acme/custom-repo"');
    // Rejects malformed repo strings and leaves default intact.
    expect(renderInstallScript(rawInstall, 'bad/../repo')).toBe(rawInstall);
  });

  test('redirects www.<domain> to apex and delegates static assets with security headers', async () => {
    const redir = await handleSiteRequest(new Request(`https://www.${DOMAIN}/cli/install.sh?x=1`), fakeEnv(), rawInstall);
    expect(redir.status).toBe(308);
    expect(redir.headers.get('Location')).toBe(`https://${DOMAIN}/cli/install.sh?x=1`);

    const home = await handleSiteRequest(new Request(`https://${DOMAIN}/`), fakeEnv(), rawInstall);
    expect(home.status).toBe(200);
    expect(home.headers.get('X-Frame-Options')).toBe('DENY');
    expect(await home.text()).toContain(`/cli/install.sh`);
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
});
