// What a host hands the core with each request, and what the core's
// middleware works out from it for the handlers (Hono's bindings and
// variables).
import type { Context } from 'hono';
import type { AuditFields, Who } from '../audit.ts';
import type { ChannelOpen } from '../channel.ts';
import type { Machine } from '../machines/machine.ts';

/** The kinds of client the core tells apart (SECURITY.md): the desktop
 * app's windows and browsers. VS Code's windows run on the UI's origin,
 * where their scripts can do whatever the page can, so each kind has its
 * own switch for them, and the core applies the requesting client's. */
export type Client = 'desktop' | 'browser';

/** What the host knows of a request's connection. */
export interface Peer {
  /** The connection's remote address (an IP); undefined for a request that
   * did not come over a network (the desktop app's windows, in process:
   * a client on the core's own host). */
  remote?: string;
  /** The request comes from the desktop app's windows: the host vouches
   * for it (the app's main process, which hands the core in process the
   * requests of its windows; on the command line, the cookie of the
   * launch the desktop app set). */
  desktop: boolean;
  /** Present on a WebSocket upgrade: adopts the connection as a channel
   * and gives the answer the host expects. compress asks for messages
   * compressed (permessage-deflate) where the client offers it. */
  upgrade?: (open: ChannelOpen, opts?: { compress?: boolean }) => Response;
}

export interface Vars {
  client: Client;
  /** A program of the core's own host talking to its loopback address
   * directly, not through a proxy (guard.ts sameHost). */
  sameHost: boolean;
  /** The request's origin when the core vouches that no other program
   * serves pages of it; "" otherwise (guard.ts trustedOrigin). */
  trustedOrigin: string;
  who: Who;
  /** What a mutating route acted on, for its audit record (a path, a
   * name; never secrets or contents). */
  audit: AuditFields;
  /** The machine of a route below /api/m/:id. */
  machine: Machine;
  /** The audit event a mutating route's handler chose instead of the
   * route's. */
  event?: string;
}

export type Env = { Bindings: Peer; Variables: Vars };

export type Ctx = Context<Env>;
