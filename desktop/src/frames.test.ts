// What the frames of the app get (frames.ts): their channels to the hub,
// the ports the main process sends passed on to the page, and in VS
// Code's frames the WebSocket that opens a channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { posted } from './fakeWindow';
import { installPortSocket } from '../../web/src/lib/portSocket';
import { CHANNEL_PORT, type DesktopChannels } from '../../web/src/shell';
import { channels } from './bridge';
import { isChannelId } from './hub';
import { executed, exposed, receive, sent } from './fakeElectron';
import { isCodeFrame, setUpFrame } from './frames';
import { APP_ORIGIN } from './origin';

test("a frame of another origin gets nothing; the app's get their channels", () => {
  assert.equal(setUpFrame({ origin: 'https://example.com', pathname: '/m/local/code/' }), false);
  assert.equal(setUpFrame({ origin: 'null', pathname: '/' }), false);
  assert.deepEqual(Object.keys(exposed), []);
  assert.deepEqual(executed, []);
  assert.equal(setUpFrame({ origin: APP_ORIGIN, pathname: '/' }), true);
  assert.deepEqual(Object.keys(exposed), ['desktopChannels']);
  assert.deepEqual(executed, []);
});

test('a channel: its id and request to the shell, its port passed on to the page as a message of its origin', () => {
  const ch = exposed.desktopChannels as DesktopChannels;
  sent.length = 0;
  const id = ch.open('/ws?x=1', ['a', 2 as unknown as string]);
  assert.ok(isChannelId(id), id);
  assert.notEqual(ch.open('/ws', []), id);
  assert.deepEqual(sent[0], { channel: channels.openChannel, value: id });
  const port = { fake: 'port' };
  receive(channels.channelPort, id, [port]);
  assert.deepEqual(posted.at(-1), [{ [CHANNEL_PORT]: id }, APP_ORIGIN, [port]]);
  const before = posted.length;
  receive(channels.channelPort, id, []);
  receive(channels.channelPort, 3, [port]);
  assert.equal(posted.length, before);
});

test("VS Code's frames get the WebSocket that opens channels", () => {
  for (const p of ['/m/local/code/', '/m/a%20b/code', '/m/x/code/stable-1/static/out/index.html']) assert.ok(isCodeFrame(p), p);
  for (const p of ['/', '/m/local/gui/1', '/code/', '/m/local/codex/', '/api/m/local/code/status']) assert.equal(isCodeFrame(p), false, p);
  setUpFrame({ origin: APP_ORIGIN, pathname: '/m/local/code/' });
  assert.deepEqual(executed, [{ func: installPortSocket, args: [true] }]);
});
