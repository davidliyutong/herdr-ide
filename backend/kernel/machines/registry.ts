// The hub's list of machines, in the machines file beside its settings:
// the ssh machines added from the UI and, once it was enabled, disabled or
// renamed, a record of the local machine. Machines given with --ssh are not
// in it. Every hub of the namespace shares the file (paths.ts): a change
// reads the file again first when someone else changed it, so it applies
// to what the others wrote, and is written at once; watch reads what they
// change meanwhile. Writing it keeps what this version does not use:
// entries it cannot read as machines (not an object, no id, an id already
// taken, a kind it does not have), fields of records and of the file it
// does not know, and machines whose target validTarget refuses (they are
// listed, in error, and never dialed). A file changed into one that is no
// machines file keeps the list read before and refuses changes until it
// is fixed.
import { z } from 'zod';
import { read, sameSig, stat, write, type Sig } from '#shared/host/userfile.ts';
import { Fail } from '../fail.ts';
import { LOCAL_ID, validTarget, type Spec } from './spec.ts';

/** The version of the machines file this hub writes. */
const VERSION = 1;

type Json = Record<string, unknown>;

/** A machine and the fields this version does not know, or an entry that
 * is no machine this version can use, kept as written. */
type Entry = { spec: Spec; extra: Json } | { raw: unknown };

const record = z.object({
  id: z.string(),
  label: z.string().optional().default(''),
  kind: z.string().optional().default(''),
  target: z.string().optional(),
  enabled: z.boolean().optional().default(false),
});
const SPEC_FIELDS = ['id', 'label', 'kind', 'target', 'enabled'];

/** A stored record as a Spec: the local machine's with only what it keeps;
 * an ssh machine's labelled with its target (its id when the target is
 * refused). null for a record of no machine. */
function normalize(r: z.output<typeof record>): Spec | null {
  if (r.id === LOCAL_ID) return { id: LOCAL_ID, label: r.label, kind: 'local', enabled: r.enabled };
  if (r.id === '' || (r.kind !== '' && r.kind !== 'ssh')) return null;
  const target = r.target ?? '';
  const label = r.label || (validTarget(target) ? target : r.id);
  return { id: r.id, label, kind: 'ssh', ...(target ? { target } : {}), enabled: r.enabled };
}

/** How often watch looks at the file, in ms. */
const POLL_MS = 2000;

export class Registry {
  private readonly path: string;
  private entries: Entry[] = [];
  private order: string[] = [];
  private version = VERSION;
  private extra: Json = {};
  /** The version of the file last read or written. */
  private sig: Sig | undefined;
  /** Why the file last read is no machines file ("" when it is one). */
  private broken = '';
  /** A change read what someone else wrote, which watch has not told. */
  private unseen = false;

  private constructor(path: string) {
    this.path = path;
  }

  /** A registry that keeps nothing on disk. */
  static memory(): Registry {
    return new Registry('');
  }

  /** Reads the machines file at path; a missing file is an empty list. A
   * file that is not a machines file fails, and the hub then keeps its
   * machines in memory only. */
  static open(path: string): Registry {
    const r = Registry.read(path);
    if (r.broken) throw new Error(r.broken);
    return r;
  }

  /** The machines file at path as it is now, broken when it is no
   * machines file. */
  private static read(path: string): Registry {
    const { data, sig } = read(path);
    const r = new Registry(path);
    r.sig = sig;
    try {
      r.parseFile(data);
    } catch (e) {
      r.broken = (e as Error).message;
    }
    return r;
  }

  private parseFile(data: Buffer | null): void {
    const path = this.path;
    if (data === null) return;
    let top: unknown;
    try {
      top = JSON.parse(data.toString('utf8'));
    } catch (e) {
      throw new Error(`${path}: ${(e as Error).message}`);
    }
    if (typeof top !== 'object' || top === null || Array.isArray(top) || !('version' in top || 'machines' in top))
      throw new Error(`${path}: not a machines file (no version or machines)`);
    const { version, machines, order, ...extra } = top as Json;
    if (version !== undefined) {
      if (typeof version !== 'number') throw new Error(`${path}: version is not a number`);
      this.version = version;
    }
    if (machines !== undefined && machines !== null && !Array.isArray(machines)) throw new Error(`${path}: machines is not a list`);
    if (order !== undefined && order !== null && !(Array.isArray(order) && order.every((x) => typeof x === 'string')))
      throw new Error(`${path}: order is not a list of ids`);
    this.order = (order as string[] | null) ?? [];
    this.extra = extra;
    for (const e of (machines as unknown[] | null) ?? []) this.entries.push(this.parse(e));
  }

  /** Whether someone else changed the file since it was last read or
   * written. */
  private changed(): boolean {
    if (!this.path) return false;
    const now = stat(this.path);
    return this.sig ? !sameSig(now, this.sig) : now.exists;
  }

