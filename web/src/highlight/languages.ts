// The languages code is colored in, and which one a file is in. A language
// has an id: Monaco's where Monaco knows the language (its configuration of
// brackets and comments, and for some a language service, stay in use),
// else the name of its grammar. Grammars are Shiki's (TextMate grammars, as
// VS Code's), each a chunk of its own that loads when a file or a code
// block of that language is first shown.

import type { LanguageRegistration } from 'shiki/core';
import { ignoreGrammar } from './grammars';

/** A grammar's module (`import('@shikijs/langs/<name>')`): the grammar and
 * those it embeds. */
export type GrammarModule = { default: LanguageRegistration[] };

export interface Lang {
  /** The id: Monaco's own where `monaco` is set, else the grammar's name. */
  id: string;
  /** The grammar's name in Shiki, when it differs from the id. */
  shiki?: string;
  grammar: () => Promise<GrammarModule>;
  /** Monaco registers this id itself (monaco-editor's languages). */
  monaco?: true;
  /** Monaco colors this language itself in the editor: JSON, whose
   * language service brings its own tokenizer. */
  ownTokens?: true;
  /** For ids Monaco lacks: the line comment, or the block comment's two
   * ends, of the language (the editor's toggle-comment commands). */
  comment?: string | [string, string];
  /** File names that are of this language whatever their extension,
   * lower case (`makefile`, `.gitignore`). */
  names?: string[];
  /** A file whose lower-case name starts with one of these, followed by
   * `.` or `-`, is of this language (`dockerfile` for `Dockerfile.dev`). */
  prefixes?: string[];
  /** Extensions without the dot, lower case. */
  extensions?: string[];
  /** Programs of a `#!` line (`bash`, `python3`); a trailing version
   * number of the program is ignored. */
  interpreters?: string[];
  /** Other names of the language in a Markdown fence (`sh`, `yml`). */
  aliases?: string[];
}

