// The browser pane's machine side (docs/features/32-browser-and-ports.md):
// it connects the hub to a service listening on the machine's own
// loopback interface, the way ssh -L does, and lists what listens there.
// Nothing listens on the machine for it: the hub opens a stream per
// connection.
import { connect, type Socket } from 'node:net';
import { CoalesceCache } from '#shared/lib/cache.ts';
import { Fail } from '#shared/lib/fail.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import { defineMachine } from '#machine/feature.ts';
import { pipe } from '#machine/hcop.ts';
import { browserProtocol } from './protocol.ts';
import { listening, tidy, type Port } from './machine/listening.ts';

export interface BrowserMachineOptions {
  /** Bounds connecting to a service of the machine itself (5 s). */
  dialMs?: number;
  /** Bounds looking for the listening ports (10 s). */
  listeningMs?: number;
  /** How long a listening-ports scan is reused on the machine (2 s). */
  listeningCacheMs?: number;
  /** Clock function for the machine-side listening cache (tests). */
  now?: () => number;
}

/** Connects to port of host within timeoutMs. */
function dialTCP(host: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<Socket> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const c = connect({ host, port });
    const fail = (e: Error) => {
      clearTimeout(t);
      signal.removeEventListener('abort', abort);
      c.destroy();
      reject(e);
    };
    const t = setTimeout(() => fail(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs);
    const abort = () => fail(new Error('the agent stopped'));
    signal.addEventListener('abort', abort, { once: true });
    c.once('error', fail);
    c.once('connect', () => {
      clearTimeout(t);
      signal.removeEventListener('abort', abort);
      c.off('error', fail);
      resolve(c);
    });
  });
}

export function browserMachine(o: BrowserMachineOptions = {}) {
  const listeningCache = new CoalesceCache<Port[]>({
    ttlMs: o.listeningCacheMs ?? 2_000,
    maxEntries: 1,
    now: o.now,
  });
  return defineMachine(browserProtocol, () => ({
    actions: {
      // Connects the stream to the port of this machine's loopback, answers,
      // and then carries bytes both ways until either side ends. Only
      // loopback is dialed: the hub reaches what a program of this machine
      // could, not the machine's network.
      dial: async (p, ctx, s) => {
        let c: Socket | null = null;
        let last: unknown;
        for (const host of ['127.0.0.1', '::1']) {
          try {
            c = await dialTCP(host, p.port, o.dialMs ?? 5000, ctx.signal);
            break;
          } catch (e) {
            ctx.signal.throwIfAborted();
            last = e;
          }
        }
        if (!c) throw new Fail('refused', 502, `nothing answers on port ${p.port} of the machine: ${(last as Error).message}`);
        const sock = c;
        sock.on('error', () => {});
        try {
          await s.reply();
        } catch {
          sock.destroy();
          return;
        }
        const end = () => {
          sock.destroy();
          closeStream(s.stream);
        };
        if (ctx.signal.aborted) {
          end();
          return;
        }
        ctx.signal.addEventListener('abort', end, { once: true });
        try {
          await pipe(s, sock);
        } finally {
          ctx.signal.removeEventListener('abort', end);
        }
      },
      listening: async (_, ctx) => {
        const ports = await listeningCache.get('listening', { signal: ctx.signal, timeoutMs: o.listeningMs ?? 10_000 }, async (signal) =>
          tidy(await listening(signal)),
        );
        return { ports };
      },
    },
  }));
}
