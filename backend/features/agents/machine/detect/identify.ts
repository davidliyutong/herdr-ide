// Which coding agent a terminal's foreground program is, as herdr names it
// (src/detect): by the process's name or argv[0], looked up in a table of
// names and aliases; a shell or a script runtime counts as the agent of
// the script it runs, unless it runs code given inline.
import { toLower, trimSpace } from '#shared/lib/gostrings.ts';

/** Executable names (lower case, without .exe, .cmd, .js and the like) and
 * the agent they run. */
const NAMES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    pi: 'pi',
    claude: 'claude',
    'claude-code': 'claude',
    codex: 'codex',
    gemini: 'gemini',
    cursor: 'cursor',
    'cursor-agent': 'cursor',
    devin: 'devin',
    'devin-cli': 'devin',
    agy: 'agy',
    antigravity: 'agy',
    'antigravity-cli': 'agy',
    cline: 'cline',
    '.cline': 'cline',
    omp: 'omp',
    mastracode: 'mastracode',
    'mastra-code': 'mastracode',
    opencode: 'opencode',
    opencode2: 'opencode',
    'open-code': 'opencode',
    copilot: 'copilot',
    'github-copilot': 'copilot',
    ghcs: 'copilot',
    kimi: 'kimi',
    'kimi-code': 'kimi',
    kiro: 'kiro',
    'kiro-cli': 'kiro',
    droid: 'droid',
    amp: 'amp',
    'amp-local': 'amp',
    grok: 'grok',
    'grok-build': 'grok',
    hermes: 'hermes',
    'hermes-agent': 'hermes',
    kilo: 'kilo',
    'kilo-code': 'kilo',
    qodercli: 'qodercli',
    qoderclicn: 'qodercli',
    qoder: 'qodercli',
    qodercn: 'qodercli',
    qwen: 'qwen',
    'qwen-code': 'qwen',
    letta: 'letta',
    'letta-code': 'letta',
    maki: 'maki',
    muse: 'muse',
    'muse-code': 'muse',
    'muse-cli': 'muse',
  }),
);

/** The entry points of agents installed as Node packages and run by node
 * or bun, by their last path components. */
const PACKAGES: ReadonlyArray<{ suffix: string[]; agent: string }> = [
  { suffix: ['node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli'], agent: 'pi' },
  { suffix: ['node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli'], agent: 'pi' },
  { suffix: ['node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli'], agent: 'omp' },
  { suffix: ['node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs'], agent: 'kimi' },
  { suffix: ['node_modules', '@qwen-code', 'qwen-code', 'dist', 'index'], agent: 'qwen' },
  { suffix: ['node_modules', 'mastracode', 'dist', 'cli'], agent: 'mastracode' },
  { suffix: ['node_modules', '@letta-ai', 'letta-code', 'letta'], agent: 'letta' },
  { suffix: ['node_modules', '@anthropic-ai', 'claude-code', 'cli'], agent: 'claude' },
  { suffix: ['node_modules', '@openai', 'codex', 'bin', 'codex'], agent: 'codex' },
  { suffix: ['node_modules', '@google', 'gemini-cli', 'dist', 'index'], agent: 'gemini' },
];

/** A name as herdr looks it up: its last path component, lower case,
 * without a Windows or script extension. */
function normalize(name: string): string {
  name = toLower(trimSpace(name)).replace(/[/\\]+$/, '');
  name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  for (const ext of ['.exe', '.cmd', '.bat', '.ps1', '.js']) if (name.endsWith(ext)) return name.slice(0, -ext.length);
  return name;
}

function lookup(name: string): string {
  const n = normalize(name);
  const a = NAMES.get(n);
  if (a) return a;
  // Muse's launcher execs muse-bin-<version>.
  if (n.startsWith('muse-bin-') && /^[0-9]/.test(n.slice('muse-bin-'.length))) return 'muse';
  return '';
}

/** python, or python and a version of dot-separated numbers. */
const isPython = (n: string): boolean => n === 'python' || /^python\d+(\.\d+)*$/.test(n);

/** Whether n is a shell or a script runtime, whose own name says nothing
 * about the agent it may run. */
const runtime = (n: string): boolean => ['sh', 'bash', 'zsh', 'fish', 'dash', 'tmux', 'node', 'bun'].includes(n) || isPython(n);

/** The agent a terminal's foreground program is (by its process name and
 * argv, as herdr-core reports them); "" for anything else. */
export function identify(name: string, argv: readonly string[] | null | undefined): string {
  const args = argv ?? [];
  // argv[0] carries the name an agent gave itself (node rewrites its
  // title, nix wrappers keep the original name there).
  if (args.length > 0 && args[0] !== '') {
    const a = lookup(args[0]);
    if (a) return a;
  }
  const a = lookup(name);
  if (a) return a;
  let run = normalize(name);
  if (args.length > 0 && runtime(normalize(args[0]))) run = normalize(args[0]);
  return runtime(run) ? scriptAgent(run, args) : '';
}

/** Options of the runtimes that take a value in the next argument. */
const TAKES_VALUE = new Set([
  '-r',
  '--require',
  '--loader',
  '--import',
  '--experimental-loader',
  '--inspect-port',
  '-W',
  '-X',
  '-S',
  '-L',
  '-o',
]);

/** The agent of the script a runtime runs: its first argument that is not
 * an option, unless code is given inline. */
function scriptAgent(run: string, argv: readonly string[]): string {
  let inline: string[];
  if (run === 'node' || run === 'bun') inline = ['-e', '--eval', '-p', '--print'];
  else if (isPython(run)) inline = ['-c', '-m'];
  else if (run === 'tmux') return '';
  else inline = ['-c'];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') return i + 1 < argv.length ? pathAgent(argv[i + 1]) : '';
    if (inline.some((f) => arg === f || (f.startsWith('--') ? arg.startsWith(f + '=') : arg.startsWith(f)))) return '';
    if (arg.startsWith('-')) {
      if (TAKES_VALUE.has(arg)) i++;
      continue;
    }
    return pathAgent(arg);
  }
  return '';
}

/** The agent a script path names: by its file name, or by the entry point
 * of a known package. */
function pathAgent(p: string): string {
  p = p.replace(/^["']+|["']+$/g, '');
  if (p === '' || p.startsWith('-')) return '';
  const a = lookup(p);
  if (a) return a;
  const parts = p
    .split(/[/\\]/)
    .filter((x) => x !== '')
    .map(toLower);
  for (const k of PACKAGES) {
    if (parts.length < k.suffix.length) continue;
    const tail = parts.slice(parts.length - k.suffix.length);
    const last = k.suffix.length - 1;
    const same = k.suffix.every((want, i) =>
      i === last ? tail[i].replace(/\.js$/, '').replace(/\.mjs$/, '') === want.replace(/\.mjs$/, '') : tail[i] === want,
    );
    if (same) return k.agent;
  }
  return '';
}
