import assert from 'node:assert/strict';
import test from 'node:test';
import { ACK_MS, closeGuard, isCloseAnswer, parseUnsaved, type CloseGuardHost } from './closeGuard';

function host() {
  const log: string[] = [];
  let timer: { fn: () => void; ms: number } | undefined;
  const h: CloseGuardHost = {
    ask: () => log.push('ask'),
    close: () => log.push('close'),
    cancelled: () => log.push('cancelled'),
    setTimer(fn, ms) {
      const t = { fn, ms };
      timer = t;
      return () => {
        if (timer === t) timer = undefined;
      };
    },
  };
  return { h, log, fire: () => timer?.fn(), timer: () => timer };
}

test('a page without unsaved changes closes at once', () => {
  const { h, log } = host();
  const g = closeGuard(h);
  assert.equal(g.onClose(), true);
  assert.deepEqual(log, []);
});

test('the page asks; Close closes once, the next close asks again', () => {
  const { h, log, timer } = host();
  const g = closeGuard(h);
  g.setUnsaved(2);
  assert.equal(g.onClose(), false);
  assert.deepEqual(log, ['ask']);
  assert.equal(timer()?.ms, ACK_MS);
  g.answer('asking');
  assert.equal(timer(), undefined, 'the page took the question: no fallback');
  g.answer('close');
  assert.deepEqual(log, ['ask', 'close']);
  // That close goes through, to the page's objection (withdrawn) and any
  // other frame's (the native question).
  assert.equal(g.onClose(), true);
  // A close that did not happen (another frame's objection was kept) asks
  // the page again next time.
  assert.equal(g.onClose(), false);
  assert.deepEqual(log, ['ask', 'close', 'ask']);
});

test('Stay keeps the window and cancels a quit; the next close asks again', () => {
  const { h, log } = host();
  const g = closeGuard(h);
  g.setUnsaved(1);
  g.onClose();
  g.answer('asking');
  g.answer('stay');
  assert.deepEqual(log, ['ask', 'cancelled']);
  assert.equal(g.onClose(), false);
  assert.deepEqual(log, ['ask', 'cancelled', 'ask']);
});

test('a page that does not take the question is closed the old way, once', () => {
  const { h, log, fire } = host();
  const g = closeGuard(h);
  g.setUnsaved(1);
  assert.equal(g.onClose(), false);
  fire();
  assert.deepEqual(log, ['ask', 'close']);
  // That close goes through (to the native question), and a late answer is ignored.
  assert.equal(g.onClose(), true);
  g.answer('close');
  assert.deepEqual(log, ['ask', 'close']);
  assert.equal(g.onClose(), false, 'the next close asks the page again');
});

test('closing again while the page asks goes to the native question: a page cannot hold the window', () => {
  const { h, log, timer } = host();
  const g = closeGuard(h);
  g.setUnsaved(1);
  g.onClose();
  g.answer('asking');
  assert.equal(g.onClose(), true);
  assert.equal(timer(), undefined);
  // Its answer after that changes nothing.
  g.answer('close');
  g.answer('stay');
  assert.deepEqual(log, ['ask']);
});

test('a shutdown never waits, also while the page asks', () => {
  const { h, log } = host();
  const g = closeGuard(h);
  g.setUnsaved(1);
  assert.equal(g.onClose(true), true);
  g.onClose();
  assert.equal(g.onClose(true), true);
  assert.deepEqual(log, ['ask']);
});

test('a new page (or none) cancels a quit waiting on the old one, and its fallback', () => {
  const { h, log, fire } = host();
  const g = closeGuard(h);
  g.answer('close'); // no question: nothing
  g.setUnsaved(3);
  g.onClose();
  g.reset();
  assert.deepEqual(log, ['ask', 'cancelled']);
  fire();
  assert.deepEqual(log, ['ask', 'cancelled'], 'no fallback close after the reset');
  assert.equal(g.onClose(), true, 'a new page has nothing unsaved until it says so');
  g.reset();
  assert.deepEqual(log, ['ask', 'cancelled'], 'a reset without a question cancels nothing');
});

test('only well-formed messages count', () => {
  for (const v of ['asking', 'close', 'stay']) assert.ok(isCloseAnswer(v));
  for (const v of ['', 'quit', 1, null, undefined, {}]) assert.equal(isCloseAnswer(v), false);
  assert.equal(parseUnsaved(0), 0);
  assert.equal(parseUnsaved(12), 12);
  for (const v of [-1, 1.5, 10001, '3', NaN, null]) assert.equal(parseUnsaved(v), undefined);
});

test('alwaysAsk asks even with zero unsaved changes so detached windows can close their tab', () => {
  const { h, log } = host();
  const g = closeGuard(h);
  assert.equal(g.onClose(false, true), false);
  assert.deepEqual(log, ['ask']);
  g.answer('asking');
  g.answer('close');
  assert.deepEqual(log, ['ask', 'close']);
  assert.equal(g.onClose(false, true), true);
  assert.equal(g.onClose(true, true), true, 'shutdown still never waits');
});
