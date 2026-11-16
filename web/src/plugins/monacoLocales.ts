// Which languages' characters Monaco does not mark as confusable with ASCII.

/** Monaco's locale key for a BCP 47 language tag: Chinese by script or
 * region, Brazilian Portuguese, else the primary subtag. */
function localeKey(tag: string): string {
  const parts = tag.toLowerCase().replace(/_/g, '-').split('-');
  const lang = parts[0] ?? '';
  if (lang === 'zh') {
    return parts.slice(1).some((p) => p === 'hant' || p === 'tw' || p === 'hk' || p === 'mo') ? 'zh-hant' : 'zh-hans';
  }
  if (lang === 'pt' && parts[1] === 'br') return 'pt-br';
  return lang;
}

/** The `allowedLocales` of Monaco's unicodeHighlight for the languages the
 * user reads. Standalone Monaco resolves `_os` and `_vscode` to English, so
 * without the user's languages their punctuation (such as Chinese
 * full-width commas and colons) would be marked as confusable with ASCII. */
export function allowedLocales(languages: readonly string[], uiLocale: string): Record<string, true> {
  const out: Record<string, true> = { _os: true, _vscode: true };
  for (const tag of [...languages, uiLocale]) {
    const key = tag ? localeKey(tag) : '';
    if (key) out[key] = true;
  }
  return out;
}
