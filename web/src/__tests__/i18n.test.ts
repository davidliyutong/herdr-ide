import { describe, expect, it } from 'vitest';
import { detectLocale, t } from '../i18n';
import { en } from '../i18n/en';
import { zhCN } from '../i18n/zh-CN';

// A plugin's messages live in its own directory (plugins/<id>/i18n).
const pluginMessages = import.meta.glob<{ en: Record<string, string> }>('../plugins/*/i18n/en.ts', { eager: true });

describe('i18n', () => {
  it('detects the locale from preference, then browser languages', () => {
    expect(detectLocale('zh-CN', ['en-US'])).toBe('zh-CN');
    expect(detectLocale(null, ['zh-TW', 'en'])).toBe('zh-CN');
    expect(detectLocale(null, ['fr-FR', 'en-GB'])).toBe('en');
    expect(detectLocale('xx', ['de'])).toBe('en');
  });
  it('substitutes every occurrence of a placeholder', () => {
    expect(t('app.withKey', { label: 'Zoom', key: 'cmd+z' })).not.toMatch(/\{(label|key)\}/);
  });
  it('keeps placeholders consistent across locales', () => {
    const vars = (s: string) =>
      [...s.matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .sort()
        .join(',');
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(vars(zhCN[k]), k).toBe(vars(en[k]));
    }
  });
  it('keeps a plugin\u2019s messages under its own keys', () => {
    const files = Object.entries(pluginMessages);
    expect(files.length).toBeGreaterThan(0);
    for (const [file, mod] of files) {
      const id = /plugins\/([^/]+)\/i18n/.exec(file)![1];
      const own = new RegExp(
        `^(${id}\\.|settings\\.${id}\\.|settings\\.section\\.${id}$|settings\\.group\\.${id}[A-Z]|command\\.${id}\\.|plugins\\.${id}\\.)`,
      );
      for (const k of Object.keys(mod.en)) {
        expect(k, file).toMatch(own);
        expect(en[k as keyof typeof en], k).toBe(mod.en[k]);
      }
    }
  });
});
