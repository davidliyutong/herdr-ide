// The file explorer's machine side (docs/features/28-file-explorer.md,
// protocol.ts): the changes the explorer makes (new files and folders,
// rename and move without replacing anything, copies, the trash, permanent
// removal, saving an editor's text with a check that nobody changed the
// file since it was loaded, uploads), the stat of the directories it shows
// and showing a path in the system's file manager. Every path goes through
// the agent's expansion, and nothing touches the root, the home directory
// or what holds it, or the agent's data directory (machine/guard.ts).
import { closeSync, lstatSync, mkdirSync, openSync, statSync, type Stats } from 'node:fs';
import { rm, stat as statAsync } from 'node:fs/promises';
import { posix } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';
import { ChunkReader, writeLine, type Reply } from '#shared/proto/agentproto/index.ts';
import { refusal } from '#machine/dispatch.ts';
import { defineMachine, type ActionContext, type ActionStream } from '#machine/feature.ts';
import { renameNoReplace } from '#machine/sys/fs.ts';
import { MAX_UPLOAD, MAX_WRITE, filesProtocol, type Entry, type Result } from './protocol.ts';
import { Guard, codeOf, errCode, holds, within } from './machine/guard.ts';
import { Revealer, revealCommand } from './machine/reveal.ts';
import {
  STAGING_RETENTION_MS,
  bufferSource,
  copyInto,
  createFree,
  precondition,
  pruneStaged,
  receiveText,
  saveErr,
  staged,
  target,
  writeFile,
  type Fill,
} from './machine/save.ts';
import { Stater } from './machine/stat.ts';
import { findFiles } from './machine/find.ts';
import { trash } from './machine/trash.ts';
import { copyTree, exists, moveNoReplace, removeTree } from './machine/tree.ts';

const { basename, dirname, extname, join } = posix;

/** Bounds the paths of one trash, remove, move or copy. */
export const MAX_PATHS = 1000;

export interface FilesOptions {
  /** How long a stat waits for its paths. */
  statWaitMs?: number;
  /** The stats running at once. */
  maxStatting?: number;
  stat?: (p: string) => Promise<Stats>;
  /** Renames without replacing (machine/sys renameNoReplace). */
  rename?: (from: string, to: string) => void;
  /** Writes a save's text into its file. */
  fill?: Fill;
  /** How long a reveal waits for its command, and how many at once. */
  revealWaitMs?: number;
  maxRevealing?: number;
  revealCommand?: (os: string, p: string, dir: boolean) => string[] | null;
  /** The system whose trash and file manager are used. */
  platform?: string;
  /** $XDG_DATA_HOME, whose Trash is the home trash off macOS (default: the
   * agent's environment's). */
  dataHome?: string;
  /** How long a broken-off upload's staged file is kept. */
  stagingRetentionMs?: number;
}

/** A Result's paths, left out when there are none. */
const made = (paths: string[], failed?: Record<string, string>): Result => ({
  ...(paths.length ? { paths } : {}),
  ...(failed && Object.keys(failed).length ? { failed } : {}),
});

