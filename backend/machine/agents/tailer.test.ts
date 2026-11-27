import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { SafeFileTailer, isWithinRoot, openContainedRegular } from './tailer.ts';

function tempRoot(prefix = 'tailer-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(posix.join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mkfifo(path: string): void {
  execFileSync('mkfifo', [path]);
}

describe('SafeFileTailer & openContainedRegular', () => {
  test('isWithinRoot enforces strict segment boundary containment', () => {
    expect(isWithinRoot('/a/b', '/a/b')).toBe(false);
    expect(isWithinRoot('/a/b/c.jsonl', '/a/b')).toBe(true);
    expect(isWithinRoot('/a/bc/file', '/a/b')).toBe(false);
    expect(isWithinRoot('/a', '/a/b')).toBe(false);
  });

  test('openContainedRegular opens owned regular files and refuses symlinks, parent-dir escapes, wrong uid, dirs, and FIFOs', () => {
    const t = tempRoot();
    const outside = tempRoot('tailer-out-');
    const uid = process.getuid!();
    try {
      const root = posix.join(t.dir, 'root');
      const sub = posix.join(root, 'brain', 'sess-1');
      mkdirSync(sub, { recursive: true, mode: 0o700 });
      const good = posix.join(sub, 'transcript.jsonl');
      writeFileSync(good, '{"ok":1}\n', { mode: 0o600 });

      // Valid owned regular file inside root.
      const opened = openContainedRegular(good, [root], uid);
      expect(opened).not.toBeNull();
      expect(opened!.size).toBe(9);
      closeSync(opened!.fd);

      // Wrong UID is rejected.
      expect(openContainedRegular(good, [root], uid + 1)).toBeNull();

      // Directory is rejected.
      expect(openContainedRegular(sub, [root], uid)).toBeNull();

      // FIFO is rejected without blocking.
      const fifo = posix.join(sub, 'pipe.jsonl');
      mkfifo(fifo);
      expect(openContainedRegular(fifo, [root], uid)).toBeNull();

      // Leaf symlink to outside file is rejected.
      const secret = posix.join(outside.dir, 'secret.jsonl');
      writeFileSync(secret, 'TOP_SECRET\n', { mode: 0o600 });
      const leafLink = posix.join(sub, 'leaf-link.jsonl');
      symlinkSync(secret, leafLink);
      expect(openContainedRegular(leafLink, [root], uid)).toBeNull();

      // Parent-directory symlink escaping root is rejected (even though leaf is a regular file!).
      const dirLink = posix.join(root, 'brain', 'escaped');
      symlinkSync(outside.dir, dirLink);
      expect(openContainedRegular(posix.join(dirLink, 'secret.jsonl'), [root], uid)).toBeNull();

      // Empty allowedRoots fails closed (never disables containment).
      expect(openContainedRegular(good, [], uid)).toBeNull();
      // Non-existent allowedRoots fails closed.
      expect(openContainedRegular(good, [posix.join(t.dir, 'missing-root')], uid)).toBeNull();

      // Regular owned file inside root still opens cleanly.
      chmodSync(good, 0o600);
      const again = openContainedRegular(good, [root], uid);
      expect(again).not.toBeNull();
      closeSync(again!.fd);
    } finally {
      t.cleanup();
      outside.cleanup();
    }
  });

  test('SafeFileTailer preserves multi-byte UTF-8 across chunk boundaries, drops oversized lines, and drains multi-chunk files', () => {
    const t = tempRoot();
    try {
      const file = posix.join(t.dir, 'log.jsonl');
      // 4-byte emoji + 3-byte CJK chars intentionally straddling a 7-byte chunk boundary!
      const obj1 = { msg: '你好🚀世界' };
      const obj2 = { msg: 'second-line-✓' };
      const huge = { msg: 'x'.repeat(200) };
      const obj3 = { msg: 'after-oversize-🎉' };
      const initial = [obj1, obj2, huge, obj3].map((x) => JSON.stringify(x)).join('\n') + '\n';
      writeFileSync(file, initial, 'utf8');

      // Use tiny maxReadBytes = 7 so multi-byte characters split mid-codepoint across chunks,
      // and maxLineBytes = 80 so `huge` is discarded cleanly while `obj3` is still delivered.
      const tailer = new SafeFileTailer(file, {
        allowedRoots: [t.dir],
        uid: process.getuid!(),
        maxReadBytes: 7,
        maxLineBytes: 80,
      });

      const drained = tailer.drainAll(4096);
      expect(drained).toEqual([obj1, obj2, obj3]);

      // Subsequent poll with no new bytes emits nothing.
      expect(tailer.poll()).toEqual({ items: [], bytesRead: 0, more: false });

      // Appending a partial line buffers until newline arrives.
      writeFileSync(file, initial + '{"msg":"part-', 'utf8');
      expect(tailer.drainAll(4096)).toEqual([]);
      writeFileSync(file, initial + '{"msg":"part-done"}\n', 'utf8');
      expect(tailer.drainAll(4096)).toEqual([{ msg: 'part-done' }]);

      // drainAll enforces maxTotalBytes strictly without overshooting by a full maxReadBytes chunk.
      const capFile = posix.join(t.dir, 'capped.jsonl');
      writeFileSync(capFile, '{"n":1}\n{"n":2}\n{"n":3}\n{"n":4}\n', 'utf8');
      const capped = new SafeFileTailer(capFile, {
        allowedRoots: [t.dir],
        uid: process.getuid!(),
        maxReadBytes: 16,
        maxLineBytes: 80,
      });
      expect(capped.drainAll(20)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(capped.position).toBe(20);
      expect(capped.drainAll(20)).toEqual([{ n: 3 }, { n: 4 }]);
    } finally {
      t.cleanup();
    }
  });
});
