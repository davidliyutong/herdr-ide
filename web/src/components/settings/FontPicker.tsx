// The terminal font setting (terminal.fontFamily): a list of the monospace
// fonts installed on this computer, each shown in itself, the bundled font
// first; any other family can be typed. A preview line shows the choice at
// the terminal font size.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { t } from '../../i18n';
import { usePrefs } from '../../prefs';
import { termFontFamily } from '../../terminal/fonts';
import { monospaceFonts, type FontList } from '../../terminal/localFonts';

const BUNDLED = 'JetBrains Mono';

/** How a family is drawn in the list and the preview: itself, then the
 * terminal's fallbacks. */
const stack = (family: string) => termFontFamily(400, family);

export function FontPicker({ value, disabled, onChange }: { value: string; disabled: boolean; onChange(v: string): void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // Closed, the list gives the keyboard back to its button.
  const close = () => {
    setOpen(false);
    button.current?.focus({ preventScroll: true });
  };
  const size = usePrefs((s) => s.prefs.termFontSize);
  const label = value || t('settings.font.bundled', { font: BUNDLED });
  return (
    <div className="font-picker">
      <button
        ref={button}
        type="button"
        className="font-picker-button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('settings.terminal.fontFamily')}
        onClick={() => setOpen(!open)}
        style={{ fontFamily: stack(value) }}
      >
        <span className="ellipsis">{label}</span>
        <ChevronDown />
      </button>
      {open && (
        <FontList
          value={value}
          onPick={(v) => {
            close();
            if (v !== value) onChange(v);
          }}
          onClose={() => setOpen(false)}
          onEscape={close}
        />
      )}
      <div className="font-preview" style={{ fontFamily: stack(value), fontSize: `${size}px` }} aria-hidden>
        {t('settings.font.preview')}
      </div>
    </div>
  );
}

function FontList({ value, onPick, onClose, onEscape }: { value: string; onPick(v: string): void; onClose(): void; onEscape(): void }) {
  const [list, setList] = useState<FontList>();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void monospaceFonts().then((l) => live && setList(l));
    input.current?.focus();
    const outside = (e: PointerEvent) => !box.current?.parentElement?.contains(e.target as Node) && onClose();
    window.addEventListener('pointerdown', outside, true);
    return () => {
      live = false;
      window.removeEventListener('pointerdown', outside, true);
    };
  }, []);

  // Rows: the bundled font, the installed ones matching the query, and the
  // typed family when it is none of them.
  const rows = useMemo(() => {
    const words = q.trim().toLowerCase();
    const fonts = (list?.families ?? []).filter((f) => f !== BUNDLED && (!words || f.toLowerCase().includes(words)));
    const out: { value: string; label: string; custom?: boolean }[] = [];
    if (!words || BUNDLED.toLowerCase().includes(words)) out.push({ value: '', label: t('settings.font.bundled', { font: BUNDLED }) });
    for (const f of fonts) out.push({ value: f, label: f });
    const typed = q.trim();
    if (typed && !out.some((r) => r.value.toLowerCase() === typed.toLowerCase()))
      out.push({ value: typed, label: t('settings.font.use', { font: typed }), custom: true });
    // The current family stays reachable when it is not listed.
    if (!words && value && !out.some((r) => r.value === value)) out.splice(1, 0, { value, label: value });
    return out;
  }, [list, q, value]);

  useLayoutEffect(() => {
    box.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  return (
    <div className="font-list" ref={box} role="listbox">
      <input
        ref={input}
        className="settings-input"
        value={q}
        placeholder={t('settings.font.search')}
        spellCheck={false}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setSel((v) => Math.min(v + 1, rows.length - 1));
          else if (e.key === 'ArrowUp') setSel((v) => Math.max(v - 1, 0));
          else if (e.key === 'Enter' && rows[sel]) onPick(rows[sel].value);
          else if (e.key === 'Escape') {
            e.nativeEvent.stopImmediatePropagation();
            onEscape();
          } else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      <div className="font-rows">
        {rows.map((r, i) => (
          <div
            key={`${r.custom ? '+' : ''}${r.value}`}
            role="option"
            aria-selected={r.value === value}
            className={`font-row ${i === sel ? 'sel' : ''}`}
            onMouseEnter={() => setSel(i)}
            onClick={() => onPick(r.value)}
            style={r.custom ? undefined : { fontFamily: stack(r.value) }}
          >
            <span className="font-check">{r.value === value && !r.custom && <Check />}</span>
            <span className="ellipsis">{r.label}</span>
          </div>
        ))}
        {!list && <div className="muted small pad">{t('settings.font.loading')}</div>}
      </div>
      {list && !list.complete && <div className="muted small font-note">{t('settings.font.partial')}</div>}
    </div>
  );
}
