// Computes and checks SHA-256 digests of downloaded files.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';

/** The lowercase hex SHA-256 digest of the file at path, read as a
 * stream. */
export function file(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (b) => h.update(b))
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Rejects unless the file at path has the digest want. */
export async function verify(path: string, want: string): Promise<void> {
  const got = await file(path);
  if (got !== want) throw new Error(`${basename(path)}: sha256 ${got} does not match expected ${want}`);
}
