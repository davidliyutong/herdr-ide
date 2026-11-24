import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMANDS,
  PLATFORMS,
  Platform,
  Store,
  When,
  conflicts,
  functionKey,
  isKeybindingsError,
  normalize,
  parse,
  ParseError,
  type Command,
  type Rule,
  type State,
} from './index.ts';
import { REPO_ROOT } from '#shared/lib/repo.ts';

const vectors = join(REPO_ROOT, 'spec/vectors/keys');
const registryPath = join(REPO_ROOT, 'spec/generated/registry.json');
const readJSON = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'keybindings-test-'));
  temps.push(d);
  return d;
}

function effective(st: State, platform: string, command: string): string[] {
  return st.effective[platform].filter((r) => r.command === command).map((r) => `${r.key}@${r.when}`);
}

/** The error code fn throws with ("" for none). */
function errorOf(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    if (isKeybindingsError(e)) return e.code;
    throw e;
  }
  return '';
}

/** The client's matcher (web/src/keymap.ts's applies and feedStroke), to
 * run the vectors of strokes against the bindings the core serves. */
type KeyContext = 'terminal' | 'shell' | 'vscode' | 'dialog';
function applies(when: string | undefined, ctx: KeyContext): boolean {
  switch (when) {
    case 'always':
      return true;
    case 'terminal':
      return ctx === 'terminal' || ctx === 'shell' || ctx === 'vscode';
    case 'editor':
      return ctx === 'terminal' || ctx === 'vscode';
    default:
      return when === ctx;
  }
}
function run(bindings: readonly Rule[], strokes: string[], ctx: KeyContext): string[] {
  let pending = '';
  return strokes.map((stroke) => {
    const live = bindings.filter((b) => applies(b.when, ctx));
    const seq = pending ? `${pending} ${stroke}` : stroke;
    const exact = live.find((b) => b.key === seq);
    const was = pending;
    pending = '';
    if (exact) return `run:${exact.command}`;
    if (live.some((b) => b.key.startsWith(seq + ' '))) {
      pending = seq;
      return 'pending';
    }
    if (!was) return 'none';
    if (!was.includes(' ') && stroke === was) return 'literal';
    return 'swallow';
  });
}

/** Whether a single stroke is canonical (a stroke that types text cannot
 * start a sequence: it is read after one that can). */
function canonicalStroke(s: string): boolean {
  try {
    return normalize('ctrl+x ' + s) === 'ctrl+x ' + s;
  } catch {
    return false;
  }
}

describe('keys', () => {
  // The vectors every client's parser runs (spec/vectors/keys/parse.json).
  test('parse vectors', () => {
    const v = readJSON<{ cases: { input: string; key?: string; error?: string }[] }>(join(vectors, 'parse.json'));
    expect(v.cases.length).toBeGreaterThanOrEqual(30);
    for (const c of v.cases) {
      if (c.error) {
        let code = '';
        try {
          normalize(c.input);
        } catch (e) {
          code = e instanceof ParseError ? e.code : String(e);
        }
        expect(code, c.input).toBe(c.error);
      } else {
        const got = normalize(c.input);
        expect(got, c.input).toBe(c.key!);
        // The canonical form reads back as itself.
        expect(normalize(got), got).toBe(got);
      }
    }
  });

  test('parse errors', () => {
    expect(() => parse('ctrl+a b c d e')).toThrow('key: length: at most 4 strokes');
    expect(() => parse('x')).toThrow('key: typing: x');
    expect(() => parse(' \t ')).toThrow('key: empty');
    expect(() => parse('hyper+x')).toThrow('key: modifier: hyper');
    expect(() => parse('ctrl+ctrl+x')).toThrow('key: repeat: ctrl');
    expect(normalize('f5')).toBe('f5');
    expect(normalize('Ctrl+B\u00a0C')).toBe('ctrl+b c');
  });

  // The strokes the other vectors name are canonical by the core's rules.
  test('vector strokes are canonical', () => {
    const events = readJSON<{ cases: { stroke: string | null }[] }>(join(vectors, 'events.json'));
    const sequences = readJSON<{ bindings: Rule[]; cases: { strokes: string[] }[] }>(join(vectors, 'sequences.json'));
    const defaults = readJSON<{ cases: { strokes: string[] }[] }>(join(vectors, 'defaults.json'));
    const strokes = [
      ...events.cases.flatMap((c) => (c.stroke === null ? [] : [c.stroke])),
      ...sequences.cases.flatMap((c) => c.strokes),
      ...defaults.cases.flatMap((c) => c.strokes),
    ];
    expect(strokes.length).toBeGreaterThan(50);
    for (const s of strokes) expect(canonicalStroke(s), s).toBe(true);
    for (const b of sequences.bindings) expect(normalize(b.key)).toBe(b.key);
  });
});

