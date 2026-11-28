// File-type icons, as VS Code's file icon themes give them: lucide's icons
// in the design tokens' file icon hues (spec/tokens.json fileIcon,
// --ds-file-icon-*). A name is looked up, case ignored, by its special
// names first (package.json, Dockerfile, README…), then its compound
// extensions (.d.ts, .test.ts, .tar.gz…), then its extension; folders by
// their name (.git, src, node_modules…). An open folder keeps its color
// with the open folder's shape; a symbolic link is lucide's link icon of
// its kind in its type's color.

import {
  BookOpen,
  Container,
  File,
  FileArchive,
  FileBadge,
  FileBox,
  FileBraces,
  FileChartPie,
  FileClock,
  FileCode,
  FileCodeCorner,
  FileCog,
  FileDatabase,
  FileDiff,
  FileDigit,
  FileImage,
  FileKey,
  FileLock,
  FileMusic,
  FilePlay,
  FileSliders,
  FileSpreadsheet,
  FileSymlink,
  FileTerminal,
  FileText,
  FileType,
  FileUser,
  FlaskConical,
  Folder,
  FolderArchive,
  FolderBookmark,
  FolderCheck,
  FolderClock,
  FolderCode,
  FolderCog,
  FolderDot,
  FolderGit,
  FolderGit2,
  FolderHeart,
  FolderKey,
  FolderOpen,
  FolderOutput,
  FolderSymlink,
  GitBranch,
  Hammer,
  NotebookText,
  Package,
  Scale,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { t } from './i18n';

/** The hues of spec/tokens.json fileIcon. */
export const FILE_ICON_COLORS = ['blue', 'sky', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'brown', 'grey'] as const;
export type FileIconColor = (typeof FILE_ICON_COLORS)[number];

export interface FileIconDef {
  /** What the icon stands for (typescript, folder.src), for tests and styles. */
  id: string;
  icon: LucideIcon;
  /** Neutral (the text's dim color) when undefined. */
  color?: FileIconColor;
}

type Entry = readonly [string, LucideIcon, FileIconColor?];
const def = ([id, icon, color]: Entry): FileIconDef => ({ id, icon, color });

// ---- languages and kinds, shared by several names ----
const code = (id: string, color: FileIconColor): Entry => [id, FileCode, color];
const K = {
  typescript: code('typescript', 'blue'),
  react: code('react', 'sky'),
  javascript: code('javascript', 'yellow'),
  json: ['json', FileBraces, 'yellow'],
  markdown: ['markdown', FileText, 'blue'],
  text: ['text', FileText],
  shell: ['shell', FileTerminal, 'green'],
  powershell: ['powershell', FileTerminal, 'blue'],
  yaml: ['yaml', FileCog, 'purple'],
  toml: ['toml', FileCog, 'brown'],
  ini: ['ini', FileSliders, 'grey'],
  xml: code('xml', 'orange'),
  html: code('html', 'orange'),
  css: code('css', 'blue'),
  sass: code('sass', 'pink'),
  image: ['image', FileImage, 'purple'],
  svg: ['svg', FileImage, 'orange'],
  video: ['video', FilePlay, 'red'],
  audio: ['audio', FileMusic, 'pink'],
  archive: ['archive', FileArchive, 'brown'],
  package: ['package', FileBox, 'brown'],
  pdf: ['pdf', FileText, 'red'],
  document: ['document', FileText, 'blue'],
  spreadsheet: ['spreadsheet', FileSpreadsheet, 'green'],
  presentation: ['presentation', FileChartPie, 'orange'],
  font: ['font', FileType, 'red'],
  certificate: ['certificate', FileBadge, 'yellow'],
  key: ['key', FileKey, 'yellow'],
  log: ['log', FileClock, 'grey'],
  notebook: ['notebook', NotebookText, 'orange'],
  binary: ['binary', FileDigit, 'grey'],
  database: ['database', FileDatabase, 'teal'],
  sql: ['sql', FileDatabase, 'orange'],
  diff: ['diff', FileDiff, 'green'],
  lock: ['lock', FileLock, 'grey'],
  env: ['env', FileCog, 'yellow'],
  config: ['config', FileCog, 'grey'],
  git: ['git', GitBranch, 'orange'],
  docker: ['docker', Container, 'blue'],
  make: ['make', Hammer, 'orange'],
  cmake: ['cmake', Hammer, 'sky'],
  build: ['build', Hammer, 'green'],
  readme: ['readme', BookOpen, 'blue'],
  license: ['license', Scale, 'yellow'],
  changelog: ['changelog', FileClock, 'green'],
  people: ['people', FileUser, 'grey'],
  security: ['security', ShieldCheck, 'green'],
  npm: ['npm', Package, 'red'],
  python: code('python', 'blue'),
  pythonPackage: ['python.package', Package, 'blue'],
  ruby: code('ruby', 'red'),
  rubyPackage: ['ruby.package', Package, 'red'],
  go: code('go', 'sky'),
  goPackage: ['go.package', Package, 'sky'],
  rust: code('rust', 'orange'),
  rustPackage: ['rust.package', Package, 'orange'],
  composer: ['php.package', Package, 'purple'],
  javaPackage: ['java.package', Package, 'red'],
  declaration: ['typescript.declaration', FileCodeCorner, 'blue'],
} satisfies Record<string, Entry>;

/** Whole names (lower case), checked first. */
const NAMES: Record<string, Entry> = {
  'package.json': K.npm,
  'package-lock.json': K.lock,
  'npm-shrinkwrap.json': K.lock,
  'yarn.lock': K.lock,
  'pnpm-lock.yaml': K.lock,
  'pnpm-workspace.yaml': K.npm,
  'bun.lockb': K.lock,
  'bun.lock': K.lock,
  'deno.lock': K.lock,
  'cargo.toml': K.rustPackage,
  'cargo.lock': K.lock,
  'go.mod': K.goPackage,
  'go.sum': K.lock,
  'go.work': K.goPackage,
  'go.work.sum': K.lock,
  gemfile: K.rubyPackage,
  'gemfile.lock': K.lock,
  rakefile: K.ruby,
  pipfile: K.pythonPackage,
  'pipfile.lock': K.lock,
  'poetry.lock': K.lock,
  'uv.lock': K.lock,
  'pyproject.toml': K.pythonPackage,
  'setup.py': K.pythonPackage,
  'setup.cfg': K.pythonPackage,
  'composer.json': K.composer,
  'composer.lock': K.lock,
  'pom.xml': K.javaPackage,
  'build.gradle': K.javaPackage,
  'build.gradle.kts': K.javaPackage,
  'settings.gradle': K.javaPackage,
  'settings.gradle.kts': K.javaPackage,
  'flake.lock': K.lock,
  makefile: K.make,
  gnumakefile: K.make,
  justfile: K.make,
  'cmakelists.txt': K.cmake,
  build: K.build,
  'build.bazel': K.build,
  workspace: K.build,
  'workspace.bazel': K.build,
  'module.bazel': K.build,
  'meson.build': K.build,
  dockerfile: K.docker,
  containerfile: K.docker,
  '.dockerignore': K.docker,
  '.gitignore': K.git,
  '.gitattributes': K.git,
  '.gitmodules': K.git,
  '.gitkeep': K.git,
  '.git-blame-ignore-revs': K.git,
  '.mailmap': K.git,
  '.editorconfig': K.config,
  '.prettierignore': K.config,
  '.eslintignore': K.config,
  '.npmrc': K.npm,
  '.yarnrc': K.npm,
  '.yarnrc.yml': K.npm,
  '.nvmrc': K.npm,
  '.node-version': K.npm,
  '.python-version': K.python,
  '.ruby-version': K.ruby,
  '.tool-versions': K.config,
  '.envrc': K.env,
  procfile: K.config,
  vagrantfile: K.ruby,
  jenkinsfile: K.build,
  codeowners: K.people,
  authors: K.people,
  contributors: K.people,
  maintainers: K.people,
  '.bashrc': K.shell,
  '.bash_profile': K.shell,
  '.bash_logout': K.shell,
  '.zshrc': K.shell,
  '.zprofile': K.shell,
  '.zshenv': K.shell,
  '.profile': K.shell,
  '.inputrc': K.shell,
  known_hosts: K.key,
  authorized_keys: K.key,
  id_rsa: K.key,
  id_ed25519: K.key,
  id_ecdsa: K.key,
  'tsconfig.json': ['tsconfig', FileCog, 'blue'],
  'jsconfig.json': ['jsconfig', FileCog, 'yellow'],
};

/** Extensions treated as documentation / plain prose when matching special
 * document prefixes (README, LICENSE, CHANGELOG, HISTORY, SECURITY, ...). */
const DOC_EXTS = new Set(['md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'asciidoc', 'org', 'pdf', 'rtf', 'doc', 'docx']);

/** Final extension after the last dot (past any leading dot run), else ''. */
function lastExtension(n: string): string {
  let start = 0;
  while (start < n.length && n[start] === '.') start++;
  const dot = n.lastIndexOf('.');
  return dot > start && dot < n.length - 1 ? n.slice(dot + 1) : '';
}

const isPlainOrDoc = (n: string): boolean => {
  const ext = lastExtension(n);
  return !ext || DOC_EXTS.has(ext);
};

const isPlainOrDocOrUnknown = (n: string): boolean => {
  const ext = lastExtension(n);
  return !ext || DOC_EXTS.has(ext) || !EXT_MAP.has(ext);
};

const isDockerVariant = (n: string): boolean => {
  const ext = lastExtension(n);
  return !ext || ext === 'dockerfile' || ext === 'containerfile' || !EXT_MAP.has(ext);
};

const isMakeVariant = (n: string): boolean => {
  const ext = lastExtension(n);
  return !ext || ext === 'mk' || ext === 'mak' || !EXT_MAP.has(ext);
};

const isEnvVariant = (n: string): boolean => {
  if (/\.(?:d\.[mc]?ts|(?:test|spec)\.[mc]?[jt]sx?)$/.test(n)) return false;
  const ext = lastExtension(n);
  return !ext || ext === 'env' || !EXT_MAP.has(ext);
};

const JS_TS_EXT = '(?:[mc]?[jt]s)';
const DATA_OR_JS_EXT = '(?:[mc]?[jt]s|jsonc?|ya?ml|toml)';
const RC_EXT = '(?:jsonc?|ya?ml|[mc]?js|toml)';

const VITE_CFG = new RegExp(`^vite\\.config\\.${JS_TS_EXT}$`);
const VITEST_CFG = new RegExp(`^vitest\\.(?:config|workspace)\\.${JS_TS_EXT}$`);
const WEBPACK_CFG = new RegExp(`^webpack\\.config\\.${JS_TS_EXT}$`);
const ROLLUP_CFG = new RegExp(`^rollup\\.config\\.${JS_TS_EXT}$`);
const ESLINT_CFG = new RegExp(`^(?:eslint\\.config\\.${JS_TS_EXT}|\\.eslintrc(?:\\.${RC_EXT})?)$`);
const PRETTIER_CFG = new RegExp(`^(?:prettier\\.config\\.${DATA_OR_JS_EXT}|\\.prettierrc(?:\\.${RC_EXT})?)$`);
const BABEL_CFG = new RegExp(`^(?:babel\\.config\\.${DATA_OR_JS_EXT}|\\.babelrc(?:\\.${RC_EXT})?)$`);
const JEST_CFG = new RegExp(`^jest\\.config\\.${DATA_OR_JS_EXT}$`);
const PLAYWRIGHT_CFG = new RegExp(`^playwright(?:\\.[^.]+)?\\.config\\.${JS_TS_EXT}$`);
const TAILWIND_CFG = new RegExp(`^tailwind\\.config\\.${JS_TS_EXT}$`);
const POSTCSS_CFG = new RegExp(`^postcss\\.config\\.${DATA_OR_JS_EXT}$`);
const FRAMEWORK_CFG = new RegExp(`^(?:next|nuxt|svelte|astro|remix)\\.config\\.${JS_TS_EXT}$`);

/** Names matched by prefix/pattern (lower case), scoped so source code and
 * test files (e.g. History.tsx, security.ts, dockerfile.sh, vite.config.test.ts)
 * fall through to their real extension icons. */
const PREFIXES: ReadonlyArray<readonly [(n: string) => boolean, Entry]> = [
  [(n) => /^readme(?:[._-]|$)/.test(n) && isPlainOrDocOrUnknown(n), K.readme],
  [(n) => /^(?:license|licence|copying|unlicense)(?:[._-]|$)/.test(n) && isPlainOrDocOrUnknown(n), K.license],
  [(n) => /^(?:changelog|changes|history)(?:[._-]|$)/.test(n) && isPlainOrDoc(n), K.changelog],
  [(n) => /^(?:contributing|code[_-]of[_-]conduct)(?:[._-]|$)/.test(n) && isPlainOrDoc(n), ['contributing', FileUser, 'blue']],
  [(n) => /^security(?:[._-]|$)/.test(n) && isPlainOrDoc(n), K.security],
  [(n) => /^(?:authors|contributors|maintainers)(?:[._-]|$)/.test(n) && isPlainOrDoc(n), K.people],
  [(n) => /^\.env(?:\.|$)/.test(n) && isEnvVariant(n), K.env],
  [(n) => /^(?:dockerfile|containerfile)(?:[._-]|$)/.test(n) && isDockerVariant(n), K.docker],
  [(n) => /^(?:(?:docker|podman)-)?compose(?:[._-].*)?\.ya?ml$/.test(n), K.docker],
  [(n) => /^(?:gnu)?makefile\./.test(n) && isMakeVariant(n), K.make],
  [(n) => /^requirements(?:[._-].*)?\.(?:txt|in)$/.test(n), K.pythonPackage],
  [(n) => /^tsconfig(?:\.[^.]+)+\.jsonc?$/.test(n), ['tsconfig', FileCog, 'blue']],
  [(n) => /^jsconfig(?:\.[^.]+)+\.jsonc?$/.test(n), ['jsconfig', FileCog, 'yellow']],
  [(n) => VITE_CFG.test(n), ['vite', FileCog, 'purple']],
  [(n) => VITEST_CFG.test(n), ['vitest', FileCog, 'green']],
  [(n) => WEBPACK_CFG.test(n), ['webpack', FileCog, 'sky']],
  [(n) => ROLLUP_CFG.test(n), ['rollup', FileCog, 'red']],
  [(n) => ESLINT_CFG.test(n), ['eslint', FileCog, 'purple']],
  [(n) => PRETTIER_CFG.test(n), ['prettier', FileCog, 'pink']],
  [(n) => BABEL_CFG.test(n), ['babel', FileCog, 'yellow']],
  [(n) => JEST_CFG.test(n), ['jest', FileCog, 'red']],
  [(n) => PLAYWRIGHT_CFG.test(n), ['playwright', FileCog, 'green']],
  [(n) => TAILWIND_CFG.test(n), ['tailwind', FileCog, 'sky']],
  [(n) => POSTCSS_CFG.test(n), ['postcss', FileCog, 'orange']],
  [(n) => FRAMEWORK_CFG.test(n), ['framework', FileCog, 'teal']],
];

/** Extensions (lower case, without the first dot), compound ones too:
 * the longest that ends the name wins. */
const EXTENSIONS: Record<string, Entry> = {
  // TypeScript and JavaScript
  ts: K.typescript,
  mts: K.typescript,
  cts: K.typescript,
  tsx: K.react,
  jsx: K.react,
  js: K.javascript,
  mjs: K.javascript,
  cjs: K.javascript,
  'd.ts': K.declaration,
  'd.mts': K.declaration,
  'd.cts': K.declaration,
  'min.js': ['javascript.minified', FileCode, 'grey'],
  'min.mjs': ['javascript.minified', FileCode, 'grey'],
  'min.cjs': ['javascript.minified', FileCode, 'grey'],
  'min.css': ['css.minified', FileCode, 'grey'],
  'd.ts.map': ['sourcemap', FileCode, 'grey'],
  'ts.map': ['sourcemap', FileCode, 'grey'],
  'js.map': ['sourcemap', FileCode, 'grey'],
  'mjs.map': ['sourcemap', FileCode, 'grey'],
  'cjs.map': ['sourcemap', FileCode, 'grey'],
  'css.map': ['sourcemap', FileCode, 'grey'],
  map: ['sourcemap', FileCode, 'grey'],
  'test.ts': ['test.typescript', FlaskConical, 'blue'],
  'spec.ts': ['test.typescript', FlaskConical, 'blue'],
  'test.mts': ['test.typescript', FlaskConical, 'blue'],
  'spec.mts': ['test.typescript', FlaskConical, 'blue'],
  'test.cts': ['test.typescript', FlaskConical, 'blue'],
  'spec.cts': ['test.typescript', FlaskConical, 'blue'],
  'test.tsx': ['test.react', FlaskConical, 'sky'],
  'spec.tsx': ['test.react', FlaskConical, 'sky'],
  'test.js': ['test.javascript', FlaskConical, 'yellow'],
  'spec.js': ['test.javascript', FlaskConical, 'yellow'],
  'test.jsx': ['test.react', FlaskConical, 'sky'],
  'spec.jsx': ['test.react', FlaskConical, 'sky'],
  'test.mjs': ['test.javascript', FlaskConical, 'yellow'],
  'spec.mjs': ['test.javascript', FlaskConical, 'yellow'],
  'test.cjs': ['test.javascript', FlaskConical, 'yellow'],
  'spec.cjs': ['test.javascript', FlaskConical, 'yellow'],
  'stories.tsx': ['stories', FileCode, 'pink'],
  'stories.ts': ['stories', FileCode, 'pink'],
  'stories.jsx': ['stories', FileCode, 'pink'],
  'stories.js': ['stories', FileCode, 'pink'],
  vue: code('vue', 'green'),
  svelte: code('svelte', 'orange'),
  astro: code('astro', 'orange'),
  // Other languages
  go: K.go,
  rs: K.rust,
  py: K.python,
  pyi: K.python,
  pyw: K.python,
  pyx: K.python,
  rb: K.ruby,
  erb: K.ruby,
  rake: K.ruby,
  gemspec: K.rubyPackage,
  java: code('java', 'red'),
  kt: code('kotlin', 'purple'),
  kts: code('kotlin', 'purple'),
  scala: code('scala', 'red'),
  sc: code('scala', 'red'),
  groovy: code('groovy', 'teal'),
  gradle: K.javaPackage,
  c: code('c', 'blue'),
  h: code('c', 'blue'),
  cpp: code('cpp', 'purple'),
  cc: code('cpp', 'purple'),
  cxx: code('cpp', 'purple'),
  'c++': code('cpp', 'purple'),
  hpp: code('cpp', 'purple'),
  hh: code('cpp', 'purple'),
  hxx: code('cpp', 'purple'),
  ino: code('cpp', 'teal'),
  m: code('objective-c', 'blue'),
  mm: code('objective-c', 'purple'),
  cs: code('csharp', 'green'),
  csx: code('csharp', 'green'),
  fs: code('fsharp', 'sky'),
  fsx: code('fsharp', 'sky'),
  vb: code('visualbasic', 'blue'),
  swift: code('swift', 'orange'),
  dart: code('dart', 'sky'),
  lua: code('lua', 'blue'),
  php: code('php', 'purple'),
  pl: code('perl', 'blue'),
  pm: code('perl', 'blue'),
  r: code('r', 'blue'),
  jl: code('julia', 'purple'),
  ex: code('elixir', 'purple'),
  exs: code('elixir', 'purple'),
  erl: code('erlang', 'red'),
  hrl: code('erlang', 'red'),
  hs: code('haskell', 'purple'),
  ml: code('ocaml', 'orange'),
  mli: code('ocaml', 'orange'),
  clj: code('clojure', 'green'),
  cljs: code('clojure', 'green'),
  cljc: code('clojure', 'green'),
  elm: code('elm', 'sky'),
  zig: code('zig', 'orange'),
  nim: code('nim', 'yellow'),
  v: code('v', 'blue'),
  sol: code('solidity', 'grey'),
  asm: code('assembly', 'red'),
  s: code('assembly', 'red'),
  wat: code('webassembly', 'purple'),
  graphql: code('graphql', 'pink'),
  gql: code('graphql', 'pink'),
  proto: code('protobuf', 'teal'),
  tf: ['terraform', FileCog, 'purple'],
  tfvars: ['terraform', FileCog, 'purple'],
  hcl: ['terraform', FileCog, 'purple'],
  nix: ['nix', FileCog, 'sky'],
  // Shells
  sh: K.shell,
  bash: K.shell,
  zsh: K.shell,
  fish: K.shell,
  ksh: K.shell,
  csh: K.shell,
  tcsh: K.shell,
  command: K.shell,
  bat: K.shell,
  cmd: K.shell,
  ps1: K.powershell,
  psm1: K.powershell,
  psd1: K.powershell,
  // Markup and styles
  html: K.html,
  htm: K.html,
  xhtml: K.html,
  xml: K.xml,
  xsd: K.xml,
  xsl: K.xml,
  xslt: K.xml,
  plist: K.ini,
  css: K.css,
  scss: K.sass,
  sass: K.sass,
  less: code('less', 'blue'),
  styl: code('stylus', 'green'),
  md: K.markdown,
  markdown: K.markdown,
  mdx: ['mdx', FileText, 'yellow'],
  rst: K.markdown,
  adoc: K.markdown,
  asciidoc: K.markdown,
  org: K.markdown,
  tex: ['tex', FileText, 'green'],
  bib: ['tex', FileText, 'green'],
  txt: K.text,
  rtf: K.document,
  // Configuration and data
  json: K.json,
  jsonc: K.json,
  json5: K.json,
  jsonl: K.json,
  ndjson: K.json,
  geojson: K.json,
  yaml: K.yaml,
  yml: K.yaml,
  toml: K.toml,
  ini: K.ini,
  cfg: K.ini,
  conf: K.ini,
  properties: K.ini,
  env: K.env,
  csv: K.spreadsheet,
  tsv: K.spreadsheet,
  sql: K.sql,
  db: K.database,
  sqlite: K.database,
  sqlite3: K.database,
  db3: K.database,
  parquet: K.database,
  avro: K.database,
  arrow: K.database,
  feather: K.database,
  // Images, video and audio
  png: K.image,
  jpg: K.image,
  jpeg: K.image,
  gif: K.image,
  webp: K.image,
  avif: K.image,
  bmp: K.image,
  ico: K.image,
  icns: K.image,
  tif: K.image,
  tiff: K.image,
  heic: K.image,
  heif: K.image,
  psd: K.image,
  xcf: K.image,
  ai: K.image,
  raw: K.image,
  svg: K.svg,
  mp4: K.video,
  m4v: K.video,
  mov: K.video,
  mkv: K.video,
  webm: K.video,
  avi: K.video,
  wmv: K.video,
  flv: K.video,
  mpg: K.video,
  mpeg: K.video,
  mp3: K.audio,
  wav: K.audio,
  flac: K.audio,
  ogg: K.audio,
  oga: K.audio,
  opus: K.audio,
  m4a: K.audio,
  aac: K.audio,
  aiff: K.audio,
  wma: K.audio,
  mid: K.audio,
  midi: K.audio,
  // Archives, packages and disk images
  zip: K.archive,
  tar: K.archive,
  gz: K.archive,
  tgz: K.archive,
  bz2: K.archive,
  tbz2: K.archive,
  xz: K.archive,
  txz: K.archive,
  zst: K.archive,
  lz4: K.archive,
  '7z': K.archive,
  rar: K.archive,
  'tar.gz': K.archive,
  'tar.bz2': K.archive,
  'tar.xz': K.archive,
  'tar.zst': K.archive,
  'tar.lz4': K.archive,
  'tar.lz': K.archive,
  'tar.br': K.archive,
  jar: K.archive,
  war: K.archive,
  ear: K.archive,
  whl: K.archive,
  gem: K.archive,
  nupkg: K.archive,
  deb: K.package,
  rpm: K.package,
  apk: K.package,
  ipa: K.package,
  dmg: K.package,
  pkg: K.package,
  msi: K.package,
  snap: K.package,
  appimage: K.package,
  flatpak: K.package,
  iso: K.package,
  img: K.package,
  // Documents
  pdf: K.pdf,
  doc: K.document,
  docx: K.document,
  odt: K.document,
  pages: K.document,
  epub: K.document,
  xls: K.spreadsheet,
  xlsx: K.spreadsheet,
  ods: K.spreadsheet,
  numbers: K.spreadsheet,
  ppt: K.presentation,
  pptx: K.presentation,
  odp: K.presentation,
  key: K.key,
  // Fonts
  ttf: K.font,
  otf: K.font,
  woff: K.font,
  woff2: K.font,
  eot: K.font,
  // Certificates and keys
  pem: K.certificate,
  crt: K.certificate,
  cer: K.certificate,
  der: K.certificate,
  csr: K.certificate,
  p7b: K.certificate,
  pub: K.key,
  asc: K.key,
  gpg: K.key,
  pgp: K.key,
  sig: K.key,
  p12: K.key,
  pfx: K.key,
  jks: K.key,
  keystore: K.key,
  kdbx: K.key,
  // Logs, notebooks, diffs, locks
  log: K.log,
  ipynb: K.notebook,
  diff: K.diff,
  patch: K.diff,
  lock: K.lock,
  // Binaries
  exe: K.binary,
  dll: K.binary,
  so: K.binary,
  dylib: K.binary,
  a: K.binary,
  lib: K.binary,
  o: K.binary,
  obj: K.binary,
  bin: K.binary,
  elf: K.binary,
  class: K.binary,
  pyc: K.binary,
  pyo: K.binary,
  wasm: ['webassembly', FileDigit, 'purple'],
  // Build files
  mk: K.make,
  mak: K.make,
  cmake: K.cmake,
  bzl: K.build,
  dockerfile: K.docker,
  containerfile: K.docker,
};

/** Folders by name (lower case). */
const FOLDERS: Record<string, Entry> = {
  '.git': ['folder.git', FolderGit2, 'orange'],
  '.github': ['folder.github', FolderGit, 'purple'],
  '.gitlab': ['folder.gitlab', FolderGit, 'orange'],
  '.circleci': ['folder.ci', FolderCog, 'grey'],
  '.vscode': ['folder.vscode', FolderCog, 'blue'],
  '.idea': ['folder.idea', FolderCog, 'grey'],
  '.devcontainer': ['folder.devcontainer', FolderCog, 'blue'],
  '.config': ['folder.config', FolderCog, 'grey'],
  config: ['folder.config', FolderCog, 'grey'],
  configs: ['folder.config', FolderCog, 'grey'],
  node_modules: ['folder.dependencies', FolderArchive, 'green'],
  bower_components: ['folder.dependencies', FolderArchive, 'green'],
  vendor: ['folder.dependencies', FolderArchive, 'brown'],
  '.venv': ['folder.dependencies', FolderArchive, 'blue'],
  venv: ['folder.dependencies', FolderArchive, 'blue'],
  src: ['folder.src', FolderCode, 'teal'],
  source: ['folder.src', FolderCode, 'teal'],
  sources: ['folder.src', FolderCode, 'teal'],
  lib: ['folder.lib', FolderCode, 'sky'],
  libs: ['folder.lib', FolderCode, 'sky'],
  pkg: ['folder.lib', FolderCode, 'sky'],
  internal: ['folder.lib', FolderCode, 'sky'],
  cmd: ['folder.lib', FolderCode, 'sky'],
  app: ['folder.lib', FolderCode, 'sky'],
  test: ['folder.test', FolderCheck, 'green'],
  tests: ['folder.test', FolderCheck, 'green'],
  __tests__: ['folder.test', FolderCheck, 'green'],
  spec: ['folder.test', FolderCheck, 'green'],
  specs: ['folder.test', FolderCheck, 'green'],
  e2e: ['folder.test', FolderCheck, 'green'],
  testdata: ['folder.test', FolderCheck, 'green'],
  fixtures: ['folder.test', FolderCheck, 'green'],
  __mocks__: ['folder.test', FolderCheck, 'green'],
  docs: ['folder.docs', FolderBookmark, 'blue'],
  doc: ['folder.docs', FolderBookmark, 'blue'],
  documentation: ['folder.docs', FolderBookmark, 'blue'],
  wiki: ['folder.docs', FolderBookmark, 'blue'],
  dist: ['folder.dist', FolderOutput, 'orange'],
  build: ['folder.dist', FolderOutput, 'orange'],
  out: ['folder.dist', FolderOutput, 'orange'],
  output: ['folder.dist', FolderOutput, 'orange'],
  target: ['folder.dist', FolderOutput, 'orange'],
  release: ['folder.dist', FolderOutput, 'orange'],
  bin: ['folder.dist', FolderOutput, 'orange'],
  '.next': ['folder.dist', FolderOutput, 'orange'],
  '.nuxt': ['folder.dist', FolderOutput, 'orange'],
  coverage: ['folder.dist', FolderOutput, 'orange'],
  scripts: ['folder.scripts', FolderCog, 'yellow'],
  script: ['folder.scripts', FolderCog, 'yellow'],
  tools: ['folder.scripts', FolderCog, 'yellow'],
  hack: ['folder.scripts', FolderCog, 'yellow'],
  public: ['folder.assets', FolderHeart, 'purple'],
  assets: ['folder.assets', FolderHeart, 'purple'],
  static: ['folder.assets', FolderHeart, 'purple'],
  images: ['folder.assets', FolderHeart, 'purple'],
  img: ['folder.assets', FolderHeart, 'purple'],
  icons: ['folder.assets', FolderHeart, 'purple'],
  media: ['folder.assets', FolderHeart, 'purple'],
  resources: ['folder.assets', FolderHeart, 'purple'],
  '.ssh': ['folder.keys', FolderKey, 'yellow'],
  '.gnupg': ['folder.keys', FolderKey, 'yellow'],
  certs: ['folder.keys', FolderKey, 'yellow'],
  keys: ['folder.keys', FolderKey, 'yellow'],
  secrets: ['folder.keys', FolderKey, 'yellow'],
  '.cache': ['folder.cache', FolderClock, 'grey'],
  cache: ['folder.cache', FolderClock, 'grey'],
  tmp: ['folder.cache', FolderClock, 'grey'],
  temp: ['folder.cache', FolderClock, 'grey'],
  __pycache__: ['folder.cache', FolderClock, 'grey'],
};

const FILE: Entry = ['file', File];
const FOLDER: Entry = ['folder', Folder];
const DOT_FOLDER: Entry = ['folder.hidden', FolderDot, 'grey'];

/** Map-backed tables avoid Object.prototype collisions (constructor, toString, ...). */
const NAME_MAP = new Map<string, Entry>(Object.entries(NAMES));
const EXT_MAP = new Map<string, Entry>(Object.entries(EXTENSIONS));
const FOLDER_MAP = new Map<string, Entry>(Object.entries(FOLDERS));

/** Normalizes a filename or path to its lower-case basename. */
function baseLower(name: string): string {
  const trimmed = name.trim().replace(/[\\/]+$/, '');
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase();
}

/** The icon of a file or folder named name; open folders get the open
 * folder's shape in their color. */
export function fileIcon(name: string, kind: 'file' | 'dir', open = false): FileIconDef {
  const n = baseLower(name);
  if (kind === 'dir') {
    const e = FOLDER_MAP.get(n) ?? (n.startsWith('.') && n.length > 1 && n !== '..' ? DOT_FOLDER : FOLDER);
    return open ? { id: e[0], icon: FolderOpen, color: e[2] } : def(e);
  }
  if (!n) return def(FILE);
  const named = NAME_MAP.get(n) ?? PREFIXES.find(([match]) => match(n))?.[1];
  if (named) return def(named);
  // Extensions from the longest: a.test.ts tries test.ts, then ts. Skip any
  // leading dot run so dotfiles like .hidden or .json are not treated as bare
  // extensions, while .foo.json and .foo.test.ts still resolve their extensions.
  let start = 0;
  while (start < n.length && n[start] === '.') start++;
  for (let i = n.indexOf('.', start + 1); i >= 0; i = n.indexOf('.', i + 1)) {
    const ext = n.slice(i + 1);
    if (!ext) break;
    const e = EXT_MAP.get(ext);
    if (e) return def(e);
  }
  return def(FILE);
}

export interface FileIconProps {
  name: string;
  kind: 'file' | 'dir';
  /** An expanded folder. */
  open?: boolean;
  /** A symbolic link: lucide's link icon of its kind, in its type's color. */
  link?: boolean;
  className?: string;
}

/** A file's or folder's icon, sized and placed by className (.file-icon
 * is the row icon's size). */
export function FileIcon({ name, kind, open, link, className }: FileIconProps) {
  const d = fileIcon(name, kind, open);
  const Icon = link ? (kind === 'dir' ? FolderSymlink : FileSymlink) : d.icon;
  return (
    <Icon
      className={`file-icon ${className ?? ''}`}
      data-icon={d.id}
      style={d.color ? { color: `var(--ds-file-icon-${d.color})` } : undefined}
      aria-hidden={link ? undefined : true}
      aria-label={link ? t('fileIcon.link') : undefined}
      role={link ? 'img' : undefined}
    />
  );
}
