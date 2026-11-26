// The decisions of preparing a machine's display, as pure functions: what
// the agent is asked to do from its status, when to try again after a
// failure, and what follows an attachment.
import { GUIDisplay, type GUIStatus } from '#shared/proto/agentproto/index.ts';
import { Phase } from './state.ts';
import type { Timing } from './timing.ts';

/** The kind of display a machine with status st gets when asked (the
 * setting gui.display) is asked for: the GPU display where the machine can
 * run it and xvfb is not asked for. */
export function wantKind(st: GUIStatus, asked: string): string {
  return asked !== GUIDisplay.Xvfb && st.gpu_display ? GUIDisplay.Xwayland : GUIDisplay.Xvfb;
}

/** The agent actions preparing a display with status st takes, or the
 * phase to stop at. Read-only mode starts nothing. A display of another
 * kind than asked for is started anew, which the agent does only while no
 * program uses it. */
export function plan(st: GUIStatus, readOnly: boolean, asked: string): { actions: Array<'install' | 'start'>; stop: string } {
  const want = wantKind(st, asked);
  if (!st.supported) return { actions: [], stop: Phase.Unsupported };
  if (st.running && (readOnly || !st.kind || st.kind === want)) return { actions: [], stop: '' };
  if (readOnly) return { actions: [], stop: Phase.NotRunning };
  if (st.running || want === GUIDisplay.Xwayland) return { actions: ['start'], stop: '' };
  if (!st.xvfb && !st.installable) return { actions: [], stop: Phase.Unavailable };
  if (!st.xvfb) return { actions: ['install', 'start'], stop: '' };
  return { actions: ['start'], stop: '' };
}

/** The wait before the next attempt after n failures in a row: retryMinMs
 * doubling, at most retryMaxMs. */
export function retryDelay(n: number, t: Pick<Timing, 'retryMinMs' | 'retryMaxMs'>): number {
  return Math.min(t.retryMinMs * 2 ** Math.min(n, 6), t.retryMaxMs);
}

/** What the hub does on a machine once its display is ready: start the
 * display keeper, push the video encoder (when video is on for it; the
 * same decides installing the GPU selection library). Read-only mode
 * starts and pushes nothing. */
export function afterAttach(readOnly: boolean, push: boolean): { keep: boolean; push: boolean } {
  return readOnly ? { keep: false, push: false } : { keep: true, push };
}
