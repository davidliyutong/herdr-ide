import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HOST_FILE_RETENTION, JOURNALS, hostFile, thisHost } from './host.ts';
import { hubDBBeside, hubDBName, tidyHubDBs } from './hubdb.ts';
import { open } from './index.ts';

const dirs: string[] = [];
const temp = () => {
  const d = fs.mkdtempSync(join(tmpdir(), 'hubdb-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const MONTH = HOST_FILE_RETENTION + 3600 * 1000;

function makeDB(p: string) {
  const db = open(p, { migrations: ['CREATE TABLE t (n INTEGER)'] });
  db.exec('INSERT INTO t VALUES (1)');
  db.close();
}

function age(p: string, ms: number) {
  const old = new Date(Date.now() - ms);
  for (const s of ['', ...JOURNALS]) {
    try {
      fs.utimesSync(p + s, old, old);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

const exists = (p: string) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** A config directory with the files of the default instance and of the
 * instances dev and desktop. */
function configDir(): string {
  const dir = temp();
  for (const f of ['settings.json', 'settings-dev.json', 'settings-desktop.json'])
    fs.writeFileSync(join(dir, f), '{}', { mode: 0o600 });
  return dir;
}

describe('the hub database', () => {
  test('is named hub[-<instance>]-<host>.db beside the instance’s files', () => {
    expect(hubDBName('/c/settings.json', 'settings')).toBe('hub.db');
    expect(hubDBName('/c/settings-dev.json', 'settings')).toBe('hub-dev.db');
    expect(hubDBName('/c/vault-dev.json', 'vault')).toBe('hub-dev.db');
    expect(hubDBName('/c/settings-dev.json', 'settings', 'core')).toBe('core-dev.db');
    expect(hubDBBeside('/c/settings.json', 'settings')).toBe(join('/c', `hub-${thisHost()}.db`));
    expect(hubDBBeside('/c/vault-desktop.json', 'vault')).toBe(join('/c', `hub-desktop-${thisHost()}.db`));
    expect(hubDBBeside('', 'settings')).toBe('');
  });

  test('a hub removes this host’s database of earlier releases of its instance only', () => {
    const dir = configDir();
    const host = thisHost();
    const oldMine = join(dir, `core-${host}.db`);
    const oldDev = join(dir, `core-dev-${host}.db`);
    const oldDesktop = join(dir, `core-desktop-${host}.db`);
    const oldOther = join(dir, 'core-otherhost-0a1b2c3d.db');
    const hubMine = join(dir, `hub-${host}.db`);
    for (const p of [oldMine, oldDev, oldDesktop, oldOther, hubMine]) makeDB(p);
    // Journal files of the old database go with it.
    for (const s of JOURNALS) fs.writeFileSync(oldMine + s, '');

    expect(tidyHubDBs(join(dir, 'settings.json'))).toEqual({ old: [`core-${host}.db`], others: [] });
    for (const s of ['', ...JOURNALS]) expect(exists(oldMine + s)).toBe(false);
    // Other instances' old databases, another host's (in use) and the new one stay.
    for (const p of [oldDev, oldDesktop, oldOther, hubMine]) expect(exists(p)).toBe(true);

    // The instance dev takes its own and nothing of the default instance's.
    makeDB(oldMine);
    expect(tidyHubDBs(join(dir, 'settings-dev.json'))).toEqual({ old: [`core-dev-${host}.db`], others: [] });
    expect(exists(oldDev)).toBe(false);
    for (const p of [oldMine, oldDesktop, oldOther, hubMine]) expect(exists(p)).toBe(true);

    // Nothing left: nothing to do.
    expect(tidyHubDBs(join(dir, 'settings-dev.json'))).toEqual({ old: [], others: [] });
    expect(tidyHubDBs('')).toEqual({ old: [], others: [] });
  });

  test('journal files left without their old database go', () => {
    const dir = configDir();
    const old = hostFile(dir, 'core.db');
    fs.writeFileSync(old + '-wal', '');
    fs.writeFileSync(old + '-shm', '');
    expect(tidyHubDBs(join(dir, 'settings.json')).old).toEqual([`core-${thisHost()}.db`]);
    expect(exists(old + '-wal')).toBe(false);
    expect(exists(old + '-shm')).toBe(false);
  });

  test('other hosts’ databases of either name go after the retention, other instances’ stay', () => {
    const dir = configDir();
    const files = {
      oldOther: join(dir, 'core-otherhost-0a1b2c3d.db'),
      hubOther: join(dir, 'hub-otherhost-0a1b2c3d.db'),
      oldDevOther: join(dir, 'core-dev-otherhost-0a1b2c3d.db'),
      hubDevOther: join(dir, 'hub-dev-otherhost-0a1b2c3d.db'),
      hubMine: hostFile(dir, 'hub.db'),
    };
    for (const p of Object.values(files)) {
      makeDB(p);
      age(p, MONTH);
    }
    const t = tidyHubDBs(join(dir, 'settings.json'));
    expect(t.old).toEqual([]);
    expect(t.others.sort()).toEqual(['core-otherhost-0a1b2c3d.db', 'hub-otherhost-0a1b2c3d.db']);
    for (const k of ['oldDevOther', 'hubDevOther', 'hubMine'] as const) expect(exists(files[k])).toBe(true);
  });

  test.skipIf(process.platform === 'win32')('an old database a process holds stays', () => {
    const dir = configDir();
    const old = hostFile(dir, 'core.db');
    makeDB(old);
    const held = new DatabaseSync(old);
    try {
      held.exec('PRAGMA journal_mode = WAL');
      held.prepare('SELECT count(*) AS n FROM t').get();
      expect(tidyHubDBs(join(dir, 'settings.json')).old).toEqual([]);
      expect(exists(old)).toBe(true);
    } finally {
      held.close();
    }
    expect(tidyHubDBs(join(dir, 'settings.json')).old).toEqual([`core-${thisHost()}.db`]);
    expect(exists(old)).toBe(false);
  });
});
