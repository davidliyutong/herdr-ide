// Validates what the desktop shell sends to start its hub.
import { validInstance } from '#shared/lib/brand.ts';
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
  return '';
}
