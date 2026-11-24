# 12 · Internationalization

## Context

The first users work in Chinese; an open-source audience expects English.
The UI and the documentation must serve both without drifting apart.

## Goals / non-goals

Goals:

- English and Simplified Chinese UI, from the browser's languages or the
  user's choice;
- missing translations caught at build time;
- the server never produces user-facing prose;
- documentation translated where it helps newcomers, canonical in English.

Non-goals: right-to-left layouts; translating logs, protocol messages or
reference documentation.

## Design

- **Web UI** (`web/src/i18n`):
  - `en.ts` defines the keys; other locales are typed
    `Record<MessageKey, string>`, so a missing or extra key fails `tsc`.
  - `t(key, vars)` substitutes `{placeholders}`; a test checks every
    translation uses the same ones.
  - The locale is the core's `appearance.language` setting (`auto`, `en`,
    `zh-CN`), shared by every client. `auto` follows
    `navigator.languages`, then English. `<html lang>` follows it.
- **Plugins** keep their messages in `web/src/plugins/<id>/i18n/`, merged
  into the one table `t` reads, so two plugins never touch a common file.
  A test restricts a plugin's keys to its own namespaces (`<id>.…`,
  `settings.<id>.…`, `command.<id>.…`, `plugins.<id>.…`).
- **Core-defined settings and commands** are labelled by keys built from
  their names (`settings.<key>`, `command.<id>`).
  `spec/generated/registry.json` lists them and `settings.test.ts`
  checks the web UI has each; an untranslated one shows its key.
- **Vocabulary**: one name per thing and per command everywhere (menus,
  palette, shortcuts page and tooltips all use `command.<id>`). English uses
  Title Case for commands, as VS Code and macOS do. Chinese uses the words
  of Chinese VS Code and Chrome: 工作区 (workspace), 标签页 (tab), 窗格
  (pane), 智能体 (agent), 分屏, 侧栏, 程序窗口, 服务器 (the core).
  herdr-core is the **terminal service** (终端服务), named only in
  troubleshooting, its settings and errors.
- **Desktop shell**: menu titles, command items and error dialogs come from
  the web UI's dictionaries. The shell reads `appearance.language` itself;
  `auto`, or a failure before the core answers, follows the system's
  languages.
- **Server**: sends codes the UI translates (code-server phases, terminal
  core states as `backend.<code>`, machine states, agent statuses, program
  window phases, API error codes). The code-server loading page carries its
  own small English/Chinese table and uses the embedding page's language.
  Errors from herdr-core, ssh or the OS are shown verbatim.
- **VS Code extension**: `package.nls*.json` for contributed titles;
  `vscode.l10n.t` with `l10n/bundle.l10n.zh-cn.json` for runtime strings.
- **Docs**: `README.md` (canonical) and `README.zh-CN.md` share their
  section structure, checked by `scripts/check.sh`. Reference material in
  `docs/` is English only.

## Adding a locale

1. Add it to the `appearance.language` values
   (`internal/uisettings/uisettings.go`) and run `make tokens`.
2. Add `web/src/i18n/<locale>.ts` typed as `Messages` and register it in
   `i18n/index.ts` (`dicts`, `locales`, detection).
3. Add `package.nls.<locale>.json` and `l10n/bundle.l10n.<locale>.json` to
   the extension.
4. Add the language to the loading page's table in
   `internal/server/codeserver.go`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| i18next / FormatJS | Heavier than needed for two locales without plurals or rich formatting. |
| Server-rendered translated messages | Ties the server to UI languages; clients cannot localize. |

## Testing

- `web/src/__tests__/i18n.test.ts`: locale detection, placeholder
  substitution and parity.
- `tsc`: key completeness.
- `web/src/__tests__/settings.test.ts`: every key the core's registry
  needs.
- `desktop/src/menu.test.ts`: menu titles follow the language.
- `scripts/check.sh`: generated key lists current (`scripts/registry
  -check`), README sections aligned.

Both languages were checked in Chrome.
