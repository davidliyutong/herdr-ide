// Numbers as the monitor reports them: one decimal, percentages within
// 0–100, and strict parsing of the text the system gives (a field that is
// not a number is not taken for 0).

/** v to one decimal, halves away from zero; 0 for NaN and infinities. */
export function round1(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return (Math.sign(v) * Math.round(Math.abs(v) * 10)) / 10 || 0;
}

/** A percentage within 0–100, to one decimal. */
export function clampPct(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v > 100) return 100;
  return round1(v);
}

const FLOAT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** s as a decimal number; null when it is not one (or is not finite). */
export function parseNum(s: string): number | null {
  s = s.trim();
  if (!FLOAT.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/** A number of a tool's output: null for empty, "[N/A]"-like and N/A. */
export function parseOptional(s: string): number | null {
  s = s.trim();
  if (s === '' || s.startsWith('[') || s.toLowerCase() === 'n/a') return null;
  return parseNum(s);
}

/** s as a non-negative integer (digits only); null otherwise. */
export function parseUint(s: string): number | null {
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** s as an integer with an optional sign; null otherwise. */
export function parseInt10(s: string): number | null {
  return /^[+-]?\d+$/.test(s) ? Number(s) : null;
}

/** The fields of s split on white space. */
export const fields = (s: string): string[] => s.split(/\s+/).filter(Boolean);

/** s cut to at most max bytes of UTF-8 (a character cut in two becomes
 * U+FFFD, as Go's encoding of the cut bytes did). */
export function truncateBytes(s: string, max: number): string {
  const b = Buffer.from(s, 'utf8');
  return b.length <= max ? s : b.subarray(0, max).toString('utf8');
}
