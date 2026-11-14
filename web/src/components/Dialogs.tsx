import { useEffect, useRef, useState } from 'react';
import { ArrowUp, File, Folder, X } from 'lucide-react';
import { closeDialog, completionParts, useDialog, type DialogRequest } from '../dialog';
import { startDownload } from '../download';
import { formatSize, listDir, type RemoteStat } from '../lib/files';
import { shortPath } from '../lib/herdr';
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
  if (req.kind === 'confirm') return <ConfirmDialog req={req} />;
  if (req.kind === 'download') return <DownloadDialog req={req} />;
  return <NewWorkspaceDialog req={req} />;
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

/** Chooses entries of a directory of a machine to download: several can be
 * checked, directories entered and left; one download takes them all (the
 * core zips directories and several entries). */
function DownloadDialog({ req }: { req: Extract<DialogRequest, { kind: 'download' }> }) {
  const machine = useStore((s) => s.machines[req.m]?.label ?? req.m);
  const home = useStore((s) => s.machines[req.m]?.info?.home);
  const [dir, setDir] = useState(req.dir);
  const [list, setList] = useState<{ path: string; entries: RemoteStat[] }>();
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setList(undefined);
    setError('');
    setChecked(new Set());
    listDir(req.m, dir)
      .then((d) => !cancelled && setList({ path: d.dir.path ?? dir, entries: d.entries }))
      .catch((e: Error) => !cancelled && setError(t('download.listFailed', { dir, error: e.message })));
    return () => {
      cancelled = true;
    };
  }, [dir, req.m]);

  const done = () => {
    closeDialog(req);
    req.resolve(undefined);
  };
  const path = list?.path ?? dir;
  const full = (name: string) => (path === '/' ? '' : path.replace(/\/$/, '')) + '/' + name;
  const parent = path.replace(/\/[^/]*\/?$/, '') || '/';
  const entries = list?.entries ?? [];
  const toggle = (name: string) =>
    setChecked((c) => {
      const next = new Set(c);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  const all = entries.length > 0 && checked.size === entries.length;
  const download = () => {
    if (checked.size === 0) return;
    startDownload(
      req.m,
      entries.filter((e) => checked.has(e.name)).map((e) => full(e.name)),
    );
    done();
  };

  return (
    <Frame title={t('download.title', { machine })} onCancel={done}>
      <div className="dialog-body download-body">
        <div className="download-path">
          <button
            className="icon"
            title={t('download.up')}
            aria-label={t('download.up')}
            disabled={!list || path === '/'}
            onClick={() => setDir(parent)}
          >
            <ArrowUp />
          </button>
          {/* A long path loses its start, not the directory shown. */}
          <span className="ellipsis download-path-text" title={path}>
            <bdi>{shortPath(path, home)}</bdi>
          </span>
        </div>
        <div className="download-list" role="listbox" aria-multiselectable="true" aria-label={path}>
          {entries.length > 0 && (
            <label className="download-row download-all">
              <input type="checkbox" checked={all} onChange={() => setChecked(all ? new Set() : new Set(entries.map((e) => e.name)))} />
              <span>{t('download.selectAll')}</span>
            </label>
          )}
          {entries.map((e) => (
            <div
              key={e.name}
              role="option"
              aria-selected={checked.has(e.name)}
              className={`download-row ${checked.has(e.name) ? 'sel' : ''}`}
              onDoubleClick={() => e.is_dir && setDir(full(e.name))}
            >
              <input type="checkbox" checked={checked.has(e.name)} aria-label={e.name} onChange={() => toggle(e.name)} />
              {e.is_dir ? <Folder /> : <File />}
              {e.is_dir ? (
                <button className="link download-name" onClick={() => setDir(full(e.name))}>
                  {e.name}
                </button>
              ) : (
                <span className="download-name ellipsis" onClick={() => toggle(e.name)}>
                  {e.name}
                </span>
              )}
              <span className="muted small">{e.is_dir ? '' : formatSize(e.size)}</span>
            </div>
          ))}
          {!list && !error && <div className="muted small">{t('download.loading')}</div>}
          {list && entries.length === 0 && <div className="muted small">{t('download.empty')}</div>}
          {error && <div className="error small">{error}</div>}
        </div>
        <div className="muted small">{t('download.hint')}</div>
      </div>
      <div className="dialog-actions">
        <span className="muted small spacer">{checked.size > 0 && t('download.selected', { n: checked.size })}</span>
        <button onClick={done}>{t('dialog.cancel')}</button>
        <button className="primary" disabled={checked.size === 0} onClick={download}>
          {t('download.button')}
        </button>
      </div>
    </Frame>
  );
}
