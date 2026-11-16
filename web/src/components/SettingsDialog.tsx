// Settings dialog, rendered from the definitions the core serves
// (/api/settings, settings.ts), laid out as VS Code's: a scope bar (the
// user's settings, then each machine's own), a list of sections (the
// advanced ones last) and the section's settings, a search across them, a
// control per type, a bar on settings changed from their default, a menu per
// setting (reset, copy its id or JSON), and settings.json opened in VS Code.
// A machine's scope lists the settings it can have its own value of, each
// following the user's value until set, and the machine's name, address and
// troubleshooting. In the desktop app on macOS the user's Terminal page ends
// with Full Disk Access (settings/FullDiskAccess.tsx). Labels are the i18n
// keys settings.<key>, settings.<key>.desc, settings.<key>.<option> and
// settings.group.<id>; a setting without them shows its key.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Copy as CopyIcon, Ellipsis, FileJson, Lock, Minus, Plus, Search, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { GuiEnableButton, GuiMachineStatus } from '../gui/GuiMenus';
import { hasMessage, t } from '../i18n';
import { openMenu, type MenuEntry } from '../contextMenu';
import { actions } from '../actions';
import { isMac, useKeys } from '../keybindings';
import { codeText, type MachineState } from '../lib/machine';
import { conn } from '../lib/conn';
import {
  resetSetting,
  setSetting,
  useSettings,
  type Section,
  type SettingDef,
  type SettingProblem,
  type SettingState,
  type SettingValue,
} from '../settings';
import { KeyboardShortcuts } from './KeyboardShortcuts';
import { FontPicker } from './settings/FontPicker';
import { desktopShell } from '../shell';
import { ZOOM_KEY } from '../zoom';
import { colorKeys, ThemeColors, schemeLabel } from './settings/Colors';
import { ThemePicker } from './settings/ThemePicker';
import { FullDiskAccess, fullDiskAccessMatches } from './settings/FullDiskAccess';
import { fullDiskAccessAvailable, localMachine } from '../fullDiskAccess';
import { PluginHeader, PluginsPage } from './settings/PluginsPage';
import { acceptRisk, pluginSwitch, sectionPlugin, usePluginList } from '../plugins/registry';
import type { PluginDef } from '../plugins/api';

export function settingLabel(key: string): string {
  const k = `settings.${key}`;
  return hasMessage(k) ? t(k) : key;
}

/** A translation that may not exist. */
function maybe(k: string): string | undefined {
  return hasMessage(k) ? t(k) : undefined;
}

function desc(key: string): string | undefined {
  return maybe(`settings.${key}.desc`);
}

function optionLabel(key: string, option: string): string {
  const k = `settings.${key}.${option}`;
  return hasMessage(k) ? t(k) : option;
}

function sectionLabel(id: string): string {
  const k = `settings.section.${id}`;
  return hasMessage(k) ? t(k) : id;
}

function groupLabel(id: string): string {
  const k = `settings.group.${id}`;
  return hasMessage(k) ? t(k) : id;
}

/** Whether a setting matches a search: its label, description, key or options. */
export function matchesSearch(d: Pick<SettingDef, 'key' | 'enum'> & { section?: string }, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const options = (d.enum ?? []).map((o) => (d.key.startsWith('terminal.colorScheme.') ? schemeLabel(o) : optionLabel(d.key, o)));
  const text = [settingLabel(d.key), desc(d.key) ?? '', d.key, d.section ? sectionLabel(d.section) : '', ...options]
    .join(' ')
    .toLowerCase();
  return words.every((w) => text.includes(w));
}

/** A problem of the settings file as shown. */
export function problemText(p: SettingProblem): string {
  const where = p.key ? (p.machine ? `${p.key} (${p.machine})` : p.key) : '';
  const code = `settings.problem.${p.code}`;
  const what = hasMessage(code) ? t(code) : p.code;
  return [where, what, p.detail].filter(Boolean).join(' · ');
}

/** Settings the generic rows leave out: the theme colors are the colors
 * page's swatches; Option as Meta exists on macOS only, the zoom in the
 * desktop app only (browsers zoom pages themselves). */
function shownInRows(d: SettingDef): boolean {
  if (d.key.startsWith('terminal.colors.')) return false;
  if (d.key === 'terminal.optionIsMeta' && !isMac) return false;
  if (d.key === ZOOM_KEY && !desktopShell) return false;
  return true;
}

