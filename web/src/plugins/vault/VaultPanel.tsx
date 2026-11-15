// The variable vault's panel in the right sidebar: the variables (never
// their values, except one revealed on request), their editor, the lock,
// requests waiting for an answer, the access log and how to connect a
// coding agent's CLI on each machine.
import { useEffect, useMemo, useState } from 'react';
import { Copy, Eye, EyeOff, Lock, LockOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { useStore } from '../../state/store';
import { confirmDialog } from '../../dialog';
import { hasMessage, t } from '../../i18n';
import { loadRequests, loadVault, useVault, vaultApi, VaultError, type VaultVariable } from './api';
import { RequestCard } from './Approvals';
import { setupSnippets } from './setup';
import './vault.css';

/** A failure's message in the UI's language. */
function errorText(e: unknown): string {
  const code = e instanceof VaultError ? e.code : 'failed';
  const key = `vault.error.${code}`;
  return hasMessage(key) ? t(key) : t('vault.error.failed');
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

export function VaultPanel() {
  const { status, variables, error, log, requests } = useVault();
  const readOnly = useStore((s) => s.readOnly);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<VaultVariable | 'new' | undefined>();
  useEffect(() => {
    void loadVault();
    void loadRequests();
  }, []);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? variables.filter((v) => v.name.toLowerCase().includes(q) || v.description.toLowerCase().includes(q)) : variables;
  }, [variables, query]);
  if (error === 'unavailable') return <div className="vault-empty">{t('vault.unavailable')}</div>;
  const pending = Object.values(requests);
  return (
    <div className="vault">
      <LockBar />
      {pending.length > 0 && (
        <section className="vault-section">
          <h3>{t('vault.requests')}</h3>
          {pending.map((r) => (
            <RequestCard key={r.id} req={r} />
          ))}
        </section>
      )}
      <div className="vault-toolbar">
        <input
          className="vault-input"
          type="search"
          placeholder={t('vault.search')}
          aria-label={t('vault.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="icon" title={t('vault.add')} aria-label={t('vault.add')} disabled={readOnly} onClick={() => setEditing('new')}>
          <Plus />
        </button>
      </div>
      {editing === 'new' && <Editor onDone={() => setEditing(undefined)} />}
      <ul className="vault-list">
        {shown.map((v) =>
          editing !== 'new' && editing?.name === v.name ? (
            <li key={v.name}>
              <Editor variable={v} onDone={() => setEditing(undefined)} />
            </li>
          ) : (
            <Row key={v.name} v={v} locked={!!status?.locked} onEdit={() => setEditing(v)} />
          ),
        )}
      </ul>
      {!variables.length && <div className="vault-empty">{t('vault.empty')}</div>}
      {variables.length > 0 && !shown.length && <div className="vault-empty">{t('vault.noMatch')}</div>}
      <details className="vault-section">
        <summary>{t('vault.log')}</summary>
        {log.length ? (
          <ul className="vault-log">
            {log.slice(0, 100).map((a, i) => (
              <li key={i}>
                <span className="vault-dim">{new Date(a.time).toLocaleTimeString()}</span>{' '}
                {t('vault.log.entry', {
                  client: a.client || t('vault.request.unknownClient'),
                  machine: useStore.getState().machines[a.m]?.label ?? a.m,
                  names: (a.names ?? []).join(', ') || '–',
                })}{' '}
                <span className={`vault-result ${a.result}`}>{resultText(a.result)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="vault-dim">{t('vault.log.empty')}</div>
        )}
      </details>
      <SetupGuide />
    </div>
  );
}

function resultText(result: string): string {
  const key = `vault.result.${result}`;
  return hasMessage(key) ? t(key) : result;
}

/** The vault's state, and the lock; a passphrase form while a passphrase
 * vault is locked. */
function LockBar() {
  const status = useVault((s) => s.status);
  const readOnly = useStore((s) => s.readOnly);
  const [pass, setPass] = useState('');
  const [repeat, setRepeat] = useState('');
  const [err, setErr] = useState('');
  if (!status) return null;
  const run = async (f: () => Promise<unknown>) => {
    setErr('');
    try {
      await f();
      setPass('');
      setRepeat('');
      await loadVault();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const modeText =
    status.mode === 'keychain'
      ? t('vault.mode.keychain')
      : status.mode === 'passphrase'
        ? t('vault.mode.passphrase')
        : t('vault.mode.none');
  const needsPassphrase = status.locked && status.mode === 'passphrase';
  return (
    <div className={`vault-lock ${status.locked ? 'locked' : ''}`}>
      <div className="vault-lock-row">
        {status.locked ? <Lock /> : <LockOpen />}
        <span className="vault-lock-text">
          {status.locked ? t('vault.locked') : t('vault.unlocked')} · {modeText}
        </span>
        {status.mode === 'keychain' && status.locked && (
          <button disabled={readOnly} onClick={() => void run(() => vaultApi.unlock(''))}>
            {t('vault.unlock')}
          </button>
        )}
        {!status.locked && status.mode !== '' && (
          <button disabled={readOnly} onClick={() => void run(() => vaultApi.lock())}>
            {t('vault.lock')}
          </button>
        )}
      </div>
      {status.error && <div className="vault-error">{errorText(new VaultError(status.error))}</div>}
      {needsPassphrase && !readOnly && (
        <form
          className="vault-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (status.setup && pass !== repeat) {
              setErr(t('vault.error.mismatch'));
              return;
            }
            void run(() => vaultApi.unlock(pass));
          }}
        >
          <div className="vault-dim">{status.setup ? t('vault.setupHint') : t('vault.lockedHint')}</div>
          <input
            className="vault-input"
            type="password"
            autoComplete={status.setup ? 'new-password' : 'current-password'}
            placeholder={t('vault.passphrase')}
            aria-label={t('vault.passphrase')}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
          {status.setup && (
            <input
              className="vault-input"
              type="password"
              autoComplete="new-password"
              placeholder={t('vault.passphraseRepeat')}
              aria-label={t('vault.passphraseRepeat')}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
          )}
          <button className="primary" type="submit" disabled={!pass}>
            {status.setup ? t('vault.setPassphrase') : t('vault.unlock')}
          </button>
        </form>
      )}
      {err && <div className="vault-error">{err}</div>}
    </div>
  );
}

function machinesText(v: VaultVariable): string {
  if (v.machines.includes('*')) return t('vault.machines.all');
  if (!v.machines.length) return t('vault.machines.none');
  const ms = useStore.getState().machines;
  return v.machines.map((m) => ms[m]?.label ?? m).join(', ');
}

function Row({ v, locked, onEdit }: { v: VaultVariable; locked: boolean; onEdit(): void }) {
  const readOnly = useStore((s) => s.readOnly);
  const [value, setValue] = useState<string>();
  const [err, setErr] = useState('');
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
  const remove = async () => {
    const ok = await confirmDialog({
      title: t('vault.deleteTitle'),
      message: t('vault.deleteMessage', { name: v.name }),
      confirm: t('vault.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await vaultApi.remove(v.name);
      await loadVault();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <li className="vault-row" data-name={v.name}>
      <div className="vault-row-head">
        <span className="vault-name ellipsis">{v.name}</span>
        {v.injectOnly && <span className="vault-badge">{t('vault.injectOnly.badge')}</span>}
        <span className="spacer" />
        <button
          className="icon"
          title={value === undefined ? t('vault.reveal') : t('vault.hide')}
          aria-label={value === undefined ? t('vault.reveal') : t('vault.hide')}
          data-action="reveal"
          disabled={readOnly || (locked && value === undefined)}
          onClick={() => void reveal()}
        >
          {value === undefined ? <Eye /> : <EyeOff />}
        </button>
        <button className="icon" title={t('vault.edit')} aria-label={t('vault.edit')} disabled={readOnly} onClick={onEdit}>
          <Pencil />
        </button>
        <button
          className="icon"
          title={t('vault.delete')}
          aria-label={t('vault.delete')}
          data-action="delete"
          disabled={readOnly}
          onClick={() => void remove()}
        >
          <Trash2 />
        </button>
      </div>
      {v.description && <div className="vault-desc">{v.description}</div>}
      <div className="vault-dim ellipsis">{machinesText(v)}</div>
      {value !== undefined && (
        <div className="vault-value">
          <code>{value}</code>
          <button className="icon" title={t('vault.copy')} aria-label={t('vault.copy')} onClick={() => copy(value)}>
            <Copy />
          </button>
        </div>
      )}
      {err && <div className="vault-error">{err}</div>}
    </li>
  );
}

/** Adds a variable, or changes one: the value field only sets a new value. */
function Editor({ variable, onDone }: { variable?: VaultVariable; onDone(): void }) {
  const machines = useStore((s) => s.machines);
  const order = useStore((s) => s.order);
  const [name, setName] = useState(variable?.name ?? '');
  const [description, setDescription] = useState(variable?.description ?? '');
  const [value, setValue] = useState('');
  const [injectOnly, setInjectOnly] = useState(variable?.injectOnly ?? false);
  const [allowed, setAllowed] = useState<string[]>(variable?.machines ?? []);
  const [err, setErr] = useState('');
  const all = allowed.includes('*');
  const toggle = (m: string, on: boolean) => setAllowed((a) => (on ? [...a.filter((x) => x !== m), m] : a.filter((x) => x !== m)));
  const save = async () => {
    setErr('');
    try {
      await vaultApi.set(name.trim(), {
        description,
        machines: allowed,
        injectOnly,
        ...(value !== '' || !variable ? { value } : {}),
      });
      await loadVault();
      onDone();
    } catch (e) {
      setErr(errorText(e));
      if (e instanceof VaultError && e.code === 'vault_locked') void loadVault();
    }
  };
  return (
    <form
      className="vault-form vault-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        <span>{t('vault.name')}</span>
        <input
          className="vault-input"
          value={name}
          disabled={!!variable}
          autoFocus={!variable}
          spellCheck={false}
          placeholder="API_KEY"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        <span>{t('vault.description')}</span>
        <input className="vault-input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        <span>{variable ? t('vault.newValue') : t('vault.value')}</span>
        <input
          className="vault-input"
          type="password"
          autoComplete="off"
          name="value"
          placeholder={variable ? t('vault.valueKeep') : ''}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <label className="vault-check">
        <input type="checkbox" checked={injectOnly} onChange={(e) => setInjectOnly(e.target.checked)} />
        <span>{t('vault.injectOnly')}</span>
      </label>
      <fieldset className="vault-machines">
        <legend>{t('vault.machines')}</legend>
        <label className="vault-check">
          <input type="checkbox" checked={all} onChange={(e) => toggle('*', e.target.checked)} />
          <span>{t('vault.machines.all')}</span>
        </label>
        {order.map((m) => (
          <label className="vault-check" key={m}>
            <input type="checkbox" disabled={all} checked={all || allowed.includes(m)} onChange={(e) => toggle(m, e.target.checked)} />
            <span>{machines[m]?.label ?? m}</span>
          </label>
        ))}
        <div className="vault-dim">{t('vault.machines.hint')}</div>
      </fieldset>
      {err && <div className="vault-error">{err}</div>}
      <div className="vault-form-actions">
        <button type="button" onClick={onDone}>
          {t('dialog.cancel')}
        </button>
        <button className="primary" type="submit" disabled={!name.trim() || (!variable && !value)}>
          {t('vault.save')}
        </button>
      </div>
    </form>
  );
}

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
        <button className="icon" title={t('vault.copy')} aria-label={t('vault.copy')} onClick={() => copy(text)}>
          <Copy />
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
  return (
    <details className="vault-section vault-setup">
      <summary>{t('vault.setup')}</summary>
      <div className="vault-dim">{t('vault.setup.about')}</div>
      {order.length > 1 && (
        <select className="vault-input" aria-label={t('vault.setup.machine')} value={id} onChange={(e) => setM(e.target.value)}>
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
      <div className="vault-dim">{t('vault.setup.note')}</div>
    </details>
  );
}
