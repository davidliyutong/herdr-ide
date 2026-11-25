// @vitest-environment jsdom
// The settings' Performance page: what the app uses now.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../vt/pane', () => ({
  paneUsage: () => [
    { hidden: false, attached: true, renderer: 'webgl' },
    { hidden: true, attached: true },
    { hidden: true, attached: true },
  ],
}));

import { cpuShare, megabytes, pageUsage, percent, sample } from '../perf';
import { Performance } from '../components/settings/Performance';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hub = (cpu_ms: number, uptime_ms: number) => ({ cpu_ms, memory: 64 * 1024 * 1024, goroutines: 40, uptime_ms, cpus: 8 });

describe('performance', () => {
  let answer: unknown;
  beforeEach(() => {
    answer = hub(1000, 10_000);
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(url === '/api/perf' ? new Response(JSON.stringify(answer), { status: 200 }) : new Response('{}', { status: 404 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('writes amounts shortly', () => {
    expect(megabytes(5.25 * 1024 * 1024)).toBe('5.3 MB');
    expect(megabytes(153 * 1024 * 1024)).toBe('153 MB');
    expect(megabytes(1536 * 1024 * 1024)).toBe('1.50 GB');
    expect(percent(0.34)).toBe('0.3%');
    expect(percent(42.6)).toBe('43%');
    expect(cpuShare(500, 2000)).toBe(25);
    expect(cpuShare(1, 0)).toBeUndefined();
  });

  it('counts the terminals shown and kept, and what draws them', () => {
    expect(pageUsage()).toMatchObject({ shown: 1, kept: 2, webgl: 1, canvas: 0 });
  });

  it('turns two samples of the hub into its share of a processor, not across a restart', async () => {
    const first = await sample();
    expect(first.hub?.memory).toBe(64 * 1024 * 1024);
    expect(first.hubCpu).toBeUndefined();
    answer = hub(1500, 12_000);
    const second = await sample({ ...first, at: performance.now() - 2000 });
    expect(Math.round(second.hubCpu!)).toBe(25);
    // The hub started again: its counters did, too.
    answer = hub(20, 300);
    expect((await sample(second)).hubCpu).toBeUndefined();
    // An answer that is not a usage is none.
    answer = { cpu_ms: 'much' };
    expect((await sample()).hub).toBeUndefined();
  });

  it('shows the page and the hub in a browser, where no process is counted', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root: Root = createRoot(host);
    await act(async () => root.render(createElement(Performance)));
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    const rows = [...host.querySelectorAll('.perf-table tbody tr')].map((r) => (r as HTMLElement).dataset.kind);
    expect(rows).toEqual(['page', 'hub']);
    expect(host.querySelector('tr[data-kind="hub"]')?.textContent).toContain('64 MB');
    expect(host.querySelector('.perf-total')).toBeNull();
    expect([...host.querySelectorAll('.perf-facts dd')].slice(0, 2).map((d) => d.textContent)).toEqual(['1', '2']);
    await act(async () => root.unmount());
    host.remove();
  });
});
