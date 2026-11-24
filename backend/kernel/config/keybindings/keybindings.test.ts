import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fail } from '#kernel/fail.ts';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import {
  conflicts,
  functionKey,
  Keybindings,
  normalize,
  parse,
  ParseError,
  PLATFORMS,
  type Command,
  type Platform,
  type Rule,
  type State,
  type When,
} from './index.ts';

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

function effective(st: State, platform: Platform, command: string): string[] {
  return st.effective[platform].filter((r) => r.command === command).map((r) => `${r.key}@${r.when}`);
}

/** The error code fn throws with ("" for none). */
function errorOf(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof Fail) return e.code;
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
    const s = new Keybindings();
    const find = (platform: Platform, command: string) =>
      s
        .defaults(platform)
        .filter((r) => r.command === command)
        .map((r) => r.key);
    const cases: [Platform, string, string[]][] = [
      ['mac', 'tab.new', ['cmd+t']],
      ['windows', 'tab.new', ['ctrl+shift+t']],
      ['linux', 'tab.new', ['ctrl+shift+t']],
      ['mac-browser', 'tab.new', []],
      ['windows-browser', 'find.open', ['ctrl+shift+f']],
      ['linux-browser', 'find.open', ['ctrl+shift+f']],
      ['mac-browser', 'find.open', ['cmd+f']],
      ['mac', 'pane.close', ['cmd+w']],
      ['windows', 'tab.close', ['ctrl+shift+w']],
      ['linux', 'tab.close', ['ctrl+shift+w']],
      ['mac', 'app.commandPalette', ['cmd+shift+p']],
      ['windows', 'app.commandPalette', ['ctrl+shift+p']],
      ['linux', 'app.commandPalette', ['ctrl+shift+p']],
      ['mac-browser', 'app.commandPalette', ['cmd+k']],
      ['windows-browser', 'app.commandPalette', []],
      ['linux-browser', 'app.commandPalette', []],
      ['mac', 'app.keyboardShortcuts', ['cmd+slash']],
      ['mac-browser', 'app.keyboardShortcuts', ['cmd+slash']],
      ['windows', 'app.keyboardShortcuts', ['ctrl+shift+slash']],
      ['linux', 'app.keyboardShortcuts', ['ctrl+shift+slash']],
      ['windows-browser', 'app.keyboardShortcuts', ['ctrl+shift+slash']],
      ['linux-browser', 'app.keyboardShortcuts', ['ctrl+shift+slash']],
      ['windows-browser', 'tab.select9', []],
      ['linux-browser', 'tab.select9', []],
      ['mac-browser', 'tab.select1', []],
      ['mac', 'tab.select1', ['cmd+1']],
      ['mac', 'tab.select9', ['cmd+9']],
      ['windows', 'tab.select2', ['alt+2']],
      ['linux', 'tab.select2', ['alt+2']],
      ['mac', 'tab.close', ['cmd+shift+w']],
      ['mac', 'tab.next', ['cmd+shift+bracketright', 'ctrl+tab']],
      ['windows', 'tab.previous', ['ctrl+shift+tab']],
      ['linux', 'tab.previous', ['ctrl+shift+tab', 'ctrl+pageup']],
      ['mac', 'pane.zoom', ['cmd+shift+enter']],
      ['mac', 'pane.leave', ['ctrl+b']],
      ['windows', 'pane.leave', ['ctrl+b']],
      ['linux', 'pane.leave', ['ctrl+b']],
      ['mac-browser', 'pane.leave', ['ctrl+b']],
      ['windows-browser', 'pane.leave', ['ctrl+b']],
      ['linux-browser', 'pane.leave', ['ctrl+b']],
      ['mac', 'pane.splitRight', ['cmd+d']],
      ['windows', 'pane.splitRight', ['alt+shift+equal']],
      ['linux', 'pane.splitRight', ['ctrl+shift+d']],
      ['mac', 'pane.splitDown', ['cmd+shift+d']],
      ['windows', 'pane.splitDown', ['alt+shift+minus']],
      ['linux', 'pane.splitDown', ['ctrl+shift+o']],
      ['mac', 'pane.focusLeft', ['cmd+alt+left']],
      ['windows', 'pane.focusLeft', ['alt+shift+left']],
      ['linux', 'pane.focusLeft', ['alt+shift+left']],
      ['mac', 'pane.focusNext', []],
      ['mac', 'pane.back', ['cmd+bracketleft']],
      ['mac', 'pane.forward', ['cmd+bracketright']],
      ['windows', 'pane.back', ['alt+left']],
      ['linux', 'pane.back', ['alt+left']],
      ['windows', 'pane.forward', ['alt+right']],
      ['linux', 'pane.forward', ['alt+right']],
      ['mac', 'pane.undoClose', ['cmd+z']],
      ['windows', 'pane.undoClose', ['ctrl+shift+z']],
      ['linux', 'pane.undoClose', ['ctrl+shift+z']],
      ['windows', 'workspace.next', ['ctrl+shift+pagedown']],
      ['linux', 'workspace.next', ['ctrl+alt+down']],
      ['mac-browser', 'pane.zoom', []],
      ['mac', 'code.open', ['cmd+j']],
      ['windows', 'code.open', ['ctrl+shift+j']],
      ['linux', 'code.open', ['ctrl+shift+j']],
      ['linux-browser', 'code.open', []],
      // Browsers zoom pages with these keys themselves.
      ['mac', 'view.zoomIn', ['cmd+shift+equal', 'cmd+equal']],
      ['windows', 'view.zoomOut', ['ctrl+minus']],
      ['linux', 'view.zoomReset', ['ctrl+0']],
      ['mac-browser', 'view.zoomIn', []],
      ['linux-browser', 'view.zoomReset', []],
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
      if (p !== 'windows-browser' && p !== 'linux-browser') expect(find(p, 'app.commandPalette').length, p).toBeGreaterThan(0);
    }
  });

  // The commands and defaults the core serves are those kernel/config/registry.ts
  // wrote for the clients (spec/generated/registry.json), in its order.
  test('registry', () => {
    const registry = readJSON<{ commands: unknown; keybindings: Record<string, Rule[]> }>(registryPath);
    const s = new Keybindings();
    expect(s.commands()).toEqual(registry.commands as never);
    expect(JSON.stringify(s.allDefaults())).toBe(JSON.stringify(registry.keybindings));
  });

  // Strokes against each platform's defaults, as a client matches them
  // (spec/vectors/keys/defaults.json); and chords bound by the user.
  test('default and sequence vectors', () => {
    const s = new Keybindings();
    const defaults = readJSON<{
      cases: { description: string; platforms: Platform[]; context: KeyContext; strokes: string[]; results: string[] }[];
    }>(join(vectors, 'defaults.json'));
    expect(defaults.cases.length).toBeGreaterThan(4);
    for (const c of defaults.cases) {
      for (const p of c.platforms) expect(run(s.defaults(p), c.strokes, c.context), `${p}: ${c.description}`).toEqual(c.results);
    }
    // The sequences' bindings are user rules the core takes as they are.
    const seq = readJSON<{ bindings: Rule[]; cases: { description: string; context: KeyContext; strokes: string[]; results: string[] }[] }>(
      join(vectors, 'sequences.json'),
    );
    const user = new Keybindings();
    user.setUser(seq.bindings);
    expect(user.state().problems).toEqual([]);
    for (const b of seq.bindings) expect(user.state().effective['mac']).toContainEqual(b);
    for (const c of seq.cases) expect(run(seq.bindings, c.strokes, c.context), c.description).toEqual(c.results);
  });

  // Chords bound in the user's file still work, ctrl+b chords included once
  // pane.leave is unbound (otherwise ctrl+b reports a prefix conflict).
  test('user chords', () => {
    const s = new Keybindings(join(tempDir(), 'keybindings.json'));
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
    expect(effective(st, 'linux-browser', 'app.keyboardShortcuts')).toEqual(['ctrl+shift+slash@terminal', 'ctrl+b shift+slash@terminal']);
    // Keeping ctrl+b bound to pane.leave while adding a ctrl+b chord reports
    // a prefix conflict.
    s.setUser([{ key: 'ctrl+b c', command: 'tab.new' }]);
    const c = s.state().conflicts['mac'];
    expect(c.length).toBe(1);
    expect(c[0]).toMatchObject({ key: 'ctrl+b', prefix: true });
  });

  // User rules add bindings and remove defaults ("-<command>"), in order; a
  // rule for a command this version does not know is kept but does nothing.
  test('user rules', () => {
    const path = join(tempDir(), 'keybindings.json');
    const s = new Keybindings(path);
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
    expect(effective(st, 'mac', 'tab.new')).toEqual(['cmd+shift+t@terminal']);
    // User rules apply on every platform.
    expect(effective(st, 'windows', 'tab.new')).toEqual(['ctrl+shift+t@terminal', 'cmd+shift+t@terminal']);
    expect(effective(st, 'linux', 'tab.new')).toEqual(['ctrl+shift+t@terminal', 'cmd+shift+t@terminal']);
    expect(effective(st, 'mac', 'pane.zoom')).toEqual(['ctrl+k z@always']);
    expect(st.problems).toEqual([{ index: 4, code: 'unknown', detail: 'future.command' }]);
    // cmd+w closes the pane and the tab now.
    expect(st.conflicts['mac']).toEqual([{ key: 'cmd+w', commands: ['pane.close', 'tab.close'] }]);
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

  // The file is JSONC: comments and trailing commas are read; null members
  // are no value; a change from the UI edits only the entries that change
  // and keeps the rest of the text.
  test('rules in the file', () => {
    const path = join(tempDir(), 'keybindings.json');
    writeFileSync(
      path,
      `// my keys
[
  {"key": "ctrl+k n", "command": "tab.new", "when": null}, // new tab
  null,
  {"key": 1, "command": "tab.new"},
  3,
  /* zoom */ {"key": "ctrl+k z", "command": "pane.zoom"},
]
`,
    );
    const s = new Keybindings(path);
    s.load();
    expect(effective(s.state(), 'linux', 'tab.new')).toEqual(['ctrl+shift+t@terminal', 'ctrl+k n@terminal']);
    expect(s.state().problems).toEqual([
      { index: 1, code: 'invalid', detail: 'invalid command ""' },
      { index: 2, code: 'invalid', detail: 'not a rule object' },
      { index: 3, code: 'invalid', detail: 'not a rule object' },
    ]);
    expect(errorOf(() => s.setUser([null]))).toBe('invalid');
    // What the UI sends: the entries it keeps and the rules it changes.
    s.setUser([
      { key: 'ctrl+k n', command: 'tab.new', when: null },
      { key: 'ctrl+k z', command: 'pane.zoom' },
      { key: 'ctrl+k <', command: '-tab.new', x: [] },
    ]);
    expect(effective(s.state(), 'linux', 'tab.new')).toEqual(['ctrl+shift+t@terminal', 'ctrl+k n@terminal']);
    expect(s.state().problems).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(`// my keys
[
  {"key": "ctrl+k n", "command": "tab.new", "when": null}, // new tab
  /* zoom */ {"key": "ctrl+k z", "command": "pane.zoom"},
  {
    "key": "ctrl+k <",
    "command": "-tab.new",
    "x": []
  },
]
`);
    expect(s.state().user[2]).toEqual({ key: 'ctrl+k <', command: '-tab.new', x: [] });
    s.setUser([{ key: 'ctrl+k z', command: 'pane.zoom' }]);
    expect(readFileSync(path, 'utf8')).toBe(`// my keys
[
  /* zoom */ {"key": "ctrl+k z", "command": "pane.zoom"},
]
`);
    s.setUser([]);
    expect(readFileSync(path, 'utf8')).toBe('// my keys\n[]\n');
    // A new file.
    const fresh = join(tempDir(), 'keybindings.json');
    new Keybindings(fresh).setUser([{ key: 'ctrl+k n', command: 'tab.new' }]);
    expect(readFileSync(fresh, 'utf8')).toBe('[\n  {\n    "key": "ctrl+k n",\n    "command": "tab.new"\n  }\n]\n');
  });

  test('conflicts', () => {
    const got = conflicts([
      { key: 'ctrl+b', command: 'a', when: 'terminal' },
      { key: 'ctrl+b c', command: 'b', when: 'terminal' },
      { key: 'ctrl+b c', command: 'c', when: 'vscode' },
      { key: 'cmd+j', command: 'd', when: 'always' },
      { key: 'cmd+j', command: 'e', when: 'vscode' },
      { key: 'cmd+k', command: 'f', when: 'dialog' },
      { key: 'cmd+k', command: 'g', when: 'terminal' },
      { key: 'cmd+e', command: 'h', when: 'editor' },
      { key: 'cmd+e', command: 'i', when: 'terminal' },
      { key: 'cmd+l', command: 'j', when: 'editor' },
      { key: 'cmd+l', command: 'k', when: 'dialog' },
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
    const s = new Keybindings(path);
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
    expect(effective(s.state(), 'linux', 'tab.new')).toEqual(['ctrl+shift+t@terminal', 'ctrl+k m@terminal']);
    expect(notified).toBe(1);
    edit(`[{"key": `);
    expect(effective(s.state(), 'linux', 'tab.new').length).toBe(2);
    expect(s.state().problems[0]).toMatchObject({ index: -1, code: 'parse' });
    expect(errorOf(() => s.setUser([]))).toBe('file');
    edit(`{"key": "ctrl+k m"}`);
    expect(s.state().problems[0]).toMatchObject({ index: -1, code: 'parse', detail: 'not a JSON array' });
    edit(`[]`);
    expect(effective(s.state(), 'linux', 'tab.new').length).toBe(1);
    expect(s.state().problems).toEqual([]);
    edit(`null`);
    expect(s.state().problems).toEqual([]);
  });

  test('watch', async () => {
    const path = join(tempDir(), 'keybindings.json');
    const s = new Keybindings(path);
    s.load();
    const changed = new Promise<void>((resolve) => s.onChange(resolve));
    const ac = new AbortController();
    const done = s.watch(ac.signal, 10);
    writeFileSync(path, `[{"key": "ctrl+k m", "command": "tab.new"}]`);
    await changed;
    expect(effective(s.state(), 'mac', 'tab.new')).toEqual(['cmd+t@terminal', 'ctrl+k m@terminal']);
    ac.abort();
    await done;
  });

  test('invalid commands refused', () => {
    const bad: Command[][] = [
      [{ id: 'a b', section: 'app', when: 'terminal', defaults: [] }],
      [{ id: '-a', section: 'app', when: 'terminal', defaults: [] }],
      [{ id: 'a', section: 'app', when: 'sometimes' as When, defaults: [] }],
      [{ id: 'a', section: 'app', when: 'terminal', defaults: [{ key: 'Ctrl+X', platforms: [] }] }],
      [{ id: 'a', section: 'app', when: 'terminal', defaults: [{ key: 'x', platforms: [] }] }],
      [
        { id: 'a', section: 'app', when: 'terminal', defaults: [] },
        { id: 'a', section: 'app', when: 'terminal', defaults: [] },
      ],
    ];
    for (const commands of bad) expect(() => new Keybindings('', { commands }), commands[0].id).toThrow();
  });
});
