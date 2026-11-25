// The hub's own outbound HTTP(S) (downloads of machine builds,
// code-server, extensions) goes through the user's proxy: HTTPS_PROXY,
// HTTP_PROXY and NO_PROXY (or their lower-case forms), loopback never. Bun's
// fetch reads them by itself. Node's (the desktop app's hub, in Electron)
// does only when asked: useEnvProxy asks with http.setGlobalProxyFromEnv,
// which sets the proxy of fetch and of the global agents of this process
// alone. No environment variable is set for it (NODE_USE_ENV_PROXY would
// reach every program the hub starts, the local machine's terminals among
// them, and make their Node programs send even their loopback requests to
// the proxy).
import http from 'node:http';

/** What NO_PROXY always holds for the hub: loopback. */
export const LOOPBACK = ['localhost', '.localhost', '127.0.0.1', '::1'];

/** The proxy settings of env (upper or lower case, lower first as curl and
 * Node read them), with loopback added to NO_PROXY; {} without a proxy. */
export function proxyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const get = (k: string) => env[k.toLowerCase()] || env[k] || '';
  const http_ = get('HTTP_PROXY');
  const https_ = get('HTTPS_PROXY');
  if (!http_ && !https_) return {};
  const no = get('NO_PROXY')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const l of LOOPBACK) if (!no.includes(l)) no.push(l);
  return { ...(http_ ? { HTTP_PROXY: http_ } : {}), ...(https_ ? { HTTPS_PROXY: https_ } : {}), NO_PROXY: no.join(',') };
}

/** In Node, sets this process's fetch and global agents to the proxy of
 * env (proxyEnv); whether it did. Bun needs nothing (its fetch reads the
 * environment). */
export function useEnvProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  const set = (http as { setGlobalProxyFromEnv?: (env: Record<string, string>) => unknown }).setGlobalProxyFromEnv;
  if (process.versions.bun || typeof set !== 'function') return false;
  const p = proxyEnv(env);
  if (!p.HTTP_PROXY && !p.HTTPS_PROXY) return false;
  set(p);
  return true;
}
