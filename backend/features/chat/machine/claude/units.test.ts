// The Claude Code adapter's parts on their own: prompts as Claude Code's
// content, the rules "allow for this session" sends, the kinds of
// permissions, Claude Code's own trust, the modes, and the cut of strings.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as chat from '#shared/proto/chatproto/index.ts';
import { ChatProtoError, Code } from '#shared/proto/chatproto/index.ts';
import { chatMode, claudeMode, cut } from './config.ts';
import { claudeContent } from './content.ts';
import { permissionKind, sessionRules } from './permissions.ts';
import { tempDir } from './testing.ts';
import { MAX_GLOBAL_CONFIG, trustedByClaude } from './trust.ts';

const codeOf = (f: () => unknown): string => {
  try {
    f();
    return 'no error';
  } catch (e) {
    return e instanceof ChatProtoError ? e.code : String(e);
  }
};

describe('content', () => {
  test("a prompt is Claude Code's content: the images first, one text block last, resource links as @ mentions", () => {
    const got = claudeContent(
      [
        { type: 'text', text: 'look at' },
        { type: 'resource_link', uri: 'file:///work/src/a.go', name: 'a.go' },
        { type: 'resource_link', uri: 'file:///elsewhere/my%20file.txt', name: 'f' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        { type: 'text', text: 'and say why' },
        { type: 'resource', resource: { uri: 'mem://x', text: 'notes' } },
      ],
      '/work',
    );
    expect(got).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: 'look at @src/a.go @"/elsewhere/my file.txt" and say why\n\nnotes' },
    ]);
  });

  test('what is no prompt is refused', () => {
    const bad: Record<string, unknown> = {
      svg: { type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' },
      'not base64': { type: 'image', mimeType: 'image/png', data: '@@@' },
      'no data': { type: 'image', mimeType: 'image/png' },
      audio: { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' },
      'no uri': { type: 'resource_link' },
      blob: { type: 'resource', resource: { uri: 'x', mimeType: 'application/pdf', blob: 'AAAA' } },
      empty: { type: 'text', text: '' },
      'no resource': { type: 'resource' },
      'no object': 'text',
    };
    for (const [name, b] of Object.entries(bad))
      expect(`${name}: ${codeOf(() => claudeContent([b], '/work'))}`).toBe(`${name}: ${Code.BadRequest}`);
  });
});

describe('permissions', () => {
  test('"allow for this session" sends only the addRules suggestions, their destination the session', () => {
    const in_ = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch a' }], behavior: 'allow', destination: 'localSettings' },
      { type: 'addDirectories', directories: ['/work'], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'userSettings' },
      42,
    ];
    expect(sessionRules(in_)).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch a' }], behavior: 'allow', destination: 'session' },
    ]);
    expect(sessionRules(in_.slice(1, 3))).toEqual([]);
    expect(sessionRules(undefined)).toEqual([]);
  });

  test('the kinds of permissions', () => {
    expect(
      Object.fromEntries(['Bash', 'KillShell', 'Write', 'NotebookEdit', 'mcp__x__y', 'WebFetch'].map((t) => [t, permissionKind(t)])),
    ).toEqual({
      Bash: chat.PermissionKind.Command,
      KillShell: chat.PermissionKind.Command,
      Write: chat.PermissionKind.File,
      NotebookEdit: chat.PermissionKind.File,
      mcp__x__y: chat.PermissionKind.MCP,
      WebFetch: chat.PermissionKind.Tool,
    });
  });
});

describe('modes', () => {
  test("Claude Code's permission modes and the chat's", () => {
    for (const m of chat.MODES) expect(chatMode(claudeMode(m))).toBe(m);
    expect(claudeMode('')).toBe('default');
    for (const m of ['dontAsk', 'auto', '', 42]) expect(chatMode(m)).toBe('');
  });
});

test('cut keeps whole characters', () => {
  expect(cut('abc', 5)).toBe('abc');
  expect(cut('aéb', 2)).toBe('a');
  expect(cut('aéb', 3)).toBe('aé');
  expect(cut('😀😀', 5)).toBe('😀');
});

describe('trust', () => {
  test("a folder is Claude Code's trusted one when its configuration says the user accepted its trust dialog for it or one above it", async () => {
    // Claude Code names folders as getcwd has them: without links.
    const home = tempDir('cth');
    const work = join(home, 'src', 'proj', 'sub');
    mkdirSync(work, { recursive: true });
    const env = { HOME: home, PATH: '/usr/bin' };
    const logs: string[] = [];
    const trusts = (e: Record<string, string>, dir: string) => trustedByClaude(e, dir, (l) => logs.push(l));
    expect(await trusts(env, work)).toBe(false);
    const cfg = join(home, '.claude.json');
    const write = (file: string, s: string) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, s, { mode: 0o600 });
    };
    write(
      cfg,
      JSON.stringify({
        numStartups: 3,
        projects: {
          [join(home, 'src', 'proj')]: { hasTrustDialogAccepted: true, allowedTools: [] },
          [work]: { hasTrustDialogAccepted: false },
        },
      }),
    );
    expect(await trusts(env, work)).toBe(true);
    expect(await trusts(env, join(home, 'src', 'proj'))).toBe(true);
    expect(await trusts(env, join(home, 'src'))).toBe(false);
    expect(await trusts(env, home)).toBe(false);
    // The folder by another name (a link) is the same folder.
    const link = join(tempDir('ctl'), 'link');
    symlinkSync(work, link);
    expect(await trusts(env, link)).toBe(true);
    write(cfg, '{"projects":');
    expect(await trusts(env, work)).toBe(false);
    expect(logs.join('\n')).toContain('is no configuration');
    writeFileSync(cfg, '');
    truncateSync(cfg, MAX_GLOBAL_CONFIG + 1);
    expect(await trusts(env, work)).toBe(false);
    expect(logs.join('\n')).toContain('not read');
    rmSync(cfg);
    mkdirSync(cfg);
    expect(await trusts(env, work)).toBe(false);
    rmSync(cfg, { recursive: true });

    // CLAUDE_CONFIG_DIR's configuration, not the home's.
    const trusted = JSON.stringify({ projects: { [work]: { hasTrustDialogAccepted: true } } });
    write(cfg, trusted);
    const dir = tempDir('ctc');
    const withDir = { ...env, CLAUDE_CONFIG_DIR: dir };
    expect(await trusts(withDir, work)).toBe(false);
    write(join(dir, '.claude.json'), trusted);
    expect(await trusts(withDir, work)).toBe(true);
    // A legacy configuration first.
    write(join(dir, '.config.json'), '{"projects":{}}');
    expect(await trusts(withDir, work)).toBe(false);
    // Nothing written.
    expect(await Bun.file(cfg).text()).toBe(trusted);
  });
});
