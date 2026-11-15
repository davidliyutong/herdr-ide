import { useEffect, useState } from 'react';
import { Server, X } from 'lucide-react';
import { useStore } from '../state/store';
import { actions } from '../actions';
import { t } from '../i18n';
import { validTarget } from '../lib/machine';

export interface AddMachineForm {
  target: string;
  label: string;
}

/** A Host alias of the core host's ssh configuration (GET /api/ssh/hosts). */
export interface SSHHost {
  alias: string;
  hostname?: string;
  user?: string;
}

/** Why the form cannot be sent, as the core checks it too: a target is an
 * ssh destination that does not read as an option and holds no whitespace,
 * control character or shell metacharacter (validTarget). */
export function addMachineProblem(f: AddMachineForm): 'target' | undefined {
  return validTarget(f.target.trim()) ? undefined : 'target';
}

/** What a host connects to, as shown beside its alias: user@hostname. */
export function hostDetail(h: SSHHost): string {
  const host = h.hostname && h.hostname !== h.alias ? h.hostname : '';
  return h.user ? `${h.user}@${host || h.alias}` : host;
}

/** The hosts offered for what is typed: all of them for nothing typed,
 * else those whose alias starts with it, then those whose alias, host name
 * or user holds it; none once the alias is typed out. */
export function matchHosts(hosts: readonly SSHHost[], typed: string): SSHHost[] {
  const q = typed.trim().toLowerCase();
  if (!q) return [...hosts];
  if (hosts.some((h) => h.alias.toLowerCase() === q)) return [];
  const starts = hosts.filter((h) => h.alias.toLowerCase().startsWith(q));
  const holds = hosts.filter(
    (h) => !starts.includes(h) && [h.alias, h.hostname ?? '', h.user ?? ''].some((v) => v.toLowerCase().includes(q)),
  );
  return [...starts, ...holds];
}

/** The core host's ssh aliases that are no machine yet; none when the core
 * cannot say. */
async function loadHosts(): Promise<SSHHost[]> {
  try {
    const r = await fetch('/api/ssh/hosts');
    const list = r.ok ? ((await r.json()) as unknown) : [];
    return Array.isArray(list) ? list.filter((h): h is SSHHost => typeof h?.alias === 'string') : [];
  } catch {
    return [];
  }
}

/** Adds an SSH machine to the core's machines: it appears in the sidebar
 * and connects; one that needs a password, a key's passphrase or a host
 * key confirmed opens the authentication terminal (docs/features/02). The
 * target is typed, or picked from the Host aliases of the core host's ssh
 * configuration, listed below the field and narrowed as one types. */
export function AddMachineDialog() {
  const open = useStore((s) => s.addMachine);
  const [form, setForm] = useState<AddMachineForm>({ target: '', label: '' });
  const [problem, setProblem] = useState<'target'>();
  const [sending, setSending] = useState(false);
  const [hosts, setHosts] = useState<SSHHost[]>([]);
  const [listed, setListed] = useState(true);
  const [sel, setSel] = useState(-1);
  // The list shows while the target field has the keyboard.
  const [focused, setFocused] = useState(true);
  const close = () => useStore.getState().openAddMachine(false);

  useEffect(() => {
    if (!open) return;
    setForm({ target: '', label: '' });
    setProblem(undefined);
    setSending(false);
    setListed(true);
    setSel(-1);
    setFocused(true);
    let live = true;
    void loadHosts().then((h) => live && setHosts(h));
    return () => {
      live = false;
    };
  }, [open]);

  if (!open) return null;
  const shown = listed && focused ? matchHosts(hosts, form.target) : [];
  const set = (k: keyof AddMachineForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [k]: e.target.value });
    setProblem(undefined);
    if (k === 'target') {
      setListed(true);
      setSel(-1);
    }
  };
  const pick = (h: SSHHost) => {
    setForm({ ...form, target: h.alias });
    setProblem(undefined);
    setListed(false);
    setSel(-1);
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
              role="combobox"
              aria-expanded={shown.length > 0}
              aria-controls="ssh-hosts"
              aria-autocomplete="list"
              value={form.target}
              placeholder={t('addMachine.targetPlaceholder')}
              onChange={set('target')}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && shown.length) {
                  e.preventDefault();
                  setSel((sel + 1) % shown.length);
                } else if (e.key === 'ArrowUp' && shown.length) {
                  e.preventDefault();
                  setSel((sel - 1 + shown.length) % shown.length);
                } else if (e.key === 'Tab' && !e.shiftKey && shown.length && (sel >= 0 || form.target.trim())) {
                  e.preventDefault();
                  pick(shown[Math.max(sel, 0)]);
                } else if (e.key === 'Enter' && sel >= 0 && shown[sel]) {
                  e.preventDefault();
                  pick(shown[sel]);
                } else enter(e);
              }}
            />
          </label>
          {shown.length > 0 && (
            <div className="dir-suggestions ssh-hosts" id="ssh-hosts" role="listbox" aria-label={t('addMachine.fromConfig')}>
              <div className="ssh-hosts-caption muted small">{t('addMachine.fromConfig')}</div>
              {shown.map((h, i) => (
                <div
                  key={h.alias}
                  role="option"
                  aria-selected={i === sel}
                  className={`dir-suggestion ${i === sel ? 'sel' : ''}`}
                  onMouseDown={(e) => (e.preventDefault(), pick(h))}
                >
                  <Server />
                  <span className="ellipsis">{h.alias}</span>
                  {hostDetail(h) && <span className="muted small ellipsis ssh-host-detail">{hostDetail(h)}</span>}
                </div>
              ))}
            </div>
          )}
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
