// Bun 1.4.5's server neither sends the rest nor closes the connection when
// a response body errors while the socket's output is backed up (the usual
// case for a download at full speed): the client waits forever instead of
// seeing a failed transfer. An error after a pause, once Bun flushed what
// it held to a client that is reading, closes the connection as it
// should. So a breakable response's body (kernel/http/breakable.ts) is
// passed on chunk by chunk, and its error only after pauseMs.

export function abortable(res: Response, pauseMs = 250): Response {
  if (!res.body) return res;
  const inner = res.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        let r: Awaited<ReturnType<typeof inner.read>>;
        try {
          r = await inner.read();
        } catch {
          await new Promise((ok) => setTimeout(ok, pauseMs));
          // Without a reason: Bun prints a body error's reason as an
          // uncaught error.
          return c.error();
        }
        if (r.done) c.close();
        else c.enqueue(r.value);
      },
      cancel: (why) => inner.cancel(why),
    },
    { highWaterMark: 0 },
  );
  return new Response(body, res);
}
