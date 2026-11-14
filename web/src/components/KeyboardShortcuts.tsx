// The keyboard shortcuts page of the settings: every command with the keys
// in effect on this platform, grouped by section. A key is added by
// recording it (press the keys, then Enter; up to MAX_STROKES strokes for a
// chord), removed with its ×, and a command's keys go back to the defaults
// with reset. Changes replace the user's rules (PUT /api/keybindings), which
// the core turns into the bindings of every platform.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Plus, RotateCcw, X } from 'lucide-react';
import { hasMessage, t } from '../i18n';
import { commandLabel } from '../keymap';
import { altOnly, keyLabel, MAX_STROKES, strokeOf, tryNormalize, KeyError, normalizeKeys } from '../keys';
import { keysOf, resetRules, rulesFor, saveUserRules, useKeys, type Conflict } from '../keybindings';

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

export function KeyboardShortcuts({ query, readOnly }: { query: string; readOnly: boolean }) {
  const k = useKeys();
  const [error, setError] = useState<string>();
  const [recording, setRecording] = useState<string>();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const commands = useMemo(
    () =>
      k.commands.filter((c) => {
        if (!words.length) return true;
        const text = [commandLabel(c.id), c.id, ...keysOf(k.effective, c.id).map(keyLabel)].join(' ').toLowerCase();
        return words.every((w) => text.includes(w));
      }),
    [k.commands, k.effective, query],
  );
  const sections = (k.sections.length ? k.sections : [...new Set(k.commands.map((c) => c.section))].map((id) => ({ id, order: 0 }))).filter(
    (s) => commands.some((c) => c.section === s.id),
  );
  if (query && commands.length === 0) return null;
  const save = async (rules: Parameters<typeof saveUserRules>[0]) => {
    setError(undefined);
    const err = await saveUserRules(rules);
    if (err) setError(err);
  };
  const changed = (id: string) => k.user.some((r) => r.command === id || r.command === `-${id}`);

  return (
    <section className="settings-section keys-page">
      {query && <h3>{t('settings.section.keyboard')}</h3>}
      {!query && <p className="settings-note">{t('keys.note')}</p>}
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
      {sections.map((s) => (
        <div key={s.id} className="keys-section">
          <h4>{sectionLabel(s.id)}</h4>
          {commands
            .filter((c) => c.section === s.id)
            .map((c) => {
              const keys = keysOf(k.effective, c.id);
              return (
                <div key={c.id} className="keys-row" data-command={c.id}>
                  <div className="keys-label">
                    {changed(c.id) && <span className="settings-modified" title={t('settings.modified')} />}
                    <span>{commandLabel(c.id)}</span>
                    <span className="settings-key">{c.id}</span>
                  </div>
                  <div className="keys-keys">
                    {keys.map((key) => {
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
                              className="icon"
                              title={t('keys.remove')}
                              onClick={() =>
                                save(
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
                    {recording === c.id ? (
                      <Recorder
                        onDone={(seq) => {
                          setRecording(undefined);
                          if (seq && !keys.includes(seq)) void save(rulesFor(k.user, k.defaults, c.id, [...keys, seq]));
                        }}
                      />
                    ) : (
                      !readOnly && (
                        <button className="icon" title={t('keys.add')} onClick={() => setRecording(c.id)}>
                          <Plus />
                        </button>
                      )
                    )}
                    {!readOnly && changed(c.id) && (
                      <button className="icon" title={t('keys.reset')} onClick={() => save(resetRules(k.user, c.id))}>
                        <RotateCcw />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
        </div>
      ))}
      {!query && k.file && <p className="settings-file muted small">{t('settings.file', { file: k.file })}</p>}
    </section>
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
