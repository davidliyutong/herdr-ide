import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAC_TITLEBAR_INSET,
  MAC_TITLEBAR_MIN_HEIGHT,
  MAC_TITLEBAR_TOP_SPACE,
  macTrafficLightPosition,
  windowFrameOptions,
} from './titlebar';

test('macOS traffic lights stay vertically aligned across UI font sizes and window zooms', () => {
  // Default (13px UI font, 100% zoom): header is clamped to MAC_TITLEBAR_MIN_HEIGHT (44pt) with 4pt top space -> y = (44 + 4 - 12) / 2 = 18.
  assert.deepEqual(macTrafficLightPosition(13, 1), { x: 16, y: 18 });
  // Lower zoom or smaller UI font keeps the 44pt minimum header height.
  assert.deepEqual(macTrafficLightPosition(11, 0.75), { x: 16, y: 18 });
  // Larger UI font (20px -> 52 + 4 = 56pt header) aligns traffic lights with the top-padded content center.
  assert.deepEqual(macTrafficLightPosition(20, 1), { x: 16, y: 24 });
  // Higher zoom (150% -> 51 + 4 = 55pt header) aligns traffic lights with the top-padded content center.
  assert.deepEqual(macTrafficLightPosition(13, 1.5), { x: 16, y: 24 });
  assert.ok(MAC_TITLEBAR_INSET >= 80);
  assert.ok(MAC_TITLEBAR_MIN_HEIGHT >= 42);
  assert.ok(MAC_TITLEBAR_TOP_SPACE > 0);
});

test('windowFrameOptions hides the separate title bar on macOS only', () => {
  const mac = windowFrameOptions('darwin', 13, 1);
  assert.equal(mac.titleBarStyle, 'hidden');
  assert.deepEqual(mac.trafficLightPosition, { x: 16, y: 18 });
  assert.deepEqual(windowFrameOptions('win32', 13, 1), {});
  assert.deepEqual(windowFrameOptions('linux', 13, 1), {});
});