describe('keybindings', () => {
  // The defaults are the applications' direct shortcuts, Ctrl+B for
  // escaping focus from a pane to app chrome, and a few keys browsers leave
  // to pages.
  test('defaults', () => {
    const s = new Store('', COMMANDS);
    const find = (platform: string, command: string) =>
      s
        .defaults(platform)
        .filter((r) => r.command === command)
        .map((r) => r.key);
    const cases: [string, string, string[]][] = [
      [Platform.Mac, 'tab.new', ['cmd+t']],
      [Platform.Windows, 'tab.new', ['ctrl+shift+t']],
      [Platform.Linux, 'tab.new', ['ctrl+shift+t']],
      [Platform.MacBrowser, 'tab.new', []],
      [Platform.WindowsBrowser, 'find.open', ['ctrl+shift+f']],
      [Platform.LinuxBrowser, 'find.open', ['ctrl+shift+f']],
      [Platform.MacBrowser, 'find.open', ['cmd+f']],
      [Platform.Mac, 'pane.close', ['cmd+w']],
      [Platform.Windows, 'tab.close', ['ctrl+shift+w']],
      [Platform.Linux, 'tab.close', ['ctrl+shift+w']],
      [Platform.Mac, 'app.commandPalette', ['cmd+shift+p']],
      [Platform.Windows, 'app.commandPalette', ['ctrl+shift+p']],
      [Platform.Linux, 'app.commandPalette', ['ctrl+shift+p']],
      [Platform.MacBrowser, 'app.commandPalette', ['cmd+k']],
      [Platform.WindowsBrowser, 'app.commandPalette', []],
      [Platform.LinuxBrowser, 'app.commandPalette', []],
      [Platform.Mac, 'app.keyboardShortcuts', ['cmd+slash']],
      [Platform.MacBrowser, 'app.keyboardShortcuts', ['cmd+slash']],
      [Platform.Windows, 'app.keyboardShortcuts', ['ctrl+shift+slash']],
      [Platform.Linux, 'app.keyboardShortcuts', ['ctrl+shift+slash']],
      [Platform.WindowsBrowser, 'app.keyboardShortcuts', ['ctrl+shift+slash']],
      [Platform.LinuxBrowser, 'app.keyboardShortcuts', ['ctrl+shift+slash']],
      [Platform.WindowsBrowser, 'tab.select9', []],
      [Platform.LinuxBrowser, 'tab.select9', []],
      [Platform.MacBrowser, 'tab.select1', []],
      [Platform.Mac, 'tab.select1', ['cmd+1']],
      [Platform.Mac, 'tab.select9', ['cmd+9']],
      [Platform.Windows, 'tab.select2', ['alt+2']],
      [Platform.Linux, 'tab.select2', ['alt+2']],
      [Platform.Mac, 'tab.close', ['cmd+shift+w']],
      [Platform.Mac, 'tab.next', ['cmd+shift+bracketright', 'ctrl+tab']],
      [Platform.Windows, 'tab.previous', ['ctrl+shift+tab']],
      [Platform.Linux, 'tab.previous', ['ctrl+shift+tab', 'ctrl+pageup']],
      [Platform.Mac, 'pane.zoom', ['cmd+shift+enter']],
      [Platform.Mac, 'pane.leave', ['ctrl+b']],
      [Platform.Windows, 'pane.leave', ['ctrl+b']],
      [Platform.Linux, 'pane.leave', ['ctrl+b']],
      [Platform.MacBrowser, 'pane.leave', ['ctrl+b']],
      [Platform.WindowsBrowser, 'pane.leave', ['ctrl+b']],
      [Platform.LinuxBrowser, 'pane.leave', ['ctrl+b']],
      [Platform.Mac, 'pane.splitRight', ['cmd+d']],
      [Platform.Windows, 'pane.splitRight', ['alt+shift+equal']],
      [Platform.Linux, 'pane.splitRight', ['ctrl+shift+d']],
      [Platform.Mac, 'pane.splitDown', ['cmd+shift+d']],
      [Platform.Windows, 'pane.splitDown', ['alt+shift+minus']],
      [Platform.Linux, 'pane.splitDown', ['ctrl+shift+o']],
      [Platform.Mac, 'pane.focusLeft', ['cmd+alt+left']],
      [Platform.Windows, 'pane.focusLeft', ['alt+shift+left']],
      [Platform.Linux, 'pane.focusLeft', ['alt+shift+left']],
      [Platform.Mac, 'pane.focusNext', []],
      [Platform.Mac, 'pane.back', ['cmd+bracketleft']],
      [Platform.Mac, 'pane.forward', ['cmd+bracketright']],
      [Platform.Windows, 'pane.back', ['alt+left']],
      [Platform.Linux, 'pane.back', ['alt+left']],
      [Platform.Windows, 'pane.forward', ['alt+right']],
      [Platform.Linux, 'pane.forward', ['alt+right']],
      [Platform.Mac, 'pane.undoClose', ['cmd+z']],
      [Platform.Windows, 'pane.undoClose', ['ctrl+shift+z']],
      [Platform.Linux, 'pane.undoClose', ['ctrl+shift+z']],
      [Platform.Windows, 'workspace.next', ['ctrl+shift+pagedown']],
      [Platform.Linux, 'workspace.next', ['ctrl+alt+down']],
      [Platform.MacBrowser, 'pane.zoom', []],
      [Platform.Mac, 'code.open', ['cmd+j']],
      [Platform.Windows, 'code.open', ['ctrl+shift+j']],
      [Platform.Linux, 'code.open', ['ctrl+shift+j']],
      [Platform.LinuxBrowser, 'code.open', []],
      // Browsers zoom pages with these keys themselves.
      [Platform.Mac, 'view.zoomIn', ['cmd+shift+equal', 'cmd+equal']],
      [Platform.Windows, 'view.zoomOut', ['ctrl+minus']],
      [Platform.Linux, 'view.zoomReset', ['ctrl+0']],
      [Platform.MacBrowser, 'view.zoomIn', []],
      [Platform.LinuxBrowser, 'view.zoomReset', []],
    ];
    for (const [platform, command, keys] of cases) expect(find(platform, command), `${platform} ${command}`).toEqual(keys);
    for (const p of PLATFORMS) {
      for (const r of s.defaults(p)) {
        const seq = parse(r.key);
        expect(seq.length, `${p}: ${r.command}'s default ${r.key} is not a single stroke`).toBe(1);
        // Keys programs in terminals read: Ctrl or Alt with a letter alone,
        // function keys (except pane.leave's ctrl+b focus escape).
        const k = seq[0];
        const terminalKey = ((k.ctrl || k.alt) && !k.cmd && !k.shift && /^[a-z]$/.test(k.key)) || functionKey.test(k.key);
        expect(r.command !== 'pane.leave' && terminalKey, `${p}: ${r.command}'s default ${r.key} is a key of terminal programs`).toBe(
          false,
        );
      }
      // No platform has conflicting defaults.
      expect(conflicts(s.defaults(p)), p).toEqual([]);
      // The command palette and the list of shortcuts are on the keyboard
      // wherever a key is left for them.
      expect(find(p, 'app.keyboardShortcuts').length, p).toBeGreaterThan(0);
      if (p !== Platform.WindowsBrowser && p !== Platform.LinuxBrowser) expect(find(p, 'app.commandPalette').length, p).toBeGreaterThan(0);
    }
  });

  // The commands and defaults the core serves are those scripts/registry
  // wrote for the clients (spec/generated/registry.json), in its order.
  test('registry', () => {
    const registry = readJSON<{ commands: unknown; keybindings: Record<string, Rule[]> }>(registryPath);
    const s = new Store('', COMMANDS);
    expect(s.commandList()).toEqual(registry.commands as never);
    expect(JSON.stringify(s.allDefaults())).toBe(JSON.stringify(registry.keybindings));
  });

  // Strokes against each platform's defaults, as a client matches them
  // (spec/vectors/keys/defaults.json); and chords bound by the user.
  test('default and sequence vectors', () => {
    const s = new Store('', COMMANDS);
    const defaults = readJSON<{
      cases: { description: string; platforms: string[]; context: KeyContext; strokes: string[]; results: string[] }[];
    }>(join(vectors, 'defaults.json'));
    expect(defaults.cases.length).toBeGreaterThan(4);
    for (const c of defaults.cases) {
      for (const p of c.platforms) expect(run(s.defaults(p), c.strokes, c.context), `${p}: ${c.description}`).toEqual(c.results);
    }
    // The sequences' bindings are user rules the core takes as they are.
    const seq = readJSON<{ bindings: Rule[]; cases: { description: string; context: KeyContext; strokes: string[]; results: string[] }[] }>(
      join(vectors, 'sequences.json'),
    );
    const user = new Store('', COMMANDS);
    user.setUser(seq.bindings);
    expect(user.state().problems).toEqual([]);
    for (const b of seq.bindings) expect(user.state().effective[Platform.Mac]).toContainEqual(b);
    for (const c of seq.cases) expect(run(seq.bindings, c.strokes, c.context), c.description).toEqual(c.results);
  });

  // Chords bound in the user's file still work, ctrl+b chords included once
  // pane.leave is unbound (otherwise ctrl+b reports a prefix conflict).
  test('user chords', () => {
    const s = new Store(join(tempDir(), 'keybindings.json'), COMMANDS);
    s.setUser([
      { key: 'ctrl+b', command: '-pane.leave' },
      { key: 'ctrl+b c', command: 'tab.new' },
      { key: 'ctrl+b shift+slash', command: 'app.keyboardShortcuts' },
      { key: 'ctrl+b x', command: 'pane.close' },
    ]);
    const st = s.state();
    for (const p of PLATFORMS) {
      expect(effective(st, p, 'tab.new'), p).toContain('ctrl+b c@terminal');
      expect(st.conflicts[p], p).toEqual([]);
    }
    expect(effective(st, Platform.LinuxBrowser, 'app.keyboardShortcuts')).toEqual([
      'ctrl+shift+slash@terminal',
      'ctrl+b shift+slash@terminal',
    ]);
    // Keeping ctrl+b bound to pane.leave while adding a ctrl+b chord reports
    // a prefix conflict.
    s.setUser([{ key: 'ctrl+b c', command: 'tab.new' }]);
    const c = s.state().conflicts[Platform.Mac];
    expect(c.length).toBe(1);
    expect(c[0]).toMatchObject({ key: 'ctrl+b', prefix: true });
  });

  // User rules add bindings and remove defaults ("-<command>"), in order; a
  // rule for a command this version does not know is kept but does nothing.
  test('user rules', () => {
    const path = join(tempDir(), 'keybindings.json');
    const s = new Store(path, COMMANDS);
    s.load();
    let changed = 0;
    s.onChange(() => changed++);
    s.setUser([
      { key: 'Cmd+Shift+T', command: 'tab.new' },
      { key: 'cmd+t', command: '-tab.new' },
      { command: '-pane.zoom' },
      { key: 'ctrl+k z', command: 'pane.zoom', when: 'always' },
      { key: 'ctrl+k x', command: 'future.command', args: { x: 1 } },
      { key: 'cmd+w', command: 'tab.close' },
    ]);
    const st = s.state();
    expect(effective(st, Platform.Mac, 'tab.new')).toEqual(['cmd+shift+t@terminal']);
    // User rules apply on every platform.
    expect(effective(st, Platform.Windows, 'tab.new')).toEqual(['ctrl+shift+t@terminal', 'cmd+shift+t@terminal']);
    expect(effective(st, Platform.Linux, 'tab.new')).toEqual(['ctrl+shift+t@terminal', 'cmd+shift+t@terminal']);
    expect(effective(st, Platform.Mac, 'pane.zoom')).toEqual(['ctrl+k z@always']);
    expect(st.problems).toEqual([{ index: 4, code: 'unknown', detail: 'future.command' }]);
    // cmd+w closes the pane and the tab now.
    expect(st.conflicts[Platform.Mac]).toEqual([{ key: 'cmd+w', commands: ['pane.close', 'tab.close'] }]);
    expect(changed).toBe(1);

    // The file keeps every entry as written, unknown ones included.
    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[];
    expect(file.length).toBe(6);
    expect(file[4].args).toEqual({ x: 1 });
    expect(file[0].key).toBe('Cmd+Shift+T');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    for (const bad of [
      [{ key: 'x', command: 'tab.new' }],
      [{ key: 'ctrl+x', command: 'tab new' }],
      [{ key: 'ctrl+x', command: 'tab.new', when: 'sometimes' }],
      [{ key: 'ctrl+x' }],
      ['ctrl+x'],
      [{ key: '', command: 'tab.new' }],
      [{ key: 1, command: 'tab.new' }],
      [[]],
      new Array(1001).fill({ key: 'ctrl+x', command: 'tab.new' }),
    ]) {
      expect(
        errorOf(() => s.setUser(bad)),
        JSON.stringify(bad).slice(0, 80),
      ).toBe('invalid');
    }
    expect(s.state().user.length).toBe(6);
  });

  // Entries are read as Go decodes them into a struct: names in any case,
  // null as no value; the file is written as Go indents it.
  test('rules as Go reads and writes them', () => {
    const path = join(tempDir(), 'keybindings.json');
    writeFileSync(path, `[{"KEY": "ctrl+k n", "Command": "tab.new", "when": null}, null, {"key": 1, "command": "tab.new"}, 3]`);
    const s = new Store(path, COMMANDS);
    s.load();
    expect(effective(s.state(), Platform.Linux, 'tab.new')).toEqual(['ctrl+shift+t@terminal', 'ctrl+k n@terminal']);
    expect(s.state().problems).toEqual([
      { index: 1, code: 'invalid', detail: 'invalid command ""' },
      { index: 2, code: 'invalid', detail: 'not a rule object' },
      { index: 3, code: 'invalid', detail: 'not a rule object' },
    ]);
    expect(errorOf(() => s.setUser([null]))).toBe('invalid');
    s.setUser([
      { KEY: 'ctrl+k n', Command: 'tab.new', when: null },
      { key: 'ctrl+k <', command: '-tab.new', x: [] },
    ]);
    expect(effective(s.state(), Platform.Linux, 'tab.new')).toEqual(['ctrl+shift+t@terminal', 'ctrl+k n@terminal']);
    expect(s.state().problems).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(
      '[\n  {\n    "KEY": "ctrl+k n",\n    "Command": "tab.new",\n    "when": null\n  },\n  {\n    "key": "ctrl+k \\u003c",\n    "command": "-tab.new",\n    "x": []\n  }\n]\n',
    );
    s.setUser([]);
    expect(readFileSync(path, 'utf8')).toBe('[]\n');
  });

  test('conflicts', () => {
    const got = conflicts([
      { key: 'ctrl+b', command: 'a', when: When.Terminal },
      { key: 'ctrl+b c', command: 'b', when: When.Terminal },
      { key: 'ctrl+b c', command: 'c', when: When.VSCode },
      { key: 'cmd+j', command: 'd', when: When.Always },
      { key: 'cmd+j', command: 'e', when: When.VSCode },
      { key: 'cmd+k', command: 'f', when: When.Dialog },
      { key: 'cmd+k', command: 'g', when: When.Terminal },
      { key: 'cmd+e', command: 'h', when: When.Editor },
      { key: 'cmd+e', command: 'i', when: When.Terminal },
      { key: 'cmd+l', command: 'j', when: When.Editor },
      { key: 'cmd+l', command: 'k', when: When.Dialog },
    ]);
    // The main UI's bindings apply in VS Code panes too: b and c meet there;
    // those outside terminals (editor) meet the main UI's, not dialogs'.
    expect(JSON.stringify(got)).toBe(
      JSON.stringify([
        { key: 'cmd+e', commands: ['h', 'i'] },
        { key: 'cmd+j', commands: ['d', 'e'] },
        { key: 'ctrl+b', commands: ['a', 'b', 'c'], prefix: true },
        { key: 'ctrl+b c', commands: ['b', 'c'] },
      ]),
    );
  });

  // Edits by hand are read again; a file that is not an array keeps the
  // rules and is not written over.
  test('reload', () => {
    const path = join(tempDir(), 'keybindings.json');
    writeFileSync(path, `[{"key": "ctrl+k n", "command": "tab.new"}]`, { mode: 0o600 });
    const s = new Store(path, COMMANDS);
    s.load();
    let notified = 0;
    s.onChange(() => notified++);
    const edit = (content: string) => {
      writeFileSync(path, content, { mode: 0o600 });
      const future = new Date(Date.now() + (notified + 1) * 60_000);
      utimesSync(path, future, future);
      s.reload();
    };
    edit(`[{"key": "ctrl+k m", "command": "tab.new"}]`);
    expect(effective(s.state(), Platform.Linux, 'tab.new')).toEqual(['ctrl+shift+t@terminal', 'ctrl+k m@terminal']);
    expect(notified).toBe(1);
    edit(`[{"key": `);
    expect(effective(s.state(), Platform.Linux, 'tab.new').length).toBe(2);
    expect(s.state().problems[0]).toMatchObject({ index: -1, code: 'parse' });
    expect(errorOf(() => s.setUser([]))).toBe('file');
    edit(`{"key": "ctrl+k m"}`);
    expect(s.state().problems[0]).toMatchObject({ index: -1, code: 'parse', detail: 'not a JSON array' });
    edit(`[]`);
    expect(effective(s.state(), Platform.Linux, 'tab.new').length).toBe(1);
    expect(s.state().problems).toEqual([]);
    edit(`null`);
    expect(s.state().problems).toEqual([]);
  });

  test('watch', async () => {
    const path = join(tempDir(), 'keybindings.json');
    const s = new Store(path, COMMANDS);
    s.load();
    const changed = new Promise<void>((resolve) => s.onChange(resolve));
    const ac = new AbortController();
    const done = s.watch(ac.signal, 10);
    writeFileSync(path, `[{"key": "ctrl+k m", "command": "tab.new"}]`);
    await changed;
    expect(effective(s.state(), Platform.Mac, 'tab.new')).toEqual(['cmd+t@terminal', 'ctrl+k m@terminal']);
    ac.abort();
    await done;
  });

  test('invalid commands refused', () => {
    const bad: Command[][] = [
      [{ id: 'a b', section: 'app', when: When.Terminal, defaults: [] }],
      [{ id: '-a', section: 'app', when: When.Terminal, defaults: [] }],
      [{ id: 'a', section: 'app', when: 'sometimes' as When, defaults: [] }],
      [{ id: 'a', section: 'app', when: When.Terminal, defaults: [{ key: 'Ctrl+X', platforms: [] }] }],
      [{ id: 'a', section: 'app', when: When.Terminal, defaults: [{ key: 'x', platforms: [] }] }],
      [
        { id: 'a', section: 'app', when: When.Terminal, defaults: [] },
        { id: 'a', section: 'app', when: When.Terminal, defaults: [] },
      ],
    ];
    for (const commands of bad) expect(() => new Store('', commands), commands[0].id).toThrow();
  });
});
