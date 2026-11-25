// Hardware temperatures and fan speeds: Linux's hwmon class (with the
// thermal zones when hwmon has no temperature), and on macOS the battery's
// temperature, the one macOS gives without root or the SMC and IOHID
// interfaces.
import { join } from 'node:path';
import type { Bounded } from './io.ts';
import { parseNum, round1, truncateBytes } from './num.ts';
import type { Fan, Sensors, Temp } from './types.ts';

/** Bounds each of a sample's temperature and fan lists. */
export const MAX_SENSORS = 128;
/** Bounds the hwmon and thermal zone directories scanned. */
const MAX_CHIPS = 64;
/** Outside this range (°C) a reading is an unconnected input or an error
 * value (-128, 255…), not a temperature. */
const MIN_C = -50;
const MAX_C = 200;

/** a before b, with runs of digits compared by value ("Core 2" before
 * "Core 10"). */
export function naturalLess(a: string, b: string): boolean {
  let i = 0;
  let j = 0;
  const digits = (s: string, k: number) => {
    let n = k;
    while (n < s.length && s.charCodeAt(n) >= 48 && s.charCodeAt(n) <= 57) n++;
    return n;
  };
  while (i < a.length && j < b.length) {
    const ea = digits(a, i);
    const eb = digits(b, j);
    if (ea > i && eb > j) {
      const na = a.slice(i, ea).replace(/^0+/, '');
      const nb = b.slice(j, eb).replace(/^0+/, '');
      if (na.length !== nb.length) return na.length < nb.length;
      if (na !== nb) return na < nb;
      i = ea;
      j = eb;
      continue;
    }
    if (a[i] !== b[j]) return a[i] < b[j];
    i++;
    j++;
  }
  return a.length - i < b.length - j;
}

const order = (x: { chip: string; label: string }, y: { chip: string; label: string }): number => {
  const less = (p: string, q: string) => naturalLess(p, q);
  if (x.chip !== y.chip) return less(x.chip, y.chip) ? -1 : less(y.chip, x.chip) ? 1 : 0;
  return less(x.label, y.label) ? -1 : less(y.label, x.label) ? 1 : 0;
};

/** Drops implausible temperatures and sorts both lists; undefined when
 * nothing is left. */
export function finishSensors(s: { temps: Temp[]; fans: Fan[] }): Sensors | undefined {
  const temps = s.temps.filter((t) => t.tempC >= MIN_C && t.tempC <= MAX_C).sort(order);
  const fans = [...s.fans].sort(order);
  if (!temps.length && !fans.length) return undefined;
  return { ...(temps.length ? { temps } : {}), ...(fans.length ? { fans } : {}) };
}

/** root's entries named prefix<N>, in order of N, at most MAX_CHIPS. */
async function numbered(io: Bounded, root: string, prefix: string, ms: number): Promise<string[]> {
  const names = (await io.names(root, ms)) ?? [];
  return names
    .flatMap((n) => {
      const rest = n.startsWith(prefix) ? n.slice(prefix.length) : null;
      return rest !== null && /^\d+$/.test(rest) ? [{ n, i: Number(rest) }] : [];
    })
    .sort((a, b) => a.i - b.i)
    .slice(0, MAX_CHIPS)
    .map((d) => d.n);
}

/** N of a file <kind>N_input. */
function sensorIndex(name: string, kind: string): number | null {
  const m = new RegExp(`^${kind}(\\d+)_input$`).exec(name);
  return m ? Number(m[1]) : null;
}

/** The temperatures and fans of the hwmon class under sysRoot (normally
 * /sys): hwmon*\/name names the chip (a second chip of one driver is told
 * apart by its directory), tempN_input in millidegrees Celsius with
 * tempN_label, _max and _crit, fanN_input in RPM with fanN_label, _min and
 * _max; without a temperature there, the thermal zones' (thermal_zone*\/type
 * and temp, their hot or passive and critical trip points). */
