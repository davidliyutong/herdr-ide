// The keyboard shortcuts page of the settings, as VS Code's: every command
// with the keys in effect on this platform, grouped by section, where they
// come from (default or the user's) and conflicts. Double-clicking a row (or
// its menu's Change) records keys that replace its own; + records one more;
// × removes a key; reset returns to the defaults. The search matches
// commands, ids and key names, or the keys pressed while "record keys" is on.
// Changes replace the user's rules (PUT /api/keybindings), which the core
// turns into the bindings of every platform.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Keyboard, Plus, RotateCcw, X } from 'lucide-react';
import { hasMessage, t } from '../i18n';
import { commandLabel } from '../keymap';
import { altOnly, keyLabel, MAX_STROKES, strokeOf, tryNormalize, KeyError, normalizeKeys } from '../keys';
import { keysOf, resetRules, rulesFor, saveUserRules, useKeys, type Conflict } from '../keybindings';
import { openMenu, type MenuEntry } from '../contextMenu';

function sectionLabel(id: string): string {
  const k = `command.section.${id}`;
  return hasMessage(k) ? t(k) : id;
}

function problemLabel(code: string): string {
  const k = `keys.problem.${code}`;
  return hasMessage(k) ? t(k) : code;
}

/** Why a recorded sequence cannot be a binding, as shown; undefined when it can. */
export function recordError(seq: string): string | undefined {
  try {
    normalizeKeys(seq);
    return undefined;
  } catch (e) {
    const code = e instanceof KeyError ? e.code : 'key';
    const k = `keys.error.${code}`;
    return hasMessage(k) ? t(k) : code;
  }
}

/** The other commands a key also runs, by the conflicts the core found. */
export function conflictsOf(conflicts: Conflict[], command: string, key: string): string[] {
  const out = new Set<string>();
  for (const c of conflicts) {
    const hit = c.key === key || (c.prefix && key.startsWith(c.key + ' ')) || (c.prefix && c.key.startsWith(key + ' '));
    if (hit && c.commands.includes(command)) for (const other of c.commands) if (other !== command) out.add(other);
  }
  return [...out];
}