export const LANGS: Lang[] = [
  {
    id: 'typescript',
    grammar: () => import('@shikijs/langs/typescript'),
    monaco: true,
    extensions: ['ts', 'mts', 'cts'],
    interpreters: ['ts-node', 'tsx'],
    aliases: ['ts'],
  },
  {
    id: 'tsx',
    grammar: () => import('@shikijs/langs/tsx'),
    comment: '//',
    extensions: ['tsx'],
  },
  {
    id: 'javascript',
    grammar: () => import('@shikijs/langs/javascript'),
    monaco: true,
    extensions: ['js', 'mjs', 'cjs', 'es6', 'jsm'],
    interpreters: ['node', 'nodejs', 'deno', 'bun'],
    aliases: ['js', 'node'],
  },
  {
    id: 'jsx',
    grammar: () => import('@shikijs/langs/jsx'),
    comment: '//',
    extensions: ['jsx'],
  },
  {
    id: 'json',
    grammar: () => import('@shikijs/langs/json'),
    monaco: true,
    ownTokens: true,
    names: ['.prettierrc', 'composer.lock'],
    extensions: ['json', 'map', 'webmanifest', 'geojson', 'har', 'ipynb', 'jsonld', 'avsc'],
  },
  {
    id: 'jsonc',
    grammar: () => import('@shikijs/langs/jsonc'),
    comment: '//',
    names: ['tsconfig.json', 'jsconfig.json', 'devcontainer.json', '.devcontainer.json', '.eslintrc', '.babelrc', '.swcrc', '.jshintrc'],
    extensions: ['jsonc', 'code-workspace', 'code-snippets'],
  },
  {
    id: 'json5',
    grammar: () => import('@shikijs/langs/json5'),
    comment: '//',
    extensions: ['json5'],
  },
  {
    id: 'jsonl',
    grammar: () => import('@shikijs/langs/jsonl'),
    extensions: ['jsonl', 'ndjson'],
    aliases: ['ndjson'],
  },
  {
    id: 'html',
    grammar: () => import('@shikijs/langs/html'),
    monaco: true,
    extensions: ['html', 'htm', 'xhtml', 'shtml'],
    aliases: ['htm'],
  },
  {
    id: 'css',
    grammar: () => import('@shikijs/langs/css'),
    monaco: true,
    extensions: ['css'],
  },
  {
    id: 'scss',
    grammar: () => import('@shikijs/langs/scss'),
    monaco: true,
    extensions: ['scss'],
  },
  {
    id: 'less',
    grammar: () => import('@shikijs/langs/less'),
    monaco: true,
    extensions: ['less'],
  },
  {
    id: 'sass',
    grammar: () => import('@shikijs/langs/sass'),
    comment: '//',
    extensions: ['sass'],
  },
  {
    id: 'markdown',
    grammar: () => import('@shikijs/langs/markdown'),
    monaco: true,
    extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn'],
    aliases: ['md'],
  },
  {
    id: 'mdx',
    grammar: () => import('@shikijs/langs/mdx'),
    monaco: true,
    extensions: ['mdx'],
  },
  {
    id: 'yaml',
    grammar: () => import('@shikijs/langs/yaml'),
    monaco: true,
    names: ['.clang-format', '.clang-tidy', '.yamllint'],
    extensions: ['yaml', 'yml'],
    aliases: ['yml'],
  },
  {
    id: 'toml',
    grammar: () => import('@shikijs/langs/toml'),
    comment: '#',
    names: ['cargo.lock', 'poetry.lock', 'pipfile'],
    extensions: ['toml'],
  },
  {
    id: 'xml',
    grammar: () => import('@shikijs/langs/xml'),
    monaco: true,
    extensions: [
      'xml',
      'xsd',
      'xsl',
      'xslt',
      'svg',
      'plist',
      'xaml',
      'csproj',
      'fsproj',
      'vbproj',
      'props',
      'targets',
      'rss',
      'atom',
      'wsdl',
      'xliff',
      'resx',
    ],
  },
  {
    id: 'ini',
    grammar: () => import('@shikijs/langs/ini'),
    monaco: true,
    names: ['.gitconfig', '.gitmodules', '.editorconfig', '.npmrc', '.pylintrc', '.flake8', '.hgrc'],
    extensions: ['ini', 'cfg', 'inf', 'properties', 'prefs'],
    aliases: ['properties'],
  },
  {
    id: 'dotenv',
    grammar: () => import('@shikijs/langs/dotenv'),
    comment: '#',
    names: ['.env'],
    prefixes: ['.env'],
    extensions: ['env'],
    aliases: ['env'],
  },
  {
    id: 'shell',
    shiki: 'shellscript',
    grammar: () => import('@shikijs/langs/shellscript'),
    monaco: true,
    names: [
      '.bashrc',
      '.zshrc',
      '.profile',
      '.bash_profile',
      '.zprofile',
      '.zshenv',
      '.zlogin',
      '.zlogout',
      '.bash_aliases',
      '.bash_logout',
      '.bash_login',
      '.kshrc',
      '.envrc',
      '.xinitrc',
      '.xprofile',
      'pkgbuild',
    ],
    extensions: ['sh', 'bash', 'zsh', 'ksh', 'command', 'ebuild'],
    interpreters: ['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash'],
    aliases: ['sh', 'bash', 'zsh'],
  },
  {
    id: 'fish',
    grammar: () => import('@shikijs/langs/fish'),
    comment: '#',
    extensions: ['fish'],
    interpreters: ['fish'],
  },
  {
    id: 'powershell',
    grammar: () => import('@shikijs/langs/powershell'),
    monaco: true,
    extensions: ['ps1', 'psm1', 'psd1', 'ps1xml'],
    interpreters: ['pwsh', 'powershell'],
    aliases: ['ps1', 'pwsh'],
  },
  {
    id: 'bat',
    grammar: () => import('@shikijs/langs/bat'),
    monaco: true,
    extensions: ['bat', 'cmd'],
    aliases: ['batch', 'cmd'],
  },
  {
    id: 'python',
    grammar: () => import('@shikijs/langs/python'),
    monaco: true,
    names: ['sconstruct', 'sconscript'],
    extensions: ['py', 'pyw', 'pyi', 'pyz'],
    interpreters: ['python'],
    aliases: ['py'],
  },
  {
    id: 'ruby',
    grammar: () => import('@shikijs/langs/ruby'),
    monaco: true,
    names: ['gemfile', 'rakefile', 'guardfile', 'vagrantfile', 'podfile', 'brewfile', 'capfile'],
    extensions: ['rb', 'rake', 'gemspec', 'ru', 'podspec', 'jbuilder'],
    interpreters: ['ruby'],
    aliases: ['rb'],
  },
  {
    id: 'php',
    grammar: () => import('@shikijs/langs/php'),
    monaco: true,
    extensions: ['php', 'php3', 'php4', 'php5', 'phtml'],
    interpreters: ['php'],
  },
  {
    id: 'perl',
    grammar: () => import('@shikijs/langs/perl'),
    monaco: true,
    extensions: ['pl', 'pm', 't'],
    interpreters: ['perl'],
    aliases: ['pl'],
  },
  {
    id: 'lua',
    grammar: () => import('@shikijs/langs/lua'),
    monaco: true,
    extensions: ['lua'],
    interpreters: ['lua', 'luajit'],
  },
  {
    id: 'r',
    grammar: () => import('@shikijs/langs/r'),
    monaco: true,
    extensions: ['r', 'rmd'],
    interpreters: ['rscript'],
  },
  {
    id: 'julia',
    grammar: () => import('@shikijs/langs/julia'),
    monaco: true,
    extensions: ['jl'],
    interpreters: ['julia'],
    aliases: ['jl'],
  },
  {
    id: 'go',
    grammar: () => import('@shikijs/langs/go'),
    monaco: true,
    extensions: ['go'],
    aliases: ['golang'],
  },
  {
    id: 'rust',
    grammar: () => import('@shikijs/langs/rust'),
    monaco: true,
    extensions: ['rs'],
    aliases: ['rs'],
  },
  {
    id: 'c',
    grammar: () => import('@shikijs/langs/c'),
    monaco: true,
    extensions: ['c', 'h'],
  },
  {
    id: 'cpp',
    grammar: () => import('@shikijs/langs/cpp'),
    monaco: true,
    extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'c++', 'h++', 'ino', 'tpp', 'ipp'],
    aliases: ['c++', 'cxx'],
  },
  {
    id: 'csharp',
    grammar: () => import('@shikijs/langs/csharp'),
    monaco: true,
    extensions: ['cs', 'csx'],
    aliases: ['cs', 'c#', 'dotnet'],
  },
  {
    id: 'java',
    grammar: () => import('@shikijs/langs/java'),
    monaco: true,
    extensions: ['java'],
  },
  {
    id: 'kotlin',
    grammar: () => import('@shikijs/langs/kotlin'),
    monaco: true,
    extensions: ['kt', 'kts'],
    aliases: ['kt'],
  },
  {
    id: 'scala',
    grammar: () => import('@shikijs/langs/scala'),
    monaco: true,
    extensions: ['scala', 'sbt', 'sc'],
  },
  {
    id: 'swift',
    grammar: () => import('@shikijs/langs/swift'),
    monaco: true,
    extensions: ['swift'],
  },
  {
    id: 'objective-c',
    grammar: () => import('@shikijs/langs/objective-c'),
    monaco: true,
    extensions: ['m'],
    aliases: ['objc', 'objectivec'],
  },
  {
    id: 'objective-cpp',
    grammar: () => import('@shikijs/langs/objective-cpp'),
    comment: '//',
    extensions: ['mm'],
    aliases: ['objcpp'],
  },
  {
    id: 'dart',
    grammar: () => import('@shikijs/langs/dart'),
    monaco: true,
    extensions: ['dart'],
  },
  {
    id: 'zig',
    grammar: () => import('@shikijs/langs/zig'),
    comment: '//',
    extensions: ['zig', 'zon'],
  },
  {
    id: 'nim',
    grammar: () => import('@shikijs/langs/nim'),
    comment: '#',
    extensions: ['nim', 'nims', 'nimble'],
  },
  {
    id: 'haskell',
    grammar: () => import('@shikijs/langs/haskell'),
    comment: '--',
    extensions: ['hs', 'lhs'],
    interpreters: ['runhaskell', 'runghc'],
    aliases: ['hs'],
  },
  {
    id: 'ocaml',
    grammar: () => import('@shikijs/langs/ocaml'),
    comment: ['(*', '*)'],
    extensions: ['ml', 'mli'],
    interpreters: ['ocaml'],
    aliases: ['ml'],
  },
  {
    id: 'elixir',
    grammar: () => import('@shikijs/langs/elixir'),
    monaco: true,
    extensions: ['ex', 'exs'],
    interpreters: ['elixir'],
    aliases: ['ex'],
  },
  {
    id: 'erlang',
    grammar: () => import('@shikijs/langs/erlang'),
    comment: '%',
    extensions: ['erl', 'hrl'],
    interpreters: ['escript'],
    aliases: ['erl'],
  },
  {
    id: 'clojure',
    grammar: () => import('@shikijs/langs/clojure'),
    monaco: true,
    extensions: ['clj', 'cljs', 'cljc', 'edn'],
    aliases: ['clj'],
  },
  {
    id: 'fsharp',
    grammar: () => import('@shikijs/langs/fsharp'),
    monaco: true,
    extensions: ['fs', 'fsi', 'fsx', 'fsscript'],
    aliases: ['fs', 'f#'],
  },
  {
    id: 'vb',
    grammar: () => import('@shikijs/langs/vb'),
    monaco: true,
    extensions: ['vb'],
    aliases: ['vbnet'],
  },
  {
    id: 'pascal',
    grammar: () => import('@shikijs/langs/pascal'),
    monaco: true,
    extensions: ['pas', 'dpr', 'lpr'],
  },
  {
    id: 'sql',
    grammar: () => import('@shikijs/langs/sql'),
    monaco: true,
    extensions: ['sql'],
  },
  {
    id: 'graphql',
    grammar: () => import('@shikijs/langs/graphql'),
    monaco: true,
    extensions: ['graphql', 'gql', 'graphqls'],
    aliases: ['gql'],
  },
  {
    id: 'proto',
    grammar: () => import('@shikijs/langs/proto'),
    monaco: true,
    extensions: ['proto'],
    aliases: ['protobuf'],
  },
  {
    id: 'dockerfile',
    shiki: 'docker',
    grammar: () => import('@shikijs/langs/docker'),
    monaco: true,
    names: ['dockerfile', 'containerfile'],
    prefixes: ['dockerfile', 'containerfile'],
    extensions: ['dockerfile', 'containerfile'],
  },
  {
    id: 'cmake',
    grammar: () => import('@shikijs/langs/cmake'),
    comment: '#',
    names: ['cmakelists.txt', 'cmakecache.txt'],
    extensions: ['cmake'],
  },
  {
    id: 'nginx',
    grammar: () => import('@shikijs/langs/nginx'),
    comment: '#',
    names: ['nginx.conf'],
    extensions: ['nginx', 'nginxconf'],
  },
  {
    id: 'apache',
    grammar: () => import('@shikijs/langs/apache'),
    comment: '#',
    names: ['.htaccess', 'httpd.conf', 'apache2.conf', 'envvars'],
    extensions: ['htaccess'],
    aliases: ['htaccess'],
  },
  {
    id: 'hcl',
    grammar: () => import('@shikijs/langs/hcl'),
    monaco: true,
    extensions: ['hcl', 'nomad'],
  },
  {
    id: 'terraform',
    grammar: () => import('@shikijs/langs/terraform'),
    comment: '#',
    extensions: ['tf', 'tfvars'],
    aliases: ['tf'],
  },
  {
    id: 'nix',
    grammar: () => import('@shikijs/langs/nix'),
    comment: '#',
    extensions: ['nix'],
  },
  {
    id: 'diff',
    grammar: () => import('@shikijs/langs/diff'),
    extensions: ['diff', 'patch'],
    aliases: ['patch'],
  },
  {
    id: 'git-commit',
    grammar: () => import('@shikijs/langs/git-commit'),
    comment: '#',
    names: ['commit_editmsg', 'merge_msg', 'tag_editmsg', 'squash_msg'],
  },
  {
    id: 'git-rebase',
    grammar: () => import('@shikijs/langs/git-rebase'),
    comment: '#',
    names: ['git-rebase-todo'],
  },
  {
    id: 'ssh-config',
    grammar: () => import('@shikijs/langs/ssh-config'),
    comment: '#',
    names: ['ssh_config', 'sshd_config'],
    aliases: ['ssh'],
  },
  {
    id: 'systemd',
    grammar: () => import('@shikijs/langs/systemd'),
    comment: '#',
    extensions: ['service', 'socket', 'timer', 'mount', 'automount', 'slice', 'scope', 'swap', 'target'],
  },
  {
    id: 'desktop',
    grammar: () => import('@shikijs/langs/desktop'),
    comment: '#',
    extensions: ['desktop'],
  },
  {
    id: 'latex',
    grammar: () => import('@shikijs/langs/latex'),
    comment: '%',
    extensions: ['tex', 'ltx', 'sty', 'cls', 'dtx'],
  },
  {
    id: 'tex',
    grammar: () => import('@shikijs/langs/tex'),
    comment: '%',
  },
  {
    id: 'bibtex',
    grammar: () => import('@shikijs/langs/bibtex'),
    comment: '%',
    extensions: ['bib'],
    aliases: ['bib'],
  },
  {
    id: 'vue',
    grammar: () => import('@shikijs/langs/vue'),
    comment: ['<!--', '-->'],
    extensions: ['vue'],
  },
  {
    id: 'svelte',
    grammar: () => import('@shikijs/langs/svelte'),
    comment: ['<!--', '-->'],
    extensions: ['svelte'],
  },
  {
    id: 'astro',
    grammar: () => import('@shikijs/langs/astro'),
    comment: ['<!--', '-->'],
    extensions: ['astro'],
  },
  {
    id: 'handlebars',
    grammar: () => import('@shikijs/langs/handlebars'),
    monaco: true,
    extensions: ['hbs', 'handlebars'],
    aliases: ['hbs'],
  },
  {
    id: 'pug',
    grammar: () => import('@shikijs/langs/pug'),
    monaco: true,
    extensions: ['pug', 'jade'],
    aliases: ['jade'],
  },
  {
    id: 'twig',
    grammar: () => import('@shikijs/langs/twig'),
    monaco: true,
    extensions: ['twig'],
  },
  {
    id: 'liquid',
    grammar: () => import('@shikijs/langs/liquid'),
    monaco: true,
    extensions: ['liquid'],
  },
  {
    id: 'jinja',
    grammar: () => import('@shikijs/langs/jinja'),
    comment: ['{#', '#}'],
    extensions: ['j2', 'jinja', 'jinja2'],
    aliases: ['j2'],
  },
  {
    id: 'erb',
    grammar: () => import('@shikijs/langs/erb'),
    comment: ['<!--', '-->'],
    extensions: ['erb', 'rhtml'],
  },
  {
    id: 'haml',
    grammar: () => import('@shikijs/langs/haml'),
    comment: '-#',
    extensions: ['haml'],
  },
  {
    id: 'sol',
    shiki: 'solidity',
    grammar: () => import('@shikijs/langs/solidity'),
    monaco: true,
    extensions: ['sol'],
  },
  {
    id: 'wgsl',
    grammar: () => import('@shikijs/langs/wgsl'),
    monaco: true,
    extensions: ['wgsl'],
  },
  {
    id: 'glsl',
    grammar: () => import('@shikijs/langs/glsl'),
    comment: '//',
    extensions: ['glsl', 'vert', 'frag', 'geom', 'tesc', 'tese', 'comp'],
  },
  {
    id: 'hlsl',
    grammar: () => import('@shikijs/langs/hlsl'),
    comment: '//',
    extensions: ['hlsl', 'fx', 'fxh', 'hlsli'],
  },
  {
    id: 'asm',
    grammar: () => import('@shikijs/langs/asm'),
    comment: ';',
    extensions: ['asm', 'nasm', 'masm'],
    aliases: ['nasm'],
  },
  {
    id: 'llvm',
    grammar: () => import('@shikijs/langs/llvm'),
    comment: ';',
    extensions: ['ll'],
  },
  {
    id: 'wasm',
    grammar: () => import('@shikijs/langs/wasm'),
    comment: ';;',
    extensions: ['wat', 'wast'],
    aliases: ['wat'],
  },
  {
    id: 'prisma',
    grammar: () => import('@shikijs/langs/prisma'),
    comment: '//',
    extensions: ['prisma'],
  },
  {
    id: 'kdl',
    grammar: () => import('@shikijs/langs/kdl'),
    comment: '//',
    extensions: ['kdl'],
  },
  {
    id: 'csv',
    grammar: () => import('@shikijs/langs/csv'),
    extensions: ['csv'],
  },
  {
    id: 'tsv',
    grammar: () => import('@shikijs/langs/tsv'),
    extensions: ['tsv', 'tab'],
  },
  {
    id: 'log',
    grammar: () => import('@shikijs/langs/log'),
    extensions: ['log'],
  },
  {
    id: 'http',
    grammar: () => import('@shikijs/langs/http'),
    comment: '#',
    extensions: ['http', 'rest'],
  },
  {
    id: 'viml',
    grammar: () => import('@shikijs/langs/viml'),
    comment: '"',
    names: ['.vimrc', '_vimrc', '.gvimrc', '_gvimrc'],
    extensions: ['vim'],
    aliases: ['vim', 'vimscript'],
  },
  {
    id: 'common-lisp',
    grammar: () => import('@shikijs/langs/common-lisp'),
    comment: ';',
    extensions: ['lisp', 'lsp', 'cl', 'asd'],
    interpreters: ['sbcl'],
    aliases: ['lisp', 'cl'],
  },
  {
    id: 'scheme',
    grammar: () => import('@shikijs/langs/scheme'),
    monaco: true,
    extensions: ['scm', 'ss', 'sld'],
    interpreters: ['guile'],
    aliases: ['scm'],
  },
  {
    id: 'racket',
    grammar: () => import('@shikijs/langs/racket'),
    comment: ';',
    extensions: ['rkt'],
    interpreters: ['racket'],
    aliases: ['rkt'],
  },
  {
    id: 'tcl',
    grammar: () => import('@shikijs/langs/tcl'),
    monaco: true,
    extensions: ['tcl', 'tk'],
    interpreters: ['tclsh', 'wish', 'expect'],
  },
  {
    id: 'awk',
    grammar: () => import('@shikijs/langs/awk'),
    comment: '#',
    extensions: ['awk'],
    interpreters: ['awk', 'gawk', 'mawk', 'nawk'],
  },
  {
    id: 'groovy',
    grammar: () => import('@shikijs/langs/groovy'),
    comment: '//',
    names: ['jenkinsfile'],
    prefixes: ['jenkinsfile'],
    extensions: ['groovy', 'gradle', 'gvy'],
    interpreters: ['groovy'],
  },
  {
    id: 'gleam',
    grammar: () => import('@shikijs/langs/gleam'),
    comment: '//',
    extensions: ['gleam'],
  },
  {
    id: 'crystal',
    grammar: () => import('@shikijs/langs/crystal'),
    comment: '#',
    extensions: ['cr'],
    aliases: ['cr'],
  },
  {
    id: 'd',
    grammar: () => import('@shikijs/langs/d'),
    comment: '//',
    extensions: ['d'],
    aliases: ['dlang'],
  },
  {
    id: 'v',
    grammar: () => import('@shikijs/langs/v'),
    comment: '//',
    extensions: ['vv'],
    aliases: ['vlang'],
  },
  {
    id: 'vala',
    grammar: () => import('@shikijs/langs/vala'),
    comment: '//',
    extensions: ['vala', 'vapi'],
  },
  {
    id: 'verilog',
    grammar: () => import('@shikijs/langs/verilog'),
    monaco: true,
    extensions: ['v', 'vh'],
  },
  {
    id: 'systemverilog',
    shiki: 'system-verilog',
    grammar: () => import('@shikijs/langs/system-verilog'),
    monaco: true,
    extensions: ['sv', 'svh'],
  },
  {
    id: 'vhdl',
    grammar: () => import('@shikijs/langs/vhdl'),
    comment: '--',
    extensions: ['vhd', 'vhdl'],
  },
  {
    id: 'matlab',
    grammar: () => import('@shikijs/langs/matlab'),
    comment: '%',
    aliases: ['octave'],
  },
  {
    id: 'fortran-free-form',
    grammar: () => import('@shikijs/langs/fortran-free-form'),
    comment: '!',
    extensions: ['f90', 'f95', 'f03', 'f08', 'f18'],
    aliases: ['fortran', 'f90'],
  },
  {
    id: 'ada',
    grammar: () => import('@shikijs/langs/ada'),
    comment: '--',
    extensions: ['adb', 'ads', 'ada'],
  },
  {
    id: 'typst',
    grammar: () => import('@shikijs/langs/typst'),
    comment: '//',
    extensions: ['typ'],
  },
  {
    id: 'restructuredtext',
    shiki: 'rst',
    grammar: () => import('@shikijs/langs/rst'),
    monaco: true,
    extensions: ['rst'],
    aliases: ['rst'],
  },
  {
    id: 'asciidoc',
    grammar: () => import('@shikijs/langs/asciidoc'),
    comment: '//',
    extensions: ['adoc', 'asciidoc', 'asc'],
    aliases: ['adoc'],
  },
  {
    id: 'org',
    grammar: () => import('@shikijs/langs/org'),
    comment: '#',
    extensions: ['org'],
  },
  {
    id: 'mermaid',
    grammar: () => import('@shikijs/langs/mermaid'),
    comment: '%%',
    extensions: ['mmd', 'mermaid'],
    aliases: ['mmd'],
  },
  {
    id: 'puppet',
    grammar: () => import('@shikijs/langs/puppet'),
    comment: '#',
    extensions: ['pp'],
  },
  {
    id: 'just',
    grammar: () => import('@shikijs/langs/just'),
    comment: '#',
    names: ['justfile', '.justfile'],
    extensions: ['just'],
  },
  {
    id: 'codeowners',
    grammar: () => import('@shikijs/langs/codeowners'),
    comment: '#',
    names: ['codeowners'],
  },
  {
    id: 'jsonnet',
    grammar: () => import('@shikijs/langs/jsonnet'),
    comment: '//',
    extensions: ['jsonnet', 'libsonnet'],
  },
  {
    id: 'cue',
    grammar: () => import('@shikijs/langs/cue'),
    comment: '//',
    extensions: ['cue'],
  },
  {
    id: 'bicep',
    grammar: () => import('@shikijs/langs/bicep'),
    monaco: true,
    extensions: ['bicep', 'bicepparam'],
  },
  {
    id: 'typespec',
    grammar: () => import('@shikijs/langs/typespec'),
    monaco: true,
    extensions: ['tsp'],
  },
  {
    id: 'makefile',
    shiki: 'make',
    grammar: () => import('@shikijs/langs/make'),
    comment: '#',
    names: ['makefile', 'gnumakefile'],
    prefixes: ['makefile'],
    extensions: ['mk', 'mak'],
    aliases: ['make'],
  },
  {
    id: 'ignore',
    grammar: async () => ({ default: [ignoreGrammar] }),
    comment: '#',
    names: [
      '.gitignore',
      '.dockerignore',
      '.npmignore',
      '.eslintignore',
      '.prettierignore',
      '.hgignore',
      '.ignore',
      '.rgignore',
      '.fdignore',
    ],
  },
];

