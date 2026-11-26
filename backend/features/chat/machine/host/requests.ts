// What the host takes from its clients, checked where it enters: a request
// (the one line after the hello) and an attached connection's commands. A
// member of another type than the protocol's refuses the line, as the Go
// host's decoding does; members the protocol does not know are passed
// over, and null stands for left out.
import { z } from 'zod';
import type * as chat from '#shared/proto/chatproto/index.ts';

const str = z
  .string()
  .nullish()
  .transform((v) => v ?? undefined);
const bool = z
  .boolean()
  .nullish()
  .transform((v) => v ?? undefined);
/** A sequence number (Go's uint64). */
const seq = z
  .number()
  .int()
  .nonnegative()
  .nullish()
  .transform((v) => v ?? undefined);
/** A number of the settings (Go's int and int64). */
const int = z
  .number()
  .int()
  .nullish()
  .transform((v) => v ?? undefined);

const settings = z.object({
  idleStopMinutes: int,
  maxLive: int,
  maxChats: int,
  retentionDays: int,
  maxTotalBytes: int,
  maxChatBytes: int,
  defaultMode: str,
  allowFull: bool,
});

const request = z.object({
  op: z.string(),
  kinds: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? undefined),
  kind: str,
  cwd: str,
  resume: str,
  import: bool,
  options: z
    .object({ model: str, effort: str, mode: str })
    .nullish()
    .transform((v) => v ?? undefined),
  env: z
    .record(z.string(), z.string())
    .nullish()
    .transform((v) => v ?? undefined),
  chat: str,
  from: seq,
  noCatchUp: bool,
  seq: seq,
  cursor: str,
  settings: settings.nullish().transform((v) => v ?? undefined),
});

const command = z.object({
  op: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
  id: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
  content: z
    .array(z.unknown())
    .nullish()
    .transform((v) => v ?? undefined),
  clientId: str,
  request: str,
  option: str,
  answers: z
    .record(z.string(), z.array(z.string()).nullable())
    .nullish()
    .transform((v) => (v ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x ?? []])) : undefined)),
  cancelled: bool,
  config: str,
  value: str,
  message: str,
  title: str,
});

export type Request = z.output<typeof request>;
export type Command = z.output<typeof command>;

function parsed<T>(schema: z.ZodType<T>, line: Buffer): T | null {
  let v: unknown;
  try {
    v = JSON.parse(line.toString('utf8'));
  } catch {
    return null;
  }
  const r = schema.safeParse(v);
  return r.success ? r.data : null;
}

/** The request of a line; null when it is no JSON object of the protocol. */
export const parseRequest = (line: Buffer): Request | null => parsed(request, line);

/** The command of a line; null when it is no JSON object of the protocol. */
export const parseCommand = (line: Buffer): (Command & chat.Command) | null => parsed(command, line) as (Command & chat.Command) | null;
