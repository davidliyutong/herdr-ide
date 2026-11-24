// The browser pane's actions on a machine (docs/features/32-browser-and-ports.md),
// as the Go agent serves them while machines run the Go machine build
// (internal/agent/plugin/browser). Nothing listens on the machine: the core
// opens a stream per connection of a forward.
import { z } from 'zod';
import { defineProtocol } from '#shared/proto/protocol.ts';

/** A TCP port something of the user listens on, on the machine's loopback
 * or every address; process names the program when it is known. */
export const listeningPort = z
  .object({ port: z.int(), process: z.string().nullish() })
  .transform((p) => ({ port: p.port, ...(p.process ? { process: p.process } : {}) }));

export const browserProtocol = defineProtocol('browser', {
  /** Connects to port of the machine's own loopback (127.0.0.1, else ::1,
   * nothing else; refused when nothing answers within 5 s), answers, and
   * then carries the connection's bytes both ways on the stream until
   * either side ends. */
  dial: { params: z.object({ port: z.int().min(1).max(65535) }), result: z.object({}), stream: true },
  /** The listening ports, sorted, one entry per port, at most 200; the
   * agent looks for at most 10 s. Only these members reach the page, as
   * the Go core decoded the answer into its struct. */
  listening: {
    params: z.object({}),
    result: z.object({
      ports: z
        .array(listeningPort)
        .nullish()
        .transform((p) => p ?? []),
    }),
    timeoutMs: 15_000,
  },
});
