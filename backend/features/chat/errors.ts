// The errors of the chat feature. What goes wrong reaches the pages as a
// chatproto ChatError ({code, message}) and the routes' callers as the
// same code with an HTTP status: the chat host's codes (chatproto's Code),
// the machine's (offline, transport, not_running, upgrading,
// no_terminal_core, start_failed), and the hub's own (wire.ts HubCode).
import { Fail } from '#kernel/fail.ts';
import { ChatProtoError, Code, type ChatError } from '#shared/proto/chatproto/index.ts';
import { NOT_RUNNING } from './protocol.ts';
import { HubCode } from './wire.ts';

export const chatError = (code: string, message: string): ChatProtoError => new ChatProtoError({ code, message });

/** A chat host that does not speak chatproto.PROTO, or says something that
 * is not of the protocol. */
export const protocolError = (message: string): ChatProtoError => chatError(Code.Protocol, message);

/** Whether e is the reason of a signal that timed out
 * (AbortSignal.timeout). */
export const isTimeout = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as Error).name === 'TimeoutError';

/** The time limit's error, as the page reads it. */
export const TIMEOUT: ChatError = { code: HubCode.Timeout, message: 'the machine did not answer in time' };

/** e as the protocol's error: a ChatProtoError's, a Fail's code (the
 * machine's), timeout for a time limit, failed for anything else. */
export function asChatError(e: unknown): ChatError {
  if (e instanceof ChatProtoError) return e.error;
  if (e instanceof Fail) return { code: e.code, message: e.message };
  if (isTimeout(e)) return TIMEOUT;
  return { code: Code.Failed, message: e instanceof Error ? e.message : String(e) };
}

/** The error of a connection to a chat host that broke: why signal ended
 * when it did (the caller's time limit), else transport. */
export function broken(signal: AbortSignal, e: unknown): unknown {
  if (signal.aborted) return signal.reason;
  return chatError('transport', e instanceof Error ? e.message : String(e));
}

/** The HTTP status of an error code. */
export function statusOf(code: string): number {
  switch (code) {
    case '':
      return 200;
    case Code.BadRequest:
      return 400;
    case Code.UnknownChat:
    case Code.NotFound:
      return 404;
    case Code.Busy:
    case Code.TooMany:
    case Code.InTerminal:
    case Code.HandedOff:
    case Code.Sleeping:
    case HubCode.Offline:
    case NOT_RUNNING:
      return 409;
    case Code.ProbeBusy:
      return 429;
    case Code.TooLarge:
      return 413;
    case HubCode.ReadOnly:
    case Code.NotAllowed:
    case Code.UnsafeFolder:
      return 403;
    case Code.Unsupported:
    case Code.AuthRequired:
      return 422;
    case HubCode.Timeout:
      return 504;
    case 'upgrading':
    case 'no_terminal_core':
    case Code.SdkUnavailable:
      // The machine's host makes way for another build, its terminal core
      // does not run, or it has no Agent SDK and could not get it: later.
      return 503;
  }
  // The agent or the machine failed: start_failed, protocol, ended,
  // failed, transport and the machine's own codes.
  return 502;
}

/** e as a route's failure: its code, with the status that fits. */
export function failOf(e: unknown): Fail {
  const c = asChatError(e);
  return new Fail(c.code, statusOf(c.code), c.message);
}

export const badRequest = (message: string): Fail => new Fail(Code.BadRequest, 400, message);
