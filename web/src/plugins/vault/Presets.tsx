// The vault panel's presets tab: named collections of variables and groups
// that can be linked to workspaces for automatic env injection when new
// panels (terminals and chats) are created.
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Folder, Layers, Link2, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { useStore } from '../../state/store';
import { useTerms } from '../../state/terms';
import * as L from '../../term/layout';
import { resolvePresetSummary, workspaceKey } from '../../state/workspacePresets';
import { confirmDialog } from '../../dialog';
import { t } from '../../i18n';
import { Picker, type PickerItem } from '../../components/Picker';
import { errorText, loadVault, useVault, vaultApi, VaultError, type VaultPreset } from './api';
import { FreshPassphrase } from './fields';

export function Presets({ session }: { session: boolean }) {
  const presets = useVault((s) => s.presets);
  const variables = useVault((s) => s.variables);
  const groups = useVault((s) => s.groups);
  const workspaceLinks = useVault((s) => s.workspaceLinks);
  const machines = useStore((s) => s.machines);
  const termMachines = useTerms((s) => s.machines);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<VaultPreset | 'new' | undefined>();
  const [linking, setLinking] = useState<VaultPreset | undefined>();

  const groupNames = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);

  const linksByPreset = useMemo(() => {
    const map = new Map<string, Array<{ machine: string; workspace: string }>>();
    for (const l of workspaceLinks) {
      for (const pid of l.presets) {
        const list = map.get(pid) ?? [];
        list.push({ machine: l.machine, workspace: l.workspace });
        map.set(pid, list);
      }
    }
    return map;
  }, [workspaceLinks]);

  const workspaceLabel = (machine: string, wsId: string): string => {
    const m = machines[machine];
    const mLabel = m?.label ?? machine;
    const w = termMachines[machine]?.layout?.workspaces.find((x) => x.id === wsId);
    const wLabel = w ? L.workspaceTitle(w, m?.info?.home) : wsId;
    return `${mLabel} · ${wLabel}`;
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return presets;
    return presets.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q) ||
        p.variables.some((v) => v.toLowerCase().includes(q)) ||
        p.groups.some((gid) => (groupNames.get(gid) ?? '').toLowerCase().includes(q)),
    );
  }, [presets, query, groupNames]);

  const removePreset = async (preset: VaultPreset) => {
    const ok = await confirmDialog({
      title: t('vault.preset.deleteTitle'),
      message: t('vault.preset.deleteMessage', { name: preset.name }),
      confirm: t('vault.delete'),
      danger: true,
    });
    if (!ok) return;
    await vaultApi.deletePreset(preset.id);
    await loadVault();
  };

  return (
    <>
      <div className="vault-toolbar">
        <label className="vault-search">
          <Search />
          <input
            type="search"
            placeholder={t('vault.preset.search')}
            aria-label={t('vault.preset.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          className="primary sm"
          data-action="add-preset"
          disabled={!session}
          title={session ? undefined : t('vault.needSession')}
          onClick={() => setEditing('new')}
        >
          <Plus /> {t('vault.preset.add')}
        </button>
      </div>
      {presets.length === 0 ? (
        <div className="empty-note">
          <Layers />
          {t('vault.preset.empty')}
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-note">{t('vault.preset.noMatch')}</div>
      ) : (
        <ul className="vault-list vault-preset-list">
          {shown.map((preset) => {
            const summary = resolvePresetSummary(preset, variables);
            const missingSet = new Set(summary.missing);
            const linked = linksByPreset.get(preset.id) ?? [];
            return (
              <li key={preset.id} className="vault-preset-row" data-preset={preset.id}>
                <div className="vault-preset-main">
                  <div className="vault-row-head">
                    <span className="vault-preset-name ellipsis">{preset.name}</span>
                    <span className="tag">{t('vault.preset.varCount', { n: summary.resolved.length })}</span>
                    {summary.missing.length > 0 && (
                      <span
                        className="tag warn vault-missing-tag"
                        title={t('vault.preset.missingHint', { names: summary.missing.join(', ') })}
                      >
                        <AlertTriangle /> {summary.missing.length} {t('vault.preset.missing')}
                      </span>
                    )}
                  </div>
                  {preset.description && <div className="vault-desc">{preset.description}</div>}
                  {(preset.groups.length > 0 || preset.variables.length > 0) && (
                    <div className="vault-chips vault-preset-members">
                      {preset.groups.map((gid) => (
                        <span key={`g:${gid}`} className="vault-group-chip">
                          <Folder /> {groupNames.get(gid) ?? gid}
                        </span>
                      ))}
                      {preset.variables.map((name) => (
                        <code key={`v:${name}`} className={missingSet.has(name) ? 'missing' : undefined}>
                          {name}
                          {missingSet.has(name) && ` (${t('vault.preset.missing')})`}
                        </code>
                      ))}
                    </div>
                  )}
                  <div className="vault-preset-links">
                    {linked.length > 0 ? (
                      linked.map((l) => (
                        <span key={workspaceKey(l.machine, l.workspace)} className="vault-link-chip">
                          <Link2 /> {workspaceLabel(l.machine, l.workspace)}
                        </span>
                      ))
                    ) : (
                      <span className="muted small">{t('vault.preset.notLinked')}</span>
                    )}
                  </div>
                </div>
                <div className="vault-row-actions">
                  <button
                    className="icon sm"
                    title={session ? t('vault.preset.link') : t('vault.needSession')}
                    aria-label={t('vault.preset.link')}
                    data-action="link-preset"
                    disabled={!session}
                    onClick={() => setLinking(preset)}
                  >
                    <Link2 />
                  </button>
                  <button
                    className="icon sm"
                    title={session ? t('vault.edit') : t('vault.needSession')}
                    aria-label={t('vault.edit')}
                    data-action="edit-preset"
                    disabled={!session}
                    onClick={() => setEditing(preset)}
                  >
                    <Pencil />
                  </button>
                  <button
                    className="icon sm danger-text"
                    title={session ? t('vault.delete') : t('vault.needSession')}
                    aria-label={t('vault.delete')}
                    data-action="delete-preset"
                    disabled={!session}
                    onClick={() => void removePreset(preset)}
                  >
                    <Trash2 />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing && <PresetEditor preset={editing === 'new' ? undefined : editing} onDone={() => setEditing(undefined)} />}
      {linking && <LinkWorkspacesDialog preset={linking} onDone={() => setLinking(undefined)} />}
    </>
  );
}

/** Creates or edits a preset: name, description, included groups and variables. */
function PresetEditor({ preset, onDone }: { preset?: VaultPreset; onDone(): void }) {
  const variables = useVault((s) => s.variables);
  const groups = useVault((s) => s.groups);
  const workspaceLinks = useVault((s) => s.workspaceLinks);
  const guard = useVault((s) => s.guard);

  const [name, setName] = useState(preset?.name ?? '');
  const [description, setDescription] = useState(preset?.description ?? '');
  const [pickedGroups, setPickedGroups] = useState<string[]>(preset?.groups ?? []);
  const [pickedVars, setPickedVars] = useState<string[]>(preset?.variables ?? []);
  const [asking, setAsking] = useState(false);
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const groupNames = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const groupItems: PickerItem[] = useMemo(
    () =>
      groups.map((g) => ({
        value: g.id,
        label: g.name,
        icon: <Folder />,
        description: `${variables.filter((v) => v.group === g.id).length}`,
      })),
    [groups, variables],
  );
  const varItems: PickerItem[] = useMemo(() => {
    const items: PickerItem[] = variables.map((v) => ({
      value: v.name,
      label: v.name,
      description: v.description || undefined,
      group: v.group ? (groupNames.get(v.group) ?? t('vault.group.none')) : t('vault.group.none'),
    }));
    const existing = new Set(variables.map((v) => v.name));
    for (const v of pickedVars) {
      if (!existing.has(v)) items.push({ value: v, label: v, description: t('vault.preset.missing') });
    }
    return items;
  }, [variables, groupNames, pickedVars]);

  const summary = useMemo(
    () => resolvePresetSummary({ id: preset?.id ?? '', name: name.trim(), variables: pickedVars, groups: pickedGroups }, variables),
    [preset?.id, name, pickedVars, pickedGroups, variables],
  );

  const isLinked = !!preset && workspaceLinks.some((l) => l.presets.includes(preset.id));
  const widensLinked =
    !!preset && isLinked && (pickedVars.some((v) => !preset.variables.includes(v)) || pickedGroups.some((g) => !preset.groups.includes(g)));

  const trimmed = name.trim();
  const nameOk = trimmed.length > 0 && trimmed.length <= 128;

  const save = async () => {
    if (!nameOk) return;
    if (!!guard?.verifyEachAllow && widensLinked && !asking) {
      setAsking(true);
      return;
    }
    setErr('');
    setBusy(true);
    try {
      const fresh = asking && pass ? { passphrase: pass } : undefined;
      if (preset) {
        await vaultApi.updatePreset(
          preset.id,
          { name: trimmed, description: description.trim(), variables: pickedVars, groups: pickedGroups },
          fresh,
        );
      } else {
        await vaultApi.createPreset({
          name: trimmed,
          description: description.trim(),
          variables: pickedVars,
          groups: pickedGroups,
        });
      }
      await loadVault();
      onDone();
    } catch (e) {
      if (e instanceof VaultError && e.code === 'vault_proof' && !asking) {
        setAsking(true);
        setErr('');
      } else {
        setErr(errorText(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!preset) return;
    const ok = await confirmDialog({
      title: t('vault.preset.deleteTitle'),
      message: t('vault.preset.deleteMessage', { name: preset.name }),
      confirm: t('vault.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await vaultApi.deletePreset(preset.id);
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
        aria-label={preset ? t('vault.preset.editTitle', { name: preset.name }) : t('vault.preset.addTitle')}
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
          <span className="modal-title">{preset ? t('vault.preset.editTitle', { name: preset.name }) : t('vault.preset.addTitle')}</span>
          <span className="spacer" />
          <button type="button" className="icon" title={t('dialog.cancel')} aria-label={t('dialog.cancel')} onClick={onDone}>
            <X />
          </button>
        </div>
        <div className="dialog-body vault-fields">
          <label className="vault-field">
            <span>{t('vault.preset.name')}</span>
            <input
              className="input"
              value={name}
              autoFocus
              maxLength={128}
              placeholder="Production API"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="vault-field">
            <span>{t('vault.preset.description')}</span>
            <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          {groups.length > 0 && (
            <div className="vault-field">
              <span>{t('vault.preset.groups')}</span>
              <Picker
                multiple
                aria-label={t('vault.preset.groups')}
                label={t('vault.preset.groups')}
                noneLabel={t('vault.preset.groupsPick')}
                placeholder={t('vault.group.search')}
                emptyText={t('vault.group.noMatch')}
                items={groupItems}
                value={pickedGroups}
                onChange={setPickedGroups}
              />
            </div>
          )}
          <div className="vault-field">
            <span>{t('vault.preset.variables')}</span>
            <Picker
              multiple
              aria-label={t('vault.preset.variables')}
              label={t('vault.preset.variables')}
              noneLabel={t('vault.preset.variablesPick')}
              items={varItems}
              value={pickedVars}
              onChange={setPickedVars}
            />
          </div>
          {summary.missing.length > 0 && (
            <div className="callout warning vault-missing-banner">
              <span>{t('vault.preset.missingHint', { names: summary.missing.join(', ') })}</span>
              <button
                type="button"
                className="sm"
                data-action="remove-missing"
                onClick={() => setPickedVars((cur) => cur.filter((v) => !summary.missing.includes(v)))}
              >
                {t('vault.preset.removeMissing')}
              </button>
            </div>
          )}
          <div className="vault-field">
            <small className="muted">
              {summary.resolved.length ? t('vault.preset.resolved', { n: summary.resolved.length }) : t('vault.preset.resolvedNone')}
            </small>
            {summary.resolved.length > 0 && (
              <div className="vault-chips">
                {summary.resolved.map((n) => (
                  <code key={n}>{n}</code>
                ))}
              </div>
            )}
          </div>
          {asking && (
            <div className="vault-field" data-fresh="preset">
              <small>{t('vault.preset.freshWiden')}</small>
              <FreshPassphrase value={pass} onChange={setPass} />
            </div>
          )}
          {err && <div className="callout error">{err}</div>}
        </div>
        <div className="dialog-actions">
          {preset && (
            <button type="button" className="ghost danger-text" onClick={() => void remove()}>
              <Trash2 /> {t('vault.delete')}
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={onDone}>
            {t('dialog.cancel')}
          </button>
          <button className="primary" type="submit" disabled={busy || !nameOk || (asking && !pass)}>
            {t('vault.save')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** Links or unlinks a preset across workspaces on all machines. */
function LinkWorkspacesDialog({ preset, onDone }: { preset: VaultPreset; onDone(): void }) {
  const workspaceLinks = useVault((s) => s.workspaceLinks);
  const guard = useVault((s) => s.guard);
  const machines = useStore((s) => s.machines);
  const order = useStore((s) => s.order);
  const termMachines = useTerms((s) => s.machines);

  const initialByWs = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const l of workspaceLinks) map.set(workspaceKey(l.machine, l.workspace), l.presets);
    return map;
  }, [workspaceLinks]);

  const rows = useMemo(() => {
    const list: Array<{ machine: string; machineLabel: string; workspace: string; workspaceLabel: string; cwd?: string }> = [];
    const seen = new Set<string>();
    for (const mId of order) {
      const m = machines[mId];
      const layout = termMachines[mId]?.layout;
      if (!layout) continue;
      for (const w of layout.workspaces) {
        const key = workspaceKey(mId, w.id);
        seen.add(key);
        list.push({
          machine: mId,
          machineLabel: m?.label ?? mId,
          workspace: w.id,
          workspaceLabel: L.workspaceTitle(w, m?.info?.home),
          cwd: w.cwd || undefined,
        });
      }
    }
    // Also show workspaces already linked to this preset even when their machine layout is not loaded yet.
    for (const l of workspaceLinks) {
      const key = workspaceKey(l.machine, l.workspace);
      if (seen.has(key) || !l.presets.includes(preset.id)) continue;
      seen.add(key);
      list.push({
        machine: l.machine,
        machineLabel: machines[l.machine]?.label ?? l.machine,
        workspace: l.workspace,
        workspaceLabel: l.workspace,
      });
    }
    return list;
  }, [order, machines, termMachines, workspaceLinks, preset.id]);

  const initialSelected = useMemo(
    () =>
      new Set(
        rows
          .filter((r) => (initialByWs.get(workspaceKey(r.machine, r.workspace)) ?? []).includes(preset.id))
          .map((r) => workspaceKey(r.machine, r.workspace)),
      ),
    [rows, initialByWs, preset.id],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected));
  const [asking, setAsking] = useState(false);
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = (key: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const allKeys = useMemo(() => rows.map((r) => workspaceKey(r.machine, r.workspace)), [rows]);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));
  const someSelected = allKeys.some((k) => selected.has(k));
  const selectAll = () => setSelected(new Set(allKeys));
  const clearAll = () => setSelected(new Set());

  const changed = rows.filter((r) => {
    const key = workspaceKey(r.machine, r.workspace);
    return selected.has(key) !== initialSelected.has(key);
  });
  const widening = changed.some((r) => selected.has(workspaceKey(r.machine, r.workspace)));

  const save = async () => {
    if (!changed.length) return onDone();
    if (!!guard?.verifyEachAllow && widening && !asking) {
      setAsking(true);
      return;
    }
    setErr('');
    setBusy(true);
    try {
      const fresh = asking && pass ? { passphrase: pass } : undefined;
      for (const r of changed) {
        const key = workspaceKey(r.machine, r.workspace);
        const cur = initialByWs.get(key) ?? [];
        const next = selected.has(key) ? [...new Set([...cur, preset.id])] : cur.filter((id) => id !== preset.id);
        await vaultApi.setWorkspacePresets(r.machine, r.workspace, next, fresh);
      }
      await loadVault();
      onDone();
    } catch (e) {
      if (e instanceof VaultError && e.code === 'vault_proof' && !asking) {
        setAsking(true);
        setErr('');
      } else {
        setErr(errorText(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <form
        className="modal dialog vault-editor"
        role="dialog"
        aria-label={t('vault.preset.linkTitle', { name: preset.name })}
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
          <span className="modal-title">{t('vault.preset.linkTitle', { name: preset.name })}</span>
          <span className="spacer" />
          <button type="button" className="icon" title={t('dialog.cancel')} aria-label={t('dialog.cancel')} onClick={onDone}>
            <X />
          </button>
        </div>
        <div className="dialog-body vault-fields">
          {rows.length === 0 ? (
            <div className="empty-note">{t('vault.preset.linkEmpty')}</div>
          ) : (
            <>
              <div className="vault-select-bar" data-selected={selected.size}>
                <label className="vault-link-select-all">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected && !allSelected;
                    }}
                    onChange={(e) => (e.target.checked ? selectAll() : clearAll())}
                  />
                  <span>{t('vault.preset.linkSelectAll')}</span>
                </label>
                <span className="spacer" />
                {selected.size > 0 && (
                  <button type="button" className="ghost sm" data-action="clear-links" onClick={clearAll}>
                    {t('vault.preset.linkDeselectAll')}
                  </button>
                )}
              </div>
              <ul className="vault-link-list">
                {rows.map((r) => {
                  const key = workspaceKey(r.machine, r.workspace);
                  const checked = selected.has(key);
                  return (
                    <li key={key}>
                      <label className="vault-link-option">
                        <input type="checkbox" checked={checked} onChange={() => toggle(key)} />
                        <span className="vault-link-text">
                          <b>
                            {r.machineLabel} · {r.workspaceLabel}
                          </b>
                          {r.cwd && <small className="muted ellipsis">{r.cwd}</small>}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {asking && (
            <div className="vault-field" data-fresh="link">
              <small>{t('vault.preset.freshLink')}</small>
              <FreshPassphrase value={pass} onChange={setPass} />
            </div>
          )}
          {err && <div className="callout error">{err}</div>}
        </div>
        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" onClick={onDone}>
            {t('dialog.cancel')}
          </button>
          <button className="primary" type="submit" disabled={busy || rows.length === 0 || (asking && !pass)}>
            {t('vault.save')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
