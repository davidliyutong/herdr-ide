// Monaco, the editor of VS Code, for plugins' panes (the file explorer's
// editor, diffs). It loads on first use: the main bundle does not carry it.
// What loads is its core with every editor feature, its languages (their
// brackets, comments and indentation) and the language services of JSON,
// CSS and HTML, each with its worker (a file of its own the browser fetches
// when a model of that language opens). TypeScript's and JavaScript's
// service is left out: its worker is larger than the rest of Monaco
// together, and those files keep their colors. Code is colored by the
// app's own highlighter (../highlight: TextMate grammars, as VS Code's),
// which also knows languages Monaco does not (Makefile, TOML, CMake…);
// Monaco's own coloring stays for the languages that highlighter lacks and
// for JSON. Its theme follows the app's light or dark theme and its colors
// (the design tokens), its font the terminal's, also in editors already
// open when they change.

import type * as MonacoNs from 'monaco-editor';
import { usePrefs } from '../prefs';
import { locale } from '../i18n';
import { allowedLocales } from './monacoLocales';
import { appearanceOf, resolveTheme, useSystemDark } from '../appearance';
import { quoteFontFamily } from '../terminal/fonts';
import { lineTokenizer, type LineTokenizer } from '../highlight/highlighter';
import { LANGS, languageOf } from '../highlight/languages';
import { ROLES, ROLE_STYLE, ROLE_TOKEN } from '../highlight/roles';
import './monaco.css';

export type Monaco = typeof MonacoNs;
export type CodeEditor = MonacoNs.editor.IStandaloneCodeEditor;
export type DiffEditor = MonacoNs.editor.IStandaloneDiffEditor;
export type TextModel = MonacoNs.editor.ITextModel;
export type EditorViewState = MonacoNs.editor.ICodeEditorViewState;

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
  registerLanguages(m);
  followTheme(m);
  return m;
}

/** A line's state for Monaco: the tokenizer's own, compared by it. */
class LineState implements MonacoNs.languages.IState {
  constructor(
    readonly tokenizer: LineTokenizer,
    readonly state: unknown,
  ) {}
  clone() {
    return new LineState(this.tokenizer, this.state);
  }
  equals(other: MonacoNs.languages.IState) {
    return other instanceof LineState && this.tokenizer.same(this.state, other.state);
  }
}

/** The app's highlighter as Monaco's tokenizer of a language: a token's
 * type is its role, which the themes color (defineThemes). Null (plain
 * text) when the grammar cannot be loaded. */
async function tokensProvider(id: string): Promise<MonacoNs.languages.TokensProvider | null> {
  const t = await lineTokenizer(id).catch(() => undefined);
  if (!t) return null;
  return {
    getInitialState: () => new LineState(t, t.initial),
    tokenize(line, state) {
      const r = t.line(line, (state as LineState).state);
      return { endState: new LineState(t, r.state), tokens: r.tokens.map((x) => ({ startIndex: x.start, scopes: x.role ?? '' })) };
    },
  };
}

const PAIRS: [string, string][] = [
  ['{', '}'],
  ['[', ']'],
  ['(', ')'],
];

/** Gives Monaco the app's languages: those it lacks get an id with their
 * comment signs and the common brackets, and all are colored by the app's
 * highlighter. A factory registered for a language replaces the one Monaco
 * registered for its own coloring; the grammar loads when a model of the
 * language first shows. */
function registerLanguages(monaco: Monaco) {
  const known = new Set(monaco.languages.getLanguages().map((l) => l.id));
  for (const l of LANGS) {
    if (!known.has(l.id)) {
      monaco.languages.register({ id: l.id });
      const pairs = [...PAIRS.map(([open, close]) => ({ open, close })), { open: '"', close: '"' }, { open: "'", close: "'" }];
      monaco.languages.setLanguageConfiguration(l.id, {
        comments: typeof l.comment === 'string' ? { lineComment: l.comment } : l.comment ? { blockComment: l.comment } : undefined,
        brackets: PAIRS,
        autoClosingPairs: pairs,
        surroundingPairs: pairs,
      });
    }
    if (!l.ownTokens) monaco.languages.registerTokensProviderFactory(l.id, { create: () => tokensProvider(l.id) });
  }
}

/** Sets a model's language by its file's name and, for a name that says
 * nothing, by the program its text's first line names (`#!/bin/sh`). A
 * file the app's table does not know keeps what Monaco made of its name. */
