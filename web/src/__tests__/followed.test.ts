// @vitest-environment jsdom
//
// The machines a browser followed are followed again when the page opens,
// each once it is connected; a machine removed is forgotten.

import { beforeEach, describe, expect, it } from 'vitest';
import { storage } from '../brand';
import { useStore } from '../state/store';
import { terms } from '../state/terms';
import { FOLLOWED_KEY, rememberFollowed } from '../state/followed';
import type { MachineState } from '../lib/machine';
import { FakeHub, settle } from './fakeTerms';

const machine = (id: string, status: string) => ({ id, label: id, kind: 'ssh', status }) as unknown as MachineState;
const saved = () => JSON.parse(storage.get(FOLLOWED_KEY) ?? '[]') as string[];

describe('followed machines', () => {
  beforeEach(() => {
    storage.remove(FOLLOWED_KEY);
    const hub = new FakeHub();
    hub.machine('a', [], undefined);
    hub.machine('b', [], undefined);
    hub.install();
    useStore.getState().setMachines([]);
  });

  it('follows the machines followed before once they are connected', async () => {
    storage.set(FOLLOWED_KEY, JSON.stringify(['a', 'b']));
    const off = rememberFollowed(() => terms);
    try {
      useStore.getState().setMachines([machine('a', 'connecting'), machine('b', 'ready')]);
      await settle();
      expect(terms.isSubscribed('a')).toBe(false);
      expect(terms.isSubscribed('b')).toBe(true);
      useStore.getState().setMachines([machine('a', 'ready'), machine('b', 'ready')]);
      await settle();
      expect(terms.isSubscribed('a')).toBe(true);
    } finally {
      off();
    }
  });

  it('remembers a machine when it is followed and forgets it when it is removed', async () => {
    const off = rememberFollowed(() => terms);
    try {
      useStore.getState().setMachines([machine('a', 'ready'), machine('b', 'ready')]);
      terms.subscribe('a');
      await settle();
      expect(saved()).toEqual(['a']);
      useStore.getState().setMachines([machine('b', 'ready')]);
      await settle();
      expect(saved()).toEqual([]);
    } finally {
      off();
    }
  });
});