export const filesMachine = (o: FilesOptions = {}) =>
  defineMachine(filesProtocol, (env) => {
    const stater = new Stater({ waitMs: o.statWaitMs ?? 10_000, max: o.maxStatting ?? 8, stat: o.stat ?? ((p) => statAsync(p)) });
    const platform = o.platform ?? process.platform;
    const revealer = new Revealer({
      waitMs: o.revealWaitMs ?? 10_000,
      max: o.maxRevealing ?? 4,
      command: o.revealCommand ?? revealCommand,
      os: platform,
    });
    const rename = o.rename ?? renameNoReplace;
    const fill = o.fill ?? copyInto;
    const guardOf = (ctx: ActionContext) => new Guard({ home: ctx.home, base: ctx.base, expand: ctx.expand });

    /** Runs f on every path: the paths it made, and the codes of those it
     * failed on. One path that fails alone fails the action. */
    const each = async (paths: string[], f: (p: string) => Promise<string> | string): Promise<Result> => {
      if (paths.length === 0 || paths.length > MAX_PATHS) throw new Fail('bad_params', 400, `between 1 and ${MAX_PATHS} paths`);
      const out: string[] = [];
      const failed: Record<string, string> = {};
      for (const p of paths) {
        try {
          const m = await f(p);
          if (m) out.push(m);
        } catch (e) {
          if (paths.length === 1) throw codeOf(e);
          failed[p] = codeOf(e).code;
        }
      }
      return made(out, failed);
    };

    /** Gives a path a new name or place; never replaces what is there.
     * Across file systems it is a copy and a removal. */
    const renameTo = async (g: Guard, from: string, to: string, signal: AbortSignal): Promise<string> => {
      const src = g.resolve(from);
      const dst = g.resolve(to);
      if (src === dst) return dst;
      if (within(dst, src) || holds(src, dirname(dst))) throw new Fail('bad_params', 400, `cannot move ${src} into itself`);
      try {
        await moveNoReplace(signal, src, dst, rename);
      } catch (e) {
        throw codeOf(e);
      }
      return dst;
    };

    /** The first free name in dir for a copy of base: base, then "stem
     * copy.ext", "stem copy 2.ext"… */
    const copyName = (dir: string, base: string): string => {
      let ext = extname(base);
      if (ext === base) ext = '';
      const stem = base.slice(0, base.length - ext.length);
      for (let i = 0; i < 1000; i++) {
        const name = i === 0 ? base : i === 1 ? `${stem} copy${ext}` : `${stem} copy ${i}${ext}`;
        const p = join(dir, name);
        if (!exists(p)) return p;
      }
      throw new Fail('exists', 409, `no free name for ${base}`);
    };

    /** Answers a streaming action's second line. */
    const answer = (s: ActionStream, r: Result | Fail): Promise<void> =>
      writeLine(s.stream, r instanceof Fail ? refusal(r) : ({ ok: true, plugin: r } satisfies Reply));

    return {
      housekeep: (now) => pruneStaged(env.base, now, o.stagingRetentionMs ?? STAGING_RETENTION_MS),
      actions: {
        stat: (p, ctx) => stater.stat(p.paths, (x) => ctx.expand(x), ctx.signal),

        find: (p, ctx) =>
          findFiles({
            dir: ctx.expand(p.dir),
            query: p.query,
            limit: p.limit,
            match: p.match,
            regex: p.regex,
            hidden: p.hidden,
            exclude: p.exclude,
            signal: ctx.signal,
          }),

        mkdir: (p, ctx) => {
          // A taken name fails, or with unique the folder gets the first
          // free name-1, name-2… (a folder uploaded beside one of its name).
          const abs = guardOf(ctx).resolve(p.path);
          for (let i = 0; i < 1000; i++) {
            const q = i > 0 ? `${abs}-${i}` : abs;
            try {
              mkdirSync(q, 0o755);
              return made([q]);
            } catch (e) {
              if (!p.unique || errCode(e) !== 'EEXIST') throw codeOf(e);
            }
          }
          throw new Fail('exists', 409, `no free name for ${abs}`);
        },

        mkdirs: (p, ctx) => {
          // Folders with the folders that lead to them; one there already
          // is fine (the folders of an upload), a file in the way is exists.
          const g = guardOf(ctx);
          return each(p.paths, (x) => {
            const abs = g.resolve(x);
            try {
              mkdirSync(abs, { recursive: true, mode: 0o755 });
              if (!statSync(abs).isDirectory()) throw new Fail('exists', 409, `${abs} is not a directory`);
            } catch (e) {
              if (errCode(e) === 'ENOTDIR') throw new Fail('exists', 409, (e as Error).message);
              throw codeOf(e);
            }
            return abs;
          });
        },

        create: (p, ctx) => {
          const abs = guardOf(ctx).resolve(p.path);
          try {
            closeSync(openSync(abs, 'wx', 0o644));
          } catch (e) {
            throw codeOf(e);
          }
          return made([abs]);
        },

        rename: async (p, ctx) => made([await renameTo(guardOf(ctx), p.path, p.to, ctx.signal)]),

        move: async (p, ctx) => {
          const g = guardOf(ctx);
          const d = g.expand(p.dir);
          return each(p.paths, (src) => renameTo(g, src, join(d, basename(posix.normalize(src))), ctx.signal));
        },

        copy: async (p, ctx) => {
          // Copies into dir under their own names, or "name copy", "name copy
          // 2"… when those are taken (a copy into the same directory).
          const g = guardOf(ctx);
          const d = g.expand(p.dir);
          return each(p.paths, async (x) => {
            const src = g.resolve(x);
            if (holds(src, d)) throw new Fail('bad_params', 400, `cannot copy ${src} into itself`);
            const dst = copyName(d, basename(src));
            // dir may be a link: where the copy lands is checked too.
            g.resolve(dst);
            const { made: was, error } = await copyTree(ctx.signal, src, dst);
            if (error) {
              // The partial copy, never what was there.
              if (was) await rm(dst, { recursive: true, force: true });
              throw codeOf(error);
            }
            return dst;
          });
        },

        trash: (p, ctx) => {
          const g = guardOf(ctx);
          return each(p.paths, (x) => {
            const abs = g.resolve(x);
            lstatSync(abs);
            return trash(abs, ctx.home, { platform, dataHome: o.dataHome ?? ctx.environ().XDG_DATA_HOME });
          });
        },

        remove: (p, ctx) => {
          const g = guardOf(ctx);
          return each(p.paths, async (x) => {
            const abs = g.resolve(x);
            lstatSync(abs);
            await removeTree(ctx.signal, abs);
            return '';
          });
        },

        write: async (p, ctx, s) => {
          // The reply, then the text as chunks, then a line with the result.
          // The file must be as the editor loaded it unless force; through a
          // link its target is written (the link stays). The text is
          // received in full, then written into the file in place.
          const g = guardOf(ctx);
          const abs = g.resolve(await target(g.resolve(p.path)));
          const w = { expect: p.expect, force: p.force };
          await precondition(abs, w);
          await s.reply();
          let text: Buffer;
          try {
            text = await receiveText(new ChunkReader(s.reader), MAX_WRITE);
          } catch (e) {
            return answer(s, codeOf(e));
          }
          let e: Entry;
          try {
            e = await writeFile(abs, bufferSource(text), w, fill);
          } catch (err) {
            return answer(s, saveErr(err));
          }
          return answer(s, { paths: [abs], entry: e });
        },

        upload: async (p, ctx, s) => {
          // A free name (path, else name-1.ext…), or with replace written
          // there as a save does (force: through a link its target, in
          // place). Received in full into the agent's private directory
          // before anything at path changes, so one cut short leaves
          // nothing there.
          const g = guardOf(ctx);
          let abs = g.resolve(p.path);
          if (p.replace) abs = g.resolve(await target(abs));
          await s.reply();
          let e: Entry;
          try {
            e = await staged(ctx.base, new ChunkReader(s.reader), MAX_UPLOAD, (src) =>
              p.replace ? writeFile(abs, src, { force: true }, fill) : createFree(abs, src, fill),
            );
          } catch (err) {
            return answer(s, saveErr(err));
          }
          return answer(s, { paths: [e.path], entry: e });
        },

        reveal: async (p, ctx) => {
          // Changes nothing, so what changes refuse (the home directory, the
          // data directory) can be shown, as their stat is answered.
          const abs = guardOf(ctx).expand(p.path);
          try {
            lstatSync(abs);
          } catch (e) {
            throw codeOf(e);
          }
          let dir = false;
          try {
            dir = statSync(abs).isDirectory();
          } catch {
            // a dangling link: its folder
          }
          await revealer.reveal(abs, dir, ctx.environ(), ctx.signal);
          return made([abs]);
        },
      },
    };
  });