const byId = new Map(LANGS.map((l) => [l.id, l]));

/** The language of id, if it is one of ours. */
export function langOf(id: string | undefined): Lang | undefined {
  return id ? byId.get(id) : undefined;
}

const lower = (s: string) => s.toLowerCase();

/** One lookup per kind of key, built once. A key two languages claimed
 * would silently go to the first, which the tests rule out. */
function index(keys: (l: Lang) => string[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of LANGS) for (const k of keys(l) ?? []) if (!m.has(k)) m.set(k, l.id);
  return m;
}

const byName = index((l) => l.names);
const byPrefix = index((l) => l.prefixes);
const byExtension = index((l) => l.extensions);
const byInterpreter = index((l) => l.interpreters);
const prefixes = [...byPrefix.keys()];
// Ids and grammar names before aliases before extensions: `tex` is the
// language of that name though `.tex` files are LaTeX.
const aliasMaps = [index((l) => [l.id, l.shiki].filter((x): x is string => !!x)), index((l) => l.aliases), byExtension];

/** Endings that say a file is a copy of another kind of file
 * (`Makefile.in`, `config.yaml.example`). */
const COPY_ENDINGS = ['.in', '.example', '.sample', '.template', '.tmpl', '.dist', '.bak', '.orig'];

function byFileName(base: string): string | undefined {
  const exact = byName.get(base);
  if (exact) return exact;
  for (const p of prefixes) {
    if (base.length > p.length && base.startsWith(p) && (base[p.length] === '.' || base[p.length] === '-')) return byPrefix.get(p);
  }
  // A dotfile without another dot (`.bashrc`) has a name, no extension.
  const dot = base.lastIndexOf('.');
  if (dot > 0) return byExtension.get(base.slice(dot + 1));
  return undefined;
}

