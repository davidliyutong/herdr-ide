// The detector's rules, identification and tracker, against the cases of
// ./testdata. UPDATE_TESTDATA=1 rewrites testdata/manifests.json, what the
// manifests parse to, after a deliberate change of them or of the parser
// (review the diff).
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all } from '#shared/agents/kinds.ts';
import { identify } from './identify.ts';
import { ManifestError, State, evaluate, parseManifest, re2Spelling, region, validRegion, type GateSpec } from './manifest.ts';
import { MANIFEST_FILES, manifestFor, manifests } from './manifests.ts';
import { TRACKER_TIMING, Tracker } from './tracker.ts';

const DIR = import.meta.dir;
const cases = <T>(name: string): T => JSON.parse(readFileSync(join(DIR, 'testdata', name), 'utf8')) as T;

/** v with the keys of its objects in order, as the recorded cases have them. */
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
        )
      : v;

/** Lines as herdr-core's terminal.read returns a screen. */
const screen = (...lines: string[]) => lines.join('\n') + '\n';

describe('manifests', () => {
  test('every file of the directory is embedded and parses', () => {
    const files = readdirSync(join(DIR, 'manifests')).filter((f) => f.endsWith('.toml'));
    expect(Object.keys(MANIFEST_FILES).sort()).toEqual(files.sort());
    for (const f of files) expect(MANIFEST_FILES[f]).toBe(readFileSync(join(DIR, 'manifests', f), 'utf8'));
    expect(manifests().size).toBe(files.length);
  });

  test('parse to testdata/manifests.json', () => {
    const gate = (g: GateSpec): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const k of ['all', 'any', 'not'] as const) if (g[k]?.length) out[k] = g[k]!.map(gate);
      for (const k of ['contains', 'regex', 'line_regex'] as const) if (g[k]?.length) out[k] = g[k];
      return out;
    };
    const got: Record<string, unknown> = {};
    for (const [id, m] of manifests()) {
      got[id] = {
        id: m.id,
        version: m.version,
        min_engine_version: m.minEngineVersion,
        updated_at: m.updatedAt,
        ...(m.aliases.length ? { aliases: m.aliases } : {}),
        rules: m.rules.map((r) => ({
          ...gate(r.spec),
          id: r.id,
          state: r.state,
          priority: r.priority,
          region: r.region,
          ...(r.visibleIdle ? { visible_idle: true } : {}),
          ...(r.visibleBlocker ? { visible_blocker: true } : {}),
          ...(r.visibleWorking ? { visible_working: true } : {}),
          ...(r.skipStateUpdate ? { skip_state_update: true } : {}),
        })),
      };
    }
    if (process.env.UPDATE_TESTDATA === '1')
      writeFileSync(join(DIR, 'testdata', 'manifests.json'), JSON.stringify(sortKeys(got), null, 1) + '\n');
    expect(got).toEqual(cases('manifests.json'));
  });

  // The settings offer every agent the manifests know as a silent agent:
  // the registry's kinds are the manifests'.
  test('are the registry’s kinds', () => {
    expect([...manifests().keys()].sort()).toEqual(
      all()
        .map((k) => k.id)
        .sort(),
    );
  });
});

