// The design tokens' generator: parsing, the generated CSS, its
// determinism, what it refuses, and the check make check runs.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CSS_OUT, HEADER, SOURCE, generate, parse, run } from './tokens.ts';

const sample = `{
  "color": {
    "background": { "light": "#ffffff", "dark": "#0a0a0a" },
    "borderStrong": { "light": "#d4d4d4", "dark": { "hex": "#ffffff", "alpha": 0.14 } }
  },
  "status": { "working": { "light": "#eab308", "dark": "#eab308" } },
  "git": { "added": { "light": "#587c0c", "dark": "#81b88b" } },
  "chart": { "blue": { "light": "#2e7de9", "dark": "#7aa2f7" } },
  "fileIcon": { "lightBlue": { "light": "#2b6cb0", "dark": "#5aa3e0" } },
  "syntax": { "keyword": { "light": "#7847bd", "dark": "#bb9af7" } },
  "themes": [
    { "id": "first", "accent": { "light": "#3a63c8", "dark": "#7aa2f7" }, "onAccent": { "light": "#ffffff", "dark": "#0a0a0a" } },
    { "id": "second", "accent": { "light": "#005fb8", "dark": "#0078d4" }, "onAccent": { "light": "#fffffe", "dark": "#fffffd" } }
  ],
  "terminal": {
    "light": { "background": "#ffffff", "foreground": "#0a0a0a", "cursor": "#0a0a0a", "selection": "#b6d4fe", "palette": [
      "#000001", "#000002", "#000003", "#000004", "#000005", "#000006", "#000007", "#000008",
      "#000009", "#00000a", "#00000b", "#00000c", "#00000d", "#00000e", "#00000f", "#000010"] },
    "dark": { "background": "#0a0a0a", "foreground": "#f0f0f0", "cursor": "#f0f0f0", "selection": "#3b4a6b", "palette": [
      "#100001", "#100002", "#100003", "#100004", "#100005", "#100006", "#100007", "#100008",
      "#100009", "#10000a", "#10000b", "#10000c", "#10000d", "#10000e", "#10000f", "#100010"] }
  },
  "metric": { "rowHeight": 26, "radius": 6 },
  "size": { "toolbar": 28 },
  "font": { "root": 13, "size": { "base": 13, "small": 11 } }
}`;

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('parse', () => {
  const t = parse(sample);
  expect(t.color.background).toEqual({ light: { rgb: 0xffffff, alpha: 1 }, dark: { rgb: 0x0a0a0a, alpha: 1 } });
  expect(t.color.borderStrong!.dark).toEqual({ rgb: 0xffffff, alpha: 0.14 });
  expect([t.metric.rowHeight, t.font.size.base, t.size.toolbar]).toEqual([26, 13, 28]);
  expect(t.terminal.dark.palette[15]!.rgb).toBe(0x100010);
});

test('generate', () => {
  const files = generate(sample);
  for (let i = 0; i < 20; i++) expect(generate(sample)).toEqual(files);
  const css = files[CSS_OUT]!;
  for (const s of [
    `/* ${HEADER} */\n:root {\n`,
    '  --ds-color-background: #0a0a0a;\n',
    '  --ds-color-border-strong: rgba(255, 255, 255, 0.14);\n',
    '  --ds-status-working: #eab308;\n',
    '  --ds-terminal-ansi-15: #100010;\n',
    '  --ds-metric-row-height: 26px;\n',
    '  --ds-font-size-base: 1rem;\n',
    '  --ds-font-size-small: 0.8462rem;\n',
    '  --ds-size-toolbar: 2.1538rem;\n',
    '  --ds-git-added: #81b88b;\n',
    '  --ds-chart-blue: #7aa2f7;\n',
    '  --ds-file-icon-light-blue: #5aa3e0;\n',
    '  --ds-syntax-keyword: #bb9af7;\n',
    ':root {\n  --ds-accent: #7aa2f7;\n  --ds-on-accent: #0a0a0a;\n',
    ":root[data-theme='light'] {\n  --ds-accent: #3a63c8;\n  --ds-on-accent: #ffffff;\n  --ds-color-background: #ffffff;\n  --ds-color-border-strong: #d4d4d4;\n",
    ":root[data-accent='second'] {\n  --ds-accent: #0078d4;\n  --ds-on-accent: #fffffd;\n}\n",
    ":root[data-accent='second'][data-theme='light'] {\n  --ds-accent: #005fb8;\n  --ds-on-accent: #fffffe;\n}\n",
  ])
    expect(css).toContain(s);
  // Lengths are written once: the light theme changes only colors.
  for (const v of ['--ds-metric-radius', '--ds-size-toolbar', '--ds-font-size-base']) expect(css.split(v).length - 1).toBe(1);
  // The first theme is the default: it has no selector of its own.
  expect(css).not.toContain("data-accent='first'");
});

test('refuses', () => {
  const edits: Record<string, [string, string]> = {
    'short color': ['"#ffffff", "dark": "#0a0a0a" }', '"#fff", "dark": "#0a0a0a" }'],
    'upper case color': ['"#eab308", "dark"', '"#EAB308", "dark"'],
    'not a color': ['"#eab308", "dark"', '"yellow", "dark"'],
    'alpha out of range': ['"alpha": 0.14', '"alpha": 1.4'],
    'missing alpha': [', "alpha": 0.14', ''],
    'missing theme': ['{ "light": "#eab308", "dark": "#eab308" }', '{ "light": "#eab308" }'],
    'unknown field': ['"metric":', '"shadow": {}, "metric":'],
    'short palette': ['"#00000f", "#000010"]', '"#00000f"]'],
    'token name': ['"rowHeight"', '"row-height"'],
    'negative metric': ['"radius": 6', '"radius": -6'],
    'no terminal': ['"light": { "background": "#ffffff", "foreground"', '"other": { "background": "#ffffff", "foreground"'],
    'no themes': ['"themes": [', '"themes": [], "x": ['],
    'theme twice': ['"id": "second"', '"id": "first"'],
    'theme no accent': ['"id": "second", "accent"', '"id": "second", "other"'],
    'no font root': ['"root": 13, ', ''],
    'negative size': ['"toolbar": 28', '"toolbar": -28'],
  };
  for (const [name, [from, to]] of Object.entries(edits)) {
    const data = sample.replace(from, to);
    expect([name, data === sample]).toEqual([name, false]);
    expect(() => generate(data)).toThrow();
  }
});

test('check', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokens-'));
  dirs.push(root);
  for (const name of [SOURCE, CSS_OUT]) mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, SOURCE), sample);
  const css = join(root, CSS_OUT);
  // Nothing generated yet: stale, and the check writes nothing.
  expect(() => run(root, true)).toThrow(CSS_OUT);
  expect(existsSync(css)).toBe(false);
  run(root, false);
  run(root, true);
  // An edited generated file is stale, and so is one behind the tokens.
  const fresh = readFileSync(css, 'utf8');
  writeFileSync(css, fresh + '\n');
  expect(() => run(root, true)).toThrow(CSS_OUT);
  expect(readFileSync(css, 'utf8')).toBe(fresh + '\n');
  run(root, false);
  writeFileSync(join(root, SOURCE), sample.replace('"radius": 6', '"radius": 8'));
  expect(() => run(root, true)).toThrow();
});

// The repository's tokens parse and its generated files are current.
test('the repository', () => {
  run(join(import.meta.dir, '..', '..'), true);
});
