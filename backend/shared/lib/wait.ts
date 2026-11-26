/** Waits for shared work without letting a caller cancel it for others. */
export function waitForResult<T>(result: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return result;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    result.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** Spreads retries from different connections over a window around ms. */
export const retryDelay = (ms: number): number => Math.round(ms * (0.8 + Math.random() * 0.4));
