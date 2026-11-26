// @vitest-environment jsdom
//
// A program window viewed while another connection controls the machine's
// windows (gui/session.ts): its input is not sent until it takes control.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuiSession } from '../gui/session';

class FakeWS {
  static last: FakeWS;
  static readonly OPEN = 1;
  readyState = 1;
  binaryType = '';
  sent: Record<string, unknown>[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: () => void;
  constructor(readonly url: string) {
    FakeWS.last = this;
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {}
  event(ev: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(ev) });
  }
}

const realWS = globalThis.WebSocket;

beforeEach(() => {
  globalThis.WebSocket = FakeWS as unknown as typeof WebSocket;
});
afterEach(() => {
  globalThis.WebSocket = realWS;
});

describe('a viewed program window', () => {
  it('sends input only while it controls the windows, and asks for control', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const roles: boolean[] = [];
    const s = new GuiSession('m1', 7, host, { status: () => {}, window: () => {}, child: () => {}, role: (c) => roles.push(c) }, true);
    await new Promise((r) => setTimeout(r, 0));
    const ws = FakeWS.last;
    const key = () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }));
    const keys = () => ws.sent.filter((c) => c.cmd === 'key').length;

    ws.event({ ev: 'role' }); // another connection controls
    key();
    expect(keys()).toBe(0);
    s.takeControl();
    expect(ws.sent.at(-1)).toEqual({ cmd: 'control' });
    ws.event({ ev: 'role', control: true });
    key();
    expect(keys()).toBe(1);
    expect(roles).toEqual([false, true]);
    s.dispose();
  });
});
