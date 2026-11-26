// Compares the AI usage plugin's price table (spec/pricing/pricing.json)
// with LiteLLM's public one, which follows the providers' price pages, for
// a release (RELEASING.md): the table's models whose prices differ there,
// and the models of the families the table prices that it does not know.
// Nothing is written: pricing.json is edited by hand from the providers'
// own pages, which stay the source.
//
//   bun backend/scripts/pricecheck.ts              # fetches LiteLLM's table
//   bun backend/scripts/pricecheck.ts --src FILE   # a copy of it
//
// The exit status is 1 when something differs or is missing. The table is
// someone else's: a model name with other characters than those of model
// names (letters, digits, . _ : / @ -) is left out and counted, so the
// output carries no control characters or text of its own.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pricing from '../../spec/pricing/pricing.json' with { type: 'json' };

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
/** Bounds the table read (it is a few MB). */
const MAX_BODY = 64 << 20;

/** A tier of the table, in USD per million tokens. */
export interface Tier {
  inputMax?: number | null;
  input: number;
  cached: number;
  output: number;
  cacheWrite?: number;
}

/** The table's providers: model (a prefix of names) to its tiers. */
export type PriceTable = Record<string, Record<string, { source?: string; tiers: Tier[] }>>;

/** What this script reads of a model of LiteLLM's table (USD per token). */
export interface Entry {
  provider?: string;
  mode?: string;
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
  /** The long-context prices, under keys such as
   * input_cost_per_token_above_200k_tokens. */
  long: Record<string, number>;
}

/** Per provider of the table, LiteLLM's provider and the model names the
 * CLIs the plugin reads use. */
const FAMILIES: Record<string, { litellm: string; names: RegExp }> = {
  grok: { litellm: 'xai', names: /^grok-[0-9]/ },
  claude: { litellm: 'anthropic', names: /^claude-/ },
  codex: { litellm: 'openai', names: /^gpt-[5-9]/ },
  antigravity: { litellm: 'gemini', names: /^gemini-(2\.5|[3-9])/ },
  kimi: { litellm: 'moonshot', names: /^kimi-/ },
};

/** LiteLLM's models of those families that are no CLI's. */
const NOT_CLI = /(audio|realtime|image|tts|transcribe|search|chat-latest|-instant|live|embed|robotics|computer|customtools|-exp)/;
const LONG_KEY = /^(input|output)_cost_per_token_above_(\d+)k_tokens$/;
/** What a model's key may be to be read at all. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
/** A version suffix of a model's name: -20251101, -2025-08-07, -0309. */
const DATED = /-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** LiteLLM's table; skipped counts the keys left out (SAFE_NAME). */
export function parse(text: string): { entries: Map<string, Entry>; skipped: number } {
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a JSON object');
  const entries = new Map<string, Entry>();
  let skipped = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!SAFE_NAME.test(k)) {
      skipped++;
      continue;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    const long: Record<string, number> = {};
    for (const [f, x] of Object.entries(o)) if (typeof x === 'number' && LONG_KEY.test(f)) long[f] = x;
    const e: Entry = { long };
    const set = <K extends keyof Entry>(key: K, value: Entry[K] | undefined) => {
      if (value !== undefined) e[key] = value;
    };
    set('provider', str(o.litellm_provider));
    set('mode', str(o.mode));
    set('input', num(o.input_cost_per_token));
    set('output', num(o.output_cost_per_token));
    set('cached', num(o.cache_read_input_token_cost));
    set('cacheWrite', num(o.cache_creation_input_token_cost));
    entries.set(k, e);
  }
  return { entries, skipped };
}

/** A LiteLLM key without its provider prefix (xai/grok-4.7). */
const nameOf = (key: string) => key.slice(key.lastIndexOf('/') + 1);

/** LiteLLM's model for an entry of the table: its own name, else a dated
 * version of it (the earliest). */
function match(theirs: Map<string, Entry>, litellm: string, model: string): [string, Entry] | null {
  let best = '';
  let be: Entry | null = null;
  for (const [k, e] of theirs) {
    const n = nameOf(k);
    if (e.provider !== litellm || e.input === undefined || e.output === undefined) continue;
    const exact = n === model;
    if (!exact && !(n.startsWith(model) && DATED.test(n) && n.replace(DATED, '') === model)) continue;
    const bestExact = best !== '' && nameOf(best) === model;
    if (best === '' || (exact && !bestExact) || (exact === bestExact && n < nameOf(best))) [best, be] = [k, e];
  }
  return be ? [best, be] : null;
}

