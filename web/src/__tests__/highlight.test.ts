// Code highlighting: the language table's invariants, that every grammar
// loads and tokenizes under the JavaScript regex engine, which language a
// file or a fence name is of, the roles of tokens, and that each role has a
// style and a legible color in both themes.

import { describe, expect, it } from 'vitest';
import tokens from '../../../design/tokens.json';
import { highlight, lineTokenizer, type Piece } from '../highlight/highlighter';
import { LANGS, languageByAlias, languageOf } from '../highlight/languages';
import { ROLES } from '../highlight/roles';

const fsModule = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(p: URL, enc: 'utf8'): string };
const css = fs.readFileSync(new URL('../highlight/highlight.css', import.meta.url), 'utf8');

const nameOf = (l: { id: string; shiki?: string }) => l.shiki ?? l.id;

describe('the language table', () => {
  it('has unique ids, grammar names and keys, all lower case', () => {
    const ids = LANGS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    const grammarNames = LANGS.map(nameOf);
    expect(new Set(grammarNames).size).toBe(grammarNames.length);
    for (const field of ['names', 'prefixes', 'extensions', 'interpreters', 'aliases'] as const) {
      const claimed = new Map<string, string>();
      for (const l of LANGS) {
        for (const k of new Set(l[field] ?? [])) {
          expect([field, k, claimed.get(k)]).toEqual([field, k, undefined]);
          claimed.set(k, l.id);
          expect([field, k, k === k.toLowerCase()]).toEqual([field, k, true]);
        }
      }
    }
    for (const l of LANGS) expect(l.id).toBe(l.id.toLowerCase());
  });

  it('keeps an alias from naming another language', () => {
    const own = new Map<string, string>();
    for (const l of LANGS) for (const k of [l.id, l.shiki]) if (k) own.set(k, l.id);
    for (const l of LANGS) for (const a of l.aliases ?? []) expect([a, own.get(a) ?? l.id]).toEqual([a, l.id]);
  });

  it('has about a hundred languages, JSON with its own tokens', () => {
    expect(LANGS.length).toBeGreaterThanOrEqual(100);
    const json = LANGS.find((l) => l.id === 'json');
    expect(json?.monaco).toBe(true);
    expect(json?.ownTokens).toBe(true);
    expect(LANGS.filter((l) => l.ownTokens).map((l) => l.id)).toEqual(['json']);
  });

  it('gives a language without Monaco a comment where it has one', () => {
    expect(LANGS.find((l) => l.id === 'toml')?.comment).toBe('#');
    expect(LANGS.find((l) => l.id === 'vue')?.comment).toEqual(['<!--', '-->']);
    for (const l of LANGS) if (l.monaco) expect(l.comment).toBeUndefined();
  });
});

