import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { currentAppearance } from '../appearance';
import { getPrefs } from '../prefs';
import { TermPane, type TermLink } from '../vt/pane';
import type { AttachOptions, StreamHandler } from '../term/connection';
import { t } from '../i18n';
import { openChannel } from '../lib/transport';

/** A PTY on the core host behind a WebSocket, as a terminal's stream: the
 * output in messages, input sent as it is. The PTY gets its size when it
 * starts. */
export class PtyLink implements TermLink {
  readonly connected = true;
  private ws?: WebSocket;

  /** path gives the channel's path (with its query) for the PTY's size. */
  constructor(private readonly path: (cols: number, rows: number) => string) {}

  attach(o: AttachOptions, handler: StreamHandler): Promise<number> {
    const ws = openChannel(this.path(o.cols, o.rows));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const enc = new TextEncoder();
    ws.onmessage = (e) => handler.output(typeof e.data === 'string' ? enc.encode(e.data) : new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = () => handler.closed('exited');
    return Promise.resolve(1);
  }

  write(_s: number, data: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(new Uint8Array(data));
  }

  ack() {}
  resize() {}
  focus() {}

  detach() {
    this.ws?.close();
  }
}

/** Interactive ssh authentication for a machine, run in a PTY on the core
 * host; the resulting ControlMaster is reused by later connections. */
export function AuthDialog() {
  const m = useStore((s) => s.auth);
  const label = useStore((s) => (s.auth ? s.machines[s.auth]?.label : undefined));
  const status = useStore((s) => (s.auth ? s.machines[s.auth]?.status : undefined));
  const close = () => useStore.getState().openAuth(undefined);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    if (status === 'ready') close();
  }, [status]);

  useEffect(() => {
    if (!m || !hostRef.current) return;
    setEnded(false);
    const link = new PtyLink((cols, rows) => `/api/m/${encodeURIComponent(m)}/auth?cols=${cols}&rows=${rows}`);
    const pane = new TermPane(
      hostRef.current,
      canvasRef.current!,
      inputRef.current!,
      {
        m,
        address: '',
        connection: link,
        onConnection: () => () => {},
        readOnly: () => false,
        appKey: () => false,
        activate: () => {},
        linkContext: () => ({ m }),
        mathHover: () => false,
        copyOnSelect: () => getPrefs().copyOnSelect,
        scrollback: () => 1000,
        setTitle: () => {},
        onFind: () => {},
        // The core connects the machine again when the terminal ends.
        onClosed: () => setEnded(true),
        onBell: () => {},
      },
      currentAppearance(),
    );
    pane.focus();
    return () => pane.dispose();
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
        <div className="muted small pad">{ended ? t('auth.ended') : t('auth.hint')}</div>
        <div className="auth-term term-host" ref={hostRef}>
          <canvas ref={canvasRef} className="term-canvas" />
          <textarea
            ref={inputRef}
            className="term-input"
            aria-label={t('surface.input')}
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  );
}
