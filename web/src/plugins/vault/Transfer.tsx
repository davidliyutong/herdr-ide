// The vault's file dialogs: exporting variables into a file encrypted
// under a passphrase of its own, and importing one. The hub opens the
// vault's values and seals them into the file, and opens a file and saves
// its values, so no value reaches the page; the page holds the file
// (ciphertext) and the passphrases typed, in memory only. Exporting is a
// bulk release: it asks for the vault's passphrase again.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileUp, X } from 'lucide-react';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import {
  errorText,
  loadVault,
  openSession,
  useVault,
  vaultApi,
  VaultError,
  type ImportAction,
  type ImportPreview,
  type ImportVariable,
} from './api';
import { StrengthBar, chars, noManager } from './fields';
import { MAX_FILE, MIN_FILE_PASSPHRASE, closeVaultDialog, exportFileName, saveFile, useVaultDialog } from './dialogs';
import './vault.css';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A failure's message, with the variable it is about. */
function namedError(e: unknown): string {
  const text = errorText(e);
  return e instanceof VaultError && e.variable ? `${e.variable}: ${text}` : text;
}

/** The open dialog, drawn over the page (a status item of the plugin). */
export function VaultDialogs() {
  const dialog = useVaultDialog((s) => s.dialog);
  if (!dialog) return null;
  return dialog.kind === 'export' ? <ExportDialog names={dialog.names} /> : <ImportDialog />;
}

/** A modal of the vault's. */
function Modal({ title, wide, children, onSubmit }: { title: string; wide?: boolean; children: ReactNode; onSubmit(): void }) {
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeVaultDialog()}>
      <form
        className={`modal dialog vault-transfer${wide ? ' wide' : ''}`}
        role="dialog"
        aria-label={title}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') closeVaultDialog();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <span className="spacer" />
          <button type="button" className="icon" title={t('dialog.cancel')} aria-label={t('dialog.cancel')} onClick={closeVaultDialog}>
            <X />
          </button>
        </div>
        {children}
      </form>
    </div>,
    document.body,
  );
}

/** The vault's passphrase, asked again (an export) or to open the page's
 * session first (an import from a page without one). */
