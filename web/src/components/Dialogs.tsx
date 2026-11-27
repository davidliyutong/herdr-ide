import { useEffect, useRef, useState } from 'react';
import { ArrowUp, File, Folder, X } from 'lucide-react';
import {
  closeDialog,
  completionParts,
  expandPath,
  folderProblem,
  useDialog,
  type DialogRequest,
  type FolderProblem,
  type NewWorkspace,
  type UnsavedAnswer,
} from '../dialog';
import { startDownload } from '../download';
import { FileIcon } from '../fileIcons';
import { formatSize, listDir, type RemoteStat } from '../lib/files';
import { shortPath } from '../lib/machine';
import { useStore } from '../state/store';
import { useWorkspacePresets, workspacePresetIds } from '../state/workspacePresets';
import { usePluginOn } from '../plugins/registry';
import { t, type MessageKey } from '../i18n';
import { match } from '../lib/match';
import { rangeOf } from './tree/selection';
import { Highlight } from './Highlight';
import { Picker, type PickerItem } from './Picker';

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
  if (req.kind === 'risk') return <RiskDialog req={req} />;
  if (req.kind === 'download') return <DownloadDialog req={req} />;
  if (req.kind === 'unsaved') return <UnsavedDialog req={req} />;
  return <WorkspaceDialog req={req} />;
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
  const [checked, setChecked] = useState(!!req.checked);
  // A request that replaces another one shown starts from its own state.
  useEffect(() => setChecked(!!req.checked), [req]);
  const done = (ok: boolean, alt = false, extra = false) => {
    closeDialog(req);
    req.resolve(ok, req.check !== undefined ? checked : undefined, alt, extra);
  };
  return (
    <Frame title={req.title} onCancel={() => done(false)}>
      <div className="dialog-body">
        {req.message}
        {req.check !== undefined && (
          <label className="row dialog-check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>{req.check}</span>
          </label>
        )}
      </div>
      <div className="dialog-actions">
        {req.extra && (
          <button data-answer="extra" className="dialog-extra" onClick={() => done(false, false, true)}>
            {req.extra}
          </button>
        )}
        {/* Enter cancels a destructive action unless the user moves to it. */}
        <button autoFocus={req.danger} onClick={() => done(false)}>
          {req.cancel ?? t('dialog.cancel')}
        </button>
        {req.alt && (
          <button data-answer="alt" onClick={() => done(false, true)}>
            {req.alt}
          </button>
        )}
        <button className={req.danger ? 'primary danger' : 'primary'} autoFocus={!req.danger} onClick={() => done(true)}>
          {req.confirm}
        </button>
      </div>
    </Frame>
  );
}

/** Before the app closes: the files with unsaved changes, each with where
 * it is (machine, workspace, tab) and Show, which keeps the app open and
 * shows it; Save All, Don't Save or Cancel. */