/** Whether a command matches a search of words: its label, id or keys. */
export function commandMatches(label: string, id: string, keys: string[], q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const text = [label, id, ...keys.map((k) => keyLabel(k)), ...keys].join(' ').toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Which recording a row has open: replacing its keys or adding one. */
type Recording = { command: string; replace: boolean };

export function KeyboardShortcuts({ query, readOnly, embedded }: { query: string; readOnly: boolean; embedded?: boolean }) {
  const k = useKeys();
  const [error, setError] = useState<string>();
  const [recording, setRecording] = useState<Recording>();
  // Keys pressed in the record-keys search; it replaces the words.
  const [pressed, setPressed] = useState<string>();
  const [byKeys, setByKeys] = useState(false);
  const commands = useMemo(
    () =>
      k.commands.filter((c) => {
        const keys = keysOf(k.effective, c.id);
        if (byKeys) return !pressed || keys.some((key) => key === pressed || key.startsWith(pressed + ' '));
        return commandMatches(commandLabel(c.id), c.id, keys, query);
      }),
    [k.commands, k.effective, query, pressed, byKeys],
  );
  const sections = (k.sections.length ? k.sections : [...new Set(k.commands.map((c) => c.section))].map((id) => ({ id, order: 0 }))).filter(
    (s) => commands.some((c) => c.section === s.id),
  );
  if (embedded && commands.length === 0) return null;
  const save = async (rules: Parameters<typeof saveUserRules>[0]) => {
    setError(undefined);
    const err = await saveUserRules(rules);
    if (err) setError(err);
  };
  const changed = (id: string) => k.user.some((r) => r.command === id || r.command === `-${id}`);
  const menu = (id: string, keys: string[]): MenuEntry[] => [
    { label: t('keys.change'), disabled: readOnly, run: () => setRecording({ command: id, replace: true }) },
    { label: t('keys.add'), disabled: readOnly, run: () => setRecording({ command: id, replace: false }) },
    { label: t('keys.removeAll'), disabled: readOnly || keys.length === 0, run: () => void save(rulesFor(k.user, k.defaults, id, [])) },
    { label: t('keys.reset'), disabled: readOnly || !changed(id), run: () => void save(resetRules(k.user, id)) },
    'sep',
    { label: t('keys.copyId'), run: () => void navigator.clipboard?.writeText(id).catch(() => {}) },
  ];

  return (
    <section className="settings-section keys-page">
      {embedded ? <h3>{t('settings.section.keyboard')}</h3> : <h2 className="settings-page-title">{t('settings.section.keyboard')}</h2>}
      {!embedded && (
        <div className="keys-toolbar">
          <span className="muted small">{t('keys.note')}</span>
          <span className="spacer" />
          <KeySearch
            active={byKeys}
            pressed={pressed}
            onToggle={() => {
              setByKeys(!byKeys);
              setPressed(undefined);
            }}
            onPress={setPressed}
          />
        </div>
      )}
      {k.problems.length > 0 && (
        <div className="settings-problems">
          <AlertTriangle />
          <div>
            <div>{t('keys.problems')}</div>
            {k.problems.map((p, i) => (
              <div key={i} className="muted small">
                {p.index >= 0 ? t('keys.problemAt', { n: p.index + 1 }) + ' · ' : ''}
                {problemLabel(p.code)}
                {p.detail ? ` · ${p.detail}` : ''}
              </div>
            ))}
          </div>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      <div className="keys-table" role="table">
        <div className="keys-row keys-head" role="row">
          <span role="columnheader">{t('keys.command')}</span>
          <span role="columnheader">{t('keys.keybinding')}</span>
          <span role="columnheader">{t('keys.source')}</span>
        </div>
        {sections.map((s) => (
          <div key={s.id} role="rowgroup">
            <div className="keys-section" role="row">
              {sectionLabel(s.id)}
            </div>
            {commands
              .filter((c) => c.section === s.id)
              .map((c) => {
                const keys = keysOf(k.effective, c.id);
                const user = changed(c.id);
                const rec = recording?.command === c.id ? recording : undefined;
                return (
                  <div
                    key={c.id}
                    className={`keys-row ${user ? 'modified' : ''}`}
                    role="row"
                    data-command={c.id}
                    title={c.id}
                    onDoubleClick={(e) =>
                      !readOnly && !(e.target as HTMLElement).closest('button') && setRecording({ command: c.id, replace: true })
                    }
                    onContextMenu={(e) => openMenu(e, menu(c.id, keys))}
                  >
                    <span className="keys-label ellipsis" role="cell">
                      {commandLabel(c.id)}
                    </span>
                    <span className="keys-keys" role="cell">
                      {rec?.replace ? null : keys.length === 0 && !rec ? <span className="muted small">—</span> : null}
                      {!rec?.replace &&
                        keys.map((key) => {
                          const others = conflictsOf(k.conflicts, c.id, key);
                          return (
                            <span key={key} className={`key-chip ${others.length ? 'conflict' : ''}`}>
                              {others.length > 0 && (
                                <span title={t('keys.conflict', { commands: others.map(commandLabel).join(', ') })}>
                                  <AlertTriangle />
                                </span>
                              )}
                              <kbd>{keyLabel(key)}</kbd>
                              {!readOnly && (
                                <button
                                  className="icon key-remove"
                                  title={t('keys.remove')}
                                  onClick={() =>
                                    void save(
                                      rulesFor(
                                        k.user,
                                        k.defaults,
                                        c.id,
                                        keys.filter((x) => x !== key),
                                      ),
                                    )
                                  }
                                >
                                  <X />
                                </button>
                              )}
                            </span>
                          );
                        })}
                      {rec ? (
                        <Recorder
                          onDone={(seq) => {
                            setRecording(undefined);
                            if (!seq) return;
                            if (rec.replace) void save(rulesFor(k.user, k.defaults, c.id, [seq]));
                            else if (!keys.includes(seq)) void save(rulesFor(k.user, k.defaults, c.id, [...keys, seq]));
                          }}
                        />
                      ) : (
                        !readOnly && (
                          <button
                            className="icon key-add"
                            title={t('keys.add')}
                            onClick={() => setRecording({ command: c.id, replace: false })}
                          >
                            <Plus />
                          </button>
                        )
                      )}
                    </span>
                    <span className="keys-source muted small" role="cell">
                      {user ? t('keys.sourceUser') : keys.length ? t('keys.sourceDefault') : ''}
                      {!readOnly && user && (
                        <button className="icon" title={t('keys.reset')} onClick={() => void save(resetRules(k.user, c.id))}>
                          <RotateCcw />
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
          </div>
        ))}
        {commands.length === 0 && <p className="muted pad">{t('settings.noMatch')}</p>}
      </div>
      {!embedded && !readOnly && <p className="muted small">{t('keys.hint')}</p>}
    </section>
  );
}

/** Searching by keys: while on, the keys pressed in the field are the
 * search. */
function KeySearch({
  active,
  pressed,
  onToggle,
  onPress,
}: {
  active: boolean;
  pressed?: string;
  onToggle(): void;
  onPress(seq: string | undefined): void;
}) {
  const field = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (active) field.current?.focus();
  }, [active]);
  return (
    <span className="key-search">
      <button className={`icon ${active ? 'on' : ''}`} aria-pressed={active} title={t('keys.searchByKeys')} onClick={onToggle}>
        <Keyboard />
      </button>
      {active && (
        <span
          ref={field}
          className="key-recorder"
          tabIndex={0}
          role="textbox"
          aria-label={t('keys.searchByKeys')}
          onKeyDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
            if (plain && e.key === 'Escape') return onToggle();
            if (plain && e.key === 'Backspace') return onPress(undefined);
            const stroke = strokeOf(e.nativeEvent);
            if (stroke) onPress(stroke);
          }}
        >
          {pressed ? keyLabel(pressed) : t('keys.pressToSearch')}
        </span>
      )}
    </span>
  );
}

/** Records a key sequence: strokes as they are pressed, Enter to keep it,
 * Escape (or leaving the field) to cancel. Every key is cancelled, so in the
 * desktop app its menu (Cmd+Q included) does not act on it. */
function Recorder({ onDone }: { onDone(seq?: string): void }) {
  const [strokes, setStrokes] = useState<string[]>([]);
  const field = useRef<HTMLSpanElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const seq = strokes.join(' ');
  const error = strokes.length ? recordError(seq) : undefined;
  const add = (stroke: string) => setStrokes((s) => (s.length >= MAX_STROKES ? [stroke] : [...s, stroke]));

  useEffect(() => {
    field.current?.focus();
  }, []);

  return (
    <span
      ref={field}
      className={`key-recorder ${error ? 'invalid' : ''}`}
      tabIndex={0}
      role="textbox"
      aria-label={t('keys.record')}
      onBlur={() => done.current()}
      onKeyDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
        if (plain && e.key === 'Escape') return done.current();
        if (plain && e.key === 'Enter' && strokes.length) {
          if (!error) done.current(tryNormalize(seq));
          return;
        }
        if (plain && e.key === 'Backspace' && strokes.length) return setStrokes((s) => s.slice(0, -1));
        const stroke = strokeOf(e);
        if (stroke) add(stroke);
      }}
    >
      {strokes.length ? keyLabel(seq) : t('keys.press')}
      {error && <span className="error small"> · {error}</span>}
      {!error && strokes.length > 0 && altOnly(strokes[0]) && <span className="muted small"> · {t('keys.altOnly')}</span>}
    </span>
  );
}
