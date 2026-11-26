import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { Fail } from '#kernel/fail.ts';
import {
  bool,
  color,
  colorList,
  defineModule,
  enumOf,
  int,
  number,
  settingFlags,
  Settings,
  stringList,
  text,
  type Change,
  type Module,
} from './index.ts';

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'settings-test-'));
  temps.push(d);
  return d;
}

const MODULE = defineModule({
  sections: [
    { id: 'b', order: 20 },
    { id: 'a', order: 10 },
  ],
  settings: {
    'a.mode': enumOf(['x', 'y'], { default: 'x', section: 'a', order: 2, flag: 'mode' }),
    'a.size': number({ default: 13, min: 8, max: 32, section: 'a', order: 1 }),
    'a.lines': int({ default: 100, section: 'a', order: 3 }),
    'b.on': bool({ default: true, scope: 'remote-machine', section: 'b', flag: 'on' }),
    'b.path': text({
      default: '',
      scope: 'machine',
      section: 'b',
      order: 1,
      check: (v) => (v !== '' && !isAbsolute(v) ? 'not absolute' : undefined),
    }),
    'b.color': color({ default: '#000000', section: 'b', order: 2 }),
    'b.palette': colorList({ default: ['#000000', '#ffffff'], length: 2, section: 'b', order: 3 }),
  },
});

function newStore(content = '', flags?: Record<string, string>): { s: Settings<typeof MODULE.settings>; path: string } {
  const path = join(tempDir(), 'sub', 'settings.json');
  if (content !== '') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode: 0o600 });
  }
  const s = new Settings(path, { modules: [MODULE], flags }).of(MODULE);
  s.load();
  return { s, path };
}

const readFile = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

/** The Fail fn throws: its code and its answer's body ("" for none). */
function failOf(fn: () => void): { code: string; body?: Record<string, unknown> } {
  try {
    fn();
  } catch (e) {
    if (e instanceof Fail) return { code: e.code, body: e.body() };
    throw e;
  }
  return { code: '' };
}
const codeOf = (fn: () => void) => failOf(fn).code;

/** Sets a file's modification time ahead, so a store sees it changed. */
function touchAhead(path: string, seconds: number): void {
  const future = new Date(Date.now() + seconds * 1000);
  utimesSync(path, future, future);
}

