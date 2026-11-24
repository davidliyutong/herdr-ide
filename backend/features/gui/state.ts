// What pages see of a machine's display (its phase, its windows), and what
// new terminals of the machine get from it (DISPLAY and the GPU
// libraries' variables): pure functions of the agent's status and the
// settings.
import { GUIDisplay, type GUIGPU, type GUIStatus, type GUIWindow } from '#shared/proto/agentproto/index.ts';
import { GPUMode } from './settings.ts';

/** Phases of a machine's display; the UI translates them. */
export const Phase = {
  Off: 'off',
  /** Windows open on the user's own screen. */
  Local: 'local',
  Unsupported: 'unsupported',
  /** No Xvfb and none can be fetched. */
  Unavailable: 'unavailable',
  Installing: 'installing',
  Starting: 'starting',
  Ready: 'ready',
  Error: 'error',
  /** Read-only mode, which only shows a display that runs. */
  NotRunning: 'not_running',
  /** The machine is disabled, reconnecting, failing or removed; a display
   * there keeps running until idle, and the next connection prepares it
   * again. */
  Disconnected: 'disconnected',
} as const;

export type PhaseName = (typeof Phase)[keyof typeof Phase] | '';

/** What pages see of one machine (/ws "gui" messages, GET /api/gui). */
export interface State {
  m: string;
  phase: string;
  error?: string;
  /** VirtualGL works on the machine (vglrun renders on the GPU). */
  gpu?: boolean;
  /** The kind of the display that is ready ("xvfb", "xwayland"). */
  display?: string;
  /** On a machine with several NVIDIA GPUs, the one (as nvidia-smi counts
   * them) that windows of Vulkan programs come from. */
  vulkan_gpu?: number;
  /** New panes get the library that makes it the one a program's
   * CUDA_VISIBLE_DEVICES names. */
  pick?: boolean;
  /** Another core controls the machine's windows; this one's viewers see
   * them and may take control. */
  view_only?: boolean;
  windows: GUIWindow[];
}

/** The GPU of a machine with several NVIDIA GPUs that the driver shows
 * windows of Vulkan programs from: its first one, the one with the lowest
 * minor; undefined elsewhere. */
export function vulkanGPU(st: GUIStatus | null | undefined): GUIGPU | undefined {
  const gpus = st?.gpus ?? [];
  if (gpus.length < 2) return undefined;
  return gpus.reduce((first, g) => (g.minor < first.minor ? g : first));
}

/** What the library gpupick reads in a pane's environment
 * (scripts/gpupick/gpupick.c); undefined when the pane gets none: the
 * setting is off, the machine has no second NVIDIA GPU or the library is
 * not there. */
export function pickEnv(pick: boolean, st: GUIStatus | null | undefined): Record<string, string> | undefined {
  if (!pick || !st || !vulkanGPU(st) || !st.pick) return undefined;
  const gpus = st.gpus ?? [];
  const env: Record<string, string> = { LD_PRELOAD: st.pick, GPUPICK_TABLE: gpus.map((g) => `${g.uuid}=${g.minor}`).join(',') };
  if (gpus.some((g) => (g.model ?? '') !== (gpus[0].model ?? ''))) env.GPUPICK_MIXED = '1';
  if (st.display_minor !== undefined) env.GPUPICK_DISPLAY = String(st.display_minor);
  return env;
}

/** The environment new panes get from a display that is ready: DISPLAY and
 * XAUTHORITY, gpupick's variables, and VirtualGL's where it works (with
 * gui.gpu = all its libraries too, except on the GPU display, where OpenGL
 * renders on the GPU by itself and VirtualGL would only add a copy of each
 * frame). */
export function displayEnv(st: GUIStatus, o: { gpu: string; pick: boolean }): Record<string, string> {
  const env: Record<string, string> = { DISPLAY: st.display ?? '', XAUTHORITY: st.xauthority ?? '' };
  Object.assign(env, pickEnv(o.pick, st));
  if (st.gpu) {
    env.VGL_DISPLAY = 'egl0';
    if (o.gpu === GPUMode.All && st.vgl_preload && st.kind !== GUIDisplay.Xwayland) {
      env.LD_PRELOAD = env.LD_PRELOAD ? `${env.LD_PRELOAD}:${st.vgl_preload}` : st.vgl_preload;
      env.VGL_ISACTIVE = '1';
    }
  }
  return env;
}

/** What a display record holds that its state shows. */
export interface StateSource {
  readonly id: string;
  readonly phase: PhaseName;
  readonly err: string;
  readonly status: GUIStatus | null;
  readonly viewOnly: boolean;
  readonly windows: Iterable<GUIWindow>;
}

/** The state pages see; pick is whether the machine's setting asks for
 * gpupick. */
export function stateOf(d: StateSource, pick: boolean): State {
  const s = d.status;
  const ready = d.phase === Phase.Ready;
  const g = vulkanGPU(s);
  return {
    m: d.id,
    phase: d.phase || Phase.Starting,
    ...(d.err ? { error: d.err } : {}),
    ...(s?.gpu ? { gpu: true } : {}),
    ...(ready && s?.kind ? { display: s.kind } : {}),
    ...(g ? { vulkan_gpu: g.index } : {}),
    ...(ready && pickEnv(pick, s) ? { pick: true } : {}),
    ...(ready && d.viewOnly ? { view_only: true } : {}),
    windows: [...d.windows],
  };
}
