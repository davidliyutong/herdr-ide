// Switching the right sidebar's tools with a swipe: Cmd held (Alt on
// Windows and Linux, whose Ctrl with the wheel zooms) and two fingers moved
// up or down on a trackpad, or the wheel turned, show the next or previous
// tool in the rail's order (view.panel.next, view.panel.previous). One swipe
// is one step: once it stepped, the rest of it (the fingers' and the
// momentum's events) is taken without another until the events pause.
// Anywhere in the main window but a VS Code pane, whose frame keeps its
// events; nothing while a dialog is open.
import { keyContext, runCommand } from './keymap';
import { isMac } from './keys';

/** How far (CSS pixels) a swipe goes before it steps. */
export const STEP_PX = 40;
/** The pause that ends a swipe. */
export const QUIET_MS = 250;

let sum = 0;
let last = -Infinity;
let stepped = false;

/** Whether ev's modifiers are the swipe's, and no others. */
function holds(ev: WheelEvent): boolean {
  return isMac ? ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey : ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey;
}

/** A wheel delta in CSS pixels. */
function px(delta: number, mode: number): number {
  if (mode === 1) return delta * 16;
  if (mode === 2) return delta * (typeof window === 'undefined' ? 800 : window.innerHeight);
  return delta;
}

/** Takes a wheel event that is the swipe's (true: it is cancelled and goes
 * no further), stepping once per swipe. */
export function onPanelWheel(ev: WheelEvent, now = performance.now()): boolean {
  if (!holds(ev) || keyContext() === 'dialog') return false;
  const dy = px(ev.deltaY, ev.deltaMode);
  if (Math.abs(dy) <= Math.abs(px(ev.deltaX, ev.deltaMode))) return false;
  ev.preventDefault();
  ev.stopPropagation();
  if (now - last > QUIET_MS) {
    sum = 0;
    stepped = false;
  }
  last = now;
  if (stepped) return true;
  sum += dy;
  if (Math.abs(sum) >= STEP_PX) {
    stepped = true;
    // Fingers up (natural scrolling) or the wheel toward the user: the next.
    runCommand(sum > 0 ? 'view.panel.next' : 'view.panel.previous');
  }
  return true;
}

/** Follows the window's wheel events, before panes and editors get them. */
export function followPanelSwipe(): () => void {
  const on = (ev: WheelEvent) => void onPanelWheel(ev);
  window.addEventListener('wheel', on, { capture: true, passive: false });
  return () => window.removeEventListener('wheel', on, { capture: true });
}

/** Forgets the swipe under way (tests). */
export function resetPanelSwipe() {
  sum = 0;
  last = -Infinity;
  stepped = false;
}
