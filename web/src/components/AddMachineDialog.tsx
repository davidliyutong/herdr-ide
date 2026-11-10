import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useStore } from '../state/store';
import { termOptions } from '../terminal/options';
import { currentAppearance } from '../appearance';
import { t } from '../i18n';

export interface AddMachineForm {
  target: string;
  label: string;
  session: string;
}

/** Why the form cannot be sent, as the core checks it too: a target is an
 * ssh destination without spaces that does not read as an option, a session
 * a plain name. */
export function addMachineProblem(f: AddMachineForm): 'target' | 'session' | undefined {
  const target = f.target.trim();
  if (!target || target.startsWith('-') || /[^\x21-\x7e]/.test(target) || target.length > 255) return 'target';
  const session = f.session.trim();
  if (session && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(session)) return 'session';
  return undefined;
}

/** The query of the terminal that runs herdr machine add. */
export function addMachineQuery(f: AddMachineForm, cols: number, rows: number): string {
  const q = new URLSearchParams({ target: f.target.trim(), cols: String(cols), rows: String(rows) });
  if (f.label.trim()) q.set('label', f.label.trim());
  if (f.session.trim()) q.set('session', f.session.trim());
  return q.toString();
}

/** Adds an SSH machine the way herdr does it: a terminal on the core host
 * runs the local herdr's `herdr machine add`, which checks the machine over
 * ssh, prepares its herdr server and saves it with herdr's machines,
 * asking in the terminal when it needs to. The machine then appears in the
 * sidebar and connects (docs/features/02). */
export function AddMachineDialog() {
  const open = useStore((s) => s.addMachine);
  const localVersion = useStore((s) => Object.values(s.machines).find((x) => x.kind === 'local')?.info?.herdr_version);
  const [form, setForm] = useState<AddMachineForm>({ target: '', label: '', session: '' });
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<'target' | 'session'>();
  const hostRef = useRef<HTMLDivElement>(null);
  const close = () => useStore.getState().openAddMachine(false);

  useEffect(() => {
    if (!open) return;
    setForm({ target: '', label: '', session: '' });
    setRunning(false);
    setProblem(undefined);
  }, [open]);

  useEffect(() => {
    if (!open || !running || !hostRef.current) return;
    const term = new Terminal({ ...termOptions(currentAppearance()), scrollback: 2000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/machines/add?${addMachineQuery(form, term.cols, term.rows)}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    ws.onclose = (e) => {
      // The core names the machine herdr saved: "added <id>", or "none".
      const added = e.reason.startsWith('added ');
      const msg = added ? t('addMachine.added') : e.reason === 'none' ? t('addMachine.notAdded') : t('addMachine.ended');
      term.write(`\r\n\x1b[${added ? '32' : '2'}m${msg}\x1b[0m\r\n`);
      if (added) useStore.getState().toast(t('addMachine.addedToast', { machine: form.label.trim() || form.target.trim() }));
    };
    const d = term.onData((s) => ws.readyState === WebSocket.OPEN && ws.send(s));
    term.focus();
    return () => {
      d.dispose();
      ws.close();
      term.dispose();
    };
    // The form is fixed while the terminal runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, running]);

  if (!open) return null;
  const set = (k: keyof AddMachineForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [k]: e.target.value });
    setProblem(undefined);
  };
  const start = () => {
    const p = addMachineProblem(form);
    if (p) setProblem(p);
    else setRunning(true);
  };
  const enter = (e: React.KeyboardEvent) => e.key === 'Enter' && localVersion && start();
  const title = t('addMachine.title');
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && close()}>
      <div className={running ? 'modal' : 'modal dialog'} role="dialog" aria-label={title}>
        <div className="modal-head">
          <span className="modal-title">{running ? t('addMachine.titleRunning', { target: form.target.trim() }) : title}</span>
          <span className="spacer" />
          <button className="icon" title={t('dialog.cancel')} onClick={close}>
            <X />
          </button>
        </div>
        {running ? (
          <>
            <div className="muted small pad">{t('addMachine.hint')}</div>
            <div className="auth-term" ref={hostRef} />
          </>
        ) : (
          <>
            <div
              className="dialog-body form"
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') close();
              }}
            >
              <label>
                <span>{t('addMachine.target')}</span>
                <input
                  autoFocus
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={form.target}
                  placeholder={t('addMachine.targetPlaceholder')}
                  onChange={set('target')}
                  onKeyDown={enter}
                />
              </label>
              {problem === 'target' && <div className="error small">{t('addMachine.badTarget')}</div>}
              <label>
                <span>{t('addMachine.label')}</span>
                <input
                  spellCheck={false}
                  value={form.label}
                  placeholder={t('addMachine.labelPlaceholder')}
                  onChange={set('label')}
                  onKeyDown={enter}
                />
              </label>
              <label>
                <span>{t('addMachine.session')}</span>
                <input
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={form.session}
                  placeholder={t('addMachine.sessionPlaceholder')}
                  onChange={set('session')}
                  onKeyDown={enter}
                />
              </label>
              {problem === 'session' && <div className="error small">{t('addMachine.badSession')}</div>}
              <div className="muted small">{t('addMachine.explain')}</div>
              {!localVersion && <div className="error small">{t('remoteHerdr.noLocal')}</div>}
            </div>
            <div className="dialog-actions">
              <button onClick={close}>{t('dialog.cancel')}</button>
              <button className="primary" disabled={!localVersion} onClick={start}>
                {t('addMachine.start')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
