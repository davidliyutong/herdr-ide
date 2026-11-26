// Native OS notifications for the desktop shell (Electron Notification API),
// with strict payload validation, tag-based deduplication, bounded active
// tracking, and queued click routing back to the main window's page.
import type { DesktopNotificationOptions, NotificationTarget } from '../../web/src/shell';

export const MAX_NOTIFY_TITLE = 256;
export const MAX_NOTIFY_BODY = 1024;
export const MAX_NOTIFY_TAG = 256;
export const MAX_NOTIFY_ID = 256;
export const MAX_NOTIFY_AGENT = 64;
export const MAX_ACTIVE_NOTIFICATIONS = 100;

const URGENCIES = new Set(['normal', 'critical', 'low']);
const OPTION_KEYS = new Set(['title', 'body', 'tag', 'silent', 'urgency', 'target']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Single-line plain text bounded to max chars with control chars replaced. */
function cleanLine(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim()
    .slice(0, max);
  return s || undefined;
}

/** Multi-line plain text bounded to max chars, preserving line breaks. */
function cleanBody(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, MAX_NOTIFY_BODY);
  return s || undefined;
}

/** Identifier or tag without control characters, bounded to max chars. */
export function sanitizeTag(v: unknown, max = MAX_NOTIFY_TAG): string | undefined {
  if (typeof v !== 'string' || !v || v.length > max) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(v)) return undefined;
  return v;
}

/** Validates and copies a notification click target; returns undefined for anything malformed. */
export function parseNotificationTarget(v: unknown): NotificationTarget | undefined {
  if (!isPlainObject(v) || typeof v.kind !== 'string') return undefined;
  const keys = Object.keys(v);
  switch (v.kind) {
    case 'pane': {
      if (keys.length !== 3) return undefined;
      const machine = sanitizeTag(v.machine, MAX_NOTIFY_ID);
      const pane = sanitizeTag(v.pane, MAX_NOTIFY_ID);
      return machine && pane ? { kind: 'pane', machine, pane } : undefined;
    }
    case 'chat': {
      if (keys.length !== 3 && keys.length !== 4) return undefined;
      if (keys.some((k) => k !== 'kind' && k !== 'machine' && k !== 'chat' && k !== 'agent')) return undefined;
      const machine = sanitizeTag(v.machine, MAX_NOTIFY_ID);
      const chat = sanitizeTag(v.chat, MAX_NOTIFY_ID);
      if (!machine || !chat) return undefined;
      if (v.agent === undefined) return { kind: 'chat', machine, chat };
      const agent = cleanLine(v.agent, MAX_NOTIFY_AGENT);
      return agent ? { kind: 'chat', machine, chat, agent } : undefined;
    }
    case 'panel': {
      if (keys.length !== 2) return undefined;
      const panel = sanitizeTag(v.panel, MAX_NOTIFY_AGENT);
      return panel ? { kind: 'panel', panel } : undefined;
    }
    default:
      return undefined;
  }
}

/** Validates and normalizes notification options into a fresh plain object. */
export function parseNotificationOptions(v: unknown): DesktopNotificationOptions | undefined {
  if (!isPlainObject(v)) return undefined;
  for (const k of Object.keys(v)) {
    if (!OPTION_KEYS.has(k)) return undefined;
  }
  const title = cleanLine(v.title, MAX_NOTIFY_TITLE);
  if (!title) return undefined;
  const out: DesktopNotificationOptions = { title };
  if (v.body !== undefined) {
    if (typeof v.body !== 'string') return undefined;
    const body = cleanBody(v.body);
    if (body) out.body = body;
  }
  if (v.tag !== undefined) {
    const tag = sanitizeTag(v.tag);
    if (!tag) return undefined;
    out.tag = tag;
  }
  if (v.silent !== undefined) {
    if (typeof v.silent !== 'boolean') return undefined;
    out.silent = v.silent;
  }
  if (v.urgency !== undefined) {
    if (typeof v.urgency !== 'string' || !URGENCIES.has(v.urgency)) return undefined;
    out.urgency = v.urgency as DesktopNotificationOptions['urgency'];
  }
  if (v.target !== undefined) {
    const target = parseNotificationTarget(v.target);
    if (!target) return undefined;
    out.target = target;
  }
  return out;
}

