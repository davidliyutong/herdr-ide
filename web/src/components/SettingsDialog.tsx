// Settings dialog. Rows are generated from definitions: browser settings
// from prefs.ts, core settings from /api/settings (internal/settings). Labels
// are i18n keys settings.<key>, settings.<key>.desc and settings.<key>.<option>;
// a core setting without translations shows its key. Core settings that can
// differ per machine get a table with one row per machine.

import { useEffect, useState } from 'react';
import { Lock, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { GuiEnableButton, GuiMachineStatus } from '../gui/GuiMenus';
import { prefDefs, usePrefs, type PrefDef, type PrefKey, type SectionId } from '../prefs';
import { hasMessage, locales, t, type MessageKey } from '../i18n';
import { keyHint, keyLabel } from '../keymap';
import { desktopShell, isShortcutSetting, shortcutsSaved, specOf } from '../desktop';

/** A core setting as listed by /api/settings. */
export interface ServerSetting {
  key: string;
  kind: 'enum' | 'string' | 'bool';
  default: string;
  options?: string[];
  value: string;
  source: 'default' | 'saved' | 'flag';
  /** Which machines may have their own value, and their values. */
  per_machine?: 'all' | 'remote';
  machines?: Record<string, string>;
}

/** Saves a core setting (for one machine when machine is set); resolves to
 * the new list, or an error message. */
async function saveServer(key: string, value: string, machine?: string): Promise<ServerSetting[] | string> {
  try {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value, machine }),
    });
    const j = await r.json();
    if (r.ok) return j.settings;
    const code = `settings.error.${j.error}`;
    // Only an OS error from saving is shown verbatim; other codes are translated.
    return (hasMessage(code) ? t(code) : String(j.error)) + (j.error === 'save' && j.detail ? `: ${j.detail}` : '');
  } catch {
    return t('settings.error.network');
  }
}

const sections: SectionId[] = ['appearance', 'layout', 'terminal', 'notifications', 'shortcuts', 'codeServer', 'gui', 'server'];

/** Section of a core setting, from its key. */
export function serverSection(key: string): SectionId {
  if (key.startsWith('code-server-')) return 'codeServer';
  if (isShortcutSetting(key)) return 'shortcuts';
  return key === 'gui' || key.startsWith('gui-') ? 'gui' : 'server';
}

function label(key: string): string {
  const k = `settings.${key}`;
  return hasMessage(k) ? t(k) : key;
}

function desc(key: string): string | undefined {
  const k = `settings.${key}.desc`;
  return hasMessage(k) ? t(k) : undefined;
}

