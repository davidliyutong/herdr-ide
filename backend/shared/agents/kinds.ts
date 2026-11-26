// The registry of the coding agents the terminals recognize: for each kind,
// its name, the AI usage plugin's provider of its subscription, the command
// lines that start it, start it with a session chosen by the caller,
// continue a directory's latest conversation and resume a session by its
// id, the parser of its session transcripts, and how the chat host runs it
// headless (its chat spec). It is data only and runs on every system the
// hub runs on.
//
// The ids are the detector's (features/agents/machine/detect/manifests), which the
// settings' list of agents names too; the registry's JSON
// (spec/generated/registry.json, key "agents") is what the web UI reads
// (web/src/conversation/kinds.ts). A kind's JSON carries only its chat's
// adapter: the command, its environment and the session metadata are a
// ChatSpec of their own (chatSpec), which stays on the machine's side and
// is never part of a Kind.
//
// Adding a kind is a row here, a manifest and, for a native view of its
// conversations, a transcript parser; for chats, a chat spec whose adapter
// is one of ADAPTERS (the chat host's adapters).

/** Stands for a session id in a command line's tokens. */
export const PLACEHOLDER = '{id}';

/** The adapters of the chat host, by the protocol they speak. */
export const Adapter = {
  /** Claude Code's SDK protocol (stream-json and control requests on stdin and stdout). */
  Claude: 'claude',
  /** Codex's app-server (JSON-RPC on stdio). */
  Codex: 'codex',
  /** The Agent Client Protocol on stdio. */
  ACP: 'acp',
} as const;
export type AdapterName = (typeof Adapter)[keyof typeof Adapter];

/** The chat host's adapters. */
export const ADAPTERS: readonly AdapterName[] = Object.freeze([Adapter.Claude, Adapter.Codex, Adapter.ACP]);

/** One kind of coding agent, as the registry's JSON writes it. */
export interface Kind {
  /** The detector's id (the manifests' id), e.g. "claude". */
  id: string;
  /** The agent's name for people, e.g. "Claude Code". */
  title: string;
  /** The AI usage plugin's provider of the agent's subscription; absent
   * when it has none. The detector's "agy" is the provider "antigravity". */
  usageProvider?: string;
  /** The argv that starts the agent; absent for an agent the UIs do not
   * offer to start. */
  start?: string[];
  /** Appended to start to start the agent with a session id chosen by the
   * caller (PLACEHOLDER); absent when the agent takes none. */
  newSession?: string[];
  /** The command line, as tokens, that continues the directory's latest
   * conversation; absent when the agent has none. */
  continueLatest?: string[];
  /** The command line, as tokens, that resumes a session by its id
   * (PLACEHOLDER); absent when the agent has none. */
  resumeById?: string[];
  /** The format of the agent's session transcripts ("claude", "codex"),
   * which sessions are found and read in; absent for an agent whose
   * transcripts are not read. */
  transcript?: string;
  /** Present for an agent the chat host runs headless: its adapter only
   * (chatSpec has the rest, on the machine's side). */
  chat?: { adapter: AdapterName };
}

/** How the chat host runs an agent headless. Only adapter leaves the
 * machine's side (a Kind's chat): the command, its environment and the
 * session metadata are in no kind's JSON. */
export interface ChatSpec {
  /** The protocol the agent speaks (ADAPTERS). */
  adapter: AdapterName;
  /** The command the adapter adds its protocol's own arguments to; argv[0]
   * is looked up in the user's PATH and is the program start runs too. */
  argv: string[];
  /** Added to the agent's environment; absent for nothing. */
  env?: Record<string, string>;
  /** The _meta of ACP's session/new (an ACP agent's settings that are not
   * in the protocol), a JSON object; absent for none. */
  newSessionMeta?: Record<string, unknown>;
}

/** An agent's command line, as tokens. */
const argv = (s: string): string[] => s.split(/\s+/).filter((t) => t !== '');

interface Row {
  kind: Kind;
  chat?: ChatSpec;
}

/** A row, its kind's members in the registry JSON's order and only those
 * given. */
function row(k: Kind, chat?: ChatSpec): Row {
  const kind: Kind = { id: k.id, title: k.title };
  if (k.usageProvider !== undefined) kind.usageProvider = k.usageProvider;
  if (k.start !== undefined) kind.start = k.start;
  if (k.newSession !== undefined) kind.newSession = k.newSession;
  if (k.continueLatest !== undefined) kind.continueLatest = k.continueLatest;
  if (k.resumeById !== undefined) kind.resumeById = k.resumeById;
  if (k.transcript !== undefined) kind.transcript = k.transcript;
  if (chat) kind.chat = { adapter: chat.adapter };
  return chat ? { kind, chat } : { kind };
}

