// Where a chat's events come from and where the user's commands go, as the
// conversation view sees it: a chat that a machine's chat host runs
// (internal/chatproto), relayed by the chat plugin, whose ChatSource
// implements this interface. The view (its reducer, model.ts, and its
// components) knows only this interface.
import type { ContentBlock, SourceEvent } from './model';

/** A file the user may name in a message (`@`): its absolute path on the
 * chat's machine, and how the list shows it (a path relative to the chat's
 * directory). */
export interface FileSuggestion {
  path: string;
  label: string;
}

/** An answer to a permission: one of its options, or none (cancelled). */
export type PermissionReply = { option: string } | { cancelled: true };

/** An answer to a question: the answers by question id (option labels or
 * the user's own words), or none (skipped). */
export type QuestionReply = { answers: Record<string, string[]> } | { cancelled: true };

/** A chat as the view uses it. Every command resolves once the host took
 * it, and rejects with an error whose code (a string member, chatproto's
 * Error codes and the core's: read_only, offline, …) says why it did not;
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
   * configuration, commands, usage and capabilities. A reset says that what
   * it gave no longer holds. */
  subscribe(fn: (ev: SourceEvent) => void): () => void;
  /** Gives the stored events before those given so far to the
   * subscribers; resolves to whether there are earlier ones still. Absent
   * for a source that gives the whole log at once. */
  loadEarlier?(): Promise<boolean>;
  /** Sends the user's message (text, image and resource_link blocks) under
   * the page's id of it (the user or queued event that follows names it);
   * while a turn runs, the host queues it. A message of an id the host has
   * already is taken once. */
  send(content: ContentBlock[], clientId: string): Promise<void>;
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
  /** Compacts the conversation's context. */
  compact(): Promise<void>;
  /** The files of the chat's directory that match what the user typed
   * after `@`, the best first; absent when the source cannot tell. */
  suggestFiles?(query: string): Promise<FileSuggestion[]>;
  /** Trusts the chat's folder, and those below it, on its machine: an
   * agent started there from then on loads the project's own settings
   * (the notice untrusted_folder says it did not). Absent when the source
   * cannot; a read-only view does not offer it. */
  trust?(): Promise<void>;
  /** Takes back the trust that covers the chat's folder (its own and
   * that of the folders above it): an agent started there from then on
   * runs without the project's own settings again. Absent when the
   * source cannot; a read-only view does not offer it. */
  untrust?(): Promise<void>;
}
