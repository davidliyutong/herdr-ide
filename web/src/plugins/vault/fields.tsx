// What the vault's passphrase fields share: the attributes that keep
// password managers away (a passphrase a browser saved is readable by
// programs on the computer in several browsers) and a rough strength.

import { t } from '../../i18n';

/** Password managers are kept away from passphrase fields. */
export const noManager = {
  autoComplete: 'off',
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
  'data-form-type': 'other',
};

/** A rough strength, 0 to 4: length and kinds of characters. */
export function passStrength(p: string): number {
  if (p.length < 8) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  return Math.min(4, (p.length >= 12 ? 2 : 1) + (kinds >= 3 ? 2 : kinds >= 2 ? 1 : 0));
}

/** The strength bar under a new passphrase. */
export function StrengthBar({ value }: { value: string }) {
  return (
    <div className={`vault-strength s${passStrength(value)}`} aria-hidden>
      <i />
      <i />
      <i />
      <i />
    </div>
  );
}

/** A passphrase's length in characters (as the core counts them). */
export function chars(s: string): number {
  return [...s].length;
}

/** The passphrase field of an action that, where every Allow is verified,
 * needs the user's word and has no authenticator to give it. */
export function FreshPassphrase({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <input
      className="input"
      type="password"
      {...noManager}
      autoFocus
      data-field="fresh-passphrase"
      placeholder={t('vault.fresh.passphrase')}
      aria-label={t('vault.fresh.passphrase')}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