// The agents in the order the UIs offer them: those the command palette
// starts first, the others by id.
//
// The chats: Claude Code and Codex through their own protocols; Antigravity
// (`agy acp --stdio`), Kimi Code (`kimi acp`) and Grok (`grok agent
// --no-leader stdio`, its sessions told not to approve everything, which
// the user's always-approve setting would make them) through ACP. OpenCode
// has no chat: `opencode acp` listens on a TCP port without authentication.
const rows: readonly Row[] = [
  row(
    {
      id: 'claude',
      title: 'Claude Code',
      usageProvider: 'claude',
      start: argv('claude'),
      newSession: argv('--session-id ' + PLACEHOLDER),
      continueLatest: argv('claude --continue'),
      resumeById: argv('claude --resume ' + PLACEHOLDER),
      transcript: 'claude',
    },
    { adapter: Adapter.Claude, argv: argv('claude') },
  ),
  row(
    {
      id: 'codex',
      title: 'Codex',
      usageProvider: 'codex',
      start: argv('codex'),
      continueLatest: argv('codex resume --last'),
      resumeById: argv('codex resume ' + PLACEHOLDER),
      transcript: 'codex',
    },
    { adapter: Adapter.Codex, argv: argv('codex app-server --listen stdio://') },
  ),
  row(
    {
      id: 'agy',
      title: 'Antigravity',
      usageProvider: 'antigravity',
      start: argv('agy'),
      continueLatest: argv('agy --continue'),
      resumeById: argv('agy --resume ' + PLACEHOLDER),
      transcript: 'agy',
    },
    { adapter: Adapter.ACP, argv: argv('agy acp --stdio') },
  ),
  row({ id: 'gemini', title: 'Gemini CLI', start: argv('gemini') }),
  row({ id: 'opencode', title: 'OpenCode', usageProvider: 'opencode', start: argv('opencode') }),
  row({ id: 'kimi', title: 'Kimi Code', usageProvider: 'kimi', start: argv('kimi') }, { adapter: Adapter.ACP, argv: argv('kimi acp') }),
  row(
    { id: 'grok', title: 'Grok', usageProvider: 'grok', start: argv('grok') },
    { adapter: Adapter.ACP, argv: argv('grok agent --no-leader stdio'), newSessionMeta: { yoloMode: false } },
  ),
  row({ id: 'cursor', title: 'Cursor', start: argv('cursor') }),
  row({ id: 'copilot', title: 'GitHub Copilot', start: argv('copilot') }),
  row({ id: 'qwen', title: 'Qwen Code', start: argv('qwen') }),
  row({ id: 'amp', title: 'Amp', start: argv('amp') }),
  row({ id: 'cline', title: 'Cline' }),
  row({ id: 'devin', title: 'Devin' }),
  row({ id: 'droid', title: 'Droid' }),
  row({ id: 'hermes', title: 'Hermes' }),
  row({ id: 'kilo', title: 'Kilo Code' }),
  row({ id: 'kiro', title: 'Kiro' }),
  row({ id: 'letta', title: 'Letta Code' }),
  row({ id: 'maki', title: 'Maki' }),
  row({ id: 'muse', title: 'Muse' }),
  row({ id: 'pi', title: 'Pi' }),
  row({ id: 'qodercli', title: 'Qoder CLI' }),
];

// Copies: the registry cannot be changed through what the functions return.
const copy = <T>(v: T): T => structuredClone(v);

/** Every kind, in the order the UIs offer them; copies. */
export function all(): Kind[] {
  return rows.map((r) => copy(r.kind));
}

/** The kind of a detector's id; a copy. */
export function byId(id: string): Kind | undefined {
  const r = rows.find((r) => r.kind.id === id);
  return r && copy(r.kind);
}

/** The kinds the chat host runs (a chat spec), in the order the UIs offer
 * them; copies, as all's. */
export function chatKinds(): Kind[] {
  return rows.filter((r) => r.chat).map((r) => copy(r.kind));
}

/** How the chat host runs the agent of a detector's id; undefined for one
 * it does not run. A copy; it stays on the machine's side. */
export function chatSpec(id: string): ChatSpec | undefined {
  const r = rows.find((r) => r.kind.id === id);
  return r?.chat && copy(r.chat);
}

const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether s is a session id as the agents write them: a UUID in
 * lower-case hexadecimal, nothing else. Only such an id is ever put into a
 * command line. */
export const validSessionId = (s: string): boolean => sessionId.test(s);
