// What a Codex chat runs with: the policies of its permission modes, the
// parameters of its threads and turns, and its configuration options (the
// models model/list offers, their efforts, the modes).
import * as chat from '#shared/proto/chatproto/index.ts';
import { Mode, MODES, type Capabilities, type ConfigOption, type ModelOption, type SlashCommand } from '#shared/proto/chatproto/index.ts';
import type {
  AskForApproval,
  ClientRequests,
  Model,
  ReasoningEffortOption,
  SandboxPolicy,
  ThreadForkParams,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
  UserInput,
} from './appserver.gen.ts';

/** The ids of the chat's configuration options, their categories'. */
export const Opt = {
  Model: chat.Category.Model,
  Effort: chat.Category.ThoughtLevel,
  Mode: chat.Category.Mode,
} as const;

/** The names of the permission modes in the mode option. */
const MODE_NAMES: Record<string, string> = {
  [Mode.Default]: 'Ask',
  [Mode.AcceptEdits]: 'Accept edits',
  [Mode.Plan]: 'Plan',
  [Mode.Full]: 'Full access',
};

/** What a turn runs with: the model, the effort and the permission mode. */
export interface Settings {
  model: string;
  effort: string;
  mode: string;
}

export const isMode = (m: string): boolean => (MODES as readonly string[]).includes(m);

/** How a permission mode runs a turn: Codex's approval policy and sandbox
 * policy, and whether it plans (collaboration mode plan). Threads start
 * and resume read-only (a thread started workspace-write writes its
 * directory into ~/.codex/config.toml as trusted); each turn carries the
 * mode's policies, which write nothing.
 *
 * The default mode asks before every change of a file and every command
 * (approval "untrusted": Codex 0.171.0 asked for apply_patch, mkdir and ls
 * alike), and what the user allows runs in the working directory's
 * sandbox. Under "on-request" with a read-only sandbox, the model refuses
 * to write instead of asking; under "on-request" with a writable one, it
 * writes the directory and runs commands there without asking, which is
 * acceptEdits. */
