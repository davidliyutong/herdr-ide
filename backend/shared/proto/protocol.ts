// A feature's protocol: the actions its machine side serves, typed. Both
// sides import the definition; the hub calls an action (kernel/agent.ts),
// the machine serves it (machine/), and each validates what it receives
// with the action's schemas. On the wire an action is the agent protocol's
// plugin op: {op: "plugin", plugin, action, params} and a reply whose
// plugin member is the result; params and results larger than MAX_INLINE
// follow their line as a body (params_length, plugin_length). After the
// reply a streaming action goes on with bytes of its own on the stream.
import type { z } from 'zod';

export interface Action<P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  params: P;
  result: R;
  /** The stream stays open after the reply for the action's own bytes. */
  stream?: boolean;
  /** How long the reply may take, for actions that answer only after
   * their work (a scan, a push); the session's default otherwise. */
  timeoutMs?: number;
}

export type Actions = Record<string, Action>;

export interface Protocol<A extends Actions = Actions> {
  /** The feature's id: the plugin op's plugin member. */
  readonly id: string;
  readonly actions: A;
}

export function defineProtocol<const A extends Actions>(id: string, actions: A): Protocol<A> {
  return { id, actions };
}

export type ParamsOf<A extends Action> = z.input<A['params']>;
export type ResultOf<A extends Action> = z.output<A['result']>;
