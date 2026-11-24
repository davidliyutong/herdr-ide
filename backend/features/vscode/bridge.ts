// VS Code's bridge (docs/features/05): the bridge extension in each window
// (extension host) of code-server connects to a socket of the agent's,
// which the agent tunnels to the core as a stream of op bridge. Lines of
// JSON go both ways: a window says hello (its id, its folders, whether it
// has the keyboard) and what the user did in it (Send to Agent, close the
// pane, give the keyboard back, download), which goes to the pages; the
// core sends it commands from the UI (open a file, a diff, Git Graph),
// which it acknowledges, and the theme the pages chose.
import { z } from 'zod';
import { writeLine, type Reply } from '#shared/proto/agentproto/index.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import type { Timing } from './timing.ts';

/** Bounds a line of a window (Send to Agent carries the selection). */
const MAX_LINE = 16 << 20;
/** Bounds the paths of one download (the agent's limit). */
const MAX_DOWNLOAD_PATHS = 1000;

/** A message of a window. Like Go's decoding, a member of the wrong type
 * drops the message. */
const message = z.object({
  type: z.string(),
  id: z.string().optional(),
  folders: z.array(z.string()).nullable().optional(),
  focused: z.boolean().optional(),
  ok: z.boolean().optional(),
  error: z.string().optional(),
  text: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  end_line: z.number().int().optional(),
  paths: z.array(z.string()).nullable().optional(),
});

/** A VS Code window: a VS Code pane of a page, or VS Code on its own. */
export interface Window {
  readonly machine: string;
  /** Its id once it said hello; "" before. */
  id: string;
  /** Its folders; null while unknown (before its hello). */
  folders: string[] | null;
  /** When it said hello first (ms, performance.now), 0 before. */
  hello: number;
  /** When it last said hello or got the keyboard. */
  active: number;
}

interface Conn extends Window {
  readonly conn: AgentStream;
  readonly pending: Map<string, (err?: Error) => void>;
}

/** Where a command goes: the window a page named (from bridge.focus or an
 * earlier reply), else one opened after the request (fresh: the page has
 * just opened a VS Code pane for folder), else the best one for folder. */
export interface Target {
  folder: string;
  window: string;
  fresh: boolean;
}

/** An event for the pages. */
export type BridgeEvent = { t: string; m: string } & Record<string, unknown>;

const trimSlash = (p: string) => p.replace(/\/+$/, '');
const within = (path: string, folder: string) => {
  const f = trimSlash(folder);
  return path === f || path.startsWith(`${f}/`);
};

export class Bridge {
  private readonly windows = new Set<Conn>();
  private readonly waiters = new Set<() => void>();
  private seq = 0;
  /** The theme kind ("dark" or "light") the pages chose last; every window
   * follows it. */
  private theme = '';
  private readonly broadcast: (ev: BridgeEvent) => void;
  private readonly timing: Timing;
  private readonly now: () => number;

  constructor(o: { broadcast: (ev: BridgeEvent) => void; timing: Timing; now?: () => number }) {
    this.broadcast = o.broadcast;
    this.timing = o.timing;
    this.now = o.now ?? (() => performance.now());
  }

  private changed(): void {
    const w = [...this.waiters];
    this.waiters.clear();
    for (const f of w) f();
  }

