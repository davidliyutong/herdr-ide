// The internal `term-env` trampoline invoked by herdr-core for a terminal
// with staged vault environment variables: fetches and consumes the one-time
// payload over <run>/env.sock (in the directory of HC_TERMINAL_SOCKET), merges
// it over the inherited environment and execve's the target shell or command
// in place without leaving a wrapper process or writing secrets to disk.
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { posix } from 'node:path';
import { userHomeDir } from '#shared/host/hostdirs.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { readLine, writeLine } from '#shared/proto/agentproto/index.ts';
import { SysError } from '#machine/sys/libc.ts';
import { execReplace } from '#machine/sys/exec.ts';
import { TERM_ENV_SOCK, type TermEnvReply } from '#machine/termenv.ts';

const DIAL_TIMEOUT_MS = 5000;

/** Default shell matching herdr-core's config.toml `shell` and platform fallback. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const cfgBase = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : posix.join(userHomeDir(), '.config');
    const raw = readFileSync(posix.join(cfgBase, 'herdr-core', 'config.toml'), 'utf8');
    const parsed = Bun.TOML.parse(raw) as { shell?: unknown };
    if (
      Array.isArray(parsed.shell) &&
      parsed.shell.length > 0 &&
      parsed.shell.every((s): s is string => typeof s === 'string') &&
      parsed.shell[0] !== ''
    ) {
      return parsed.shell;
    }
  } catch {
    // no config.toml or no valid shell override
  }
  const sh = env.SHELL && env.SHELL !== '' ? env.SHELL : '/bin/sh';
  return process.platform === 'darwin' ? [sh, '-l'] : [sh];
}

export function resolveTargetCommand(reply: TermEnvReply, env: NodeJS.ProcessEnv = process.env): string[] {
  if (reply.argv && reply.argv.length > 0) return reply.argv;
  if (typeof reply.line === 'string') return ['sh', '-c', reply.line];
  return defaultShell(env);
}

async function fetchStagedEnv(sockPath: string, token: string): Promise<TermEnvReply> {
  const c = connect(sockPath);
  const timer = setTimeout(() => c.destroy(new Error('timed out')), DIAL_TIMEOUT_MS);
  try {
    await new Promise<void>((res, rej) => c.once('connect', res).once('error', rej));
    await writeLine(c, { token });
    return await readLine<TermEnvReply>(new Reader(c));
  } finally {
    clearTimeout(timer);
    c.destroy();
  }
}

export async function termEnvCommand(argv: string[]): Promise<number> {
  const token = argv[0] ?? '';
  if (!/^[0-9a-f]{48}$/.test(token)) {
    process.stderr.write('term-env: invalid token\n');
    return 2;
  }
  const hcSock = process.env.HC_TERMINAL_SOCKET ?? '';
  if (!hcSock) {
    process.stderr.write('term-env: missing HC_TERMINAL_SOCKET\n');
    return 126;
  }
  const sockPath = posix.join(posix.dirname(hcSock), TERM_ENV_SOCK);
  let reply: TermEnvReply;
  try {
    reply = await fetchStagedEnv(sockPath, token);
  } catch (e) {
    process.stderr.write(`term-env: ${(e as Error).message}\n`);
    return 126;
  }
  if (!reply.ok || !reply.env) {
    process.stderr.write('term-env: terminal environment expired or unavailable\n');
    return 126;
  }
  const cmd = resolveTargetCommand(reply, process.env);
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') merged[k] = v;
  for (const [k, v] of Object.entries(reply.env)) {
    merged[k] = v;
    reply.env[k] = '';
  }
  try {
    execReplace(cmd, merged);
  } catch (e) {
    process.stderr.write(`term-env: ${(e as Error).message}\n`);
    return e instanceof SysError && e.code === 'ENOENT' ? 127 : 126;
  }
}
