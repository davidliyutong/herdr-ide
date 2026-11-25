// Where the chat host's Claude Code adapter gets Anthropic's Agent SDK: a
// module loaded at run time, never a part of any executable
// (../../claudesdk.ts). installedSdk loads the pinned version from the
// machine's data directory (<data dir>/claude-agent-sdk/<version>/sdk.mjs,
// which ../sdkstore.ts installs), its SHA-256 checked again first; the
// entry imports Node's own modules only, so it resolves nothing of the
// directory around it. A compiled executable imports it as Bun or Node
// would (import() of its file URL: Bun's compiled executables load modules
// from the file system too).
import { utimes } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type * as Sdk from '@anthropic-ai/claude-agent-sdk';
import { ChatProtoError, Code } from '#shared/proto/chatproto/index.ts';
import { CLAUDE_SDK, sdkDir, type NpmTarball } from '../../claudesdk.ts';
import { entryOk } from '../sdkstore.ts';

/** The SDK's module, as its types declare it. */
export type SdkModule = typeof Sdk;

/** Where the adapter gets the SDK. */
export interface SdkSource {
  /** The module; rejects with sdk_unavailable when the machine has none. */
  load(): Promise<SdkModule>;
}

/** The error of a chat the machine cannot run without the SDK. */
export const unavailable = (message: string): ChatProtoError =>
  new ChatProtoError({ code: Code.SdkUnavailable, message: `claude: ${message}` });

/** The pinned SDK as installed in data directory base: loaded once per
 * process, its directory counted as used at each load. */
export function installedSdk(base: string, pin: NpmTarball = CLAUDE_SDK): SdkSource {
  const dir = sdkDir(base, pin);
  let mod: Promise<SdkModule> | null = null;
  return {
    async load() {
      if (!mod) {
        if (!(await entryOk(dir, pin)))
          throw unavailable(`${pin.name} ${pin.version} is not on this machine (${dir}); a hub installs it before a chat starts`);
        const m = import(pathToFileURL(`${dir}/${pin.entry}`).href) as Promise<SdkModule>;
        mod = m;
        m.catch(() => {
          if (mod === m) mod = null;
        });
      }
      let m: SdkModule;
      try {
        m = await mod;
      } catch (e) {
        throw unavailable(`${pin.name} ${pin.version} did not load: ${(e as Error).message}`);
      }
      const now = new Date();
      await utimes(dir, now, now).catch(() => {});
      return m;
    },
  };
}
