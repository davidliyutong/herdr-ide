import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { compact, indent, marshal, members } from '#shared/lib/gojson.ts';
import {
  formatFloat,
  isSettingsError,
  range,
  Scope,
  Source,
  Store,
  Type,
  type Change,
  type Def,
  type ErrorCode,
  type Module,
  type SettingValue,
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

function testModule(): Module {
  return {
    sections: [
      { id: 'b', order: 20 },
      { id: 'a', order: 10 },
    ],
    defs: [
      { key: 'a.mode', type: Type.Enum, default: 'x', enum: ['x', 'y'], section: 'a', order: 2, flag: 'mode' },
      { key: 'a.size', type: Type.Number, default: 13, ...range(8, 32), section: 'a', order: 1 },
      { key: 'a.lines', type: Type.Number, default: 100, integer: true, section: 'a', order: 3 },
      { key: 'b.on', type: Type.Bool, default: true, scope: Scope.RemoteMachine, section: 'b', flag: 'on' },
      {
        key: 'b.path',
        type: Type.String,
        default: '',
        scope: Scope.Machine,
        section: 'b',
        order: 1,
        validate: (v) => {
          if (v !== '' && !isAbsolute(v as string)) throw new Error('not absolute');
        },
      },
      { key: 'b.color', type: Type.Color, default: '#000000', section: 'b', order: 2 },
      { key: 'b.palette', type: Type.List, item: Type.Color, length: 2, default: ['#000000', '#ffffff'], section: 'b', order: 3 },
    ],
  };
}

function newStore(content = ''): { s: Store; path: string } {
  const path = join(tempDir(), 'sub', 'settings.json');
  if (content !== '') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode: 0o600 });
  }
  const s = new Store(path, testModule());
  s.load();
  return { s, path };
}

function readFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** The error code fn throws with ("" for none). */
function errorOf(fn: () => void): ErrorCode | '' {
  try {
    fn();
  } catch (e) {
    if (isSettingsError(e)) return e.code;
    throw e;
  }
  return '';
}

/** Parses args as Go's flag package does for the store's flags: --name
 * value or --name=value. */
function parseFlags(s: Store, args: string[]): void {
  const flags = new Map(s.flags().map((f) => [f.name, f]));
  for (let i = 0; i < args.length; i++) {
    const m = /^--?([^=]+)(?:=(.*))?$/.exec(args[i])!;
    const f = flags.get(m[1]);
    if (!f) throw new Error('flag provided but not defined: ' + m[1]);
    f.set(m[2] ?? args[++i]);
  }
}

/** Sets a file's modification time ahead, so a store sees it changed. */
function touchAhead(path: string, seconds: number): void {
  const future = new Date(Date.now() + seconds * 1000);
  utimesSync(path, future, future);
}

