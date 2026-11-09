import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useStore } from '../state/store';
import { termOptions } from '../terminal/options';
import { currentAppearance } from '../appearance';
import { t } from '../i18n';
import { herdrMissing } from '../lib/localHerdr';

/** Updates herdr on an SSH machine the way herdr does it, or installs it
 * where it is missing (removed, moved or never installed): a terminal on the
 * core host runs the local herdr's `herdr --remote <target>`, which asks
 * before installing its version there and before replacing a running server,
 * then attaches (docs/features/17). */
export function RemoteHerdrDialog() {
  const m = useStore((s) => s.remoteHerdr);
  const machine = useStore((s) => (s.remoteHerdr ? s.machines[s.remoteHerdr] : undefined));
  const localVersion = useStore((s) => Object.values(s.machines).find((x) => x.kind === 'local')?.info?.herdr_version);
  const [running, setRunning] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const close = () => useStore.getState().openRemoteHerdr(undefined);

  useEffect(() => {
    setRunning(false);
    setHandoff(false);
  }, [m]);

  useEffect(() => {
    if (!m || !running || !hostRef.current) return;
    const term = new Terminal({ ...termOptions(currentAppearance()), scrollback: 2000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = `cols=${term.cols}&rows=${term.rows}&handoff=${handoff ? 1 : 0}`;
    const ws = new WebSocket(`${proto}//${location.host}/api/m/${encodeURIComponent(m)}/herdr/remote?${q}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    ws.onclose = () => term.write(`\r\n\x1b[2m${t('remoteHerdr.ended')}\x1b[0m\r\n`);
    const d = term.onData((s) => ws.readyState === WebSocket.OPEN && ws.send(s));
    term.focus();
    return () => {
      d.dispose();
      ws.close();
      term.dispose();
    };
  }, [m, running]);

  if (!m || !machine) return null;
  const missing = herdrMissing(machine);
  const title = t(missing ? 'remoteHerdr.titleInstall' : 'remoteHerdr.title', { machine: machine.label });
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && close()}>
      <div className={running ? 'modal' : 'modal dialog'} role="dialog" aria-label={title}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <span className="spacer" />
          <button className="icon" title={t('dialog.cancel')} onClick={close}>
            <X />
          </button>
        </div>
        {running ? (
          <>
            <div className="muted small pad">{t('remoteHerdr.hint')}</div>
            <div className="auth-term" ref={hostRef} />
          </>
        ) : (
          <>
            <div
              className="dialog-body herdr-info"
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') close();
              }}
            >
              <div>
                {t('remoteHerdr.versions', {
                  remote: missing ? t('remoteHerdr.missing') : machine.info?.herdr_version || t('remoteHerdr.unknown'),
                  local: localVersion || t('remoteHerdr.unknown'),
                })}
              </div>
              <div>
                {t(missing ? 'remoteHerdr.explainInstall' : 'remoteHerdr.explain', {
                  version: localVersion || t('remoteHerdr.unknown'),
                })}
              </div>
              {/* Only a running server has terminals to keep. */}
              {(!missing || machine.status === 'ready') && (
                <label className="row">
                  <input type="checkbox" checked={handoff} onChange={(e) => setHandoff(e.target.checked)} />
                  <span>{t('remoteHerdr.handoff')}</span>
                </label>
              )}
              {!localVersion && <div className="error-text">{t('remoteHerdr.noLocal')}</div>}
            </div>
            <div className="dialog-actions">
              <button onClick={close}>{t('dialog.cancel')}</button>
              <button className="primary" autoFocus disabled={!localVersion} onClick={() => setRunning(true)}>
                {t('remoteHerdr.start')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
