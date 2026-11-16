// The variable vault's panel in the right sidebar. At the top, the gate:
// creating the vault's passphrase, unlocking this page's session with it,
// or the session's bar with the lock. Then requests waiting for
// an answer and three tabs: the variables (never their values, except one
// revealed on request; an editor in a dialog), the access log (filtered by
// machine and outcome, by day) and how to connect a coding agent's CLI on
// each machine.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Copy,
  Eye,
  EyeOff,
  History,
  KeyRound,
  Lock,
  LockOpen,
  Monitor,
  Pencil,
  Plug,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Variable as VariableIcon,
  X,
} from 'lucide-react';
import { useStore } from '../../state/store';
import { confirmDialog } from '../../dialog';
import { hasMessage, t } from '../../i18n';
import {
  errorText,
  loadErrorText,
  loadRequests,
  loadVault,
  lockVault,
  openSession,
  processText,
  setPassphrase,
  useVault,
  vaultApi,
  type VaultAccess,
  type VaultVariable,
} from './api';
import { RequestCard } from './Approvals';
import { setupSnippets } from './setup';
import './vault.css';

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

type Tab = 'variables' | 'log' | 'connect';

/** Why the vault did not load (its file of another version or unreadable,
 * the core unreachable), with a retry: a file moved away or put back is
 * opened at the next load. */
function LoadError({ code }: { code: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="callout error vault-load-error" role="alert" data-error={code}>
      <span>{loadErrorText(code)}</span>
      <button
        className="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void Promise.all([loadVault(), loadRequests()]).finally(() => setBusy(false));
        }}
      >
        {t('vault.retry')}
      </button>
    </div>
  );
}