function VaultPassphrase({ value, onChange, label }: { value: string; onChange(v: string): void; label: string }) {
  return (
    <label className="vault-field">
      <span>{label}</span>
      <input className="input" type="password" {...noManager} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** Exporting the variables named (or all) into an encrypted file. */
function ExportDialog({ names }: { names?: string[] }) {
  const variables = useVault((s) => s.variables);
  const readOnly = useStore((s) => s.readOnly);
  useEffect(() => {
    if (!useVault.getState().status) void loadVault();
  }, []);
  const [scope, setScope] = useState<'selected' | 'all'>(names?.length ? 'selected' : 'all');
  const selected = useMemo(() => (names ?? []).filter((n) => variables.some((v) => v.name === n)), [names, variables]);
  const chosen = scope === 'selected' ? selected : variables.map((v) => v.name);
  const [pass, setPass] = useState('');
  const [filePass, setFilePass] = useState('');
  const [repeat, setRepeat] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setErr('');
    if (filePass !== repeat) return setErr(t('vault.error.mismatch'));
    setBusy(true);
    try {
      // A page without a session opens one with the same passphrase.
      if (!useVault.getState().session) await openSession(pass);
      const body = { passphrase: pass, filePassphrase: filePass };
      const text = await vaultApi.exportFile(scope === 'all' ? { ...body, all: true } : { ...body, names: chosen });
      saveFile(text, exportFileName());
      closeVaultDialog();
      void loadVault();
    } catch (e) {
      setErr(namedError(e));
    } finally {
      setBusy(false);
    }
  };
  const ready = chosen.length > 0 && !!pass && chars(filePass) >= MIN_FILE_PASSPHRASE && !!repeat && !readOnly;
  return (
    <Modal title={t('vault.export.title')} onSubmit={() => void submit()}>
      <div className="dialog-body vault-fields">
        {names?.length ? (
          <div className="vault-modes" role="radiogroup">
            {(['selected', 'all'] as const).map((s) => (
              <label key={s} className={`vault-mode ${scope === s ? 'on' : ''}`}>
                <input type="radio" name="scope" checked={scope === s} onChange={() => setScope(s)} />
                <b>
                  {s === 'selected' ? t('vault.export.selected', { n: selected.length }) : t('vault.export.all', { n: variables.length })}
                </b>
              </label>
            ))}
          </div>
        ) : (
          <p className="vault-hint">{t('vault.export.all', { n: variables.length })}</p>
        )}
        <div className="vault-chips" data-chosen>
          {chosen.slice(0, 40).map((n) => (
            <code key={n}>{n}</code>
          ))}
          {chosen.length > 40 && <span className="muted">{t('vault.export.more', { n: chosen.length - 40 })}</span>}
        </div>
        <VaultPassphrase label={t('vault.export.passphrase')} value={pass} onChange={setPass} />
        <label className="vault-field">
          <span>{t('vault.export.filePassphrase')}</span>
          <input className="input" type="password" {...noManager} value={filePass} onChange={(e) => setFilePass(e.target.value)} />
        </label>
        <StrengthBar value={filePass} />
        <label className="vault-field">
          <span>{t('vault.passphraseRepeat')}</span>
          <input className="input" type="password" {...noManager} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </label>
        <p className="vault-hint">{t('vault.export.warning')}</p>
        {readOnly && <div className="callout">{t('vault.readOnly')}</div>}
        {err && <div className="callout error">{err}</div>}
      </div>
      <div className="dialog-actions">
        <span className="spacer" />
        <button type="button" onClick={closeVaultDialog}>
          {t('dialog.cancel')}
        </button>
        <button className="primary" type="submit" disabled={busy || !ready}>
          <Download /> {t('vault.export.button', { n: chosen.length })}
        </button>
      </div>
    </Modal>
  );
}

interface Row {
  action: ImportAction;
  /** The new name of a rename. */
  as: string;
}

/** What a variable may become: taken names are skipped, overwritten or
 * renamed; a name the vault does not take only renamed; an invalid
 * variable only skipped. */
function actionsOf(v: ImportVariable): ImportAction[] {
  if (v.invalid === 'invalid_name') return ['skip', 'rename'];
  if (v.invalid) return ['skip'];
  return v.exists ? ['skip', 'overwrite', 'rename'] : ['import', 'skip', 'rename'];
}

function defaultAction(v: ImportVariable): ImportAction {
  return v.invalid || v.exists ? 'skip' : 'import';
}

/** Importing an export file: the file and its passphrase, a preview of
 * what it holds (without values), a choice per variable, then one write. */
function ImportDialog() {
  const machines = useStore((s) => s.machines);
  const readOnly = useStore((s) => s.readOnly);
  const session = useVault((s) => s.session);
  const variables = useVault((s) => s.variables);
  useEffect(() => {
    if (!useVault.getState().status) void loadVault();
  }, []);
  const [file, setFile] = useState<{ name: string; text: string }>();
  const [filePass, setFilePass] = useState('');
  const [pass, setPass] = useState('');
  const [preview, setPreview] = useState<ImportPreview>();
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const pick = async (f?: File) => {
    setErr('');
    setPreview(undefined);
    setFile(undefined);
    if (!f) return;
    if (f.size > MAX_FILE) return setErr(t('vault.error.too_large'));
    setFile({ name: f.name, text: await f.text() });
  };
  const read = async () => {
    if (!file) return;
    setErr('');
    setBusy(true);
    try {
      if (!useVault.getState().session) await openSession(pass);
      const p = await vaultApi.importPreview(file.text, filePass);
      setPreview(p);
      setRows(p.variables.map((v) => ({ action: defaultAction(v), as: v.name })));
    } catch (e) {
      setErr(namedError(e));
    } finally {
      setBusy(false);
    }
  };
  // Where each variable lands, and why a new name cannot be.
  const targets = rows.map((r, i) => (r.action === 'skip' ? '' : r.action === 'rename' ? r.as.trim() : (preview?.variables[i].name ?? '')));
  const renameError = (i: number): string => {
    if (rows[i]?.action !== 'rename') return '';
    const n = targets[i];
    if (!NAME.test(n) || n.length > 128) return t('vault.error.invalid_name');
    if (variables.some((v) => v.name === n) || targets.some((x, j) => j !== i && x === n)) return t('vault.error.exists');
    return '';
  };
  const count = targets.filter(Boolean).length;
  const valid = rows.every((_, i) => !renameError(i));
  const commit = async () => {
    if (!file || !preview) return;
    setErr('');
    setBusy(true);
    try {
      const choices = rows.map((r, i) => ({ i, action: r.action, ...(r.action === 'rename' ? { as: r.as.trim() } : {}) }));
      await vaultApi.importFile(file.text, filePass, choices);
      closeVaultDialog();
      await loadVault();
    } catch (e) {
      setErr(namedError(e));
    } finally {
      setBusy(false);
    }
  };
  const label = (id: string) => machines[id]?.label ?? preview?.machines.find((m) => m.id === id)?.label ?? id;
  const access = (v: ImportVariable) =>
    v.machines.includes('*') ? t('vault.machines.all') : v.machines.length ? v.machines.map(label).join(', ') : t('vault.machines.none');
  const setRow = (i: number, r: Partial<Row>) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, ...r } : x)));
  const anyExists = preview?.variables.some((v) => v.exists && !v.invalid);

  if (!preview)
    return (
      <Modal title={t('vault.import.title')} onSubmit={() => void read()}>
        <div className="dialog-body vault-fields">
          <label className="vault-field">
            <span>{t('vault.import.file')}</span>
            <input
              className="input"
              type="file"
              accept=".json,application/json"
              data-field="file"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
          </label>
          <label className="vault-field">
            <span>{t('vault.import.filePassphrase')}</span>
            <input className="input" type="password" {...noManager} value={filePass} onChange={(e) => setFilePass(e.target.value)} />
          </label>
          {!session && <VaultPassphrase label={t('vault.import.passphrase')} value={pass} onChange={setPass} />}
          {readOnly && <div className="callout">{t('vault.readOnly')}</div>}
          {err && <div className="callout error">{err}</div>}
        </div>
        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" onClick={closeVaultDialog}>
            {t('dialog.cancel')}
          </button>
          <button className="primary" type="submit" disabled={busy || !file || !filePass || (!session && !pass) || readOnly}>
            {t('vault.import.read')}
          </button>
        </div>
      </Modal>
    );

  return (
    <Modal title={t('vault.import.title')} wide onSubmit={() => void commit()}>
      <div className="dialog-body vault-fields">
        {anyExists && (
          <label className="vault-import-bulk">
            <span>{t('vault.import.existing')}</span>
            <select
              aria-label={t('vault.import.existing')}
              value=""
              onChange={(e) => {
                const a = e.target.value as ImportAction;
                if (a)
                  setRows((rs) =>
                    rs.map((r, i) => (preview.variables[i].exists && !preview.variables[i].invalid ? { ...r, action: a } : r)),
                  );
              }}
            >
              <option value="">{t('vault.import.existingPick')}</option>
              <option value="skip">{t('vault.import.action.skip')}</option>
              <option value="overwrite">{t('vault.import.action.overwrite')}</option>
            </select>
          </label>
        )}
        <ul className="vault-import-list">
          {preview.variables.map((v, i) => {
            const r = rows[i];
            const bad = renameError(i);
            return (
              <li key={i} className={`vault-import-row ${r.action}`} data-name={v.name}>
                <div className="vault-import-head">
                  <code className="vault-name ellipsis">{v.name}</code>
                  {v.injectOnly && <span className="tag">{t('vault.injectOnly.badge')}</span>}
                  {v.exists && <span className="tag warn">{t('vault.import.exists')}</span>}
                  {v.invalid && <span className="tag danger">{t(`vault.error.${v.invalid}` as 'vault.error.invalid')}</span>}
                  <span className="spacer" />
                  <select
                    aria-label={t('vault.import.action', { name: v.name })}
                    value={r.action}
                    onChange={(e) => setRow(i, { action: e.target.value as ImportAction })}
                  >
                    {actionsOf(v).map((a) => (
                      <option key={a} value={a}>
                        {t(`vault.import.action.${a}`)}
                      </option>
                    ))}
                  </select>
                </div>
                {r.action === 'rename' && (
                  <input
                    className="input mono"
                    aria-label={t('vault.import.newName', { name: v.name })}
                    spellCheck={false}
                    value={r.as}
                    onChange={(e) => setRow(i, { as: e.target.value })}
                  />
                )}
                {bad && <small className="error">{bad}</small>}
                {v.description && <div className="vault-desc">{v.description}</div>}
                <div className="vault-import-access muted">
                  {access(v)}
                  {(v.unknown ?? []).length > 0 && (
                    <span className="vault-import-unknown" data-unknown>
                      {' · '}
                      {t('vault.import.unknown', { machines: (v.unknown ?? []).map(label).join(', ') })}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {err && <div className="callout error">{err}</div>}
      </div>
      <div className="dialog-actions">
        <button type="button" className="ghost" onClick={() => setPreview(undefined)}>
          {t('vault.import.back')}
        </button>
        <span className="spacer" />
        <button type="button" onClick={closeVaultDialog}>
          {t('dialog.cancel')}
        </button>
        <button className="primary" type="submit" disabled={busy || !count || !valid || readOnly}>
          <FileUp /> {t('vault.import.button', { n: count })}
        </button>
      </div>
    </Modal>
  );
}
