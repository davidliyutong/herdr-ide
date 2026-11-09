import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../state/store';
import { confirmDialog } from '../dialog';
import { herdrError, herdrRequest, isNewer, type HerdrAction, type MachineHerdr } from '../lib/localHerdr';
import { APP_NAME } from '../brand';
import { t } from '../i18n';

/** Manages a machine's herdr: its server and, for the application's own copy
 * on the core host, updates through herdr's updater (docs/features/17). */
export function HerdrDialog() {
  const m = useStore((s) => s.herdr);
  const machine = useStore((s) => (s.herdr ? s.machines[s.herdr] : undefined));
  const local = machine?.kind === 'local';
  const [st, setSt] = useState<MachineHerdr>();
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
      message: local ? t('herdr.stopMessage') : t('herdr.stopMessageMachine', { machine: machine?.label ?? m ?? '' }),
      confirm: t(restart ? 'herdr.restart' : 'herdr.stop'),
      danger: true,
    });
    if (!ok) return;
    await run(restart ? 'restart' : 'stop');
  };

  useEffect(() => {
    setSt(undefined);
    if (m) void run();
  }, [m]);

  if (!m) return null;
  // No herdr executable there (removed, moved or never installed): nothing
  // can start or stop a server; on an SSH machine herdr --remote installs it.
  const missing = !!st && !st.bin && st.error === 'not_found';
  const install = () => {
    close();
    useStore.getState().openRemoteHerdr(m);
  };
  const error = missing && !local ? t('herdr.notFoundMachine', { machine: machine?.label ?? m }) : herdrError(st);
  // Only the core host's own copy is updated here; SSH machines update
  // through herdr --remote (the machine's Update herdr).
  const managed = local && !!st?.managed;
  const updatable = managed && isNewer(st?.latest, st?.version);
  const title = local ? t('herdr.title') : t('herdr.titleMachine', { machine: machine?.label ?? m });
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div
        className="modal dialog"
        role="dialog"
        aria-label={title}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' && !busy) close();
        }}
      >
        <div className="modal-head">
          <span className="modal-title">{title}</span>
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
                  {local && <div className="small muted">{managed ? t('herdr.managed', { app: APP_NAME }) : t('herdr.installed')}</div>}
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
              {missing && st.running && (
                <div>
                  {t('herdr.runningAny')}
                  <div className="small warn">{t('herdr.runningWithoutBin')}</div>
                </div>
              )}
              {managed && st.latest && !st.error && (
                <div>{updatable ? t('herdr.available', { version: st.latest }) : t('herdr.upToDate')}</div>
              )}
              {busy && busy !== 'status' && <div className="muted">{t(`herdr.busy.${busy}`)}</div>}
              {error && <div className="error-text">{error}</div>}
              {st.output && <pre className="herdr-output">{st.output}</pre>}
            </>
          )}
        </div>
        <div className="dialog-actions">
          {missing && (
            <button disabled={!!busy} onClick={() => void run()}>
              {t('herdr.recheck')}
            </button>
          )}
          {missing && !local && (
            <button className="primary" autoFocus disabled={!!busy} onClick={install}>
              {t('herdr.install')}
            </button>
          )}
          {managed && (
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
                <button className={st.restart_needed ? 'primary' : undefined} disabled={!!busy} onClick={() => void stop(true)}>
                  {t('herdr.restart')}
                </button>
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