/** Whether a machine can have its own value of a setting. */
export function machineScoped(d: SettingDef, m: Pick<MachineState, 'kind'>): boolean {
  return d.scope === 'machine' || (d.scope === 'remote-machine' && m.kind !== 'local');
}

/** A page of the dialog's navigation: a section, or one of its own. */
interface Page {
  id: string;
  advanced?: boolean;
  /** The plugin whose settings it has: listed under the plugins. */
  plugin?: string;
}

/** The pages of plugins' settings, in the plugins' order: their sections
 * with settings shown, and (with extra, in the user's scope) the pages a
 * plugin names for its extra alone. */
function pluginPages(shown: readonly Section[], all: readonly Section[], plugins: readonly PluginDef[], user: boolean): Page[] {
  const out: Page[] = [];
  for (const s of shown) {
    const plugin = sectionPlugin(s.id, all);
    if (plugin) out.push({ id: s.id, plugin });
  }
  if (user) {
    for (const p of plugins) {
      const id = p.settings?.section;
      if (id && p.settings?.extra && !out.some((x) => x.id === id)) out.push({ id, plugin: p.id });
    }
  }
  const rank = (p: Page) => {
    const i = plugins.findIndex((x) => x.id === p.plugin);
    return i < 0 ? plugins.length : i;
  };
  return out.sort((a, b) => rank(a) - rank(b));
}

const KEYS_PAGE = 'keys';
const MACHINE_PAGE = 'machine';
/** The plugins and their switches (the section of plugins.<id>.enabled). */
const PLUGINS_PAGE = 'plugins';

export function SettingsDialog() {
  const view = useStore((s) => s.settings);
  return view ? <SettingsModal page={view.page} machine={view.machine} /> : null;
}

