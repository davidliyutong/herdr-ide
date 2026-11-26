import type { FullResult, Reporter } from '@playwright/test/reporter';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { HEIGHT, imagePath, outputDir, scenes, selected, stageDir, wants, WIDTH, type Locale, type SceneName } from './manifest';

export default class Publish implements Reporter {
  async onEnd(result: FullResult) {
    const stage = stageDir;
    if (!stage) return;
    try {
      if (result.status === 'passed') publish();
    } catch (error) {
      console.error(error);
      return { status: 'failed' as const };
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
}

function publish() {
  const files: string[] = [];
  const failures: string[] = [];
  for (const name of Object.keys(scenes) as SceneName[]) {
    if (!wants(name)) continue;
    for (const locale of ['en', 'zh-CN'] as Locale[]) {
      const path = imagePath(name, locale);
      if (!existsSync(path)) {
        failures.push(`${name} (${locale}): missing ${basename(path)}`);
        continue;
      }
      const png = readFileSync(path);
      if (
        png.length < 24 ||
        png.toString('hex', 0, 8) !== '89504e470d0a1a0a' ||
        png.readUInt32BE(16) !== WIDTH ||
        png.readUInt32BE(20) !== HEIGHT
      ) {
        failures.push(`${name} (${locale}): expected ${WIDTH}x${HEIGHT} PNG`);
      }
      files.push(path);
    }
  }
  if (failures.length) throw new Error(`screenshot output is incomplete:\n${failures.join('\n')}`);
  for (const path of files) renameSync(path, join(outputDir, basename(path)));
  console.log(`Published ${selected.size || Object.keys(scenes).length} screenshot scene(s) to ${outputDir}`);
}
