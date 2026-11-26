// GPUs: NVIDIA's through nvidia-smi, AMD's and Intel's through the DRM
// class of sysfs (amdgpu exposes gpu_busy_percent, VRAM and its hwmon),
// Apple's through the IOAccelerator registry (darwin.ts).
import { join } from 'node:path';
import type { Bounded } from './io.ts';
import { clampPct, parseInt10, parseNum, parseOptional, parseUint, round1 } from './num.ts';
import type { GPU } from './types.ts';

/** nvidia-smi's arguments for the GPUs (parseNvidiaGPUs). */
export const NVIDIA_GPUS = [
  '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit',
  '--format=csv,noheader,nounits',
];
/** nvidia-smi's arguments for the processes on GPUs (parseNvidiaApps). */
export const NVIDIA_APPS = ['--query-compute-apps=pid,used_gpu_memory', '--format=csv,noheader,nounits'];

const MiB = 1024 * 1024;

/** nvidia-smi's CSV of NVIDIA_GPUS: one GPU a line; a value it does not
 * know ([N/A], [Not Supported]) is left out. */
export function parseNvidiaGPUs(raw: string): GPU[] {
  const out: GPU[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const p = line.split(',').map((s) => s.trim());
    if (p.length < 5) continue;
    const g: GPU = { index: parseInt10(p[0]) ?? out.length, name: p[1], vendor: 'nvidia' };
    const util = parseOptional(p[2]);
    if (util !== null) g.utilPct = round1(clampPct(util));
    const used = parseOptional(p[3]);
    if (used !== null && used >= 0) g.memUsedBytes = Math.floor(used * MiB) || undefined;
    const total = parseOptional(p[4]);
    if (total !== null && total > 0) {
      g.memTotalBytes = Math.floor(total * MiB);
      g.memPct = clampPct(((g.memUsedBytes ?? 0) / g.memTotalBytes) * 100);
    }
    const opt = (i: number) => (p.length > i ? parseOptional(p[i]) : null);
    const temp = opt(5);
    if (temp !== null) g.tempC = round1(temp);
    const power = opt(6);
    if (power !== null) g.powerW = round1(power);
    const limit = opt(7);
    if (limit !== null) g.powerLimitW = round1(limit);
    out.push(g);
  }
  return out;
}

/** nvidia-smi's CSV of NVIDIA_APPS: the GPU memory of each process, summed
 * over its GPUs. */
export function parseNvidiaApps(raw: string): Map<number, number> {
  const res = new Map<number, number>();
  for (const line of raw.split('\n')) {
    const p = line.trim().split(',');
    if (p.length < 2) continue;
    const pid = parseInt10(p[0].trim());
    if (pid === null || pid <= 0) continue;
    const mib = parseOptional(p[1]);
    if (mib !== null && mib > 0) res.set(pid, (res.get(pid) ?? 0) + Math.floor(mib * MiB));
  }
  return res;
}

/** The AMD and Intel GPUs of the DRM class at drmRoot (card<N>, not their
 * connectors), numbered from start; NVIDIA's are nvidia-smi's. A card
 * without a metric is left out. */
export async function drmGPUs(io: Bounded, drmRoot: string, start: number, ms: number): Promise<GPU[]> {
  const names = await io.names(drmRoot, ms);
  if (!names) return [];
  const cards = names.filter((n) => n.startsWith('card') && !n.includes('-') && parseUint(n.slice(4)) !== null).sort();
  const out: GPU[] = [];
  for (const card of cards) {
    const dev = join(drmRoot, card, 'device');
    const vendorID = (await io.text(join(dev, 'vendor'), ms))?.trim().toLowerCase();
    const vendor = vendorID === '0x1002' ? 'amd' : vendorID === '0x8086' ? 'intel' : '';
    if (!vendor) continue;
    const g: GPU = { index: start + out.length, name: `${vendor.toUpperCase()} GPU (${card})`, vendor };
    const product = (await io.text(join(dev, 'product_name'), ms))?.trim();
    if (product) g.name = product;
    let has = false;
    const busy = parseNum((await io.text(join(dev, 'gpu_busy_percent'), ms)) ?? '');
    if (busy !== null) {
      g.utilPct = clampPct(busy);
      has = true;
    }
    const used = parseUint(((await io.text(join(dev, 'mem_info_vram_used'), ms)) ?? '').trim());
    if (used !== null) {
      g.memUsedBytes = used || undefined;
      has = true;
    }
    const total = parseUint(((await io.text(join(dev, 'mem_info_vram_total'), ms)) ?? '').trim());
    if (total !== null && total > 0) {
      g.memTotalBytes = total;
      g.memPct = clampPct(((used ?? 0) / total) * 100);
      has = true;
    }
    for (const h of ((await io.names(join(dev, 'hwmon'), ms)) ?? []).sort()) {
      const mc = parseNum((await io.text(join(dev, 'hwmon', h, 'temp1_input'), ms)) ?? '');
      if (mc !== null && mc > 0) {
        g.tempC = round1(mc / 1000);
        has = true;
        break;
      }
    }
    if (has) out.push(g);
  }
  return out;
}
