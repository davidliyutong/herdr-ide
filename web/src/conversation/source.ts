// Where a chat's events come from and where the user's commands go, as the
// conversation view sees it: a chat that a machine's chat host runs
// (backend/shared/proto/chatproto), relayed by the chat plugin, whose ChatSource
// implements this interface. The view (its reducer, model.ts, and its
// components) knows only this interface.
import type { ReactNode } from 'react';
import type { MarkdownBase } from '../markdown/links';
import type { BackgroundTask, Delivery } from '../plugins/chat/protocol';
import type { ContentBlock, SourceEvent } from './model';

export type { BackgroundTask, Delivery };

/** A file the user may name in a message (`@`) or attach from the file browser:
 * its absolute path on the chat's machine, and how the list shows it (a path
 * relative to the chat's directory). */
export interface FileSuggestion {
  path: string;
  label: string;
  /** True when the entry is a directory (`@` autocomplete drills into it
   * instead of closing the menu). */
  isDir?: boolean;
}

/** Alias used by file search / picker helpers. */
export interface FileMatch extends FileSuggestion {
  name?: string;
}

/** Structured task metadata extracted from a tool call's `_meta.<slug>.task`
 * (Claude SDK tasks, Codex subagents / background terminals). */
export interface TaskMeta {
  taskId?: string;
  type?: string;
  description?: string;
  lastTool?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  summary?: string;
  backgrounded?: boolean;
  stoppable?: boolean;
  subagentType?: string;
  parentTaskId?: string;
  error?: string;
  processId?: string;
}

/** Options for rewinding an idle chat to just before a user turn. */
export interface RewindOptions {
  /** Re-send edited content immediately after rewinding; omit to truncate only. */
  content?: ContentBlock[];
  clientId?: string;
  /** Restore file checkpoints made since the target turn (when capabilities.rewindFiles). */
  restoreFiles?: boolean;
}

/** Model picker visibility filter & settings shortcut passed from ChatPane
 * into Conversation and forwarded to Composer (#3). */
export interface ModelPickerConfig {
  /** Visible model IDs allowlist (empty or undefined = show all). Current model
   * always remains visible even if not in the allowlist. */
  visibleModels?: readonly string[];
  /** Opens Chat Settings directly to this agent's provider sub-page. */
  onManageModels?(): void;
}

/** Shared optional props added to ConversationProps (Conversation.tsx) and
 * supplied by ChatPane.tsx. */
export interface ConversationExtras {
  /** Brand logo element for the active agent kind. */
  agentIcon?: ReactNode;
  /** Active Git branch name (or detached commit short hash) of the chat's workspace. */
  branch?: string;
  /** Model visibility allowlist (#3). */
  modelPicker?: ModelPickerConfig;
  /** Fork the conversation up to `upToSeq` (or its end when omitted) (#6). */
  onFork?(upToSeq?: number): void | Promise<void>;
  /** Open a referenced chat (e.g. the source chat of a cross-agent handoff). */
  onOpenChat?(chatId: string, kind?: string): void;
}

/** Shared optional props forwarded from Conversation.tsx into Composer.tsx. */
export interface ComposerExtras {
  /** Agent kind id (e.g. 'claude', 'codex', 'agy'). */
  kind?: string;
  /** Brand logo element for the active agent kind. */
  agentIcon?: ReactNode;
  /** Machine & directory base for project label, Markdown preview and local FilePicker. */
  base?: MarkdownBase;
  /** Active Git branch name (or detached commit short hash) of the chat's workspace. */
  branch?: string;
  /** Current turn activity (e.g. 'compacting' for #9 loading indicator). */
  activity?: 'compacting';
  /** Model visibility allowlist (#3). */
  modelPicker?: ModelPickerConfig;
}

/** Directory entry shape consumed by FilePicker (compatible with lib/files RemoteStat). */
export interface FilePickerEntry {
  name: string;
  path?: string;
  is_dir: boolean;
  size?: number;
}

