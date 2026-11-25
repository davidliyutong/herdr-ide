// The variable vault's MCP server: the mcp command of the machine side
// (hosts/machine/cli.ts), which a coding agent's CLI (Claude Code, Codex…)
// starts on a machine and speaks to over stdio (JSON-RPC 2.0, one message
// per line). It asks the hub for variables through the agent's
// <run>/vault.sock, which relays each connection to the hub (op vault,
// #machine/vault.ts); the hub decides what the machine may read
// (docs/features/30-variable-vault.md). The Go build of earlier releases
// answered the same.
//
// The protocol is the official MCP TypeScript SDK's
// (@modelcontextprotocol/server): its stdio transport, the handshake and
// its version negotiation, ping, "method not found" for what is not served,
// and the client's notifications/cancelled, which aborts the call (its
// request to the hub is closed, which the hub takes as a denial; its
// command is killed) and leaves it unanswered. The tools are the low-level
// Server's handlers, so that their definitions and refusals are the Go
// server's to the byte: a call with arguments a tool does not take is
// refused with "invalid params" (-32602), never run.
import { connect, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { ProtocolError, ProtocolErrorCode, Server, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { NAME, SLUG } from '#shared/lib/brand.ts';
import { Reader, writeLine } from '#shared/lib/streamio.ts';
import { VERSION, VaultTool, type VaultRequest, type VaultResponse } from '#shared/proto/agentproto/index.ts';
import { runWithEnv, withHub, type RunLimits } from './run.ts';

/** The server's name in MCP (serverInfo) and the name the setup guide gives
 * it in the CLIs' configurations. */
export const SERVER_NAME = `${SLUG}-vault`;
/** The longest line taken from the client. */
export const MAX_LINE = 4 << 20;
/** Bounds the hub's answer (values of up to 64 variables). */
const MAX_RESPONSE = 32 << 20;

const INSTRUCTIONS =
  `Environment variables (API keys, tokens) kept in ${NAME}'s vault. ` +
  'Prefer run_with_env, which runs a command with the variables set and keeps their values out of the conversation; ' +
  "use get_variable only when a value itself is needed. A request may wait for the user's approval.";

const STR = { type: 'string' };

/** The tools, as the Go server lists them. */
export const TOOLS: Tool[] = [
  {
    name: 'list_variables',
    description:
      "List the vault's variables: name, description, whether the value can only be injected into a command (inject_only), and whether reading it from this machine asks the user first (approval). Values are not listed.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_variable',
    description: "Return a variable's value. The value enters the conversation; prefer run_with_env. Refused for inject-only variables.",
    inputSchema: { type: 'object', properties: { name: STR }, required: ['name'] },
  },
  {
    name: 'run_with_env',
    description:
      "Run a shell command (sh -c) with the named variables in its environment, and return its exit status and output (stdout and stderr, at most 64 KiB unless the vault's settings say otherwise). " +
      "Occurrences of the values in the output are replaced with ***. The default and longest timeouts are the vault's settings (120 s and 600 s unless changed).",
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command, run by sh -c.' },
        names: { type: 'array', items: STR, description: 'The variables to set.' },
        cwd: { type: 'string', description: "Working directory (default: the server's)." },
        timeout: {
          type: 'integer',
          description: "Seconds (by default the vault's setting, 120 unless changed; at most its longest, 600 unless changed).",
        },
      },
      required: ['command', 'names'],
    },
  },
];

/** What the server needs from outside. */
export interface McpOptions {
  /** Connects to the agent's vault socket. */
  dial(signal: AbortSignal): Promise<Socket>;
  /** Who asks, shown to the user who approves (not trusted): the CLI's
   * process name and the terminal it runs in. */
  client?: string;
  terminal?: string;
  /** The working directory a request names when the call names none. */
  cwd?: () => string;
  /** run_with_env's bounds before the hub's (tests). */
  limits?: RunLimits;
  /** How long a command's output may stay open after its shell exited. */
  waitDelayMs?: number;
}

