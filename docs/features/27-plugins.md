# 27 Plugins

## Context

Many features are self-contained: a panel, a kind of pane, a few commands,
routes in the core and work on machines. Wiring each by hand into the app
shell, status bar, keymap, the core's routes and the agent's dispatch made
every feature touch the same files and left no way to turn one off.
Plugins give such features one shape on each side.

The right sidebar replaces a panel docked beside the panes, which covered
terminals on narrow windows ([05](05-vscode-panes.md)). Panels stay small
(lists, trees, forms); diffs, editors and graphs open as panes.

## Goals / non-goals

- One shape on each side: core (a feature, `backend/kernel/feature.ts`,
  one directory each in `backend/features`), agent
  (`internal/agent/plugin`), web UI (`web/src/plugins`).
- A switch per plugin, in Settings › Plugins.
- Non-goal: plugins loaded at runtime or written by third parties. Plugins
  are compiled in and pass the same guards as any route; foreign code
  would need a trust boundary the core does not have.

## Design

### Core

A plugin is a feature of the core (`defineFeature`,
`backend/kernel/feature.ts`): an id, a typed protocol of its machine-side
actions (`protocol.ts`) and a `setup` that gets a `FeatureContext`, never
the whole core. Its routes are mounted below `/api/p/<id>/` (core,
`ctx.api`), `/api/m/{id}/p/<id>/` (per machine, `ctx.machineApi`; unknown
machine → 404) or a prefix of its own (`ctx.route`, VS Code's).

- **Guards.** A route with `ctx.mutating(event)` is refused in read-only
  mode and audited as `<plugin>[.<event>]` after it answers, with what it
  acted on (`c.var.audit`; paths, never contents), the path's parameters
  and its outcome (`status`, and `error`, the code); `ctx.writable` only
  refuses. Each feature's tests walk its routes (`checkGuarded`,
  `backend/kernel/testing.ts`). A disabled plugin's routes answer `404
  plugin_disabled`. A GET route may upgrade to a WebSocket (the chat
  plugin's page connection) behind the same Host and Origin checks.
- **Services and streams.** `ctx.service` (background work such as a
  scheduler, ended by its signal), `ctx.agentStream` (streams agents open
  towards the core, e.g. the vault's; `plugin_disabled` while off),
  `ctx.onForget` (called when the user removes a machine, whether the
  plugin is on or off).
- **Context** (`FeatureContext`): machines (with `publishAgent`, a `/ws`
  agent message for a plugin's pane, the chat's), `broadcast` (a `/ws`
  message `plugin {plugin, m, data}`), the pages on `/ws`, audit log,
  read-only mode, settings, logger. `ctx.call` and `ctx.open` run a
  machine-side action, its params and result checked by the protocol's
  schemas (`backend/kernel/agent.ts`); agent error codes reach the UI as
  `{error, message}` (`offline` 409, `transport` 502, `not_found` 404,
  others 400). Params and results up to 64 MiB pass; above 32 KiB they
  travel as a body after the header line
  ([architecture](../architecture.md)). The stream `ctx.open` returns
  closes when the caller's signal ends.
- **Switches.** `plugins.<id>.enabled`, on by default unless the feature
  is `defaultOff` (as `vscode` is); a feature with its own setting
  (`toggle`, `gui.enabled`) uses that, and one that is always on
  (terminals, transfers) has none.
- **Browser risk.** A plugin whose content runs on the UI's own origin,
  where its scripts reach what the page reaches (VS Code), has
  `browserRisk`. It gets a second switch, `plugins.<id>.browser`, always
  off by default; `enabled` then applies to the desktop app only. The
  core tells the clients apart (the request's `client`: the desktop app's
  launch token, [08](08-web-access-and-security.md)) and applies the
  requesting client's switch to the plugin's routes (`enableSetting`,
  `ctx.enabledFor`). What serves every client (agents' streams, schedulers)
  runs while either is on.
- **Plugin settings.** A settings section with a `plugin` field
  (`{id: 'usage', order: …, plugin: 'usage'}`) is listed under its plugin
  ([13](13-settings-and-appearance.md));
  `backend/hosts/bun/registry.test.ts` (`plugin sections`) checks the
  names.

### Agent

The op `plugin` (`Header.Plugin`, `Action`, `Params`) runs the handler
registered with `plugin.Register`. It answers once (`plugin.Reply`) or
streams JSON lines after its reply until the core closes the stream
(`plugin.UntilClosed`). Failures carry a code
(`plugin.Errorf`); unknown plugin → `unknown_plugin`. A panicking handler
fails its action with `failed` and is logged; the agent goes on. Handlers
get the agent's directories and environment (`plugin.Env`), including
running helpers as hidden terminals of the terminal core (`RunHidden`,
`KillHidden`, [21](21-terminal-core.md)).

Actions run with the agent's context; when the core gives up, the action's
stream closes. An action that reads nothing more from the stream can opt
in to `plugin.UntilClosed`, a context that ends when the stream closes,
and stop (file copies and removals, usage scans, code-server downloads,
Git's processes). It is opt-in because an action that reads the stream
cannot also wait on it.

There is no generic exec: each action has its own arguments, so what runs
on machines stays in the agent's code.

### Web UI

A plugin (`PluginDef`, `web/src/plugins/api.ts`) contributes:

- **panels** of the right sidebar, each with a rail button;
- **pane views**: the layout leaf `{view: {id, plugin, kind, …}}`, drawn by
  the plugin's component for that kind. A kind gives the pane's title,
  path, preview flag, a `useGone` hook (title struck through when what it
  shows is deleted) and its menu entries. `actions.openView` reuses a pane
  of the kind where possible, else opens a tab or a split;
- **header actions** (`headerActions`): buttons in a terminal pane's
  header, inside the plugin's error boundary, that leave the keyboard
  where it is;
- **new-tab items** (`newTabItems(m)`): kinds of tab in the new-tab menu
  (a chat with each agent, [37](37-agent-chats.md));
- **pane statuses** (`viewStatus`): the agent status of the plugin's panes,
  which the app shows and counts as it does terminals' agents (dots,
  badge, attention list, sounds, notifications,
  [07](07-agent-native-workflow.md)), with `seen` when the user looked at
  a done pane;
- **commands** declared in `backend/kernel/config/keybindings/commands.ts`,
  checked before the app's own;
- **status bar items**, **palette items** and a `/ws` message handler;
- **a settings page** (`settings: {section, layout?, extra?, controls?}`):
  its section, an optional custom layout, an `extra` component for actions
  that are not settings (import/export), and `controls`, a control of the
  plugin's own for some settings in place of their type's (the AI usage
  plugin's form of prices, [29](29-ai-usage.md)).

A plugin's messages live in `web/src/plugins/<id>/i18n/`
([12](12-internationalization.md)), so two plugins' changes never meet in
one file.

`web/src/plugins/index.ts` lists the plugins; `registry.ts` filters them by
their switch. A disabled plugin loses its panels, commands, items and
messages; its panes keep their place and say it is off. A pane of an
unknown plugin says so and is kept in the layout. A plugin whose setting
machines can override (`gui.enabled`) is on if the User value or any
machine's value is on. A `browserRisk` plugin follows the switch for the
page's kind of client (`client` of `GET /api/settings`); turning the
browsers' switch on, wherever, opens a risk dialog whose **Enable** works
only once the user ticks that they understand (`setPluginSwitch`,
`acceptRisk`).

**Settings pages.** Settings › Plugins lists every plugin with its switch
and a button to its page. Plugins' pages follow the Plugins page in the
navigation; each starts with the plugin's description and switch, stays
editable while the plugin is off (dimmed, with a note), and ends with its
`extra`.

**Building blocks** shared so plugins look and behave alike (styles in
[24](24-design-tokens.md)):

- `components/Picker.tsx`: searchable dropdowns (`<Picker>`, `pick`,
  `pickMany`), using the command palette's matcher and a windowed list.
- `fileIcons.tsx`: VS Code-style file-type icons in the token hues.
- `components/tree`: `<TreeRow>`, selection helpers, tree key navigation
  with type-ahead, and collapsible `<Section>`.
- `plugins/files/ops.ts`: the menu entries and actions for a machine's
  files (open, open to the side, preview, VS Code, terminal, copy path,
  download, reveal in explorer), all read-only
  ([28](28-file-explorer.md)).
- `lib/pluginApi.ts`: request helpers and `PluginError`, subclassed per
  plugin so `instanceof` tells whose failure it is.

**Isolation.** Each pane body, the shown panel and each status item is
inside an error boundary (`PluginBoundary`): a throw shows the error and
**Try Again**, and the rest of the page goes on.

**Unsaved edits.** Only the selected tab's panes are mounted (only the
zoomed one while zoomed), so an editor pane can unmount while it stays in
the layout. Its unsaved text, dirty state and base version are kept in a
store by machine and pane (`unsaved.ts` `keepEdit`): closing it still
asks, Save works without the pane drawn, the desktop app lists them on
quit ([16](16-desktop-packaging.md)). They are freed when the pane leaves
the layout, the machine is removed, or the text is saved. Each editor
pane has its own model.

**Right sidebar** (`components/RightBar.tsx`). A rail of panel buttons at
the right edge and the shown panel beside it: a grid column on wide
windows, an overlay at ≤ 760 px (closed by a press beside it or Escape).
Width and shown panel are kept per browser. **Toggle Right Sidebar**
(`view.togglePanel`, ⌘⌥B in the macOS desktop app).

**Panels as panes** (`web/src/panelPanes.ts`). Every plugin with panels has
the pane kind `panel`, which draws a panel's component in a pane. Dragging
a rail button or a panel title onto the panes (an edge, a tab, the tab
bar, a workspace) or **Open in Pane** makes one; **Move to Sidebar**
returns it. The panel's pane and sidebar view share state. `showPanel`
focuses the pane if shown, else the sidebar. Read-only pages do not drag
panels into panes.

### Plugins

| Plugin | Setting | What it adds |
| --- | --- | --- |
| `transfers` | always on | Uploads and downloads trays ([06](06-quick-look-and-files.md)). |
| `gui` | `gui.enabled` (per machine) | Program windows' tray and palette items ([14](14-gui-windows.md)). |
| `vscode` | `plugins.vscode.enabled` (desktop app), `plugins.vscode.browser` (browsers, after accepting the risk); both off by default | VS Code panes and their commands ([05](05-vscode-panes.md)). Its routes are the core's own (`/api/m/{id}/code/*`, `/m/{id}/code/`, `/api/m/{id}/bridge`) and answer `plugin_disabled` to a client whose switch is off (stopping code-server excepted). Turning a switch off closes that client's proxied connections; once both are off, a code-server preparation under way ends. |
| `files` | `plugins.files.enabled` | File explorer panel and editor pane ([28](28-file-explorer.md)). |
| `vault` | `plugins.vault.enabled` | Variable vault panel, approvals, the op `vault` and the `mcp` command ([30](30-variable-vault.md)). |
| `usage` | `plugins.usage.enabled` | AI usage panel, status items (tightest window, the focused agent's session) and scheduler ([29](29-ai-usage.md)). |
| `git` | `plugins.git.enabled` | Source Control panel, graph and diff panes, explorer decorations ([31](31-git.md)). |
| `monitor` | `plugins.monitor.enabled` | Resource dashboard and Task Manager ([34](34-system-monitor.md)). |
| `search` | `plugins.search.enabled` | The Search panel: text in the files of a folder on the machine, opening at the match in VS Code or the file explorer's editor ([41](41-project-search.md)). |
| `agents` | `plugins.agents.enabled` | Sessions of detected coding agents, the route confirming one before a restore resumes it, and **Continue in Chat** on a terminal whose agent quit ([35](35-agent-native-view.md)). |
| `chat` | `plugins.chat.enabled` (and `chat.*`, per machine) | Chats run by each machine's chat host: chat pane, Chats panel, new-tab items, `chat.new`, the `chat.usage` status item, pane statuses, the core's WebSocket ([37](37-agent-chats.md)). |
| `history` | `plugins.history.enabled` (and `history.capture`, off by default, per machine) | Snapshots of terminals' output on each machine, shown above the new shell of a terminal whose program was replaced ([36](36-terminal-history.md)). |

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Plugins loaded at runtime (JS bundles, Go plugins, WebAssembly) | Foreign code in the page runs as the user's shell; a sandbox is a project of its own and every route would need a second review. |
| A dock beside the panes for large content | Covered the panes on narrow windows; panes already split, move and close. |
| A generic exec op for plugins | The agent would run whatever it is sent; per-action arguments keep what runs on machines in the agent's code. |
| One switch for all plugins | Plugins reach different things (credentials, networks); each is turned off on its own. |

## Failure modes

- **Older agent during an upgrade** → `unknown_plugin`, shown in the UI.
- **Machine offline** → `offline` (409).
- **Plugin turned off with its pane open** → the pane says so and keeps
  its place and unsaved text.
- **Handler panics on a machine** → `failed`; the agent goes on.
- **Component throws** → error with Try Again in its place.
- **Core gives up on an action** → its stream closes; `UntilClosed`
  actions stop.

## Testing

- `backend/kernel/core.test.ts`: routes and switches (`the switch of a
  feature reaches its routes only`, `routes of features do not overlap`,
  `browserRisk`, `enabledFor`), agents' streams (`dispatched by op`),
  audit outcomes and read-only (`mutating routes`);
  `backend/features/vscode/core.test.ts`: VS Code off ending its work, the
  per-client switch (`routes follow their client's switch`).
- `backend/kernel/agent.test.ts`: large params and results (`inline and
  as bodies`), the agent's codes (`agent errors`), `open` closing with
  the caller (`open and stream`).
- `internal/agent/plugin/plugin_test.go`, `internal/agent/plugins_test.go`,
  `internal/agentproto/proto_test.go`: replies, codes, bodies,
  `UntilClosed`, panics.
- `backend/hosts/bun/registry.test.ts`: `plugin sections`, the features'
  switches in their order.
- Web: `plugins.test.ts`, `viewStatus.test.tsx`, `notifyViews.test.ts`,
  `attention.test.tsx`, `headerActions.test.ts`, `panelPanes.test.ts`,
  `vscodeRisk.test.ts`,
  `pluginSettings.test.ts`, `usageSettings.test.ts`,
  `pluginFramework.test.ts`, `keptEdits.test.ts`, `picker.test.ts`,
  `tree.test.ts`, `fileIcons.test.ts`.
- `spec/vectors/layout/plugin-views.json`: plugin panes in the layout.
