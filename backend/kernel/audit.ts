// The audit log (--audit-log): one JSON object per line for each
// security-relevant event (SECURITY.md), with who did it as far as the
// core can tell: the connection's address, the proxy's X-Forwarded-For and
// the user an authenticating proxy names in a header.

/** Who a request or channel comes from. */
export interface Who {
  remote?: string;
  forwardedFor?: string;
  user?: string;
}

/** The headers that name the authenticated user when --user-header does
 * not. */
const DEFAULT_USER_HEADERS = ['Tailscale-User-Login', 'X-Forwarded-User', 'X-Auth-Request-User', 'Remote-User', 'X-Forwarded-Email'];

/** Who sent a request with these headers over a connection from remote. */
export function whoOf(headers: Headers, remote: string | undefined, userHeader = ''): Who {
  const who: Who = {};
  if (remote) who.remote = remote;
  const fwd = headers.get('X-Forwarded-For');
  if (fwd) who.forwardedFor = fwd;
  for (const h of userHeader ? [userHeader] : DEFAULT_USER_HEADERS) {
    const v = headers.get(h);
    if (v) {
      who.user = v;
      break;
    }
  }
  return who;
}

export type AuditFields = Record<string, unknown>;

/** Records events; the default records nothing. */
export interface Audit {
  log(who: Who | null, event: string, fields?: AuditFields): void;
}

export const noAudit: Audit = { log() {} };

/** An audit log that writes lines with write (an append-only file's). The
 * members are sorted, as the Go core wrote them. */
export function auditLog(write: (line: string) => void, now: () => Date = () => new Date()): Audit {
  return {
    log(who, event, fields = {}) {
      const rec: AuditFields = { time: now().toISOString(), event };
      if (who?.remote) rec.remote = who.remote;
      if (who?.forwardedFor) rec.forwarded_for = who.forwardedFor;
      if (who?.user) rec.user = who.user;
      Object.assign(rec, fields);
      const sorted = Object.fromEntries(Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      write(JSON.stringify(sorted) + '\n');
    },
  };
}
