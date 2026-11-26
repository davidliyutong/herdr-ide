import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import baseSetup from '../harness/global-setup';
import { paths, repoRoot } from '../harness/paths';
import { IMAGE } from '../harness/sshd';
import { checkCoverage, dockerImage, stageImages, wants } from './manifest';

export default function globalSetup() {
  baseSetup();
  checkCoverage();
  mkdirSync(join(dirname(paths.hub), 'results'), { recursive: true });
  if (wants('windows')) {
    console.log('Preparing the SSH demo machine with matplotlib');
    execFileSync(
      'docker',
      [
        'build',
        '-q',
        '--build-arg',
        `BASE_IMAGE=${IMAGE}`,
        '-t',
        dockerImage,
        '-f',
        join(repoRoot, 'e2e', 'screenshots', 'Dockerfile'),
        join(repoRoot, 'e2e'),
      ],
      { stdio: 'inherit', timeout: 300_000 },
    );
  }
  prepareCodeServer();
  stageImages();
}

function prepareCodeServer() {
  if (!wants('vscode') || process.env.E2E_CODE_SERVER_SEED) return;

  const os = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : '';
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : '';
  if (!os || !arch) throw new Error(`no code-server asset for ${process.platform}/${process.arch}`);
  const dir = join(dirname(paths.hub), 'code-server');
  const suffix = `-${os}-${arch}.tar.gz`;
  if (existsSync(dir) && readdirSync(dir).some((name) => name.startsWith('code-server-') && name.endsWith(suffix))) {
    process.env.E2E_CODE_SERVER_SEED = dir;
    return;
  }

  console.log('Preparing the pinned code-server release and extensions for the VS Code screenshot');
  execFileSync(paths.hub, ['fetch-assets', '--platforms', `${os}-${arch}`, dir], { stdio: 'inherit', timeout: 300_000 });
  process.env.E2E_CODE_SERVER_SEED = dir;
}
