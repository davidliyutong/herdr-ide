// @vitest-environment jsdom
//
// File Explorer editor enhancements:
// - Monaco defaultEditorOptions uses light-DOM context menus (useShadowDOM: false)
//   so fixedOverflowWidgets inherits theme CSS variables without breaking.
// - Soft-wrap toggle button, files.wordWrap setting fallback, and Alt+Z action.
// - Markdown Preview right-click context menu (copy, link actions, mode switch, path/reveal).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const updateOptionsSpy = vi.fn();
const addActionSpy = vi.fn();
const createEditorSpy = vi.fn();

vi.mock('../plugins/monaco', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plugins/monaco')>();
  return {
    ...actual,
    setLanguage: vi.fn(),
    createEditor: (...args: unknown[]) => createEditorSpy(...args),
  };
});

import { defaultEditorOptions } from '../plugins/monaco';
import { EditorPane, resetFileCache, resetWordWrapPref, setWordWrap } from '../plugins/files/EditorPane';
import { isItem, useMenu } from '../contextMenu';
import { useSettings } from '../settings';
import { useStore } from '../state/store';
import { t } from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mockMonaco(initialText: string) {
  let text = initialText;
  const model = {
    getValue: () => text,
    setValue: (v: string) => {
      text = v;
    },
    getEOL: () => '\n',
    getAlternativeVersionId: () => 1,
    getVersionId: () => 1,
    onDidChangeContent: () => ({ dispose: () => {} }),
    dispose: () => {},
  };
  const editor = {
    setModel: vi.fn(),
    getModel: () => model,
    getValue: () => text,
    updateOptions: updateOptionsSpy,
    addAction: addActionSpy.mockReturnValue({ dispose: () => {} }),
    onKeyDown: () => ({ dispose: () => {} }),
    onDidChangeModelContent: () => ({ dispose: () => {} }),
    saveViewState: () => null,
    restoreViewState: () => {},
    layout: () => {},
    focus: () => {},
    dispose: () => {},
  };
  const monaco = {
    Uri: { from: (o: unknown) => o },
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    KeyMod: { CtrlCmd: 2048, Alt: 512 },
    KeyCode: { KeyS: 49, KeyZ: 56 },
    editor: {
      EndOfLineSequence: { LF: 0, CRLF: 1 },
      OverviewRulerLane: { Left: 1 },
      getModel: () => null,
      createModel: (v: string) => {
        text = v;
        return model;
      },
    },
  };
  createEditorSpy.mockResolvedValue({ monaco, editor });
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));

describe('Monaco context menu, soft-wrap and Markdown preview context menu', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    resetFileCache();
    resetWordWrapPref();
    updateOptionsSpy.mockReset();
    addActionSpy.mockReset();
    createEditorSpy.mockReset();
    useMenu.setState({ menu: undefined });
    useSettings.setState({ values: {} });
    useStore.setState({
      readOnly: false,
      machines: {
        m: { id: 'm', label: 'Local', kind: 'local', status: 'ready', platform: 'darwin/arm64', enabled: true, updated_at: 0 },
      },
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('disables Monaco shadow DOM so fixedOverflowWidgets context menus inherit theme styles', () => {
    expect(defaultEditorOptions.fixedOverflowWidgets).toBe(true);
    expect(defaultEditorOptions.useShadowDOM).toBe(false);
  });

  it('supports toggling soft-wrap in text editors via toolbar, setting and Alt+Z', async () => {
    mockMonaco('a very long line of text without line breaks');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('a very long line of text without line breaks', { status: 200, headers: { ETag: 'W/"2c-1"' } })),
    );

    await act(async () => {
      root.render(
        createElement(EditorPane, {
          m: 'm',
          pane: 'view:e1',
          view: { id: 'e1', plugin: 'files', kind: 'editor', path: '/tmp/notes.txt' },
          focused: true,
        }),
      );
    });
    await flush();

    expect(createEditorSpy).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ wordWrap: 'off' }));
    const btn = host.querySelector<HTMLButtonElement>(`button[aria-label="${t('files.wordWrap')}"]`)!;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    // Clicking the toolbar toggle enables soft-wrap and updates Monaco.
    await act(async () => btn.click());
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(updateOptionsSpy).toHaveBeenCalledWith(expect.objectContaining({ wordWrap: 'on' }));

    // Registered Alt+Z action toggles soft-wrap back off.
    expect(addActionSpy).toHaveBeenCalledWith(expect.objectContaining({ label: t('files.wordWrap') }));
    const actionDef = addActionSpy.mock.calls[0][0] as { run: () => void };
    await act(async () => actionDef.run());
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(updateOptionsSpy).toHaveBeenCalledWith(expect.objectContaining({ wordWrap: 'off' }));

    // Without a browser override, the hub setting files.wordWrap enables soft-wrap.
    await act(async () => {
      resetWordWrapPref();
      useSettings.setState({ values: { 'files.wordWrap': { value: true, source: 'global' } } });
    });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    await act(async () => setWordWrap(false));
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('opens a clean context menu when right-clicking inside Markdown preview', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('# Hello\n\nCheck [Example](https://example.com) for details.', {
            status: 200,
            headers: { ETag: 'W/"38-1"' },
          }),
      ),
    );

    await act(async () => {
      root.render(
        createElement(EditorPane, {
          m: 'm',
          pane: 'view:md1',
          view: { id: 'md1', plugin: 'files', kind: 'editor', path: '/tmp/README.md' },
          focused: true,
        }),
      );
    });
    await flush();

    const preview = host.querySelector<HTMLElement>('.files-md-preview')!;
    expect(preview).not.toBeNull();

    await act(async () => {
      preview.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }));
    });
    const labels = (useMenu.getState().menu?.entries ?? []).filter(isItem).map((e) => e.label);
    expect(labels).toContain(t('surface.copy'));
    expect(labels).toContain(t('files.markdown.split'));
    expect(labels).toContain(t('files.markdown.source'));
    expect(labels).toContain(t('files.copyPath'));
    expect(labels).toContain(t('files.reveal'));
  });
});
