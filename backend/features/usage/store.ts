// What the feature keeps in the core's database (core[-<instance>]-<host>.db
// beside the settings file, shared with the other features; the Go core's
// tables, so either core reads what the other wrote): the points of each
// account's window (usage_windows), the accounts of the last poll
// (usage_accounts), the alerts fired (usage_alerts) and each machine's last
// cost report (usage_machine_costs). Values are JSON, written as blobs as
// Go wrote them. Tables of a newer version are read, not written.
import { basename, dirname, extname } from 'node:path';
import { z } from 'zod';
import { hostFile, NewerError, openShared, type DB } from '#shared/store/index.ts';
import { History, type AlertRecord, type Kept, type Point } from './history.ts';
import { account } from './protocol.ts';

const FEATURE = 'usage';

const MIGRATIONS = [
  `CREATE TABLE usage_windows (
		account TEXT NOT NULL,
		win TEXT NOT NULL,
		points TEXT NOT NULL,
		PRIMARY KEY (account, win)
	);
	CREATE TABLE usage_accounts (
		key TEXT PRIMARY KEY,
		view TEXT NOT NULL
	);
	CREATE TABLE usage_alerts (
		key TEXT PRIMARY KEY,
		record TEXT NOT NULL
	);`,
  `CREATE TABLE usage_machine_costs (
		mc_key TEXT PRIMARY KEY,
		machine TEXT NOT NULL,
		entry BLOB NOT NULL
	);`,
];

/** The core's database beside settingsFile (settings-dev.json →
 * core-dev-<host>.db); "" for a core without a settings file, which keeps
 * no state. */
export function coreDBFile(settingsFile: string): string {
  if (!settingsFile) return '';
  const name = basename(settingsFile).replace('settings', 'core');
  return hostFile(dirname(settingsFile), name.slice(0, name.length - extname(name).length) + '.db');
}

/** An account as kept (its windows without ids and paces). */
const keptView = account.extend({
  key: z.string(),
  machines: z.array(z.string()).nullish(),
  fetchedAt: z.number().nullish(),
  seenAt: z.number().nullish(),
  issues: z.array(z.object({ machine: z.string(), status: z.string(), code: z.string().nullish() })).nullish(),
});

const points = z.array(z.tuple([z.number(), z.number()])).min(1);
const alertRecord = z.object({ end: z.number() });

