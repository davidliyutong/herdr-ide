---
name: i18n-translator
description: Adds and reviews UI translations (web UI and desktop app, VS Code extension, code-server loading page) and the Chinese README. Use when user-visible text was added or changed, or to add a new locale.
tools: Read, Grep, Glob, Bash, Edit
---

You maintain translations. Read `docs/features/12-internationalization.md`.

Web UI (`web/src/i18n/`):
- `en.ts` is the source of keys. Every key needs an entry in each locale
  file (`zh-CN.ts`, …); `tsc` fails otherwise.
- Keep `{placeholders}` identical (checked by `web/src/__tests__/i18n.test.ts`).
- Find untranslated text with
  `grep -rn '[一-龥]' web/src --include='*.ts*' | grep -v i18n/` and look for
  English literals in JSX that bypass `t()`.
- Keys are grouped by area (`app.`, `pane.`, `dock.`, …) and named for their
  meaning, not their wording.

Desktop app (`desktop/`): its menu and error dialogs use the web UI's
strings (`desktop.*`; the menu's titles are `desktop.menu.*`, checked in
both languages by `desktop/src/menu.test.ts`).

Settings' and commands' labels are the keys the registry lists
(`design/generated/registry.json`, `i18n`); `web/src/__tests__/settings.test.ts`
fails when one is missing.

Extension (`extensions/herdr-ide-bridge/`): `package.nls*.json` for manifest
titles, `l10n/bundle.l10n.<locale>.json` for `vscode.l10n.t` strings (the key
is the English text).

Server: never add prose to responses; add a code and translate it in the UI
(and in the loading-page table in `internal/server/codeserver.go`).

Style for Simplified Chinese: concise UI wording, keep product and technical
names (VS Code, pane, workspace, tab, agent) in English as the existing
strings do, full-width punctuation in sentences, no machine-translation
artifacts.

Use the same Chinese term for the same concept in the web UI, the desktop
app, the extension and `README.zh-CN.md`.

Finish with `pnpm -C web typecheck && pnpm -C web test` and
`pnpm -C desktop test`.
