// Where machines get code-server from, also per machine (one is offline,
// another has its own): the settings of the section codeServer, which the
// web UI shows under VS Code.
import { posix } from 'node:path';
import { defineModule, enumOf, text } from '#kernel/config/settings/index.ts';

/** How a machine gets code-server (codeServer.install). */
export const Install = {
  /** The hub resolves, verifies and uploads the release. */
  Push: 'push',
  /** The machine downloads the release, verified against the hub's
   * digest; falls back to Push. */
  Download: 'download',
  /** A code-server already on the machine; falls back to Push when there
   * is none. */
  Existing: 'existing',
} as const;
export type Install = (typeof Install)[keyof typeof Install];

export const INSTALL = 'codeServer.install';
export const PATH = 'codeServer.path';

export const settings = defineModule({
  sections: [{ id: 'codeServer', order: 60, advanced: true, plugin: 'vscode' }],
  settings: {
    [INSTALL]: enumOf([Install.Push, Install.Download, Install.Existing], {
      default: Install.Push,
      scope: 'machine',
      section: 'codeServer',
      order: 10,
      flag: 'code-server-install',
      usage:
        "how machines get code-server: push (the hub downloads, verifies and uploads it), download (the machine downloads it, verified) or existing (use the machine's own code-server); the last two fall back to push",
    }),
    [PATH]: text({
      default: '',
      scope: 'machine',
      section: 'codeServer',
      order: 20,
      flag: 'code-server-path',
      usage:
        'code-server executable on machines for --code-server-install=existing (absolute or ~/ path); empty searches PATH and the usual install locations',
      check: (s) => (s !== '' && !posix.isAbsolute(s) && !s.startsWith('~/') ? 'must be an absolute or ~/ path' : undefined),
    }),
  },
});
