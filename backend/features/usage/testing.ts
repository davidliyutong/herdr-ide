// Helpers of the feature's tests, never used by the product: a scheduler
// over machines whose agents answer what a test gives them, at a clock of
// the test's, with its settings and database in a temporary directory.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discard } from '#shared/lib/log.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import { account, costReport, window, type Account, type CostParams, type CostReport, type LimitsParams } from './protocol.ts';
import { settings } from './settings.ts';
import { coreDBFile, Store } from './store.ts';
import { Usage, type Snapshot } from './usage.ts';

const dirs: string[] = [];

/** A new temporary directory, removed by removeTempDirs. */
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tu-'));
  dirs.push(d);
  return d;
}

export function removeTempDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** The tests' clock starts here (Unix seconds). */
export const T0 = 1_800_000_000;

/** An account as an agent's answer decodes. */
export const acc = (a: Record<string, unknown>): Account => account.parse(a);
export const win = (kind: string, usedPct: number, resetsAt = 0, windowSec = 0, label = '') =>
  window.parse({ kind, label, usedPct, resetsAt, windowSec });
export const report = (r: Record<string, unknown>): CostReport => costReport.parse(r);

/** What the machines' agents answer. */
export interface Fakes {
  limits: (m: string, p: LimitsParams) => Account[] | Promise<Account[]>;
  cost: (m: string, p: CostParams, signal: AbortSignal) => CostReport | Promise<CostReport>;
  status: (url: string) => Promise<unknown>;
}

/** An account of the snapshot. */
export interface View {
  key: string;
  provider: string;
  status: string;
  code?: string;
  plan?: string;
  machines: string[];
  fetchedAt?: number;
  issues?: { machine: string; status: string; code?: string }[];
  windows: { id: string; usedPct: number; pace?: { expectedPct: number; exhaustsAt?: number; beforeReset?: boolean } }[];
}

export const find = (s: { accounts: View[] }, key: string) => s.accounts.find((a) => a.key === key);

/** A scheduler of the machines ready (env.ready) whose agents answer with
 * f, its settings file in dir, at a clock that starts at T0. */
export function testUsage(o: { ready?: string[]; dir?: string; known?: string[]; now?: number } = {}) {
  const dir = o.dir ?? tempDir();
  const st = new Settings(join(dir, 'settings-dev.json'), { modules: [settings] });
  const clock = { now: o.now ?? T0 * 1000 };
  const sent: Snapshot[] = [];
  const f: Fakes = {
    limits: () => [],
    cost: () => report({}),
    status: () => Promise.reject(new Error('no status pages in tests')),
  };
  const env = { ready: o.ready ?? ['local'], readOnly: false };
  const u = new Usage({
    settings: st,
    limits: async (m, p) => f.limits(m, p),
    cost: async (m, p, signal) => f.cost(m, p, signal),
    ready: () => env.ready,
    known: (m) => (o.known ?? env.ready).includes(m),
    readOnly: () => env.readOnly,
    enabled: () => true,
    broadcast: (s) => void sent.push(s),
    log: discard,
    store: new Store(coreDBFile(st.path), discard),
    now: () => clock.now,
    status: (url) => f.status(url),
  });
  const signal = new AbortController().signal;
  return {
    u,
    st,
    f,
    env,
    clock,
    sent,
    dir,
    sec: () => Math.floor(clock.now / 1000),
    poll: () => u.poll(signal),
    snap: () => u.snapshot() as Snapshot & { accounts: View[] },
    report: (days: number, tz: number, s = signal) => u.spend.report(days, tz, s),
  };
}
