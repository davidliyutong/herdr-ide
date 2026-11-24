// An SSH machine for a test: a container of the image e2e/sshd (OpenSSH on
// Linux, the user e2e signing in with a key only) whose port 22 is
// published on 127.0.0.1 only, on a port of its own.
//
// Nothing of the user's ssh setup is used: the test's throwaway key pair,
// known_hosts entry and ssh configuration are in the instance's home, and
// the core finds an `ssh` first in its PATH that runs the system's ssh with
// that configuration only (-F: neither ~/.ssh/config, which ssh reads from
// the account's home whatever HOME says, nor /etc/ssh/ssh_config), no
// ssh agent and no other key.
//
// Containers carry the label <slug>.e2e and the runner's process id: a
// test removes its own (docker rm -f), and the next run removes those
// whose runner is gone. No other container or image is touched.

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { alive, type Instance } from './instance';
import { paths } from './paths';
import { waitFor } from './wait';

const run = promisify(execFile);
export const IMAGE = `${paths.slug}-e2e-sshd`;
const LABEL = `${paths.slug}.e2e`;
const PID_LABEL = `${paths.slug}.e2e.pid`;
/** The Host alias of the machine in the instance's ssh configuration. */
export const ALIAS = 'e2e-sshd';
/** The machine's user and home directory. */
export const USER = 'e2e';
export const HOME = '/home/e2e';

let probed: { arch?: string; reason?: string } | undefined;

/** Why SSH machines cannot run here (no Docker, nothing built for its
 * architecture), or undefined when they can. With E2E_REQUIRE_DOCKER set
 * (CI) a reason throws instead, so the tests fail rather than skip. */
export function sshUnavailable(): string | undefined {
  probed ??= probe();
  if (probed.reason && process.env.E2E_REQUIRE_DOCKER) throw new Error(`E2E_REQUIRE_DOCKER is set: ${probed.reason}`);
  return probed.reason;
}

function probe(): { arch?: string; reason?: string } {
  const info = spawnSync('docker', ['info', '--format', '{{.Architecture}}'], { encoding: 'utf8', timeout: 20_000 });
  if (info.status !== 0) return { reason: 'Docker is not available (SSH machine tests need it)' };
  const arch = { x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64' }[info.stdout.trim()];
  if (!arch) return { reason: `no machine build for Docker's architecture ${info.stdout.trim()}` };
  for (const f of [join(paths.agents, `${paths.slug}-linux-${arch}`), paths.linuxFake(arch), paths.linuxXClient(arch)]) {
    if (!existsSync(f)) return { reason: `${f} is missing: run make e2e with Docker running` };
  }
  if (spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status !== 0) {
    return { reason: `the image ${IMAGE} is missing: run make e2e with Docker running` };
  }
  if (!sshTool('ssh') || !sshTool('ssh-keygen')) return { reason: 'OpenSSH (ssh, ssh-keygen) is not installed' };
  return { arch };
}

/** The system's OpenSSH program of that name. */
function sshTool(name: string): string | undefined {
  return ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].map((d) => join(d, name)).find((p) => existsSync(p));
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { timeout: 60_000, maxBuffer: 16 << 20 });
  return stdout;
}