describe('rules', () => {
  // Screens of the agents the UI starts, written after the agents' own
  // interfaces and the manifests' rules, with the state each gives.
  test('per agent', () => {
    const list =
      cases<Array<{ agent: string; name: string; screen: string[]; title?: string; want: string; skip?: boolean }>>('screens.json');
    expect(list.length).toBeGreaterThan(30);
    for (const c of list) {
      const m = manifestFor(c.agent);
      expect(m).toBeDefined();
      const r = evaluate(m!, { screen: screen(...c.screen), title: c.title ?? '' });
      expect([c.agent, c.name, r.state, r.skip]).toEqual([c.agent, c.name, c.want, !!c.skip]);
    }
  });

  // Gates: contains are case-insensitive, regexes all match, line regexes
  // match a line each; all, any and not nest; the highest priority wins
  // and no match reads idle. Manifests outside herdr's format or limits
  // fail.
  test('semantics', () => {
    const v = cases<{ manifest: string; cases: Array<{ screen: string; want: string; rule: string }>; bad: string[]; good: string[] }>(
      'rules.json',
    );
    const m = parseManifest(v.manifest);
    for (const c of v.cases) {
      const r = evaluate(m, { screen: c.screen });
      expect([c.screen, r.state, r.rule]).toEqual([c.screen, c.want, c.rule]);
    }
    for (const bad of v.bad) expect(() => parseManifest(bad), bad).toThrow(ManifestError);
    for (const good of v.good) expect(() => parseManifest(good), good).not.toThrow();
  });

  test('regions and Rust spellings', () => {
    const v = cases<{
      cases: Array<{ screen: string; title?: string; progress?: string; region: string; want: string }>;
      valid: string[];
      invalid: string[];
      rewrites: Array<{ in: string; want: string }>;
    }>('regions.json');
    for (const c of v.cases)
      expect([c.region, c.screen, region({ screen: c.screen, title: c.title, progress: c.progress }, c.region)]).toEqual([
        c.region,
        c.screen,
        c.want,
      ]);
    for (const s of v.valid) expect([s, validRegion(s)]).toEqual([s, true]);
    for (const s of v.invalid) expect([s, validRegion(s)]).toEqual([s, false]);
    for (const c of v.rewrites) expect(re2Spelling(c.in)).toBe(c.want);
  });

  // RE2's syntax and semantics, not JavaScript's RegExp: \s is ASCII
  // space only, \x{…} names a code point, (?s) and \A as RE2 reads them,
  // and a character class takes a character outside the BMP whole.
  test('RE2 semantics', () => {
    const one = (regex: string, text: string) =>
      evaluate(parseManifest(`id = "x"\n[[rules]]\nid = "r"\nstate = "working"\nregex = ['${regex}']\n`), { screen: text }).state;
    expect(one('^a\\sb$', 'a b')).toBe(State.Idle);
    expect(one('^a\\sb$', 'a\tb')).toBe(State.Working);
    expect(one('\\x{1F600}', 'x😀')).toBe(State.Working);
    expect(one('^[😀]$', '😀')).toBe(State.Working);
    expect(one('\\Aab', 'ab')).toBe(State.Working);
    expect(one('\\Aab', 'x\nab')).toBe(State.Idle);
    expect(one('(?s)a.b', 'a\nb')).toBe(State.Working);
    expect(one('a.b', 'a\nb')).toBe(State.Idle);
    expect(one('(?i)straße', 'STRASSE')).toBe(State.Idle);
    expect(one('\\bé', 'xé')).toBe(State.Working);
  });

  test('a contains is lower-cased one character at a time, as Go does', () => {
    const m = parseManifest(`id = "x"\n[[rules]]\nid = "r"\nstate = "working"\ncontains = ["ΑΣ"]\n`);
    expect(evaluate(m, { screen: 'ΑΣ' }).state).toBe(State.Working);
    expect(evaluate(m, { screen: 'ασ' }).state).toBe(State.Working);
  });
});

test('identify', () => {
  for (const c of cases<Array<{ name: string; argv: string[] | null; want: string }>>('identify.json'))
    expect([c.name, c.argv, identify(c.name, c.argv)]).toEqual([c.name, c.argv, c.want]);
});

