// @vitest-environment jsdom
//
// How the Git plugin follows repositories (plugins/git/state.ts,
// follow.ts) with the core's routes stubbed and time faked: the watch's
// tokens move the status, the diffs' version and the history's refs
// version apart; the repository's info is read when its configuration
// moved; reads back off after timeouts; a change gets a read that starts
// after it; failures that say nothing about a directory are not
// remembered; turning the plugin off stops the explorer's and editors'
// watches.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true } }));
vi.mock('../plugins/monaco', () => ({ createEditor: vi.fn(), createDiffEditor: vi.fn(), loadMonaco: vi.fn() }));

import { useSettings } from '../settings';
import { definePlugins } from '../plugins/registry';
import { useShownDirs } from '../plugins/files/decorations';
import { gitPlugin } from '../plugins/git';
import { leaseCount, repoOf } from '../plugins/git/follow';
import {
  ACTIVE_MS,
  ACTIVE_POLL_MS,
  ACTIVE_REFRESH_MS,
  changed,
  forgetInput,
  nudge,
  NUDGE_MS,
  POLL_MS,
  refresh,
  REFRESH_MS,
  repoKey,
  RETRY_MS,
  SLOW_FACTOR,
  useGit,
  useReposOf,
  watchRepo,
  type RepoState,
} from '../plugins/git/state';
import { useTerms } from '../state/terms';
import type { StatusFile } from '../plugins/git/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

definePlugins([gitPlugin]);

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

