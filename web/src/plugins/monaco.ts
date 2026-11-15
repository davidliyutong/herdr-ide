// Monaco, the editor of VS Code, for plugins' panes (the file explorer's
// editor, diffs). It loads on first use: the main bundle does not carry it.
// What loads is its core with every editor feature, the syntax colors of
// all its languages and the language services of JSON, CSS and HTML, each
// with its worker (a file of its own the browser fetches when a model of
// that language opens). TypeScript's and JavaScript's service is left out:
// its worker is larger than the rest of Monaco together, and those files
// keep their colors. Its theme follows the app's light or dark theme and
// its colors (the design tokens), its font the terminal's.

import type * as MonacoNs from 'monaco-editor';
import { usePrefs } from '../prefs';
import { appearanceOf, resolveTheme, useSystemDark } from '../appearance';

export type Monaco = typeof MonacoNs;
export type CodeEditor = MonacoNs.editor.IStandaloneCodeEditor;
export type DiffEditor = MonacoNs.editor.IStandaloneDiffEditor;

let loading: Promise<Monaco> | undefined;

/** Loads Monaco once; later calls get the same instance. */
export function loadMonaco(): Promise<Monaco> {
  loading ??= load().catch((e) => {
    loading = undefined;
    throw e;
  });
  return loading;
}

async function load(): Promise<Monaco> {
  const [monaco, editor, json, css, html] = await Promise.all([
    import('monaco-editor/editor/editor.api'),
    import('monaco-editor/editor/editor.worker?worker'),
    import('monaco-editor/language/json/json.worker?worker'),
    import('monaco-editor/language/css/css.worker?worker'),
    import('monaco-editor/language/html/html.worker?worker'),
    import('monaco-editor/features/register.all'),
    import('monaco-editor/languages/definitions/register.all'),
    import('monaco-editor/languages/features/json/register'),
    import('monaco-editor/languages/features/css/register'),
    import('monaco-editor/languages/features/html/register'),
  ]);
  (self as unknown as { MonacoEnvironment: MonacoNs.Environment }).MonacoEnvironment = {
    getWorker(_id: string, label: string) {
      switch (label) {
        case 'json':
          return new json.default();
        case 'css':
        case 'scss':
        case 'less':
          return new css.default();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new html.default();
      }
      return new editor.default();
    },
  };
  const m = monaco as unknown as Monaco;
  followTheme(m);
  return m;
}

/** A CSS color as Monaco takes it (#rrggbb or #rrggbbaa). */
export function hexColor(css: string, fallback: string): string {
  const s = css.trim();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + [...s.slice(1)].map((c) => c + c).join('');
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (!m) return fallback;
  const hex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  let a = '';
  if (m[4] !== undefined) {
    const v = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (v < 1) a = hex(v * 255);
  }
  return `#${hex(+m[1])}${hex(+m[2])}${hex(+m[3])}${a}`;
}

const THEME = { dark: 'app-dark', light: 'app-light' } as const;

/** Defines the app's themes from its design tokens and applies the one in
 * use. */
function defineThemes(monaco: Monaco) {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => hexColor(style.getPropertyValue(name), fallback);
  for (const kind of ['dark', 'light'] as const) {
    const dark = kind === 'dark';
    // The tokens are those of the theme in use; the other theme gets
    // Monaco's own colors until it is in use.
    const own = document.documentElement.dataset.theme === kind || (!document.documentElement.dataset.theme && dark);
    monaco.editor.defineTheme(THEME[kind], {
      base: dark ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [],
      colors: own
        ? {
            'editor.background': v('--ds-color-background', dark ? '#0a0a0a' : '#ffffff'),
            'editor.foreground': v('--ds-color-foreground', dark ? '#f0f0f0' : '#0a0a0a'),
            'editorGutter.background': v('--ds-color-background', dark ? '#0a0a0a' : '#ffffff'),
            'editor.lineHighlightBackground': v('--ds-color-hover', dark ? '#262626' : '#f0f0f0'),
            'editor.selectionBackground': v('--ds-terminal-selection', dark ? '#3b4a6b' : '#b4d5fe'),
            'editorLineNumber.foreground': v('--ds-color-faint', '#7a7a7a'),
            'editorLineNumber.activeForeground': v('--ds-color-muted', '#acacac'),
            'editorWidget.background': v('--ds-color-sidebar', dark ? '#171717' : '#fafafa'),
            'editorWidget.border': v('--ds-color-border-strong', dark ? '#3a3a3a' : '#d4d4d4'),
            focusBorder: v('--ds-color-focus-ring', '#8a8a8a'),
          }
        : {},
    });
  }
}

function themeName(): string {
  return THEME[resolveTheme(usePrefs.getState().prefs.theme, useSystemDark.getState().dark)];
}

/** Keeps Monaco's theme and font with the app's settings. */
function followTheme(monaco: Monaco) {
  const apply = () => {
    defineThemes(monaco);
    monaco.editor.setTheme(themeName());
  };
  apply();
  // After the app sets data-theme and the tokens for the new theme.
  usePrefs.subscribe(() => requestAnimationFrame(apply));
  useSystemDark.subscribe(() => requestAnimationFrame(apply));
}

/** The editor's options that follow the settings: the terminal's font. */
export function fontOptions(): MonacoNs.editor.IEditorOptions {
  const a = appearanceOf(usePrefs.getState().prefs);
  return {
    fontFamily: `${a.fontFamily ? a.fontFamily + ', ' : ''}'JetBrains Mono', Menlo, monospace`,
    fontSize: a.fontSize,
  };
}

const common: MonacoNs.editor.IEditorOptions = {
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fixedOverflowWidgets: true,
  renderWhitespace: 'selection',
};

/** An editor in el. */
export async function createEditor(
  el: HTMLElement,
  opts: MonacoNs.editor.IStandaloneEditorConstructionOptions = {},
): Promise<{ monaco: Monaco; editor: CodeEditor }> {
  const monaco = await loadMonaco();
  const editor = monaco.editor.create(el, { ...common, ...fontOptions(), theme: themeName(), ...opts });
  return { monaco, editor };
}

/** A diff editor in el (original left, modified right). */
export async function createDiffEditor(
  el: HTMLElement,
  opts: MonacoNs.editor.IStandaloneDiffEditorConstructionOptions = {},
): Promise<{ monaco: Monaco; editor: DiffEditor }> {
  const monaco = await loadMonaco();
  const editor = monaco.editor.createDiffEditor(el, {
    ...common,
    ...fontOptions(),
    theme: themeName(),
    hideUnchangedRegions: { enabled: true },
    ...opts,
  });
  return { monaco, editor };
}
