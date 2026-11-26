/** How long a connection must stay open before retries return to the initial delay. */
export const RETRY_RESET_MS = 30_000;

/** Spreads retries across pages that lost the same connection. */
export const retryDelay = (ms: number): number => Math.round(ms * (0.8 + Math.random() * 0.4));
