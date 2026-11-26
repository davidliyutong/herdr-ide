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

  it('shows an error note when directory listing fails', async () => {
    await mount({ rootDir: '/missing' });
    expect(q('.file-picker-note.error')?.textContent).toContain('ENOENT');
  });
});
