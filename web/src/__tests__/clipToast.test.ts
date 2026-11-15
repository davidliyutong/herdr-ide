import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { sendNow: () => {} } }));

import { useStore } from '../state/store';
import { usePrefs } from '../prefs';
import { fakeSettingsApi } from './fakeSettings';
import { CLIP_AUTO_MS, PROGRAM_CLIP_MS, forgetProgramClipboard, programClipboard, programCopied, userInput } from '../vt/clipboard';

const clip = (text: string, m = 'm') => programCopied(m, text);
const typed = () => userInput();
const flush = () => new Promise((r) => setTimeout(r, 0));

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  fakeSettingsApi();
  usePrefs.getState().setPref('programClipboard', 'auto');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useStore.setState({ toasts: [] });
});

describe('OSC 52 from programs', () => {
  it('copies at once right after input to a pane and says what it copied', async () => {
    typed();
    clip('copied text');
    expect(writeText).toHaveBeenCalledWith('copied text');
    await flush();
    const [toast] = useStore.getState().toasts;
    expect(toast.action).toBeUndefined();
    expect(toast.msg).toContain('copied text');
    expect(programClipboard('m')).toBe('copied text');
    // Only for the machine whose program copied it.
    expect(programClipboard('other')).toBeUndefined();
  });

  it('asks when nobody used a pane lately, and closes the toast after 5 s', () => {
    vi.useFakeTimers();
    typed();
    vi.advanceTimersByTime(CLIP_AUTO_MS + 1);
    clip('copied text');
    expect(writeText).not.toHaveBeenCalled();
    const [toast] = useStore.getState().toasts;
    expect(toast.action?.label).toBeTruthy();
    expect(toast.msg).toContain('copied text');
    toast.action!.run();
    expect(writeText).toHaveBeenCalledWith('copied text');
    vi.advanceTimersByTime(4999);
    expect(useStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it('asks when the browser refuses the write', async () => {
    writeText.mockImplementationOnce(() => Promise.reject(new Error('not allowed')));
    typed();
    clip('copied text');
    await flush();
    expect(useStore.getState().toasts.map((t) => !!t.action)).toEqual([true]);
  });

  it('always asks with "ask", and ignores programs with "off"', async () => {
    usePrefs.getState().setPref('programClipboard', 'ask');
    typed();
    clip('one');
    expect(writeText).not.toHaveBeenCalled();
    expect(useStore.getState().toasts).toHaveLength(1);

    usePrefs.getState().setPref('programClipboard', 'off');
    typed();
    clip('two');
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(useStore.getState().toasts).toHaveLength(1);
    expect(programClipboard('m')).toBeUndefined();
  });

  it('keeps one toast for programs that copy on every selection', async () => {
    typed();
    clip('first');
    await flush();
    clip('second');
    await flush();
    expect(useStore.getState().toasts.map((t) => t.msg)).toEqual([expect.stringContaining('second')]);
  });

  it('keeps for the menu only copies that passed the gate, until the next input or it expires', () => {
    vi.useFakeTimers();
    usePrefs.getState().setPref('programClipboard', 'ask');
    typed();
    clip('asked');
    expect(programClipboard('m')).toBeUndefined();

    usePrefs.getState().setPref('programClipboard', 'auto');
    typed();
    vi.advanceTimersByTime(CLIP_AUTO_MS + 1);
    clip('late');
    expect(programClipboard('m')).toBeUndefined();

    typed();
    clip('kept');
    expect(programClipboard('m')).toBe('kept');
    vi.advanceTimersByTime(PROGRAM_CLIP_MS + 1);
    expect(programClipboard('m')).toBeUndefined();

    typed();
    clip('kept');
    typed();
    expect(programClipboard('m')).toBeUndefined();
    clip('kept');
    forgetProgramClipboard();
    expect(programClipboard('m')).toBeUndefined();
  });
});