describe('the grammars', () => {
  for (const l of LANGS) {
    it(`load: ${l.id}`, async () => {
      const mod = await l.grammar();
      expect(mod.default.some((r) => r.name === nameOf(l))).toBe(true);
    });
  }

  for (const l of LANGS) {
    it(`tokenize: ${l.id}`, async () => {
      const lines = await highlight('x', l.id);
      expect(lines).toBeDefined();
      expect(lines?.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('give nothing for a language that is none of ours', async () => {
    expect(await highlight('x', 'nope')).toBeUndefined();
    expect(await highlight('x', undefined)).toBeUndefined();
  });
});

describe('languageOf', () => {
  const cases: [string, string | undefined, string | undefined][] = [
    ['Makefile', undefined, 'makefile'],
    ['GNUmakefile', undefined, 'makefile'],
    ['rules.mk', undefined, 'makefile'],
    ['Makefile.in', undefined, 'makefile'],
    ['Makefile.linux', undefined, 'makefile'],
    ['Dockerfile', undefined, 'dockerfile'],
    ['Dockerfile.dev', undefined, 'dockerfile'],
    ['dockerfile-prod', undefined, 'dockerfile'],
    ['dev.Dockerfile', undefined, 'dockerfile'],
    ['Containerfile', undefined, 'dockerfile'],
    ['CMakeLists.txt', undefined, 'cmake'],
    ['toolchain.cmake', undefined, 'cmake'],
    ['.gitignore', undefined, 'ignore'],
    ['.dockerignore', undefined, 'ignore'],
    ['.env', undefined, 'dotenv'],
    ['.env.local', undefined, 'dotenv'],
    ['prod.env', undefined, 'dotenv'],
    ['.bashrc', undefined, 'shell'],
    ['.zshrc', undefined, 'shell'],
    ['install.sh', undefined, 'shell'],
    ['config.yaml.example', undefined, 'yaml'],
    ['settings.json.sample', undefined, 'json'],
    ['src/app/main.TSX', undefined, 'tsx'],
    ['a/b/c.test.ts', undefined, 'typescript'],
    ['x.d.ts', undefined, 'typescript'],
    ['x.mts', undefined, 'typescript'],
    ['x.cts', undefined, 'typescript'],
    ['x.mjs', undefined, 'javascript'],
    ['x.cjs', undefined, 'javascript'],
    ['App.jsx', undefined, 'jsx'],
    ['A.JSON', undefined, 'json'],
    ['tsconfig.json', undefined, 'jsonc'],
    ['data.jsonl', undefined, 'jsonl'],
    ['main.go', undefined, 'go'],
    ['lib.rs', undefined, 'rust'],
    ['main.c', undefined, 'c'],
    ['main.cpp', undefined, 'cpp'],
    ['Gemfile', undefined, 'ruby'],
    ['Jenkinsfile', undefined, 'groovy'],
    ['justfile', undefined, 'just'],
    ['CODEOWNERS', undefined, 'codeowners'],
    ['.htaccess', undefined, 'apache'],
    ['sshd_config', undefined, 'ssh-config'],
    ['COMMIT_EDITMSG', undefined, 'git-commit'],
    ['dir.with.dots/README.md', undefined, 'markdown'],
    ['unit.service', undefined, 'systemd'],
    ['README', undefined, undefined],
    ['LICENSE', undefined, undefined],
    ['a.unknownext', undefined, undefined],
    ['.hidden', undefined, undefined],
    ['run', '#!/usr/bin/env python3', 'python'],
    ['run', '#!/bin/bash', 'shell'],
    ['run', '#!/usr/bin/env -S node --flag', 'javascript'],
    ['run', '#!/usr/bin/python3.12', 'python'],
    ['run', '#! /bin/sh -e', 'shell'],
    ['run', '#!/usr/bin/env', undefined],
    ['run', '# not a shebang', undefined],
    ['run', '#!/opt/unknown/tool', undefined],
    ['notes.unknownext', '#!/usr/bin/env ruby', 'ruby'],
    ['main.py', '#!/bin/bash', 'python'],
  ];
  for (const [name, first, want] of cases) {
    it(`${name}${first === undefined ? '' : ` (${first})`} is ${want ?? 'none'}`, () => {
      expect(languageOf(name, first)).toBe(want);
    });
  }

  it('gives only ids of the table', () => {
    const ids = new Set(LANGS.map((l) => l.id));
    for (const l of LANGS) {
      for (const k of [...(l.names ?? []), ...(l.extensions ?? []).map((e) => `x.${e}`)]) expect(ids.has(languageOf(k) ?? '')).toBe(true);
    }
  });
});

describe('languageByAlias', () => {
  const cases: [string, string | undefined][] = [
    ['ts', 'typescript'],
    ['TypeScript', 'typescript'],
    ['  tsx ', 'tsx'],
    ['js', 'javascript'],
    ['sh', 'shell'],
    ['bash', 'shell'],
    ['shellscript', 'shell'],
    ['yml', 'yaml'],
    ['md', 'markdown'],
    ['py', 'python'],
    ['rb', 'ruby'],
    ['c++', 'cpp'],
    ['golang', 'go'],
    ['rs', 'rust'],
    ['make', 'makefile'],
    ['dockerfile', 'dockerfile'],
    ['docker', 'dockerfile'],
    ['tf', 'terraform'],
    ['ps1', 'powershell'],
    ['proto', 'proto'],
    ['protobuf', 'proto'],
    ['rst', 'restructuredtext'],
    ['tex', 'tex'],
    ['text', undefined],
    ['plaintext', undefined],
    ['txt', undefined],
    ['console', undefined],
    ['', undefined],
    ['nope', undefined],
  ];
  for (const [name, want] of cases) {
    it(`${JSON.stringify(name)} is ${want ?? 'none'}`, () => {
      expect(languageByAlias(name)).toBe(want);
    });
  }
});

describe('roles', () => {
  const roleOf = (lines: Piece[][] | undefined, line: number, text: string) => lines?.[line]?.find((p) => p.text.includes(text))?.role;

  it('color a Makefile', async () => {
    const lines = await highlight('# build\nall: main.o\n\tcc -o app main.o\n', 'makefile');
    expect(roleOf(lines, 0, '# build')).toBe('comment');
  });

  it('color TypeScript', async () => {
    const lines = await highlight('const s = "hello";\n', 'typescript');
    expect(roleOf(lines, 0, 'const')).toBe('keyword');
    expect(roleOf(lines, 0, 'hello')).toBe('string');
  });

  it('color a diff', async () => {
    const lines = await highlight('--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n', 'diff');
    expect(roleOf(lines, 4, '+new')).toBe('inserted');
    expect(roleOf(lines, 3, '-old')).toBe('deleted');
  });

  it('color Markdown headings', async () => {
    const lines = await highlight('# Title\n\ntext\n', 'markdown');
    expect(roleOf(lines, 0, 'Title')).toBe('heading');
  });

  it('color keys of YAML', async () => {
    const yaml = await highlight('name: value\n', 'yaml');
    expect(roleOf(yaml, 0, 'name')).toBe('property');
  });

  it('color keys of TOML', async () => {
    const toml = await highlight('name = "value"\n', 'toml');
    expect(roleOf(toml, 0, 'name')).toBe('property');
  });

  it('color an ignore file', async () => {
    const lines = await highlight('# deps\nnode_modules/\n!keep\n', 'ignore');
    expect(roleOf(lines, 0, '# deps')).toBe('comment');
    expect(roleOf(lines, 1, 'node_modules')).toBeUndefined();
  });
});

describe('lineTokenizer', () => {
  it('tokenizes a Makefile line by line', async () => {
    const t = await lineTokenizer('makefile');
    expect(t).toBeDefined();
    if (!t) return;
    const first = t.line('# a comment', t.initial);
    expect(first.tokens[0].role).toBe('comment');
    expect(t.same(t.initial, t.initial)).toBe(true);
    expect(t.same(first.state, first.state)).toBe(true);
    const next = t.line('all:', first.state);
    expect(next.tokens.length).toBeGreaterThan(0);
  });

  it('gives nothing for a language that is none of ours', async () => {
    expect(await lineTokenizer('nope')).toBeUndefined();
  });
});

describe('the colors', () => {
  it('have a style for every role', () => {
    for (const role of ROLES) expect([role, css.includes(`.syn-${role}`)]).toEqual([role, true]);
  });

  for (const theme of ['light', 'dark'] as const) {
    it(`of syntax keep 4.5:1 against the ${theme} background`, () => {
      const bg = tokens.color.background[theme];
      for (const [name, c] of Object.entries(tokens.syntax)) {
        const ratio = contrast(c[theme], bg);
        expect([name, ratio >= 4.5]).toEqual([name, true]);
      }
    });
  }
});

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
