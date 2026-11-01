// Notification sounds for agents, played in the browser because herdr plays
// its own only in the herdr TUI client. Two short chimes are synthesized with
// the Web Audio API, so there are no audio files: "request" when an agent
// needs input, "done" when it finished.

import type { AgentStatusEvent } from './lib/herdr';

export type SoundKind = 'done' | 'request';

/** Parses the muted agents setting: names separated by commas or spaces. */
export function mutedAgents(raw: string): Set<string> {
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface SoundContext {
  /** The core chose this page to play sounds (the most recently used one). */
  chosen: boolean;
  /** The "Notification sounds" setting. */
  enabled: boolean;
  muted: Set<string>;
  /** The pane is in the selected workspace and tab. */
  onScreen: boolean;
  /** The page is visible and has focus. */
  focused: boolean;
}

/**
 * Which sound an agent status change plays, following herdr: the request
 * sound always plays, the done sound not when the pane is on screen in a
 * focused window.
 */
export function soundFor(ev: AgentStatusEvent, c: SoundContext): SoundKind | undefined {
  if (!c.chosen || !c.enabled) return undefined;
  for (const name of [ev.agent, ev.display_agent]) if (name && c.muted.has(name.toLowerCase())) return undefined;
  if (ev.agent_status === 'blocked') return 'request';
  if (ev.agent_status === 'done' && !(c.onScreen && c.focused)) return 'done';
  return undefined;
}

// Notes as [frequency in Hz, start in seconds].
const tunes: Record<SoundKind, { wave: OscillatorType; notes: [number, number][] }> = {
  done: {
    wave: 'sine',
    notes: [
      [659.25, 0],
      [987.77, 0.13],
    ],
  },
  request: {
    wave: 'triangle',
    notes: [
      [880, 0],
      [880, 0.16],
      [1318.51, 0.32],
    ],
  },
};

let ctx: AudioContext | undefined;

function audio(): AudioContext | undefined {
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return undefined;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/**
 * Browsers start audio only after a user gesture on the page; called from
 * one, it prepares the audio context so that later sounds can play.
 */
export function unlockAudio() {
  if (!ctx || ctx.state === 'suspended') audio();
}

export function playSound(kind: SoundKind) {
  const a = audio();
  if (!a) return;
  const { wave, notes } = tunes[kind];
  const t0 = a.currentTime + 0.02;
  for (const [freq, at] of notes) {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = wave;
    osc.frequency.value = freq;
    const start = t0 + at;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
    osc.connect(gain).connect(a.destination);
    osc.start(start);
    osc.stop(start + 0.42);
  }
}
