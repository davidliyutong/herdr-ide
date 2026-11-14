import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../state/store';
import { actions } from '../actions';
import { t } from '../i18n';

export interface AddMachineForm {
  target: string;
  label: string;
}

/** Why the form cannot be sent, as the core checks it too: a target is an
 * ssh destination without spaces that does not read as an option. */
export function addMachineProblem(f: AddMachineForm): 'target' | undefined {
  const target = f.target.trim();
  if (!target || target.startsWith('-') || /[^\x21-\x7e]/.test(target) || target.length > 255) return 'target';
  return undefined;
}

/** Adds an SSH machine to the core's machines: it appears in the sidebar
 * and connects; one that needs a password, a key's passphrase or a host
 * key confirmed opens the authentication terminal (docs/features/02). */
export function AddMachineDialog() {
  const open = useStore((s) => s.addMachine);
  const [form, setForm] = useState<AddMachineForm>({ target: '', label: '' });
  const [problem, setProblem] = useState<'target'>();
  const [sending, setSending] = useState(false);
  const close = () => useStore.getState().openAddMachine(false);

  useEffect(() => {
    if (!open) return;
    setForm({ target: '', label: '' });
    setProblem(undefined);
    setSending(false);
  }, [open]);

  if (!open) return null;
  const set = (k: keyof AddMachineForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [k]: e.target.value });
    setProblem(undefined);
  };
  const add = async () => {
    const p = addMachineProblem(form);
    if (p) return setProblem(p);
    setSending(true);
    if (await actions.addMachine(form)) close();
    else setSending(false);
  };
  const enter = (e: React.KeyboardEvent) => e.key === 'Enter' && !sending && void add();
  const title = t('addMachine.title');
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal dialog" role="dialog" aria-label={title}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <span className="spacer" />
          <button className="icon" title={t('dialog.cancel')} onClick={close}>
            <X />
          </button>
        </div>
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
          <div className="muted small">{t('addMachine.explain')}</div>
        </div>
        <div className="dialog-actions">
          <button onClick={close}>{t('dialog.cancel')}</button>
          <button className="primary" disabled={sending} onClick={() => void add()}>
            {t('addMachine.start')}
          </button>
        </div>
      </div>
    </div>
  );
}
