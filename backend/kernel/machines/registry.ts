// The core's own list of machines, in the machines file beside its
// settings: the ssh machines added from the UI and, once it was enabled,
// disabled or renamed, a record of the local machine. Machines given with
// --ssh are not in it. Every change is written at once; the file is the
// core's, read when it starts. Writing it keeps what this version does not
// use: entries it cannot read as machines (not an object, no id, an id
// already taken, a kind it does not have), fields of records and of the
// file it does not know, and machines whose target validTarget refuses
// (they are listed, in error, and never dialed).
import { z } from 'zod';
import { read, write } from '#shared/host/userfile.ts';
import { Fail } from '../fail.ts';
import { LOCAL_ID, validTarget, type Spec } from './spec.ts';

/** The version of the machines file this core writes. */
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

export class Registry {
  private readonly path: string;
  private entries: Entry[] = [];
  private order: string[] = [];
  private version = VERSION;
  private extra: Json = {};

  private constructor(path: string) {
    this.path = path;
  }

  /** A registry that keeps nothing on disk. */
  static memory(): Registry {
    return new Registry('');
  }

  /** Reads the machines file at path; a missing file is an empty list. A
   * file that is not a machines file fails, and the core then keeps its
   * machines in memory only. */
  static open(path: string): Registry {
    const r = new Registry(path);
    const { data } = read(path);
    if (data === null) return r;
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
      r.version = version;
    }
    if (machines !== undefined && machines !== null && !Array.isArray(machines)) throw new Error(`${path}: machines is not a list`);
    if (order !== undefined && order !== null && !(Array.isArray(order) && order.every((x) => typeof x === 'string')))
      throw new Error(`${path}: order is not a list of ids`);
    r.order = (order as string[] | null) ?? [];
    r.extra = extra;
    for (const e of (machines as unknown[] | null) ?? []) r.entries.push(r.parse(e));
    return r;
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
    const i = this.index(spec.id);
    const prev = i >= 0 ? (this.entries[i] as { spec: Spec; extra: Json }) : undefined;
    if (spec.kind === 'ssh' && !validTarget(spec.target ?? '') && prev?.spec.target !== spec.target)
      throw new Fail('invalid_target', 400, 'invalid ssh target');
    this.change(() => {
      if (prev) this.entries[i] = { spec, extra: prev.extra };
      else this.entries.push({ spec, extra: {} });
    });
  }

  delete(id: string): void {
    const i = this.index(id);
    if (i >= 0) this.change(() => this.entries.splice(i, 1));
  }

  getOrder(): string[] {
    return [...this.order];
  }

  setOrder(ids: readonly string[]): void {
    this.change(() => (this.order = [...ids]));
  }

  /** Applies a change and writes the file; a failed write undoes it. */
  private change(fn: () => void): void {
    const entries = [...this.entries];
    const order = this.order;
    fn();
    try {
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
    write(this.path, JSON.stringify({ ...top, ...sorted(this.extra) }, null, 2) + '\n');
  }
}

/** The members of o sorted by name. */
const sorted = (o: Json): Json => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
