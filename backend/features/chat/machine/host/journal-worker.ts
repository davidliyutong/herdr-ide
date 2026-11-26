import { parentPort } from 'node:worker_threads';
import { type DB, NewerError, open, pruneHostFiles } from '#shared/store/index.ts';

export type Param = null | number | bigint | string | Uint8Array;
export type SQLRow = Record<string, Param>;

export interface Step {
  sql: string;
  params: Param[];
  /** Any other number of changes rolls the transaction back. */
  expect?: number;
}

export type Request =
  | { op: 'open'; base: string; path: string; name: string; migrations: readonly string[]; busyTimeout?: number }
  | { op: 'tx'; steps: Step[] }
  | { op: 'all'; sql: string; params: Param[] }
  | { op: 'close' };

export type Reply =
  | { id: number; ok: true; changes?: number[]; rows?: SQLRow[]; pruned?: string[]; pruneMessage?: string }
  | { id: number; ok: false; gap?: boolean; message: string; newer?: number };

class Gap extends Error {
  constructor() {
    super("the chat's log would have a gap");
  }
}

/** Opens, migrates, prunes and serves the journal on one thread in message order. */
export function serveJournal(): void {
  const port = parentPort!;
  let db: DB | undefined;
  port.on('message', (m: Request & { id: number }) => {
    const { id } = m;
    try {
      let reply: Reply;
      if (m.op === 'open') {
        if (db) throw new Error('the journal is already open');
        const conn = open(m.path, { migrations: m.migrations, busyTimeout: m.busyTimeout });
        if (conn.newer) {
          conn.close();
          throw conn.newer;
        }
        db = conn;
        reply = { id, ok: true };
        try {
          reply.pruned = pruneHostFiles(m.base, m.name);
        } catch (e) {
          reply.pruneMessage = (e as Error).message;
        }
      } else if (m.op === 'close') {
        db?.close();
        db = undefined;
        reply = { id, ok: true };
      } else {
        if (!db) throw new Error('the journal is closed');
        if (m.op === 'all') reply = { id, ok: true, rows: db.all<SQLRow>(m.sql, ...m.params) };
        else {
          const changes = db.update((conn) =>
            m.steps.map((s) => {
              const count = Number(conn.run(s.sql, ...s.params).changes);
              if (s.expect !== undefined && count !== s.expect) throw new Gap();
              return count;
            }),
          );
          reply = { id, ok: true, changes };
        }
      }
      port.postMessage(reply);
    } catch (e) {
      port.postMessage({
        id,
        ok: false,
        gap: e instanceof Gap,
        message: (e as Error).message,
        ...(e instanceof NewerError ? { newer: e.version } : {}),
      } satisfies Reply);
    }
  });
}