export function VaultPanel() {
  const { status, variables, error, requests, session } = useVault();
  const [tab, setTab] = useState<Tab>('variables');
  useEffect(() => {
    void loadVault();
    void loadRequests();
  }, []);
  if (error === 'unavailable') return <div className="empty-note">{t('vault.unavailable')}</div>;
  if (!status) return error ? <LoadError code={error} /> : null;
  const pending = Object.values(requests);
  return (
    <div className="vault">
      {error && <LoadError code={error} />}
      <Gate />
      {pending.length > 0 && (
        <section className="vault-pending" aria-label={t('vault.requests')}>
          {pending.map((r) => (
            <RequestCard key={r.id} req={r} />
          ))}
        </section>
      )}
      {(status.mode === 'passphrase' || variables.length > 0) && (
        <>
          <div className="segmented vault-tabs" role="tablist">
            {(
              [
                ['variables', VariableIcon, t('vault.tab.variables', { n: variables.length })],
                ['log', History, t('vault.tab.log')],
                ['connect', Plug, t('vault.tab.connect')],
              ] as const
            ).map(([id, Icon, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
                <Icon /> {label}
              </button>
            ))}
          </div>
          {tab === 'variables' && <Variables session={session} />}
          {tab === 'log' && <AccessLog />}
          {tab === 'connect' && <SetupGuide />}
        </>
      )}
    </div>
  );
}

// ---- the gate ----

/** Password managers are kept away from the passphrase: one saved there is
 * readable by programs on the computer in several browsers. */
const noManager = { autoComplete: 'off', 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': '', 'data-form-type': 'other' };

/** When the passphrase was set, so that one the user did not choose shows. */
function Since() {
  const at = useVault((s) => s.status?.passphraseSet);
  if (!at) return null;
  return <span className="muted">{t('vault.passphraseSince', { date: new Date(at).toLocaleString() })}</span>;
}

/** The vault's gate: a passphrase to create or to unlock this page's
 * session with; with a session, its bar. */
function Gate() {
  const status = useVault((s) => s.status)!;
  const session = useVault((s) => s.session);
  const readOnly = useStore((s) => s.readOnly);
  const [changing, setChanging] = useState(false);
  if (readOnly) {
    return (
      <div className="callout">
        <Lock />
        <span>{t('vault.readOnly')}</span>
      </div>
    );
  }
  if (status.setup) return <PassphraseCard kind="create" />;
  if (!session) return <UnlockCard />;
  return (
    <>
      <div className="vault-session">
        <LockOpen />
        <span className="vault-session-text">
          <b>{t('vault.session.open')}</b>
          <span className="muted">{t('vault.session.idle')}</span>
          <Since />
        </span>
        <span className="spacer" />
        <button className="sm ghost" onClick={() => setChanging(!changing)}>
          {t('vault.changePassphrase')}
        </button>
        <button className="sm" onClick={() => void lockVault()}>
          <Lock /> {t('vault.lock')}
        </button>
      </div>
      {changing && <PassphraseCard kind="change" onDone={() => setChanging(false)} />}
    </>
  );
}

/** Creating the passphrase, or changing it. */
function PassphraseCard({ kind, onDone }: { kind: 'create' | 'change'; onDone?(): void }) {
  const [old, setOld] = useState('');
  const [pass, setPass] = useState('');
  const [repeat, setRepeat] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const strength = passStrength(pass);
  const submit = async () => {
    setErr('');
    if (pass !== repeat) return setErr(t('vault.error.mismatch'));
    setBusy(true);
    try {
      await setPassphrase(pass, kind === 'change' ? old : undefined);
      onDone?.();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="vault-gate"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="vault-gate-head">
        <ShieldCheck />
        <b>{t(`vault.gate.${kind}.title`)}</b>
      </div>
      <p className="vault-gate-text">{t(`vault.gate.${kind}.text`)}</p>
      {kind === 'change' && (
        <input
          className="input"
          type="password"
          {...noManager}
          placeholder={t('vault.passphraseCurrent')}
          aria-label={t('vault.passphraseCurrent')}
          value={old}
          onChange={(e) => setOld(e.target.value)}
        />
      )}
      <input
        className="input"
        type="password"
        {...noManager}
        autoFocus={kind !== 'change'}
        placeholder={t('vault.passphraseNew')}
        aria-label={t('vault.passphraseNew')}
        value={pass}
        onChange={(e) => setPass(e.target.value)}
      />
      <div className={`vault-strength s${strength}`} aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </div>
      <input
        className="input"
        type="password"
        {...noManager}
        placeholder={t('vault.passphraseRepeat')}
        aria-label={t('vault.passphraseRepeat')}
        value={repeat}
        onChange={(e) => setRepeat(e.target.value)}
      />
      <p className="vault-hint">{t('vault.gate.hint')}</p>
      {err && <div className="callout error">{err}</div>}
      <div className="vault-gate-actions">
        {onDone && (
          <button type="button" onClick={onDone}>
            {t('dialog.cancel')}
          </button>
        )}
        <button className="primary" type="submit" disabled={busy || pass.length < 8 || !repeat || (kind === 'change' && !old)}>
          {t(`vault.gate.${kind}.button`)}
        </button>
      </div>
    </form>
  );
}

/** A rough strength, 0 to 4: length and kinds of characters. */
export function passStrength(p: string): number {
  if (p.length < 8) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  return Math.min(4, (p.length >= 12 ? 2 : 1) + (kinds >= 3 ? 2 : kinds >= 2 ? 1 : 0));
}

/** Unlocking this page's session with the passphrase. */
function UnlockCard() {
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      await openSession(pass);
      setPass('');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="vault-gate"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="vault-gate-head">
        <Lock />
        <b>{t('vault.gate.unlock.title')}</b>
      </div>
      <p className="vault-gate-text">
        {t('vault.gate.unlock.text')} <Since />
      </p>
      <div className="vault-unlock-row">
        <input
          className="input"
          type="password"
          {...noManager}
          placeholder={t('vault.passphrase')}
          aria-label={t('vault.passphrase')}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
        <button className="primary" type="submit" disabled={busy || !pass}>
          {t('vault.unlock')}
        </button>
      </div>
      {err && <div className="callout error">{err}</div>}
    </form>
  );
}

// ---- variables ----

function Variables({ session }: { session: boolean }) {
  const variables = useVault((s) => s.variables);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<VaultVariable | 'new' | undefined>();
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? variables.filter((v) => v.name.toLowerCase().includes(q) || v.description.toLowerCase().includes(q)) : variables;
  }, [variables, query]);
  return (
    <>
      <div className="vault-toolbar">
        <label className="vault-search">
          <Search />
          <input
            type="search"
            placeholder={t('vault.search')}
            aria-label={t('vault.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          className="primary sm"
          disabled={!session}
          title={session ? undefined : t('vault.needSession')}
          onClick={() => setEditing('new')}
        >
          <Plus /> {t('vault.add')}
        </button>
      </div>
      {variables.length === 0 ? (
        <div className="empty-note">
          <KeyRound />
          {t('vault.empty')}
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-note">{t('vault.noMatch')}</div>
      ) : (
        <ul className="vault-list">
          {shown.map((v) => (
            <Row key={v.name} v={v} session={session} onEdit={() => setEditing(v)} />
          ))}
        </ul>
      )}
      {editing && <Editor variable={editing === 'new' ? undefined : editing} onDone={() => setEditing(undefined)} />}
    </>
  );
}

/** Who may read a variable without asking, as a chip. */
function Access({ v }: { v: VaultVariable }) {
  const ms = useStore((s) => s.machines);
  if (v.machines.includes('*'))
    return (
      <span className="vault-access all" title={t('vault.access.allTitle')}>
        <Monitor /> {t('vault.machines.all')}
      </span>
    );
  if (!v.machines.length)
    return (
      <span className="vault-access ask" title={t('vault.access.askTitle')}>
        <ShieldCheck /> {t('vault.machines.none')}
      </span>
    );
  const names = v.machines.map((m) => ms[m]?.label ?? m);
  return (
    <span className="vault-access some" title={names.join(', ')}>
      <Monitor /> {names.length === 1 ? names[0] : t('vault.access.someCount', { n: names.length })}
    </span>
  );
}

function Row({ v, session, onEdit }: { v: VaultVariable; session: boolean; onEdit(): void }) {
  const [value, setValue] = useState<string>();
  const [err, setErr] = useState('');
  // A revealed value hides itself after a while.
  useEffect(() => {
    if (value === undefined) return;
    const id = window.setTimeout(() => setValue(undefined), 30_000);
    return () => window.clearTimeout(id);
  }, [value]);
  const reveal = async () => {
    if (value !== undefined) return setValue(undefined);
    const ok = await confirmDialog({
      title: t('vault.revealTitle'),
      message: t('vault.revealMessage', { name: v.name }),
      confirm: t('vault.reveal'),
    });
    if (!ok) return;
    try {
      setValue((await vaultApi.reveal(v.name)).value);
      setErr('');
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <li className="vault-row" data-name={v.name}>
      <div className="vault-row-main">
        <div className="vault-row-head">
          <code className="vault-name ellipsis">{v.name}</code>
          {v.injectOnly && <span className="tag">{t('vault.injectOnly.badge')}</span>}
        </div>
        {v.description && <div className="vault-desc">{v.description}</div>}
        <Access v={v} />
      </div>
      <div className="vault-row-actions">
        <button
          className="icon sm"
          title={value === undefined ? t('vault.reveal') : t('vault.hide')}
          aria-label={value === undefined ? t('vault.reveal') : t('vault.hide')}
          data-action="reveal"
          disabled={!session && value === undefined}
          onClick={() => void reveal()}
        >
          {value === undefined ? <Eye /> : <EyeOff />}
        </button>
        <button
          className="icon sm"
          title={t('vault.edit')}
          aria-label={t('vault.edit')}
          data-action="edit"
          disabled={!session}
          onClick={onEdit}
        >
          <Pencil />
        </button>
      </div>
      {value !== undefined && (
        <div className="vault-value">
          <code>{value}</code>
          <button className="icon sm" title={t('vault.copy')} aria-label={t('vault.copy')} onClick={() => copy(value)}>
            <Copy />
          </button>
        </div>
      )}
      {err && <div className="callout error">{err}</div>}
    </li>
  );
}

type AccessMode = 'ask' | 'some' | 'all';

/** Adds or changes a variable, in a dialog: the value field only sets a new
 * value; who may read it without asking; inject-only. */
function Editor({ variable, onDone }: { variable?: VaultVariable; onDone(): void }) {
  const machines = useStore((s) => s.machines);
  const order = useStore((s) => s.order);
  const [name, setName] = useState(variable?.name ?? '');
  const [description, setDescription] = useState(variable?.description ?? '');
  const [value, setValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [injectOnly, setInjectOnly] = useState(variable?.injectOnly ?? false);
  const initial = variable?.machines ?? [];
  const [mode, setMode] = useState<AccessMode>(initial.includes('*') ? 'all' : initial.length ? 'some' : 'ask');
  const [picked, setPicked] = useState<string[]>(initial.filter((m) => m !== '*'));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const target = name.trim();
  const nameOk = /^[A-Za-z_][A-Za-z0-9_]*$/.test(target) && target.length <= 128;
  const machinesOf = (): string[] => (mode === 'all' ? ['*'] : mode === 'some' ? picked : []);
  const save = async () => {
    setErr('');
    setBusy(true);
    try {
      // A new name renames it in the same write as the other changes (its
      // value stays, sealed under the new name): a failure changes nothing.
      const to = variable && target !== variable.name ? { to: target } : {};
      await vaultApi.set(variable?.name ?? target, {
        ...to,
        description,
        machines: machinesOf(),
        injectOnly,
        ...(value !== '' || !variable ? { value } : {}),
      });
      await loadVault();
      onDone();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!variable) return;
    const ok = await confirmDialog({
      title: t('vault.deleteTitle'),
      message: t('vault.deleteMessage', { name: variable.name }),
      confirm: t('vault.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await vaultApi.remove(variable.name);
      await loadVault();
      onDone();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <form
        className="modal dialog vault-editor"
        role="dialog"
        aria-label={variable ? t('vault.editTitle', { name: variable.name }) : t('vault.addTitle')}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onDone();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="modal-head">
          <span className="modal-title">{variable ? t('vault.editTitle', { name: variable.name }) : t('vault.addTitle')}</span>
          <span className="spacer" />
          <button type="button" className="icon" title={t('dialog.cancel')} aria-label={t('dialog.cancel')} onClick={onDone}>
            <X />
          </button>
        </div>
        <div className="dialog-body vault-fields">
          <label className="vault-field">
            <span>{t('vault.name')}</span>
            <input
              className="input mono"
              value={name}
              autoFocus={!variable}
              spellCheck={false}
              placeholder="API_KEY"
              onChange={(e) => setName(e.target.value)}
            />
            {target && !nameOk && <small className="error">{t('vault.error.invalid_name')}</small>}
          </label>
          <label className="vault-field">
            <span>{t('vault.description')}</span>
            <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="vault-field">
            <span>{variable ? t('vault.newValue') : t('vault.value')}</span>
            <span className="vault-secret">
              <input
                className="input mono"
                type={showValue ? 'text' : 'password'}
                autoComplete="off"
                name="value"
                placeholder={variable ? t('vault.valueKeep') : ''}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <button
                type="button"
                className="icon sm"
                title={showValue ? t('vault.hide') : t('vault.showTyped')}
                aria-label={showValue ? t('vault.hide') : t('vault.showTyped')}
                onClick={() => setShowValue(!showValue)}
              >
                {showValue ? <EyeOff /> : <Eye />}
              </button>
            </span>
          </label>
          <fieldset className="vault-field">
            <legend>{t('vault.machines')}</legend>
            <div className="vault-modes" role="radiogroup">
              {(['ask', 'some', 'all'] as const).map((m) => (
                <label key={m} className={`vault-mode ${mode === m ? 'on' : ''}`}>
                  <input type="radio" name="access" checked={mode === m} onChange={() => setMode(m)} />
                  <b>{t(`vault.access.${m}`)}</b>
                  <small>{t(`vault.access.${m}Hint`)}</small>
                </label>
              ))}
            </div>
            {mode === 'some' && (
              <div className="vault-machine-list">
                {order.map((m) => (
                  <label key={m} className="vault-machine">
                    <input
                      type="checkbox"
                      checked={picked.includes(m)}
                      onChange={(e) => setPicked((p) => (e.target.checked ? [...p.filter((x) => x !== m), m] : p.filter((x) => x !== m)))}
                    />
                    <span className={`mstatus ms-${machines[m]?.status ?? 'idle'}`} />
                    <span className="ellipsis">{machines[m]?.label ?? m}</span>
                    {machines[m]?.kind === 'local' && <span className="tag">{t('vault.thisComputer')}</span>}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div className="vault-field vault-switch-row">
            <span className="vault-switch-text">
              <b>{t('vault.injectOnly.title')}</b>
              <small>{t('vault.injectOnly')}</small>
            </span>
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={injectOnly}
              aria-label={t('vault.injectOnly.title')}
              onClick={() => setInjectOnly(!injectOnly)}
            />
          </div>
          {err && <div className="callout error">{err}</div>}
        </div>
        <div className="dialog-actions">
          {variable && (
            <button type="button" className="ghost danger-text" onClick={() => void remove()}>
              <Trash2 /> {t('vault.delete')}
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={onDone}>
            {t('dialog.cancel')}
          </button>
          <button
            className="primary"
            type="submit"
            disabled={busy || !nameOk || (!variable && !value) || (mode === 'some' && !picked.length)}
          >
            {t('vault.save')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

// ---- the access log ----

/** Outcomes: values let out (by the list, or by a page: a reveal, an
 * export), approved by the user, refused, listed. */
const OUTCOME: Record<string, 'ok' | 'asked' | 'refused' | 'info'> = {
  allowed: 'ok',
  revealed: 'ok',
  exported: 'ok',
  approved: 'asked',
  approved_always: 'asked',
  listed: 'info',
};

function resultText(result: string): string {
  const key = `vault.result.${result}`;
  return hasMessage(key) ? t(key) : result;
}

/** The machine filter's value of a page's records (machine ''). */
const PAGE = '\0page';

/** Who asked: the machine, the client and terminal it reported and the
 * directory; a page's address. */
function whoText(a: VaultAccess, label: (m: string) => string): string {
  if (!a.m) return [t('vault.log.page'), a.remote].filter(Boolean).join(' · ');
  return [
    label(a.m),
    a.client || t('vault.request.unknownClient'),
    a.terminal && t('vault.request.terminal', { terminal: a.terminal }),
    a.cwd,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The accesses kept in the vault's access log, by day, filtered by
 * machine (or pages) and outcome. */
function AccessLog() {
  const log = useVault((s) => s.log);
  const machines = useStore((s) => s.machines);
  const [machine, setMachine] = useState('');
  const [outcome, setOutcome] = useState('');
  const shown = log.filter(
    (a) => (!machine || (machine === PAGE ? !a.m : a.m === machine)) && (!outcome || (OUTCOME[a.result] ?? 'refused') === outcome),
  );
  const days = new Map<string, VaultAccess[]>();
  for (const a of shown.slice(0, 300)) {
    const d = new Date(a.time).toLocaleDateString();
    days.set(d, [...(days.get(d) ?? []), a]);
  }
  const ids = [...new Set(log.map((a) => a.m || PAGE))];
  const label = (m: string) => machines[m]?.label ?? m;
  return (
    <>
      <div className="vault-toolbar">
        <select value={machine} aria-label={t('vault.log.machine')} onChange={(e) => setMachine(e.target.value)}>
          <option value="">{t('vault.log.allMachines')}</option>
          {ids.map((m) => (
            <option key={m} value={m}>
              {m === PAGE ? t('vault.log.page') : label(m)}
            </option>
          ))}
        </select>
        <select value={outcome} aria-label={t('vault.log.outcome')} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">{t('vault.log.allOutcomes')}</option>
          {(['ok', 'asked', 'refused', 'info'] as const).map((o) => (
            <option key={o} value={o}>
              {t(`vault.outcome.${o}`)}
            </option>
          ))}
        </select>
      </div>
      {!shown.length ? (
        <div className="empty-note">
          <History />
          {log.length ? t('vault.noMatch') : t('vault.log.empty')}
        </div>
      ) : (
        <div className="vault-log">
          {[...days].map(([day, list]) => (
            <section key={day}>
              <h4 className="section-head">{day}</h4>
              <ul>
                {list.map((a, i) => (
                  <li key={a.id ?? i} className={`vault-entry ${OUTCOME[a.result] ?? 'refused'}`} data-result={a.result}>
                    <span className="vault-entry-time mono">{new Date(a.time).toLocaleTimeString()}</span>
                    <span className="vault-entry-body">
                      <span className="vault-entry-line">
                        <span className={`vault-outcome ${OUTCOME[a.result] ?? 'refused'}`}>{resultText(a.result)}</span>
                        <span className="vault-entry-tool">{t(`vault.tool.${a.tool}` as 'vault.tool.get')}</span>
                        {(a.count ?? 1) > 1 && <span className="muted">{t('vault.log.count', { count: a.count ?? 1 })}</span>}
                      </span>
                      {(a.names ?? []).length > 0 && (
                        <span className="vault-entry-names">
                          {a.names!.map((n) => (
                            <code key={n}>{n}</code>
                          ))}
                        </span>
                      )}
                      <span className="vault-entry-who muted ellipsis" title={a.userAgent}>
                        {whoText(a, label)}
                      </span>
                      {(a.process ?? []).length > 0 && (
                        <span className="vault-entry-who vault-entry-process muted ellipsis" title={t('vault.log.process')}>
                          {processText(a.process)}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <p className="vault-hint">{t('vault.log.about')}</p>
    </>
  );
}

// ---- connecting a CLI ----

/** Per machine: how to add the vault's MCP server to a coding agent's CLI. */
function SetupGuide() {
  const machines = useStore((s) => s.machines);
  const order = useStore((s) => s.order);
  const [m, setM] = useState('');
  const id = m && machines[m] ? m : order[0];
  const info = id ? machines[id]?.info : undefined;
  const s = setupSnippets(info);
  const block = (title: string, text: string, kind: string) => (
    <div className="vault-snippet" data-snippet={kind}>
      <div className="vault-snippet-head">
        <span>{title}</span>
        <span className="spacer" />
        <button className="icon sm" title={t('vault.copy')} aria-label={t('vault.copy')} onClick={() => copy(text)}>
          <Copy />
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
  return (
    <div className="vault-setup">
      <p className="vault-hint">{t('vault.setup.about')}</p>
      {order.length > 1 && (
        <select aria-label={t('vault.setup.machine')} value={id} onChange={(e) => setM(e.target.value)}>
          {order.map((x) => (
            <option key={x} value={x}>
              {machines[x]?.label ?? x}
            </option>
          ))}
        </select>
      )}
      {block(t('vault.setup.claude'), s.claude, 'claude')}
      {block(t('vault.setup.codex'), s.codex, 'codex')}
      {block(t('vault.setup.json'), s.json, 'json')}
      <p className="vault-hint">{t('vault.setup.note')}</p>
      {id && machines[id]?.kind === 'local' && (
        <p className="vault-hint" data-note="local">
          {t('vault.localNote')}
        </p>
      )}
    </div>
  );
}
