import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditFile } from './audit-file.ts';

test('the audit log flushes ordered events and reports overflow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-'));
  const path = join(dir, 'events.jsonl');
  const messages: string[] = [];
  try {
    const log = await auditFile(path, (line) => messages.push(line));
    log.audit.log(null, 'first');
    log.audit.log(null, 'overflow', { text: 'x'.repeat(4 << 20) });
    for (let n = 0; n < 16; n++) log.audit.log(null, 'after', { n });
    await log.close();
    const records = (await readFile(path, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records[0]?.event).toBe('first');
    expect(records.slice(1).map((record) => record.n)).toEqual(Array.from({ length: 16 }, (_, n) => n));
    expect(messages).toEqual(['audit log: dropped 1 events while the disk queue was full']);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
