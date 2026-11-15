// The terminal colors of the settings: for the dark and the light theme a
// scheme (terminal.colorScheme.<theme>) with a preview, and the user's own
// colors (terminal.colors.<theme>.*) as named swatches that replace the
// scheme's. Choosing another scheme drops the user's own colors of that
// theme, after asking.

import { useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { hasMessage, t, type MessageKey } from '../../i18n';
import { colors } from '../../prefs';
import { resetSetting, setSetting, useSettings, type SettingDef } from '../../settings';
import { ansiNames, schemeColors } from '../../terminal/schemes';
import { confirmDialog } from '../../dialog';

type Theme = 'dark' | 'light';
const overrides = ['foreground', 'background', 'cursor', 'selection', 'palette'] as const;

/** The keys of a theme's own colors. */
export const colorKeys = (theme: Theme) => overrides.map((n) => `terminal.colors.${theme}.${n}`);

export function schemeLabel(id: string): string {
  const k = `settings.terminal.colorScheme.dark.${id}`;
  return hasMessage(k) ? t(k) : id;
}

export function ThemeColors({
  theme,
  scheme,
  readOnly,
  onError,
}: {
  theme: Theme;
  scheme: SettingDef;
  readOnly: boolean;
  onError(e: string | undefined): void;
}) {
  const values = useSettings((s) => s.values);
  const current = String(values[scheme.key]?.value ?? 'default');
  const own = colorKeys(theme).filter((k) => values[k] && values[k].source !== 'default');
  const [open, setOpen] = useState(own.length > 0);
  const c = colors(theme);
  const base = schemeColors(current, theme);
  const locked = !!values[scheme.key]?.locked;

  const choose = async (id: string) => {
    if (id === current) return;
    if (
      own.length > 0 &&
      !(await confirmDialog({
        title: t('settings.colors.replaceTitle'),
        message: t('settings.colors.replace', { scheme: schemeLabel(id) }),
        confirm: t('settings.colors.replaceConfirm'),
      }))
    )
      return;
    onError(await setSetting(scheme.key, id));
    for (const k of own) onError(await resetSetting(k));
  };
  const set = async (name: (typeof overrides)[number], v: string | string[]) =>
    onError(await setSetting(`terminal.colors.${theme}.${name}`, v));
  const reset = async (name: (typeof overrides)[number]) => onError(await resetSetting(`terminal.colors.${theme}.${name}`));
  const isOwn = (name: (typeof overrides)[number]) => own.includes(`terminal.colors.${theme}.${name}`);

  return (
    <div className={`setting ${current !== 'default' || own.length ? 'modified' : ''}`} data-key={scheme.key}>
      <div className="setting-head">
        <span className="setting-title">{t(`settings.${scheme.key}` as MessageKey)}</span>
      </div>
      <div className="setting-desc">{t(`settings.${scheme.key}.desc` as MessageKey)}</div>
      <div className="setting-control scheme-control">
        <select
          value={current}
          disabled={readOnly || locked}
          aria-label={t(`settings.${scheme.key}` as MessageKey)}
          onChange={(e) => void choose(e.target.value)}
        >
          {(scheme.enum ?? []).map((id) => (
            <option key={id} value={id}>
              {schemeLabel(id)}
            </option>
          ))}
        </select>
        <SchemePreview fg={c.foreground} bg={c.background} palette={c.palette} />
      </div>
      <button type="button" className="link disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown /> : <ChevronRight />}
        {t('settings.colors.customize')}
        {own.length > 0 && <span className="muted small"> · {t('settings.colors.customized', { n: own.length })}</span>}
      </button>
      {open && (
        <div className="swatches">
          <div className="swatch-group">
            {(['foreground', 'background', 'cursor', 'selection'] as const).map((name) => (
              <Swatch
                key={name}
                label={t(`settings.colors.${name}` as MessageKey)}
                value={c[name]}
                own={isOwn(name)}
                disabled={readOnly}
                onChange={(v) => void set(name, v)}
                onReset={() => void reset(name)}
              />
            ))}
          </div>
          <div className="swatch-grid">
            {c.palette.map((color, i) => (
              <Swatch
                key={i}
                label={t(`settings.colors.${i < 8 ? '' : 'bright.'}${ansiNames[i % 8]}` as MessageKey)}
                value={color}
                own={isOwn('palette') && color !== base.palette[i]}
                disabled={readOnly}
                onChange={(v) =>
                  void set(
                    'palette',
                    c.palette.map((x, j) => (j === i ? v : x)),
                  )
                }
                onReset={() => {
                  const next = c.palette.map((x, j) => (j === i ? base.palette[i] : x));
                  void (next.every((x, j) => x === base.palette[j]) ? reset('palette') : set('palette', next));
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A scheme's background with its text and the 16 colors. */
export function SchemePreview({ fg, bg, palette }: { fg: string; bg: string; palette: string[] }) {
  return (
    <span className="scheme-preview" style={{ background: bg, color: fg }} aria-hidden>
      <span className="scheme-text">Aa</span>
      {palette.map((c, i) => (
        <span key={i} className="scheme-chip" style={{ background: c }} />
      ))}
    </span>
  );
}

/** A named color well; one the user set has a reset button. */
function Swatch({
  label,
  value,
  own,
  disabled,
  onChange,
  onReset,
}: {
  label: string;
  value: string;
  own: boolean;
  disabled: boolean;
  onChange(v: string): void;
  onReset(): void;
}) {
  const [draft, setDraft] = useState<string>();
  const [timer, setTimer] = useState<number>();
  const shown = draft ?? value;
  const pick = (v: string) => {
    setDraft(v);
    clearTimeout(timer);
    // The pick is saved once it rests.
    setTimer(
      window.setTimeout(() => {
        setDraft(undefined);
        if (v !== value) onChange(v);
      }, 300),
    );
  };
  return (
    <label className={`swatch ${own ? 'own' : ''}`} title={`${label} · ${shown}`}>
      <input type="color" value={shown} disabled={disabled} aria-label={label} onChange={(e) => pick(e.target.value)} />
      <span className="swatch-name ellipsis">{label}</span>
      {own && !disabled && (
        <button
          type="button"
          className="icon swatch-reset"
          title={t('settings.colors.resetOne')}
          onClick={(e) => {
            e.preventDefault();
            onReset();
          }}
        >
          <RotateCcw />
        </button>
      )}
    </label>
  );
}
