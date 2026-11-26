// What the chat feature writes to the audit log of the changes it relays:
// the routes' values (route.ts) and the pages' commands that change what an
// agent may do or where its session goes (auditOf). A prompt's text, and
// what a question was answered, are never written.
import * as chat from '#shared/proto/chatproto/index.ts';
import type { PageCommand } from './wire.ts';

/** The most bytes of a value an audit record takes from a request. */
export const MAX_AUDIT = 256;

/** A value of an audit record: at most MAX_AUDIT bytes of s, cut where a
 * character starts. */
export function auditText(s: string): string {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= MAX_AUDIT) return s;
  let cut = MAX_AUDIT;
  while (cut > 0 && (b[cut] & 0xc0) === 0x80) cut--;
  return b.subarray(0, cut).toString('utf8') + '…';
}

/** A command's audit record. */
export interface AuditRecord {
  event: string;
  fields: Record<string, unknown>;
}

/** The record of a command of machine m's chat that changes what an agent
 * may do or where its session goes: a permission's answer, a question's
 * (how many, not what), a configuration option set (the mode among them),
 * a handoff; undefined for the others. */
export function auditOf(m: string, id: string, cmd: PageCommand): AuditRecord | undefined {
  const fields: Record<string, unknown> = { plugin: 'chat', machine: m, chat: id };
  switch (cmd.op) {
    case chat.CommandOp.Permission:
      fields.request = auditText(cmd.request);
      if (cmd.cancelled) fields.cancelled = true;
      else fields.option = auditText(cmd.option);
      break;
    case chat.CommandOp.Answer:
      fields.request = auditText(cmd.request);
      if (cmd.cancelled) fields.cancelled = true;
      else fields.questions = Object.keys(cmd.answers ?? {}).length;
      break;
    case chat.CommandOp.SetConfig:
      fields.config = auditText(cmd.config);
      fields.value = auditText(cmd.value);
      break;
    case chat.CommandOp.Handoff:
      break;
    default:
      return undefined;
  }
  return { event: `chat.${cmd.op}`, fields };
}