function optionLabel(key: string, option: string): string {
  if (key === 'locale') return locales.find((l) => l.id === option)?.label ?? t('settings.locale.auto');
  const k = `settings.${key}.${option}`;
  return hasMessage(k) ? t(k) : option;
}

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const close = () => useStore.getState().openSettings(false);
  const [server, setServer] = useState<ServerSetting[]>();
  const [serverError, setServerError] = useState<string>();
  const readOnly = useStore((s) => s.readOnly);

  useEffect(() => {
    if (!open) return;
    setServerError(undefined);
    fetch('/api/settings')
      .then((r) => r.json())
      .then((j) => setServer(j.settings ?? []))
      .catch(() => setServerError(t('settings.error.network')));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal settings" role="dialog" aria-label={t('settings.title')}>
        <div className="modal-head">
          <span className="modal-title">{t('settings.title')}</span>
          <span className="muted small">{keyHint('open_settings')}</span>
          <span className="spacer" />
          <button className="icon" title={t('settings.close')} onClick={close}>
            <X />
          </button>
        </div>
        <div className="settings-body">
          {sections.map((sec) => {
            const prefRows = (Object.keys(prefDefs) as PrefKey[]).filter((k) => prefDefs[k].section === sec);
            // Direct shortcuts exist only in the desktop app.
            if (sec === 'shortcuts' && !desktopShell) return null;
            const serverRows = (server ?? []).filter((s) => serverSection(s.key) === sec);
            if (prefRows.length === 0 && serverRows.length === 0 && !(sec === 'codeServer' && serverError)) return null;
            return (
              <section key={sec} className="settings-section">
                <h3>{t(`settings.section.${sec}` as MessageKey)}</h3>
                {(sec === 'shortcuts' || sec === 'codeServer' || sec === 'gui' || sec === 'server') && (
                  <p className="settings-note">{t(readOnly ? 'settings.serverReadOnly' : 'settings.serverNote')}</p>
                )}
                {prefRows.map((k) => (
                  <PrefRow key={k} k={k} />
                ))}
                {serverRows.map((s) => (
                  <ServerRow key={s.key} s={s} readOnly={readOnly} onSaved={setServer} />
                ))}
                {serverRows.some((s) => s.per_machine) && (
                  <MachineSettings
                    entries={serverRows.filter((s) => s.per_machine)}
                    readOnly={readOnly}
                    onSaved={setServer}
                    gui={sec === 'gui'}
                  />
                )}
                {sec === 'codeServer' && serverError && <p className="error small">{serverError}</p>}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Row({ k, children, note }: { k: string; children: React.ReactNode; note?: React.ReactNode }) {
  const d = desc(k);
  return (
    <div className="settings-row">
      <div className="settings-label">
        <div>{label(k)}</div>
        {d && <div className="muted small">{d}</div>}
        {note}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function Segmented({
  k,
  options,
  value,
  disabled,
  onChange,
}: {
  k: string;
  options: readonly string[];
  value: string;
  disabled?: boolean;
  onChange(v: string): void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label(k)}>
      {options.map((o) => (
        <button
          key={o}
          role="radio"
          aria-checked={o === value}
          className={o === value ? 'on' : ''}
          disabled={disabled}
          onClick={() => onChange(o)}
        >
          {optionLabel(k, o)}
        </button>
      ))}
    </div>
  );
}

function Toggle({ k, value, disabled, onChange }: { k: string; value: boolean; disabled?: boolean; onChange(v: boolean): void }) {
  return (
    <button
      role="switch"
      aria-checked={value}
      aria-label={label(k)}
      className={`toggle ${value ? 'on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!value)}
    />
  );
}

function PrefRow({ k }: { k: PrefKey }) {
  const value = usePrefs((s) => s.prefs[k]);
  const setPref = usePrefs((s) => s.setPref);
  const d: PrefDef = prefDefs[k];
  const note = d.reload ? <div className="muted small">{t('settings.reloads')}</div> : undefined;
  let control: React.ReactNode;
  switch (d.kind) {
    case 'enum':
      control =
        d.options.length > 3 ? (
          <select value={String(value)} onChange={(e) => setPref(k, e.target.value as never)}>
            {d.options.map((o) => (
              <option key={o} value={o}>
                {optionLabel(k, o)}
              </option>
            ))}
          </select>
        ) : (
          <Segmented k={k} options={d.options} value={String(value)} onChange={(v) => setPref(k, v as never)} />
        );
      break;
    case 'number': {
      const n = value as number;
      control = (
        <div className="stepper">
          <button className="icon" disabled={n <= d.min} onClick={() => setPref(k, (n - 1) as never)} aria-label="-">
            <Minus />
          </button>
          <span className="stepper-value">{n}px</span>
          <button className="icon" disabled={n >= d.max} onClick={() => setPref(k, (n + 1) as never)} aria-label="+">
            <Plus />
          </button>
          <button className="icon" title={t('settings.reset')} disabled={n === d.default} onClick={() => setPref(k, d.default as never)}>
            <RotateCcw />
          </button>
        </div>
      );
      break;
    }
    case 'bool':
      control = <Toggle k={k} value={value as boolean} onChange={(v) => setPref(k, v as never)} />;
      break;
    case 'string':
      control = <PrefText k={k} value={value as string} onSave={(v) => setPref(k, v as never)} />;
      break;
  }
  return (
    <Row k={k} note={note}>
      {control}
    </Row>
  );
}

/** A text field that saves on Enter or blur; Escape restores the value. */
function PrefText({ k, value, onSave }: { k: string; value: string; onSave(v: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const save = () => {
    if (draft.trim() !== value) onSave(draft.trim());
  };
  const ph = `settings.${k}.placeholder`;
  return (
    <input
      className="settings-input"
      value={draft}
      spellCheck={false}
      placeholder={hasMessage(ph) ? t(ph) : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setDraft(value);
        }
      }}
      onBlur={save}
    />
  );
}

function ServerRow({ s, readOnly, onSaved }: { s: ServerSetting; readOnly: boolean; onSaved(list: ServerSetting[]): void }) {
  const [draft, setDraft] = useState(s.value);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(s.value), [s.value]);
  const locked = s.source === 'flag';
  const disabled = readOnly || locked || busy;

  const save = async (value: string) => {
    if (value === s.value) return;
    setBusy(true);
    setError(undefined);
    const res = await saveServer(s.key, value);
    setBusy(false);
    if (typeof res === 'string') {
      setError(res);
      setDraft(s.value);
    } else {
      onSaved(res);
      if (isShortcutSetting(s.key)) shortcutsSaved(res);
    }
  };

  let control: React.ReactNode;
  if (isShortcutSetting(s.key)) {
    control = <ShortcutInput s={s} disabled={disabled} onChange={save} />;
  } else if (s.kind === 'enum' && s.options) {
    control =
      s.options.length > 3 ? (
        <select value={s.value} disabled={disabled} onChange={(e) => save(e.target.value)}>
          {s.options.map((o) => (
            <option key={o} value={o}>
              {optionLabel(s.key, o)}
            </option>
          ))}
        </select>
      ) : (
        <Segmented k={s.key} options={s.options} value={s.value} disabled={disabled} onChange={save} />
      );
  } else if (s.kind === 'bool') {
    control = <Toggle k={s.key} value={s.value === 'true'} disabled={disabled} onChange={(v) => save(String(v))} />;
  } else {
    const ph = `settings.${s.key}.placeholder`;
    control = (
      <input
        className="settings-input"
        value={draft}
        disabled={disabled}
        spellCheck={false}
        placeholder={hasMessage(ph) ? t(ph) : s.default}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save(draft.trim());
          if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(s.value);
          }
        }}
        onBlur={() => save(draft.trim())}
      />
    );
  }
  const note = (
    <>
      {locked && (
        <div className="settings-locked small">
          <Lock /> {t('settings.lockedByFlag', { flag: `--${s.key}` })}
        </div>
      )}
      {error && <div className="error small">{error}</div>}
    </>
  );
  return (
    <Row k={s.key} note={note}>
      {control}
    </Row>
  );
}

/** Records a shortcut: focus it and press the keys. Backspace removes the
 * shortcut, Escape keeps the current one; the reset button restores the
 * default. The desktop shell lets keys through while it records. */
function ShortcutInput({ s, disabled, onChange }: { s: ServerSetting; disabled: boolean; onChange(v: string): void }) {
  const [recording, setRecording] = useState(false);
  const record = (on: boolean) => {
    setRecording(on);
    desktopShell?.recordShortcut(on);
  };
  useEffect(() => () => desktopShell?.recordShortcut(false), []);
  const shown = s.value === 'none' ? t('settings.shortcut.none') : keyLabel(s.value);
  return (
    <div className="stepper">
      <input
        className="settings-input settings-shortcut"
        readOnly
        value={recording ? t('settings.shortcut.press') : shown}
        disabled={disabled}
        aria-label={label(s.key)}
        onFocus={() => record(true)}
        onBlur={() => record(false)}
        onKeyDown={(e) => {
          const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
          if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) return;
          e.preventDefault();
          e.stopPropagation();
          if (plain && e.key === 'Escape') return e.currentTarget.blur();
          if (plain && (e.key === 'Backspace' || e.key === 'Delete')) {
            onChange('none');
            return e.currentTarget.blur();
          }
          const spec = specOf(e.nativeEvent);
          if (!spec) return;
          onChange(spec);
          e.currentTarget.blur();
        }}
      />
      <button className="icon" title={t('settings.reset')} disabled={disabled || s.source === 'default'} onClick={() => onChange('')}>
        <RotateCcw />
      </button>
    </div>
  );
}

/** One row per machine for settings that can differ per machine: each
 * machine follows the global value or has its own. The GUI section also
 * shows each machine's display and enables it in open panes. */
function MachineSettings({
  entries,
  readOnly,
  onSaved,
  gui,
}: {
  entries: ServerSetting[];
  readOnly: boolean;
  onSaved(list: ServerSetting[]): void;
  gui: boolean;
}) {
  const machines = useStore(useShallow((s) => s.order.map((id) => s.machines[id]).filter(Boolean)));
  const [error, setError] = useState<string>();
  const remoteOnly = entries.every((e) => e.per_machine === 'remote');
  const rows = machines.filter((m) => !remoteOnly || m.kind !== 'local');
  if (rows.length === 0) return null;
  const save = async (e: ServerSetting, m: string, value: string) => {
    setError(undefined);
    const res = await saveServer(e.key, value, m);
    if (typeof res === 'string') setError(res);
    else onSaved(res);
  };
  return (
    <div className="settings-machines">
      <div className="settings-machines-head">
        <span>{t('settings.perMachine')}</span>
        <span className="muted small">{t('settings.perMachine.desc')}</span>
      </div>
      <div
        className="settings-machines-grid"
        style={{ gridTemplateColumns: `minmax(8rem, 1fr) repeat(${entries.length}, auto)${gui ? ' auto' : ''}` }}
      >
        <span className="muted small">{t('settings.machine')}</span>
        {entries.map((e) => (
          <span key={e.key} className="muted small">
            {label(e.key)}
          </span>
        ))}
        {gui && <span />}
        {rows.map((m) => (
          <div key={m.id} className="settings-machines-row">
            <span className="settings-machine">
              <span className="ellipsis">{m.label}</span>
              {gui && <GuiMachineStatus m={m.id} />}
            </span>
            {entries.map((e) => (
              <select
                key={e.key}
                value={e.machines?.[m.id] ?? ''}
                disabled={readOnly || e.source === 'flag'}
                aria-label={`${m.label} · ${label(e.key)}`}
                onChange={(ev) => save(e, m.id, ev.target.value)}
              >
                <option value="">{t('settings.inherit', { value: optionLabel(e.key, e.value) })}</option>
                {(e.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {optionLabel(e.key, o)}
                  </option>
                ))}
              </select>
            ))}
            {gui && <GuiEnableButton m={m.id} disabled={readOnly} />}
          </div>
        ))}
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