/** Props for the reusable local file browser popover (web/src/components/FilePicker.tsx, #5). */
export interface FilePickerProps {
  /** Machine id on which to browse files. */
  m: string;
  /** Initial directory (the chat's cwd). */
  rootDir: string;
  /** Already-attached file paths (shown as checked). */
  selected?: readonly string[];
  /** Called when the user confirms selected files. */
  onSelect(files: FileSuggestion[]): void;
  /** Called when the user dismisses the picker. */
  onClose(): void;
  /** Optional directory listing override for tests (defaults to lib/files listDir). */
  listDir?: (m: string, path: string) => Promise<{ entries: FilePickerEntry[] }>;
}

/** An answer to a permission: one of its options, or none (cancelled). */
export type PermissionReply = { option: string } | { cancelled: true };

/** An answer to a question: the answers by question id (option labels or
 * the user's own words), or none (skipped). */
export type QuestionReply = { answers: Record<string, string[]> } | { cancelled: true };

/** A chat as the view uses it. Every command resolves once the host took
 * it, and rejects with an error whose code (a string member, chatproto's
 * Error codes and the hub's: read_only, offline, …) says why it did not;
 * the view explains the codes it knows (conversation.error.<code>). An
 * error whose member unsure is true says that the command was sent and may
 * have been carried out all the same (the connection ended before the
 * answer): a message then shows in the conversation once the host has it,
 * and sending it again under its clientId does not send it twice. */
export interface ChatSource {
  /** A name of the chat that outlives the view (the user's draft is kept
   * by it); without one, the draft is kept by the source object. */
  readonly id?: string;
  /** The chat is shown read-only: every control is disabled. */
  readonly readOnly?: boolean;
  /** Calls fn with every event from now on, the ones the source has first;
   * returns a function that stops. After it attached, and after it attached
   * again (a reattach event first), its first event is an info event with
   * the chat as the host stated it (chatproto.Chat): its state,
   * configuration, commands, usage, tasks and capabilities. A reset says that
   * what it gave no longer holds. */
  subscribe(fn: (ev: SourceEvent) => void): () => void;
  /** Gives the stored events before those given so far to the
   * subscribers; resolves to whether there are earlier ones still. Absent
   * for a source that gives the whole log at once. */
  loadEarlier?(): Promise<boolean>;
  /** Sends the user's message (text, image and resource_link blocks) under
   * the page's id of it (the user or queued event that follows names it);
   * while a turn runs, delivery chooses 'queue' (default), 'steer' or
   * 'interrupt'. A message of an id the host has already is taken once. */
  send(content: ContentBlock[], clientId: string, delivery?: Delivery): Promise<void>;
  /** Cancels the turn, what waits for an answer and the queued messages. */
  cancel(): Promise<void>;
  /** Answers the permission of that id. */
  respond(permission: string, reply: PermissionReply): Promise<void>;
  /** Answers, or skips, the question of that id. */
  answer(question: string, reply: QuestionReply): Promise<void>;
  /** Sets a configuration option (the model, the effort, the mode) to one
   * of its values. */
  setConfig(id: string, value: string): Promise<void>;
  /** Withdraws a queued message before the agent took it. */
  cancelQueued(message: string): Promise<void>;
  /** Promotes an already-queued message to send immediately via 'steer'
   * (default) or 'interrupt'. */
  steerQueued?(message: string, delivery?: 'steer' | 'interrupt'): Promise<void>;
  /** Compacts the conversation's context, optionally guided by instructions. */
  compact(instructions?: string): Promise<void>;
  /** Terminates a running background task or subagent by BackgroundTask.id. */
  stopTask?(taskId: string): Promise<void>;
  /** Rewinds an idle chat to just before the user turn at `seq`, optionally
   * restoring files and/or immediately sending edited content. */
  rewind?(seq: number, opts?: RewindOptions): Promise<void>;
  /** The files of the chat's directory that match what the user typed
   * after `@`, the best first; absent when the source cannot tell. */
  suggestFiles?(query: string, signal?: AbortSignal): Promise<FileSuggestion[]>;
  /** Trusts the chat's folder, and those below it, on its machine: an
   * agent started there from then on loads the project's own settings
   * (the notice untrusted_folder says it did not). Absent when the source
   * cannot; a read-only view does not offer it. */
  trust?(): Promise<void>;
  /** Takes back the trust that covers the chat's folder (its own and
   * that of the folders above it): an agent started there from then on
   * runs without the project's own settings again. Absent when the source
   * cannot; a read-only view does not offer it. */
  untrust?(): Promise<void>;
}