  /** Reads the file again when someone else changed it; true when the
   * list may have changed. A file that cannot be read is tried again at
   * the next call; one that is no machines file keeps the list as it was
   * (and changes are refused) until it is fixed, and so does one
   * removed. */
  reload(): boolean {
    if (!this.changed()) return false;
    const had = this.sig?.exists ?? false;
    const fresh = Registry.read(this.path);
    this.sig = fresh.sig;
    this.broken = fresh.broken;
    // A file removed takes no machine away (each would be forgotten, as
    // removed ones are): the next change writes the list again.
    if (fresh.broken || (had && !fresh.sig?.exists)) return false;
    this.entries = fresh.entries;
    this.order = fresh.order;
    this.version = fresh.version;
    this.extra = fresh.extra;
    return true;
  }

  /** Reads the file again whenever someone else changes it, looking every
   * everyMs, and calls onChange after a read that may have changed the
   * list (its own, or a change's), until signal aborts. A file that cannot
   * be read is logged once until it can be again. */
  watch(signal: AbortSignal, onChange: () => void, logger: (line: string) => void, everyMs = POLL_MS): Promise<void> {
    return new Promise((resolve) => {
      if (!this.path || signal.aborted) return resolve();
      let failing = '';
      let reported = this.broken;
      const look = () => {
        try {
          const changed = this.reload() || this.unseen;
          this.unseen = false;
          failing = '';
          if (this.broken !== reported) {
            reported = this.broken;
            if (this.broken) logger(`machines are not reread: ${this.broken}`);
          }
          if (changed) onChange();
        } catch (e) {
          const why = (e as Error).message;
          if (why !== failing) logger(`machines are not reread: ${why}`);
          failing = why;
        }
      };
      const t = setInterval(look, everyMs);
      signal.addEventListener(
        'abort',
        () => {
          clearInterval(t);
          resolve();
        },
        { once: true },
      );
    });
  }

  private parse(e: unknown): Entry {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return { raw: e };
    const p = record.safeParse(e);
    const spec = p.success ? normalize(p.data) : null;
    if (!spec || this.index(spec.id) >= 0) return { raw: e };
    const extra = Object.fromEntries(Object.entries(e).filter(([k]) => !SPEC_FIELDS.includes(k)));
    return { spec, extra };
  }

  private index(id: string): number {
    return this.entries.findIndex((e) => 'spec' in e && e.spec.id === id);
  }

  /** The machines the file holds. */
  specs(): Spec[] {
    return this.entries.flatMap((e) => ('spec' in e ? [{ ...e.spec }] : []));
  }

  /** How many entries are kept that are no machine of this version. */
  kept(): number {
    return this.entries.filter((e) => 'raw' in e).length;
  }

  get(id: string): Spec | undefined {
    const i = this.index(id);
    return i >= 0 ? { ...(this.entries[i] as { spec: Spec }).spec } : undefined;
  }

  /** Adds or replaces the record of s.id and writes the file. A target
   * validTarget refuses is taken only when the record had it already. */
  put(s: Spec): void {
    const spec = normalize({ ...s, target: s.target });
    if (!spec) throw new Error('machine record without an id');
    this.change(() => {
      const i = this.index(spec.id);
      const prev = i >= 0 ? (this.entries[i] as { spec: Spec; extra: Json }) : undefined;
      if (spec.kind === 'ssh' && !validTarget(spec.target ?? '') && prev?.spec.target !== spec.target)
        throw new Fail('invalid_target', 400, 'invalid ssh target');
      if (prev) this.entries[i] = { spec, extra: prev.extra };
      else this.entries.push({ spec, extra: {} });
    });
  }

  delete(id: string): void {
    this.change(() => {
      const i = this.index(id);
      if (i >= 0) this.entries.splice(i, 1);
    });
  }

  getOrder(): string[] {
    return [...this.order];
  }

  setOrder(ids: readonly string[]): void {
    this.change(() => (this.order = [...ids]));
  }

  /** Applies a change to the file as it is now and writes it; a change
   * that throws or a failed write leaves the list as it was. */
  private change(fn: () => void): void {
    if (this.reload()) this.unseen = true;
    if (this.broken) throw new Error(this.broken);
    const entries = [...this.entries];
    const order = this.order;
    try {
      fn();
      this.save();
    } catch (e) {
      this.entries = entries;
      this.order = order;
      throw e;
    }
  }

  private save(): void {
    if (!this.path) return;
    const machines = this.entries.map((e) => {
      if ('raw' in e) return e.raw;
      const { id, label, kind, target, enabled } = e.spec;
      return { id, label, kind, ...(target ? { target } : {}), enabled, ...sorted(e.extra) };
    });
    const top: Json = { version: Math.max(this.version, VERSION), machines };
    if (this.order.length) top.order = this.order;
    this.sig = write(this.path, JSON.stringify({ ...top, ...sorted(this.extra) }, null, 2) + '\n');
  }
}

/** The members of o sorted by name. */
const sorted = (o: Json): Json => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