export async function sysfsSensors(io: Bounded, sysRoot: string, ms: number): Promise<Sensors | undefined> {
  const text = async (p: string) => {
    const s = await io.text(p, ms);
    return s === null ? '' : truncateBytes(s.trim(), 64);
  };
  const num = async (p: string) => {
    const s = await text(p);
    return s === '' ? null : parseNum(s);
  };
  const milliC = async (p: string) => {
    const v = await num(p);
    return v === null ? null : round1(v / 1000);
  };
  const temps: Temp[] = [];
  const fans: Fan[] = [];
  const hwmon = join(sysRoot, 'class', 'hwmon');
  const seen = new Map<string, number>();
  for (const d of await numbered(io, hwmon, 'hwmon', ms)) {
    const dir = join(hwmon, d);
    let chip = (await text(join(dir, 'name'))) || d;
    seen.set(chip, (seen.get(chip) ?? 0) + 1);
    if (seen.get(chip)! > 1) chip += ` (${d})`;
    const names = await io.names(dir, ms);
    if (!names) continue;
    const ts = names
      .map((n) => sensorIndex(n, 'temp'))
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
    const fs = names
      .map((n) => sensorIndex(n, 'fan'))
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
    for (const n of ts) {
      if (temps.length >= MAX_SENSORS) break;
      const p = join(dir, `temp${n}`);
      const c = await milliC(p + '_input');
      if (c === null) continue;
      const t: Temp = { chip, label: (await text(p + '_label')) || `temp${n}`, tempC: c };
      const high = await milliC(p + '_max');
      if (high !== null && high > 0 && high <= MAX_C) t.highC = high;
      const crit = await milliC(p + '_crit');
      if (crit !== null && crit > 0 && crit <= MAX_C) t.critC = crit;
      temps.push(t);
    }
    for (const n of fs) {
      if (fans.length >= MAX_SENSORS) break;
      const p = join(dir, `fan${n}`);
      const rpm = await num(p + '_input');
      if (rpm === null || rpm < 0) continue;
      const f: Fan = { chip, label: (await text(p + '_label')) || `fan${n}`, rpm };
      const min = await num(p + '_min');
      if (min !== null && min > 0) f.minRpm = round1(min);
      const max = await num(p + '_max');
      if (max !== null && max > 0) f.maxRpm = round1(max);
      fans.push(f);
    }
  }
  if (!temps.length) {
    const thermal = join(sysRoot, 'class', 'thermal');
    for (const d of await numbered(io, thermal, 'thermal_zone', ms)) {
      if (temps.length >= MAX_SENSORS) break;
      const dir = join(thermal, d);
      const c = await milliC(join(dir, 'temp'));
      if (c === null) continue;
      const t: Temp = { chip: 'thermal', label: (await text(join(dir, 'type'))) || d, tempC: c };
      for (let i = 0; i < 16; i++) {
        const p = join(dir, `trip_point_${i}`);
        const kind = await text(p + '_type');
        if (!kind) break;
        const v = await milliC(p + '_temp');
        if (v === null || v <= 0 || v > MAX_C) continue;
        if (kind === 'critical' && (t.critC === undefined || v < t.critC)) t.critC = v;
        else if ((kind === 'hot' || kind === 'passive') && (t.highC === undefined || v < t.highC)) t.highC = v;
      }
      temps.push(t);
    }
  }
  return finishSensors({ temps, fans });
}

/** The battery's temperature from `ioreg -rn AppleSmartBattery -w0`, whose
 * "Temperature" key is in hundredths of a degree Celsius. */
export function parseBatteryTemp(raw: string): Sensors | undefined {
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('"Temperature" = ')) continue;
    const v = parseNum(t.slice('"Temperature" = '.length));
    if (v === null) return undefined;
    return finishSensors({ temps: [{ chip: 'battery', label: 'Battery', tempC: round1(v / 100) }], fans: [] });
  }
  return undefined;
}
