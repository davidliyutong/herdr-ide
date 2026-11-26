// The variables of an ssh machine's ssh session for its new terminals. A
// terminal core started as a service of the user does not pass them on,
// and programs take them as the sign that the user's clipboard and browser
// are not on the machine: Codex then also copies through the terminal
// (OSC 52), reads pastes from it and logs in with a device code. None for
// the local machine, where they would not be true, nor with the setting
// terminal.sshEnv off for the machine.
import { isIP } from 'node:net';

/** An IPv6 zone that may reach a terminal: an interface's name. */
const ZONE = /^[A-Za-z0-9._-]{1,32}$/;

/** Go's unicode.IsSpace, which strings.Fields splits at. */
const SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/** An address as Go's netip.ParseAddr takes one; a link-local address may
 * name its interface after "%", but only as an interface is called, since
 * a zone is any text. */
function validAddr(a: string): boolean {
  const pct = a.indexOf('%');
  if (pct < 0) return isIP(a) !== 0;
  return isIP(a.slice(0, pct)) === 6 && ZONE.test(a.slice(pct + 1));
}

/** A port as strconv.Atoi reads one, in range. */
const validPort = (p: string): boolean => /^[+-]?[0-9]+$/.test(p) && Number(p) >= 0 && Number(p) <= 65535;

/** SSH_CONNECTION ("client port server port") as the two variables; null
 * for anything else, so that only addresses and ports reach a terminal's
 * environment. */
export function sshEnv(conn: string): Record<string, string> | null {
  if (Buffer.byteLength(conn, 'utf8') > 200) return null;
  const f = conn.split(SPACE).filter((x) => x !== '');
  if (f.length !== 4) return null;
  for (let i = 0; i < 4; i++) if (i % 2 === 0 ? !validAddr(f[i]) : !validPort(f[i])) return null;
  return { SSH_CONNECTION: f.join(' '), SSH_CLIENT: `${f[0]} ${f[1]} ${f[3]}` };
}
