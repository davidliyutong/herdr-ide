// What the core registers in its settings and keybindings, written for the
// clients that need it before or without a core (spec/generated/registry.json):
//
//   - "settings": each setting's default, which the web UI uses until the
//     core's values arrive;
//   - "commands" and "keybindings": the commands and the default bindings
//     of each platform, which the web UI and the desktop app's shell use
//     until they have read the core's;
//   - "i18n": the translation keys the web UI needs for the settings and
//     commands it shows; its tests fail when it lacks one;
//   - "agents": the kinds of coding agents (shared/agents), which the web
//     UI starts, resumes and shows the conversations of.
//
// It also writes the tables of every setting and of every command with its
// default keys into docs/reference.md, between the markers there.
//
// The core's input is the features the host composes (registryInput of
// hosts/common/compose.ts describedFeatures): scripts/registry.ts writes the
// files, or with --check only compares them (pnpm registry, make tokens).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as agentkinds from '#shared/agents/kinds.ts';
import { COMMANDS, Keybindings, SECTIONS, type Command, type Platform } from './keybindings/index.ts';
import { Settings, type Def, type Module } from './settings/index.ts';
import { toggles, type Switchable } from './toggles.ts';
import { UI } from './ui/index.ts';

/** What coreModules reads of a feature (FeatureDef's members). */
export type FeatureSettings = Switchable & { settings?: Module };

/** The settings modules of the core: the user interface's, the switches
 * of the features that can be turned off and the features' own modules,
 * in the order the host composes the features (hosts/common/compose.ts
 * hubFeatures), which is the order the UIs list them in. */
export function coreModules(features: readonly FeatureSettings[]): Module[] {
  return [UI, toggles(features), ...features.flatMap((f) => (f.settings ? [f.settings] : []))];
}

export interface RegistryInput {
  modules: readonly Module[];
  commands: readonly Command[];
  agents: readonly agentkinds.Kind[];
}

/** The registry's input of a core of features: their settings, every
 * command, every kind of coding agent. */
export const registryInput = (features: readonly FeatureSettings[]): RegistryInput => ({
  modules: coreModules(features),
  commands: COMMANDS,
  agents: agentkinds.all(),
});

const sorted = (list: Iterable<string>) => [...new Set(list)].sort();

/** The translation keys of the UI: every section in use, group, setting
 * label and enum option, and every command with its section. */
export function translationKeys(i: RegistryInput): string[] {
  const settings = new Settings('', { modules: i.modules });
  const defs = settings.defs();
  const used = new Set(defs.map((d) => d.section));
  return sorted([
    ...defs.flatMap((d) => [
      `settings.${d.key}`,
      ...(d.group ? [`settings.group.${d.group}`] : []),
      ...(d.enum ?? []).map((o) => `settings.${d.key}.${o}`),
    ]),
    ...settings
      .sections()
      .filter((s) => used.has(s.id))
      .map((s) => `settings.section.${s.id}`),
    ...SECTIONS.map((s) => `command.section.${s.id}`),
    ...i.commands.map((c) => `command.${c.id}`),
  ]);
}

