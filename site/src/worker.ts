import { DOMAIN } from '../../backend/shared/lib/brand';

export interface SiteEnv {
  ASSETS: { fetch(request: Request | string): Promise<Response> };
  GITHUB_REPO?: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

const INSTALL_ROUTE = '/cli/install.sh';

export function renderInstallScript(rawScript: string, githubRepo?: string): string {
  const repo = githubRepo?.trim();
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return rawScript;
  return rawScript.replace(/^DEFAULT_REPO="[^"]*"$/m, `DEFAULT_REPO="${repo}"`);
}

function withSecurityHeaders(res: Response, extra: Record<string, string> = {}): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export async function handleSiteRequest(request: Request, env: SiteEnv, installScript: string): Promise<Response> {
  const url = new URL(request.url);

  if (url.hostname === `www.${DOMAIN}`) {
    url.hostname = DOMAIN;
    return withSecurityHeaders(Response.redirect(url.toString(), 308));
  }

  if (url.pathname === INSTALL_ROUTE) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return withSecurityHeaders(new Response('Method Not Allowed\n', { status: 405 }), {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      });
    }
    const body = renderInstallScript(installScript, env.GITHUB_REPO);
    return withSecurityHeaders(new Response(request.method === 'HEAD' ? null : body, { status: 200 }), {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    });
  }

  const assetRes = await env.ASSETS.fetch(request);
  return withSecurityHeaders(assetRes);
}
