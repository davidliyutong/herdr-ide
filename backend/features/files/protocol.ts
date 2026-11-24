// The file explorer's actions on a machine (docs/features/28-file-explorer.md),
// as the Go agent serves them while machines run the Go machine build
// (internal/agent/plugin/files): the changes the explorer makes, the stat
// of the directories it shows, saving an editor's text, uploads into its
// folders and showing a path in the system's file manager. The agent
// expands every path (~, relative to home) and refuses the root, the home
// directory and what holds it, and its own data directory; it answers
// failures with codes the UI translates (not_found, exists, denied,
// refused, conflict, partial_write, …).
//
// write and upload stream: the reply has no result; the core then sends
// the body as ChunkWriter chunks with their end marker, and the agent
// answers a second line, {ok, plugin: Result} or {ok: false, code, error}.
// A body that ends without the marker leaves nothing on the machine.
import { z } from 'zod';
import { defineProtocol } from '#shared/proto/protocol.ts';

/** Bounds an editor's save (the agent's limit). */
export const MAX_WRITE = 8 << 20;
/** Bounds the paths of one stat (the agent's limit). */
export const MAX_STAT = 200;
/** Bounds an upload into the explorer (the agent's limit). */
export const MAX_UPLOAD = 4 * 2 ** 30;

/** The state of a path the explorer follows; exists is false when it is
 * gone, or with error when its state is not known (busy, timeout, denied,
 * failed): the explorer then keeps what it shows. */
export const entry = z.object({
  path: z.string(),
  exists: z.boolean(),
  is_dir: z.boolean().optional(),
  size: z.number(),
  /** Unix milliseconds. */
  mtime: z.number(),
  error: z.string().optional(),
});
export type Entry = z.infer<typeof entry>;

/** What a change made: the paths it made, the file's state after a save
 * or an upload, and the codes of the paths an action on several failed on. */
export const result = z.object({
  paths: z.array(z.string()).optional(),
  entry: entry.optional(),
  failed: z.record(z.string(), z.string()).optional(),
});
export type Result = z.infer<typeof result>;

const path = z.string();
const paths = z.array(z.string());

/** A change of large trees (a copy, a removal) answers after its work. */
const CHANGE_MS = 10 * 60_000;

export const filesProtocol = defineProtocol('files', {
  /** The state of paths, in their order. The agent waits at most 10 s for
   * them (a dead mount) and runs at most 8 stats at once. */
  stat: { params: z.object({ paths: paths.max(MAX_STAT) }), result: z.array(entry), timeoutMs: 20_000 },
  /** A folder; a taken name fails (exists), or with unique the folder takes
   * the first free name-1, name-2… */
  mkdir: { params: z.object({ path, unique: z.boolean().optional() }), result, timeoutMs: CHANGE_MS },
  /** Folders with the folders that lead to them; those there are kept. */
  mkdirs: { params: z.object({ paths }), result, timeoutMs: CHANGE_MS },
  /** A new empty file; a taken name fails. */
  create: { params: z.object({ path }), result, timeoutMs: CHANGE_MS },
  /** A new name or place for path; never replaces anything. */
  rename: { params: z.object({ path, to: z.string() }), result, timeoutMs: CHANGE_MS },
  /** paths into dir under their own names, replacing nothing. */
  move: { params: z.object({ paths, dir: z.string() }), result, timeoutMs: CHANGE_MS },
  /** Copies of paths into dir ("name copy", "name copy 2"… when taken);
   * stops when the core closes the stream. */
  copy: { params: z.object({ paths, dir: z.string() }), result, timeoutMs: CHANGE_MS },
  /** paths into the user's trash. */
  trash: { params: z.object({ paths }), result, timeoutMs: CHANGE_MS },
  /** Removes paths for good; stops when the core closes the stream. */
  remove: { params: z.object({ paths }), result, timeoutMs: CHANGE_MS },
  /** Saves an editor's text (at most MAX_WRITE bytes) into path, which must
   * be as the editor loaded it (expect; none: the file must not exist)
   * unless force. A file changed since fails with conflict, whose message
   * is "conflict: " and its state now as JSON. Streams (above). */
  write: {
    params: z.object({ path, expect: entry.optional(), force: z.boolean().optional() }),
    result: z.object({}),
    stream: true,
  },
  /** A file into path under a free name (name-1.ext… when taken), or with
   * replace over the file there; received in full before anything at path
   * changes. Streams (above). */
  upload: { params: z.object({ path, replace: z.boolean().optional() }), result: z.object({}), stream: true },
  /** Shows path in the system's file manager (the core asks only for its
   * own machine, for a client on its host). */
  reveal: { params: z.object({ path }), result, timeoutMs: 30_000 },
});

/** The actions that change paths and take their parameters as JSON. */
export const CHANGES = ['mkdir', 'mkdirs', 'create', 'rename', 'move', 'copy', 'trash', 'remove'] as const;
export type Change = (typeof CHANGES)[number];
