// The desktop app's hub: composed as the command line composes it
// (hosts/common/compose.ts) from what the app's main process starts it
// with (HubStart): the payloads from the app's resources, a terminal
// through node-pty, the guard with the app's origin, the verify key of
// this launch.
import { validInstance } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import { noAudit } from '#kernel/audit.ts';
import { Guard } from '#kernel/http/guard.ts';
import { dirFiles, payloads } from '#kernel/payloads.ts';
import type { SpawnPty } from '#kernel/pty.ts';
import { controlDir as makeControlDir } from '#kernel/machines/transport/controldir.ts';
import { composeHub, hubFeatures, type Composed } from '#hosts/common/compose.ts';
import type { HubStart } from './bridge.ts';

/** Checks what the main process sent; the message of the first fault. */
export function startProblem(s: HubStart): string {
  if (!validInstance(s.instance) || !validInstance(s.nodeInstance)) return 'invalid instance';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(s.verifyKey)) return 'invalid verify key';
  let origin: URL;
  try {
    origin = new URL(s.origin);
  } catch {
    return 'invalid origin';
  }
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.localhost') || origin.origin !== s.origin) return 'invalid origin';
  if (!s.payload || !s.web) return 'no payloads';
  return '';
}

export function startHub(s: HubStart, o: { logger: Logger; pty?: SpawnPty }): Composed {
  const problem = startProblem(s);
  if (problem) throw new Error(problem);
  const controlDir = process.platform === 'win32' ? '' : makeControlDir(s.instance);
  const p = payloads({ files: dirFiles(s.payload), web: dirFiles(s.web), agentDir: s.agentDir, logger: o.logger });
  const features = hubFeatures({
    payloads: p,
    controlDir,
    verifyKey: s.verifyKey,
    pty: o.pty,
    codeServer: { seedDirs: s.seedDirs ?? [], offline: false, idle: 20 * 60_000 },
    chatSdk: { seedDirs: s.seedDirs ?? [] },
  });
  return composeHub({
    instance: s.instance,
    nodeInstance: s.nodeInstance,
    features,
    payloads: p,
    controlDir,
    localOnly: s.localOnly,
    // The app's windows are its only clients: its origin is the one the
    // guard lets in, and nothing listens.
    guard: new Guard({ allowedOrigins: [s.origin], logger: o.logger }),
    audit: noAudit,
    readOnly: false,
    logger: o.logger,
  });
}