function SettingsModal({ page: askedPage, machine: askedMachine }: { page?: string; machine?: string }) {
  const close = () => useStore.getState().openSettings(false);
  const st = useSettings();
  const readOnly = useStore((s) => s.readOnly) || st.readOnly;
  const machines = useStore(useShallow((s) => s.order.map((id) => s.machines[id]).filter(Boolean)));
  const [scope, setScope] = useState(askedMachine ?? '');
  const [page, setPage] = useState(askedPage ?? (askedMachine ? MACHINE_PAGE : 'appearance'));
  const [query, setQuery] = useState('');
  const keysFile = useKeys((k) => k.file);
  const plugins = usePluginList((s) => s.list);
  const search = useRef<HTMLInputElement>(null);

  // Opened again while open (a machine's menu, a key): show what was asked.
  useEffect(() => {
    setScope(askedMachine ?? '');
    setPage(askedPage ?? (askedMachine ? MACHINE_PAGE : 'appearance'));
  }, [askedPage, askedMachine]);

  useEffect(() => {
    search.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const machine = scope ? machines.find((m) => m.id === scope) : undefined;
  const defs = useMemo(
    () =>
      st.defs.filter((d) => shownInRows(d) || d.key.startsWith('terminal.colors.')).filter((d) => !machine || machineScoped(d, machine)),
    [st.defs, machine],
  );
  const sections = st.sections.filter((s) => defs.some((d) => d.section === s.id && shownInRows(d)));
  const pages: Page[] = [
    ...(machine ? [{ id: MACHINE_PAGE }] : []),
    ...sections.filter((s) => !s.advanced && s.id !== PLUGINS_PAGE && !sectionPlugin(s.id, st.sections)),
    ...(machine ? [] : [{ id: PLUGINS_PAGE }]),
    ...pluginPages(sections, st.sections, plugins, !machine),
    ...(machine ? [] : [{ id: KEYS_PAGE }]),
    ...sections.filter((s) => s.advanced && !sectionPlugin(s.id, st.sections)),
  ];
  const current = pages.some((p) => p.id === page) ? page : pages[0]?.id;
  const currentPlugin = plugins.find((p) => p.id === pages.find((x) => x.id === current)?.plugin);
  const CurrentExtra = currentPlugin?.settings?.section === current ? currentPlugin.settings.extra : undefined;
  /** A page's name: its section's, else its plugin's (a page for extra alone). */
  const pageLabel = (id: string) => {
    if (hasMessage(`settings.section.${id}`)) return sectionLabel(id);
    const p = plugins.find((x) => x.id === sectionPlugin(id, st.sections));
    return p ? t(p.title) : id;
  };
  const searching = query.trim() !== '';
  const matching = defs.filter((d) => shownInRows(d) && matchesSearch(d, query));
  // The Terminal page's Full Disk Access row (desktop app on macOS), found
  // by a search of the user's settings too.
  const fdaFound = searching && !machine && fullDiskAccessAvailable() && !!localMachine() && fullDiskAccessMatches(query);
  const fileProblems = st.problems.filter((p) => !p.key || !st.defs.some((d) => d.key === p.key));
  const modifiedIn = (section: string) =>
    defs.some(
      (d) =>
        d.section === section && (machine ? st.values[d.key]?.machines?.[machine.id] !== undefined : st.values[d.key]?.source === 'global'),
    );
  const go = (id: string) => {
    setQuery('');
    setPage(id);
  };
  const scopes = [
    { id: '', label: t('settings.scope.user') },
    ...machines.filter((m) => st.defs.some((d) => machineScoped(d, m))).map((m) => ({ id: m.id, label: m.label })),
  ];

  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal settings" role="dialog" aria-label={t('settings.title')}>
        <div className="modal-head">
          <span className="modal-title">{t('settings.title')}</span>
          <label className="settings-search">
            <Search />
            <input
              ref={search}
              value={query}
              placeholder={current === KEYS_PAGE ? t('keys.search') : t('settings.search')}
              aria-label={t('settings.search')}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.stopPropagation();
                  e.nativeEvent.stopImmediatePropagation();
                  setQuery('');
                }
              }}
            />
            {query && (
              <button className="icon" title={t('settings.clearSearch')} onClick={() => setQuery('')}>
                <X />
              </button>
            )}
          </label>
          <OpenFileButton file={current === KEYS_PAGE ? keysFile : st.file} which={current === KEYS_PAGE ? 'keys' : 'settings'} />
          <button className="icon" title={t('settings.close')} onClick={close}>
            <X />
          </button>
        </div>
        <div className="settings-scopes" role="tablist" aria-label={t('settings.scope')}>
          {scopes.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={scope === s.id}
              className={scope === s.id ? 'on' : ''}
              title={s.id ? t('settings.scope.machineHint', { machine: s.label }) : t('settings.scope.userHint')}
              onClick={() => {
                setScope(s.id);
                if (
                  s.id &&
                  page !== MACHINE_PAGE &&
                  !st.defs.some(
                    (d) =>
                      d.section === page &&
                      machineScoped(
                        d,
                        machines.find((m) => m.id === s.id)!,
                      ),
                  )
                )
                  setPage(MACHINE_PAGE);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="settings-main">
          <nav className="settings-nav" aria-label={t('settings.sections')}>
            {pages.map((s, i) => {
              const def = s.plugin === undefined ? undefined : plugins.find((x) => x.id === s.plugin);
              const off = !!def && !pluginSwitch(def, st.values, st.client);
              return (
                <div key={s.id}>
                  {s.advanced && !pages[i - 1]?.advanced && <div className="settings-nav-heading">{t('settings.section.advanced')}</div>}
                  {s.plugin !== undefined && machine && pages[i - 1]?.plugin === undefined && (
                    <div className="settings-nav-heading">{t('settings.section.plugins')}</div>
                  )}
                  <button
                    className={[!searching && current === s.id && 'on', s.plugin !== undefined && !machine && 'sub', off && 'off']
                      .filter(Boolean)
                      .join(' ')}
                    title={off ? t('plugins.page.off', { plugin: pageLabel(s.id) }) : undefined}
                    onClick={() => go(s.id)}
                  >
                    <span className="ellipsis">
                      {s.id === KEYS_PAGE
                        ? t('settings.section.keyboard')
                        : s.id === MACHINE_PAGE
                          ? t('settings.machine.overview')
                          : pageLabel(s.id)}
                    </span>
                    {s.id !== KEYS_PAGE && s.id !== MACHINE_PAGE && modifiedIn(s.id) && (
                      <span className="nav-dot" title={t('settings.modifiedHere')} />
                    )}
                  </button>
                </div>
              );
            })}
          </nav>
          <div className="settings-body">
            {readOnly && <p className="settings-note">{t('settings.serverReadOnly')}</p>}
            {!st.loaded && <p className="error small">{t('settings.error.network')}</p>}
            {fileProblems.length > 0 && current !== KEYS_PAGE && (
              <div className="settings-problems">
                <AlertTriangle />
                <div>
                  <div>{t('settings.problems')}</div>
                  {fileProblems.map((p, i) => (
                    <div key={i} className="muted small">
                      {problemText(p)}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {current === KEYS_PAGE && !machine ? (
              <KeyboardShortcuts query={query} readOnly={readOnly} />
            ) : searching ? (
              <>
                {sections
                  .filter((s) => matching.some((d) => d.section === s.id) || (s.id === 'terminal' && fdaFound))
                  .map((s) => (
                    <SectionView
                      key={s.id}
                      id={s.id}
                      defs={matching.filter((d) => d.section === s.id)}
                      heading
                      machine={machine}
                      readOnly={readOnly}
                      fullDiskAccess={s.id === 'terminal' && fdaFound}
                    />
                  ))}
                {!machine && <KeyboardShortcuts query={query} readOnly={readOnly} embedded />}
                {matching.length === 0 && !fdaFound && <p className="muted pad">{t('settings.noMatch')}</p>}
              </>
            ) : current === MACHINE_PAGE && machine ? (
              <MachinePage m={machine} readOnly={readOnly} />
            ) : current === PLUGINS_PAGE && !machine ? (
              <PluginsPage readOnly={readOnly} onOpen={go} />
            ) : (
              <SectionView
                id={current}
                title={pageLabel(current)}
                defs={defs.filter((d) => d.section === current)}
                machine={machine}
                readOnly={readOnly}
                fullDiskAccess={current === 'terminal' && !machine}
                header={currentPlugin && <PluginHeader p={currentPlugin} readOnly={readOnly} withSwitch={!machine} />}
                footer={CurrentExtra && !machine && <CurrentExtra readOnly={readOnly} />}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Opens settings.json (or keybindings.json) in a VS Code pane of the
 * core's own machine, where the file is; without one (a core on Windows,
 * read-only mode) it copies the file's path. */
function OpenFileButton({ file, which }: { file: string; which: 'settings' | 'keys' }) {
  const local = useStore((s) => s.order.map((id) => s.machines[id]).find((m) => m?.kind === 'local' && m.status === 'ready' && !m.code));
  const readOnly = useStore((s) => s.readOnly);
  if (!file) return null;
  const name = file.split(/[\\/]/).pop() ?? file;
  const canOpen = !!local && !readOnly;
  return (
    <button
      className="icon"
      title={t(canOpen ? 'settings.openFile' : 'settings.copyFilePath', { file: name, path: file })}
      aria-label={t(canOpen ? 'settings.openFile' : 'settings.copyFilePath', { file: name, path: file })}
      data-file={which}
      onClick={() => {
        if (canOpen) {
          useStore.getState().openSettings(false);
          void actions.openPath(local.id, file, 1);
        } else {
          void navigator.clipboard?.writeText(file).catch(() => {});
          useStore.getState().toast(t('transfers.copied', { path: file }));
        }
      }}
    >
      <FileJson />
    </button>
  );
}

function SectionView({
  id,
  title,
  defs,
  heading,
  machine,
  readOnly,
  fullDiskAccess,
  header,
  footer,
}: {
  id: string;
  /** The page's title, when not the section's (a plugin's page). */
  title?: string;
  /** Before the settings (a plugin and its switch) and after them (a plugin's extra). */
  header?: ReactNode;
  footer?: ReactNode;
  defs: SettingDef[];
  heading?: boolean;
  machine?: MachineState;
  readOnly: boolean;
  /** With the Full Disk Access row, which shows itself only where it applies. */
  fullDiskAccess?: boolean;
}) {
  const values = useSettings((s) => s.values);
  const problems = useSettings((s) => s.problems);
  const [error, setError] = useState<string>();
  const rows = defs.filter(shownInRows);
  const schemes = rows.filter((d) => d.key.startsWith('terminal.colorScheme.'));
  return (
    <section className="settings-section">
      {heading && <h3>{sectionLabel(id)}</h3>}
      {!heading && <h2 className="settings-page-title">{title ?? sectionLabel(id)}</h2>}
      {machine && !heading && <p className="settings-note">{t('settings.scope.machineNote', { machine: machine.label })}</p>}
      {header}
      {error && <p className="error small">{error}</p>}
      {/* The colors page: a scheme and own colors per theme. */}
      {!machine &&
        schemes.map((d) => (
          <ThemeColors key={d.key} theme={d.key.endsWith('.dark') ? 'dark' : 'light'} scheme={d} readOnly={readOnly} onError={setError} />
        ))}
      {rows
        .filter((d) => !schemes.includes(d))
        .map((d, i, list) => (
          <div key={d.key}>
            {d.group && d.group !== list[i - 1]?.group && <h4 className="settings-group">{groupLabel(d.group)}</h4>}
            <SettingRow
              d={d}
              state={values[d.key]}
              problems={problems.filter((p) => p.key === d.key && (machine ? p.machine === machine.id : !p.machine))}
              machine={machine}
              readOnly={readOnly}
            />
          </div>
        ))}
      {fullDiskAccess && <FullDiskAccess readOnly={readOnly} />}
      {footer}
      {id === 'gui' && machine && machine.kind !== 'local' && (
        <div className="setting">
          <div className="setting-head">
            <span className="setting-title">{t('gui.display')}</span>
          </div>
          <div className="setting-control row-gap">
            <GuiMachineStatus m={machine.id} />
            <GuiEnableButton m={machine.id} disabled={readOnly} />
          </div>
        </div>
      )}
    </section>
  );
}

/** One setting in a scope: in the user's, its global value (the default
 * until set); in a machine's, the machine's own value, or the user's value
 * it follows until set. */
function SettingRow({
  d,
  state,
  problems,
  machine,
  readOnly,
}: {
  d: SettingDef;
  state?: SettingState;
  problems: SettingProblem[];
  machine?: MachineState;
  readOnly: boolean;
}) {
  const [error, setError] = useState<string>();
  const own = machine ? state?.machines?.[machine.id] : undefined;
  const global = state?.value ?? d.default;
  const value = machine ? (own ?? global) : global;
  const locked = !!state?.locked;
  const modified = machine ? own !== undefined : state?.source === 'global';
  const disabled = readOnly || locked;
  const otherMachines = useStore(
    useShallow((s) =>
      machine
        ? []
        : Object.keys(state?.machines ?? {})
            .map((id) => s.machines[id])
            .filter(Boolean),
    ),
  );
  // The language is read once, when the page starts.
  const done = (err: string | undefined) => {
    if (err) setError(err);
    else if (d.key === 'appearance.language') location.reload();
  };
  const save = async (v: SettingValue | undefined) => {
    setError(undefined);
    if (v === undefined) return done(await resetSetting(d.key, machine?.id));
    if (JSON.stringify(v) === JSON.stringify(machine ? own : value)) return;
    // VS Code's switch for browsers asks to accept its risk first.
    if (v === true && !(await acceptRisk(d.key))) return;
    done(await setSetting(d.key, v, machine?.id));
  };
  const reset = () => void save(undefined);
  const menu = (): MenuEntry[] => [
    { label: t('settings.reset'), disabled: disabled || !modified, run: reset },
    'sep',
    { label: t('settings.copyId'), run: () => void navigator.clipboard?.writeText(d.key).catch(() => {}) },
    {
      label: t('settings.copyJson'),
      run: () => void navigator.clipboard?.writeText(`"${d.key}": ${JSON.stringify(value)}`).catch(() => {}),
    },
  ];
  const description = desc(d.key);
  return (
    <div
      className={`setting ${modified ? 'modified' : ''}`}
      data-key={d.key}
      onContextMenu={(e) => !(e.target as HTMLElement).closest('input, select') && openMenu(e, menu())}
    >
      <div className="setting-head">
        <span className="setting-title">{settingLabel(d.key)}</span>
        {modified && <span className="setting-badge">{t(machine ? 'settings.ownValue' : 'settings.modified')}</span>}
        <button
          className="icon setting-more"
          title={t('settings.more')}
          aria-label={t('settings.more')}
          onClick={(e) => openMenu(e, menu())}
        >
          <Ellipsis />
        </button>
      </div>
      {description && d.type !== 'bool' && <div className="setting-desc">{description}</div>}
      <div className="setting-control">
        {machine ? (
          <MachineControl d={d} own={own} inherited={global} disabled={disabled} onChange={save} />
        ) : (
          <Control d={d} value={value} disabled={disabled} onChange={save} />
        )}
      </div>
      {locked && (
        <div className="settings-locked small">
          <Lock /> {t('settings.lockedByFlag', { flag: `--${d.flag ?? d.key}` })}
        </div>
      )}
      {otherMachines.length > 0 && (
        <div className="muted small">
          {t('settings.alsoModifiedIn')}{' '}
          {otherMachines.map((m, i) => (
            <span key={m.id}>
              {i > 0 && ', '}
              <button className="link" onClick={() => useStore.getState().openSettings({ machine: m.id, page: d.section })}>
                {m.label}
              </button>
            </span>
          ))}
        </div>
      )}
      {problems.map((p, i) => (
        <div key={i} className="error small">
          {t('settings.problemInFile', { problem: problemText({ ...p, key: undefined, machine: undefined }) })}
        </div>
      ))}
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

function Control({
  d,
  value,
  disabled,
  onChange,
}: {
  d: SettingDef;
  value: SettingValue;
  disabled: boolean;
  onChange(v: SettingValue): void;
}) {
  switch (d.type) {
    case 'bool':
      return (
        <label className="setting-check">
          <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
          <span>{desc(d.key) ?? settingLabel(d.key)}</span>
        </label>
      );
    case 'enum':
      if (d.key === 'appearance.colorTheme')
        return <ThemePicker value={String(value)} disabled={disabled} onChange={(id) => onChange(id)} />;
      return (d.enum ?? []).length > 4 ? (
        <select value={String(value)} disabled={disabled} aria-label={settingLabel(d.key)} onChange={(e) => onChange(e.target.value)}>
          {(d.enum ?? []).map((o) => (
            <option key={o} value={o}>
              {optionLabel(d.key, o)}
            </option>
          ))}
        </select>
      ) : (
        <div className="segmented" role="radiogroup" aria-label={settingLabel(d.key)}>
          {(d.enum ?? []).map((o) => (
            <button
              key={o}
              role="radio"
              aria-checked={o === value}
              className={o === value ? 'on' : ''}
              disabled={disabled}
              onClick={() => onChange(o)}
            >
              {optionLabel(d.key, o)}
            </button>
          ))}
        </div>
      );
    case 'number':
      return <NumberInput d={d} value={value as number} disabled={disabled} onChange={onChange} />;
    case 'color':
      return (
        <input
          type="color"
          className="settings-color"
          value={String(value)}
          disabled={disabled}
          aria-label={settingLabel(d.key)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'list':
      return <ListEditor d={d} value={value as string[]} disabled={disabled} onChange={onChange} />;
    default:
      return d.key === 'terminal.fontFamily' ? (
        <FontPicker value={String(value)} disabled={disabled} onChange={onChange} />
      ) : (
        <TextInput d={d} value={String(value)} disabled={disabled} onChange={onChange} />
      );
  }
}

/** A machine's own value: "Same as User (value)" or a value of its own. */
function MachineControl({
  d,
  own,
  inherited,
  disabled,
  onChange,
}: {
  d: SettingDef;
  own?: SettingValue;
  inherited: SettingValue;
  disabled: boolean;
  onChange(v: SettingValue | undefined): void;
}) {
  if (d.type === 'bool' || d.type === 'enum') {
    const options = d.type === 'bool' ? ['true', 'false'] : (d.enum ?? []);
    const parse = (raw: string): SettingValue => (d.type === 'bool' ? raw === 'true' : raw);
    return (
      <select
        value={own === undefined ? '' : String(own)}
        disabled={disabled}
        aria-label={settingLabel(d.key)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : parse(e.target.value))}
      >
        <option value="">{t('settings.inherit', { value: valueLabel(d, inherited) })}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {valueLabel(d, parse(o))}
          </option>
        ))}
      </select>
    );
  }
  // Text: empty follows the user's value.
  return (
    <TextInput
      d={d}
      value={own === undefined ? '' : String(own)}
      placeholder={t('settings.inherit', {
        value: String(inherited) || (maybe(`settings.${d.key}.placeholder`) ?? t('settings.empty')),
      })}
      disabled={disabled}
      onChange={(v) => onChange(v === '' ? undefined : v)}
    />
  );
}

/** Escape restores a field without closing the dialog. */
function stopEscape(e: React.KeyboardEvent) {
  e.stopPropagation();
  e.nativeEvent.stopImmediatePropagation();
}

/** A text field that saves on Enter or blur; Escape restores the value. */
function TextInput({
  d,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  d: SettingDef;
  value: string;
  placeholder?: string;
  disabled: boolean;
  onChange(v: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const save = () => draft.trim() !== value && onChange(draft.trim());
  const ph = `settings.${d.key}.placeholder`;
  return (
    <input
      className="settings-input"
      value={draft}
      disabled={disabled}
      spellCheck={false}
      aria-label={settingLabel(d.key)}
      placeholder={placeholder ?? (hasMessage(ph) ? t(ph) : String(d.default))}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') {
          stopEscape(e);
          setDraft(value);
        }
      }}
      onBlur={save}
    />
  );
}

/** How a number is written: grouped digits, no exponent. */
export function formatNumber(n: number | undefined): string {
  return n === undefined ? '' : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** A number with − and + buttons of the definition's step, its unit and its
 * range; typed values are saved on Enter or blur, out-of-range ones are
 * brought into the range. */
function NumberInput({ d, value, disabled, onChange }: { d: SettingDef; value: number; disabled: boolean; onChange(v: number): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const step = d.step ?? 1;
  const clamp = (n: number) => {
    const r = Math.min(d.max ?? Infinity, Math.max(d.min ?? -Infinity, n));
    return d.integer ? Math.round(r) : Math.round(r * 1000) / 1000;
  };
  const save = (n: number) => {
    const v = clamp(n);
    setDraft(String(v));
    if (v !== value) onChange(v);
  };
  const commit = () => {
    const n = Number(draft.replace(/[\s,]/g, ''));
    if (draft.trim() === '' || !Number.isFinite(n)) setDraft(String(value));
    else save(n);
  };
  const unitKey = `settings.${d.key}.unit`;
  const unit = hasMessage(unitKey) ? t(unitKey) : '';
  const range =
    d.min !== undefined && d.max !== undefined ? t('settings.range', { min: formatNumber(d.min), max: formatNumber(d.max) }) : '';
  return (
    <div className="stepper" title={range}>
      <button
        className="icon"
        disabled={disabled || value <= (d.min ?? -Infinity)}
        aria-label={t('settings.decrease')}
        onClick={() => save(value - step)}
      >
        <Minus />
      </button>
      <input
        className="settings-input stepper-value"
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        aria-label={settingLabel(d.key)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            save(value + (e.key === 'ArrowUp' ? step : -step));
          } else if (e.key === 'Escape') {
            stopEscape(e);
            setDraft(String(value));
          }
        }}
        onBlur={commit}
      />
      <button
        className="icon"
        disabled={disabled || value >= (d.max ?? Infinity)}
        aria-label={t('settings.increase')}
        onClick={() => save(value + step)}
      >
        <Plus />
      </button>
      {unit && <span className="muted small">{unit}</span>}
      {range && <span className="muted small stepper-range">{range}</span>}
    </div>
  );
}

/** A list of strings: the offered values as checkboxes, other values as
 * removable chips, and a field that adds one. */
function ListEditor({ d, value, disabled, onChange }: { d: SettingDef; value: string[]; disabled: boolean; onChange(v: string[]): void }) {
  const [draft, setDraft] = useState('');
  const options = d.options ?? [];
  const others = value.filter((v) => !options.includes(v));
  const toggle = (o: string, on: boolean) => onChange(on ? [...value, o] : value.filter((v) => v !== o));
  const add = () => {
    const v = draft.trim();
    setDraft('');
    if (v && !value.includes(v)) onChange([...value, v]);
  };
  return (
    <div className="list-editor">
      {options.length > 0 && (
        <div className="list-options">
          {options.map((o) => (
            <label key={o} className={`list-option ${value.includes(o) ? 'on' : ''}`}>
              <input type="checkbox" checked={value.includes(o)} disabled={disabled} onChange={(e) => toggle(o, e.target.checked)} />
              {o}
            </label>
          ))}
        </div>
      )}
      <div className="list-items">
        {others.map((v) => (
          <span key={v} className="list-chip">
            {v}
            {!disabled && (
              <button
                className="icon"
                title={t('settings.list.remove', { item: v })}
                onClick={() => onChange(value.filter((x) => x !== v))}
              >
                <X />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <span className="list-add">
            <input
              className="settings-input"
              value={draft}
              placeholder={maybe(`settings.${d.key}.placeholder`) ?? t('settings.list.addPlaceholder')}
              aria-label={t('settings.list.add')}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add();
                if (e.key === 'Escape' && draft) {
                  stopEscape(e);
                  setDraft('');
                }
              }}
            />
            <button disabled={!draft.trim()} onClick={add}>
              {t('settings.list.add')}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** A machine's page: its name (renamed in place), address, connection and
 * troubleshooting. */
function MachinePage({ m, readOnly }: { m: MachineState; readOnly: boolean }) {
  const busy = useStore((s) => s.hcBusy[m.id] === true);
  const sshLogin = useStore((s) => s.sshLogin);
  const usable = m.status === 'ready' && !readOnly;
  const [name, setName] = useState(m.label);
  useEffect(() => setName(m.label), [m.label]);
  const rename = () => {
    const v = name.trim();
    if (v && v !== m.label) void actions.renameMachine(m.id, v);
    else setName(m.label);
  };
  return (
    <section className="settings-section">
      <h2 className="settings-page-title">{m.label}</h2>
      <div className="setting">
        <div className="setting-head">
          <span className="setting-title">{t('settings.machine.name')}</span>
        </div>
        <div className="setting-control row-gap">
          {!readOnly ? (
            <input
              className="settings-input"
              value={name}
              aria-label={t('settings.machine.name')}
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') rename();
                if (e.key === 'Escape') {
                  stopEscape(e);
                  setName(m.label);
                }
              }}
              onBlur={rename}
            />
          ) : (
            <span>{m.label}</span>
          )}
        </div>
      </div>
      <div className="setting">
        <div className="setting-head">
          <span className="setting-title">{t(m.kind === 'local' ? 'settings.machine.host' : 'settings.machine.target')}</span>
        </div>
        <div className="setting-control row-gap">
          <code>{m.kind === 'local' ? (m.info?.hostname ?? m.label) : (m.target ?? m.label)}</code>
          {m.kind === 'ssh' && m.target && (
            <button
              className="icon"
              title={t('menu.copyTarget')}
              aria-label={t('menu.copyTarget')}
              onClick={() => void navigator.clipboard?.writeText(m.target!).catch(() => {})}
            >
              <CopyIcon />
            </button>
          )}
          {m.platform && <span className="muted small">{m.platform}</span>}
        </div>
      </div>
      <div className="setting">
        <div className="setting-head">
          <span className="setting-title">{t('settings.machine.status')}</span>
        </div>
        <div className="setting-control row-gap">
          <span className={`mstatus ms-${m.status}`} />
          <span>{t(`machine.${m.status}` as 'machine.ready')}</span>
          {!readOnly && !m.code && m.status === 'disabled' && (
            <button onClick={() => void actions.setMachineEnabled(m.id, true)}>{t('menu.enableMachine')}</button>
          )}
          {!readOnly && !m.code && m.status === 'auth_required' && m.kind === 'ssh' && sshLogin && (
            <button onClick={() => useStore.getState().openAuth(m.id)}>{t('sidebar.authenticate')}</button>
          )}
          {!readOnly && !m.code && (m.status === 'auth_required' || m.status === 'error') && (
            <button onClick={() => conn.retry(m.id)}>{t('sidebar.retry')}</button>
          )}
          {!readOnly && !m.code && m.kind === 'ssh' && m.status !== 'disabled' && (
            <button onClick={() => void actions.setMachineEnabled(m.id, false)}>{t('menu.disableMachine')}</button>
          )}
        </div>
        {m.code && <div className="setting-desc">{codeText(m.code)}</div>}
      </div>
      {!m.code && (
        <>
          <h4 className="settings-group">{t('menu.troubleshooting')}</h4>
          <div className="setting">
            <div className="setting-desc">{t('settings.machine.troubleshootingDesc')}</div>
            <div className="setting-control row-gap">
              <button disabled={!usable || busy} onClick={() => void actions.terminalCore(m.id, 'restart')}>
                {t('menu.restartCore')}
              </button>
              <button disabled={!usable || busy} onClick={() => void actions.terminalCore(m.id, 'start')}>
                {t('menu.startCore')}
              </button>
              <button className="danger-text" disabled={!usable || busy} onClick={() => void actions.terminalCore(m.id, 'stop')}>
                {t('menu.stopCore')}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** How a value is shown: On/Off, an option's label, or the value. */
export function valueLabel(d: Pick<SettingDef, 'key' | 'type'>, v: SettingValue): string {
  if (d.type === 'bool') return t(v ? 'settings.on' : 'settings.off');
  if (d.type === 'enum') return optionLabel(d.key, String(v));
  return Array.isArray(v) ? v.join(', ') : String(v);
}

export { colorKeys };
