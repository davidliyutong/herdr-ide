// GPUs and the display (docs/features/14-gui-windows.md, "GPUs"; the Go
// agent's guigpu.go). The GPU display is Xwayland drawing with one GPU: the
// driver's first NVIDIA GPU where there are any, because NVIDIA's driver
// shows windows of Vulkan programs only from that one whatever the display
// draws with, and shares buffers with the display only on the same GPU;
// else the first GPU whose render node the user may open.
import { constants } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import type { GUIGPU } from '#shared/proto/agentproto/index.ts';

/** Where the kernel describes GPUs; tests give their own. */
export interface GPUPaths {
  nvidiaProc: string;
  drmSys: string;
  drmDev: string;
}

export const GPU_PATHS: GPUPaths = { nvidiaProc: '/proc/driver/nvidia/gpus', drmSys: '/sys/class/drm', drmDev: '/dev/dri' };

/** A UUID goes into a terminal's environment and is matched there. */
export const GPU_UUID = /^GPU-[0-9a-fA-F-]{8,64}$/;

/** The machine's NVIDIA GPUs in PCI bus order, which is nvidia-smi's, from
 * what the driver says about each (readable by anyone). */
export async function nvidiaGPUs(p: GPUPaths = GPU_PATHS): Promise<GUIGPU[]> {
  let names: string[];
  try {
    names = await readdir(p.nvidiaProc);
  } catch {
    return [];
  }
  names.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
  const out: GUIGPU[] = [];
  for (const name of names) {
    let info: string;
    try {
      info = await readFile(posix.join(p.nvidiaProc, name, 'information'), 'utf8');
    } catch {
      continue;
    }
    const g: GUIGPU = { index: 0, minor: -1, uuid: '', pci: name.toLowerCase() };
    let excluded = false;
    for (const line of info.split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k === 'Model') g.model = v;
      else if (k === 'GPU UUID') g.uuid = v;
      else if (k === 'Device Minor') {
        if (/^\d+$/.test(v)) g.minor = Number(v);
      } else if (k === 'GPU Excluded') excluded = v.toLowerCase() === 'yes';
    }
    if (excluded || g.minor < 0 || !GPU_UUID.test(g.uuid)) continue;
    g.index = out.length;
    if (!g.model) delete g.model;
    out.push(g);
  }
  return out;
}

export interface RenderNode {
  path: string;
  pci: string;
  driver: string;
}

/** The render nodes of the machine's GPUs in their order, with each one's
 * PCI address and driver. */
export async function renderNodes(p: GPUPaths = GPU_PATHS): Promise<RenderNode[]> {
  let names: string[];
  try {
    names = await readdir(p.drmDev);
  } catch {
    return [];
  }
  const nodes = names
    .filter((n) => /^renderD\d+$/.test(n))
    .map((n) => ({ n: Number(n.slice(7)), name: n }))
    .sort((a, b) => a.n - b.n);
  const out: RenderNode[] = [];
  for (const { name } of nodes) {
    const r: RenderNode = { path: posix.join(p.drmDev, name), pci: '', driver: '' };
    try {
      const dev = await realpath(posix.join(p.drmSys, name, 'device'));
      r.pci = posix.basename(dev).toLowerCase();
      try {
        r.driver = posix.basename(await realpath(posix.join(dev, 'driver')));
      } catch {
        // none
      }
    } catch {
      // not described
    }
    out.push(r);
  }
  return out;
}

/** Whether the user may open path for reading and writing. */
export async function openable(path: string): Promise<boolean> {
  try {
    const f = await open(path, constants.O_RDWR | constants.O_NONBLOCK);
    await f.close();
    return true;
  } catch {
    return false;
  }
}

/** The GPU the display draws with: its render node, whether NVIDIA's
 * driver runs it, and then its minor. */
export async function gpuNode(
  gpus: readonly GUIGPU[],
  p: GPUPaths = GPU_PATHS,
): Promise<{ node: string; nvidia: boolean; minor?: number }> {
  const nodes = await renderNodes(p);
  if (gpus.length > 0) {
    let first = gpus[0];
    for (const g of gpus) if (g.minor < first.minor) first = g;
    for (const r of nodes) if (r.pci === first.pci && (await openable(r.path))) return { node: r.path, nvidia: true, minor: first.minor };
  }
  for (const r of nodes) {
    if (!(await openable(r.path))) continue;
    if (r.driver === 'nvidia') {
      const g = gpus.find((x) => x.pci === r.pci);
      return { node: r.path, nvidia: true, ...(g ? { minor: g.minor } : {}) };
    }
    return { node: r.path, nvidia: false };
  }
  return { node: '', nvidia: false };
}

/** Whether path is a regular file with an execute bit (Go agent's
 * isExecutable). */
export async function isExecutable(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** The first of name in the directories of PATH that is executable. */
export async function lookPath(name: string, path = process.env.PATH ?? ''): Promise<string> {
  for (const d of path.split(':')) {
    if (!d) continue;
    const p = posix.join(d, name);
    if (await isExecutable(p)) return p;
  }
  return '';
}

/** An Xwayland on the machine. */
export async function findXwayland(path?: string): Promise<string> {
  const p = await lookPath('Xwayland', path);
  if (p) return p;
  for (const c of ['/usr/bin/Xwayland', '/usr/local/bin/Xwayland']) if (await isExecutable(c)) return c;
  return '';
}
