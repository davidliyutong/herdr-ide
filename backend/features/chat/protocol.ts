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
});
