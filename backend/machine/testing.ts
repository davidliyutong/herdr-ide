// Helpers of the machine side's tests: a home of their own (short, below
// /tmp: macOS limits unix socket paths to 104 bytes), an agent on it, and
// the hub's side of a session with it (the kernel's Session, so the tests
// speak the wire as the hub does).
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { duplexPair } from 'node:stream';
import { dirsOf, makeDirs, type Dirs } from '#shared/host/hostdirs.ts';
import { DATA_DIR_NAME } from '#shared/lib/brand.ts';
import { discard, type Logger } from '#shared/lib/log.ts';
import { Session } from '#kernel/machines/transport/session.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import { Agent } from './agent.ts';
import type { MachineSide } from './feature.ts';
import type { FsCalls } from './fsops.ts';

/** A temporary home directory, removed by its remove(). */
export function tempHome(): { home: string; remove(): void } {
  const home = realpathSync(mkdtempSync('/tmp/hm-'));
  return { home, remove: () => rmSync(home, { recursive: true, force: true, maxRetries: 5 }) };
}

/** Runs f with $HOME set to a temporary home, restored after. */
export async function withHome<T>(f: (home: string) => Promise<T>): Promise<T> {
  const h = tempHome();
  const was = process.env.HOME;
  process.env.HOME = h.home;
  try {
    return await f(h.home);
  } finally {
    process.env.HOME = was;
    h.remove();
  }
}

export interface Rig {
  home: string;
  dirs: Dirs;
  agent: Agent;
  /** The hub's side of a session with the agent. */
  session: Session;
  /** Another session of the same agent (a second hub). */
  connect(client?: string): Session;
  close(): Promise<void>;
}

/** An agent for the default instance on a new home, with a session. */
export async function rig(
  o: {
    features?: MachineSide[];
    logger?: Logger;
    client?: string;
    sshConn?: string;
    fs?: Partial<FsCalls>;
    peerCred?: (c: import('node:net').Socket) => { pid: number; uid: number };
    carryHC?: () => { gz: Buffer; digest: string } | null;
  } = {},
): Promise<Rig> {
  const h = tempHome();
  const dirs = dirsOf(`${h.home}/${DATA_DIR_NAME}`);
  makeDirs(dirs);
  const agent = new Agent({
    instance: '',
    dirs,
    logger: o.logger ?? discard,
    features: o.features ?? [],
    socketWatchMs: 50,
    fs: o.fs,
    peerCred: o.peerCred,
    carryHC: o.carryHC,
  });
  const sessions: Session[] = [];
  const connect = (client = o.client ?? 'hub-1', sshConn = o.sshConn ?? '') => {
    const [a, b] = duplexPair();
    void agent.serve(a, client, sshConn);
    const s = new Session(b, () => b.destroy());
    sessions.push(s);
    return s;
  };
  const session = connect();
  return {
    home: h.home,
    dirs,
    agent,
    session,
    connect,
    async close() {
      for (const s of sessions) s.close();
      await agent.close();
      h.remove();
    },
  };
}

/** Waits until cond holds, at most ms. */
export async function until(cond: () => boolean | Promise<boolean>, what = 'the condition', ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A machine of the kernel whose agent is reached through s: the hub's
 * own call and open (#kernel/agent.ts) run a feature's actions through the
 * wire, its params and results checked by the protocol's schemas as the
 * hub checks them. */
export const machineOf = (s: Session): Machine =>
  ({ open: (h: never, o: never) => s.open(h, o), request: (h: never, o: never) => s.request(h, o) }) as unknown as Machine;