export function policy(mode: string, cwd: string): { approval: AskForApproval; sandbox: SandboxPolicy; plan: boolean } {
  const readOnly: SandboxPolicy = { type: 'readOnly', networkAccess: false };
  // excludeTmpdirEnvVar would break zsh's here-documents.
  const workspace: SandboxPolicy = {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
  switch (mode) {
    case Mode.AcceptEdits:
      return { approval: 'on-request', sandbox: workspace, plan: false };
    case Mode.Plan:
      return { approval: 'on-request', sandbox: readOnly, plan: true };
    case Mode.Full:
      return { approval: 'never', sandbox: { type: 'dangerFullAccess' }, plan: false };
  }
  return { approval: 'untrusted', sandbox: workspace, plan: false };
}

/** turn/start's parameters for input under st. */
export function turnParams(thread: string, cwd: string, clientMessage: string, input: UserInput[], st: Settings): TurnStartParams {
  const { approval, sandbox, plan } = policy(st.mode, cwd);
  const p: TurnStartParams = {
    threadId: thread,
    input,
    approvalPolicy: approval,
    approvalsReviewer: 'user',
    sandboxPolicy: sandbox,
    // Null instructions: the mode's own.
    collaborationMode: {
      mode: plan ? 'plan' : 'default',
      settings: { model: st.model, reasoning_effort: st.effort !== '' ? st.effort : null, developer_instructions: null },
    },
  };
  if (clientMessage !== '') p.clientUserMessageId = clientMessage;
  if (st.model !== '') p.model = st.model;
  if (st.effort !== '') p.effort = st.effort;
  return p;
}

/** thread/start's parameters (resume "") or thread/resume's: always
 * read-only, asking the user (the real policy goes with each turn). */
export function threadParams(resume: '', cwd: string, model: string): ThreadStartParams;
export function threadParams(resume: string, cwd: string, model: string): ThreadResumeParams;
export function threadParams(resume: string, cwd: string, model: string): ThreadStartParams | ThreadResumeParams {
  const p: ThreadStartParams & Partial<ThreadResumeParams> = {
    cwd,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
  };
  if (model !== '') p.model = model;
  if (resume !== '') return { ...p, threadId: resume, excludeTurns: true } satisfies ThreadResumeParams;
  return p;
}

/** thread/fork's parameters: always read-only, asking the user, without
 * hydrating turns, so forking never writes ~/.codex/config.toml. */
export function forkParams(
  threadId: string,
  cwd: string,
  o: { model?: string; beforeTurnId?: string; lastTurnId?: string } = {},
): ThreadForkParams {
  const p: ThreadForkParams = {
    threadId,
    cwd,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
    excludeTurns: true,
  };
  if (o.model) p.model = o.model;
  if (o.beforeTurnId) p.beforeTurnId = o.beforeTurnId;
  else if (o.lastTurnId) p.lastTurnId = o.lastTurnId;
  return p;
}

/** model/list's parameters. */
export const modelListParams = (cursor: string): ClientRequests['model/list']['params'] => ({
  limit: 100,
  includeHidden: false,
  ...(cursor ? { cursor } : {}),
});

/** The models model/list gave, the hidden ones left out. */
export class Models {
  readonly list: Model[];

  constructor(list: Model[] = []) {
    this.list = list;
  }

  get length(): number {
    return this.list.length;
  }

  /** A model's name for turn/start. */
  static slug(m: Model): string {
    return m.model || m.id;
  }

  find(slug: string): Model | undefined {
    return this.list.find((m) => Models.slug(m) === slug || m.id === slug);
  }

  /** The efforts of a model; null when it is not known. */
  efforts(slug: string): ReasoningEffortOption[] | null {
    const m = this.find(slug);
    return m ? (m.supportedReasoningEfforts ?? []) : null;
  }

  /** The effort to run model with: want when the model has it, else the
   * thread's (from the user's configuration) when it has that, else the
   * model's default. */
  effortFor(model: string, want: string, thread: string): string {
    const efforts = this.efforts(model);
    if (efforts === null) {
      // A model model/list does not list: the effort asked for, or none.
      return want !== '' ? want : thread;
    }
    for (const e of [want, thread]) if (e !== '' && hasEffort(efforts, e)) return e;
    const m = this.find(model);
    if (m?.defaultReasoningEffort) return m.defaultReasoningEffort;
    return efforts[0]?.reasoningEffort ?? '';
  }

  /** Whether a model takes images; true when it is not known. */
  images(slug: string): boolean {
    const m = this.find(slug);
    return !m || !m.inputModalities || m.inputModalities.length === 0 || m.inputModalities.includes('image');
  }

  /** The chat's configuration options under st. */
  configOptions(st: Settings): ConfigOption[] {
    const out: ConfigOption[] = [];
    const model: ConfigOption = {
      id: Opt.Model,
      name: 'Model',
      category: chat.Category.Model,
      type: chat.CONFIG_SELECT,
      currentValue: st.model,
      options: [],
    };
    for (const m of this.list) {
      model.options!.push({
        value: Models.slug(m),
        name: m.displayName || Models.slug(m),
        ...(m.description ? { description: m.description } : {}),
      });
    }
    if (st.model !== '' && !this.find(st.model)) model.options!.push({ value: st.model, name: st.model });
    if (model.options!.length > 0) out.push(model);
    const efforts = this.efforts(st.model) ?? [];
    if (efforts.length > 0) {
      out.push({
        id: Opt.Effort,
        name: 'Effort',
        category: chat.Category.ThoughtLevel,
        type: chat.CONFIG_SELECT,
        currentValue: st.effort,
        options: efforts.map((e) => ({
          value: e.reasoningEffort,
          name: e.reasoningEffort,
          ...(e.description ? { description: e.description } : {}),
        })),
      });
    }
    out.push({
      id: Opt.Mode,
      name: 'Mode',
      category: chat.Category.Mode,
      type: chat.CONFIG_SELECT,
      currentValue: st.mode,
      // Full access: the host refuses it unless its settings allow it.
      options: MODES.map((m) => ({ value: m, name: MODE_NAMES[m]!, ...(m === Mode.Full ? { full: true } : {}) })),
    });
    return out;
  }

  /** Models in chatproto's standalone Op.Models shape. */
  toModelOptions(): ModelOption[] {
    return this.list.map((m) => {
      const value = Models.slug(m);
      const efforts = (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
      return {
        value,
        name: m.displayName || value,
        ...(m.description ? { description: m.description } : {}),
        ...(efforts.length > 0 ? { efforts } : {}),
        ...(m.defaultReasoningEffort ? { defaultEffort: m.defaultReasoningEffort } : {}),
        images: this.images(value),
      };
    });
  }

  /** What a chat with st's model can do. */
  capabilities(st: Settings): Capabilities {
    return {
      images: this.images(st.model),
      compact: true,
      queue: true,
      plan: true,
      questions: true,
      effort: (this.efforts(st.model) ?? []).length > 0,
      model: this.list.length > 0,
      cancelQueued: true,
      steer: true,
      stopTask: true,
      fork: true,
      rewind: true,
      rewindFiles: false,
    };
  }
}

export const hasEffort = (efforts: ReasoningEffortOption[], e: string): boolean => efforts.some((o) => o.reasoningEffort === e);

/** The slash commands a Codex chat takes as prompts. */
export const COMMANDS: readonly SlashCommand[] = Object.freeze([
  { name: 'compact', description: 'Summarize the conversation to free context' },
]);
