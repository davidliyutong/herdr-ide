import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useStore } from '../state/store';
import { conn } from '../lib/conn';
import { fontFamily, theme } from '../terminal/TermController';
import { t } from '../i18n';

/** Interactive ssh authentication for a machine, run in a PTY on the core
 * host; the resulting ControlMaster is reused by later connections. */
export function AuthDialog() {
  const m = useStore((s) => s.auth);
  const label = useStore((s) => (s.auth ? s.machines[s.auth]?.label : undefined));
  const status = useStore((s) => (s.auth ? s.machines[s.auth]?.status : undefined));
  const close = () => useStore.getState().openAuth(undefined);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status === 'ready') close();
  }, [status]);

  useEffect(() => {
    if (!m || !hostRef.current) return;
    const term = new Terminal({ fontFamily, fontSize: 13, theme, scrollback: 1000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/m/${encodeURIComponent(m)}/auth?cols=${term.cols}&rows=${term.rows}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    ws.onclose = () => {
      term.write(`\r\n\x1b[2m${t('auth.ended')}\x1b[0m\r\n`);
      conn.retry(m);
    };
    const d = term.onData((s) => ws.readyState === WebSocket.OPEN && ws.send(s));
    term.focus();
    return () => {
      d.dispose();
      ws.close();
      term.dispose();
    };
  }, [m]);

  if (!m) return null;
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {t('auth.title', { machine: label ?? '' })}
          <span className="spacer" />
          <button className="icon" onClick={close}>
            ✕
          </button>
        </div>
        <div className="muted small pad">{t('auth.hint')}</div>
        <div className="auth-term" ref={hostRef} />
      </div>
    </div>
  );
}
