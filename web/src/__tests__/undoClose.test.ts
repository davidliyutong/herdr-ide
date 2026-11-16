// The time to undo a close is the setting layout.undoClose, read when the close happens.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasClosed, rememberClosed, resetClosed, takeClosed, undoMs } from '../closedPanes';
import { useSettings } from '../settings';
import type * as L from '../term/layout';

const layout = (): L.Layout => ({
  version: 2,
  workspaces: [
    {
      id: 'wwwwwwww',
      name: 'w',
      cwd: '',
      tabs: [{ root: { split: 'horizontal', ratio: 0.5, children: [{ terminal: 't1' }, { terminal: 't2' }] }, focused: 't1' }],
      selected: 0,
    },
  ],
  selected: 0,
});

const initial = useSettings.getState().values;
const setUndo = (seconds: number) =>
  useSettings.setState({ values: { ...initial, 'layout.undoClose': { value: seconds, source: 'user' } } as never });

describe('layout.undoClose', () => {
  beforeEach(() => resetClosed());
  afterEach(() => useSettings.setState({ values: initial }));

  it('is 5 s by default', () => {
    expect(undoMs()).toBe(5000);
  });

  it('gives a close the deadline of the setting at that time, and Undo works until then', () => {
    setUndo(30);
    const now = 1_000_000;
    const first = rememberClosed('m', layout(), ['t2'], now)!;
    expect(first.deadline).toBe(now + 30_000);
    // The setting changes afterwards: the record keeps its deadline.
    setUndo(5);
    expect(first.deadline).toBe(now + 30_000);
    const second = rememberClosed('m', layout(), ['t1'], now + 1000)!;
    expect(second.deadline).toBe(now + 1000 + 5000);
    expect(hasClosed(now + 10_000)).toBe(true);
    expect(takeClosed(now + 10_000).tabs[0]?.deadline).toBe(now + 30_000);
  });
});
