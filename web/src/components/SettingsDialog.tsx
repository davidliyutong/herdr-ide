// Settings dialog, rendered from the definitions the core serves
// (/api/settings, settings.ts): a page per section and one for the
// keyboard shortcuts, a search across them, a control per type, a marker on
// changed settings, reset, per-machine values for settings whose scope allows
// them, and the lock of a command-line flag. Labels are the i18n keys
// settings.<key>, settings.<key>.desc and settings.<key>.<option>; a setting
// without them shows its key.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Lock, RotateCcw, Search, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { GuiEnableButton, GuiMachineStatus } from '../gui/GuiMenus';
import { hasMessage, t } from '../i18n';
import { keyHint } from '../keymap';
import {
  resetSetting,
  setSetting,
  useSettings,
  type SettingDef,
  type SettingProblem,
  type SettingState,
  type SettingValue,
} from '../settings';
import { KeyboardShortcuts } from './KeyboardShortcuts';

export function settingLabel(key: string): string {
  const k = `settings.${key}`;
  return hasMessage(k) ? t(k) : key;
}

function desc(key: string): string | undefined {
  const k = `settings.${key}.desc`;
  return hasMessage(k) ? t(k) : undefined;
}

function optionLabel(key: string, option: string): string {
  const k = `settings.${key}.${option}`;
  return hasMessage(k) ? t(k) : option;
}

function sectionLabel(id: string): string {
  const k = `settings.section.${id}`;
  return hasMessage(k) ? t(k) : id;
}

/** Whether a setting matches a search: its label, description, key or options. */
export function matchesSearch(d: Pick<SettingDef, 'key' | 'enum'>, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [settingLabel(d.key), desc(d.key) ?? '', d.key, ...(d.enum ?? []).map((o) => optionLabel(d.key, o))].join(' ').toLowerCase();
  return words.every((w) => text.includes(w));
}

/** A problem of the settings file as shown. */
export function problemText(p: SettingProblem): string {
  const where = p.key ? (p.machine ? `${p.key} (${p.machine})` : p.key) : '';
  const code = `settings.problem.${p.code}`;
  const what = hasMessage(code) ? t(code) : p.code;
  return [where, what, p.detail].filter(Boolean).join(' · ');
}

