// Machines as the UI manages them: the list and its order, adding an ssh
// machine (with the Host aliases of the user's ssh configuration to choose
// from), renaming, enabling, removing; an interactive ssh login in a
// terminal on the core's host; and the machines' states and agents' events
// on /ws.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { sample } from '#shared/host/perf.ts';
import { defineFeature } from '#kernel/feature.ts';
import { Fail } from '#kernel/fail.ts';
import { jsonBody } from '#kernel/http/app.ts';
import { CloseCode } from '#kernel/channel.ts';
import { validTarget } from '#kernel/machines/spec.ts';
import { authCommand } from '#kernel/machines/transport/ssh.ts';
import type { SpawnPty } from '#kernel/pty.ts';
import { read as readSSHConfig, type Host } from './sshconfig.ts';

/** A label: short, without control characters (no odd bytes in the audit
 * log). */
const MAX_LABEL = 64;
const validLabel = (l: string) => [...l].length <= MAX_LABEL && !/\p{Cc}/u.test(l);

/** The host of an ssh target: without ssh://, the user and the port ("gpu"
 * for "ssh://me@gpu:22" and "me@gpu"). */
export function targetHost(t: string): string {
  t = t.replace(/^ssh:\/\//, '');
  const at = t.lastIndexOf('@');
  if (at >= 0) t = t.slice(at + 1);
  if (t.startsWith('[')) {
    const end = t.indexOf(']');
    if (end > 0) return t.slice(1, end);
  }
  const colon = t.indexOf(':');
  if (colon >= 0 && t.split(':').length === 2) t = t.slice(0, colon);
  return t;
}

/** Machine ids appear in URLs and in per-machine settings, so they are
 * random, never derived from what the user typed. */
const newMachineID = () => randomBytes(8).toString('hex');

/** A registry or manager failure that is not a Fail: the file could not be
 * written. fn may be async (removing waits for the session's end). */
const saving = <T>(fn: () => T): T => {
  const fail = (e: unknown): never => {
    if (e instanceof Fail) throw e;
    throw new Fail('save', 500, (e as Error).message);
  };
  try {
    const r = fn();
    return (r instanceof Promise ? r.catch(fail) : r) as T;
  } catch (e) {
    return fail(e);
  }
};

export interface MachinesFeatureOptions {
  /** The core host user's home, whose ~/.ssh/config the Add Machine dialog
   * lists. */
  home: () => string;
  /** The directory of ssh's control sockets; "" where ssh shares no
   * connections (Windows): there is no login in the UI then. */
  controlDir: string;
  /** Terminals on the core's host, for the ssh login; undefined where the
   * host has none. */
  pty?: SpawnPty;
  /** How long the login's last output is forwarded after ssh exited. */
  ptyDrainMs?: number;
}

const label = z.string().transform((s) => s.trim());

export const machinesFeature = (o: MachinesFeatureOptions) =>
  defineFeature({
    id: 'machines',
    toggle: false,
    audit: 'machine',
    setup(ctx) {
      const { machines, pages } = ctx;
      const broadcastList = () => pages.broadcast({ t: 'machines', list: machines.states() });

      // What a page starts from and follows.
      pages.onOpen((p) => {
        p.send({ t: 'machines', list: machines.states() });
        return machines.subscribe({
          state: (state) => p.send({ t: 'machine', state }),
          agent: (ev) => p.send({ t: 'agent', m: ev.m, data: ev.data, sound: pages.soundPage() === p }),
        });
      });
      // Ends the wait before a machine's next connection attempt; not for
      // watchers, as an attempt may start an ssh login.
      pages.on('retry', (p, m) => {
        const mc = typeof m.m === 'string' ? machines.get(m.m) : undefined;
        if (!mc) return;
        if (p.readOnly) return ctx.audit.log(p.who, 'denied.retry', { machine: m.m });
        mc.wake();
      });

      const api = ctx.route('/api');
      api.get('/machines', (c) => c.json(machines.states()));
      api.get('/perf', (c) => c.json(sample()));

      // The Host aliases of the core host's ssh configuration that are no
      // machine's target yet: each alias with its HostName and User,
      // nothing else. Only pages that may add machines get it.
      api.get('/ssh/hosts', ctx.writable, async (c) => {
        const home = o.home();
        if (!home) return c.json([]);
        const added = new Set<string>();
        for (const st of machines.states())
          if (st.kind === 'ssh' && st.target) {
            added.add(st.target.toLowerCase());
            added.add(targetHost(st.target).toLowerCase());
          }
        const hosts: Host[] = (await readSSHConfig(home)).filter((h) => validTarget(h.alias) && !added.has(h.alias.toLowerCase()));
        return c.json(hosts);
      });

      // Adds an ssh machine: stored, then connected. The answer is its
      // state; whether it connects, needs a login or fails follows on /ws.
      api.post(
        '/machines',
        ctx.mutating('add'),
        jsonBody(z.object({ target: z.string().optional().default(''), label: label.optional().default('') }), {
          limit: 4 << 10,
          code: 'invalid',
        }),
        (c) => {
          const body = c.req.valid('json');
          const target = body.target.trim();
          Object.assign(c.var.audit, { target, label: body.label || target });
          if (!validTarget(target)) throw new Fail('invalid_target', 400);
          if (!validLabel(body.label)) throw new Fail('invalid', 400, 'invalid label');
          const id = newMachineID();
          c.var.audit.machine = id;
          const m = saving(() => machines.add({ id, label: body.label || target, target }));
          broadcastList();
          return c.json(m.state(), 201);
        },
      );

      // Puts the machines in an order, each once; every page gets the list.
      api.put(
        '/machines/order',
        ctx.mutating('order'),
        jsonBody(z.object({ order: z.array(z.string()) }), { limit: 16 << 10, code: 'invalid' }),
        (c) => {
          const { order } = c.req.valid('json');
          c.var.audit.order = order;
          saving(() => machines.setOrder(order));
          broadcastList();
          return c.json(machines.states());
        },
      );

      const one = ctx.route('/api/m/:id');
      // Removes an ssh machine: its record goes, its session ends (its
      // terminal core and programs keep running there) and it leaves every
      // page. The local machine stays.
      one.delete('/', ctx.mutating('remove'), async (c) => {
        const m = c.var.machine;
        c.var.audit.target = m.target;
        await saving(() => machines.remove(m.id));
        ctx.forget(m.id);
        broadcastList();
        return c.json({ removed: m.id });
      });

      one.put('/label', ctx.mutating('rename'), jsonBody(z.object({ label }), { limit: 1 << 10, code: 'invalid' }), (c) => {
        const m = c.var.machine;
        const { label } = c.req.valid('json');
        Object.assign(c.var.audit, { from: m.label, label });
        if (!label || !validLabel(label)) throw new Fail('invalid', 400, 'invalid label');
        saving(() => machines.setLabel(m.id, label));
        return c.json(m.state());
      });

      const enabled = z.object({ enabled: z.boolean() });
      one.put('/enabled', ctx.mutating('enable'), jsonBody(enabled, { limit: 1 << 10, code: 'invalid' }), (c) => {
        const m = c.var.machine;
        const on = c.req.valid('json').enabled;
        if (!on) c.set('event', 'disable');
        saving(() => machines.setEnabled(m.id, on));
        return c.json(m.state());
      });

      // An interactive ssh login in a terminal on the core's host, bridged
      // to a channel. The control master it creates is reused by the
      // BatchMode connections afterwards; without a control directory
      // (Windows) a login would hold nothing, and it is refused.
      one.get('/auth', ctx.writable, (c) => {
        const m = c.var.machine;
        if (m.kind !== 'ssh') throw new Fail('not_ssh', 400, 'not an ssh machine');
        // A stored target validTarget refuses never reaches ssh.
        if (!validTarget(m.target)) throw new Fail('invalid_target', 400);
        if (!o.controlDir || !o.pty) throw new Fail('ssh_login_unsupported', 501);
        if (!c.env.upgrade) throw new Fail('upgrade_required', 426);
        ctx.audit.log(c.var.who, 'ssh.auth', { machine: m.id, target: m.target });
        const cols = Number(c.req.query('cols'));
        const rows = Number(c.req.query('rows'));
        const size = cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000 ? { cols, rows } : { cols: 100, rows: 24 };
        const spawn = o.pty;
        return c.env.upgrade((ch) => {
          const pty = spawn(authCommand(o.controlDir, m.target), size);
          let last = Date.now();
          pty.onData((d) => {
            last = Date.now();
            ch.send(d);
          });
          void pty.exited.then(async () => {
            // The last output may still be in the terminal: forward it until
            // it is quiet, but do not wait long for descendants that keep it
            // open.
            const until = Date.now() + (o.ptyDrainMs ?? 2000);
            while (Date.now() - last < 100 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
            ch.close(CloseCode.Normal, 'done');
            m.wake();
          });
          return {
            message: (data) => pty.write(data),
            close: () => pty.kill(),
          };
        });
      });
    },
  });
