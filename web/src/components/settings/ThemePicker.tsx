// The color theme setting (appearance.colorTheme): a card per theme with
// its accent on the dark and the light background, chosen like a radio.
import { colorThemes } from '../../themes';
import { hasMessage, t } from '../../i18n';
import tokens from '../../../../spec/tokens.json';

export function themeLabel(id: string): string {
  const k = `settings.appearance.colorTheme.${id}`;
  return hasMessage(k) ? t(k) : id;
}

export function ThemePicker({ value, disabled, onChange }: { value: string; disabled: boolean; onChange(id: string): void }) {
  const bg = tokens.color.background;
  const line = tokens.color.borderStrong;
  return (
    <div className="theme-picker" role="radiogroup" aria-label={t('settings.appearance.colorTheme')}>
      {colorThemes.map((th) => (
        <button
          key={th.id}
          type="button"
          role="radio"
          aria-checked={th.id === value}
          className={`theme-card ${th.id === value ? 'on' : ''}`}
          disabled={disabled}
          data-theme-id={th.id}
          onClick={() => onChange(th.id)}
        >
          <span className="theme-swatch" aria-hidden>
            {(['dark', 'light'] as const).map((kind) => (
              <span
                key={kind}
                className="theme-swatch-half"
                style={{ background: bg[kind], borderColor: kind === 'light' ? line.light : 'transparent' }}
              >
                <span className="theme-swatch-bar" style={{ background: th.accent[kind] }} />
                <span className="theme-swatch-button" style={{ background: th.accent[kind], color: th.onAccent[kind] }}>
                  Aa
                </span>
              </span>
            ))}
          </span>
          <span className="theme-name">{themeLabel(th.id)}</span>
        </button>
      ))}
    </div>
  );
}
