import { describe, expect, it } from 'vitest';
import { detectLocale, t } from '../i18n';
import { en } from '../i18n/en';
import { zhCN } from '../i18n/zh-CN';

describe('i18n', () => {
  it('detects the locale from preference, then browser languages', () => {
    expect(detectLocale('zh-CN', ['en-US'])).toBe('zh-CN');
    expect(detectLocale(null, ['zh-TW', 'en'])).toBe('zh-CN');
    expect(detectLocale(null, ['fr-FR', 'en-GB'])).toBe('en');
    expect(detectLocale('xx', ['de'])).toBe('en');
  });
  it('substitutes every occurrence of a placeholder', () => {
    expect(t('app.hint', { prefix: 'ctrl+a' })).not.toContain('{prefix}');
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
});
