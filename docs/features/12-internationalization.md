# 12 · Internationalization

## Context

The first users work in Chinese; an open-source audience expects English. The UI and the documentation must serve both without drifting apart.

## Goals / non-goals

Goals: English and Simplified Chinese UI; missing translations caught at build time; no user-facing prose from the server; documentation canonical in English. Non-goals: right-to-left layouts; translating logs, protocol messages or reference documentation.

## Design

- `web/src/i18n/en.ts` defines the keys; other locales are typed against it, so a missing key fails `tsc`. The locale is the hub's `appearance.language`, shared by every client (`auto` follows the browser's languages, in the desktop shell's menus the system's).
- Plugins keep their messages in `web/src/plugins/<id>/i18n/`, under their own namespaces, merged into one table.
- The hub's settings and commands are labelled by keys built from their names (`settings.<key>`, `command.<id>`), listed in `spec/generated/registry.json`; one name per command everywhere.
- The server sends codes the UI translates; errors from herdr-core, ssh or the OS are shown verbatim.
- Chinese uses the words of Chinese VS Code and Chrome (工作区, 标签页, 窗格, 智能体); herdr-core is the 终端服务.
- The VS Code extension has `package.nls*.json` and `l10n/`; `README.md` and `README.zh-CN.md` keep the same sections (`scripts/check.sh`).

A new locale goes into `appearance.language` (`backend/kernel/config/ui/ui.ts`, then `make tokens`), `web/src/i18n/index.ts`, the extension and the code-server loading page (`backend/features/vscode/loading.ts`).

## Alternatives considered

| Option | Why not |
| --- | --- |
| i18next / FormatJS | Heavier than needed for two locales without plurals. |
| Server-rendered translated messages | Ties the server to UI languages. |

## Testing

`web/src/__tests__/i18n.test.ts` (detection, placeholders, plugin namespaces), `tsc`, `settings.test.ts` (the registry's keys), `desktop/src/menu.test.ts`, `scripts/check.sh`.
