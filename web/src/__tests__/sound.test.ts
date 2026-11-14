import { describe, expect, it } from 'vitest';
import { mutedAgents, soundFor, type SoundContext } from '../sound';
import { builtinDefaults } from '../settings';
import type { AgentStatusEvent } from '../lib/machine';

const ev = (agent_status: AgentStatusEvent['agent_status'], agent = 'claude'): AgentStatusEvent => ({
  terminal: 't1',
  agent_status,
  agent,
});
const ctx = (c: Partial<SoundContext> = {}): SoundContext => ({
  chosen: true,
  enabled: true,
  muted: new Set(),
  onScreen: false,
  focused: false,
  ...c,
});

describe('soundFor', () => {
  it('plays the request sound when blocked and the done sound when done', () => {
    expect(soundFor(ev('blocked'), ctx())).toBe('request');
    expect(soundFor(ev('done'), ctx())).toBe('done');
    expect(soundFor(ev('working'), ctx())).toBeUndefined();
    expect(soundFor(ev('idle'), ctx())).toBeUndefined();
  });
  it('skips the done sound only for a pane on screen in a focused window', () => {
    expect(soundFor(ev('done'), ctx({ onScreen: true, focused: true }))).toBeUndefined();
    expect(soundFor(ev('done'), ctx({ onScreen: true }))).toBe('done');
    expect(soundFor(ev('done'), ctx({ focused: true }))).toBe('done');
    expect(soundFor(ev('blocked'), ctx({ onScreen: true, focused: true }))).toBe('request');
  });
  it('stays silent when disabled, muted or not the chosen browser', () => {
    expect(soundFor(ev('blocked'), ctx({ enabled: false }))).toBeUndefined();
    expect(soundFor(ev('blocked'), ctx({ chosen: false }))).toBeUndefined();
    expect(soundFor(ev('blocked', 'droid'), ctx({ muted: mutedAgents('droid') }))).toBeUndefined();
    expect(soundFor({ ...ev('done', 'x'), display_agent: 'Droid' }, ctx({ muted: mutedAgents('droid') }))).toBeUndefined();
  });
});

describe('sound settings', () => {
  it('parses muted agents and keeps an empty list', () => {
    expect([...mutedAgents(' Droid, codex  kimi,,')]).toEqual(['droid', 'codex', 'kimi']);
    expect(mutedAgents('').size).toBe(0);
    expect(builtinDefaults['notifications.mutedAgents']).toBe('droid');
    expect(builtinDefaults['notifications.sound']).toBe(true);
  });
});
