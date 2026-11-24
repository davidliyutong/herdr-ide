// Terminals of the product's own helpers. A machine's agent runs a helper
// that has to outlive it (the chat host) as a terminal of the instance's
// terminal core, so that it has the lifetime, the owner and the privacy
// attribution of the user's terminals. No client shows such a terminal.
import { SLUG } from '#shared/lib/brand.ts';

/** The key of the label that marks a terminal as one of the product's helpers. */
export const HIDDEN_LABEL = `${SLUG}.hidden`;
/** HIDDEN_LABEL's value for the chat host. */
export const HIDDEN_CHAT_HOST = 'chat-host';
/** The terminal name of a machine's chat host, also the lock that keeps a
 * second chat host from starting (the terminal core gives a name to one
 * live terminal at a time). */
export const CHAT_HOST_NAME = `${SLUG}-${HIDDEN_CHAT_HOST}`;

/** Whether name is CHAT_HOST_NAME or one of its fallback names. */
export const isChatHostName = (name: string): boolean => name === CHAT_HOST_NAME || name.startsWith(CHAT_HOST_NAME + '-');

/** The i-th fallback name (1-based) when a user's terminal holds CHAT_HOST_NAME. */
export const chatHostFallbackName = (i: number): string => `${CHAT_HOST_NAME}-${i}`;

/** HIDDEN_LABEL's value for a helper's terminal named name. */
export function hiddenValue(name: string): string {
  if (isChatHostName(name)) return HIDDEN_CHAT_HOST;
  return name.startsWith(SLUG + '-') ? name.slice(SLUG.length + 1) : name;
}

/** Whether a terminal named name, whose HIDDEN_LABEL has value, is a
 * helper's that no client sees. Both are needed: labels are free-form, so a
 * program that sets the label on another terminal does not hide it. */
export const hidden = (name: string, value: string): boolean => isChatHostName(name) && value === HIDDEN_CHAT_HOST;
