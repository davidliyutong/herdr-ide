// A feature's machine side: the handlers of its protocol's actions
// (#shared/proto/protocol.ts), which the agent runs for the plugin op
// (dispatch.ts). A feature's machine.ts exports one, made with
// defineMachine: start(env) runs once per agent (a node's sessions share
// it) and returns the handlers, which keep what the feature shares between
// its requests (a limit on searches running at once, a capture that one
// core started and another waits for).
import type { z } from 'zod';
import type { Reader } from '#shared/lib/streamio.ts';
import type { Logger } from '#shared/lib/log.ts';
import type { Header, NodeInfo, Reply } from '#shared/proto/agentproto/index.ts';
import type { Action, Protocol } from '#shared/proto/protocol.ts';
import type { Stream } from '#shared/proto/yamux.ts';
import type { Conn } from './stream.ts';

/** One core's session of the agent, as the machine sides of features see
 * it. */
export interface MachineSession {
  /** Numbers the agent's sessions in the order they came. */
  readonly id: number;
  /** Names the core (its process), the same for its sessions after
   * reconnects; "" when unknown. */
  readonly client: string;
  readonly live: boolean;
  /** The session's pipes to the unix socket at path (op dial-unix): how
   * many are open, and when it last opened one (performance.now(); 0 for
   * never). */
  dialed(path: string): { open: number; last: number };
  /** Opens a stream towards the core with header h and reads its reply
   * within timeoutMs; the stream and its reader after the reply. */
  ask(h: Header, timeoutMs: number, signal?: AbortSignal): Promise<{ conn: Conn; reply: Reply }>;
}

/** What the agent gives the machine sides of features. */
export interface MachineEnv {
  /** The instance (its data directory: ~/<brand.dataDir(instance)>). */
  readonly instance: string;
  /** The user's home directory. */
  readonly home: string;
  /** The instance's data directory, shared by the hosts that share the home. */
  readonly base: string;
  /** This host's own directory of the instance (hostdirs). */
  readonly host: string;
  /** This host's private run directory of the instance, 0700. */
  readonly run: string;
  readonly logger: Logger;
  /** p with "~" resolved and made absolute relative to the home directory;
   * throws Fail bad_params for an empty path. */
  expand(p: string): string;
  /** The environment of programs the agent starts (env.ts cleanEnv). */
  environ(): Record<string, string>;
  /** The instance's terminal core's socket. */
  readonly hcSocket: string;
  /** Runs argv as a terminal of the instance's terminal core that no
   * client shows (hidden.ts); fails with code no_terminal_core when none
   * answers. */
  runHidden(name: string, argv: string[], signal?: AbortSignal): Promise<void>;
  /** Ends a helper's terminal that holds name (hidden.ts killHidden). */
  killHidden(name: string, argv: string[], kill: boolean, signal?: AbortSignal): Promise<boolean>;
  /** The agent's live sessions, oldest first. */
  sessions(): MachineSession[];
  /** Ends with the agent. */
  readonly signal: AbortSignal;
}

/** What one action gets besides its params. */
export interface ActionContext extends Omit<MachineEnv, 'signal'> {
  /** Names the core that asked (its process; "" when unknown): the cores a
   * node serves share work that concerns the machine and tell each other
   * apart by it. */
  readonly client: string;
  /** The session of the core that asked. */
  readonly session: MachineSession;
  /** Ends with the agent, with the session, and for an action that does not
   * stream when the core closes the stream (it gave up on the action). */
  readonly signal: AbortSignal;
}

/** The stream of a streaming action, after its params. */
export interface ActionStream {
  readonly stream: Stream;
  /** What follows the header on the stream. */
  readonly reader: Reader;
  /** The reply line: ok, with the result when there is one. */
  reply(result?: unknown): Promise<void>;
}

type Params<A extends Action> = z.output<A['params']>;
type Result<A extends Action> = z.input<A['result']>;

/** A handler of one action: the result (what goes on the wire, as the
 * core's schema reads it), or for a streaming action whatever it writes
 * after its reply. A Fail it throws is the refusal's code. */
export type Handler<A extends Action> = A extends { stream: true }
  ? (params: Params<A>, ctx: ActionContext, s: ActionStream) => Promise<void>
  : (params: Params<A>, ctx: ActionContext) => Promise<Result<A>> | Result<A>;

export type Handlers<P extends Protocol> = { [K in keyof P['actions']]: Handler<P['actions'][K]> };

/** An op of the agent protocol a feature serves besides its actions (the
 * agents feature's detect, which the core opens as an op of its own): it
 * gets the stream after the header, writes the reply itself and returns
 * when it is done with the stream, which the agent then closes. */
export type OpHandler = (conn: Conn, h: Header, ctx: ActionContext) => Promise<void>;

/** What a feature's machine side runs for an agent. */
export interface Served<P extends Protocol = Protocol> {
  readonly actions: Handlers<P>;
  /** Its ops, by name (agentproto's Op). */
  readonly ops?: Readonly<Record<string, OpHandler>>;
  /** Its own retention rules, run with the agent's housekeeping. */
  housekeep?(now: Date): void | Promise<void>;
  /** Runs when the node gives way to the node next (a newer build took it
   * over): what the feature runs for the instance becomes that node's. */
  handOver?(next: NodeInfo): void;
  /** Runs when the agent ends, once its signal ended and its sessions'
   * requests were waited for: ends what the feature started and owns. */
  close?(): void | Promise<void>;
}

export interface MachineSide<P extends Protocol = Protocol> {
  readonly protocol: P;
  start(env: MachineEnv): Served<P>;
}

export function defineMachine<P extends Protocol>(protocol: P, start: (env: MachineEnv) => Served<P>): MachineSide<P> {
  return { protocol, start };
}
