// Minimal i18n: t(key, vars) with English fallback. The locale comes from the
// saved setting or the browser languages; changing the setting reloads the
// page (see prefs.ts).

import { en, type MessageKey, type Messages } from './en';
import { zhCN } from './zh-CN';
import { storage } from '../brand';

export type Locale = 'en' | 'zh-CN';

const dicts: Record<Locale, Messages> = { en, 'zh-CN': zhCN };

export const locales: { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'zh-CN', label: '简体中文' },
];

export function detectLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved && saved in dicts) return saved as Locale;
  for (const l of languages) {
    const x = l.toLowerCase();
    if (x.startsWith('zh')) return 'zh-CN';
    if (x.startsWith('en')) return 'en';
  }
  return 'en';
}

export const locale: Locale = detectLocale(
  storage.get('locale'),
  typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language],
);

if (typeof document !== 'undefined') document.documentElement.lang = locale;

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  let s: string = dicts[locale][key] ?? en[key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Whether key is a message key (for keys built at runtime). */
export function hasMessage(key: string): key is MessageKey {
  return key in en;
}

export type { MessageKey };