/** USD per token as USD per million tokens. */
const perM = (p: number) => Math.round(p * 1e6 * 1e6) / 1e6;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
/** A number as Go's %g writes these. */
const g = (v: number) => String(v);

/** The longest prefix of model the table prices for provider. */
function priced(ours: PriceTable, provider: string, model: string): boolean {
  return Object.keys(ours[provider] ?? {}).some((k) => model.startsWith(k));
}

/** What differs: a line per finding, sorted. */
export function compare(ours: PriceTable, theirs: Map<string, Entry>): { differ: string[]; missing: string[] } {
  const differ: string[] = [];
  let missing: string[] = [];
  for (const [prov, models] of Object.entries(ours)) {
    const f = FAMILIES[prov];
    if (!f) continue;
    for (const [model, mp] of Object.entries(models)) {
      const m = match(theirs, f.litellm, model);
      if (!m) {
        differ.push(`${prov}/${model}: not in LiteLLM's table (check ${mp.source ?? ''})`);
        continue;
      }
      const [key, e] = m;
      const t = mp.tiers[0]!;
      const d: string[] = [];
      const check = (what: string, mine: number, p: number | undefined) => {
        if (p !== undefined && !near(mine, perM(p))) d.push(`${what} ${g(mine)}, LiteLLM ${g(perM(p))}`);
      };
      check('input', t.input, e.input);
      check('output', t.output, e.output);
      check('cached', t.cached, e.cached);
      if (t.cacheWrite !== undefined) check('cache write', t.cacheWrite, e.cacheWrite);
      if (mp.tiers.length === 1 && Object.keys(e.long).length > 0) d.push('LiteLLM has a long-context price, the table one price');
      if (mp.tiers.length > 1) {
        const long = mp.tiers[1]!;
        for (const [field, v] of Object.entries(e.long)) {
          const [, kind, k] = LONG_KEY.exec(field)!;
          const mine = kind === 'output' ? long.output : long.input;
          const theirsM = Math.round(v * 1e12) / 1e6;
          if (!near(mine, theirsM)) d.push(`long ${kind} ${g(mine)}, LiteLLM ${g(theirsM)} above ${k}k`);
        }
      }
      if (d.length > 0) differ.push(`${prov}/${model} (LiteLLM ${key}): ${d.sort().join('; ')}`);
    }
  }
  const seen = new Set<string>();
  for (const [k, e] of theirs)
    for (const [prov, f] of Object.entries(FAMILIES)) {
      const n = nameOf(k);
      if (e.provider !== f.litellm || (e.mode !== 'chat' && e.mode !== 'responses') || !f.names.test(n) || NOT_CLI.test(n)) continue;
      if (!priced(ours, prov, n) && !seen.has(`${prov}/${n}`)) {
        seen.add(`${prov}/${n}`);
        missing.push(`${prov}/${n}`);
      }
    }
  // A dated version of a model listed is not listed again.
  missing = missing.filter((m) => !(DATED.test(m) && seen.has(m.replace(DATED, ''))));
  return { differ: differ.sort(), missing: missing.sort() };
}

async function fetchTable(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) throw new Error(`${url}: redirect to ${res.headers.get('location') ?? '?'} refused`);
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of res.body) {
    n += c.length;
    if (n > MAX_BODY) throw new Error(`${url}: more than ${MAX_BODY} bytes`);
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

if (import.meta.main) {
  const { values: o } = parseArgs({ options: { src: { type: 'string' } } });
  let theirs: Map<string, Entry>;
  try {
    const { entries, skipped } = parse(o.src ? readFileSync(o.src, 'utf8') : await fetchTable(LITELLM_URL));
    theirs = entries;
    if (skipped > 0) console.log(`skipped: ${skipped} model keys with characters model names do not have`);
  } catch (e) {
    console.error(`pricecheck: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = compare(pricing.providers as unknown as PriceTable, theirs);
  for (const l of r.differ) console.log(`differs: ${l}`);
  for (const l of r.missing) console.log(`missing: ${l}`);
  if (r.differ.length + r.missing.length > 0) {
    console.log("Check each against the provider's price page, then edit spec/pricing/pricing.json.");
    process.exit(1);
  }
  console.log("pricing.json agrees with LiteLLM's table.");
}
