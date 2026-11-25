// A stream of the agent's session as the machine side reads it: the yamux
// stream, and a Reader of what follows the header (reader.release() hands
// the rest on to a pipe).
import type { Reader } from '#shared/lib/streamio.ts';
import type { Stream } from '#shared/proto/yamux.ts';

export interface Conn {
  readonly stream: Stream;
  readonly reader: Reader;
}
