// What the app uses now, for the settings' Performance page: the page
// itself (its script memory, its terminals and what they draw with), the
// hub's process (GET /api/perf) and, in the desktop app, each of its
// processes as Electron counts them (the page's, the GPU's, the shell's).
// A page in a browser cannot know its own share of the processor: there
// only the hub's is shown.
import { paneUsage } from './vt/pane';
import { desktopShell, type ProcessUsage } from './shell';

export interface PageUsage {
  /** Script memory in use and its limit, in bytes (Chromium only). */
  heap?: number;
  heapLimit?: number;
  /** Terminals shown, and kept attached while not shown. */
  shown: number;
  kept: number;
  /** WebGL contexts the terminals hold, and terminals drawn with Canvas 2D. */
  webgl: number;
  canvas: number;
}

/** The hub process's usage as GET /api/perf reports it. */
export interface HubUsage {
  cpu_ms: number;
  memory: number;
  goroutines: number;
  uptime_ms: number;
  cpus: number;
}

export interface Usage {
  at: number;
  page: PageUsage;
  /** The hub's usage. */
  hub?: HubUsage;
  /** The hub's share of one processor since the sample before, in percent. */
  hubCpu?: number;
  /** The desktop app's processes; undefined in a browser. */
  processes?: ProcessUsage[];
}

export function pageUsage(): PageUsage {
  const mem = (performance as { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory;
  const panes = paneUsage();
  return {
    heap: typeof mem?.usedJSHeapSize === 'number' ? mem.usedJSHeapSize : undefined,
    heapLimit: typeof mem?.jsHeapSizeLimit === 'number' ? mem.jsHeapSizeLimit : undefined,
    shown: panes.filter((p) => !p.hidden).length,
    kept: panes.filter((p) => p.hidden).length,
    webgl: panes.filter((p) => p.renderer === 'webgl').length,
    canvas: panes.filter((p) => p.renderer === 'canvas').length,
  };
}

let gpu: string | undefined;

/** The graphics processor the page draws with, as WebGL names it; '' when
 * it does not say. Asked once, with a context given back at once. */
export function gpuName(): string {
  if (gpu !== undefined) return gpu;
  gpu = '';
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const name: unknown = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
      gpu = typeof name === 'string' ? name : '';
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    /* no WebGL: no name */
  }
  return gpu;
}

const amount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

async function hubUsage(): Promise<HubUsage | undefined> {
  try {
    const r = await fetch('/api/perf');
    if (!r.ok) return undefined;
    const u = (await r.json()) as Partial<HubUsage>;
    return amount(u.cpu_ms) && amount(u.memory) && amount(u.goroutines) && amount(u.uptime_ms) && amount(u.cpus)
      ? (u as HubUsage)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A share of one processor, in percent, from processor time used over time passed. */
export function cpuShare(cpuMs: number, wallMs: number): number | undefined {
  return wallMs > 0 && cpuMs >= 0 ? (cpuMs / wallMs) * 100 : undefined;
}

/** Measures now; prev (the sample before) gives the hub's share of a processor. */
export async function sample(prev?: Usage): Promise<Usage> {
  const [hub, processes] = await Promise.all([hubUsage(), desktopShell?.metrics?.()]);
  const at = performance.now();
  // A hub that started again counts from zero: no share for that step.
  const hubCpu = hub && prev?.hub && hub.uptime_ms > prev.hub.uptime_ms ? cpuShare(hub.cpu_ms - prev.hub.cpu_ms, at - prev.at) : undefined;
  return { at, page: pageUsage(), hub, hubCpu, processes };
}

/** Bytes as MB, or GB from 1024 MB. */
export function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export const percent = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;
