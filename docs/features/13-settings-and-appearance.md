# 13 · Settings, keybindings and appearance

## Context

Several clients show one hub's machines: the web UI (in browsers and in the desktop app) and the desktop app's shell (its menu and title bar). Values kept per client (a browser's `localStorage`, keys in a menu) differ per browser and profile, do not reach the other clients, and cannot be read by the shell. So settings and keybindings live in the hub.

## Goals / non-goals

Goals:

- one settings system and one keybinding system, with the hub as the only source;
- the settings UI rendered from the hub's definitions;
- hand-editable files like VS Code's `settings.json` and `keybindings.json`;
- a change from any client or from the file reaches every client at once;
- the command line stays the authority.

Non-goals: per-user settings on a shared hub (the hub has no users); settings per browser; theming terminal applications.

## Design

### Registry

- `backend/kernel/config/settings` holds the model (`define.ts`) and the values (`store.ts`). `hubModules` (`backend/kernel/config/registry.ts`) gathers the UI's module (`config/ui`), the feature switches ([27](27-plugins.md)) and the features' own, in the order `hubFeatures` (`backend/hosts/common/compose.ts`) composes them, which is also the order of the UIs' lists.
- A definition has a dotted key, a type, a default, constraints, a section, an optional command-line flag and a zod schema; its scope is `app`, `machine` (any machine may have its own value) or `remote-machine`. Labels and descriptions are the UI's translations ([12](12-internationalization.md)).
- `backend/scripts/registry.ts` writes `spec/generated/registry.json` (defaults, commands, default bindings, the translation keys the UI needs) and the tables of [reference](../reference.md#settings), which lists every setting; `make tokens` regenerates them, `make check` fails when they are stale.

### File and precedence

- `settings.json` lies beside `keybindings.json` in the data directory of the hub's namespace on the hub host, `~/.veldr[-<node instance>]` (`backend/kernel/config/paths.ts`, [reference](../reference.md#files-and-directories)): global values at the top level, a machine's own under `"[machine:<id>]"`. Every hub of the namespace there shares both files, so the desktop app and `veldr` without `--instance` show the same settings and keys.
- The file is JSONC; a change edits only its value, keeping the user's comments and layout (`backend/kernel/config/jsonc.ts`), and is written atomically, mode 0600.
- Unknown keys and invalid values are kept on rewrite (another version may know them) and reported as problems. While the file is not JSON, the values read before stay and changes are refused, so an edit in progress is never overwritten.
- The hub polls the file every 2 s for hand edits and other hubs' changes, which reach its clients (and, for the chat host's settings, the machines' chat hosts) as its own do; an API change first reads what changed meanwhile so it is not lost.
- Precedence: command-line flag → the machine's own value → the global value → the default. A flag locks its setting in the UI (`locked`).

### API

`backend/kernel/config/routes.ts`; endpoints in [reference](../reference.md#http-and-websocket-endpoints). `GET /api/settings` returns definitions, values with their source, problems and the file; `PUT` and `DELETE` set and remove a value. Errors are codes the UI translates. Every change, through the API or the file, is pushed to every `/ws` client (`settings`).

### Keybindings

`backend/kernel/config/keybindings`; key syntax, contexts and defaults in [reference](../reference.md#keyboard-shortcuts), the choice of defaults in [04](04-layout-and-keyboard.md).

- Commands are registered in the hub (`commands.ts`): an id, a section, a context (`terminal`, `editor`, `vscode`, `dialog`, `always`) and default keys per platform. The desktop app and a browser on the same computer are different platforms (`mac`, `mac-browser`), since `cmd+t` belongs to the browser.
- The hub (`keys.ts`) and the web UI (`web/src/keys.ts`) parse keys alike, tested with `spec/vectors/keys`; no binding may take a key that types text.
- The user's file is an array of `{key, command, when?}` applied after the defaults on every platform (`"command": "-<id>"` removes one), kept and protected like the settings file.
- The hub computes the effective bindings and conflicts per platform, so clients only match keys. No platform's defaults conflict (tested); among user rules the first wins. `GET`/`PUT /api/keybindings` work as the settings' API, pushed as `keybindings`.

### Clients

`web/src/settings.ts`, `prefs.ts`, `keybindings.ts`, `keymap.ts`, `components/SettingsDialog.tsx`.

- The page reads `/api/settings` before rendering (the language must be known) and after each reconnect; until the hub answers, `registry.json`'s defaults apply. Per-browser state (sidebar, selected machine) stays in `localStorage`.
- The Settings dialog, laid out like VS Code's, has a **User** and a **Machine** scope (only the settings a machine can differ in), search and a control per type; the Keyboard Shortcuts page turns rebinding into user rules (`rulesFor`).
- `keymap.ts` matches every keydown of the app, terminals included, against the effective bindings. A key no binding takes goes to the terminal's key encoder, as does the second press of a chord's first stroke (`ctrl+k ctrl+k` types `ctrl+k`); while a dialog is open only `dialog` and `always` bindings run.
- The desktop shell (`desktop/src/follow.ts`) follows both endpoints: its menu shows the commands' keys, and `appearance.theme`, `appearance.language` and `window.zoom` drive its native theme, menu language and zoom ([16](16-desktop-packaging.md)).
- The **Performance** page (`web/src/perf.ts`) shows what the app and the hub process (`GET /api/perf`) use below `performance.keptTerminals` ([26](26-web-terminals.md)), so the cost of that number is read where it is set.

### Appearance

`web/src/appearance.ts`.

- **Theme** `system`, `dark` or `light` sets `<html data-theme>`, the terminals' colors and `theme-color`, and is sent to the hub, which switches VS Code ([05](05-vscode-panes.md)). **Color theme** (`appearance.colorTheme`) is the chrome's accent, one of the design tokens' themes ([24](24-design-tokens.md)).
- **Terminal colors**: a scheme per theme (`web/src/terminal/schemes.ts`; Default is the tokens' palette) with the user's colors over it, for what programs leave to the terminal. Programs that query the colors (OSC 10/11/4, `CSI ?996n`) get the current theme's.
- **Fonts**: Latin and CJK families are set apart for the UI and the terminals. The bundled JetBrains Mono is the terminals' default; faces load without blocking the first render (`web/src/terminal/fonts.ts`) and terminals re-measure when they arrive.
- `appearance.uiFontSize` sets the root font size (the chrome is sized in `rem`); `window.zoom` scales the desktop app's window.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Settings kept per browser (`localStorage`) | Values differ per browser and profile; the desktop shell cannot read a page's storage. |
| JSON Schema for the definitions | Clients would need a validator plus sections, scopes and platforms; small typed records suffice. |
| A file watcher (`fs.watch`, chokidar) | Loses a file replaced by a rename; polling suffices for hand edits. |
| Clients working out the effective bindings | A second implementation of rules and conflicts. |
| Sending a chord's first stroke twice as its control character | Works only for `ctrl`+letter; passing the second press to the key encoder works for any stroke and mode. |
| Settings file overriding flags | Breaks service definitions and scripts that rely on their flags. |
| CSS `zoom` for the font size | Distorts mouse coordinates and canvas sharpness. |

## Failure modes

- **A file is not JSON** → the values read before stay, the problem is shown, changes are refused until it is fixed.
- **An invalid value or unknown key** → ignored and shown; rewrites keep it.
- **Saving fails** → the old value stays; the dialog shows the error.
- **A client was disconnected** → it reads both endpoints again on reconnect.
- **A page loaded before the hub was replaced** → after a reconnect it offers to reload (`web/src/update.ts`).

## Security

- The mutating routes are guarded like every mutation (Host/Origin, proxy secret, read-only mode), audited (`settings.set`, `settings.reset`, `keybindings.set`) and bounded in size ([SECURITY.md](../../SECURITY.md)).
- Values are typed and validated; strings refuse every control character, so a value carries no line breaks or escape sequences.
- `GET /api/perf` returns only amounts and counts of the hub's own process: no path, name or process id.

## Testing

- `backend/kernel/config/settings/settings.test.ts`, `jsonc.test.ts`, `routes.test.ts`: precedence, validation, broken files, the APIs, read-only, audit, pushes.
- `backend/kernel/config/keybindings/keybindings.test.ts` and `web/src/__tests__/keys.test.ts`: the shared vectors, defaults, user rules, conflicts.
- `backend/kernel/config/registry.test.ts` and `backend/hosts/bun/registry.test.ts` (the generated files are current); `web/src/__tests__/` `settings`, `settingsDialog`, `keysTable`, `theme`, `perf`; `desktop/src/follow.test.ts`.
