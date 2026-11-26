// The numbers of the coding agent's session in the focused terminal, for
// the status bar (SessionItem.tsx): read from the agent's machine (GET
// /api/m/{id}/p/usage/session) when the focused pane or its session
// changes, every 30 seconds while the agent is in a turn (working, or
// blocked on a question between its work) and once when it turns done or
// idle; a session is read at most once in 10 seconds, and never from a
// hidden page (the read is owed until the page shows again). A read is
// given up after SESSION_TIMEOUT_MS, and the one when the agent stopped is
// tried once more SESSION_RETRY_MS after it failed: nothing else reads the
// session until its agent works again. The answers are kept per machine,
// agent kind and session (useUsage.sessions), so that a pane focused again
// shows its last numbers at once. A session without a transcript yet
// (not_found) is read again at its agent's next status change, one whose
// sessions are not priced (bad_request) not again.
import { useEffect, useRef } from 'react';
import type { AgentStatus } from '../../lib/machine';
import { jsonBody } from '../../lib/pluginApi';
import { sessionUsageOf } from './model';
import { useUsage, type SessionCode, type SessionEntry } from './state';

/** A coding agent's session the status bar shows. */
export interface SessionTarget {
  m: string;
  /** The agent's kind (a detector id, agentkinds). */
  kind: string;
  /** Its session id (isSessionId), when known. */
  session?: string;
  /** Its working directory, for agents matched by cwd. */
  cwd?: string;
  /** The foreground process id (used on the machine to bound cwd matches). */
  pid?: number;
  /** The terminal address (disambiguates cached cwd entries). */
  terminal?: string;
  status?: AgentStatus;
}

/** The least time between two reads of a session (ms). */
export const SESSION_MIN_GAP = 10_000;

/** How often the session of an agent that works is read (ms). */
export const SESSION_WORKING_EVERY = 30_000;

/** How many sessions' numbers the page keeps. */
export const SESSION_KEEP = 64;

/** How long a read waits for the machine's answer (ms). */
export const SESSION_TIMEOUT_MS = 15_000;

/** How long after a final read failed it is tried again, once (ms). */
export const SESSION_RETRY_MS = 10_000;

/** How often a focused session whose transcript was not found yet is checked
 * again while its agent stays idle/unknown (ms). */
export const SESSION_NOT_FOUND_RECHECK_MS = 15_000;

/** The key of a session in useUsage.sessions. */
export const sessionKey = (m: string, kind: string, session: string): string => JSON.stringify([m, kind, session]);

/** The key of a SessionTarget (by session id when known, else cwd + pid/terminal). */
export const targetKey = (t: Pick<SessionTarget, 'm' | 'kind' | 'session' | 'cwd' | 'pid' | 'terminal'>): string =>
  t.session ? sessionKey(t.m, t.kind, t.session) : sessionKey(t.m, t.kind, `cwd:${t.cwd ?? ''}:${t.pid ?? t.terminal ?? ''}`);

/** The reads of a session: when the last began (ms), whether one is under
 * way and another must follow it, whether one waits for the page to show,
 * the read that waits for the gap, and the one more try of a final read
 * that failed. */
interface Slot {
  at: number;
  busy: boolean;
  again: boolean;
  owed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
}

const slots = new Map<string, Slot>();

function slotOf(key: string): Slot {
  let s = slots.get(key);
  if (s) return s;
  s = { at: 0, busy: false, again: false, owed: false };
  slots.set(key, s);
  // Those of sessions long gone, the oldest first; none with a read under
  // way or waiting.
  if (slots.size > SESSION_KEEP) {
    for (const [k, v] of slots) {
      if (slots.size <= SESSION_KEEP) break;
      if (k !== key && !v.busy && !v.timer && !v.retry) slots.delete(k);
    }
  }
  return s;
}

const shown = () => typeof document === 'undefined' || document.visibilityState === 'visible';

const CODES = new Set<string>(['not_found', 'provider_off', 'bad_request'] satisfies SessionCode[]);

/** Keeps an entry, and at most SESSION_KEEP of them: the oldest go. */
function put(key: string, e: SessionEntry) {
  useUsage.setState((s) => {
    const next = { ...s.sessions, [key]: e };
    const keys = Object.keys(next);
    if (keys.length > SESSION_KEEP) {
      keys.sort((a, b) => next[a].at - next[b].at);
      for (const k of keys.slice(0, keys.length - SESSION_KEEP)) delete next[k];
    }
    return { sessions: next };
  });
}

/** Reads a session's numbers into useUsage.sessions: whether the machine
 * answered. A failure without a code of its own (the machine offline, the
 * network, no answer within SESSION_TIMEOUT_MS) keeps what was known. */
