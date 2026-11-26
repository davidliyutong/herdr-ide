// Claude Code's requests to use a tool (can_use_tool, the SDK's canUseTool)
// as the host's permissions, questions and plan approvals: AskUserQuestion
// becomes a question whose answers go back as the tool's input,
// ExitPlanMode a plan to approve (in the mode the option names) or reject,
// every other tool a permission with the host's options. "Allow for this
// session" sends only the request's addRules suggestions, their destination
// the session: nothing is written to the user's settings.
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import * as chat from '#shared/proto/chatproto/index.ts';
import { OPTION_ALLOW_ONCE, OPTION_ALLOW_SESSION, OPTION_PLAN_PREFIX, OPTION_REJECT_ONCE, planOption, type Sink } from '../adapter.ts';
import { MAX_OPTIONS, MAX_QUESTIONS, MAX_TEXT, cut } from './config.ts';
import { isObj, str, toolCall, type Obj } from './items.ts';

// The messages a denial gives the model.
export const DENY_TOOL = 'The user declined this tool use.';
export const DENY_QUESTION = 'The user skipped the question; end your turn and wait for their next message.';
export const DENY_PLAN = 'The user did not approve the plan. Stay in plan mode and revise the plan with the user.';
export const DENY_UNASKED = 'The user could not be asked.';

const allow = (input: Obj, updated?: unknown[]): PermissionResult =>
  updated && updated.length > 0
    ? { behavior: 'allow', updatedInput: input, updatedPermissions: updated as PermissionUpdate[] }
    : { behavior: 'allow', updatedInput: input };

const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });

/** The suggestions that allow calls like this one for the rest of the
 * session: the addRules ones only, their destination the session (a
 * setMode suggestion would switch the mode, a settings destination would
 * write the user's settings). */
export function sessionRules(suggestions: unknown): Obj[] {
  if (!Array.isArray(suggestions)) return [];
  const out: Obj[] = [];
  for (const s of suggestions) {
    if (!isObj(s) || s.type !== 'addRules' || s.behavior !== 'allow' || !Array.isArray(s.rules) || s.rules.length === 0) continue;
    out.push({ ...s, destination: 'session' });
  }
  return out;
}

/** The kind of permission a tool's use is. */
export function permissionKind(tool: string): string {
  if (tool === 'Bash' || tool === 'BashOutput' || tool === 'KillShell' || tool === 'KillBash') return chat.PermissionKind.Command;
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') return chat.PermissionKind.File;
  if (tool.startsWith('mcp__')) return chat.PermissionKind.MCP;
  return chat.PermissionKind.Tool;
}

/** A request to use a tool. */
export interface ToolRequest {
  tool: string;
  input: Obj;
  toolUseId: string;
  suggestions?: unknown;
  /** The tool call of the subagent that asks; "" for the main agent. */
  parent: string;
}

/** The answer to a request (null: none, the request is gone), and for an
 * approved plan the mode to go on in once the answer was sent. */
export interface Decision {
  result: PermissionResult | null;
  mode?: string;
}

/** Asks the user about a tool use through the sink. */
export async function decide(sink: Sink, q: ToolRequest, signal: AbortSignal): Promise<Decision> {
  const call = toolCall(q.toolUseId, q.tool, q.input);
  try {
    if (q.tool === 'AskUserQuestion') return { result: await askQuestions(sink, q, call, signal) };
    if (q.tool === 'ExitPlanMode') return await approvePlan(sink, q, call, signal);
    const rules = sessionRules(q.suggestions);
    const options: chat.PermissionOption[] = [{ optionId: OPTION_ALLOW_ONCE, name: 'Allow', kind: chat.OptionKind.AllowOnce }];
    if (rules.length > 0)
      options.push({ optionId: OPTION_ALLOW_SESSION, name: 'Allow for this session', kind: chat.OptionKind.AllowAlways });
    options.push({ optionId: OPTION_REJECT_ONCE, name: 'Reject', kind: chat.OptionKind.RejectOnce });
    const a = await sink.permission({ kind: permissionKind(q.tool), toolCall: call, options, parent: q.parent }, signal);
    if (signal.aborted) return { result: null };
    if (a.cancelled) return { result: deny(DENY_TOOL) };
    if (a.option === OPTION_ALLOW_ONCE) return { result: allow(q.input) };
    if (a.option === OPTION_ALLOW_SESSION && rules.length > 0) return { result: allow(q.input, rules) };
    return { result: deny(DENY_TOOL) };
  } catch {
    return { result: signal.aborted ? null : deny(DENY_UNASKED) };
  }
}

