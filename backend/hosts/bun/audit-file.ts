import { appendFile, open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { auditLog } from '#kernel/audit.ts';
import type { Logger } from '#shared/lib/log.ts';

const MAX_QUEUED_BYTES = 4 << 20;
const FLUSH_MS = 5000;

/** Writes the CLI audit in order without holding the hub on disk I/O. */
export async function auditFile(path: string, logger: Logger) {
  const file = await open(path, 'a', 0o600);
  await file.close();
  let lines: string[] = [];
  let bytes = 0;
  let draining: Promise<void> | undefined;
  let closed = false;
  let dropped = 0;
  let failed = false;

  function reportDrops() {
    if (!dropped) return;
    logger(`audit log: dropped ${dropped} events while the disk queue was full`);
    dropped = 0;
  }

  async function drain() {
    while (lines.length) {
      const batch = lines;
      lines = [];
      const text = batch.join('');
      try {
        await appendFile(path, text, { mode: 0o600 });
        failed = false;
      } catch (e) {
        if (!failed) logger(`audit log: append failed: ${(e as Error).message}`);
        failed = true;
      } finally {
        bytes -= Buffer.byteLength(text);
      }
    }
    draining = undefined;
    reportDrops();
  }

  return {
    audit: auditLog((line) => {
      if (closed) return;
      const size = Buffer.byteLength(line);
      if (bytes + size > MAX_QUEUED_BYTES) {
        dropped++;
        if (!draining) reportDrops();
        return;
      }
      lines.push(line);
      bytes += size;
      draining ??= drain();
    }),
    async close() {
      closed = true;
      if (draining) {
        const flushed = await Promise.race([draining.then(() => true), delay(FLUSH_MS, false, { ref: false })]);
        if (!flushed) logger('audit log: the disk queue did not flush before shutdown');
      }
    },
  };
}
