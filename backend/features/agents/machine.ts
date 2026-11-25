// The agents feature's machine side (docs/features/25-agent-detection.md,
// 35-agent-native-view.md): which coding agents run in the instance's
// terminals and what they do (op detect, machine/detect.ts), and questions
// about the agents' sessions on this machine. A request names a session by
// its agent's kind and id, never by a path: the id is checked before it
// reaches one, and the transcript is found inside the kind's own session
// root (#machine/agents/sessions.ts). The action only reads:
//
//   - resolve {kind, session, cwd} → {ok, code?}: whether the session's
//     transcript exists and ran in cwd, which is only compared with the
//     directory the transcript records, never opened. A transcript that
//     records none yet is answered as not found: it holds no conversation
//     to resume.
//
// Replies carry codes, never an error's text: that would name a path of
// the machine.
import { byId, validSessionId } from '#shared/agents/kinds.ts';
import { Op, RESOLVE_OTHER_CWD, TranscriptCode, type ResolveReply } from '#shared/proto/agentproto/index.ts';
import { Resolver, SessionError, clean } from '#machine/agents/sessions.ts';
import { defineMachine } from '#machine/feature.ts';
import { serveDetect, type DetectOptions } from './machine/detect.ts';
import { agentsProtocol } from './protocol.ts';

/** Bounds the directory a resolve compares, in bytes. */
export const MAX_CWD = 4096;

export interface AgentsMachineOptions {
  detect?: DetectOptions;
}

/** A UTF-16 surrogate without its pair: no UTF-8 can hold it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether s can be the directory of a resolve: an absolute POSIX path of
 * at most MAX_CWD bytes of UTF-8 without NUL. */
const validCwd = (s: string): boolean =>
  s.startsWith('/') && Buffer.byteLength(s) <= MAX_CWD && !s.includes('\0') && !LONE_SURROGATE.test(s);

/** Whether the session's transcript exists and records the directory. */
export async function resolveSession(r: Resolver, req: { kind: string; session: string; cwd: string }): Promise<ResolveReply> {
  if (!byId(req.kind)?.transcript || !validSessionId(req.session) || !validCwd(req.cwd))
    return { ok: false, code: TranscriptCode.BadRequest };
  let cwd: string;
  try {
    cwd = (await r.describe(req.kind, req.session)).cwd;
  } catch (e) {
    if (e instanceof SessionError && e.code === 'compressed') return { ok: false, code: TranscriptCode.Compressed };
    return { ok: false, code: TranscriptCode.NotFound };
  }
  if (cwd === '') return { ok: false, code: TranscriptCode.NotFound };
  if (clean(cwd) !== clean(req.cwd)) return { ok: false, code: RESOLVE_OTHER_CWD };
  return { ok: true };
}

export function agentsMachine(o: AgentsMachineOptions = {}) {
  return defineMachine(agentsProtocol, (env) => {
    // One Resolver for every resolve of the agent: it keeps where it found
    // transcripts, and its misses, between them.
    const resolver = new Resolver({ home: env.home });
    return {
      actions: {
        resolve: (p) => resolveSession(resolver, p),
      },
      ops: { [Op.Detect]: serveDetect(o.detect) },
    };
  });
}
