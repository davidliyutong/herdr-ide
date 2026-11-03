import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { GuiSession, type SessionStatus } from './session';
import { openGuiWindow, type GuiWindow } from './state';
import type { StatsView } from './stats';

const wantsStats = () => location.hash === '#stats';

/** The page of a browser window that shows one program window. */
export function GuiWindowPage({ m, id }: { m: string; id: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<SessionStatus>('connecting');
  const [blocked, setBlocked] = useState<GuiWindow[]>([]);
  const [stats, setStats] = useState<StatsView | undefined>();
  const showStats = useRef(wantsStats());

  useEffect(() => {
    const changed = () => {
      showStats.current = wantsStats();
      if (!showStats.current) setStats(undefined);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);

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
            stats: (s) => {
              if (showStats.current) setStats(s);
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
      {stats && <StatsPanel s={stats} />}
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

const f1 = (v: number) => v.toFixed(1);

/** Frame statistics (#stats in the address). */
function StatsPanel({ s }: { s: StatsView }) {
  const m = s.machine;
  return (
    <div className="gui-stats">
      <div>
        {t('gui.stats.browser', {
          fps: f1(s.fps),
          kb: f1(s.kbPerFrame),
          mbps: f1(s.mbps),
          decode: f1(s.decodeMs),
          draw: f1(s.drawMs),
          skipped: f1(s.skipped),
        })}
      </div>
      {m ? (
        <>
          <div>
            {t('gui.stats.machine', {
              ups: f1(m.ups),
              fps: f1(m.fps),
              mpx: f1(m.mpx),
              capture: f1(m.captureMs),
              convert: f1(m.convertMs),
              encode: f1(m.encodeMs),
              jpeg: m.jpeg,
              png: m.png,
            })}
          </div>
          <div>{t('gui.stats.flow', { latency: f1(m.latencyMs), waits: f1(m.waits) })}</div>
          {m.encoder && <div>{t('gui.stats.video', { encoder: m.encoder, fps: f1(m.video) })}</div>}
          {m.fallback && <div>{t('gui.stats.fallback', { reason: t(`gui.stats.fallback.${m.fallback}`) })}</div>}
        </>
      ) : (
        <div>{t('gui.stats.noMachine')}</div>
      )}
    </div>
  );
}