const KEYS_PAGE = 'keys';

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const close = () => useStore.getState().openSettings(false);
  const st = useSettings();
  const readOnly = useStore((s) => s.readOnly) || st.readOnly;
  const [page, setPage] = useState('appearance');
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const defs = st.defs;
  const sections = useMemo(() => st.sections.filter((s) => defs.some((d) => d.section === s.id)), [st.sections, defs]);
  useEffect(() => {
    if (sections.length && page !== KEYS_PAGE && !sections.some((s) => s.id === page)) setPage(sections[0].id);
  }, [sections, page]);

  if (!open) return null;
  const searching = query.trim() !== '';
  const fileProblems = st.problems.filter((p) => !p.key || !defs.some((d) => d.key === p.key));
  const go = (id: string) => {
    setQuery('');
    setPage(id);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal settings" role="dialog" aria-label={t('settings.title')}>
        <div className="modal-head">
          <span className="modal-title">{t('settings.title')}</span>
          <span className="muted small">{keyHint('app.settings')}</span>
          <span className="spacer" />
          <label className="settings-search">
            <Search />
            <input
              value={query}
              placeholder={t('settings.search')}
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
          </label>
          <button className="icon" title={t('settings.close')} onClick={close}>
            <X />
          </button>
        </div>
        <div className="settings-main">
          <nav className="settings-nav">
            {sections.map((s) => (
              <button key={s.id} className={!searching && page === s.id ? 'on' : ''} onClick={() => go(s.id)}>
                {sectionLabel(s.id)}
              </button>
            ))}
            <button className={!searching && page === KEYS_PAGE ? 'on' : ''} onClick={() => go(KEYS_PAGE)}>
              {t('settings.section.keyboard')}
            </button>
          </nav>
          <div className="settings-body">
            {readOnly && <p className="settings-note">{t('settings.serverReadOnly')}</p>}
            {!st.loaded && <p className="error small">{t('settings.error.network')}</p>}
            {fileProblems.length > 0 && (page !== KEYS_PAGE || searching) && (
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
            {page === KEYS_PAGE && !searching ? (
              <KeyboardShortcuts query="" readOnly={readOnly} />
            ) : (
              sections
                .filter((s) => (searching ? defs.some((d) => d.section === s.id && matchesSearch(d, query)) : s.id === page))
                .map((s) => (
                  <SectionView
                    key={s.id}
                    id={s.id}
                    defs={defs.filter((d) => d.section === s.id && (!searching || matchesSearch(d, query)))}
                    values={st.values}
                    problems={st.problems}
                    readOnly={readOnly}
                    heading={searching}
                  />
                ))
            )}
            {searching && <KeyboardShortcuts query={query} readOnly={readOnly} />}
            {st.file && !searching && <p className="settings-file muted small">{t('settings.file', { file: st.file })}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionView({
  id,
  defs,
  values,
  problems,
  readOnly,
  heading,
}: {
  id: string;
  defs: SettingDef[];
  values: Record<string, SettingState>;
  problems: SettingProblem[];
  readOnly: boolean;
  heading: boolean;
}) {
  const perMachine = defs.filter((d) => d.scope !== 'app');
  return (
    <section className="settings-section">
      {heading && <h3>{sectionLabel(id)}</h3>}
      {defs.map((d) => (
        <SettingRow key={d.key} d={d} state={values[d.key]} problems={problems.filter((p) => p.key === d.key)} readOnly={readOnly} />
      ))}
      {perMachine.length > 0 && <MachineSettings defs={perMachine} values={values} readOnly={readOnly} gui={id === 'gui'} />}
    </section>
  );
}

function SettingRow({
  d,
  state,
  problems,
  readOnly,
}: {
  d: SettingDef;
  state?: SettingState;
  problems: SettingProblem[];
  readOnly: boolean;
}) {
  const [error, setError] = useState<string>();
  const value = state?.value ?? d.default;
  const locked = !!state?.locked;
  const modified = state?.source === 'global';
  const disabled = readOnly || locked;
  // The language is read once, when the page starts.
  const done = (err: string | undefined) => {
    if (err) setError(err);
    else if (d.key === 'appearance.language') location.reload();
  };
  const save = async (v: SettingValue) => {
    setError(undefined);
    if (JSON.stringify(v) !== JSON.stringify(value)) done(await setSetting(d.key, v));
  };
  const reset = async () => {
    setError(undefined);
    done(await resetSetting(d.key));
  };
  const description = desc(d.key);
  return (
    <div className={`settings-row ${d.type === 'list' ? 'wide' : ''}`} data-key={d.key}>
      <div className="settings-label">
        <div className="settings-name">
          {modified && <span className="settings-modified" title={t('settings.modified')} />}
          <span>{settingLabel(d.key)}</span>
          <span className="settings-key">{d.key}</span>
        </div>
        {description && <div className="muted small">{description}</div>}
        {locked && (
          <div className="settings-locked small">
            <Lock /> {t('settings.lockedByFlag', { flag: `--${d.flag ?? d.key}` })}
          </div>
        )}
        {problems
          .filter((p) => !p.machine)
          .map((p, i) => (
            <div key={i} className="error small">
              {t('settings.problemInFile', { problem: problemText({ ...p, key: undefined }) })}
            </div>
          ))}
        {error && <div className="error small">{error}</div>}
      </div>
      <div className="settings-control">
        <Control d={d} value={value} disabled={disabled} onChange={save} />
        <button className="icon" title={t('settings.reset')} disabled={disabled || !modified} onClick={reset}>
          <RotateCcw />
        </button>
      </div>
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
        <button
          role="switch"
          aria-checked={value === true}
          aria-label={settingLabel(d.key)}
          className={`toggle ${value === true ? 'on' : ''}`}
          disabled={disabled}
          onClick={() => onChange(!value)}
        />
      );
    case 'enum':
      return (d.enum ?? []).length > 3 ? (
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
      return <ColorInput label={settingLabel(d.key)} value={value as string} disabled={disabled} onChange={onChange} />;
    case 'list':
      return d.item === 'color' ? (
        <Palette d={d} value={value as string[]} disabled={disabled} onChange={onChange} />
      ) : (
        <TextInput
          d={d}
          value={(value as string[]).join(', ')}
          disabled={disabled}
          onChange={(v) =>
            onChange(
              v
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
        />
      );
    default:
      return <TextInput d={d} value={String(value)} disabled={disabled} onChange={onChange} />;
  }
}

/** Escape restores a field without closing the dialog. */
function stopEscape(e: React.KeyboardEvent) {
  e.stopPropagation();
  e.nativeEvent.stopImmediatePropagation();
}

/** A text field that saves on Enter or blur; Escape restores the value. */
function TextInput({ d, value, disabled, onChange }: { d: SettingDef; value: string; disabled: boolean; onChange(v: string): void }) {
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
      placeholder={hasMessage(ph) ? t(ph) : String(d.default)}
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

/** A number field with the definition's range; saves on Enter or blur. */
function NumberInput({ d, value, disabled, onChange }: { d: SettingDef; value: number; disabled: boolean; onChange(v: number): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const save = () => {
    const n = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(n)) setDraft(String(value));
    else if (n !== value) onChange(n);
  };
  return (
    <input
      className="settings-input settings-number"
      type="number"
      value={draft}
      min={d.min}
      max={d.max}
      step={d.integer ? 1 : 'any'}
      disabled={disabled}
      aria-label={settingLabel(d.key)}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') {
          stopEscape(e);
          setDraft(String(value));
        }
      }}
      onBlur={save}
    />
  );
}

/** A color well and its hex value; the pick is saved once it rests. */
function ColorInput({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange(v: string): void }) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const pick = (v: string) => {
    setDraft(v);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => v !== value && onChange(v), 300);
  };
  return (
    <span className="settings-color" title={draft}>
      <input type="color" value={draft} disabled={disabled} aria-label={label} onChange={(e) => pick(e.target.value)} />
    </span>
  );
}

/** The 16 ANSI colors: black to white, then their bright variants. */
function Palette({ d, value, disabled, onChange }: { d: SettingDef; value: string[]; disabled: boolean; onChange(v: string[]): void }) {
  return (
    <div className="settings-palette">
      {value.map((c, i) => (
        <ColorInput
          key={i}
          label={`${settingLabel(d.key)} ${i}`}
          value={c}
          disabled={disabled}
          onChange={(v) => onChange(value.map((x, j) => (j === i ? v : x)))}
        />
      ))}
    </div>
  );
}

/** One row per machine for the settings that can differ per machine: each
 * machine follows the global value or has its own. The program windows
 * section also shows each machine's display and enables it in open panes. */
function MachineSettings({
  defs,
  values,
  readOnly,
  gui,
}: {
  defs: SettingDef[];
  values: Record<string, SettingState>;
  readOnly: boolean;
  gui: boolean;
}) {
  const machines = useStore(useShallow((s) => s.order.map((id) => s.machines[id]).filter(Boolean)));
  const [error, setError] = useState<string>();
  const remoteOnly = defs.every((d) => d.scope === 'remote-machine');
  const rows = machines.filter((m) => !remoteOnly || m.kind !== 'local');
  if (rows.length === 0) return null;
  const save = async (d: SettingDef, m: string, raw: string) => {
    setError(undefined);
    const err = raw === '' ? await resetSetting(d.key, m) : await setSetting(d.key, parseOption(d, raw), m);
    if (err) setError(err);
  };
  return (
    <div className="settings-machines">
      <div className="settings-machines-head">
        <span>{t('settings.perMachine')}</span>
        <span className="muted small">{t('settings.perMachine.desc')}</span>
      </div>
      <div
        className="settings-machines-grid"
        style={{ gridTemplateColumns: `minmax(8rem, 1fr) repeat(${defs.length}, auto)${gui ? ' auto' : ''}` }}
      >
        <span className="muted small">{t('settings.machine')}</span>
        {defs.map((d) => (
          <span key={d.key} className="muted small">
            {settingLabel(d.key)}
          </span>
        ))}
        {gui && <span />}
        {rows.map((m) => (
          <div key={m.id} className="settings-machines-row">
            <span className="settings-machine">
              <span className="ellipsis">{m.label}</span>
              {gui && <GuiMachineStatus m={m.id} />}
            </span>
            {defs.map((d) => {
              const st = values[d.key];
              const own = st?.machines?.[m.id];
              const disabled = readOnly || !!st?.locked || (d.scope === 'remote-machine' && m.kind === 'local');
              return (
                <select
                  key={d.key}
                  value={own === undefined ? '' : String(own)}
                  disabled={disabled}
                  aria-label={`${m.label} · ${settingLabel(d.key)}`}
                  onChange={(ev) => save(d, m.id, ev.target.value)}
                >
                  <option value="">{t('settings.inherit', { value: valueLabel(d, st?.value ?? d.default) })}</option>
                  {machineOptions(d).map((o) => (
                    <option key={o} value={o}>
                      {valueLabel(d, parseOption(d, o))}
                    </option>
                  ))}
                </select>
              );
            })}
            {gui && <GuiEnableButton m={m.id} disabled={readOnly} />}
          </div>
        ))}
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** The values a per-machine select offers. */
function machineOptions(d: SettingDef): string[] {
  return d.type === 'bool' ? ['true', 'false'] : (d.enum ?? []);
}

function parseOption(d: SettingDef, raw: string): SettingValue {
  return d.type === 'bool' ? raw === 'true' : raw;
}

/** How a value is shown: On/Off, an option's label, or the value. */
export function valueLabel(d: Pick<SettingDef, 'key' | 'type'>, v: SettingValue): string {
  if (d.type === 'bool') return t(v ? 'settings.on' : 'settings.off');
  if (d.type === 'enum') return optionLabel(d.key, String(v));
  return Array.isArray(v) ? v.join(', ') : String(v);
}
