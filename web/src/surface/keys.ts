// Routing of key events in the pane surface. Every keydown the surface gets
// goes through routeKey, with three outcomes: the app keymap consumes it, it
// goes to the focused pane as a key event (herdr encodes it), or the browser
// keeps it (Cmd shortcuts, IME composition, dead keys). Consumed events are
// cancelled so that no keypress or input event follows them.

import { keyEvent, type InputEvent, type KeyOptions } from './input';

export type KeyRoute = 'app' | 'pane' | 'browser';

export function routeKey(
  ev: KeyboardEvent,
  appKey: (ev: KeyboardEvent) => boolean,
  send: (e: InputEvent) => void,
  o: KeyOptions = {},
): KeyRoute {
  if (appKey(ev)) {
    ev.preventDefault();
    return 'app';
  }
  const e = keyEvent(ev, o);
  if (!e) return 'browser';
  ev.preventDefault();
  send(e);
  return 'pane';
}
