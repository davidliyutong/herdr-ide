// The agents feature's action on a machine, as the machine side serves it
// (features/agents/machine): whether a coding agent's session is one to
// resume in a directory. The machine looks for the session's transcript in
// the agent's session directories (by kind and id, never by a path the core
// names) and compares the directory it ran in with cwd.
import { z } from 'zod';
import { defineProtocol } from '#shared/proto/protocol.ts';

/** How long a resolve may take: a search of the machine's session
 * directories for an id it does not know. */
export const RESOLVE_MS = 15_000;

/** The machine's answer (agentproto.ResolveReply): ok, or a code
 * (not_found, bad_request, other_cwd when the session ran elsewhere). Only
 * these members reach the page, as the Go core decoded the answer into its
 * struct; an empty code is left out. */
export const resolveReply = z
  .object({ ok: z.boolean().optional(), code: z.string().optional() })
  .transform((r) => ({ ok: r.ok ?? false, ...(r.code ? { code: r.code } : {}) }));
export type ResolveReply = z.output<typeof resolveReply>;

export const agentsProtocol = defineProtocol('agents', {
  resolve: {
    params: z.object({ kind: z.string(), session: z.string(), cwd: z.string() }),
    result: resolveReply,
    timeoutMs: RESOLVE_MS,
  },
});