const json = (v: unknown) => Buffer.from(JSON.stringify(v));
function parse<T extends z.ZodType>(t: T, v: unknown): z.output<T> | undefined {
  try {
    const r = t.safeParse(JSON.parse(typeof v === 'string' ? v : Buffer.from(v as Uint8Array).toString('utf8')));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** What a history read back holds. */
export interface Stored {
  history: History;
  accounts: Kept[];
}

/** The account as the Go core kept it: its windows with an empty id. */
export const keptJSON = (a: Kept) => {
  const { windows, ...rest } = a.account;
  return {
    ...rest,
    windows: (windows ?? []).map((w) => ({ ...w, id: '' })),
    key: a.key,
    machines: a.machines,
    fetchedAt: a.fetchedAt || undefined,
    seenAt: a.seenAt,
    issues: a.issues?.length ? a.issues : undefined,
  };
};

export class Store {
  readonly file: string;
  private readonly log: (line: string) => void;
  private newerTold = false;

  constructor(file: string, log: (line: string) => void) {
    this.file = file;
    this.log = log;
  }

  /** Runs fn on the database with the feature's tables, and whether they
   * may be written; undefined when it cannot be opened (logged) or for a
   * core without a database. */
  use<T>(fn: (db: DB, writable: boolean) => T): T | undefined {
    if (!this.file) return undefined;
    let db: DB | undefined;
    try {
      db = openShared(this.file);
      let writable = true;
      try {
        db.migrate(FEATURE, MIGRATIONS);
      } catch (e) {
        if (!(e instanceof NewerError) || e.version < MIGRATIONS.length) throw e;
        writable = false;
      }
      return fn(db, writable);
    } catch (e) {
      this.log(`usage: ${(e as Error).message}`);
      return undefined;
    } finally {
      db?.close();
    }
  }

  /** The history and accounts kept; undefined when they cannot be read. */
  readHistory(): { stored: Stored; writable: boolean } | undefined {
    return this.use((db, writable) => {
      const history = new History();
      for (const r of db.all<{ account: string; win: string; points: unknown }>('SELECT account, win, points FROM usage_windows')) {
        const pts = parse(points, r.points) as Point[] | undefined;
        if (!pts) continue;
        let ws = history.windows.get(r.account);
        if (!ws) history.windows.set(r.account, (ws = new Map()));
        ws.set(r.win, pts);
      }
      const accounts: Kept[] = [];
      for (const r of db.all<{ view: unknown }>('SELECT view FROM usage_accounts ORDER BY key')) {
        const v = parse(keptView, r.view);
        if (!v) continue;
        const { key, machines, fetchedAt, seenAt, issues, ...acc } = v;
        accounts.push({
          key,
          account: acc,
          machines: machines ?? [],
          fetchedAt: fetchedAt ?? 0,
          seenAt: seenAt ?? 0,
          issues: issues?.map((i) => ({ machine: i.machine, status: i.status, code: i.code || undefined })),
          notBefore: 0,
        });
      }
      for (const r of db.all<{ key: string; record: unknown }>('SELECT key, record FROM usage_alerts')) {
        const rec = parse(alertRecord, r.record);
        if (rec) history.alerts.set(r.key, rec);
      }
      return { stored: { history, accounts }, writable };
    });
  }

  /** Writes the rows that changed and removes those gone from memory. */
  writeHistory(history: History, accounts: Iterable<Kept>): void {
    const windows = new Map<string, Buffer>();
    for (const [k, ws] of history.windows) for (const [id, pts] of ws) windows.set(`${k}\0${id}`, json(pts));
    const views = new Map<string, Buffer>();
    for (const a of accounts) if (a.key) views.set(a.key, json(keptJSON(a)));
    const alerts = new Map<string, Buffer>([...history.alerts].map(([k, r]: [string, AlertRecord]) => [k, json(r)]));
    this.use((db, writable) => {
      if (!writable) {
        if (!this.newerTold) this.log("usage: the core's database is of a newer version: the history is not kept");
        this.newerTold = true;
        return;
      }
      db.update(() => {
        for (const [k, b] of windows) {
          const [acc, win] = k.split('\0') as [string, string];
          db.run(
            `INSERT INTO usage_windows (account, win, points) VALUES (?, ?, ?)
			ON CONFLICT (account, win) DO UPDATE SET points = excluded.points WHERE points != excluded.points`,
            acc,
            win,
            b,
          );
        }
        for (const [k, b] of views)
          db.run(
            `INSERT INTO usage_accounts (key, view) VALUES (?, ?)
			ON CONFLICT (key) DO UPDATE SET view = excluded.view WHERE view != excluded.view`,
            k,
            b,
          );
        for (const [k, b] of alerts)
          db.run(
            `INSERT INTO usage_alerts (key, record) VALUES (?, ?)
			ON CONFLICT (key) DO UPDATE SET record = excluded.record WHERE record != excluded.record`,
            k,
            b,
          );
        for (const r of db.all<{ account: string; win: string }>('SELECT account, win FROM usage_windows'))
          if (!windows.has(`${r.account}\0${r.win}`)) db.run('DELETE FROM usage_windows WHERE account = ? AND win = ?', r.account, r.win);
        for (const r of db.all<{ key: string }>('SELECT key FROM usage_accounts'))
          if (!views.has(r.key)) db.run('DELETE FROM usage_accounts WHERE key = ?', r.key);
        for (const r of db.all<{ key: string }>('SELECT key FROM usage_alerts'))
          if (!alerts.has(r.key)) db.run('DELETE FROM usage_alerts WHERE key = ?', r.key);
      });
    });
  }

  /** Each kept cost report's entry by its key (machine|cost key), as JSON;
   * undefined when they cannot be read. */
  readMachineCosts(): { entries: Map<string, unknown>; writable: boolean } | undefined {
    return this.use((db, writable) => {
      const entries = new Map<string, unknown>();
      for (const r of db.all<{ mc_key: string; entry: unknown }>('SELECT mc_key, entry FROM usage_machine_costs')) {
        const e = parse(z.unknown(), r.entry);
        if (e !== undefined) entries.set(r.mc_key, e);
      }
      return { entries, writable };
    });
  }

  /** Writes a machine's cost report entry and removes the evicted ones. */
  saveMachineCost(key: string, machine: string, entry: unknown, evicted: readonly string[]): void {
    this.use((db, writable) => {
      if (!writable) return;
      db.update(() => {
        db.run(
          `INSERT INTO usage_machine_costs (mc_key, machine, entry) VALUES (?, ?, ?)
			ON CONFLICT (mc_key) DO UPDATE SET machine = excluded.machine, entry = excluded.entry WHERE entry != excluded.entry`,
          key,
          machine,
          json(entry),
        );
        for (const k of evicted) db.run('DELETE FROM usage_machine_costs WHERE mc_key = ?', k);
      });
    });
  }

  /** Removes a machine's cost reports. */
  deleteMachineCosts(machine: string): void {
    this.use((db, writable) => {
      if (writable) db.run('DELETE FROM usage_machine_costs WHERE machine = ?', machine);
    });
  }
}
