// A dialog that asks for names (a new branch, a tag and its message) for
// the Git plugin's actions; mounted once with the plugin (a status bar
// item that draws nothing else).

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { create } from 'zustand';
import { t } from '../../i18n';

export interface PromptField {
  key: string;
  label: string;
  value?: string;
  placeholder?: string;
  /** A text area (a message) instead of a line. */
  multiline?: boolean;
  /** A checkbox. */
  check?: boolean;
  /** Returns why the value cannot be taken. */
  validate?(v: string): string | undefined;
}

interface Request {
  title: string;
  confirm: string;
  fields: PromptField[];
  resolve(v: Record<string, string | boolean> | undefined): void;
}

const usePrompt = create<{ req?: Request }>(() => ({}));

/** Asks for the fields' values; undefined when cancelled. */
export function promptDialog(title: string, confirm: string, fields: PromptField[]): Promise<Record<string, string | boolean> | undefined> {
  return new Promise((resolve) => {
    usePrompt.getState().req?.resolve(undefined);
    usePrompt.setState({ req: { title, confirm, fields, resolve } });
  });
}

/** Why a name cannot be a branch or tag (the machine checks it with
 * git's rules too). */
export function badRefName(s: string): string | undefined {
  if (!s.trim()) return t('git.name.empty');
  // eslint-disable-next-line no-control-regex
  if (/^-|\.\.|@\{|\/\/|^\/|\/$|\.$|\.lock$|[\s~^:?*[\\\x00-\x1f\x7f]/.test(s)) return t('git.name.invalid');
  return undefined;
}

export function GitPrompt() {
  const req = usePrompt((s) => s.req);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  useEffect(() => {
    if (req) setValues(Object.fromEntries(req.fields.map((f) => [f.key, f.check ? !!f.value : (f.value ?? '')])));
  }, [req]);
  if (!req) return null;
  const done = (ok: boolean) => {
    usePrompt.setState({ req: undefined });
    req.resolve(ok ? values : undefined);
  };
  const errors = req.fields.map((f) => (f.check || !f.validate ? undefined : f.validate(String(values[f.key] ?? ''))));
  const valid = errors.every((e) => !e);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div
        className="modal dialog"
        role="dialog"
        aria-label={req.title}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') done(false);
        }}
      >
        <div className="modal-head">
          <span className="modal-title">{req.title}</span>
          <span className="spacer" />
          <button className="icon" title={t('dialog.cancel')} onClick={() => done(false)}>
            <X />
          </button>
        </div>
        <form
          className="dialog-body form"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) done(true);
          }}
        >
          {req.fields.map((f, i) =>
            f.check ? (
              <label key={f.key} className="row dialog-check">
                <input
                  type="checkbox"
                  checked={!!values[f.key]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))}
                />
                <span>{f.label}</span>
              </label>
            ) : (
              <label key={f.key}>
                <span>{f.label}</span>
                {f.multiline ? (
                  <textarea
                    rows={3}
                    spellCheck={false}
                    value={String(values[f.key] ?? '')}
                    placeholder={f.placeholder}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                ) : (
                  <input
                    autoFocus={i === 0}
                    spellCheck={false}
                    value={String(values[f.key] ?? '')}
                    placeholder={f.placeholder}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                )}
                {errors[i] && String(values[f.key] ?? '') !== '' && <span className="error small">{errors[i]}</span>}
              </label>
            ),
          )}
          <button type="submit" hidden />
        </form>
        <div className="dialog-actions">
          <button onClick={() => done(false)}>{t('dialog.cancel')}</button>
          <button className="primary" disabled={!valid} onClick={() => done(true)}>
            {req.confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
