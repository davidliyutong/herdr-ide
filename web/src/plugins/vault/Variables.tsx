// The vault panel's variables: the list (never their values, except one
// revealed on request), user-defined groups with ungrouped fallback, what
// machines may read each, changes of several at once and the editor in a
// dialog.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  FileUp,
  Folder,
  FolderInput,
  FolderPlus,
  KeyRound,
  Monitor,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useStore } from '../../state/store';
import { confirmDialog } from '../../dialog';
import { t } from '../../i18n';
import { errorText, loadVault, useVault, vaultApi, VaultError, type VaultGroup, type VaultVariable } from './api';
import { Picker } from '../../components/Picker';
import { FreshPassphrase } from './fields';
import { openVaultExport, openVaultImport } from './dialogs';
import { ways, widens, withFresh } from './proof';
import { CopyButton, machineItems } from './shared';

const FILTER_ALL = '__all__';
const FILTER_UNGROUPED = '__ungrouped__';

export function Variables({ session }: { session: boolean }) {
  const variables = useVault((s) => s.variables);
  const groups = useVault((s) => s.groups);
  const readOnly = useStore((s) => s.readOnly);
  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState<string>(FILTER_ALL);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<VaultVariable | 'new' | undefined>();
  const [editingGroup, setEditingGroup] = useState<VaultGroup | 'new' | undefined>();
  const [picked, setPicked] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string>();
  const [bulkAccess, setBulkAccess] = useState(false);
  const [bulkGroup, setBulkGroup] = useState(false);
  const [bulkErr, setBulkErr] = useState('');

  // Fall back to All if the filtered group was deleted.
  const activeFilter =
    groupFilter === FILTER_ALL || groupFilter === FILTER_UNGROUPED || groups.some((g) => g.id === groupFilter) ? groupFilter : FILTER_ALL;

  const groupIds = useMemo(() => new Set(groups.map((g) => g.id)), [groups]);
  const counts = useMemo(() => {
    const byGroup = new Map<string, number>();
    let ungrouped = 0;
    for (const v of variables) {
      if (v.group && groupIds.has(v.group)) byGroup.set(v.group, (byGroup.get(v.group) ?? 0) + 1);
      else ungrouped++;
    }
    return { byGroup, ungrouped };
  }, [variables, groupIds]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return variables.filter((v) => {
      if (activeFilter === FILTER_UNGROUPED) {
        if (v.group && groupIds.has(v.group)) return false;
      } else if (activeFilter !== FILTER_ALL) {
        if (v.group !== activeFilter) return false;
      }
      return !q || v.name.toLowerCase().includes(q) || v.description.toLowerCase().includes(q);
    });
  }, [variables, activeFilter, groupIds, query]);

  // The selection holds variables that are still there.
  const selected = picked.filter((n) => variables.some((v) => v.name === n));
  const shownNames = shown.map((v) => v.name);
  const allShown = shownNames.length > 0 && shownNames.every((n) => selected.includes(n));
  const someShown = shownNames.some((n) => selected.includes(n));

  /** A row's checkbox: shift extends from the last one clicked. */
  const toggle = (name: string, on: boolean, range: boolean) => {
    const from = anchor ? shownNames.indexOf(anchor) : -1;
    const to = shownNames.indexOf(name);
    const names = range && from >= 0 && to >= 0 ? shownNames.slice(Math.min(from, to), Math.max(from, to) + 1) : [name];
    setPicked((p) => (on ? [...p.filter((n) => !names.includes(n)), ...names] : p.filter((n) => !names.includes(n))));
    setAnchor(name);
  };

  const removeSelected = async () => {
    const ok = await confirmDialog({
      title: t('vault.bulk.deleteTitle', { n: selected.length }),
      message: t('vault.bulk.deleteMessage', { names: selected.join(', ') }),
      confirm: t('vault.delete'),
      danger: true,
    });
    if (!ok) return;
    setBulkErr(await eachVariable(selected, (n) => vaultApi.remove(n)));
    setPicked([]);
    await loadVault();
  };

  const removeGroup = async (group: VaultGroup) => {
    const ok = await confirmDialog({
      title: t('vault.group.deleteTitle'),
      message: t('vault.group.deleteMessage', { name: group.name }),
      confirm: t('vault.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await vaultApi.deleteGroup(group.id);
      if (groupFilter === group.id) setGroupFilter(FILTER_ALL);
      await loadVault();
    } catch (e) {
      setBulkErr(errorText(e));
    }
  };

  const toggleCollapse = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const activeGroupObj =
    activeFilter !== FILTER_ALL && activeFilter !== FILTER_UNGROUPED ? groups.find((g) => g.id === activeFilter) : undefined;
  const showGroupedSections = groups.length > 0 && activeFilter === FILTER_ALL;

  const groupedSections = useMemo(() => {
    if (!showGroupedSections) return [];
    const q = query.trim();
    const sections: Array<{ id: string; group?: VaultGroup; title: string; description?: string; items: VaultVariable[] }> = [];
    for (const g of groups) {
      const items = shown.filter((v) => v.group === g.id);
      if (items.length > 0 || !q) sections.push({ id: g.id, group: g, title: g.name, description: g.description, items });
    }
    const ungrouped = shown.filter((v) => !v.group || !groupIds.has(v.group));
    if (ungrouped.length > 0) sections.push({ id: FILTER_UNGROUPED, title: t('vault.group.none'), items: ungrouped });
    return sections;
  }, [showGroupedSections, groups, shown, groupIds, query]);

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
          className="icon sm"
          data-action="add-group"
          disabled={!session}
          title={session ? t('vault.group.add') : t('vault.needSession')}
          aria-label={t('vault.group.add')}
          onClick={() => setEditingGroup('new')}
        >
          <FolderPlus />
        </button>
        <button
          className="icon sm"
          data-action="import"
          disabled={readOnly}
          title={t('vault.import.title')}
          aria-label={t('vault.import.open')}
          onClick={() => openVaultImport()}
        >
          <FileUp />
        </button>
        <button
          className="icon sm"
          data-action="export"
          disabled={readOnly || variables.length === 0}
          title={t('vault.export.title')}
          aria-label={t('vault.export.open')}
          onClick={() => openVaultExport(selected)}
        >
          <Download />
        </button>
        <button
          className="primary sm"
          disabled={!session}
          title={session ? undefined : t('vault.needSession')}
          onClick={() => setEditing('new')}
        >
          <Plus /> {t('vault.add')}
        </button>
      </div>
      {groups.length > 0 && (
        <div className="vault-group-bar" role="group" aria-label={t('vault.group')}>
          <button
            type="button"
            className={`vault-group-pill${activeFilter === FILTER_ALL ? ' on' : ''}`}
            data-group-filter="all"
            onClick={() => setGroupFilter(FILTER_ALL)}
          >
            {t('vault.group.all')} <span className="muted">{variables.length}</span>
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`vault-group-pill${activeFilter === g.id ? ' on' : ''}`}
              data-group-filter={g.id}
              onClick={() => setGroupFilter(g.id)}
            >
              <Folder /> {g.name} <span className="muted">{counts.byGroup.get(g.id) ?? 0}</span>
            </button>
          ))}
          <button
            type="button"
            className={`vault-group-pill${activeFilter === FILTER_UNGROUPED ? ' on' : ''}`}
            data-group-filter="ungrouped"
            onClick={() => setGroupFilter(FILTER_UNGROUPED)}
          >
            {t('vault.group.none')} <span className="muted">{counts.ungrouped}</span>
          </button>
        </div>
      )}
      {activeGroupObj && (
        <div className="vault-active-group" data-group-header={activeGroupObj.id}>
          <div className="vault-active-group-text">
            <b>{activeGroupObj.name}</b>
            {activeGroupObj.description && <small className="muted">{activeGroupObj.description}</small>}
          </div>
          {session && (
            <div className="vault-group-actions">
              <button
                type="button"
                className="icon sm"
                data-action="edit-group"
                title={t('vault.group.rename')}
                aria-label={t('vault.group.rename')}
                onClick={() => setEditingGroup(activeGroupObj)}
              >
                <Pencil />
              </button>
              <button
                type="button"
                className="icon sm danger-text"
                data-action="delete-group"
                title={t('vault.group.delete')}
                aria-label={t('vault.group.delete')}
                onClick={() => void removeGroup(activeGroupObj)}
              >
                <Trash2 />
              </button>
            </div>
          )}
        </div>
      )}
      {variables.length === 0 && groups.length === 0 ? (
        <div className="empty-note">
          <KeyRound />
          {t('vault.empty')}
        </div>
      ) : (
        <>
          {shown.length > 0 && (
            <div className="vault-select-bar" data-selected={selected.length}>
              <input
                type="checkbox"
                aria-label={t('vault.bulk.selectAll')}
                title={t('vault.bulk.selectAll')}
                checked={allShown}
                ref={(el) => {
                  if (el) el.indeterminate = someShown && !allShown;
                }}
                onChange={(e) =>
                  setPicked((p) =>
                    e.target.checked
                      ? [...p.filter((n) => !shownNames.includes(n)), ...shownNames]
                      : p.filter((n) => !shownNames.includes(n)),
                  )
                }
              />
              {selected.length > 0 && (
                <>
                  <b>{t('vault.bulk.selected', { n: selected.length })}</b>
                  <span className="spacer" />
                  <button className="sm ghost" data-bulk="export" disabled={readOnly} onClick={() => openVaultExport(selected)}>
                    <Download /> {t('vault.export.open')}
                  </button>
                  {groups.length > 0 && (
                    <button
                      className="sm ghost"
                      data-bulk="group"
                      disabled={!session}
                      title={session ? undefined : t('vault.needSession')}
                      onClick={() => setBulkGroup(true)}
                    >
                      <FolderInput /> {t('vault.bulk.group')}
                    </button>
                  )}
                  <button
                    className="sm ghost"
                    data-bulk="access"
                    disabled={!session}
                    title={session ? undefined : t('vault.needSession')}
                    onClick={() => setBulkAccess(true)}
                  >
                    <Monitor /> {t('vault.bulk.access')}
                  </button>
                  <button
                    className="sm ghost danger-text"
                    data-bulk="delete"
                    disabled={!session}
                    title={session ? undefined : t('vault.needSession')}
                    onClick={() => void removeSelected()}
                  >
                    <Trash2 /> {t('vault.delete')}
                  </button>
                  <button
                    className="icon sm"
                    title={t('vault.bulk.clear')}
                    aria-label={t('vault.bulk.clear')}
                    onClick={() => setPicked([])}
                  >
                    <X />
                  </button>
                </>
              )}
            </div>
          )}
          {bulkErr && <div className="callout error">{bulkErr}</div>}
          {showGroupedSections ? (
            groupedSections.length === 0 ? (
              <div className="empty-note">{t('vault.noMatch')}</div>
            ) : (
              <div className="vault-groups">
                {groupedSections.map((sec) => {
                  const isCollapsed = !!collapsed[sec.id];
                  return (
                    <section key={sec.id} className="vault-group-section" data-group-section={sec.id}>
                      <div className="vault-group-head">
                        <button
                          type="button"
                          className="vault-group-toggle"
                          aria-expanded={!isCollapsed}
                          onClick={() => toggleCollapse(sec.id)}
                        >
                          {isCollapsed ? <ChevronRight /> : <ChevronDown />}
                          {sec.group && <Folder />}
                          <span className="vault-group-title ellipsis" title={sec.description}>
                            {sec.title}
                          </span>
                          <span className="muted small">{sec.items.length}</span>
                        </button>
                        {sec.group && session && (
                          <div className="vault-group-actions">
                            <button
                              type="button"
                              className="icon sm"
                              data-action="edit-group"
                              title={t('vault.group.rename')}
                              aria-label={t('vault.group.rename')}
                              onClick={() => setEditingGroup(sec.group)}
                            >
                              <Pencil />
                            </button>
                            <button
                              type="button"
                              className="icon sm danger-text"
                              data-action="delete-group"
                              title={t('vault.group.delete')}
                              aria-label={t('vault.group.delete')}
                              onClick={() => void removeGroup(sec.group!)}
                            >
                              <Trash2 />
                            </button>
                          </div>
                        )}
                      </div>
                      {!isCollapsed &&
                        (sec.items.length === 0 ? (
                          <div className="vault-group-empty muted small">{t('vault.group.empty')}</div>
                        ) : (
                          <ul className="vault-list">
                            {sec.items.map((v) => (
                              <Row
                                key={v.name}
                                v={v}
                                session={session}
                                selected={selected.includes(v.name)}
                                onSelect={(on, range) => toggle(v.name, on, range)}
                                onEdit={() => setEditing(v)}
                              />
                            ))}
                          </ul>
                        ))}
                    </section>
                  );
                })}
              </div>
            )
          ) : shown.length === 0 ? (
            <div className="empty-note">{query.trim() ? t('vault.noMatch') : t('vault.group.empty')}</div>
          ) : (
            <ul className="vault-list">
              {shown.map((v) => (
                <Row
                  key={v.name}
                  v={v}
                  session={session}
                  selected={selected.includes(v.name)}
                  onSelect={(on, range) => toggle(v.name, on, range)}
                  onEdit={() => setEditing(v)}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {editing && (
        <Editor
          variable={editing === 'new' ? undefined : editing}
          defaultGroup={editing === 'new' && activeGroupObj ? activeGroupObj.id : undefined}
          onDone={() => setEditing(undefined)}
        />
      )}
      {editingGroup && <GroupEditor group={editingGroup === 'new' ? undefined : editingGroup} onDone={() => setEditingGroup(undefined)} />}
      {bulkAccess && (
        <BulkAccess
          names={selected}
          onDone={(err) => {
            setBulkAccess(false);
            setBulkErr(err ?? '');
          }}
        />
      )}
      {bulkGroup && (
        <BulkGroup
          names={selected}
          onDone={(err) => {
            setBulkGroup(false);
            setBulkErr(err ?? '');
            if (!err) setPicked([]);
          }}
        />
      )}
    </>
  );
}

/** Runs change for each variable in turn (one call each: a failure leaves
 * the others changed) and says which failed, and why. */
async function eachVariable(names: string[], change: (name: string) => Promise<unknown>): Promise<string> {
  const failed: string[] = [];
  for (const n of names) {
    try {
      await change(n);
    } catch (e) {
      failed.push(`${n}: ${errorText(e)}`);
      // Without the session, the others fail alike.
      if (e instanceof VaultError && e.code === 'vault_session') break;
    }
  }
  return failed.length ? t('vault.bulk.failed', { failed: failed.join('; ') }) : '';
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

function Row({
  v,
  session,
  selected,
  onSelect,
  onEdit,
}: {
  v: VaultVariable;
  session: boolean;
  selected: boolean;
  onSelect(on: boolean, range: boolean): void;
  onEdit(): void;
}) {
  const guard = useVault((s) => s.guard);
  const [value, setValue] = useState<string>();
  const [err, setErr] = useState('');
  // Where every Allow is verified and no authenticator can answer, the
  // passphrase is asked here.
  const [asking, setAsking] = useState(false);
  const [pass, setPass] = useState('');
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
    if (ok) await show();
  };
  const show = async (passphrase?: string) => {
    try {
      const r = await withFresh({
        guard,
        purpose: { for: 'reveal', request: v.name },
        needed: !!guard?.verifyEachAllow,
        passphrase,
        send: (fresh) => vaultApi.reveal(v.name, fresh),
      });
      if (r.done) {
        setValue(r.value.value);
        setErr('');
        setAsking(false);
        setPass('');
      } else if (r.reason === 'passphrase') {
        setErr('');
        setAsking(true);
      } else setErr(t('vault.proof.cancelled'));
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <li className={`vault-row${selected ? ' selected' : ''}`} data-name={v.name}>
      <input
        type="checkbox"
        className="vault-row-check"
        aria-label={t('vault.bulk.select', { name: v.name })}
        checked={selected}
        onClick={(e) => onSelect(e.currentTarget.checked, e.shiftKey)}
        onChange={() => {}}
      />
      <div className="vault-row-main">
        <div className="vault-row-head">
          <code className="vault-name ellipsis">{v.name}</code>
          <CopyButton text={v.name} label={t('vault.copyName')} action="copy-name" />
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
      {asking && value === undefined && (
        <form
          className="vault-request-actions"
          data-fresh="reveal"
          onSubmit={(e) => {
            e.preventDefault();
            void show(pass);
          }}
        >
          <FreshPassphrase value={pass} onChange={setPass} />
          <div className="vault-request-buttons">
            <button
              type="button"
              onClick={() => {
                setAsking(false);
                setPass('');
                setErr('');
              }}
            >
              {t('dialog.cancel')}
            </button>
            <span className="spacer" />
            <button className="primary" type="submit" disabled={!pass}>
              {t('vault.reveal')}
            </button>
          </div>
        </form>
      )}
      {value !== undefined && (
        <div className="vault-value">
          <code>{value}</code>
          <CopyButton text={value} label={t('vault.copy')} />
        </div>
      )}
      {err && <div className="callout error">{err}</div>}
    </li>
  );
}

type AccessMode = 'ask' | 'some' | 'all';

/** Who may read without asking: ask every time, chosen machines (with
 * their state), all machines. */
function AccessChooser({
  mode,
  picked,
  onMode,
  onPicked,
}: {
  mode: AccessMode;
  picked: string[];
  onMode(m: AccessMode): void;
  onPicked(f: (p: string[]) => string[]): void;
}) {
  const machines = useStore((s) => s.machines);
  const order = useStore((s) => s.order);
  return (
    <fieldset className="vault-field">
      <legend>{t('vault.machines')}</legend>
      <div className="vault-modes" role="radiogroup">
        {(['ask', 'some', 'all'] as const).map((m) => (
          <label key={m} className={`vault-mode ${mode === m ? 'on' : ''}`}>
            <input type="radio" name="access" checked={mode === m} onChange={() => onMode(m)} />
            <b>{t(`vault.access.${m}`)}</b>
            <small>{t(`vault.access.${m}Hint`)}</small>
          </label>
        ))}
      </div>
      {mode === 'some' && (
        <Picker
          multiple
          className="vault-machines-picker"
          aria-label={t('vault.machines')}
          label={t('vault.machines')}
          noneLabel={t('vault.access.pickMachines')}
          items={machineItems(order, machines, picked)}
          value={picked}
          onChange={(v) => onPicked(() => v)}
        />
      )}
    </fieldset>
  );
}

const machinesFor = (mode: AccessMode, picked: string[]): string[] => (mode === 'all' ? ['*'] : mode === 'some' ? picked : []);

/** Creates or renames a group in a dialog. */
function GroupEditor({ group, onDone }: { group?: VaultGroup; onDone(): void }) {
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const nameOk = trimmed.length > 0 && trimmed.length <= 128;

  const save = async () => {
    if (!nameOk) return;
    setErr('');
    setBusy(true);
    try {
      if (group) await vaultApi.updateGroup(group.id, { name: trimmed, description: description.trim() });
      else await vaultApi.createGroup({ name: trimmed, description: description.trim() });
      await loadVault();
      onDone();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <form
        className="modal dialog vault-editor"
        role="dialog"
        aria-label={group ? t('vault.group.editTitle') : t('vault.group.add')}
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
          <span className="modal-title">{group ? t('vault.group.editTitle') : t('vault.group.add')}</span>
          <span className="spacer" />
          <button type="button" className="icon" title={t('dialog.cancel')} aria-label={t('dialog.cancel')} onClick={onDone}>
            <X />
          </button>
        </div>
        <div className="dialog-body vault-fields">
          <label className="vault-field">
            <span>{t('vault.group.name')}</span>
            <input className="input" value={name} autoFocus maxLength={128} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="vault-field">
            <span>{t('vault.group.description')}</span>
            <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          {err && <div className="callout error">{err}</div>}
        </div>
        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" onClick={onDone}>
            {t('dialog.cancel')}
          </button>
          <button className="primary" type="submit" disabled={busy || !nameOk}>
            {t('vault.save')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** Moves several variables to a chosen group (or ungrouped) in one call. */
function BulkGroup({ names, onDone }: { names: string[]; onDone(err?: string): void }) {
  const groups = useVault((s) => s.groups);
  const presets = useVault((s) => s.presets);
  const workspaceLinks = useVault((s) => s.workspaceLinks);
  const guard = useVault((s) => s.guard);
  const [group, setGroup] = useState('');
  const [asking, setAsking] = useState(false);
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const inLinkedPreset = (gid: string) => {
    if (!gid) return false;
    const linked = new Set(workspaceLinks.flatMap((l) => l.presets));
    return presets.some((p) => linked.has(p.id) && p.groups.includes(gid));
  };

  const save = async () => {
    if (!!guard?.verifyEachAllow && inLinkedPreset(group) && !asking) {
      setAsking(true);
      return;
    }
    setErr('');
    setBusy(true);
    try {
      await vaultApi.assignGroup(names, group, asking && pass ? { passphrase: pass } : undefined);
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
        aria-label={t('vault.bulk.groupTitle', { n: names.length })}
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
          <span className="modal-title">{t('vault.bulk.groupTitle', { n: names.length })}</span>
          <span className="spacer" />
          <button type="button" className="icon" title={t('dialog.cancel')} aria-label={t('dialog.cancel')} onClick={() => onDone()}>
            <X />
          </button>
        </div>
        <div className="dialog-body vault-fields">
          <div className="vault-chips">
            {names.map((n) => (
              <code key={n}>{n}</code>
            ))}
          </div>
          <label className="vault-field">
            <span>{t('vault.group')}</span>
            <select className="input" aria-label={t('vault.group')} value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">{t('vault.group.none')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          {asking && (
            <div className="vault-field" data-fresh="group-assign">
              <small>{t('vault.fresh.groupAssign')}</small>
              <FreshPassphrase value={pass} onChange={setPass} />
            </div>
          )}
          {err && <div className="callout error">{err}</div>}
        </div>
        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" onClick={() => onDone()}>
            {t('dialog.cancel')}
          </button>
          <button className="primary" type="submit" disabled={busy || (asking && !pass)}>
            {t('vault.save')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** Changes who may read the variables named without asking, one call
 * each (their values are sealed again with their machines). */
function BulkAccess({ names, onDone }: { names: string[]; onDone(err?: string): void }) {
  const [mode, setMode] = useState<AccessMode>('ask');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const guard = useVault((s) => s.guard);
  const variables = useVault((s) => s.variables);
  const [asking, setAsking] = useState(false);
  const [pass, setPass] = useState('');
  const save = async () => {
    const machines = machinesFor(mode, picked);
    const wide = (n: string) => {
      const cur = variables.find((x) => x.name === n);
      return !!guard?.verifyEachAllow && !!cur && widens(cur, { machines });
    };
    const w = ways(guard);
    // The passphrase is asked once for all, where no proof can be made.
    if (!asking && !w.desktop && !w.webauthn && names.some(wide)) return setAsking(true);
    setBusy(true);
    const err = await eachVariable(names, async (n) => {
      // A proof is made for one variable: each is asked.
      const r = await withFresh({
        guard,
        purpose: { for: 'change', request: n },
        needed: wide(n),
        passphrase: asking ? pass : undefined,
        send: (fresh) => vaultApi.set(n, { machines }, fresh),
      });
      if (!r.done) throw new VaultError('proof_cancelled');
    });
    setBusy(false);
    await loadVault();
    onDone(err);
  };
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <form
        className="modal dialog vault-editor"
        role="dialog"
        aria-label={t('vault.bulk.accessTitle', { n: names.length })}
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
          <span className="modal-title">{t('vault.bulk.accessTitle', { n: names.length })}</span>
          <span className="spacer" />
          <button type="button" className="icon" title={t('dialog.cancel')} aria-label={t('dialog.cancel')} onClick={() => onDone()}>
            <X />
          </button>
        </div>
        <div className="dialog-body vault-fields">
          <div className="vault-chips">
            {names.map((n) => (
              <code key={n}>{n}</code>
            ))}
          </div>
          <AccessChooser mode={mode} picked={picked} onMode={setMode} onPicked={setPicked} />
          {asking && <FreshPassphrase value={pass} onChange={setPass} />}
        </div>
        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" onClick={() => onDone()}>
            {t('dialog.cancel')}
          </button>
          <button className="primary" type="submit" disabled={busy || (mode === 'some' && !picked.length) || (asking && !pass)}>
            {t('vault.save')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** Adds or changes a variable, in a dialog: the value field only sets a new
 * value; optional group assignment; who may read it without asking; inject-only. */
function Editor({ variable, defaultGroup, onDone }: { variable?: VaultVariable; defaultGroup?: string; onDone(): void }) {
  const groups = useVault((s) => s.groups);
  const presets = useVault((s) => s.presets);
  const workspaceLinks = useVault((s) => s.workspaceLinks);
  const [name, setName] = useState(variable?.name ?? '');
  const [description, setDescription] = useState(variable?.description ?? '');
  const [group, setGroup] = useState(variable?.group ?? defaultGroup ?? '');
  const [value, setValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [injectOnly, setInjectOnly] = useState(variable?.injectOnly ?? false);
  const initial = variable?.machines ?? [];
  const [mode, setMode] = useState<AccessMode>(initial.includes('*') ? 'all' : initial.length ? 'some' : 'ask');
  const [picked, setPicked] = useState<string[]>(initial.filter((m) => m !== '*'));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useVault((s) => s.guard);
  // Where every Allow is verified and no authenticator can answer, a change
  // that lets more read the value asks for the passphrase.
  const [asking, setAsking] = useState(false);
  const [pass, setPass] = useState('');
  const target = name.trim();
  const nameOk = /^[A-Za-z_][A-Za-z0-9_]*$/.test(target) && target.length <= 128;
  const machinesOf = (): string[] => machinesFor(mode, picked);
  const linkedPresetIds = useMemo(() => new Set(workspaceLinks.flatMap((l) => l.presets)), [workspaceLinks]);
  const groupWidens =
    !!group && group !== (variable?.group ?? '') && presets.some((p) => linkedPresetIds.has(p.id) && p.groups.includes(group));
  const varWidens =
    !!target && (!variable || target !== variable.name) && presets.some((p) => linkedPresetIds.has(p.id) && p.variables.includes(target));
  const save = async () => {
    setErr('');
    // A new variable cannot be proved via POST /proof (it does not exist yet):
    // when verifyEachAllow requires confirmation for a linked group or name, ask
    // for the passphrase directly.
    const to = variable && target !== variable.name ? { to: target } : {};
    const groupField = variable ? (group !== (variable.group ?? '') ? { group } : {}) : group ? { group } : {};
    const body = {
      ...to,
      description,
      machines: machinesOf(),
      injectOnly,
      ...groupField,
      ...(value !== '' || !variable ? { value } : {}),
    };
    if (!variable && !!guard?.verifyEachAllow && (groupWidens || varWidens) && !asking) {
      setAsking(true);
      return;
    }
    setBusy(true);
    try {
      if (!variable) {
        await vaultApi.set(target, body, asking && pass ? { passphrase: pass } : undefined);
      } else {
        const r = await withFresh({
          guard,
          purpose: { for: 'change', request: variable.name },
          needed: !!guard?.verifyEachAllow && (widens(variable, body) || groupWidens || varWidens),
          passphrase: asking ? pass : undefined,
          send: (fresh) => vaultApi.set(variable.name, body, fresh),
        });
        if (!r.done) {
          // The editor stays as it is.
          if (r.reason === 'passphrase') setAsking(true);
          else setErr(t('vault.proof.cancelled'));
          return;
        }
      }
      await loadVault();
      onDone();
    } catch (e) {
      if (!variable && e instanceof VaultError && e.code === 'vault_proof' && !asking) {
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
          {groups.length > 0 && (
            <label className="vault-field">
              <span>{t('vault.group')}</span>
              <select className="input" aria-label={t('vault.group')} value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">{t('vault.group.none')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          )}
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
          <AccessChooser mode={mode} picked={picked} onMode={setMode} onPicked={setPicked} />
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
          {asking && (
            <div className="vault-field" data-fresh="change">
              <small>{t('vault.fresh.change')}</small>
              <FreshPassphrase value={pass} onChange={setPass} />
            </div>
          )}
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
            disabled={busy || !nameOk || (!variable && !value) || (mode === 'some' && !picked.length) || (asking && !pass)}
          >
            {t('vault.save')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
