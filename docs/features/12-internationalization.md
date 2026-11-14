# 12 · Internationalization

## Context

The first users work in Chinese; an open-source audience expects English.
Both the UI and the documentation must serve both without drifting apart.

## Goals / non-goals

Goals: English and Simplified Chinese UI chosen from the browser languages
or by the user; missing translations caught at build time; the server never
produces user-facing prose; documentation translated where it helps
newcomers, canonical in English.

Non-goals: right-to-left layouts; translating logs, protocol messages or
reference documentation.

## Design

- **Web UI** (`web/src/i18n`): `en.ts` is the source of keys; other locales
  are typed `Record<MessageKey, string>`, so a missing or extra key fails
  `tsc`. `t(key, vars)` substitutes `{placeholders}`; a test checks that every
  translation uses the same placeholders. The locale comes from the saved
  setting, then `navigator.languages`, then English; `<html lang>` is set
  accordingly. The settings dialog and the palette switch language (reloads
  the page). Settings defined by the core are labelled with keys built from
  their names (`settings.<key>`, `.desc`, `.<option>`); a test checks that
  the known ones exist, and an untranslated one shows its key.
- **macOS application** (`macos/Sources/App/Resources`): `Localizable.strings`
  per locale (`en`, `zh-Hans`), read with `tr(key, args)`, in the language
  of the core's `appearance.language` (`auto`: the system's). `LocalizationTests` checks that every locale has the
  English keys with the same `%@` placeholders, and that every key is used
  and every used key exists. The core's codes (backend and machine states)
  are keys: `backend.<code>`, `machine.<status>`, `status.<state>`.
- **Desktop shell**: the menu's titles (`desktop.menu.*`, the macOS
  application's `menu.*` strings in both languages; `desktop/src/menu.test.ts`
  compares them) and the error dialogs (`desktop.*`) come from the web's
  English/Chinese dictionaries, Electron's role items included. They follow
  the core's `appearance.language`, which the shell reads itself; `auto`
  follows the system's preferred languages, and so does a failure before the
  core answers.
- **Server**: sends codes (code-server phases such as `download` with a
  detail, pane notices such as `taken_over`, agent statuses) that the UI
  translates. The code-server loading page, served inside the VS Code iframe,
  carries its own small English/Chinese table for the same codes and uses
  the embedding page's language. Settings errors are codes too (`invalid`,
  `locked`, `unknown`, `save`). Error
  messages from herdr-core, ssh or the OS are shown verbatim.
- **VS Code extension**: `package.nls.json` / `package.nls.zh-cn.json` for
  contributed titles; `vscode.l10n.t` with `l10n/bundle.l10n.zh-cn.json` for
  runtime strings.
- **Docs**: `README.md` (English, canonical) and `README.zh-CN.md` share
  their section structure, checked by `scripts/check.sh`; reference material
  is English-only in `docs/` and linked from both.

## Adding a locale

1. Add `web/src/i18n/<locale>.ts` typed as `Messages`, register it in
   `i18n/index.ts` (`dicts`, `locales`, detection).
2. Add `package.nls.<locale>.json` and `l10n/bundle.l10n.<locale>.json` to
   the extension.
3. Add the language to the loading-page table in
   `internal/server/codeserver.go`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| i18next / FormatJS | Heavier than needed for two locales without plurals or rich formatting. |
| Server-rendered translated messages | Ties the server to UI languages and makes clients unable to localize. |

## Testing

`web/src/__tests__/i18n.test.ts` (locale detection, placeholder
substitution, placeholder parity); `tsc` enforces key completeness. Both
languages were checked in Chrome.