/** spec/generated/registry.json's content. */
export function buildRegistry(i: RegistryInput): string {
  const settings = new Settings('', { modules: i.modules });
  const keys = new Keybindings('', { commands: i.commands });
  const doc = {
    agents: i.agents,
    commands: keys.commands(),
    i18n: translationKeys(i),
    keybindings: keys.allDefaults(),
    settings: Object.fromEntries(sorted(settings.defs().map((d) => d.key)).map((k) => [k, settings.lookup(k)!.default])),
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

/** The values a setting takes, for the reference. */
function values(d: Def): string {
  switch (d.type) {
    case 'enum':
      return (d.enum ?? []).map((e) => `\`${e}\``).join(', ');
    case 'number': {
      const kind = d.integer ? 'integer' : 'number';
      return d.min !== undefined && d.max !== undefined ? `${kind}, ${d.min}–${d.max}` : kind;
    }
    case 'color':
      return 'color `#rrggbb`';
    case 'list': {
      const item = d.item === 'color' ? 'colors' : 'strings';
      return d.length ? `${d.length} ${item}` : `list of ${item}`;
    }
    case 'bool':
      return '`true`, `false`';
  }
  return d.type;
}

/** A setting's default as JSON; a palette is named by its length. */
function defaultOf(d: Def): string {
  if (Array.isArray(d.default) && d.item === 'color' && d.default.length > 4) return `${d.default.length} colors of \`spec/tokens.json\``;
  return `\`${JSON.stringify(d.default)}\``;
}

const SCOPES = { app: '–', machine: 'per machine', 'remote-machine': 'per remote machine' } as const;

/** Every setting, in the order of the settings dialog. */
export function settingsTable(modules: readonly Module[]): string {
  const settings = new Settings('', { modules });
  const order = new Map(settings.sections().map((s) => [s.id, s.order]));
  const defs = [...settings.defs()].sort((a, b) => order.get(a.section)! - order.get(b.section)! || a.order - b.order);
  const rows = defs.map(
    (d) => `| \`${d.key}\` | ${values(d)} | ${defaultOf(d)} | ${d.flag ? `\`--${d.flag}\`` : '–'} | ${SCOPES[d.scope]} |\n`,
  );
  return '| Setting | Values | Default | Flag | Scope |\n| --- | --- | --- | --- | --- |\n' + rows.join('');
}

/** Every command with its default keys per platform. */
export function commandsTable(commands: readonly Command[] = COMMANDS): string {
  const keys = new Keybindings('', { commands });
  const defaults = keys.allDefaults();
  const platforms: readonly Platform[] = ['mac', 'mac-browser', 'windows', 'windows-browser', 'linux', 'linux-browser'];
  const head = `| Command | When | ${platforms.map((p) => `\`${p}\``).join(' | ')} |\n| --- | --- |${' --- |'.repeat(platforms.length)}\n`;
  const rows = keys.commands().map((c) => {
    const cells = platforms.map((p) => {
      const bound = defaults[p].filter((r) => r.command === c.id).map((r) => `\`${r.key}\``);
      return bound.length ? bound.join(', ') : '–';
    });
    return `| \`${c.id}\` | \`${c.when}\` | ${cells.join(' | ')} |\n`;
  });
  return head + rows.join('');
}

const markers = (name: string) => [`<!-- make tokens: ${name} -->`, `<!-- end of make tokens: ${name} -->`] as const;

/** doc (docs/reference.md) with each generated table between its markers. */
export function fillReference(doc: string, i: RegistryInput): string {
  for (const [name, table] of [
    ['settings', settingsTable(i.modules)],
    ['commands', commandsTable(i.commands)],
  ] as const) {
    const [begin, end] = markers(name);
    const a = doc.indexOf(begin);
    const b = doc.indexOf(end);
    if (a < 0 || b < a) throw new Error(`docs/reference.md: markers ${JSON.stringify(begin)} and ${JSON.stringify(end)} missing`);
    doc = doc.slice(0, a + begin.length) + '\n\n' + table + '\n' + doc.slice(b);
  }
  return doc;
}

/** Writes (or with check, only compares) the registry and the reference
 * of i under root; returns the files that were stale. */
export function updateRegistry(root: string, i: RegistryInput, check = false): string[] {
  const stale: string[] = [];
  const update = (rel: string, want: string) => {
    const path = join(root, rel);
    let old: string | undefined;
    try {
      old = readFileSync(path, 'utf8');
    } catch {
      // missing
    }
    if (old === want) return;
    stale.push(rel);
    if (check) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, want);
  };
  update('spec/generated/registry.json', buildRegistry(i));
  update('docs/reference.md', fillReference(readFileSync(join(root, 'docs/reference.md'), 'utf8'), i));
  return stale;
}
