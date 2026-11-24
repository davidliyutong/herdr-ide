// The attach stream to a machine's window manager (action attach): after
// the agent's reply both sides exchange GUI messages, the agent's events
// and frames one way, the core's commands the other. Commands are queued
// and written one at a time; while the agent does not keep up, more are
// dropped.
import { EOFError } from '#shared/lib/streamio.ts';
import { GUIMessage, readGUI, writeGUI, type GUICommand } from '#shared/proto/agentproto/index.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { marshalCommand } from './wire.ts';

export class AttachStream {
  private readonly conn: AgentStream;
  private readonly maxCommands: number;
  private readonly detachMs: number;
  private queue: Buffer[] = [];
  private writing = false;
  private ended = false;

  constructor(conn: AgentStream, o: { maxCommands: number; detachMs: number }) {
    this.conn = conn;
    this.maxCommands = o.maxCommands;
    this.detachMs = o.detachMs;
  }

  /** Queues a command; dropped while the queue is full or after the end. */
  send(c: GUICommand): void {
    if (this.ended || this.queue.length >= this.maxCommands) return;
    this.queue.push(Buffer.from(marshalCommand(c)));
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.queue.length && !this.ended) await writeGUI(this.conn.stream, GUIMessage.JSON, this.queue.shift()!);
    } catch {
      // The stream broke: reading ends too.
      this.destroy();
    } finally {
      this.writing = false;
    }
  }

  /** Reads the agent's messages until the stream ends, and returns why it
   * ended. */
  async read(on: (kind: number, payload: Buffer) => void): Promise<Error> {
    for (;;) {
      let msg: { kind: number; payload: Buffer };
      try {
        msg = await readGUI(this.conn.reader);
      } catch (e) {
        this.ended = true;
        this.queue = [];
        this.conn.reader.release();
        closeStream(this.conn.stream);
        return e instanceof EOFError ? new Error('EOF') : e instanceof Error ? e : new Error(String(e));
      }
      on(msg.kind, msg.payload);
    }
  }

  /** Ends the stream: the agent sees its end and leaves; one that does not
   * within detachMs is reset. */
  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.queue = [];
    const st = this.conn.stream;
    const timer = setTimeout(() => st.destroy(), this.detachMs);
    st.once('close', () => clearTimeout(timer));
    st.end();
  }

  /** Resets the stream at once. */
  destroy(): void {
    this.ended = true;
    this.queue = [];
    this.conn.stream.destroy();
  }
}
