import { useEffect, useRef, useState } from 'react';
import { Folder, X } from 'lucide-react';
import { closeDialog, completionParts, useDialog, type DialogRequest } from '../dialog';
import { listDir } from '../lib/files';
import { useStore } from '../state/store';
import { t } from '../i18n';

/** Renders the pending dialog request (see dialog.ts). */
export function Dialogs() {
  const req = useDialog((s) => s.current);
  // Focus returns to where it was (usually a terminal) when the dialog closes.
  const returnTo = useRef<Element | null>(null);
  useEffect(() => {
    if (!req) return;
    returnTo.current = document.activeElement;
    return () => (returnTo.current as HTMLElement | null)?.focus?.();
  }, [req]);
  if (!req) return null;
  return req.kind === 'confirm' ? <ConfirmDialog req={req} /> : <NewWorkspaceDialog req={req} />;
}

function Frame({ title, onCancel, children }: { title: string; onCancel(): void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="modal dialog"
        role="dialog"
        aria-label={title}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onCancel();
        }}
      >
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <span className="spacer" />
          <button className="icon" title={t('dialog.cancel')} onClick={onCancel}>
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ConfirmDialog({ req }: { req: Extract<DialogRequest, { kind: 'confirm' }> }) {
  const done = (ok: boolean) => {
    closeDialog(req);
    req.resolve(ok);
  };
  return (
    <Frame title={req.title} onCancel={() => done(false)}>
      <div className="dialog-body">{req.message}</div>
      <div className="dialog-actions">
        {/* Enter cancels a destructive action unless the user moves to it. */}
        <button autoFocus={req.danger} onClick={() => done(false)}>
          {t('dialog.cancel')}
        </button>
        <button className={req.danger ? 'primary danger' : 'primary'} autoFocus={!req.danger} onClick={() => done(true)}>
          {req.confirm}
        </button>
      </div>
    </Frame>
  );
}

function NewWorkspaceDialog({ req }: { req: Extract<DialogRequest, { kind: 'newWorkspace' }> }) {
  const machine = useStore((s) => s.machines[req.m]?.label ?? req.m);
  const [cwd, setCwd] = useState(req.cwd);
  const [label, setLabel] = useState('');
  const [dirs, setDirs] = useState<string[]>([]);
  const [sel, setSel] = useState(-1);
  const [missing, setMissing] = useState(false);

  // Subdirectories matching what is typed, listed on the machine.
  useEffect(() => {
    let cancelled = false;
    const id = window.setTimeout(async () => {
      const [dir, prefix] = completionParts(cwd);
      try {
        const list = dir ? await listDir(req.m, dir) : undefined;
        if (cancelled) return;
        const names = (list?.entries ?? [])
          .filter((e) => e.is_dir && e.name.startsWith(prefix) && (prefix.startsWith('.') || !e.name.startsWith('.')))
          .map((e) => e.name)
          .sort();
        setDirs(names.length === 1 && names[0] === prefix ? [] : names.slice(0, 8));
        setMissing(false);
      } catch {
        if (!cancelled) setDirs([]);
      }
      setSel(-1);
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [cwd, req.m]);

  const done = (v: { cwd: string; label: string } | undefined) => {
    closeDialog(req);
    req.resolve(v);
  };
  const complete = (name: string) => {
    const [dir] = completionParts(cwd);
    setCwd(`${dir === '/' ? '' : dir}/${name}/`);
  };
  const submit = async () => {
    const path = cwd.trim().replace(/(.)\/+$/, '$1');
    if (!path) return;
    try {
      const d = await listDir(req.m, path);
      if (!d.dir.is_dir) throw new Error('not a directory');
    } catch {
      setMissing(true);
      return;
    }
    done({ cwd: path, label: label.trim() });
  };

  return (
    <Frame title={t('newWorkspace.title', { machine })} onCancel={() => done(undefined)}>
      <div className="dialog-body form">
        <label>
          <span>{t('newWorkspace.cwd')}</span>
          <input
            autoFocus
            spellCheck={false}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && dirs.length) {
                e.preventDefault();
                setSel((sel + 1) % dirs.length);
              } else if (e.key === 'ArrowUp' && dirs.length) {
                e.preventDefault();
                setSel((sel - 1 + dirs.length) % dirs.length);
              } else if (e.key === 'Tab' && dirs.length && !e.shiftKey) {
                e.preventDefault();
                complete(dirs[Math.max(sel, 0)]);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (sel >= 0) complete(dirs[sel]);
                else submit();
              }
            }}
          />
        </label>
        {dirs.length > 0 && (
          <div className="dir-suggestions">
            {dirs.map((d, i) => (
              <div key={d} className={`dir-suggestion ${i === sel ? 'sel' : ''}`} onMouseDown={(e) => (e.preventDefault(), complete(d))}>
                <Folder /> {d}
              </div>
            ))}
          </div>
        )}
        {missing && <div className="error small">{t('newWorkspace.missing')}</div>}
        <label>
          <span>{t('newWorkspace.label')}</span>
          <input
            spellCheck={false}
            value={label}
            placeholder={t('newWorkspace.labelPlaceholder')}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>
        <div className="muted small">{t('newWorkspace.hint')}</div>
      </div>
      <div className="dialog-actions">
        <button onClick={() => done(undefined)}>{t('dialog.cancel')}</button>
        <button className="primary" onClick={submit}>
          {t('newWorkspace.create')}
        </button>
      </div>
    </Frame>
  );
}
