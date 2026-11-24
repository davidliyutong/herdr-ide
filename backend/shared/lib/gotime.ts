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

const UNITS: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, μs: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** Milliseconds of a duration as Go's flags write it (time.ParseDuration:
 * "20m", "1h30m", "90s", "0"); throws on anything else. */
export function parseDuration(s: string): number {
  const fail = () => new Error(`invalid duration ${JSON.stringify(s)}`);
  const sign = s.startsWith('-') ? -1 : 1;
  let rest = s.replace(/^[-+]/, '');
  if (rest === '0') return 0;
  if (rest === '') throw fail();
  let ms = 0;
  while (rest) {
    const p = /^(\d*(?:\.\d*)?)([a-zµμ]+)/.exec(rest);
    if (!p || p[1] === '' || p[1] === '.' || !(p[2] in UNITS)) throw fail();
    ms += Number(p[1]) * UNITS[p[2]];
    rest = rest.slice(p[0].length);
  }
  return sign * ms;
}