describe('settings', () => {
  test('definitions in UI order; invalid definitions refused', () => {
    const s = new Store('', testModule());
    expect(s.definitions().map((d) => d.key)).toEqual(['a.size', 'a.mode', 'a.lines', 'b.on', 'b.path', 'b.color', 'b.palette']);
    expect(s.sections()[0].id).toBe('a');
    const bad: Def[] = [
      { key: 'x', type: Type.Enum, default: 'z', enum: ['a'], section: 'a' },
      { key: 'x', type: Type.Number, default: 1, section: 'nope' },
      { key: 'a.mode', type: Type.Bool, default: true, section: 'a' },
    ];
    for (const d of bad) {
      const m = testModule();
      m.defs!.push(d);
      expect(() => new Store('', m), d.key).toThrow();
    }
    expect(() => new Store('', { sections: [{ id: 'a', order: 1 }] }, { sections: [{ id: 'a', order: 2 }] })).toThrow();
  });

  // Command line, then the machine's own value, then the global value,
  // then the default.
  test('merge order', () => {
    const { s, path } = newStore();
    expect(s.get('a.size')).toBe(13);
    s.set('a.size', '', 15);
    s.set('b.on', '', false);
    s.set('b.on', 'm1', true);
    expect([s.bool('b.on', ''), s.bool('b.on', 'm1'), s.bool('b.on', 'm2')]).toEqual([false, true, false]);
    const st = s.state();
    expect(st.values['b.on']).toEqual({ value: false, source: Source.Global, machines: { m1: true } });
    expect(st.values['a.mode']).toEqual({ value: 'x', source: Source.Default });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    // Another store reads the same; a flag wins everywhere and locks.
    const s2 = new Store(path, testModule());
    s2.load();
    parseFlags(s2, ['--on', 'off', '--mode=y']);
    expect([s2.bool('b.on', 'm1'), s2.string('a.mode', ''), s2.get('a.size')]).toEqual([false, 'y', 15]);
    expect(s2.state().values['b.on']).toMatchObject({ locked: true, source: Source.Flag });
    for (const m of ['', 'm1']) {
      expect(errorOf(() => s2.set('b.on', m, true))).toBe('locked');
      expect(errorOf(() => s2.reset('b.on', m))).toBe('locked');
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
    const cases: [string, string, unknown, ErrorCode][] = [
      ['a.mode', '', 'z', 'invalid'],
      ['a.mode', '', 1.0, 'invalid'],
      ['a.size', '', 7.0, 'invalid'],
      ['a.size', '', '13', 'invalid'],
      ['a.size', '', Infinity, 'invalid'],
      ['a.size', '', NaN, 'invalid'],
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
        errorOf(() => s.set(key, machine, value)),
        `set(${key}, ${JSON.stringify(machine)}, ${String(value)})`,
      ).toBe(want);
    }
    expect(errorOf(() => s.set('b.path', '', '/srv/données é'))).toBe('');
    s.set('b.color', '', '#ABCDEF');
    expect(s.string('b.color', '')).toBe('#abcdef');
    s.set('b.palette', '', ['#FFFFFF', '#000000']);
    expect(s.get('b.palette')).toEqual(['#ffffff', '#000000']);
    // A list read is a copy.
    (s.get('b.palette') as string[])[0] = '#123456';
    expect(s.get('b.palette')).toEqual(['#ffffff', '#000000']);
    expect(() => parseFlags(s, ['--mode', 'z'])).toThrow();
    expect(errorOf(() => parseFlags(s, ['--on', 'maybe']))).toBe('invalid');
  });

  // The errors' messages are the Go program's, which the API sends as the
  // detail.
  test('error messages', () => {
    const { s } = newStore();
    const message = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    };
    expect(message(() => s.set('a.size', '', 7))).toBe('invalid value: a.size: must be between 8 and 32');
    expect(message(() => s.set('a.lines', '', 1.5))).toBe('invalid value: a.lines: must be a whole number');
    expect(message(() => s.set('b.palette', '', ['#000000', 'x']))).toBe('invalid value: b.palette: item 2: must be a color #rrggbb');
    expect(message(() => s.set('b.path', '', 'rel'))).toBe('invalid value: b.path: not absolute');
    expect(message(() => s.set('a.mode', '', 'z'))).toBe('invalid value: a.mode: must be one of x, y');
    expect(message(() => s.set('nope', '', 1))).toBe('unknown setting: nope');
    expect(message(() => s.set('a.mode', 'm', 'x'))).toBe('setting has no per-machine values: a.mode');
    parseFlags(s, ['--on=1']);
    expect(message(() => s.set('b.on', '', true))).toBe('setting is fixed by a command-line flag: --on');
  });

  test('flags', () => {
    const min = range(0.5, 4);
    const s = new Store('', {
      sections: [{ id: 's', order: 1 }],
      defs: [
        { key: 'n', type: Type.Number, default: 1.5, ...min, section: 's', flag: 'n', usage: 'a number' },
        { key: 'l', type: Type.List, item: Type.String, default: ['a', 'b'], section: 's', flag: 'l' },
        { key: 'b', type: Type.Bool, default: false, section: 's', flag: 'b' },
        { key: 'x', type: Type.String, default: '', section: 's' },
      ],
    });
    expect(s.flags().map((f) => [f.name, f.usage, f.defaultText])).toEqual([
      ['n', 'a number', '1.5'],
      ['l', '', 'a,b'],
      ['b', '', 'false'],
    ]);
    parseFlags(s, ['--n', '2.5e0', '--l', '', '--b', 'YES']);
    expect([s.get('n'), s.get('l'), s.get('b')]).toEqual([2.5, [], true]);
    for (const bad of ['', 'x', '1x', 'inf', '-Infinity', 'nan', '9'])
      expect(
        errorOf(() => parseFlags(s, ['--n', bad])),
        bad,
      ).toBe('invalid');
    parseFlags(s, ['--l=x,y']);
    expect(s.get('l')).toEqual(['x', 'y']);
  });

  // Keys this version does not know and values that do not validate are
  // kept when the file is rewritten, reported as problems and count as
  // unset.
  test('unknown and invalid entries kept', () => {
    const { s, path } = newStore(`{"a.size": 99, "zzz": [1, 2], "a.mode": "y", "[machine:m1]": {"a.mode": "y", "b.on": "yes", "nope": 1}}`);
    expect([s.get('a.size'), s.string('a.mode', '')]).toEqual([13, 'y']);
    const codes = s.state().problems.map((p) => `${p.code}:${p.machine ?? ''}/${p.key ?? ''}`);
    expect(codes.join(' ')).toBe('scope:m1/a.mode invalid:m1/b.on unknown:m1/nope invalid:/a.size unknown:/zzz');
    s.set('b.on', 'm1', false);
    const f = readFile(path);
    expect(f['a.size']).toBe(99);
    expect(f['zzz']).toEqual([1, 2]);
    expect(f['[machine:m1]']).toEqual({ 'a.mode': 'y', 'b.on': false, nope: 1 });
  });

  // Edits of the file by hand are read again, with the changes reported; a
  // file that is not JSON keeps the values and refuses writes until fixed.
  test('reload', () => {
    const { s, path } = newStore(`{"a.size": 14}`);
    let got: Change[][] = [];
    s.onChange((c) => got.push(c));
    s.reload();
    expect(got).toEqual([]);
    // An API change is not reloaded as an edit.
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
    expect(problems.length).toBe(1);
    expect(problems[0].code).toBe('parse');
    expect(problems[0].key).toBeUndefined();
    expect(errorOf(() => s.set('a.size', '', 20))).toBe('file');
    expect(readFileSync(path, 'utf8')).toBe(`{"a.size": 17,`);
    edit(`{"a.size": 18}`);
    expect([s.get('a.size'), s.state().problems.length, s.string('a.mode', '')]).toEqual([18, 0, 'x']);

    // A file that is JSON but not an object is reported as well.
    edit(`[1]`);
    expect(s.state().problems.map((p) => p.code)).toEqual(['parse']);
    expect(s.get('a.size')).toBe(18);
    edit(`{"a.size": 18}`);

    // A change through the API keeps an edit made since the last read.
    writeFileSync(path, `{"a.size": 19, "kept": true}`, { mode: 0o600 });
    touchAhead(path, 3600);
    s.set('a.mode', '', 'y');
    expect(readFile(path)).toEqual({ 'a.size': 19, 'a.mode': 'y', kept: true });

    // A removed file is empty: the defaults.
    unlinkSync(path);
    s.reload();
    expect(s.get('a.size')).toBe(13);
  });

  test('memory store', () => {
    const s = new Store('', testModule());
    s.load();
    s.set('b.path', 'm', '/x');
    expect([s.string('b.path', 'm'), s.string('b.path', '')]).toEqual(['/x', '']);
    s.reload();
  });

  // The file as Go writes it: global values first, then each machine's,
  // keys sorted, two-space indentation; values written by hand keep their
  // literals when another value changes.
  test('file layout', () => {
    const { s, path } = newStore(`{"zzz": {"n": 1.50, "big": 12345678901234567890},
      "[machine:m2]": {"b.on": true},
      "a.lines": 1e2,
      "[machine:m1]": {"x": [ ] , "a<b": "<&>"}}`);
    expect(s.get('a.lines')).toBe(100);
    s.set('b.path', 'm1', '/a<b');
    s.set('b.palette', '', ['#000000', '#FFFFFF']);
    expect(readFileSync(path, 'utf8')).toBe(`{
  "a.lines": 1e2,
  "b.palette": [
    "#000000",
    "#ffffff"
  ],
  "zzz": {
    "n": 1.50,
    "big": 12345678901234567890
  },
  "[machine:m1]": {
    "a\\u003cb": "\\u003c\\u0026\\u003e",
    "b.path": "/a\\u003cb",
    "x": []
  },
  "[machine:m2]": {
    "b.on": true
  }
}
`);
    expect(s.string('b.path', 'm1')).toBe('/a<b');
    s.reset('b.palette', '');
    s.reset('a.lines', '');
    s.reset('b.path', 'm1');
    s.reset('b.on', 'm2');
    expect(readFile(path)).toEqual({ zzz: { n: 1.5, big: 12345678901234567890 }, '[machine:m1]': { 'a<b': '<&>', x: [] } });
    for (const m of ['m1', 'm3']) s.reset('b.path', m);
    // An empty file.
    const { s: e, path: ep } = newStore();
    e.set('a.size', '', 9);
    e.reset('a.size', '');
    expect(readFileSync(ep, 'utf8')).toBe('{}\n');
  });

  // A machine's entry that is not an object is reported and refuses the
  // machine's changes; null is no values (Go panics setting one there).
  test('machine entries', () => {
    const { s } = newStore(`{"[machine:m1]": 5, "[machine:m2]": null, "[machine:]": {}}`);
    expect(s.state().problems).toEqual([
      { key: '[machine:]', code: 'unknown' },
      { key: '[machine:m1]', code: 'invalid', detail: 'must be an object of settings' },
    ]);
    expect(errorOf(() => s.set('b.on', 'm1', false))).toBe('file');
    s.set('b.on', 'm2', false);
    expect(s.bool('b.on', 'm2')).toBe(false);
  });

  test('state and definitions as JSON', () => {
    const { s } = newStore(`{"[machine:z]": {"b.on": false}, "[machine:a]": {"b.on": true, "b.path": "/p"}}`);
    expect(JSON.stringify(s.state().values['b.on'])).toBe('{"value":true,"source":"default","machines":{"a":true,"z":false}}');
    expect(Object.keys(s.state().values)).toEqual(['a.lines', 'a.mode', 'a.size', 'b.color', 'b.on', 'b.palette', 'b.path']);
    const defs = Object.fromEntries(s.definitions().map((d) => [d.key, JSON.stringify(d)]));
    expect(defs['a.size']).toBe('{"key":"a.size","type":"number","default":13,"min":8,"max":32,"scope":"app","section":"a","order":1}');
    expect(defs['a.mode']).toBe(
      '{"key":"a.mode","type":"enum","default":"x","enum":["x","y"],"scope":"app","section":"a","order":2,"flag":"mode"}',
    );
    expect(defs['b.palette']).toBe(
      '{"key":"b.palette","type":"list","default":["#000000","#ffffff"],"item":"color","length":2,"scope":"app","section":"b","order":3}',
    );
    expect(defs['b.on']).toBe('{"key":"b.on","type":"bool","default":true,"scope":"remote-machine","section":"b","order":0,"flag":"on"}');
    const sec = new Store('', { sections: [{ id: 'p', order: 66, advanced: false, plugin: 'usage' }] }).sections();
    expect(JSON.stringify(sec)).toBe('[{"id":"p","order":66,"plugin":"usage"}]');
  });

  test('watch', async () => {
    const { s, path } = newStore(`{"a.size": 14}`);
    const changed = new Promise<Change[]>((resolve) => s.onChange(resolve));
    const ac = new AbortController();
    const done = s.watch(ac.signal, 10);
    writeFileSync(path, `{"a.size": 15}`);
    touchAhead(path, 5);
    expect(await changed).toEqual([{ key: 'a.size', machine: '' }]);
    ac.abort();
    await done;
  });

  // A file the store cannot read is an error of load and of a change.
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('unreadable file', () => {
    const { s, path } = newStore(`{"a.size": 14}`);
    chmodSync(path, 0o000);
    touchAhead(path, 10);
    expect(() => new Store(path, testModule()).load()).toThrow();
    expect(() => s.set('a.size', '', 15)).toThrow();
    s.reload();
    expect(s.get('a.size')).toBe(14);
    chmodSync(path, 0o600);
  });
});