/** The program a `#!` line starts (`#!/usr/bin/env -S node --flag`: node). */
function interpreterOf(firstLine: string): string | undefined {
  if (!firstLine.startsWith('#!')) return undefined;
  const words = firstLine.slice(2).trim().split(/\s+/);
  const base = (w: string) => lower(w.slice(w.lastIndexOf('/') + 1));
  let prog = base(words[0] ?? '');
  if (prog === 'env') prog = base(words.slice(1).find((w) => !w.startsWith('-')) ?? '');
  if (!prog) return undefined;
  return byInterpreter.get(prog) ?? byInterpreter.get(prog.replace(/[\d.]+$/, ''));
}

/** The id of the language of a file by its name, and for a name that says
 * nothing by the program of its first line (`#!/usr/bin/env python3`). */
export function languageOf(fileName: string, firstLine?: string): string | undefined {
  const base = lower(fileName.slice(fileName.lastIndexOf('/') + 1));
  const found = byFileName(base);
  if (found) return found;
  for (const e of COPY_ENDINGS) {
    if (base.length > e.length && base.endsWith(e)) {
      const inner = byFileName(base.slice(0, -e.length));
      if (inner) return inner;
      break;
    }
  }
  return firstLine === undefined ? undefined : interpreterOf(firstLine);
}

/** The id of the language a Markdown fence names (an id, a grammar's name,
 * an alias or an extension), case-insensitive. */
export function languageByAlias(name: string): string | undefined {
  const key = lower(name.trim());
  for (const m of aliasMaps) {
    const id = m.get(key);
    if (id) return id;
  }
  return undefined;
}
