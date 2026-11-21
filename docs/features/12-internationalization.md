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
  translation uses the same placeholders. A plugin's messages are in its
  own directory, `web/src/plugins/<id>/i18n/en.ts` and `zh-CN.ts` (typed
  against that plugin's `en`), and `web/src/i18n`'s files spread them into
  the one table `t` reads: changes to two plugins touch no common file. Its
  keys are `<id>.…`, its settings' (`settings.<id>.…`,
  `settings.section.<id>`, `settings.group.<id>…`), its commands'
  (`command.<id>.…`) and `plugins.<id>.…`; a test fails for any other key
  in a plugin's file. The locale comes from the core's
  `appearance.language` setting (`auto`, `en`, `zh-CN`; one value for every
  client of the core), where `auto` follows `navigator.languages`, then
  English; `<html lang>` is set accordingly. The settings dialog and the
  palette switch language (the page that changed it reloads). Settings and
  commands defined by the core are labelled with keys built from their
  names (`settings.<key>`, `.desc`, `.<option>`, `command.<id>`);
  `design/generated/registry.json` lists those keys (`scripts/registry`,
  `"i18n"`), `settings.test.ts` checks that the web UI has them, and an
  untranslated one shows its key.
- **Vocabulary**: one name per thing and per command in every place (the
  desktop app's menu, the command palette, the keyboard shortcuts page,
  context menus and tooltips all use `command.<id>`), Title Case in English
  menus and command names as in VS Code and macOS. Chinese uses the words
  Chinese VS Code and Chrome use: 工作区 (workspace), 标签页 (tab), 窗格
  (pane), 智能体 (agent, the coding agents; the sidebar's **Agents**
  section is 智能体), 分屏, 侧栏, 程序窗口, 服务器 (the core). herdr-core
  is the **terminal service** (终端服务), named only in the machine's
  **Troubleshooting** submenu, its machine settings page and errors; the
  everyday UI says terminals.
- **Desktop shell**: the menu's titles (`desktop.menu.*`), its items of
  commands (`command.<id>`) and the error dialogs (`desktop.*`) come from
  the web's English/Chinese dictionaries, Electron's role items included. They follow
  the core's `appearance.language`, which the shell reads itself; `auto`
  follows the system's preferred languages, and so does a failure before the
  core answers.
- **Server**: sends codes that the UI translates: code-server phases such as
  `download` with a detail, the terminal core's states (`machine_offline`,
  `not_bundled`, `start_failed`, `stopped`…; `backend.<code>` in the UI),
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
3. Add `package.nls.<locale>.json` and `l10n/bundle.l10n.<locale>.json` to
   the extension.
4. Add the language to the loading-page table in
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
for the web UI). `desktop/src/menu.test.ts` (the menu's titles follow the
language). `scripts/check.sh`
(`scripts/registry -check`: the generated key lists are current; README
sections). Both languages were checked in Chrome.
