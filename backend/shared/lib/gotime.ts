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

/** A duration of ns nanoseconds as Go's time.Duration writes it ("300ms",
 * "1.5s", "2m0s", "1h0m0s"), for messages both builds word alike. */
export function formatDuration(ns: number): string {
  let u = Math.round(Math.abs(ns));
  const sign = ns < 0 ? '-' : '';
  // The fraction of v/10**prec without its trailing zeros, and v's whole part.
  const frac = (v: number, prec: number): [string, number] => {
    let digits = '';
    let print = false;
    for (let i = 0; i < prec; i++) {
      const d = v % 10;
      print ||= d !== 0;
      if (print) digits = String(d) + digits;
      v = Math.floor(v / 10);
    }
    return [print ? '.' + digits : '', v];
  };
  if (u === 0) return '0s';
  if (u < 1e9) {
    const [unit, prec] = u < 1e3 ? ['ns', 0] : u < 1e6 ? ['µs', 3] : ['ms', 6];
    const [f, whole] = frac(u, prec);
    return `${sign}${whole}${f}${unit}`;
  }
  const [f, secs] = frac(u, 9);
  u = secs;
  let out = `${u % 60}${f}s`;
  u = Math.floor(u / 60);
  if (u > 0) {
    out = `${u % 60}m${out}`;
    u = Math.floor(u / 60);
    if (u > 0) out = `${u}h${out}`;
  }
  return sign + out;
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