function UnsavedDialog({ req }: { req: Extract<DialogRequest, { kind: 'unsaved' }> }) {
  const done = (v: UnsavedAnswer) => {
    closeDialog(req);
    req.resolve(v);
  };
  return (
    <Frame title={t('unsaved.quitTitle')} onCancel={() => done('cancel')}>
      <div className="dialog-body">
        {t('unsaved.quitMessage', { n: req.files.length })}
        <ul className="unsaved-list">
          {req.files.map((f, i) => (
            <li key={i} className="unsaved-file">
              <FileIcon name={f.name} kind="file" />
              <span className="unsaved-name ellipsis" title={f.name}>
                {f.name}
              </span>
              <span className="unsaved-place muted ellipsis" title={f.place}>
                {f.place}
              </span>
              <button className="unsaved-show" data-show={i} onClick={() => done({ show: i })}>
                {t('unsaved.show')}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="dialog-actions">
        <button onClick={() => done('cancel')}>{t('dialog.cancel')}</button>
        <button data-answer="discard" onClick={() => done('discard')}>
          {t('unsaved.discard')}
        </button>
        <button className="primary" autoFocus onClick={() => done('save')}>
          {t('unsaved.saveAll')}
        </button>
      </div>
    </Frame>
  );
}

/** A risk to accept (riskDialog): what is at risk, and the confirm button
 * only once the box is ticked; Cancel has the focus. */
function RiskDialog({ req }: { req: Extract<DialogRequest, { kind: 'risk' }> }) {
  const [accepted, setAccepted] = useState(false);
  useEffect(() => setAccepted(false), [req]);
  const done = (ok: boolean) => {
    closeDialog(req);
    req.resolve(ok);
  };
  return (
    <Frame title={req.title} onCancel={() => done(false)}>
      <div className="dialog-body risk-dialog">
        <p>{req.intro}</p>
        <ul>
          {req.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        {req.outro.map((p) => (
          <p key={p}>{p}</p>
        ))}
        <label className="row dialog-check">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span>{req.check}</span>
        </label>
      </div>
      <div className="dialog-actions">
        <button autoFocus onClick={() => done(false)}>
          {t('dialog.cancel')}
        </button>
        <button className="primary danger" data-answer="accept" disabled={!accepted} onClick={() => accepted && done(true)}>
          {req.confirm}
        </button>
      </div>
    </Frame>
  );
}

const folderMessage: Record<FolderProblem, MessageKey> = {
  missing: 'newWorkspace.missing',
  file: 'newWorkspace.notFolder',
  denied: 'newWorkspace.denied',
};

/** A new workspace's directory, name and optional linked vault presets, or an
 * existing one's (req.edit), whose directory may be left empty. */
function WorkspaceDialog({ req }: { req: Extract<DialogRequest, { kind: 'workspace' }> }) {
  const machine = useStore((s) => s.machines[req.m]?.label ?? req.m);
  const readOnly = useStore((s) => s.readOnly);
  const vaultOn = usePluginOn('vault');
  const presets = useWorkspacePresets((s) => s.presets);
  const presetOrder = useWorkspacePresets((s) => s.order);
  const presetLinks = useWorkspacePresets((s) => s.links);
  const vaultSession = useWorkspacePresets((s) => s.session);
  const verifyEachAllow = useWorkspacePresets((s) => s.verifyEachAllow);
  const edit = !!req.edit;
  const initialPresets = req.edit?.id ? workspacePresetIds(req.m, req.edit.id, presetLinks) : [];
  const [cwd, setCwd] = useState(req.cwd);
  const [label, setLabel] = useState(req.edit?.name ?? '');
  const [pickedPresets, setPickedPresets] = useState<string[]>(initialPresets);
  const [passphrase, setPassphrase] = useState('');
  const [dirs, setDirs] = useState<string[]>([]);
  const [sel, setSel] = useState(-1);
  // A request that replaces another one shown starts from its own state.
  useEffect(() => {
    setCwd(req.cwd);
    setLabel(req.edit?.name ?? '');
    setPickedPresets(req.edit?.id ? workspacePresetIds(req.m, req.edit.id) : []);
    setPassphrase('');
  }, [req]);
  // What the machine says of the typed folder: the absolute path it
  // resolves to, or why it cannot be used; undefined while unknown.
  const [check, setCheck] = useState<{ path: string; problem?: FolderProblem; resolved?: string }>();
  const home = useStore((s) => s.machines[req.m]?.info?.home ?? '');
  const typed = cwd.trim().replace(/(.)\/+$/, '$1');

  const showPresets = vaultOn && (presetOrder.length > 0 || initialPresets.length > 0);
  const canEditPresets = vaultSession && !readOnly;
  const presetsChanged = pickedPresets.length !== initialPresets.length || pickedPresets.some((id, i) => id !== initialPresets[i]);
  const wideningPresets = pickedPresets.some((id) => !initialPresets.includes(id));
  const needPassphrase = showPresets && canEditPresets && verifyEachAllow && wideningPresets;
  const presetItems: PickerItem[] = presetOrder.map((id) => {
    const p = presets[id];
    return {
      value: id,
      label: p?.name ?? id,
      description: p ? t('vault.preset.varCount', { n: p.resolved.length }) : undefined,
      detail: p?.description,
    };
  });
  for (const id of pickedPresets) {
    if (!presetOrder.includes(id)) presetItems.push({ value: id, label: id });
  }

  // Subdirectories matching what is typed, listed on the machine.
  useEffect(() => {
    const ac = new AbortController();
    const id = window.setTimeout(async () => {
      const [dir, prefix] = completionParts(cwd);
      try {
        const list = dir ? await listDir(req.m, dir, ac.signal) : undefined;
        if (ac.signal.aborted) return;
        const names = (list?.entries ?? [])
          .filter((e) => e.is_dir && e.name.startsWith(prefix) && (prefix.startsWith('.') || !e.name.startsWith('.')))
          .map((e) => e.name)
          .sort();
        setDirs(names.length === 1 && names[0] === prefix ? [] : names.slice(0, 8));
      } catch {
        if (!ac.signal.aborted) setDirs([]);
      }
      if (!ac.signal.aborted) setSel(-1);
    }, 120);
    return () => {
      ac.abort();
      window.clearTimeout(id);
    };
  }, [cwd, req.m]);

  // The whole typed path, checked on the machine while it is typed.
  useEffect(() => {
    setCheck(undefined);
    if (!typed) return;
    const ac = new AbortController();
    const id = window.setTimeout(async () => {
      try {
        const d = await listDir(req.m, typed, ac.signal);
        if (ac.signal.aborted) return;
        setCheck(d.dir.is_dir ? { path: typed, resolved: d.dir.path || expandPath(typed, home) } : { path: typed, problem: 'file' });
      } catch (err) {
        const problem = folderProblem(err);
        if (!ac.signal.aborted && problem) setCheck({ path: typed, problem });
      }
    }, 250);
    return () => {
      ac.abort();
      window.clearTimeout(id);
    };
  }, [typed, req.m, home]);
  const problem = check?.path === typed ? check.problem : undefined;
  const resolved = check?.path === typed ? check.resolved : undefined;

  const done = (v: NewWorkspace | undefined) => {
    closeDialog(req);
    req.resolve(v);
  };
  const buildResult = (resolvedCwd: string): NewWorkspace => {
    const out: NewWorkspace = { cwd: resolvedCwd, label: label.trim() };
    if (showPresets && canEditPresets && (edit ? presetsChanged : pickedPresets.length > 0)) {
      out.presets = pickedPresets;
      if (needPassphrase && passphrase) out.passphrase = passphrase;
    }
    return out;
  };
  const complete = (name: string) => {
    const [dir] = completionParts(cwd);
    setCwd(`${dir === '/' ? '' : dir}/${name}/`);
  };
  const submit = async () => {
    if (needPassphrase && !passphrase) return;
    const path = typed;
    // A workspace without a directory follows its focused pane.
    if (!path) return done(buildResult(''));
    try {
      const d = await listDir(req.m, path);
      if (!d.dir.is_dir) throw new Error('not a directory');
      done(buildResult(d.dir.path || expandPath(path, home)));
    } catch (err) {
      setCheck({ path, problem: folderProblem(err) ?? 'missing' });
    }
  };

  return (
    <Frame title={t(edit ? 'editWorkspace.title' : 'newWorkspace.title', { machine })} onCancel={() => done(undefined)}>
      <div className="dialog-body form">
        <label>
          <span>{t('newWorkspace.cwd')}</span>
          <input
            autoFocus
            spellCheck={false}
            value={cwd}
            placeholder={t('editWorkspace.cwdPlaceholder')}
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
        {problem && <div className="error small">{t(folderMessage[problem])}</div>}
        {!problem && resolved && resolved !== typed && <div className="muted small">{t('newWorkspace.resolved', { path: resolved })}</div>}
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
        {showPresets && (
          <div className="workspace-presets-field">
            <span>{t('vault.workspace.presets')}</span>
            <Picker
              multiple
              disabled={!canEditPresets}
              aria-label={t('vault.workspace.presets')}
              label={t('vault.workspace.presets')}
              noneLabel={t('vault.workspace.presetsPick')}
              items={presetItems}
              value={pickedPresets}
              onChange={setPickedPresets}
            />
            {canEditPresets ? (
              <div className="muted small">{t('vault.workspace.presetsHint')}</div>
            ) : (
              <div className="muted small">
                {t('vault.workspace.presetsLocked')}{' '}
                {!readOnly && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      useStore.getState().setPanel('vault');
                      done(undefined);
                    }}
                  >
                    {t('vault.workspace.presetsOpen')}
                  </button>
                )}
              </div>
            )}
            {needPassphrase && (
              <input
                className="input"
                type="password"
                autoComplete="off"
                data-field="workspace-preset-passphrase"
                placeholder={t('vault.fresh.passphrase')}
                aria-label={t('vault.fresh.passphrase')}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            )}
          </div>
        )}
        <div className="muted small">{t(edit ? 'editWorkspace.hint' : 'newWorkspace.hint')}</div>
      </div>
      <div className="dialog-actions">
        <button onClick={() => done(undefined)}>{t('dialog.cancel')}</button>
        <button className="primary" disabled={!!problem || (needPassphrase && !passphrase)} onClick={submit}>
          {t(edit ? 'editWorkspace.save' : 'newWorkspace.create')}
        </button>
      </div>
    </Frame>
  );
}

/** Chooses entries of a directory of a machine to download: several can be
 * checked, directories entered and left; one download takes them all (the
 * hub zips directories and several entries). */
function DownloadDialog({ req }: { req: Extract<DialogRequest, { kind: 'download' }> }) {
  const machine = useStore((s) => s.machines[req.m]?.label ?? req.m);
  const home = useStore((s) => s.machines[req.m]?.info?.home);
  const [dir, setDir] = useState(req.dir);
  const [list, setList] = useState<{ path: string; entries: RemoteStat[] }>();
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  // The entry checked or unchecked last, where a Shift-click's range starts.
  const anchor = useRef<string>(undefined);

  useEffect(() => {
    const ac = new AbortController();
    setList(undefined);
    setError('');
    setChecked(new Set());
    setQuery('');
    anchor.current = undefined;
    listDir(req.m, dir, ac.signal)
      .then((d) => !ac.signal.aborted && setList({ path: d.dir.path ?? dir, entries: d.entries }))
      .catch((e: Error) => !ac.signal.aborted && setError(t('download.listFailed', { dir, error: e.message })));
    return () => {
      ac.abort();
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
  // The entries the filter shows, with the characters it matched.
  const shown = entries.flatMap((e) => {
    const m = match(query, e.name);
    return m ? [{ e, ranges: m.ranges }] : [];
  });
  /** Checks or unchecks an entry; with Shift, every entry shown from the
   * one checked or unchecked last, alike. */
  const toggle = (name: string, shift = false) =>
    setChecked((c) => {
      const next = new Set(c);
      const on = !c.has(name);
      const names = shown.map((x) => x.e.name);
      const from = shift && anchor.current && names.includes(anchor.current) ? anchor.current : name;
      for (const n of rangeOf(names, from, name)) {
        if (on) next.add(n);
        else next.delete(n);
      }
      anchor.current = name;
      return next;
    });
  const all = shown.length > 0 && shown.every((x) => checked.has(x.e.name));
  const some = shown.some((x) => checked.has(x.e.name));
  const setShown = (on: boolean) =>
    setChecked((c) => {
      const next = new Set(c);
      for (const x of shown) {
        if (on) next.add(x.e.name);
        else next.delete(x.e.name);
      }
      return next;
    });
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
        {entries.length > 0 && (
          <input
            className="input download-filter"
            value={query}
            placeholder={t('download.filter')}
            aria-label={t('download.filter')}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Escape clears the filter before it closes the dialog.
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
        )}
        <div className="download-list" role="listbox" aria-multiselectable="true" aria-label={path}>
          {shown.length > 0 && (
            <label className="download-row download-all">
              <input
                type="checkbox"
                checked={all}
                ref={(el) => {
                  if (el) el.indeterminate = some && !all;
                }}
                onChange={() => setShown(!all)}
              />
              <span>{t(query ? 'download.selectShown' : 'download.selectAll')}</span>
            </label>
          )}
          {shown.map(({ e, ranges }) => (
            <div
              key={e.name}
              role="option"
              aria-selected={checked.has(e.name)}
              className={`download-row ${checked.has(e.name) ? 'sel' : ''}`}
              title={e.name}
              onDoubleClick={() => e.is_dir && setDir(full(e.name))}
            >
              <input
                type="checkbox"
                checked={checked.has(e.name)}
                aria-label={e.name}
                // React reports a checkbox's change from its click, which knows Shift.
                onChange={(ev) => toggle(e.name, (ev.nativeEvent as MouseEvent).shiftKey)}
              />
              {e.is_dir ? <Folder /> : <File />}
              {e.is_dir ? (
                <button className="link download-name ellipsis" onClick={() => setDir(full(e.name))}>
                  <Highlight text={e.name} ranges={ranges} />
                </button>
              ) : (
                <span className="download-name ellipsis" onClick={(ev) => toggle(e.name, ev.shiftKey)}>
                  <Highlight text={e.name} ranges={ranges} />
                </span>
              )}
              <span className="muted small">{e.is_dir ? '' : formatSize(e.size)}</span>
            </div>
          ))}
          {!list && !error && <div className="muted small">{t('download.loading')}</div>}
          {list && entries.length === 0 && <div className="muted small">{t('download.empty')}</div>}
          {entries.length > 0 && shown.length === 0 && <div className="muted small">{t('download.noMatch')}</div>}
          {error && <div className="error small">{error}</div>}
        </div>
        <div className="muted small">{t('download.hint')}</div>
      </div>
      <div className="dialog-actions">
        <span className="muted small spacer">{checked.size > 0 && t('download.selected', { n: checked.size })}</span>
        {checked.size > 0 && (
          <button type="button" className="ghost" onClick={() => setChecked(new Set())}>
            {t('download.clear')}
          </button>
        )}
        <button onClick={done}>{t('dialog.cancel')}</button>
        <button className="primary" disabled={checked.size === 0} onClick={download}>
          {t('download.button')}
        </button>
      </div>
    </Frame>
  );
}
