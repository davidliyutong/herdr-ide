import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discard } from '#shared/lib/log.ts';
import type { Audit, AuditFields } from '../audit.ts';
import { Http } from '../http/app.ts';
import { Guard } from '../http/guard.ts';
import type { Machine } from '../machines/machine.ts';
import { Pages } from '../pages.ts';
import { Keybindings } from './keybindings/index.ts';
import { besideSettings, settingsPath } from './paths.ts';
import { settingsRoutes } from './routes.ts';
import { bool, defineModule, enumOf, Settings } from './settings/index.ts';

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const MODULE = defineModule({
  sections: [{ id: 's', order: 1 }],
  settings: {
    's.mode': enumOf(['x', 'y'], { default: 'x', section: 's' }),
    's.remote': bool({ default: true, scope: 'remote-machine', section: 's' }),
    's.flagged': bool({ default: false, section: 's', flag: 'flagged' }),
  },
});

function setup(o: { readOnly?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'config-routes-'));
  temps.push(dir);
  const settingsFile = settingsPath(dir, 'dev');
  const settings = new Settings(settingsFile, { modules: [MODULE], flags: { flagged: 'on' } });
  const keybindings = new Keybindings(besideSettings(settingsFile, 'keybindings'));
  const audited: { event: string; fields?: AuditFields }[] = [];
  const audit: Audit = { log: (_who, event, fields) => void audited.push({ event, fields }) };
  const machines: Record<string, Partial<Machine>> = { local: { id: 'local', local: true }, m1: { id: 'm1', local: false } };
  const http = new Http({
    guard: new Guard(),
    audit,
    readOnly: o.readOnly ?? false,
    logger: discard,
    machine: (id) => machines[id] as Machine | undefined,
  });
  const pages = new Pages({ logger: discard, audit });
  const pushed: { t: string }[] = [];
  pages.connect(
    { send: (d) => void pushed.push(JSON.parse(d as string)), buffered: 0, close() {} },
    { client: 'browser', readOnly: false, who: {} },
  );
  const stop = settingsRoutes(http, { settings, keybindings, pages });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await http.app.request(
      path,
      {
        method,
        headers: { Host: 'localhost:7780', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      },
      { desktop: false, remote: '127.0.0.1' },
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { dir, settings, keybindings, call, audited, pushed, stop };
}

describe('settings routes', () => {
  test('GET /api/settings', async () => {
    const { call, dir } = setup();
    const { status, body } = await call('GET', '/api/settings');
    expect(status).toBe(200);
    expect(Object.keys(body)).toEqual(['sections', 'definitions', 'values', 'problems', 'read_only', 'file', 'client']);
    expect(body.sections).toEqual([{ id: 's', order: 1 }]);
    expect(body.definitions[0]).toEqual({
      key: 's.mode',
      type: 'enum',
      default: 'x',
      enum: ['x', 'y'],
      scope: 'app',
      section: 's',
      order: 0,
    });
    expect(body.values['s.flagged']).toEqual({ value: true, source: 'flag', locked: true });
    expect([body.problems, body.read_only, body.file, body.client]).toEqual([
      [],
      false,
      join(dir, 'veldr', 'settings-dev.json'),
      'browser',
    ]);
  });

  test('PUT and DELETE /api/settings', async () => {
    const { call, audited, pushed, settings, stop } = setup();
    let r = await call('PUT', '/api/settings', { key: 's.mode', value: 'y' });
    expect(r).toEqual({ status: 200, body: { values: settings.state().values, problems: [] } });
    expect(r.body.values['s.mode']).toEqual({ value: 'y', source: 'global' });
    expect(readFileSync(settings.path, 'utf8')).toBe('{\n  "s.mode": "y"\n}\n');
    expect(audited.at(-1)).toEqual({ event: 'settings.set', fields: { key: 's.mode', value: 'y', machine: '', status: 200 } });
    expect(pushed.at(-1)).toEqual({ t: 'settings', ...settings.state() } as never);

    r = await call('PUT', '/api/settings', { key: 's.remote', value: false, machine: 'm1' });
    expect(r.body.values['s.remote']).toEqual({ value: true, source: 'default', machines: { m1: false } });

    r = await call('DELETE', '/api/settings?key=s.remote&machine=m1');
    expect([r.status, r.body.values['s.remote']]).toEqual([200, { value: true, source: 'default' }]);
    expect(audited.at(-1)).toEqual({ event: 'settings.reset', fields: { key: 's.remote', machine: 'm1', status: 200 } });

    // The codes the UI translates, with the detail it shows.
    const cases: [string, string, unknown, number, Record<string, unknown>][] = [
      ['PUT', '/api/settings', { key: 'nope', value: 1 }, 404, { error: 'unknown' }],
      [
        'PUT',
        '/api/settings',
        { key: 's.mode', value: 'z' },
        400,
        { error: 'invalid', detail: 'invalid value: s.mode: must be one of x, y' },
      ],
      ['PUT', '/api/settings', { key: 's.mode' }, 400, { error: 'invalid' }],
      ['PUT', '/api/settings', '{"key": ', 400, { error: 'invalid' }],
      ['PUT', '/api/settings', { key: 's.flagged', value: true }, 409, { error: 'locked' }],
      [
        'PUT',
        '/api/settings',
        { key: 's.mode', value: 'y', machine: 'm1' },
        400,
        { error: 'scope', detail: 'setting has no per-machine values: s.mode' },
      ],
      [
        'PUT',
        '/api/settings',
        { key: 's.remote', value: false, machine: 'local' },
        400,
        { error: 'scope', detail: 's.remote applies to remote machines only' },
      ],
      ['PUT', '/api/settings', { key: 's.remote', value: false, machine: 'gone' }, 404, { error: 'unknown', detail: 'machine gone' }],
      ['DELETE', '/api/settings?key=nope', undefined, 404, { error: 'unknown' }],
      ['PUT', '/api/settings', 'x'.repeat(65 << 10), 413, { error: 'too_large' }],
    ];
    for (const [method, path, body, status, want] of cases) {
      const got = await call(method, path, body);
      expect(got.status, JSON.stringify(body)?.slice(0, 60)).toBe(status);
      expect(got.body, JSON.stringify(body)?.slice(0, 60)).toMatchObject(want);
      if (!('detail' in want)) expect(got.body.detail).toBeUndefined();
    }
    expect(audited.at(-2)).toMatchObject({ event: 'settings.reset', fields: { key: 'nope', status: 404, error: 'unknown' } });

    // A file broken by hand refuses changes.
    writeFileSync(settings.path, '{"s.mode": ');
    const future = new Date(Date.now() + 60_000);
    utimesSync(settings.path, future, future);
    expect(await call('PUT', '/api/settings', { key: 's.mode', value: 'x' })).toMatchObject({ status: 409, body: { error: 'file' } });

    stop();
    const n = pushed.length;
    settings.reload();
    expect(pushed.length).toBe(n);
  });

  test('read-only', async () => {
    const { call } = setup({ readOnly: true });
    expect((await call('GET', '/api/settings')).body.read_only).toBe(true);
    expect(await call('PUT', '/api/settings', { key: 's.mode', value: 'y' })).toMatchObject({ status: 403, body: { error: 'read_only' } });
    expect(await call('DELETE', '/api/settings?key=s.mode')).toMatchObject({ status: 403 });
    expect(await call('PUT', '/api/keybindings', [])).toMatchObject({ status: 403 });
  });
});

describe('keybindings routes', () => {
  test('GET and PUT /api/keybindings', async () => {
    const { call, audited, pushed, keybindings, dir } = setup();
    let r = await call('GET', '/api/keybindings');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual([
      'sections',
      'commands',
      'defaults',
      'user',
      'effective',
      'conflicts',
      'problems',
      'read_only',
      'file',
    ]);
    expect(r.body.file).toBe(join(dir, 'veldr', 'keybindings-dev.json'));
    expect(r.body.sections[0]).toEqual({ id: 'app', order: 10 });
    expect(Object.keys(r.body.effective)).toEqual(['linux', 'linux-browser', 'mac', 'mac-browser', 'windows', 'windows-browser']);

    r = await call('PUT', '/api/keybindings', [{ key: 'ctrl+k n', command: 'tab.new' }]);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['user', 'effective', 'conflicts', 'problems']);
    expect(r.body.user).toEqual([{ key: 'ctrl+k n', command: 'tab.new' }]);
    expect(r.body.effective.mac).toContainEqual({ key: 'ctrl+k n', command: 'tab.new', when: 'terminal' });
    expect(audited.at(-1)).toEqual({ event: 'keybindings.set', fields: { rules: 1, status: 200 } });
    expect(pushed.at(-1)).toEqual({ t: 'keybindings', ...keybindings.state() } as never);

    r = await call('PUT', '/api/keybindings', [{ key: 'x', command: 'tab.new' }]);
    expect(r).toMatchObject({ status: 400, body: { error: 'invalid', detail: 'invalid keybindings: rule 1: key: typing: x' } });
    expect((await call('PUT', '/api/keybindings', { key: 'x' })).body.error).toBe('invalid');
  });
});