describe('tracker', () => {
  const working = { screen: screen('✻ Thinking… (3s · esc to interrupt)') };
  const plain = { screen: screen('⏺ All done.') };
  const prompt = { screen: screen('⏺ All done.', '──────', '❯ ', '──────') };
  const dialog = { screen: screen(' Do you want to proceed?', ' ❯ 1. Yes', '   2. No') };
  const t0 = 1_000_000;
  const grace = TRACKER_TIMING.startupGraceMs;

  // Nothing is read during the startup grace; working → idle without the
  // prompt on screen waits for three more reads or 700 ms, and becomes
  // done; the visible prompt confirms at once; done stays until a new
  // turn.
  test('debounce and done', () => {
    const tr = new Tracker(manifestFor('claude'), t0);
    expect(tr.observe(t0 + 1000, working)).toEqual([State.Unknown, false]);
    const at = t0 + grace;
    expect(tr.observe(at, working)).toEqual([State.Working, true]);
    // A spinner frame that reads as idle, then working again: no change.
    expect(tr.observe(at + 100, plain)[1]).toBe(false);
    expect(tr.pending()).toBe(true);
    expect(tr.observe(at + 200, working)).toEqual([State.Working, false]);
    expect(tr.pending()).toBe(false);
    // The first idle read and three confirmations.
    for (let i = 1; i <= 4; i++) {
      const [s, ch] = tr.observe(at + 300 + 100 * i, plain);
      expect([i, ch]).toEqual([i, i === 4]);
      if (i === 4) expect(s).toBe(State.Done);
    }
    expect(tr.observe(at + 1000, prompt)).toEqual([State.Done, false]);
    expect(tr.observe(at + 2000, working)[0]).toBe(State.Working);
    // The cap: one read 700 ms later is enough.
    tr.observe(at + 3000, plain);
    expect(tr.observe(at + 3000 + TRACKER_TIMING.idleCapMs, plain)).toEqual([State.Done, true]);
    // The prompt confirms at once; blocked → idle is done too.
    tr.observe(at + 4000, working);
    expect(tr.observe(at + 5000, prompt)).toEqual([State.Done, true]);
    expect(tr.observe(at + 6000, dialog)[0]).toBe(State.Blocked);
    expect(tr.observe(at + 7000, prompt)).toEqual([State.Done, true]);
    // An agent that exits in the middle of a turn is done; at rest nothing.
    tr.observe(at + 8000, working);
    expect(tr.exit()).toEqual([State.Done, true]);
    expect(tr.exit()[1]).toBe(false);
  });

  // A status the program reports itself wins over the screen, at once and
  // also during the grace; once cleared, the screen counts again.
  test('self-reported', () => {
    const tr = new Tracker(manifestFor('claude'), t0);
    expect(tr.report(State.Working)).toEqual([State.Working, true]);
    expect(tr.selfReported()).toBe(true);
    expect(tr.observe(t0 + 3_600_000, prompt)).toEqual([State.Working, false]);
    expect(tr.report(State.Idle)).toEqual([State.Done, true]);
    expect(tr.report('error')).toEqual([State.Blocked, true]);
    expect(tr.report(State.Done)).toEqual([State.Done, true]);
    expect(tr.report(State.Done)[1]).toBe(false);
    tr.report('');
    expect(tr.observe(t0 + 3_600_000, working)[0]).toBe(State.Working);
    expect(tr.selfReported()).toBe(false);
    expect(tr.report('something else')).toEqual([State.Unknown, true]);
    // Without a manifest only the program's own report gives a status.
    expect(new Tracker(undefined, t0).observe(t0 + 3_600_000, working)).toEqual([State.Unknown, false]);
  });

  test('a skipped screen keeps the state and ends a pending change', () => {
    const tr = new Tracker(manifestFor('claude'), t0);
    tr.observe(t0 + grace, working);
    tr.observe(t0 + grace + 100, plain);
    expect(tr.pending()).toBe(true);
    const viewer = { screen: screen('⏺ Earlier output', '  Showing detailed transcript · ctrl+o to toggle') };
    expect(tr.observe(t0 + grace + 200, viewer)).toEqual([State.Working, false]);
    expect(tr.pending()).toBe(false);
    expect(tr.graceLeft(t0 + 1000)).toBe(grace - 1000);
    expect(tr.graceLeft(t0 + grace + 1)).toBe(0);
  });
});