/** A connection to the socket at path. */
export function dialSocket(path: string): (signal: AbortSignal) => Promise<Socket> {
  return (signal) =>
    new Promise((resolve, reject) => {
      const c = connect(path);
      const fail = (e: Error) => {
        c.destroy();
        reject(e);
      };
      const abort = () => fail(new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      c.once('error', fail);
      c.once('connect', () => {
        signal.removeEventListener('abort', abort);
        c.off('error', fail);
        c.on('error', () => {});
        resolve(c);
      });
    });
}

class Refused extends Error {}

/** Sends one request to the hub through the agent's socket. A refusal or
 * an agent that does not answer is an error whose text the model reads. */
export async function ask(o: McpOptions, req: VaultRequest, signal: AbortSignal): Promise<VaultResponse> {
  req = { ...req, client: o.client ?? '', terminal: o.terminal ?? '' };
  if (!req.cwd) req.cwd = (o.cwd ?? (() => process.cwd()))();
  let c: Socket;
  try {
    c = await o.dial(signal);
  } catch (e) {
    throw new Refused(`unavailable: the ${NAME} agent is not running on this machine (${(e as Error).message})`);
  }
  const end = () => c.destroy();
  signal.addEventListener('abort', end, { once: true });
  try {
    await writeLine(c, req);
    let line: string;
    try {
      line = await new Reader(c).line(MAX_RESPONSE);
    } catch (e) {
      throw new Refused(`unavailable: no answer from ${NAME} (${(e as Error).message})`);
    }
    const resp = JSON.parse(line) as VaultResponse;
    if (!resp.ok) throw new Refused(`${resp.code}: ${resp.error}`);
    return resp;
  } finally {
    signal.removeEventListener('abort', end);
    c.destroy();
  }
}

/** A tool's result. */
const text = (s: string, isError: boolean): CallToolResult => ({ content: [{ type: 'text', text: s }], isError });

const invalid = (message: string) => new ProtocolError(ProtocolErrorCode.InvalidParams, message);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Runs one tool call. */
export async function callTool(o: McpOptions, name: string, args: unknown, signal: AbortSignal): Promise<CallToolResult> {
  const a = isObject(args) ? args : {};
  try {
    switch (name) {
      case 'list_variables': {
        const resp = await ask(o, { tool: VaultTool.List }, signal);
        const vars = resp.variables ?? [];
        return text(vars.length === 0 ? '[]' : JSON.stringify(vars, null, 2), false);
      }
      case 'get_variable': {
        if (typeof a.name !== 'string' || a.name === '') throw invalid('get_variable needs a name');
        const resp = await ask(o, { tool: VaultTool.Get, names: [a.name] }, signal);
        return text(resp.values?.[a.name] ?? '', false);
      }
      case 'run_with_env': {
        const names = a.names;
        if (
          typeof a.command !== 'string' ||
          a.command === '' ||
          !Array.isArray(names) ||
          names.length === 0 ||
          !names.every((n) => typeof n === 'string') ||
          (a.cwd !== undefined && typeof a.cwd !== 'string') ||
          (a.timeout !== undefined && typeof a.timeout !== 'number')
        )
          throw invalid('run_with_env needs a command and names');
        const cwd = (a.cwd as string | undefined) ?? '';
        const resp = await ask(o, { tool: VaultTool.Env, names: names as string[], cwd }, signal);
        const ran = await runWithEnv(a.command, resp.values ?? {}, cwd, ((a.timeout as number | undefined) ?? 0) * 1000, {
          limits: withHub(o.limits ?? {}, resp.run),
          signal,
          waitDelayMs: o.waitDelayMs,
        });
        return text(ran.out, ran.failed);
      }
    }
  } catch (e) {
    if (e instanceof Refused) return text(e.message, true);
    throw e;
  }
  throw invalid(`unknown tool: ${name}`);
}

/** Serves MCP on input and output until input ends (the CLI closed it) or
 * signal does (a signal to the process): the calls still running are then
 * cancelled, their commands killed, and serveMcp returns once they are.
 * A line longer than MAX_LINE ends it with an error. */
export async function serveMcp(o: McpOptions, input: Readable, output: Writable, signal: AbortSignal): Promise<void> {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS },
  );
  const calls = new Set<Promise<unknown>>();
  server.setRequestHandler('tools/list', () => ({ tools: TOOLS }));
  server.setRequestHandler('tools/call', (request, ctx) => {
    const p = callTool(o, request.params.name, request.params.arguments, ctx.mcpReq.signal);
    const q = p.catch(() => {}).finally(() => calls.delete(q));
    calls.add(q);
    return p;
  });
  let failure: Error | null = null;
  let inputEnded = false;
  input.once('end', () => (inputEnded = true));
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  server.onerror = (e) => {
    // The transport ends on a line that does not fit; anything else (a
    // message that is no JSON-RPC, a response it could not send) is the
    // one message's.
    if (/exceeded maximum size/.test(e.message)) failure = e;
  };
  const transport = new StdioServerTransport(input, output, { maxBufferSize: MAX_LINE });
  const stop = () => void server.close();
  signal.addEventListener('abort', stop, { once: true });
  try {
    await server.connect(transport);
    if (signal.aborted) stop();
    await closed;
  } finally {
    signal.removeEventListener('abort', stop);
    // The close aborted every call: their commands are killed.
    await Promise.allSettled([...calls]);
  }
  if (failure && !inputEnded) throw failure;
}
