// The Full Disk Access row of the settings (the Terminal page's Permissions
// group; the desktop app on macOS only): whether terminals (herdr-core) and
// the file browser and VS Code (the app) have it, as the core finds them,
// read again whenever the window comes back to the front, as it does from
// System Settings; buttons for System Settings at the list and for
// herdr-core in Finder, and, while one of them lacks it, what to restart
// once it is turned on, with that action.

import { useEffect, useRef, useState } from 'react';
import { APP_NAME } from '../../brand';
import { actions } from '../../actions';
import { FDA_ROW, fetchPrivacy, relaunchApp, type Access, type PrivacyState } from '../../fullDiskAccess';
import { t } from '../../i18n';
import { desktopShell, type DesktopPrivacy } from '../../shell';
import { useStore } from '../../state/store';

/** Whether a settings search finds the row. */
export function fullDiskAccessMatches(q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const text = [t('fda.title'), t('fda.desc'), t('settings.group.permissions'), 'herdr-core'].join(' ').toLowerCase();
  return words.length > 0 && words.every((w) => text.includes(w));
}

const dot: Record<Access, string> = { granted: 'ms-ready', denied: 'ms-auth_required', unknown: '' };

function AccessState({ a }: { a?: Access }) {
  return (
    <span className="fda-state" data-access={a ?? ''}>
      <span className={`mstatus ${a ? dot[a] : ''}`} />
      {a ? t(`fda.${a}`) : '…'}
    </span>
  );
}

export function FullDiskAccess({ readOnly }: { readOnly: boolean }) {
  const m = useStore((s) => s.order.find((id) => s.machines[id]?.kind === 'local'));
  const privacy = desktopShell?.privacy;
  return privacy && m ? <FullDiskAccessRow m={m} privacy={privacy} readOnly={readOnly} /> : null;
}

function FullDiskAccessRow({ m, privacy, readOnly }: { m: string; privacy: DesktopPrivacy; readOnly: boolean }) {
  const ready = useStore((s) => s.machines[m]?.status === 'ready');
  const busy = useStore((s) => s.hcBusy[m] === true);
  const shown = useStore((s) => s.settings?.row === FDA_ROW);
  const [state, setState] = useState<PrivacyState>();
  // Bumped to read the state again after a restart.
  const [asked, setAsked] = useState(0);
  const row = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const load = () => void fetchPrivacy(m).then((p) => live && setState(p));
    load();
    window.addEventListener('focus', load);
    return () => {
      live = false;
      window.removeEventListener('focus', load);
    };
  }, [m, ready, asked]);
  useEffect(() => {
    if (shown) row.current?.scrollIntoView?.({ block: 'center' });
  }, [shown]);

  const granted = state?.terminals === 'granted' && state.files === 'granted';
  const terminalsDenied = state?.terminals === 'denied';
  const filesDenied = state?.files === 'denied';
  const restart = async () => {
    await actions.terminalCore(m, 'restart');
    setAsked((n) => n + 1);
  };
  return (
    <>
      <h4 className="settings-group">{t('settings.group.permissions')}</h4>
      <div className="setting" data-key={FDA_ROW} ref={row}>
        <div className="setting-head">
          <span className="setting-title">{t('fda.title')}</span>
        </div>
        <div className="setting-desc">{t('fda.desc')}</div>
        <div className="fda-access">
          <span>{t('fda.terminals')}</span>
          <code title={state?.hc || undefined}>herdr-core</code>
          <AccessState a={state?.terminals} />
          <span>{t('fda.files')}</span>
          <code>{APP_NAME}</code>
          <AccessState a={state?.files} />
        </div>
        {!granted && <div className="setting-desc">{t('fda.howTo', { app: APP_NAME })}</div>}
        <div className="setting-control row-gap">
          <button onClick={() => privacy.openFullDiskAccess()}>{t('fda.open')}</button>
          {state?.terminals !== 'granted' && <button onClick={() => privacy.revealTerminalCore()}>{t('fda.reveal')}</button>}
        </div>
        {(terminalsDenied || filesDenied) && (
          <div className="fda-after">
            {terminalsDenied && <div className="setting-desc">{t('fda.afterTerminals')}</div>}
            {filesDenied && <div className="setting-desc">{t('fda.afterFiles', { app: APP_NAME })}</div>}
            <div className="setting-control row-gap">
              {terminalsDenied && (
                <button disabled={!ready || readOnly || busy} onClick={() => void restart()}>
                  {t('menu.restartCore')}
                </button>
              )}
              {filesDenied && <button onClick={() => void relaunchApp()}>{t('fda.relaunch')}</button>}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
