import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_SUBMODULES, ENCODER_LICENSES, depUrlOf, type SubmoduleKind, type SubmoduleRelease } from './deps.ts';
import { checkDeps, stageDeps } from './fetch-deps.ts';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function makeTarGz(files: Record<string, Uint8Array | string>): Promise<Uint8Array> {
  return await new Bun.Archive(files, { compress: 'gzip' }).bytes();
}

describe('submodule release pins', () => {
  test('every submodule artifact has a valid SHA-256 and GitHub release URL', () => {
    for (const [, rel] of Object.entries(ALL_SUBMODULES)) {
      expect(rel.version).toMatch(/^\d+\.\d+\.\d+$/);
      for (const [, a] of Object.entries(rel.artifacts)) {
        expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(depUrlOf(rel, a)).toBe(`https://github.com/davidliyutong/${rel.repo}/releases/download/v${rel.version}/${a.name}`);
      }
    }
  });

  test('checkDeps verifies staged vt, gpupick and gui-helper files against pinned archives', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deps-check-'));
    try {
      const cacheDir = join(root, 'dist', 'deps', 'cache');
      mkdirSync(cacheDir, { recursive: true });

      const vtTgz = await makeTarGz({
        'ghostty-vt.wasm': new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
        LICENSE: 'MIT\n',
      });
      const encFiles: Record<string, string | Uint8Array> = { encoder: new Uint8Array([1, 2, 3]) };
      for (const lic of ENCODER_LICENSES) encFiles[lic] = `license ${lic}\n`;
      const encAmd = await makeTarGz(encFiles);
      const encArm = await makeTarGz({ ...encFiles, encoder: new Uint8Array([4, 5, 6]) });
      const gpuAmd = await makeTarGz({ 'gpupick.so': new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1]) });
      const gpuArm = await makeTarGz({ 'gpupick.so': new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2]) });
      const guiAmd = await makeTarGz({
        'gui-helper': new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 3]),
        'THIRD-PARTY-NOTICES': 'notices\n',
      });
      const guiArm = await makeTarGz({
        'gui-helper': new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 4]),
        'THIRD-PARTY-NOTICES': 'notices\n',
      });

      const submodules: Record<SubmoduleKind, SubmoduleRelease> = {
        vt: { repo: 'veldr-vt', version: '0.1.0', artifacts: { wasm: { name: 'vt.tar.gz', sha256: sha256(vtTgz) } } },
        encoder: {
          repo: 'veldr-encoder',
          version: '0.1.0',
          artifacts: {
            'linux-amd64': { name: 'enc-amd64.tar.gz', sha256: sha256(encAmd) },
            'linux-arm64': { name: 'enc-arm64.tar.gz', sha256: sha256(encArm) },
          },
        },
        gpupick: {
          repo: 'veldr-gpupick',
          version: '0.1.0',
          artifacts: {
            'linux-amd64': { name: 'gpu-amd64.tar.gz', sha256: sha256(gpuAmd) },
            'linux-arm64': { name: 'gpu-arm64.tar.gz', sha256: sha256(gpuArm) },
          },
        },
        'gui-helper': {
          repo: 'veldr-gui-helper',
          version: '0.1.0',
          artifacts: {
            'linux-amd64': { name: 'gui-amd64.tar.gz', sha256: sha256(guiAmd) },
            'linux-arm64': { name: 'gui-arm64.tar.gz', sha256: sha256(guiArm) },
          },
        },
      };

      const seed = (rel: SubmoduleRelease, key: string, bytes: Uint8Array) => {
        const a = rel.artifacts[key]!;
        writeFileSync(join(cacheDir, `${rel.repo}-v${rel.version}-${a.name}`), bytes);
      };
      seed(submodules.vt, 'wasm', vtTgz);
      seed(submodules.encoder, 'linux-amd64', encAmd);
      seed(submodules.encoder, 'linux-arm64', encArm);
      seed(submodules.gpupick, 'linux-amd64', gpuAmd);
      seed(submodules.gpupick, 'linux-arm64', gpuArm);
      seed(submodules['gui-helper'], 'linux-amd64', guiAmd);
      seed(submodules['gui-helper'], 'linux-arm64', guiArm);

      await stageDeps(['vt', 'encoder', 'gpupick', 'gui-helper'], { repoRoot: root, submodules, quiet: true });
      await checkDeps({ repoRoot: root, submodules });

      // Corrupt gpupick binary -> fails checkDeps; re-staging restores it.
      writeFileSync(join(root, 'dist', 'deps', 'gpupick', 'gpupick-linux-amd64.so'), 'corrupted');
      await expect(checkDeps({ repoRoot: root, submodules })).rejects.toThrow(/gpupick-linux-amd64\.so does not match/);
      await stageDeps(['gpupick'], { repoRoot: root, submodules, quiet: true });
      await checkDeps({ repoRoot: root, submodules });

      // Remove gui-helper binary -> fails checkDeps offline immediately.
      rmSync(join(root, 'dist', 'deps', 'gui-helper', 'gui-helper-linux-arm64'));
      await expect(checkDeps({ repoRoot: root, submodules })).rejects.toThrow(/gui-helper-linux-arm64 is missing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
