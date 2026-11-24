// Times as the Go program writes them in JSON (time.Time: RFC 3339 with
// the fraction of a second only when there is one, its trailing zeros
// trimmed), so the wire stays the same whichever side wrote a time.

/** d in UTC as Go's time.RFC3339Nano writes it. */
export function formatRFC3339(d: Date): string {
  const iso = d.toISOString(); // 2026-11-02T09:30:00.120Z
  const ms = d.getUTCMilliseconds();
  if (ms === 0) return iso.slice(0, 19) + 'Z';
  return iso.slice(0, 19) + '.' + String(ms).padStart(3, '0').replace(/0+$/, '') + 'Z';
}

/** A time Go wrote (any RFC 3339 offset, up to nanoseconds); null when it is not one. */
export function parseRFC3339(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(s)) return null;
  // Date parses at most milliseconds.
  const t = Date.parse(s.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(t) ? null : new Date(t);
}