async function load(t: SessionTarget, key: string): Promise<boolean> {
  const q = new URLSearchParams({ kind: t.kind });
  if (t.session) q.set('session', t.session);
  if (t.cwd) q.set('cwd', t.cwd);
  if (t.pid) q.set('pid', String(t.pid));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SESSION_TIMEOUT_MS);
  try {
    const r = await fetch(`/api/m/${encodeURIComponent(t.m)}/p/usage/session?${q}`, { signal: abort.signal });
    const j = await jsonBody(r);
    if (r.ok) {
      const usage = sessionUsageOf(j);
      if (usage) put(key, { usage, at: Date.now() });
      return !!usage;
    }
    if (typeof j.error === 'string' && CODES.has(j.error)) {
      put(key, { code: j.error as SessionCode, status: t.status, at: Date.now() });
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads session t unless the page is hidden (then the read is owed until
 * it shows), a read of it is under way, or it was read less than
 * SESSION_MIN_GAP ago. A final read (the agent stopped working) is not
 * dropped: it follows the read under way, or waits for the gap; and when
 * it fails it is tried once more SESSION_RETRY_MS later (retry is that
 * try). */
export function requestSession(t: SessionTarget, final = false, retry = false) {
  const key = targetKey(t);
  const s = slotOf(key);
  if (!shown()) {
    s.owed = true;
    return;
  }
  if (s.busy) {
    if (final) s.again = true;
    return;
  }
  const wait = s.at + SESSION_MIN_GAP - Date.now();
  if (wait > 0) {
    if (final && !s.timer) {
      s.timer = setTimeout(() => {
        s.timer = undefined;
        requestSession(t, true, retry);
      }, wait);
    }
    return;
  }
  s.owed = false;
  s.at = Date.now();
  s.busy = true;
  void load(t, key).then((ok) => {
    s.busy = false;
    if (s.again) {
      s.again = false;
      requestSession(t, true);
      return;
    }
    if (ok || !final || retry || s.retry) return;
    s.retry = setTimeout(() => {
      s.retry = undefined;
      requestSession(t, true, true);
    }, SESSION_RETRY_MS);
  });
}

/** Cancels the reads that wait for their gap or their one more try (the
 * status bar's item is gone). */
export function cancelSessionReads() {
  for (const s of slots.values()) {
    clearTimeout(s.timer);
    s.timer = undefined;
    clearTimeout(s.retry);
    s.retry = undefined;
  }
}

/** Forgets every session's reads: when they were and what is owed. */
export function resetSessionReads() {
  cancelSessionReads();
  slots.clear();
}

/** Whether the machine said the session's agent is one whose sessions are
 * not priced: it is not asked again. */
const unpriced = (key: string) => useUsage.getState().sessions[key]?.code === 'bad_request';

/** Keeps the numbers of session t current while the status bar shows it,
 * as the module's comment says. */
export function useSessionReads(t: SessionTarget | undefined) {
  const key = t ? targetKey(t) : undefined;
  const status = t?.status;
  const latest = useRef(t);
  latest.current = t;
  const seen = useRef<{ key?: string; status?: AgentStatus }>({});
  // The focused session, and its agent's status.
  useEffect(() => {
    const before = seen.current;
    seen.current = { key, status };
    const cur = latest.current;
    if (!cur || !key || unpriced(key)) return;
    const e = useUsage.getState().sessions[key];
    if (before.key !== key) {
      // Another pane or session: its numbers, unless the machine recently had
      // none and its agent did nothing since.
      const freshMiss = e?.code === 'not_found' && e.status === status && Date.now() - e.at < SESSION_NOT_FOUND_RECHECK_MS;
      if (!freshMiss) requestSession(cur);
    } else if (before.status !== status) {
      if (status === 'done' || status === 'idle') requestSession(cur, true);
      else if (e?.code) requestSession(cur);
    }
  }, [key, status]);
  // While the agent is in a turn: working, or blocked on a question
  // between its work, which an agent may alternate faster than the reads
  // come. A tick reads when it worked since the last one, so that one
  // blocked for long is not read again and again.
  const inTurn = status === 'working' || status === 'blocked';
  const notFound = useUsage((s) => (key ? s.sessions[key]?.code === 'not_found' : false));
  const worked = useRef(false);
  useEffect(() => {
    if (status === 'working') worked.current = true;
  }, [status]);
  useEffect(() => {
    if (!key || !inTurn) return;
    worked.current = latest.current?.status === 'working';
    const id = setInterval(() => {
      const cur = latest.current;
      const working = cur?.status === 'working';
      if (!cur || (!working && !worked.current) || unpriced(key)) return;
      worked.current = working;
      requestSession(cur);
    }, SESSION_WORKING_EVERY);
    return () => clearInterval(id);
  }, [key, inTurn]);
  // A focused terminal whose transcript was not written yet: re-check
  // periodically so fast turns or resumed sessions show up without waiting for
  // a status transition.
  useEffect(() => {
    if (!key || !notFound || inTurn) return;
    const id = setInterval(() => {
      const cur = latest.current;
      if (!cur || unpriced(key)) return;
      requestSession(cur);
    }, SESSION_NOT_FOUND_RECHECK_MS);
    return () => clearInterval(id);
  }, [key, notFound, inTurn]);
  // A read owed while the page was hidden.
  useEffect(() => {
    if (!key) return;
    const look = () => {
      const cur = latest.current;
      if (cur && shown() && slots.get(key)?.owed && !unpriced(key)) requestSession(cur, true);
    };
    document.addEventListener('visibilitychange', look);
    return () => document.removeEventListener('visibilitychange', look);
  }, [key]);
  useEffect(() => () => cancelSessionReads(), []);
}
