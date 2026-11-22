// A plugin whose panes have an agent status (plugins/api.ts ViewStatusDef),
// as the chat plugin's have, driven by the tests: statuses set by view id,
// its notifications point to a pane by a member of their own ("thing"),
// and what it was told was seen is recorded.

import { Files } from 'lucide-react';
import { createElement } from 'react';
import type { AgentStatus } from '../lib/machine';
import type { PluginDef, UnopenedAgent } from '../plugins/api';
import * as L from '../term/layout';

export const DUMMY = 'dummy';

const statuses = new Map<string, AgentStatus>();
const unopened = new Map<string, UnopenedAgent[]>();
const listeners = new Set<() => void>();

/** What the plugin was told was seen: machine and view id. */
export const seenCalls: string[] = [];

/** How many subscriptions to its statuses are taken. */
export const subscriptions = () => listeners.size;

/** Sets (or, with undefined, clears) the status of the pane of view id, and says so. */
export function setViewStatus(id: string, s: AgentStatus | undefined) {
  if (s) statuses.set(id, s);
  else statuses.delete(id);
  for (const f of [...listeners]) f();
}

export function setUnopenedAgents(m: string, list: UnopenedAgent[]) {
  if (list.length) unopened.set(m, list);
  else unopened.delete(m);
  for (const f of [...listeners]) f();
}

export function resetViewStatuses() {
  statuses.clear();
  unopened.clear();
  seenCalls.length = 0;
}

/** A leaf of the plugin's pane. */
export const thing = (id: string, name = id): L.PluginLeaf => ({ view: { id, plugin: DUMMY, kind: 'thing', name } });

export const dummyPlugin: PluginDef = {
  id: DUMMY,
  title: 'plugins.gui.title',
  icon: Files,
  paneViews: {
    thing: {
      icon: Files,
      title: (_m, v) => `thing ${String(v.name)}`,
      directory: () => '/srv/thing',
      component: ({ view }) => createElement('div', { className: 'thing-pane' }, view.id),
    },
  },
  viewStatus: {
    status: (_m, v) => statuses.get(v.id),
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    paneOf: (_m, data) => (typeof data.thing === 'string' ? L.viewKey(data.thing) : undefined),
    seen: (m, v) => {
      seenCalls.push(`${m}:${v.id}`);
    },
    unopened: (m) => unopened.get(m) ?? [],
  },
};