export interface NativeNotificationHandle {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown;
  show(): void;
  close(): void;
}

export interface NotificationDeps {
  isSupported(): boolean;
  create(opts: { title: string; body?: string; silent?: boolean; urgency?: 'normal' | 'critical' | 'low' }): NativeNotificationHandle;
  showMain(): void;
  maxActive?: number;
}

/** Manages native Electron notifications, deduplicating by tag and queuing
 * click targets until the main page is ready to receive them. */
export function createNotifications(deps: NotificationDeps) {
  const maxActive = deps.maxActive ?? MAX_ACTIVE_NOTIFICATIONS;
  const active = new Map<string, NativeNotificationHandle>();
  const pendingClicks: NotificationTarget[] = [];
  let sendClick: ((target: NotificationTarget) => void) | undefined;
  let seq = 0;

  function deliverClicks() {
    if (!sendClick) return;
    for (const target of pendingClicks.splice(0)) sendClick(target);
  }

  function enqueueClick(target: NotificationTarget) {
    if (pendingClicks.length >= maxActive) pendingClicks.shift();
    pendingClicks.push(target);
    deliverClicks();
  }

  function removeHandle(key: string, handle: NativeNotificationHandle) {
    if (active.get(key) === handle) active.delete(key);
  }

  return {
    supported(): boolean {
      try {
        return deps.isSupported();
      } catch {
        return false;
      }
    },

    show(raw: unknown): boolean {
      const opts = parseNotificationOptions(raw);
      if (!opts) return false;
      try {
        if (!deps.isSupported()) return false;
      } catch {
        return false;
      }
      const key = opts.tag ?? `__anon_${++seq}`;
      if (opts.tag) {
        const prev = active.get(opts.tag);
        if (prev) {
          active.delete(opts.tag);
          try {
            prev.close();
          } catch {}
        }
      }
      if (active.size >= maxActive) {
        const oldestKey = active.keys().next().value;
        if (oldestKey !== undefined) {
          const oldest = active.get(oldestKey);
          active.delete(oldestKey);
          try {
            oldest?.close();
          } catch {}
        }
      }
      let handle: NativeNotificationHandle;
      try {
        handle = deps.create({
          title: opts.title,
          ...(opts.body !== undefined ? { body: opts.body } : {}),
          ...(opts.silent !== undefined ? { silent: opts.silent } : {}),
          ...(opts.urgency !== undefined ? { urgency: opts.urgency } : {}),
        });
      } catch {
        return false;
      }
      active.set(key, handle);
      handle.on('click', () => {
        removeHandle(key, handle);
        deps.showMain();
        if (opts.target) enqueueClick(opts.target);
      });
      handle.on('close', () => removeHandle(key, handle));
      handle.on('failed', () => removeHandle(key, handle));
      try {
        handle.show();
        return true;
      } catch {
        removeHandle(key, handle);
        return false;
      }
    },

    close(rawTag: unknown): void {
      const tag = sanitizeTag(rawTag);
      if (!tag) return;
      const handle = active.get(tag);
      if (!handle) return;
      active.delete(tag);
      try {
        handle.close();
      } catch {}
    },

    closeAll(): void {
      const handles = [...active.values()];
      active.clear();
      for (const h of handles) {
        try {
          h.close();
        } catch {}
      }
    },

    takenBy(send: ((target: NotificationTarget) => void) | undefined): void {
      sendClick = send;
      deliverClicks();
    },

    /** Exposed for tests. */
    activeCount(): number {
      return active.size;
    },
  };
}
