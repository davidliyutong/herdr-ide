import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { GuiSession, type SessionStatus } from './session';
import { openGuiWindow, type GuiWindow } from './state';

/** The page of a browser window that shows one program window. */
export function GuiWindowPage({ m, id }: { m: string; id: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<SessionStatus>('connecting');
  const [blocked, setBlocked] = useState<GuiWindow[]>([]);

  useEffect(() => {
    let session: GuiSession | undefined;
    let cancelled = false;
    // Watchers (read-only mode) see the window but send no input.
    fetch('/api/config')
      .then((r) => r.json())
      .catch(() => ({}))
      .then((c: { read_only?: boolean }) => {
        if (cancelled || !host.current) return;
        session = new GuiSession(
          m,
          id,
          host.current,
          {
            status: setStatus,
            window: (w) => {
              document.title = w.title || t('gui.untitled');
            },
            child: (w) => {
              if (!openGuiWindow(m, w)) setBlocked((b) => [...b.filter((x) => x.id !== w.id), w]);
            },
          },
          !c.read_only,
        );
      });
    return () => {
      cancelled = true;
      session?.dispose();
    };
  }, [m, id]);

  useEffect(() => {
    if (status !== 'gone') return;
    const timer = setTimeout(() => window.close(), 1500);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <div className="gui-page">
      <div className="gui-host" ref={host} />
      {status !== 'open' && <div className="gui-overlay">{t(`gui.status.${status}`)}</div>}
      {blocked.length > 0 && (
        <div className="gui-banner">
          {blocked.map((w) => (
            <div key={w.id} className="gui-banner-row">
              <span className="ellipsis">{t('gui.dialogBlocked', { title: w.title || t('gui.untitled') })}</span>
              <button
                className="primary"
                onClick={() => {
                  if (openGuiWindow(m, w)) setBlocked((b) => b.filter((x) => x.id !== w.id));
                }}
              >
                {t('gui.open')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
