import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { paths, repoRoot } from '../harness/paths';

export const WIDTH = 2000;
export const dockerImage = `${paths.slug}-e2e-screenshots`;
export const HEIGHT = 1141;

export const scenes = {
  overview: {
    title: 'Machines, workspaces, agents and split terminals',
    features: ['02', '04', '07', '10', '11', '12', '21', '22', '25', '26', '39', '40', '42'],
  },
  chat: { title: 'Headless agent chats and persisted transcripts', features: ['35', '37', '38'] },
  files: { title: 'File explorer and conflict-safe editor', features: ['28'] },
  quicklook: { title: 'Media preview and downloads', features: ['06'] },
  search: { title: 'Project search', features: ['41'] },
  git: { title: 'Source Control, Git Graph and diffs', features: ['31'] },
  usage: { title: 'Subscription windows and API-equivalent spend', features: ['29'] },
  vault: { title: 'Encrypted variable vault', features: ['30'] },
  monitor: { title: 'Resource dashboard and task manager', features: ['34'] },
  browser: { title: 'Browser pane and loopback port forwarding', features: ['32'] },
  windows: { title: 'Program windows from a remote Linux machine', features: ['14'] },
  vscode: { title: 'VS Code panes and verified provisioning', features: ['05', '09'] },
  settings: { title: 'Settings, keybindings, themes and plugins', features: ['13', '24', '27'] },
  security: { title: 'VS Code browser switch and explicit risk acceptance', features: ['08'] },
  formula: { title: 'LaTeX formulas in terminal panes', features: ['19'] },
  'terminal-history': { title: 'Workspace restore and terminal history', features: ['33', '36'] },
  desktop: { title: 'Desktop app with its in-process hub', features: ['16'] },
} as const;

export type SceneName = keyof typeof scenes;
export type Locale = 'en' | 'zh-CN';

export const outputDir = resolve(repoRoot, process.env.SCREENSHOT_DIR || 'docs/images');
/** The staging directory created by this runner, for its publisher to clean up. */
export let stageDir: string | undefined;

export function stageImages(): void {
  mkdirSync(outputDir, { recursive: true });
  stageDir = mkdtempSync(join(outputDir, '.screenshots-'));
  process.env.E2E_SCREENSHOT_STAGE = stageDir;
}

export const selected = new Set(
  (process.env.SCREENSHOT_ONLY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

for (const name of selected) if (!Object.hasOwn(scenes, name)) throw new Error(`unknown screenshot scene ${name}`);

export function wants(name: SceneName): boolean {
  return selected.size === 0 || selected.has(name);
}

export function imagePath(name: SceneName, locale: Locale): string {
  const stage = process.env.E2E_SCREENSHOT_STAGE;
  if (!stage) throw new Error('screenshot staging directory has not been set up');
  return join(stage, `${name}${locale === 'en' ? '' : '.zh-CN'}.png`);
}

export function checkCoverage() {
  const documented = readdirSync(join(repoRoot, 'docs', 'features'))
    .map((name) => /^(\d+)-.*\.md$/.exec(name)?.[1])
    .filter((id): id is string => !!id);
  const covered = Object.values(scenes).flatMap((scene) => scene.features as readonly string[]);
  const missing = documented.filter((id) => !covered.includes(id));
  const unknown = covered.filter((id) => !documented.includes(id));
  const duplicate = covered.filter((id, i) => covered.indexOf(id) !== i);
  if (missing.length || unknown.length || duplicate.length) {
    throw new Error(
      `screenshot coverage mismatch: missing=${missing.join(',') || 'none'} unknown=${unknown.join(',') || 'none'} duplicate=${duplicate.join(',') || 'none'}`,
    );
  }
}