/** A free port on 127.0.0.1, for Docker to publish sshd on. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export class SSHMachine {
  readonly container: string;
  readonly hostname: string;
  port = 0;
  private removed = false;

  private constructor(private inst: Instance) {
    const id = randomBytes(4).toString('hex');
    this.container = `${paths.slug}-e2e-${id}`;
    this.hostname = `sshd-${id}`;
  }

  /** Starts a container for the instance and writes the instance's ssh
   * setup for it; answers once ssh signs in. */
  static async start(inst: Instance): Promise<SSHMachine> {
    sshUnavailable();
    const m = new SSHMachine(inst);
    try {
      await m.launch();
    } catch (e) {
      await m.remove();
      throw e;
    }
    return m;
  }

  private async launch() {
    const dir = join(this.inst.home, '.ssh');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = join(dir, 'id_ed25519');
    execFileSync(sshTool('ssh-keygen')!, ['-q', '-t', 'ed25519', '-N', '', '-C', 'e2e', '-f', key]);
    const pub = readFileSync(key + '.pub', 'utf8').trim();

    // Docker may give the port away between our check and its start: try another.
    for (let attempt = 0; ; attempt++) {
      this.port = await freePort();
      try {
        await docker(
          'run',
          '-d',
          '--init',
          '--name',
          this.container,
          '--hostname',
          this.hostname,
          '--label',
          `${LABEL}=1`,
          '--label',
          `${PID_LABEL}=${process.pid}`,
          '-p',
          `127.0.0.1:${this.port}:22`,
          '-e',
          `E2E_AUTHORIZED_KEY=${pub}`,
          IMAGE,
        );
        break;
      } catch (e) {
        await docker('rm', '-f', this.container).catch(() => '');
        if (attempt >= 2 || !/port is already allocated|address already in use/i.test(String(e))) throw e;
      }
    }
    // The fake coding agent and the test X program, in the PATH of the
    // machine's login shells.
    await docker('cp', paths.linuxFake(probed!.arch!), `${this.container}:/usr/local/bin/kimi`);
    await docker('cp', paths.linuxXClient(probed!.arch!), `${this.container}:/usr/local/bin/e2e-xclient`);
    await waitFor(async () => (await this.root('test -f /run/e2e-ready && echo ok')).trim() === 'ok', {
      what: 'sshd in the container',
      timeout: 20_000,
    });
    const hostKey = (await this.root('cat /etc/ssh/ssh_host_ed25519_key.pub')).trim().split(/\s+/).slice(0, 2).join(' ');
    writeFileSync(join(dir, 'known_hosts'), `${ALIAS} ${hostKey}\n`, { mode: 0o600 });
    const config = [
      `Host ${ALIAS}`,
      `  HostName 127.0.0.1`,
      `  Port ${this.port}`,
      `  User ${USER}`,
      `  HostKeyAlias ${ALIAS}`,
      `Host *`,
      `  IdentityFile ${key}`,
      `  IdentitiesOnly yes`,
      `  IdentityAgent none`,
      `  UserKnownHostsFile ${join(dir, 'known_hosts')}`,
      `  GlobalKnownHostsFile /dev/null`,
      `  StrictHostKeyChecking yes`,
      `  UpdateHostKeys no`,
      `  PasswordAuthentication no`,
      `  KbdInteractiveAuthentication no`,
      `  LogLevel ERROR`,
      '',
    ].join('\n');
    writeFileSync(join(dir, 'config'), config, { mode: 0o600 });
    const ssh = join(this.inst.bin, 'ssh');
    writeFileSync(ssh, `#!/bin/sh\nexec ${sshTool('ssh')} -F '${join(dir, 'config')}' "$@"\n`);
    chmodSync(ssh, 0o755);
    // Signed in once: Docker's port forwarding is up too.
    await waitFor(
      async () => {
        await run(ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', ALIAS, 'true'], {
          timeout: 15_000,
          env: { PATH: '/usr/bin:/bin' },
        });
        return true;
      },
      { what: `ssh ${ALIAS}`, timeout: 20_000 },
    );
  }

  /** Runs a shell command in the container as root. */
  root(command: string): Promise<string> {
    return docker('exec', this.container, 'sh', '-c', command);
  }

  /** Runs a shell command in the container as the machine's user. */
  user(command: string): Promise<string> {
    return docker('exec', '-u', USER, '-w', HOME, this.container, 'sh', '-c', command);
  }

  /** The command lines of the container's processes. */
  async processes(): Promise<string[]> {
    const out = await this.root('ps -o args');
    return out
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /** Takes the machine off the network as far as ssh can tell: every sshd
   * process ends (the listener and the connections), so the connection
   * drops and new ones are refused. The container and its processes, the
   * terminal core among them, keep running. */
  async offline() {
    await this.root('pkill sshd; true');
    await waitFor(async () => !(await this.processes()).some((p) => /sshd/.test(p)), { what: 'sshd to end' });
  }

  /** Lets ssh in again. */
  async online() {
    await this.root('/usr/sbin/sshd -E /var/log/sshd.log');
  }

  /** Removes the container (also when it is gone already). */
  async remove() {
    if (this.removed) return;
    this.removed = true;
    await docker('rm', '-f', '-v', this.container).catch(() => '');
  }
}

/** Removes the containers earlier runs left: those with our label whose
 * runner is gone. */
export function sweepContainers() {
  const ls = spawnSync('docker', ['ps', '-a', '--filter', `label=${LABEL}`, '--format', `{{.ID}} {{.Label "${PID_LABEL}"}}`], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (ls.status !== 0) return;
  const gone = ls.stdout
    .split('\n')
    .map((l) => l.trim().split(' '))
    .filter(([id, pid]) => id && !(Number(pid) > 0 && alive(Number(pid))))
    .map(([id]) => id);
  if (gone.length) spawnSync('docker', ['rm', '-f', '-v', ...gone], { stdio: 'ignore', timeout: 60_000 });
}