  /** Writes a line to a window; one that does not take it in time is
   * dropped (its extension connects again). */
  private async send(w: Conn, v: unknown): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        writeLine(w.conn.stream, v),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('VS Code window is not reading')), this.timing.bridgeWriteMs);
        }),
      ]);
    } catch (e) {
      w.conn.stream.destroy();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Serves a window's connection until it ends. */
  async serve(machine: string, conn: AgentStream): Promise<void> {
    try {
      await writeLine(conn.stream, { ok: true } satisfies Reply);
    } catch {
      conn.reader.release();
      closeStream(conn.stream);
      return;
    }
    const w: Conn = { machine, id: '', folders: null, hello: 0, active: this.now(), conn, pending: new Map() };
    try {
      for (;;) {
        let line: string;
        try {
          line = await conn.reader.line(MAX_LINE);
        } catch {
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        const m = message.safeParse(raw);
        if (m.success) this.handle(w, m.data);
      }
    } finally {
      conn.reader.release();
      closeStream(conn.stream);
      this.windows.delete(w);
      for (const done of w.pending.values()) done(new Error('VS Code window closed'));
      w.pending.clear();
      this.changed();
    }
  }

  /** The folders of a window's events: none while unknown (not an empty
   * list, which is a window without a folder). */
  private static place(w: Window): Record<string, unknown> {
    return w.folders !== null ? { folders: w.folders } : {};
  }

  private handle(w: Conn, m: z.infer<typeof message>): void {
    const ev = (t: string, fields: Record<string, unknown>): BridgeEvent => ({ t, m: w.machine, ...fields });
    switch (m.type) {
      case 'hello': {
        w.id = m.id ?? '';
        w.folders = m.folders ?? null;
        w.active = this.now();
        if (!w.hello) w.hello = w.active;
        this.windows.add(w);
        this.changed();
        if (this.theme) void this.send(w, { type: 'theme', kind: this.theme }).catch(() => {});
        if (m.focused) this.focused(w);
        return;
      }
      case 'focus':
        w.active = this.now();
        this.focused(w);
        return;
      case 'ack': {
        const done = w.pending.get(m.id ?? '');
        if (!done) return;
        w.pending.delete(m.id ?? '');
        done(m.ok ? undefined : new Error(m.error ?? ''));
        return;
      }
      case 'sendToAgent':
        // The page decides which agent pane gets it and pastes it without
        // submitting.
        this.broadcast(
          ev('bridge.send', {
            text: m.text ?? '',
            file: m.file ?? '',
            line: m.line ?? 0,
            end_line: m.end_line ?? 0,
            ...Bridge.place(w),
            ...(w.id ? { window: w.id } : {}),
          }),
        );
        return;
      case 'closePane':
      case 'leave':
        // closePane: VS Code's key for closing, pressed in a window without
        // an editor: the page whose pane has the keyboard closes the pane.
        // leave: the key that gives the keyboard back to the page. Only a
        // window that said hello is one a page can name.
        if (w.id) this.broadcast(ev(m.type === 'leave' ? 'bridge.leave' : 'bridge.close', { window: w.id, ...Bridge.place(w) }));
        return;
      case 'download':
        // Files chosen in VS Code's explorer: the page showing that VS Code
        // downloads them.
        if (m.paths && m.paths.length > 0 && m.paths.length <= MAX_DOWNLOAD_PATHS)
          this.broadcast(ev('bridge.download', { paths: m.paths, ...(w.id ? { window: w.id } : {}) }));
        return;
    }
  }

  /** Tells the pages that a window that said hello got the keyboard: the
   * page whose VS Code pane has it learns which window the pane shows. */
  private focused(w: Conn): void {
    if (w.id) this.broadcast({ t: 'bridge.focus', m: w.machine, window: w.id, ...Bridge.place(w) });
  }

  /** Makes every window, now and later, use a theme of kind. */
  setTheme(kind: unknown): void {
    if ((kind !== 'dark' && kind !== 'light') || kind === this.theme) return;
    this.theme = kind;
    for (const w of this.windows) void this.send(w, { type: 'theme', kind }).catch(() => {});
  }

  /** The best window on machine m for folder and its score: 3 shows
   * exactly folder, 2 has a folder that contains it, 1 is any window of
   * the machine; the one used last wins a tie. */
  pick(m: string, folder: string): { window?: Window; score: number } {
    let best: Conn | undefined;
    let score = 0;
    for (const w of this.windows) {
      if (w.machine !== m) continue;
      let sc = 1;
      if (folder)
        for (const f of w.folders ?? []) {
          if (trimSlash(f) === trimSlash(folder)) sc = 3;
          else if (within(folder, f) && sc < 2) sc = 2;
        }
      if (sc > score || (sc === score && best && w.active > best.active)) [best, score] = [w, sc];
    }
    return { window: best, score };
  }

  /** The window of machine m that said hello as id. */
  byID(m: string, id: string): Window | undefined {
    for (const w of this.windows) if (w.machine === m && w.id === id) return w;
    return undefined;
  }

  /** A window of machine m showing folder (any for "") that said hello at
   * or after since: one a page has just opened; the first such. */
  private pickNew(m: string, folder: string, since: number): Conn | undefined {
    let best: Conn | undefined;
    for (const w of this.windows) {
      if (w.machine !== m || w.hello < since) continue;
      const shows = folder === '' || (w.folders ?? []).some((f) => trimSlash(f) === trimSlash(folder));
      if (shows && (!best || w.hello < best.hello)) best = w;
    }
    return best;
  }

  /** Resolves when the windows change, after ms, or when signal ends. */
  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /** The window a command for t goes to, waiting for it (command). */
  private async target(m: string, t: Target, signal: AbortSignal): Promise<Conn> {
    const named = t.window ? (this.byID(m, t.window) as Conn | undefined) : undefined;
    if (named) return named;
    const start = this.now();
    const deadline = start + this.timing.bridgeWindowMs;
    for (;;) {
      signal.throwIfAborted();
      let cand: Conn | undefined;
      let ready: boolean;
      if (t.fresh) {
        cand = this.pickNew(m, t.folder, start);
        ready = !!cand;
      } else {
        const p = this.pick(m, t.folder);
        cand = p.window as Conn | undefined;
        const grace = this.now() - start > this.timing.bridgeGraceMs;
        ready = !!cand && (p.score === 3 || t.folder === '' || (grace && p.score >= 2));
      }
      if (cand && (ready || this.now() >= deadline)) return cand;
      if (this.now() >= deadline) throw new Error('no VS Code window is connected (code-server may still be starting)');
      await this.wait(Math.min(this.timing.bridgePollMs, deadline - this.now()), signal);
    }
  }

  /** Sends cmd to the window of t and returns that window's id once it
   * acknowledged it. A named window that is gone counts as unnamed. A
   * window that is still loading is waited for: a fresh one, or one that
   * shows exactly the folder; without fresh, one that contains the folder
   * (or, without a folder, any) is taken after a grace period. */
  async command(m: string, t: Target, cmd: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const w = await this.target(m, t, signal);
    const id = String(++this.seq);
    const acked = new Promise<void>((resolve, reject) => w.pending.set(id, (err) => (err ? reject(err) : resolve())));
    acked.catch(() => {});
    try {
      await this.send(w, { ...cmd, type: 'command', id });
    } catch (e) {
      w.pending.delete(id);
      throw e;
    }
    const window = w.id;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => w.pending.get(id)?.(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await Promise.race([
        acked,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('VS Code did not answer')), this.timing.bridgeAckMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      w.pending.delete(id);
    }
    return window;
  }
}
