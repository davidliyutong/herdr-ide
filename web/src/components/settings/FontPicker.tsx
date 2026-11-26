// Font pickers for terminal and UI fonts (English/Latin and Chinese/CJK kept
// separate): lists installed matching fonts drawn in themselves, with the
// default first and any custom family typeable. A preview line shows the
// combined English + CJK stack at the current font size.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { t, type MessageKey } from '../../i18n';
import { usePrefs } from '../../prefs';
import { quoteFontFamily, termFontFamily, uiCssFontFamily } from '../../terminal/fonts';
import { cjkFonts, monospaceFonts, uiFonts, type FontList } from '../../terminal/localFonts';

const BUNDLED = 'JetBrains Mono';

export type FontPickerKind = 'terminal' | 'terminal-cjk' | 'ui' | 'ui-cjk';

const LOADERS: Record<FontPickerKind, () => Promise<FontList>> = {
  terminal: monospaceFonts,
  'terminal-cjk': cjkFonts,
  ui: uiFonts,
  'ui-cjk': cjkFonts,
};

const LABELS: Record<FontPickerKind, MessageKey> = {
  terminal: 'settings.terminal.fontFamily',
  'terminal-cjk': 'settings.terminal.cjkFontFamily',
  ui: 'settings.appearance.uiFontFamily',
  'ui-cjk': 'settings.appearance.uiCjkFontFamily',
};

const PARTIAL_NOTES: Record<FontPickerKind, MessageKey> = {
  terminal: 'settings.font.partial',
  'terminal-cjk': 'settings.font.partialCjk',
  ui: 'settings.font.partialUi',
  'ui-cjk': 'settings.font.partialCjk',
};

export function FontPicker({
  value,
  disabled,
  kind = 'terminal',
  onChange,
}: {
  value: string;
  disabled: boolean;
  kind?: FontPickerKind;
  onChange(v: string): void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // Closed, the list gives the keyboard back to its button.
  const close = () => {
    setOpen(false);
    button.current?.focus({ preventScroll: true });
  };
  const prefs = usePrefs((s) => s.prefs);
  const isTerm = kind === 'terminal' || kind === 'terminal-cjk';
  const size = isTerm ? prefs.termFontSize : prefs.uiFontSize;
  const defaultLabel = kind === 'terminal' ? t('settings.font.bundled', { font: BUNDLED }) : t('settings.font.systemDefault');
  const label = value || defaultLabel;

  /** Font stack for the combined preview (English/Latin + CJK together). */
  const previewStack = (v: string): string | undefined => {
    switch (kind) {
      case 'terminal':
        return termFontFamily(400, v, prefs.termCjkFontFamily);
      case 'terminal-cjk':
        return termFontFamily(400, prefs.termFontFamily, v);
      case 'ui':
        return uiCssFontFamily(v, prefs.uiCjkFontFamily) || undefined;
      case 'ui-cjk':
        return uiCssFontFamily(prefs.uiFontFamily, v) || undefined;
    }
  };

  /** Font stack for rendering an individual option row in its own typeface. */
  const rowStack = (v: string): string | undefined => {
    if (!v) return previewStack('');
    if (kind === 'terminal') return termFontFamily(400, v);
    if (kind === 'terminal-cjk') return `${quoteFontFamily(v)}, ${termFontFamily(400, prefs.termFontFamily)}`;
    if (kind === 'ui') return uiCssFontFamily(v) || undefined;
    return `${quoteFontFamily(v)}, ${uiCssFontFamily(prefs.uiFontFamily) || 'sans-serif'}`;
  };

  const buttonFont = rowStack(value);
  const previewFont = previewStack(value);

  return (
    <div className="font-picker">
      <button
        ref={button}
        type="button"
        className="font-picker-button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t(LABELS[kind])}
        onClick={() => setOpen(!open)}
        style={buttonFont ? { fontFamily: buttonFont } : undefined}
      >
        <span className="ellipsis">{label}</span>
        <ChevronDown />
      </button>
      {open && (
        <FontList
          kind={kind}
          value={value}
          defaultLabel={defaultLabel}
          rowStack={rowStack}
          onPick={(v) => {
            close();
            if (v !== value) onChange(v);
          }}
          onClose={() => setOpen(false)}
          onEscape={close}
        />
      )}
      <div className="font-preview" style={{ ...(previewFont ? { fontFamily: previewFont } : {}), fontSize: `${size}px` }} aria-hidden>
        {t(isTerm ? 'settings.font.preview' : 'settings.font.uiPreview')}
      </div>
    </div>
  );
}

function FontList({
  kind,
  value,
  defaultLabel,
  rowStack,
  onPick,
  onClose,
  onEscape,
}: {
  kind: FontPickerKind;
  value: string;
  defaultLabel: string;
  rowStack(v: string): string | undefined;
  onPick(v: string): void;
  onClose(): void;
  onEscape(): void;
}) {
  const [list, setList] = useState<FontList>();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void LOADERS[kind]().then((l) => live && setList(l));
    input.current?.focus();
    const outside = (e: PointerEvent) => !box.current?.parentElement?.contains(e.target as Node) && onClose();
    window.addEventListener('pointerdown', outside, true);
    return () => {
      live = false;
      window.removeEventListener('pointerdown', outside, true);
    };
  }, [kind]);

  // Rows: the default option, the installed ones matching the query, and the
  // typed family when it is none of them.
  const rows = useMemo(() => {
    const words = q.trim().toLowerCase();
    const skipDefault = kind === 'terminal' ? BUNDLED : '';
    const fonts = (list?.families ?? []).filter((f) => f !== skipDefault && (!words || f.toLowerCase().includes(words)));
    const out: { value: string; label: string; custom?: boolean }[] = [];
    const defaultMatch = kind === 'terminal' ? BUNDLED.toLowerCase().includes(words) : defaultLabel.toLowerCase().includes(words);
    if (!words || defaultMatch) out.push({ value: '', label: defaultLabel });
    for (const f of fonts) out.push({ value: f, label: f });
    const typed = q.trim();
    if (typed && !out.some((r) => r.value.toLowerCase() === typed.toLowerCase()))
      out.push({ value: typed, label: t('settings.font.use', { font: typed }), custom: true });
    // The current family stays reachable when it is not listed.
    if (!words && value && !out.some((r) => r.value === value)) out.splice(1, 0, { value, label: value });
    return out;
  }, [list, q, value, kind, defaultLabel]);

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
        {rows.map((r, i) => {
          const rf = r.custom ? undefined : rowStack(r.value);
          return (
            <div
              key={`${r.custom ? '+' : ''}${r.value}`}
              role="option"
              aria-selected={r.value === value}
              className={`font-row ${i === sel ? 'sel' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => onPick(r.value)}
              style={rf ? { fontFamily: rf } : undefined}
            >
              <span className="font-check">{r.value === value && !r.custom && <Check />}</span>
              <span className="ellipsis">{r.label}</span>
            </div>
          );
        })}
        {!list && <div className="muted small pad">{t('settings.font.loading')}</div>}
      </div>
      {list && !list.complete && <div className="muted small font-note">{t(PARTIAL_NOTES[kind])}</div>}
    </div>
  );
}
