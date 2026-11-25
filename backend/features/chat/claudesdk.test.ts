// The pin of Anthropic's Agent SDK is the development dependency's, as the
// lockfile records it: moving to another version changes both together
// (offline: the lockfile and package.json are read, nothing is fetched).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { CLAUDE_SDK, NPM_REGISTRY, pinnedSha512, tarballURL } from './claudesdk.ts';

const backend = (rel: string) => readFileSync(join(REPO_ROOT, 'backend', rel), 'utf8');

describe("the Agent SDK's pin", () => {
  test("is the lockfile's integrity of the development dependency's version", () => {
    const pkg = JSON.parse(backend('package.json')) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
    expect(pkg.devDependencies?.[CLAUDE_SDK.name]).toBe(CLAUDE_SDK.version);
    expect(pkg.dependencies?.[CLAUDE_SDK.name]).toBeUndefined();
    const lock = backend('pnpm-lock.yaml');
    // packages: '<name>@<version>': resolution: {integrity: …}
    const key = `\n  '${CLAUDE_SDK.name}@${CLAUDE_SDK.version}':\n`;
    const at = lock.indexOf(key);
    expect(at).toBeGreaterThan(0);
    const entry = lock.slice(at + key.length, lock.indexOf('\n\n', at + key.length));
    const integrity = /^\s+resolution: \{integrity: (\S+?)\}/m.exec(entry)?.[1];
    expect(integrity).toBe(CLAUDE_SDK.integrity);
    expect(pinnedSha512(CLAUDE_SDK)).not.toBe('');
    // The registry's name of the tarball.
    expect(CLAUDE_SDK.file).toBe(`${CLAUDE_SDK.name.split('/')[1]}-${CLAUDE_SDK.version}.tgz`);
    expect(tarballURL(CLAUDE_SDK)).toBe(`${NPM_REGISTRY}/${CLAUDE_SDK.name}/-/${CLAUDE_SDK.file}`);
    expect(tarballURL(CLAUDE_SDK, 'https://mirror.example/npm/')).toBe(
      `https://mirror.example/npm/${CLAUDE_SDK.name}/-/${CLAUDE_SDK.file}`,
    );
  });
});
