// Export files carry variables (their values included) from one vault to
// another, encrypted under a passphrase of their own: a JSON envelope that
// says in the clear only its format, version, the key's derivation and the
// cipher, all bound to the ciphertext as its additional data, and the
// content sealed with AES-256-GCM. The core seals and opens them; values
// never reach a browser. The Go store's format (internal/vault/export.go).
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { SLUG } from '#shared/lib/brand.ts';
import { b64, derive, goJSON, open, seal, unb64, VaultError } from './crypto.ts';
import { kdfProblem, MAX_ENTRIES, type ExportVariable } from './store.ts';

export const EXPORT_VERSION = 1;
/** Bounds an export file, written or read. */
export const MAX_EXPORT_FILE = 16 << 20;
/** The file is attacked offline, without the vault's waits. */
export const MIN_EXPORT_PASSPHRASE = 12;
export const exportFormat = () => `${SLUG}-vault-export`;

export interface ExportMachine {
  id: string;
  label?: string;
  /** The core's own computer, whose id is the same on every core. */
  local?: boolean;
  /** Its kind and, for an ssh machine, its target on the exporting core:
   * an import maps the id only to a machine of the same kind and target. */
  kind?: string;
  target?: string;
}

export interface Export {
  exported: string;
  machines: ExportMachine[];
  variables: ExportVariable[];
}

export const weakExport = () => new VaultError('weak_export_passphrase', "an export's passphrase needs at least 12 characters");
const tooLarge = () => new VaultError('too_large', 'the export file is too large');
const badFile = (why: string) => new VaultError('bad_file', `not an export file of the vault, or a damaged one: ${why}`);

const uint = z.number().int().min(0);
const envelope = z.object({
  format: z.string().nullish(),
  version: z.number().int().nullish(),
  kdf: z.object({ alg: z.string().nullish(), salt: z.string().nullish(), time: uint, memory: uint, threads: uint.max(255) }).nullish(),
  cipher: z.string().nullish(),
  nonce: z.string().nullish(),
  ciphertext: z.string().nullish(),
});
const opt = z.string().nullish();
const content = z.object({
  exported: opt,
  machines: z.array(z.object({ id: z.string(), label: opt, local: z.boolean().nullish(), kind: opt, target: opt })).nullish(),
  variables: z
    .array(
      z.object({
        name: z.string(),
        value: z.string().nullish(),
        description: opt,
        machines: z.array(z.string()).nullish(),
        injectOnly: z.boolean().nullish(),
        created: opt,
        updated: opt,
      }),
    )
    .nullish(),
});

/** The envelope's additional data: everything in the clear but the nonce. */
const adOf = (kdf: { salt: string; time: number; memory: number; threads: number }) =>
  goJSON({
    format: exportFormat(),
    version: EXPORT_VERSION,
    kdf: { alg: 'argon2id', salt: kdf.salt, time: kdf.time, memory: kdf.memory, threads: kdf.threads },
    cipher: 'aes-256-gcm',
  });

/** e as an export file under passphrase, its key derived with k's
 * parameters and a new salt. */
export async function sealExport(e: Export, passphrase: string, k: { time: number; memory: number; threads: number }): Promise<Buffer> {
  if ([...passphrase].length < MIN_EXPORT_PASSPHRASE) throw weakExport();
  if (e.variables.length > MAX_ENTRIES) throw new VaultError('full', 'too many variables');
  const plain = Buffer.from(JSON.stringify(e));
  try {
    if (plain.length > MAX_EXPORT_FILE) throw tooLarge();
    const kdf = { salt: b64(randomBytes(16)), time: k.time, memory: k.memory, threads: k.threads };
    const sealed = await seal(await derive(passphrase, kdf), plain, adOf(kdf));
    const file = {
      format: exportFormat(),
      version: EXPORT_VERSION,
      kdf: { alg: 'argon2id', ...kdf },
      cipher: 'aes-256-gcm',
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
    };
    const b = Buffer.from(JSON.stringify(file, null, 2) + '\n');
    if (b.length > MAX_EXPORT_FILE) throw tooLarge();
    return b;
  } finally {
    plain.fill(0);
  }
}

/** Reads an export file with its passphrase: bad_file for what is not one
 * (or is damaged), file_version for another version, file_passphrase for a
 * wrong passphrase or a changed file; a derivation outside the vault's
 * bounds is refused before any work. The variables are checked by the
 * import. */
export async function openExport(b: Uint8Array, passphrase: string): Promise<Export> {
  if (b.length > MAX_EXPORT_FILE) throw tooLarge();
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(b).toString('utf8'));
  } catch (e) {
    throw badFile((e as Error).message);
  }
  const r = envelope.safeParse(raw);
  if (!r.success || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw badFile('envelope');
  const f = r.data;
  if (f.format !== exportFormat()) throw badFile(`format ${JSON.stringify(f.format)}`);
  if (f.version !== EXPORT_VERSION)
    throw new VaultError('file_version', `an export file of another version ${f.version}, not ${EXPORT_VERSION}`);
  if (f.cipher !== 'aes-256-gcm' || f.kdf?.alg !== 'argon2id') throw badFile(`cipher ${JSON.stringify(f.cipher)}`);
  // The salt as Go re-encodes it: its additional data is of the bytes.
  const kdf = { salt: b64(unb64(f.kdf.salt ?? '')), time: f.kdf.time, memory: f.kdf.memory, threads: f.kdf.threads };
  const why = kdfProblem(kdf);
  if (why) throw badFile(why);
  const plain = await open(await derive(passphrase, kdf), { nonce: f.nonce ?? '', ciphertext: f.ciphertext ?? '' }, adOf(kdf)).catch(() => {
    throw new VaultError('file_passphrase', 'wrong passphrase, or the file was changed');
  });
  try {
    let c: z.infer<typeof content>;
    try {
      c = content.parse(JSON.parse(plain.toString('utf8')));
    } catch (e) {
      throw badFile(`content: ${(e as Error).message}`);
    }
    const variables = (c.variables ?? []).map((v) => ({
      name: v.name,
      value: v.value ?? '',
      ...(v.description ? { description: v.description } : {}),
      machines: v.machines ?? [],
      ...(v.injectOnly ? { injectOnly: true } : {}),
      created: v.created ?? '',
      updated: v.updated ?? '',
    }));
    if (variables.length > MAX_ENTRIES) throw new VaultError('full', 'too many variables');
    const machines = (c.machines ?? []).map((m) => ({
      id: m.id,
      ...(m.label ? { label: m.label } : {}),
      ...(m.local ? { local: true } : {}),
      ...(m.kind ? { kind: m.kind } : {}),
      ...(m.target ? { target: m.target } : {}),
    }));
    return { exported: c.exported ?? '', machines, variables };
  } finally {
    plain.fill(0);
  }
}
