// What VS Code's work follows (work.ts): each kind of client's own work
// (its proxied requests and WebSockets, the bridge's commands) and the
// preparations of code-server, taken only while that client's switch is on
// and ended when it goes off.
import { expect, test } from 'bun:test';
import type { Client } from '#kernel/http/env.ts';
import { Work } from './work.ts';

function switches() {
  const on: Record<Client, boolean> = { desktop: true, browser: true };
  const logs: string[] = [];
  return {
    on,
    logs,
    work: new Work(
      (c) => on[c],
      (m) => void logs.push(m),
    ),
  };
}

// Turning VS Code off for a kind of client ends that client's work;
// preparations end once it is off for every client; another setting's
// change ends nothing; the next use takes a new signal.
test("a switch turned off ends its client's work, and the last one the preparations", () => {
  const { on, logs, work } = switches();
  const desktop = work.signal('desktop', true)!;
  const browser = work.signal('browser', true)!;
  const prep = work.signal('browser', false)!;
  work.follow();
  expect([desktop.aborted, browser.aborted, prep.aborted]).toEqual([false, false, false]);
  on.browser = false;
  work.follow();
  expect([desktop.aborted, browser.aborted, prep.aborted]).toEqual([false, true, false]);
  expect((browser.reason as Error).message).toBe('VS Code turned off');
  on.desktop = false;
  work.follow();
  expect([desktop.aborted, prep.aborted]).toEqual([true, true]);
  expect(logs).toEqual([
    'VS Code turned off for browser clients: their connections end',
    'VS Code turned off for desktop clients: their connections end',
    'VS Code turned off: its preparations end',
  ]);
  on.desktop = true;
  expect(work.signal('desktop', true)?.aborted).toBe(false);
  expect(work.signal('desktop', false)?.aborted).toBe(false);
});

// A request takes the signal of its work, and of preparing code-server,
// only while its client's switch is on: taken before the switch goes off,
// turning it off ends it; asked for after (a request that passed the
// route's check just before), there is none, never a signal that nothing
// would end.
test("work is taken only while its client's switch is on", () => {
  const { on, work } = switches();
  on.desktop = false;
  on.browser = false;
  expect([work.signal('desktop', true), work.signal('desktop', false)]).toEqual([undefined, undefined]);
  on.desktop = true;
  const own = work.signal('desktop', true)!;
  const prep = work.signal('desktop', false)!;
  expect([own.aborted, prep.aborted]).toEqual([false, false]);
  expect([work.signal('browser', true), work.signal('browser', false)]).toEqual([undefined, undefined]);
  // Turned off, before the change is followed: nothing more is taken.
  on.desktop = false;
  expect([work.signal('desktop', true), work.signal('desktop', false)]).toEqual([undefined, undefined]);
  work.follow();
  expect([own.aborted, prep.aborted]).toEqual([true, true]);
});

// The core stops: all work ends, whatever the switches.
test('stopAll ends every signal', () => {
  const { logs, work } = switches();
  const s = [work.signal('desktop', true)!, work.signal('browser', true)!, work.signal('desktop', false)!];
  work.stopAll();
  expect(s.map((x) => x.aborted)).toEqual([true, true, true]);
  expect(logs).toEqual([]);
});
