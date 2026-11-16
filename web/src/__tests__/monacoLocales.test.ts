// The locales Monaco's unicode highlighting allows: the user's languages
// map to Monaco's keys, so their punctuation is not marked as ambiguous.

import { describe, expect, it } from 'vitest';
import { allowedLocales } from '../plugins/monacoLocales';

const base = { _os: true, _vscode: true };

describe('allowedLocales', () => {
  it('maps simplified Chinese', () => {
    expect(allowedLocales(['zh-CN'], 'en')).toEqual({ ...base, 'zh-hans': true, en: true });
    expect(allowedLocales(['zh', 'zh-SG', 'zh-Hans'], 'en')).toEqual({ ...base, 'zh-hans': true, en: true });
  });
  it('maps traditional Chinese', () => {
    expect(allowedLocales(['zh-TW'], 'en')).toMatchObject({ 'zh-hant': true });
    expect(allowedLocales(['zh-Hant-HK', 'zh-MO'], 'en')).toMatchObject({ 'zh-hant': true });
    expect(allowedLocales(['zh-TW'], 'en')).not.toHaveProperty('zh-hans');
  });
  it('maps Brazilian Portuguese and other languages by primary subtag', () => {
    expect(allowedLocales(['pt-BR', 'ja-JP', 'pt-PT'], 'en')).toEqual({
      ...base,
      'pt-br': true,
      ja: true,
      pt: true,
      en: true,
    });
  });
  it('maps English and ignores duplicates', () => {
    expect(allowedLocales(['en-US', 'en-GB', 'en'], 'en')).toEqual({ ...base, en: true });
  });
  it('adds the UI language to English browser languages', () => {
    expect(allowedLocales(['en-US', 'en'], 'zh-CN')).toEqual({ ...base, en: true, 'zh-hans': true });
  });
  it('works without languages', () => {
    expect(allowedLocales([], 'en')).toEqual({ ...base, en: true });
  });
});
