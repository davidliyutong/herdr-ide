// @vitest-environment jsdom
// The Add Machine dialog's hosts of the core host's ~/.ssh/config: listed
// under the target field, narrowed as one types, picked with the keys or
// the pointer; any other target can still be typed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AddMachineDialog, hostDetail, matchHosts, type SSHHost } from '../components/AddMachineDialog';
import { useStore } from '../state/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hosts: SSHHost[] = [
  { alias: 'gpu', hostname: '10.0.0.5', user: 'yutong' },
  { alias: 'nus-ws-1', hostname: 'nus-ws-1.lab.example' },
  { alias: 'web', user: 'deploy' },
  { alias: 'lab-gpu', hostname: 'gpu2.lab.example' },
];

describe('the hosts offered', () => {
  it('lists every host for nothing typed, alias starts first, then any field holding the text', () => {
    expect(matchHosts(hosts, '').map((h) => h.alias)).toEqual(['gpu', 'nus-ws-1', 'web', 'lab-gpu']);
    expect(matchHosts(hosts, 'GP').map((h) => h.alias)).toEqual(['gpu', 'lab-gpu']);
    expect(matchHosts(hosts, 'lab').map((h) => h.alias)).toEqual(['lab-gpu', 'nus-ws-1']);
    expect(matchHosts(hosts, 'deploy').map((h) => h.alias)).toEqual(['web']);
    // A typed-out alias or a target of its own closes the list.
    expect(matchHosts(hosts, 'gpu')).toEqual([]);
    expect(matchHosts(hosts, 'me@elsewhere')).toEqual([]);
  });

  it('shows where each connects', () => {
    expect(hostDetail(hosts[0])).toBe('yutong@10.0.0.5');
    expect(hostDetail(hosts[1])).toBe('nus-ws-1.lab.example');
    expect(hostDetail(hosts[2])).toBe('deploy@web');
    expect(hostDetail({ alias: 'x', hostname: 'x' })).toBe('');
  });
});

describe('the dialog', () => {
  let root: Root;
  let host: HTMLDivElement;
  const posted: unknown[] = [];
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T & HTMLElement>(sel);
  const rows = () => [...document.querySelectorAll('.ssh-hosts [role="option"]')].map((r) => r.textContent);
  const target = () => q<HTMLInputElement>('input[role="combobox"]')!;
  const key = (k: string) =>
    act(async () => void target().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
  const type = (v: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target(), v);
      target().dispatchEvent(new Event('input', { bubbles: true }));
    });

  beforeEach(async () => {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === '/api/ssh/hosts') return new Response(JSON.stringify([...hosts, { nope: 1 }]), { status: 200 });
      if (url === '/api/machines' && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: 'new' }), { status: 201 });
      }
      return new Response('{}', { status: 404 });
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(AddMachineDialog)));
    await act(async () => useStore.getState().openAddMachine(true));
    await act(async () => target().focus());
  });
  afterEach(async () => {
    await act(async () => useStore.getState().openAddMachine(false));
    await act(async () => root.unmount());
    host.remove();
    posted.length = 0;
    vi.unstubAllGlobals();
  });

  it('lists the hosts and narrows them as one types', async () => {
    expect(q('.ssh-hosts-caption')?.textContent).toBe('Hosts in ~/.ssh/config');
    expect(rows()).toEqual(['gpuyutong@10.0.0.5', 'nus-ws-1nus-ws-1.lab.example', 'webdeploy@web', 'lab-gpugpu2.lab.example']);
    await type('la');
    expect(rows()).toEqual(['lab-gpugpu2.lab.example', 'nus-ws-1nus-ws-1.lab.example']);
  });

  it('picks a host with the arrow keys and Enter, then adds it with Enter', async () => {
    await key('ArrowDown');
    await key('ArrowDown');
    await key('Enter');
    expect(target().value).toBe('nus-ws-1');
    expect(rows()).toEqual([]);
    await key('Enter');
    expect(posted).toEqual([{ target: 'nus-ws-1', label: '' }]);
  });

  it('completes the first match with Tab and takes any other target as typed', async () => {
    await type('we');
    await key('Tab');
    expect(target().value).toBe('web');
    await type('me@elsewhere');
    expect(rows()).toEqual([]);
    await key('Enter');
    expect(posted).toEqual([{ target: 'me@elsewhere', label: '' }]);
  });

  it('picks a host with the pointer', async () => {
    const row = [...document.querySelectorAll<HTMLElement>('.ssh-hosts [role="option"]')][3];
    await act(async () => void row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
    expect(target().value).toBe('lab-gpu');
  });
});