describe('Go JSON', () => {
  test('marshal escapes as json.Marshal does', () => {
    const v: SettingValue = ['<a&b>', 'x\u2028y'];
    expect(marshal(v)).toBe('["\\u003ca\\u0026b\\u003e","x\\u2028y"]');
    expect(marshal(1e21)).toBe('1e+21');
    expect(marshal(1.05)).toBe('1.05');
  });

  test('indent as json.Indent does', () => {
    expect(indent('{ "a" : [1, {"b":[]}, { }], "c":"x , y"}', '  ', '  ')).toBe(
      '{\n    "a": [\n      1,\n      {\n        "b": []\n      },\n      {}\n    ],\n    "c": "x , y"\n  }',
    );
    expect(indent('[]', '', '  ')).toBe('[]');
    expect(indent('"a\\"b"', '', '  ')).toBe('"a\\"b"');
  });

  test('compact as json.Marshal of a RawMessage', () => {
    expect(compact('{ "a" : [ 1 , 2 ],\n "b": "x <y>" }')).toBe('{"a":[1,2],"b":"x \\u003cy\\u003e"}');
  });

  test('members keep values as written', () => {
    expect(members(' { "a" : 1.50 , "b":{"c" : [ ] }, "a\\"q": "x}", "a": 2 } ')).toEqual(
      new Map([
        ['a', '2'],
        ['b', '{"c" : [ ] }'],
        ['a"q', '"x}"'],
      ]),
    );
    expect(members('{}')).toEqual(new Map());
    expect(members('[1]')).toBeUndefined();
    expect(members('null')).toBeUndefined();
  });

  test('formatFloat never writes an exponent', () => {
    expect(formatFloat(1e21)).toBe('1000000000000000000000');
    expect(formatFloat(1.5e-7)).toBe('0.00000015');
    expect(formatFloat(-2.5e22)).toBe('-25000000000000000000000');
    expect(formatFloat(100000)).toBe('100000');
    expect(formatFloat(0.05)).toBe('0.05');
  });
});