describe('following a repository', () => {
  let root = '';
  let n = 0;
  let tokens = { token: 't1', refs: 'r1', config: 'c1' };
  let statusError: string | undefined;
  let repoError: string | undefined;
  let statusHold: Promise<void> | undefined;
  /** How long a status read takes (fake time), and its files. */
  let statusTakes = 0;
  let files: StatusFile[] = [];
  const calls: Array<{ action: string; q: URLSearchParams }> = [];
  const count = (action: string, path = root) =>
    calls.filter((c) => c.action === action && (c.q.get('repo') ?? c.q.get('path'))?.startsWith(path)).length;
  const state = (): RepoState => useGit.getState().repos[repoKey('m', root)];
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  beforeEach(() => {
    vi.useFakeTimers();
    root = `/repo${++n}`;
    tokens = { token: 't1', refs: 'r1', config: 'c1' };
    statusError = repoError = undefined;
    statusHold = undefined;
    statusTakes = 0;
    files = [];
    forgetInput();
    calls.length = 0;
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(input, 'http://x');
      const action = url.pathname.split('/').pop()!;
      calls.push({ action, q: url.searchParams });
      switch (action) {
        case 'watch':
          return json(tokens);
        case 'status':
          await statusHold;
          if (statusTakes) await new Promise((r) => setTimeout(r, statusTakes));
          if (statusError) return json({ error: statusError, message: statusError }, 504);
          return json({ branch: 'main', head: 'h1', ahead: 0, behind: 0, files });
        case 'repo': {
          if (repoError) return json({ error: repoError, message: repoError }, 502);
          const p = url.searchParams.get('path')!;
          if (p.startsWith('/plain')) return json({ error: 'not_a_repo', message: 'no' }, 404);
          const nested = p === root && p.endsWith('/with-nested') ? [`${root}/sub`] : undefined;
          return json({ root: p.startsWith(root) ? root : p, ahead: 0, behind: 0, remotes: [], nested });
        }
      }
      return json({});
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reads the status when the token moved, the log when the refs did, the info when the configuration did', async () => {
    const stop = watchRepo('m', root);
    await advance(0);
    expect([count('repo'), count('status')]).toEqual([1, 1]);
    // Quiet: nothing happened for a while (the first token is what the
    // first read saw).
    await advance(ACTIVE_MS);
    const s0 = state();
    const reads = count('status');
    await advance(POLL_MS);
    expect(count('status')).toBe(reads);
    // The index moved (staging in a terminal): the diffs, not the log,
    // within a poll.
    tokens = { ...tokens, token: 't2' };
    await advance(POLL_MS);
    expect([state().version - s0.version, state().refs - s0.refs, count('status') - reads, count('repo')]).toEqual([1, 0, 1, 1]);
    // A commit: the log too; active now, the token is asked more often.
    tokens = { ...tokens, token: 't3', refs: 'r2' };
    await advance(ACTIVE_POLL_MS);
    expect([state().version - s0.version, state().refs - s0.refs, count('repo')]).toEqual([2, 1, 1]);
    // A remote added: the info is read again.
    tokens = { ...tokens, token: 't4', config: 'c2' };
    await advance(ACTIVE_POLL_MS);
    expect([state().refs - s0.refs, count('repo')]).toEqual([1, 2]);
    stop();
  });

  // Changes of the working tree do not move the token: the status is read
  // every ACTIVE_REFRESH_MS while the repository is active, every
  // REFRESH_MS once it is quiet, never more than a fifth of the time.
  it('reads the status often while active, less once quiet', async () => {
    const stop = watchRepo('m', root);
    await advance(0);
    // Just shown: active.
    let at = count('status');
    await advance(10 * ACTIVE_REFRESH_MS);
    expect(count('status') - at).toBe(10);
    await advance(ACTIVE_MS);
    at = count('status');
    await advance(3 * REFRESH_MS);
    expect(count('status') - at).toBe(3);
    // A key pressed in the page: active again.
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })));
    at = count('status');
    await advance(5 * ACTIVE_REFRESH_MS);
    expect(count('status') - at).toBeGreaterThanOrEqual(4);
    // A status that changed keeps it active.
    await advance(ACTIVE_MS);
    files = [{ path: 'a.txt', x: '.', y: 'M', kind: 'changed' }];
    await advance(REFRESH_MS);
    at = count('status');
    await advance(5 * ACTIVE_REFRESH_MS);
    expect(count('status') - at).toBeGreaterThanOrEqual(4);
    stop();
  });

  it('keeps slow reads apart', async () => {
    const stop = watchRepo('m', root);
    await advance(0);
    statusTakes = 1000;
    await advance(ACTIVE_REFRESH_MS + 1000);
    const at = count('status');
    // A read of 1 s keeps the next one 5 s away, also when a terminal's
    // command ended.
    await act(async () => nudge('m', root));
    await advance(SLOW_FACTOR * 1000 - ACTIVE_REFRESH_MS);
    expect(count('status')).toBe(at);
    await advance(ACTIVE_REFRESH_MS + 1000);
    expect(count('status')).toBe(at + 1);
    stop();
  });

  // Looked at soon: a command or an agent's turn that ended in a terminal
  // in the repository, the page shown again or focused.
  it('reads the repository when a terminal’s command ended there and when the page comes back', async () => {
    const stop = watchRepo('m', root);
    await advance(ACTIVE_MS + POLL_MS);
    const term = (address: string, cwd: string, pid: number, name: string) => ({
      address,
      state: 'live',
      cwd,
      foreground: { pid, name, cwd },
    });
    const terminals = (...ts: ReturnType<typeof term>[]) =>
      act(async () => useTerms.setState({ machines: { m: { terminals: Object.fromEntries(ts.map((x) => [x.address, x])) } } }));
    await terminals(term('a', `${root}/src`, 1, 'zsh'), term('b', '/elsewhere', 5, 'zsh'));
    let at = [count('watch'), count('status')];
    // A command elsewhere: nothing.
    await terminals(term('a', `${root}/src`, 1, 'zsh'), term('b', '/elsewhere', 6, 'git'));
    await advance(NUDGE_MS);
    expect([count('watch'), count('status')]).toEqual(at);
    // git commit in the repository, then back at the prompt.
    await terminals(term('a', `${root}/src`, 2, 'git'), term('b', '/elsewhere', 6, 'git'));
    await terminals(term('a', `${root}/src`, 1, 'zsh'), term('b', '/elsewhere', 6, 'git'));
    await advance(NUDGE_MS);
    expect([count('watch') - at[0], count('status') - at[1]]).toEqual([1, 1]);
    // An agent's turn ended.
    await advance(ACTIVE_MS);
    at = [count('watch'), count('status')];
    await act(async () =>
      useTerms.setState((s) => ({
        machines: { m: { terminals: { ...s.machines.m.terminals, a: { ...s.machines.m.terminals.a, agent_status: 'done' } } } },
      })),
    );
    await advance(NUDGE_MS);
    expect(count('status') - at[1]).toBe(1);
    // The page focused again.
    await advance(ACTIVE_MS);
    at = [count('watch'), count('status')];
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await advance(NUDGE_MS);
    expect(count('status') - at[1]).toBe(1);
    await act(async () => useTerms.setState({ machines: {} }));
    stop();
  });

  it('backs off after a read timed out', async () => {
    statusError = 'timeout';
    const stop = watchRepo('m', root);
    await advance(0);
    expect(count('status')).toBe(1);
    // Not again at REFRESH_MS: twice as long after the first timeout.
    await advance(REFRESH_MS + POLL_MS);
    expect(count('status')).toBe(1);
    await advance(REFRESH_MS);
    expect(count('status')).toBe(2);
    // Then four times as long (at 60 s).
    await advance(3 * REFRESH_MS);
    expect(count('status')).toBe(2);
    statusError = undefined;
    await advance(REFRESH_MS);
    expect(count('status')).toBe(3);
    expect(state().error).toBeUndefined();
    // A change still reads at once.
    await act(async () => void (await changed('m', root)));
    expect(count('status')).toBe(4);
    stop();
  });

  it('gives a change a read that starts after it', async () => {
    let release!: () => void;
    statusHold = new Promise<void>((r) => (release = r));
    const a = refresh('m', root);
    const b = refresh('m', root);
    const c = refresh('m', root, { fresh: true });
    const d = refresh('m', root, { fresh: true });
    await advance(0);
    expect(b).toBe(a);
    expect(d).toBe(c);
    expect(count('status')).toBe(1);
    statusHold = undefined;
    release();
    await act(async () => void (await Promise.all([a, c])));
    expect(count('status')).toBe(2);
  });

  it('moves the log after a change only when the refs moved', async () => {
    const stop = watchRepo('m', root);
    await advance(POLL_MS);
    const s0 = state();
    tokens = { ...tokens, token: 't2' };
    await act(async () => void (await changed('m', root)));
    expect([state().version - s0.version, state().refs - s0.refs]).toEqual([1, 0]);
    tokens = { ...tokens, token: 't3', refs: 'r2' };
    await act(async () => void (await changed('m', root)));
    expect([state().version - s0.version, state().refs - s0.refs]).toEqual([2, 1]);
    // The polls do not count the change again.
    await advance(POLL_MS);
    expect([state().version - s0.version, state().refs - s0.refs]).toEqual([2, 1]);
    // Refresh reads everything again.
    const repos = count('repo');
    await act(async () => void (await changed('m', root, { all: true })));
    expect([state().refs - s0.refs, count('repo') - repos]).toEqual([2, 1]);
    stop();
  });

  // The panel's repository of a directory: a failure that says nothing
  // about it is shown and asked again, not remembered as "no repository".
  it('asks again for a directory whose repository could not be asked', async () => {
    repoError = 'offline';
    const host = document.createElement('div');
    const r = createRoot(host);
    const Probe = () => createElement('span', null, JSON.stringify(useReposOf('m', `${root}/sub`)));
    await act(async () => r.render(createElement(Probe)));
    await advance(0);
    expect(JSON.parse(host.textContent!)).toEqual({ roots: [], error: expect.any(String) });
    repoError = undefined;
    await advance(RETRY_MS);
    expect(JSON.parse(host.textContent!)).toEqual({ roots: [root] });
    await act(async () => r.unmount());
  });

  it('remembers no repository, not a failure, for a directory of the explorer', async () => {
    repoError = 'busy';
    await expect(repoOf('m', `${root}/a`)).rejects.toThrow();
    repoError = undefined;
    await expect(repoOf('m', `${root}/a`)).resolves.toBe(root);
    await expect(repoOf('m', '/plain/dir')).resolves.toBeUndefined();
    await expect(repoOf('m', '/plain/dir')).resolves.toBeUndefined();
    expect(count('repo', '/plain')).toBe(1);
  });

  it('stops the explorer’s watches while the plugin is off', async () => {
    const set = (on: boolean) =>
      act(async () => useSettings.setState((s) => ({ values: { ...s.values, 'plugins.git.enabled': { value: on, source: 'global' } } })));
    await act(async () => useShownDirs.setState({ m: 'm', dirs: [`${root}/src`] }));
    await advance(0);
    expect(leaseCount()).toEqual({ held: 1, watching: 1 });
    await set(false);
    expect(leaseCount()).toEqual({ held: 1, watching: 0 });
    const watches = count('watch');
    await advance(3 * POLL_MS);
    expect(count('watch')).toBe(watches);
    await set(true);
    await advance(POLL_MS);
    expect(leaseCount()).toEqual({ held: 1, watching: 1 });
    expect(count('watch')).toBeGreaterThan(watches);
    // A directory that could not be asked is asked again while shown.
    repoError = 'offline';
    await act(async () => useShownDirs.setState({ m: 'm', dirs: [`${root}/src`, `${root}/other`] }));
    await advance(0);
    expect(leaseCount()).toEqual({ held: 2, watching: 1 });
    repoError = undefined;
    await advance(RETRY_MS);
    expect(leaseCount()).toEqual({ held: 2, watching: 2 });
    await act(async () => useShownDirs.setState({ m: undefined, dirs: [] }));
    expect(leaseCount()).toEqual({ held: 0, watching: 0 });
  });

  it('includes nested repositories in useReposOf and watches them in follow leases', async () => {
    root = `${root}/with-nested`;
    const host = document.createElement('div');
    const r = createRoot(host);
    const Probe = () => createElement('span', null, JSON.stringify(useReposOf('m', root)));
    await act(async () => r.render(createElement(Probe)));
    await advance(0);
    expect(JSON.parse(host.textContent!)).toEqual({ roots: [root, `${root}/sub`] });
    await act(async () => r.unmount());

    await act(async () => useShownDirs.setState({ m: 'm', dirs: [root] }));
    await advance(0);
    expect(leaseCount()).toEqual({ held: 1, watching: 1 });
    expect(count('status', `${root}/sub`)).toBeGreaterThanOrEqual(1);
    await act(async () => useShownDirs.setState({ m: undefined, dirs: [] }));
    expect(leaseCount()).toEqual({ held: 0, watching: 0 });
  });
});