describe('settings', () => {
  test('definitions in UI order; invalid definitions refused', () => {
    const s = new Settings('', { modules: [MODULE] });
    expect(s.definitions().map((d) => d.key)).toEqual(['a.size', 'a.mode', 'a.lines', 'b.on', 'b.path', 'b.color', 'b.palette']);
    expect(s.sections()[0]!.id).toBe('a');
    const bad: Module[] = [
      defineModule({ settings: { x: enumOf(['a'], { default: 'z' as 'a', section: 'a' }) } }),
      defineModule({ settings: { x: number({ default: 1, section: 'nope' }) } }),
      defineModule({ settings: { 'a.mode': bool({ default: true, section: 'a' }) } }),
      defineModule({ settings: { '[x]': bool({ default: true, section: 'a' }) } }),
      { sections: [{ id: 'a', order: 2 }] },
    ];
    for (const m of bad) expect(() => new Settings('', { modules: [MODULE, m] }), JSON.stringify(m)).toThrow();
  });

  // Command line, then the machine's own value, then the global value,
  // then the default.
  test('merge order', () => {
    const { s, path } = newStore();
    expect(s.get('a.size')).toBe(13);
    s.set('a.size', '', 15);
    s.set('b.on', '', false);
    s.set('b.on', 'm1', true);
    expect([s.bool('b.on'), s.bool('b.on', 'm1'), s.bool('b.on', 'm2')]).toEqual([false, true, false]);
    const st = s.state();
    expect(st.values['b.on']).toEqual({ value: false, source: 'global', machines: { m1: true } });
    expect(st.values['a.mode']).toEqual({ value: 'x', source: 'default' });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    // Another store reads the same; a flag wins everywhere and locks.
    const s2 = new Settings(path, { modules: [MODULE], flags: { on: 'off', mode: 'y', other: 'ignored', bare: true } }).of(MODULE);
    s2.load();
    expect([s2.bool('b.on', 'm1'), s2.string('a.mode'), s2.get('a.size')]).toEqual([false, 'y', 15]);
    expect(s2.state().values['b.on']).toMatchObject({ locked: true, source: 'flag' });
    for (const m of ['', 'm1']) {
      expect(codeOf(() => s2.set('b.on', m, true))).toBe('locked');
      expect(codeOf(() => s2.reset('b.on', m))).toBe('locked');
    }

    // Reset: the machine follows the global value, the global value the default.
    s.reset('b.on', 'm1');
    expect(s.bool('b.on', 'm1')).toBe(false);
    s.reset('b.on', '');
    expect(s.bool('b.on', 'm1')).toBe(true);
    expect(readFile(path)).toEqual({ 'a.size': 15 });
  });

  test('validation', () => {
    const { s } = newStore();
    const cases: [string, string, unknown, string][] = [
      ['a.mode', '', 'z', 'invalid'],
      ['a.mode', '', 1.0, 'invalid'],
      ['a.size', '', 7.0, 'invalid'],
      ['a.size', '', '13', 'invalid'],
      ['a.size', '', Infinity, 'invalid'],
      ['a.size', '', NaN, 'invalid'],
      ['a.size', '', undefined, 'invalid'],
      ['a.lines', '', 1.5, 'invalid'],
      ['b.on', '', 'true', 'invalid'],
      ['b.path', '', 'relative', 'invalid'],
      ['b.path', '', '/a\nb', 'invalid'],
      // Every control character: C0, DEL and C1.
      ['b.path', '', '/a\tb', 'invalid'],
      ['b.path', '', '/a\x1b[31mb', 'invalid'],
      ['b.path', '', '/a\x00b', 'invalid'],
      ['b.path', '', '/a\x7fb', 'invalid'],
      ['b.path', '', '/a\u0085b', 'invalid'],
      ['b.path', '', '/a\u009bb', 'invalid'],
      // Too long: more than 4096 bytes of UTF-8.
      ['b.path', '', '/' + 'é'.repeat(2048), 'invalid'],
      ['b.color', '', 'red', 'invalid'],
      ['b.palette', '', ['#000000'], 'invalid'],
      ['b.palette', '', ['#000000', 3.0], 'invalid'],
      ['b.palette', '', '#000000', 'invalid'],
      ['nope', '', 'x', 'unknown'],
      ['a.mode', 'm1', 'y', 'scope'],
      ['b.on', '[x]', true, 'scope'],
      ['b.on', 'a\nb', true, 'scope'],
      ['b.on', 'x'.repeat(257), true, 'scope'],
    ];
    for (const [key, machine, value, want] of cases) {
      expect(
        codeOf(() => s.set(key, machine, value)),
        `set(${key}, ${JSON.stringify(machine)}, ${String(value)})`,
      ).toBe(want);
    }
    expect(codeOf(() => s.set('b.path', '', '/srv/données é'))).toBe('');
    s.set('b.color', '', '#ABCDEF');
    expect(s.string('b.color')).toBe('#abcdef');
    s.set('b.palette', '', ['#FFFFFF', '#000000']);
    expect(s.get('b.palette')).toEqual(['#ffffff', '#000000']);
    // A list read is a copy.
    s.get('b.palette')[0] = '#123456';
    expect(s.get('b.palette')).toEqual(['#ffffff', '#000000']);
    // Reading an unregistered key is a programming error.
    expect(() => new Settings('').get('nope')).toThrow();
  });

  // The answers carry the reason as detail where the web UI shows it, as
  // the Go hub answered.
  test('failures', () => {
    const { s } = newStore('', { on: '1' });
    expect(failOf(() => s.set('a.size', '', 7)).body).toEqual({
      error: 'invalid',
      message: 'invalid value: a.size: must be between 8 and 32',
      detail: 'invalid value: a.size: must be between 8 and 32',
    });
    const detail = (fn: () => void) => failOf(fn).body?.detail;
    expect(detail(() => s.set('a.lines', '', 1.5))).toBe('invalid value: a.lines: must be a whole number');
    expect(detail(() => s.set('a.size', '', 'x'))).toBe('invalid value: a.size: must be a number');
    expect(detail(() => s.set('b.palette', '', ['#000000', 'x']))).toBe('invalid value: b.palette: item 2: must be a color #rrggbb');
    expect(detail(() => s.set('b.palette', '', ['#000000', 3]))).toBe('invalid value: b.palette: items must be strings');
    expect(detail(() => s.set('b.palette', '', ['#000000']))).toBe('invalid value: b.palette: must have 2 items');
    expect(detail(() => s.set('b.path', '', 'rel'))).toBe('invalid value: b.path: not absolute');
    expect(detail(() => s.set('a.mode', '', 'z'))).toBe('invalid value: a.mode: must be one of x, y');
    expect(detail(() => s.set('a.mode', 'm', 'x'))).toBe('setting has no per-machine values: a.mode');
    expect(failOf(() => s.set('nope', '', 1)).body).toEqual({ error: 'unknown', message: 'unknown setting: nope' });
    expect(failOf(() => s.set('b.on', '', true)).body).toEqual({
      error: 'locked',
      message: 'setting is fixed by a command-line flag: --on',
    });
    const statuses = [
      () => s.set('nope', '', 1),
      () => s.set('b.on', '', true),
      () => s.set('a.size', '', 7),
      () => s.set('a.mode', 'm', 'x'),
    ].map((fn) => {
      try {
        fn();
      } catch (e) {
        return (e as Fail).status;
      }
      return 0;
    });
    expect(statuses).toEqual([404, 409, 400, 400]);
  });

  test('flags', () => {
    const m = defineModule({
      sections: [{ id: 's', order: 1 }],
      settings: {
        n: number({ default: 1.5, min: 0.5, max: 4, section: 's', flag: 'n', usage: 'a number' }),
        l: stringList({ default: ['a', 'b'], section: 's', flag: 'l' }),
        b: bool({ default: false, section: 's', flag: 'b' }),
        x: text({ default: '', section: 's' }),
      },
    });
    expect(settingFlags([m])).toEqual([
      { name: 'n', key: 'n', usage: 'a number', default: '1.5' },
      { name: 'l', key: 'l', usage: '', default: 'a,b' },
      { name: 'b', key: 'b', usage: '', default: 'false' },
    ]);
    const s = new Settings('', { modules: [m], flags: { n: '2.5e0', l: '', b: 'YES' } }).of(m);
    expect([s.get('n'), s.get('l'), s.get('b')]).toEqual([2.5, [], true]);
    for (const bad of ['', 'x', '1x', 'inf', '-Infinity', 'nan', '9', '0x2']) {
      expect(
        codeOf(() => new Settings('', { modules: [m], flags: { n: bad } })),
        bad,
      ).toBe('invalid');
    }
    expect(codeOf(() => new Settings('', { modules: [m], flags: { b: 'maybe' } }))).toBe('invalid');
    expect(new Settings('', { modules: [m], flags: { l: 'x,y' } }).get('l')).toEqual(['x', 'y']);
  });

  // Keys this version does not know and values that do not validate stay
  // in the file, are reported as problems and count as unset.
  test('unknown and invalid entries kept', () => {
    const { s, path } = newStore(`{"a.size": 99, "zzz": [1, 2], "a.mode": "y", "[machine:m1]": {"a.mode": "y", "b.on": "yes", "nope": 1}}`);
    expect([s.get('a.size'), s.string('a.mode')]).toEqual([13, 'y']);
    const codes = s.state().problems.map((p) => `${p.code}:${p.machine ?? ''}/${p.key ?? ''}`);
    expect(codes.join(' ')).toBe('scope:m1/a.mode invalid:m1/b.on unknown:m1/nope invalid:/a.size unknown:/zzz');
    expect(s.state().problems.find((p) => p.key === 'a.size')?.detail).toBe('invalid value: a.size: must be between 8 and 32');
    s.set('b.on', 'm1', false);
    expect(readFile(path)).toEqual({ 'a.size': 99, zzz: [1, 2], 'a.mode': 'y', '[machine:m1]': { 'a.mode': 'y', 'b.on': false, nope: 1 } });
  });

  // Edits of the file by hand are read again, with the changes reported; a
  // file that is not JSON keeps the values and refuses writes until fixed.
  test('reload', () => {
    const { s, path } = newStore(`{"a.size": 14}`);
    let got: Change[][] = [];
    const off = s.onChange((c) => got.push(c));
    s.reload();
    expect(got).toEqual([]);
    // A change through the store is not reloaded as an edit.
    s.set('a.mode', '', 'y');
    s.reload();
    expect(got).toEqual([[{ key: 'a.mode', machine: '' }]]);
    got = [];

    const edit = (content: string) => {
      // A different size or a later time: either tells the file changed.
      writeFileSync(path, content, { mode: 0o600 });
      touchAhead(path, got.length + 1);
      s.reload();
    };
    edit(`{"a.size": 16, "a.mode": "y", "[machine:m]": {"b.on": false}}`);
    expect([s.get('a.size'), s.bool('b.on', 'm'), got.length]).toEqual([16, false, 1]);
    expect(got[0]).toEqual([
      { key: 'a.size', machine: '' },
      { key: 'b.on', machine: 'm' },
    ]);

    edit(`{"a.size": 17,`);
    expect(s.get('a.size')).toBe(16);
    const problems = s.state().problems;
    expect(problems).toEqual([{ code: 'parse', detail: expect.stringContaining('line 1') }]);
    expect(codeOf(() => s.set('a.size', '', 20))).toBe('file');
    expect(readFileSync(path, 'utf8')).toBe(`{"a.size": 17,`);
    edit(`{"a.size": 18}`);
    expect([s.get('a.size'), s.state().problems.length, s.string('a.mode')]).toEqual([18, 0, 'x']);

    // A file that is JSON but not an object is reported as well.
    for (const content of ['[1]', 'null']) {
      edit(content);
      expect(s.state().problems).toEqual([{ code: 'parse', detail: 'not a JSON object' }]);
      expect(s.get('a.size')).toBe(18);
    }
    edit(`{"a.size": 18}`);

    // A change through the store keeps an edit made since the last read.
    writeFileSync(path, `{"a.size": 19, "kept": true}`, { mode: 0o600 });
    touchAhead(path, 3600);
    s.set('a.mode', '', 'y');
    expect(readFile(path)).toEqual({ 'a.size': 19, 'a.mode': 'y', kept: true });

    // A removed file is empty: the defaults.
    unlinkSync(path);
    s.reload();
    expect(s.get('a.size')).toBe(13);

    off();
    got = [];
    s.set('a.size', '', 9);
    expect(got).toEqual([]);
  });

  test('memory store', () => {
    const s = new Settings('', { modules: [MODULE] }).of(MODULE);
    s.load();
    s.set('b.path', 'm', '/x');
    expect([s.string('b.path', 'm'), s.string('b.path')]).toEqual(['/x', '']);
    s.load();
    s.reload();
    expect(s.string('b.path', 'm')).toBe('/x');
  });

  // A change from the UI edits the file's text: comments, trailing commas
  // and the layout of what it does not touch stay; what it adds goes
  // where the Go hub put it (global values sorted, then each machine's).
  test('file edits keep the user text', () => {
    const { s, path } = newStore(`// my settings
{
  "zzz": {"n": 1.50, "big": 12345678901234567890}, // not ours
  /* by hand */ "a.lines": 1e2,
  "[machine:m2]": {"b.on": true},
}
`);
    expect(s.get('a.lines')).toBe(100);
    s.set('b.path', 'm1', '/a<b');
    s.set('a.size', '', 9);
    s.set('b.palette', '', ['#000000', '#FFFFFF']);
    s.set('b.on', 'm2', false);
    expect(readFileSync(path, 'utf8')).toBe(`// my settings
{
  "a.size": 9,
  "b.palette": [
    "#000000",
    "#ffffff"
  ],
  "zzz": {"n": 1.50, "big": 12345678901234567890}, // not ours
  /* by hand */ "a.lines": 1e2,
  "[machine:m1]": {
    "b.path": "/a<b"
  },
  "[machine:m2]": {"b.on": false},
}
`);
    expect(s.string('b.path', 'm1')).toBe('/a<b');
    s.reset('b.palette', '');
    s.reset('a.lines', '');
    s.reset('a.size', '');
    s.reset('b.path', 'm1');
    s.reset('b.on', 'm2');
    expect(readFileSync(path, 'utf8')).toBe(`// my settings
{
  "zzz": {"n": 1.50, "big": 12345678901234567890}, // not ours
}
`);
    s.set('a.size', '', 10);
    s.reset('a.size', '');
    for (const m of ['m1', 'm3']) s.reset('b.path', m);
    // A new file.
    const { s: e, path: ep } = newStore();
    e.set('b.on', 'x', false);
    e.set('a.size', '', 9);
    expect(readFileSync(ep, 'utf8')).toBe(`{
  "a.size": 9,
  "[machine:x]": {
    "b.on": false
  }
}
`);
  });

  // A machine's entry that is not an object is reported and refuses the
  // machine's changes; null is no values.
  test('machine entries', () => {
    const { s, path } = newStore(`{"[machine:m1]": 5, "[machine:m2]": null, "[machine:]": {}}`);
    expect(s.state().problems).toEqual([
      { key: '[machine:]', code: 'unknown' },
      { key: '[machine:m1]', code: 'invalid', detail: 'must be an object of settings' },
    ]);
    expect(codeOf(() => s.set('b.on', 'm1', false))).toBe('file');
    s.set('b.on', 'm2', false);
    expect(s.bool('b.on', 'm2')).toBe(false);
    expect((readFile(path) as Record<string, unknown>)['[machine:m2]']).toEqual({ 'b.on': false });
  });

  test('state and definitions as JSON', () => {
    const { s } = newStore(`{"[machine:z]": {"b.on": false}, "[machine:a]": {"b.on": true, "b.path": "/p"}}`);
    expect(JSON.stringify(s.state().values['b.on'])).toBe('{"value":true,"source":"default","machines":{"a":true,"z":false}}');
    expect(Object.keys(s.state().values)).toEqual(['a.lines', 'a.mode', 'a.size', 'b.color', 'b.on', 'b.palette', 'b.path']);
    const defs = Object.fromEntries(s.definitions().map((d) => [d.key, JSON.stringify(d)]));
    expect(defs['a.size']).toBe('{"key":"a.size","type":"number","default":13,"min":8,"max":32,"scope":"app","section":"a","order":1}');
    expect(defs['a.lines']).toBe('{"key":"a.lines","type":"number","default":100,"integer":true,"scope":"app","section":"a","order":3}');
    expect(defs['a.mode']).toBe(
      '{"key":"a.mode","type":"enum","default":"x","enum":["x","y"],"scope":"app","section":"a","order":2,"flag":"mode"}',
    );
    expect(defs['b.palette']).toBe(
      '{"key":"b.palette","type":"list","default":["#000000","#ffffff"],"item":"color","length":2,"scope":"app","section":"b","order":3}',
    );
    expect(defs['b.on']).toBe('{"key":"b.on","type":"bool","default":true,"scope":"remote-machine","section":"b","order":0,"flag":"on"}');
    const sec = new Settings('', { modules: [{ sections: [{ id: 'p', order: 66, advanced: false, plugin: 'usage' }] }] }).sections();
    expect(JSON.stringify(sec)).toBe('[{"id":"p","order":66,"plugin":"usage"}]');
  });

  test('watch', async () => {
    const { s, path } = newStore(`{"a.size": 14}`);
    const changed = new Promise<Change[]>((resolve) => s.onChange(resolve));
    const ac = new AbortController();
    const done = new Settings(path, { modules: [MODULE], pollMs: 10 }).watch(ac.signal);
    const mine = s.watch(ac.signal, 10);
    writeFileSync(path, `{"a.size": 15}`);
    touchAhead(path, 5);
    expect(await changed).toEqual([{ key: 'a.size', machine: '' }]);
    ac.abort();
    await Promise.all([done, mine]);
  });

  // A file the store cannot read is an error of load and of a change.
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('unreadable file', () => {
    const { s, path } = newStore(`{"a.size": 14}`);
    chmodSync(path, 0o000);
    touchAhead(path, 10);
    expect(() => new Settings(path, { modules: [MODULE] }).load()).toThrow();
    expect(codeOf(() => s.set('a.size', '', 15))).toBe('save');
    s.reload();
    expect(s.get('a.size')).toBe(14);
    chmodSync(path, 0o600);
  });
});