export function setLanguage(monaco: Monaco, model: TextModel, fileName: string) {
  const id = languageOf(fileName) ?? languageOf(fileName, model.getLineContent(1));
  if (id && model.getLanguageId() !== id) monaco.editor.setModelLanguage(model, id);
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
    // A token's type is its role (tokensProvider); Monaco's own tokenizers
    // name theirs alike (comment, keyword, string, number, type, tag…), so
    // the languages they still color take the same colors. JSON's keys are
    // strings to its tokenizer.
    const rules: MonacoNs.editor.ITokenThemeRule[] = [];
    if (own) {
      const rule = (token: string, css: string, fontStyle?: string) => {
        const c = v(css, '');
        if (c) rules.push({ token, foreground: c.slice(1), fontStyle });
      };
      for (const role of ROLES) rule(role, ROLE_TOKEN[role], ROLE_STYLE[role]);
      rule('string.key', ROLE_TOKEN.property);
    }
    monaco.editor.defineTheme(THEME[kind], {
      base: dark ? 'vs-dark' : 'vs',
      inherit: true,
      rules,
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
            'menu.background': v('--ds-color-hover', dark ? '#262626' : '#f0f0f0'),
            'menu.foreground': v('--ds-color-foreground', dark ? '#f0f0f0' : '#0a0a0a'),
            'menu.border': v('--ds-color-border-strong', dark ? '#3a3a3a' : '#d4d4d4'),
            'menu.separatorBackground': v('--ds-color-border', dark ? '#2a2a2a' : '#e5e5e5'),
            'menu.selectionBackground': v('--ds-accent', dark ? '#7aa2f7' : '#3a63c8'),
            'menu.selectionForeground': v('--ds-on-accent', '#ffffff'),
            'list.hoverBackground': v('--ds-accent', dark ? '#7aa2f7' : '#3a63c8'),
            'list.hoverForeground': v('--ds-on-accent', '#ffffff'),
            'widget.shadow': v('--shadow', dark ? '#00000080' : '#0a0a0a2e'),
            focusBorder: v('--ds-accent', dark ? '#7aa2f7' : '#3a63c8'),
            'editorCursor.foreground': v('--ds-accent', dark ? '#7aa2f7' : '#3a63c8'),
            'editorGutter.addedBackground': v('--ds-git-added', dark ? '#81b88b' : '#587c0c'),
            'editorGutter.modifiedBackground': v('--ds-git-modified', dark ? '#e2c08d' : '#895503'),
            'editorGutter.deletedBackground': v('--ds-git-deleted', dark ? '#c74e39' : '#ad0707'),
            'minimapGutter.addedBackground': v('--ds-git-added', dark ? '#81b88b' : '#587c0c'),
            'minimapGutter.modifiedBackground': v('--ds-git-modified', dark ? '#e2c08d' : '#895503'),
            'minimapGutter.deletedBackground': v('--ds-git-deleted', dark ? '#c74e39' : '#ad0707'),
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
  appliedFont = JSON.stringify(fontOptions());
  // After the app sets data-theme and the tokens for the new theme.
  usePrefs.subscribe(() =>
    requestAnimationFrame(() => {
      apply();
      applyFont(() => monaco.editor.remeasureFonts());
    }),
  );
  useSystemDark.subscribe(() => requestAnimationFrame(apply));
}

/** The editor's options that follow the settings: the terminal's font. */
export function fontOptions(): MonacoNs.editor.IEditorOptions {
  const a = appearanceOf(usePrefs.getState().prefs);
  const primary = a.fontFamily.trim();
  const cjk = quoteFontFamily(a.cjkFontFamily);
  return {
    fontFamily: [primary, "'JetBrains Mono'", 'Menlo', cjk, "'Noto Sans Mono CJK SC'", "'PingFang SC'", 'monospace']
      .filter(Boolean)
      .join(', '),
    fontSize: a.fontSize,
  };
}

/** An editor or diff editor whose font follows the settings. */
export interface FontFollower {
  updateOptions(o: MonacoNs.editor.IEditorOptions): void;
  onDidDispose(listener: () => void): unknown;
}

const followers = new Set<FontFollower>();
let appliedFont = '';

/** Keeps e's font with the settings until it is disposed. */
export function followFont(e: FontFollower) {
  followers.add(e);
  e.onDidDispose(() => followers.delete(e));
}

/** Gives the editors made the settings' font when it changed since;
 * remeasure has Monaco measure its characters again. */
export function applyFont(remeasure?: () => void) {
  const font = fontOptions();
  const key = JSON.stringify(font);
  if (key === appliedFont) return;
  appliedFont = key;
  for (const e of followers) e.updateOptions(font);
  remeasure?.();
}

export const defaultEditorOptions: MonacoNs.editor.IEditorOptions = {
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: true,
  fixedOverflowWidgets: true,
  // Keep context menus in light DOM inside .monaco-editor so fixedOverflowWidgets
  // inherits StandaloneThemeService's --vscode-* variables instead of mounting an
  // unstyled shadow-root-host directly on document.body.
  useShadowDOM: false,
  renderWhitespace: 'selection',
};

/** Unicode highlighting for an editor made now: characters of the user's
 * languages are not marked as confusable with ASCII, invisible ones stay
 * marked. The languages are read when an editor is created, so editors made
 * after the UI language changes get the new list. */
function unicodeOptions(): MonacoNs.editor.IEditorOptions {
  const languages = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return {
    unicodeHighlight: {
      ambiguousCharacters: true,
      allowedLocales: allowedLocales(languages, locale),
      nonBasicASCII: false,
      invisibleCharacters: true,
    },
  };
}

/** An editor in el. */
export async function createEditor(
  el: HTMLElement,
  opts: MonacoNs.editor.IStandaloneEditorConstructionOptions = {},
): Promise<{ monaco: Monaco; editor: CodeEditor }> {
  const monaco = await loadMonaco();
  const editor = monaco.editor.create(el, { ...defaultEditorOptions, ...unicodeOptions(), ...fontOptions(), theme: themeName(), ...opts });
  followFont(editor);
  return { monaco, editor };
}

/** A diff editor in el (original left, modified right). */
export async function createDiffEditor(
  el: HTMLElement,
  opts: MonacoNs.editor.IStandaloneDiffEditorConstructionOptions = {},
): Promise<{ monaco: Monaco; editor: DiffEditor }> {
  const monaco = await loadMonaco();
  const editor = monaco.editor.createDiffEditor(el, {
    ...defaultEditorOptions,
    ...unicodeOptions(),
    ...fontOptions(),
    theme: themeName(),
    hideUnchangedRegions: { enabled: true },
    ...opts,
  });
  followFont(editor);
  return { monaco, editor };
}
