import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../state/store';
import { confirmDialog } from '../dialog';
import { herdrRequest, isNewer, type HerdrAction, type LocalHerdr } from '../lib/localHerdr';
import { APP_NAME } from '../brand';
import { hasMessage, t, type MessageKey } from '../i18n';

/** Manages the core host's herdr: its server and, for the application's own
 * copy, updates through herdr's updater (docs/features/17). */
export function HerdrDialog() {
  const m = useStore((s) => s.herdr);
  const [st, setSt] = useState<LocalHerdr>();
  const [busy, setBusy] = useState<HerdrAction | 'status'>();
  const close = () => useStore.getState().openHerdr(undefined);

  const run = async (action?: HerdrAction) => {
    if (!m) return;
    setBusy(action ?? 'status');
    const next = await herdrRequest(m, action);
    setBusy(undefined);
    // A check's result stays until the dialog closes.
    setSt((prev) => ({ ...next, latest: next.latest ?? prev?.latest }));
  };

  const stop = async (restart: boolean) => {
    const ok = await confirmDialog({
      title: t(restart ? 'herdr.restartTitle' : 'herdr.stopTitle'),
      message: t('herdr.stopMessage'),
      confirm: t(restart ? 'herdr.restart' : 'herdr.stop'),
      danger: true,
    });
    if (!ok) return;
    await run('stop');
    if (restart) await run('start');
  };

  useEffect(() => {
    setSt(undefined);
    if (m) void run();
  }, [m]);

  if (!m) return null;
  const error = st?.error
    ? hasMessage(`herdr.error.${st.error}`)
      ? t(`herdr.error.${st.error}` as MessageKey)
      : t('herdr.error.transport')
    : '';
  const updatable = !!st?.managed && isNewer(st.latest, st.version);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div
        className="modal dialog"
        role="dialog"
        aria-label={t('herdr.title')}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' && !busy) close();
        }}
      >
        <div className="modal-head">
          <span className="modal-title">{t('herdr.title')}</span>
          <span className="spacer" />
          <button className="icon" title={t('dialog.cancel')} disabled={!!busy} onClick={close}>
            <X />
          </button>
        </div>
        <div className="dialog-body herdr-info">
          {!st ? (
            <div className="muted">{t('herdr.loading')}</div>
          ) : (
            <>
              {st.bin && (
                <div>
                  <div>{st.version ? t('herdr.version', { version: st.version }) : 'herdr'}</div>
                  <div className="small muted ellipsis" title={st.bin}>
                    {st.bin}
                  </div>
                  <div className="small muted">{st.managed ? t('herdr.managed', { app: APP_NAME }) : t('herdr.installed')}</div>
                </div>
              )}
              {st.bin && (
                <div>
                  {st.running
                    ? st.server_version
                      ? t('herdr.running', { version: st.server_version })
                      : t('herdr.runningAny')
                    : t('herdr.stopped')}
                  {st.restart_needed && <div className="small warn">{t('herdr.restartNeeded')}</div>}
                </div>
              )}
              {st.managed && st.latest && !st.error && (
                <div>{updatable ? t('herdr.available', { version: st.latest }) : t('herdr.upToDate')}</div>
              )}
              {busy && busy !== 'status' && <div className="muted">{t(`herdr.busy.${busy}`)}</div>}
              {error && <div className="error-text">{error}</div>}
              {st.output && <pre className="herdr-output">{st.output}</pre>}
            </>
          )}
        </div>
        <div className="dialog-actions">
          {st?.managed && (
            <button disabled={!!busy} onClick={() => void run('check')}>
              {t('herdr.check')}
            </button>
          )}
          {updatable && (
            <button className="primary" disabled={!!busy} onClick={() => void run('update')}>
              {t('herdr.update')}
            </button>
          )}
          {st?.bin &&
            (st.running ? (
              <>
                {st.restart_needed && (
                  <button disabled={!!busy} onClick={() => void stop(true)}>
                    {t('herdr.restart')}
                  </button>
                )}
                <button disabled={!!busy} onClick={() => void stop(false)}>
                  {t('herdr.stop')}
                </button>
              </>
            ) : (
              <button className="primary" autoFocus disabled={!!busy} onClick={() => void run('start')}>
                {t('herdr.start')}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
