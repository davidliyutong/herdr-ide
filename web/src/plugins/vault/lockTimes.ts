// The auto-lock's countdown in the vault panel: how its times read and
// how a time typed into its picker is understood
// (docs/features/30-variable-vault.md).
import { t } from '../../i18n';

/** The longest time a page may set, as vault.autoLock's range: a day. */
export const MAX_MINUTES = 1440;

/** The times the picker offers, in minutes. */
export const PRESETS = [15, 30, 60, 120, 240, 480] as const;

/** A duration in minutes as people read it: 45 min, 2 h, 1 h 30 min. */
export function minutesText(n: number): string {
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (!h) return t('vault.autoLock.minutes', { n: m });
  if (!m) return t('vault.autoLock.hours', { n: h });
  return t('vault.autoLock.hoursMinutes', { h, m });
}

/** Seconds left as a clock: 4:05, 59:59, 1:02:03. */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const UNIT_H = '(?:h|hr|hrs|hour|hours|小时|时)';
const UNIT_M = '(?:m|min|mins|minute|minutes|分钟|分)';
const NUM = '(\\d+(?:\\.\\d+)?)';
const TIME = new RegExp(`^(?:${NUM}${UNIT_H})?(?:${NUM}${UNIT_M}?)?$`);

/** The minutes a typed time names (90, 90m, 2h, 1.5h, 1h30m, 2小时), or
 * undefined when it names none from 1 minute to a day. */
export function parseMinutes(q: string): number | undefined {
  const s = q.trim().toLowerCase().replace(/\s+/g, '');
  const m = TIME.exec(s);
  if (!s || !m || (m[1] === undefined && m[2] === undefined)) return undefined;
  // A bare number after hours is minutes (1h30); alone it is minutes too.
  const n = Math.round(Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0));
  return n >= 1 && n <= MAX_MINUTES ? n : undefined;
}
