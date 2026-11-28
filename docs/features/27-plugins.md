# 27 · Plugins

## Context

Many features are self-contained: a panel, a kind of pane, a few commands, routes in the hub and work on machines. Plugins give such features one shape on each side, so a feature touches no shared file and can be turned off. Panels of the right sidebar stay small (lists, trees, forms); diffs, editors and graphs open as panes.

## Goals / non-goals

- One shape on each side: hub (a feature, `backend/kernel/feature.ts`, one directory each in `backend/features`), machine side (the feature's `machine.ts`), web UI (`web/src/plugins`).
- A switch per plugin, in Settings › Plugins.
- Non-goal: plugins loaded at runtime or written by third parties. Plugins are compiled in and pass the same guards as any route; foreign code would need a trust boundary the hub does not have.

## Design

### Hub

A plugin is a feature (`defineFeature`): an id, a typed protocol of its machine-side actions (`protocol.ts`) and a `setup` that gets a `FeatureContext`, never the whole hub.

- Routes mount below `/api/p/<id>/`, `/api/m/{id}/p/<id>/` or a prefix of their own (`ctx.route`). `ctx.mutating(event)` refuses a route in read-only mode and audits it; each feature's tests walk its routes (`checkGuarded`, `backend/kernel/testing.ts`). A disabled plugin's routes answer `404 plugin_disabled`.
- `ctx.call` and `ctx.open` run a machine-side action, params and result checked by the protocol's schemas (`backend/kernel/agent.ts`); the agent's error codes reach the UI as `{error, message}`.
- Switches: `plugins.<id>.enabled`, on unless the feature is `defaultOff` (`vscode`). A feature with `toggle: false` has none: it is always on (terminals, transfers) or applies a setting of its own (program windows apply `gui.enabled` per machine).
- A plugin whose content runs on the UI's own origin, where its scripts reach what the page reaches (VS Code), has `browserRisk` and a second switch, `plugins.<id>.browser`, off by default; `enabled` then applies to the desktop app only. The hub applies the requesting client's switch (`ctx.enabledFor`; the desktop app is told apart by its launch token, [08](08-web-access-and-security.md)).

### Machine side

The agent's op `plugin` dispatches through `servePlugin` (`backend/machine/dispatch.ts`) to the feature's machine side, `defineMachine(protocol, start)` (`backend/machine/feature.ts`, registered in `backend/hosts/machine/features.ts`). Handlers are typed by the protocol and get directories, environment, hidden terminals of the terminal core ([21](21-terminal-core.md)) and a `signal`.

There is no generic exec: each action has its own arguments, so what runs on machines stays in the agent's code.

### Web UI

A plugin (`PluginDef`, `web/src/plugins/api.ts`) contributes sidebar panels, pane views (the layout leaf `{view: {id, plugin, kind, …}}`), header buttons, new-tab items, pane statuses counted as terminals' agents are ([07](07-agent-native-workflow.md)), commands (declared in `backend/kernel/config/keybindings/commands.ts`), status bar and palette items and a settings page. `workspaceCreated(m, ws)` tells it the user made a workspace (a new one, or one panes or tabs move into), so it can learn what its use there needs (the chat plugin asks which agents the machine can start, [37](37-agent-chats.md)). Its messages live in `web/src/plugins/<id>/i18n/` ([12](12-internationalization.md)), so two plugins' changes never meet in one file.

- `web/src/plugins/index.ts` lists the plugins and `registry.ts` filters them by their switch; turning a browser switch on asks the user to acknowledge the risk first. Heavy plugins register lazy stubs (`lazy.ts`): rail icons, settings and pane titles render at once, the module loads on first use.
- A disabled plugin loses its panels, commands and items; its panes keep their place and say it is off, as does a pane of an unknown plugin.
- Each pane body, the shown panel and each status item is inside an error boundary (`PluginBoundary`), so a throw shows the error and **Try Again** while the rest of the page goes on.
- Only the selected tab's panes are mounted, so an editor's unsaved text is kept by machine and pane while it is not drawn (`unsaved.ts`): closing still asks, and Save works.
- A panel dragged onto the panes, or **Open in Pane**, becomes a pane sharing the sidebar view's state (`web/src/panelPanes.ts`).

### Plugins

In the order of `web/src/plugins/index.ts`: `transfers` (always on, [06](06-quick-look-and-files.md)), `gui` (`gui.enabled`, per machine, [14](14-gui-windows.md)), `vscode` (both switches off by default, [05](05-vscode-panes.md)), `browser` ([32](32-browser-and-ports.md)), `files` ([28](28-file-explorer.md)), `search` ([41](41-project-search.md)), `git` ([31](31-git.md)), `monitor` ([34](34-system-monitor.md)), `usage` ([29](29-ai-usage.md)), `vault` ([30](30-variable-vault.md)), `agents` ([35](35-agent-native-view.md)), `chat` ([37](37-agent-chats.md)) and `history` ([36](36-terminal-history.md)).

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Plugins loaded at runtime (JS bundles, WebAssembly) | Foreign code in the page runs as the user's shell; a sandbox is a project of its own and every route would need a second review. |
| A dock beside the panes for large content | Covers the panes on narrow windows; panes already split, move and close. |
| A generic exec op for plugins | The agent would run whatever it is sent. |
| One switch for all plugins | Plugins reach different things (credentials, networks); each is turned off on its own. |

## Failure modes

- **An agent of an earlier release lacks the plugin** → `unknown_plugin`, shown in the UI.
- **Handler throws on a machine** → `failed` (or the `Fail`'s code); the agent goes on.
- **The hub gives up on an action** → its stream closes and the handler's `signal` aborts.

## Testing

- `backend/kernel/hub.test.ts` (switches reach only their routes, routes do not overlap, `browserRisk`, audit, read-only), `backend/features/vscode/hub.test.ts` (the per-client switch), `backend/kernel/agent.test.ts` and `backend/machine/agent.test.ts` (`the plugin op`), `backend/hosts/bun/registry.test.ts` (plugin sections).
- `web/src/__tests__/`: `plugins`, `pluginFramework`, `viewStatus`, `panelPanes`, `vscodeRisk`, `pluginSettings`, `keptEdits`, `chatPlugin` (`workspaceCreated`); `spec/vectors/layout/plugin-views.json`.
