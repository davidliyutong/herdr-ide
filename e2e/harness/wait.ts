// Waiting on conditions instead of sleeping.

export interface WaitOptions {
  what: string;
  timeout?: number;
  interval?: number;
}

/** Polls cond until it returns a truthy value (which it returns) or the
 * timeout passes; errors thrown by cond count as not yet. */
export async function waitFor<T>(cond: () => Promise<T> | T, o: WaitOptions): Promise<NonNullable<T>> {
  const deadline = Date.now() + (o.timeout ?? 10_000);
  let last: unknown;
  for (;;) {
    try {
      const v = await cond();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${o.what}${last ? `: ${last instanceof Error ? last.message : String(last)}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, o.interval ?? 100));
  }
}
