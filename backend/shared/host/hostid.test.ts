import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as hostid from './hostid.ts';

// The id stays when the name changes, differs between machine ids, and
// without an id is the name, or a hash of a long one.
test('TestID', () => {
  const a = hostid.idOf('mac', 'id-1');
  const b = hostid.idOf('MacBook-Pro.local', 'id-1');
  expect(a).toBe(b);
  expect(a).toHaveLength(8);
  expect(a).not.toContain('id');
  expect(hostid.idOf('mac', 'id-2')).not.toBe(a);
  expect(hostid.idOf('Node01', '')).toBe('node01');
  const long = 'x'.repeat(30);
  expect(hostid.idOf(long, '')).toHaveLength(8);
  expect(hostid.idOf(long, '')).not.toBe(hostid.idOf(long + 'y', ''));
  expect(hostid.id()).not.toBe('');
  expect(hostid.validKey(hostid.id())).toBe(true);
  expect(hostid.validKey(hostid.key())).toBe(true);
});

// The keys and ids are Go's (vectors printed by the Go program's KeyOf and
// IDOf, which earlier releases ran): files the Go program named are found again.
test('the hashes are Go’s', () => {
  expect(hostid.keyOf('node01', 'id-1')).toBe('node01-2024ba5b');
  expect(hostid.idOf('node01', ' id-1\n')).toBe('565c11db');
  expect(hostid.idOf('x'.repeat(30), '')).toBe('e9359ab8');
  // A machine id of bytes that are not UTF-8 is hashed as bytes.
  expect(hostid.keyOf('h', Buffer.from([0xff, 0x00, 0x7f, 0xc3]))).toBe('h-aeb3881b');
});

// The machine id is the system's own: macOS's platform UUID as ioreg
// shows it, elsewhere the first machine-id file that has one.
test('TestMachineID', () => {
  const out = `+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000256, registered>
    {
      "IOPolledInterface" = "AppleARMWatchdogTimerHibernateHandler is not serializable"
      "IOPlatformUUID" = "AB77F40E-2F67-5607-B4F1-6D5E54732E35"
      "serial-number" = <0000>
    }
`;
  expect(hostid.ioregUUID(out)).toBe('AB77F40E-2F67-5607-B4F1-6D5E54732E35');
  expect(hostid.ioregUUID('nothing')).toBe('');
  const id = hostid.machineID();
  if (process.platform === 'darwin') {
    expect(id).not.toBe('');
    return;
  }
  if (process.platform === 'win32') return; // reg.exe: TestRegQuery
  let want = '';
  for (const p of hostid.MACHINE_ID_FILES) {
    try {
      const s = readFileSync(p, 'utf8').trim();
      if (s !== '') {
        want = s;
        break;
      }
    } catch {
      // the next
    }
  }
  expect(typeof id === 'string' ? id : Buffer.from(id).toString('utf8')).toBe(want);
});

// The files are tried in order; empty ones, missing ones and ones too long
// for an id are passed over.
test('machine id files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostid-'));
  try {
    const empty = join(dir, 'empty');
    const long = join(dir, 'long');
    const good = join(dir, 'good');
    const binary = join(dir, 'binary');
    writeFileSync(empty, ' \n');
    writeFileSync(long, 'x'.repeat(257));
    writeFileSync(good, '0123abcd\n');
    writeFileSync(binary, Buffer.from([0x0a, 0xff, 0x01, 0x20]));
    expect(hostid.machineIDOfFiles([join(dir, 'missing'), empty, long, good])).toBe('0123abcd');
    expect(hostid.machineIDOfFiles([binary])).toEqual(Buffer.from([0xff, 0x01]));
    expect(hostid.machineIDOfFiles([empty])).toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Windows' MachineGuid as reg query prints it.
test('TestRegQuery', () => {
  const out =
    '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    0b6e2f4a-1c3d-4e5f-8a9b-0c1d2e3f4a5b\r\n\r\n';
  expect(hostid.regQueryValue(out, 'MachineGuid')).toBe('0b6e2f4a-1c3d-4e5f-8a9b-0c1d2e3f4a5b');
  expect(hostid.regQueryValue('ERROR: The system was unable to find the specified registry key or value.\r\n', 'MachineGuid')).toBe('');
});

// A host's name as keys have it (store's TestHostFile has the rest).
test('names', () => {
  const cases: Array<[string, string]> = [
    ['node01.cluster.example.org', 'node01.cluster.example.org'],
    ['MacBook-Pro.local', 'macbook-pro.local'],
    ['  ', 'localhost'],
    ['', 'localhost'],
    ['.local', 'local'],
    ['a/b\\c:d e', 'a_b_c_d_e'],
    ['..', 'localhost'],
    ['büro', 'b_ro'],
    ['x.', 'x'],
    ['x'.repeat(200), 'x'.repeat(hostid.MAX_NAME)],
    // Go's simple case mapping: these lower to ASCII letters.
    ['İSTANBUL', 'istanbul'],
    ['KELVIN', 'kelvin'],
    ['﻿a ', '_a'],
    ['🙂x', '_x'],
  ];
  for (const [h, want] of cases) expect([h, hostid.name(h)]).toEqual([h, want]);
});