/** Asks AskUserQuestion's questions: the answers go back as the tool's
 * input with "answers" (by question text: the label, or the labels joined
 * with ", "); skipped, the tool is denied. */
async function askQuestions(sink: Sink, q: ToolRequest, call: Obj, signal: AbortSignal): Promise<PermissionResult | null> {
  const asked = Array.isArray(q.input.questions) ? q.input.questions : [];
  if (asked.length === 0 || !asked.every(isObj)) return deny(DENY_UNASKED);
  const given = (asked as Obj[]).slice(0, MAX_QUESTIONS);
  const questions: chat.Question[] = given.map((x, i) => {
    const cq: chat.Question = { id: String(i), question: cut(str(x.question), MAX_TEXT), allowOther: true };
    const header = cut(str(x.header), MAX_TEXT);
    if (header) cq.header = header;
    if (x.multiSelect === true) cq.multiSelect = true;
    const opts = Array.isArray(x.options) ? x.options.filter(isObj).slice(0, MAX_OPTIONS) : [];
    if (opts.length > 0)
      cq.options = opts.map((o) => {
        const qo: chat.QuestionOption = { label: cut(str(o.label), MAX_TEXT) };
        const d = cut(str(o.description), MAX_TEXT);
        const p = cut(str(o.preview), MAX_TEXT);
        if (d) qo.description = d;
        if (p) qo.preview = p;
        return qo;
      });
    return cq;
  });
  const a = await sink.question({ questions, toolCall: call, parent: q.parent }, signal);
  if (signal.aborted) return null;
  const answers: Record<string, string> = {};
  given.forEach((x, i) => {
    const got = a.answers?.[String(i)];
    if (got && got.length > 0) answers[str(x.question)] = got.join(', ');
  });
  if (a.cancelled || Object.keys(answers).length === 0) return deny(DENY_QUESTION);
  return allow({ ...q.input, answers });
}

/** Asks to approve ExitPlanMode's plan: approved, the program goes on in
 * the mode the option names (it leaves plan mode for default by itself; the
 * chosen mode is set once the answer is sent); rejected, it keeps
 * planning. */
async function approvePlan(sink: Sink, q: ToolRequest, call: Obj, signal: AbortSignal): Promise<Decision> {
  const options: chat.PermissionOption[] = [
    { optionId: planOption(chat.Mode.Default), name: 'Approve', kind: chat.OptionKind.AllowOnce },
    { optionId: planOption(chat.Mode.AcceptEdits), name: 'Approve and accept edits', kind: chat.OptionKind.AllowOnce },
    { optionId: OPTION_REJECT_ONCE, name: 'Keep planning', kind: chat.OptionKind.RejectOnce },
  ];
  const a = await sink.permission({ kind: chat.PermissionKind.Plan, toolCall: call, options, parent: q.parent }, signal);
  if (signal.aborted) return { result: null };
  const mode = a.option?.startsWith(OPTION_PLAN_PREFIX) ? a.option.slice(OPTION_PLAN_PREFIX.length) : '';
  if (a.cancelled || (mode !== chat.Mode.Default && mode !== chat.Mode.AcceptEdits)) return { result: deny(DENY_PLAN) };
  return { result: allow(q.input), mode };
}
