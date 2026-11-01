import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../state/store';
import { handleSurfaceMessage } from '../surface/session';

afterEach(() => {
  vi.useRealTimers();
  useStore.setState({ toasts: [] });
});

describe('OSC 52 toast', () => {
  it('offers the copy and closes itself after 5 s', () => {
    vi.useFakeTimers();
    handleSurfaceMessage({ t: 'clip', data: btoa('copied text') });
    const [toast] = useStore.getState().toasts;
    expect(toast.action?.label).toBeTruthy();
    expect(toast.msg).toContain('copied text');
    vi.advanceTimersByTime(4999);
    expect(useStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useStore.getState().toasts).toHaveLength(0);
  });
});
