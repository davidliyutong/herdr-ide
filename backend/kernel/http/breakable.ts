// Responses whose body may break off on purpose: a download the user
// cancelled, a machine gone mid-file. The client must then see a failed
// transfer, not a short file (a streamed body has no length the client
// could check), so the host passes the body's error on as a broken
// connection, working around what its runtime does there (hosts/bun:
// abortable).

const breakable = new WeakSet<Response>();

/** A response with a streamed body that may error: the client sees the
 * transfer fail when it does. */
export function breakableResponse(body: ReadableStream<Uint8Array>, init?: ResponseInit): Response {
  const res = new Response(body, init);
  breakable.add(res);
  return res;
}

export const isBreakable = (res: Response): boolean => breakable.has(res);
