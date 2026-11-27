// @vitest-environment jsdom
//
// Reusable local FilePicker component (components/FilePicker.tsx): directory
// listing with folders-first sorting, hidden-files toggle, inline folder
// expansion, breadcrumb navigation, fuzzy filter with highlights, multi-select
// checkboxes preserving pre-selected paths, and error reporting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FilePicker } from '../components/FilePicker';
import type { FilePickerEntry, FilePickerProps } from '../conversation/source';
import { setLocale, t } from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const q = <E extends Element = HTMLElement>(sel: string) => host.querySelector<E>(sel as never) as E | null;
const qa = <E extends Element = HTMLElement>(sel: string) => Array.from(host.querySelectorAll<E>(sel as never)) as E[];
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const click = (el: Element | null | undefined) => act(async () => void (el as HTMLElement).click());

beforeEach(() => {
  setLocale('en');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const tree: Record<string, FilePickerEntry[]> = {
  '/work/repo': [
    { name: 'README.md', is_dir: false, size: 1200 },
    { name: 'src', is_dir: true },
    { name: '.env', is_dir: false, size: 42 },
    { name: 'my notes.txt', is_dir: false, size: 300 },
  ],
  '/work/repo/src': [
    { name: 'app.ts', is_dir: false, size: 2048 },
    { name: 'api.ts', is_dir: false, size: 512 },
  ],
  '/work': [{ name: 'repo', is_dir: true }],
};

async function mount(overrides: Partial<FilePickerProps> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const listDir = vi.fn(async (_m: string, path: string) => {
    if (!(path in tree)) throw new Error('ENOENT');
    return { entries: tree[path] };
  });
  const props: FilePickerProps = {
    m: 'local',
    rootDir: '/work/repo',
    onSelect,
    onClose,
    listDir,
    ...overrides,
  };
  await act(async () => root.render(createElement(FilePicker, props)));
  await settle();
  return { onSelect, onClose, listDir };
}

describe('FilePicker', () => {
  it('lists folders first, toggles hidden files, expands folders inline and attaches multi-selected files', async () => {
    const { onSelect, onClose, listDir } = await mount();
    expect(listDir).toHaveBeenCalledWith('local', '/work/repo');
    // Hidden .env excluded initially; folders sorted before files.
    expect(qa('.file-picker-row .tree-label').map((e) => e.textContent)).toEqual(['src', 'my notes.txt', 'README.md']);

    // Toggle hidden files on.
    await click(q(`[aria-label="${t('conversation.filePicker.hidden')}"]`));
    expect(qa('.file-picker-row .tree-label').map((e) => e.textContent)).toEqual(['src', '.env', 'my notes.txt', 'README.md']);

    // Expand src folder inline.
    await click(q('.file-picker-row[data-path="/work/repo/src"]'));
    await settle();
    expect(listDir).toHaveBeenCalledWith('local', '/work/repo/src');
    expect(qa('.file-picker-row .tree-label').map((e) => e.textContent)).toEqual([
      'src',
      'api.ts',
      'app.ts',
      '.env',
      'my notes.txt',
      'README.md',
    ]);

    // Select a nested file and a file with spaces in its name.
    await click(q('.file-picker-row[data-path="/work/repo/src/app.ts"]'));
    await click(q('.file-picker-row[data-path="/work/repo/my notes.txt"]'));
    expect(q('.file-picker-count')?.textContent).toBe(t('conversation.filePicker.selected', { n: 2 }));

    // Confirm attachment.
    await click(q('.file-picker-foot .primary'));
    expect(onSelect).toHaveBeenCalledWith([
      { path: '/work/repo/src/app.ts', label: 'src/app.ts' },
      { path: '/work/repo/my notes.txt', label: 'my notes.txt' },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('filters entries with highlights, clears filter on first Escape and closes on second Escape', async () => {
    const { onClose } = await mount();
    const input = q<HTMLInputElement>('.file-picker-filter')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'rm');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(qa('.file-picker-row .tree-label').map((e) => e.textContent)).toEqual(['README.md']);
    expect(qa('.file-picker-row mark.match').length).toBeGreaterThan(0);

    // First Escape clears filter.
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(input.value).toBe('');
    expect(onClose).not.toHaveBeenCalled();

    // Second Escape closes dialog.
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates up and back to workspace root while keeping pre-selected files', async () => {
    const { onSelect } = await mount({ selected: ['/work/repo/README.md'] });
    await click(q(`[aria-label="${t('conversation.filePicker.up')}"]`));
    await settle();
    expect(qa('.file-picker-row .tree-label').map((e) => e.textContent)).toEqual(['repo']);
    // Home button appears when away from rootDir.
    await click(q(`[aria-label="${t('conversation.filePicker.home')}"]`));
    await settle();
    expect(qa('.file-picker-row .tree-label').map((e) => e.textContent)).toEqual(['src', 'my notes.txt', 'README.md']);
    // Pre-selected file stays checked and attaches cleanly.
    const box = q<HTMLInputElement>('.file-picker-row[data-path="/work/repo/README.md"] input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    await click(q('.file-picker-foot .primary'));
    expect(onSelect).toHaveBeenCalledWith([{ path: '/work/repo/README.md', label: 'README.md' }]);
  });

  it('supports Select all and Deselect all for visible files', async () => {
    const { onSelect } = await mount();
    await click(q('.file-picker-select-all'));
    expect(q('.file-picker-count')?.textContent).toBe(t('conversation.filePicker.selected', { n: 2 }));
    expect(q('.file-picker-select-all')).toBeNull();
    expect(q('.file-picker-clear')).not.toBeNull();
    await click(q('.file-picker-clear'));
    expect(q('.file-picker-count')?.textContent).toBe('');
    expect(q<HTMLButtonElement>('.file-picker-foot .primary')!.disabled).toBe(true);
    await click(q('.file-picker-select-all'));
    await click(q('.file-picker-foot .primary'));
    expect(onSelect).toHaveBeenCalledWith([
      { path: '/work/repo/my notes.txt', label: 'my notes.txt' },
      { path: '/work/repo/README.md', label: 'README.md' },
    ]);
  });

  it('shows an error note when directory listing fails', async () => {
    await mount({ rootDir: '/missing' });
    expect(q('.file-picker-note.error')?.textContent).toContain('ENOENT');
  });

  it('does not re-fetch directories that are already cached when re-expanding or navigating back', async () => {
    const { listDir } = await mount();
    expect(listDir).toHaveBeenCalledTimes(1);
    // Expand, collapse, and re-expand src -> listed only once.
    await click(q('.file-picker-row[data-path="/work/repo/src"]'));
    await settle();
    expect(listDir).toHaveBeenCalledTimes(2);
    await click(q('.file-picker-row[data-path="/work/repo/src"]'));
    await click(q('.file-picker-row[data-path="/work/repo/src"]'));
    await settle();
    expect(listDir).toHaveBeenCalledTimes(2);
    // Navigate up to /work and back home to /work/repo -> /work/repo stays cached.
    await click(q(`[aria-label="${t('conversation.filePicker.up')}"]`));
    await settle();
    expect(listDir).toHaveBeenCalledTimes(3);
    await click(q(`[aria-label="${t('conversation.filePicker.home')}"]`));
    await settle();
    expect(listDir).toHaveBeenCalledTimes(3);
  });

  it('ignores Escape during IME composition', async () => {
    const { onClose } = await mount();
    const input = q<HTMLInputElement>('.file-picker-filter')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'rm');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true }));
    });
    expect(input.value).toBe('rm');
    expect(onClose).not.toHaveBeenCalled();

    // Clear filter, then compose Escape again: dialog stays open.
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(input.value).toBe('');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows empty state for a dotfile-only directory when hidden files are off, and renders subdirectory listing errors', async () => {
    const customListDir = vi.fn(async (_m: string, path: string) => {
      if (path === '/dotfiles') return { entries: [{ name: '.env', is_dir: false, size: 10 }] };
      if (path === '/work/repo') return { entries: [{ name: 'secret', is_dir: true }] };
      throw new Error('EACCES');
    });

    await mount({ rootDir: '/dotfiles', listDir: customListDir });
    expect(q('.file-picker-note.muted')?.textContent).toBe(t('conversation.filePicker.empty'));

    await act(async () => root.unmount());
    root = createRoot(host);
    await mount({ rootDir: '/work/repo', listDir: customListDir });
    await click(q('.file-picker-row[data-path="/work/repo/secret"]'));
    await settle();
    expect(q('.file-picker-note.error')?.textContent).toContain('EACCES');
  });

  it('does not clear newer machine deduplication when an aborted listDir rejects after machine switch', async () => {
    let rejectFirst!: (err: Error) => void;
    let resolveSecond!: (res: { entries: FilePickerEntry[] }) => void;
    const calls: Array<{ m: string; path: string }> = [];
    const customListDir = vi.fn((m: string, path: string) => {
      calls.push({ m, path });
      if (calls.length === 1) {
        return new Promise<{ entries: FilePickerEntry[] }>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      if (calls.length === 2) {
        return new Promise<{ entries: FilePickerEntry[] }>((resolve) => {
          resolveSecond = resolve;
        });
      }
      return Promise.resolve({ entries: [] });
    });

    const onSelect = vi.fn();
    const onClose = vi.fn();
    await act(async () =>
      root.render(createElement(FilePicker, { m: 'm1', rootDir: '/work/repo', onSelect, onClose, listDir: customListDir })),
    );
    expect(calls).toEqual([{ m: 'm1', path: '/work/repo' }]);

    // Switch machine before m1's request settles; m2 starts its own request for /work/repo.
    await act(async () =>
      root.render(createElement(FilePicker, { m: 'm2', rootDir: '/work/repo', onSelect, onClose, listDir: customListDir })),
    );
    expect(calls).toEqual([
      { m: 'm1', path: '/work/repo' },
      { m: 'm2', path: '/work/repo' },
    ]);

    // Old aborted m1 request rejects: must NOT clear m2's requestedRef entry.
    rejectFirst(new DOMException('aborted', 'AbortError'));
    await settle();

    // Resolve m2's request and verify no duplicate fetch occurred even after re-rendering.
    resolveSecond({ entries: [{ name: 'ok.txt', is_dir: false, size: 4 }] });
    await settle();
    await act(async () =>
      root.render(createElement(FilePicker, { m: 'm2', rootDir: '/work/repo', onSelect, onClose, listDir: customListDir })),
    );
    await settle();
    expect(calls).toHaveLength(2);
    expect(qa('.file-picker-row .tree-label').map((e) => e.textContent)).toEqual(['ok.txt']);
  });
});
