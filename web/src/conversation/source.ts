// Where a conversation's events come from, as the conversation view sees
// it. The view (its reducer, model.ts, and its components) knows only this
// interface.
import type { ContentBlock, SourceEvent } from './model';

export interface SourceCapabilities {
  /** How the user's text reaches the agent: typed into its terminal
   * (terminal), sent to it (direct, send), or not at all (none). */
  input: 'terminal' | 'direct' | 'none';
  /** The source asks for permissions and takes the answers (respond). */
  permissions: boolean;
  /** Text arrives as the agent writes it rather than block by block. */
  streaming: boolean;
}

export interface AgentSource {
  readonly capabilities: SourceCapabilities;
  /** Calls fn with every event from now on, the ones the source has first
   * (a reset when they no longer hold); returns a function that stops. */
  subscribe(fn: (ev: SourceEvent) => void): () => void;
  /** Gives the events before those given so far to the subscribers;
   * resolves to whether there are earlier ones still. */
  loadEarlier?(): Promise<boolean>;
  /** Sends the user's message; rejects with an error whose code (a string
   * member, when it has one) says why it was not sent, which the view
   * explains when it knows the code (conversation.sendError.<code>). */
  send?(content: ContentBlock[]): Promise<void>;
  /** Cancels the agent's turn. */
  cancel?(): void;
  /** Answers a permission with one of its options. */
  respond?(permission: string, option: string): void;
}
