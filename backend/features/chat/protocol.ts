// The chat feature's action on a machine (docs/features/37-agent-chats.md), as the
// Go agent serves it while machines run the Go machine build
// (internal/agent/plugin/chat): open gives a stream to the machine's chat
// host (a hidden terminal of the machine's terminal core, which the machine
// side starts, replaces when it is of another build, and never lets the
// core name). After the reply the stream carries the chat host's protocol
// (#shared/proto/chatproto) as it is, the host's Hello first.
import { z } from 'zod';
import { defineProtocol } from '#shared/proto/protocol.ts';

/** The machine side's answer to an open that may not start the chat host
 * (start false) when none serves. */
export const NOT_RUNNING = 'not_running';

export const chatProtocol = defineProtocol('chat', {
  /** A connection to the machine's chat host. Without start (false), only
   * to a host that serves already (else not_running); with it the machine
   * starts one when none does, within 15 s (start_failed), or answers
   * upgrading while a host of another build makes way. */
  open: { params: z.object({ start: z.boolean().optional() }), result: z.unknown(), stream: true },
  /** Anthropic's Agent SDK, which the TypeScript build's chat host loads for
   * Claude Code's chats (claudesdk.ts): whether the pinned version is
   * installed; given url, a machine without it downloads the pinned tarball
   * from there itself (curl or wget), fetched saying it did, error saying
   * why it could not. The Go machine build, whose chat host speaks Claude
   * Code's protocol itself, serves neither this nor sdkUpload (bad_params,
   * an unknown action). */
  sdk: {
    params: z.object({ url: z.string().max(2048).optional() }),
    result: z.object({ installed: z.boolean(), fetched: z.boolean().optional(), error: z.string().optional() }),
    timeoutMs: 6 * 60_000,
  },
  /** The core's upload of the SDK's pinned tarball: after the reply, the
   * tarball in chunks (agentproto's ChunkWriter), then a second line,
   * {ok} once it is installed, else {ok: false, error}. */
  sdkUpload: { params: z.object({}), result: z.unknown(), stream: true },
});
