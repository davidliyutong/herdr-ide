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
  translation uses the same placeholders. The locale comes from the core's
  `appearance.language` setting (`auto`, `en`, `zh-CN`; one value for every
  client of the core), where `auto` follows `navigator.languages`, then
  English; `<html lang>` is set accordingly. The settings dialog and the
  palette switch language (the page that changed it reloads). Settings and
  commands defined by the core are labelled with keys built from their
  names (`settings.<key>`, `.desc`, `.<option>`, `command.<id>`);
  `design/generated/registry.json` lists the keys each UI needs
  (`scripts/registry`), `settings.test.ts` checks that the web UI has them,
  and an untranslated one shows its key.
- **macOS application** (`macos/Sources/App/Resources`): `Localizable.strings`
  per locale (`en`, `zh-Hans`), read with `tr(key, args)`, in the language
  of the core's `appearance.language` (`auto`: the system's).
  `LocalizationTests` checks that every locale has the English keys with
  the same `%@` placeholders, that every key is used and every used key
  exists, and that the keys the core's registry asks of the application
  exist. The core's codes are keys: `backend.<code>` (the terminal core's
  state), `machine.<status>` and `machine.error.<code>`, `status.<state>`
  (agents).
- **Desktop shell**: the menu's titles (`desktop.menu.*`, the macOS
  application's `menu.*` strings in both languages; `desktop/src/menu.test.ts`
  compares them) and the error dialogs (`desktop.*`) come from the web's
  English/Chinese dictionaries, Electron's role items included. They follow
  the core's `appearance.language`, which the shell reads itself; `auto`
  follows the system's preferred languages, and so does a failure before the
  core answers.
- **Server**: sends codes that the UI translates: code-server phases such as
  `download` with a detail, the terminal core's states (`machine_offline`,
  `not_bundled`, `start_failed`, `stopped`…; `backend.<code>` in both UIs),
  machine states, agent statuses, program window phases (`gui.phase.*`).
  The code-server loading page, served inside the VS Code iframe, carries
  its own small English/Chinese table for the same codes and uses the
  embedding page's language. Errors of the settings and keybindings API
  are codes too (`invalid`, `locked`, `unknown`, `save`, `file`, `scope`),
  and so are those of the machines API (`invalid`, `machine_exists`,
  `label_taken`, `local`, `unknown`, `save`). Error messages from
  herdr-core, ssh or the OS are shown verbatim.
- **VS Code extension**: `package.nls.json` / `package.nls.zh-cn.json` for
  contributed titles; `vscode.l10n.t` with `l10n/bundle.l10n.zh-cn.json` for
  runtime strings.
- **Docs**: `README.md` (English, canonical) and `README.zh-CN.md` share
  their section structure, checked by `scripts/check.sh`; reference material
  is English-only in `docs/` and linked from both.

## Adding a locale

1. Add the locale to the `appearance.language` setting's values
   (`internal/uisettings/uisettings.go`) and run `make tokens` to
   regenerate `design/generated/registry.json`.
2. Add `web/src/i18n/<locale>.ts` typed as `Messages`, register it in
   `i18n/index.ts` (`dicts`, `locales`, detection).
3. Add `macos/Sources/App/Resources/<locale>.lproj/Localizable.strings`
   and map the setting's value to it in `macos/Sources/App/Theme.swift`.
4. Add `package.nls.<locale>.json` and `l10n/bundle.l10n.<locale>.json` to
   the extension.
5. Add the language to the loading-page table in
   `internal/server/codeserver.go`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| i18next / FormatJS | Heavier than needed for two locales without plurals or rich formatting. |
| Server-rendered translated messages | Ties the server to UI languages and makes clients unable to localize. |

## Testing

`web/src/__tests__/i18n.test.ts` (locale detection, placeholder
substitution, placeholder parity); `tsc` enforces key completeness;
`web/src/__tests__/settings.test.ts` (every key the core's registry needs
for the web UI). `macos/Tests/TermKitTests` (`LocalizationTests`: locales
agree, keys used and present, the registry's keys).
`desktop/src/menu.test.ts` (the menu's titles are the macOS application's
in English and Chinese, and follow the language). `scripts/check.sh`
(`scripts/registry -check`: the generated key lists are current; README
sections). Both languages were checked in Chrome.
