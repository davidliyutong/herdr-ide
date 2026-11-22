# 27 Plugins

## Context

Features keep arriving that are self-contained: a panel of their own, a kind
of pane, a few commands, routes in the core and work on machines. Wiring each
into the app shell, the status bar, the keymap, the core's route table and the
agent's dispatch by hand made every one touch the same files and left no way
to turn one off. Plugins give such features one shape on each side.

The right sidebar answers a design note of [05](05-vscode-panes.md): a panel
docked beside the panes covered terminals on narrow windows. Panels are now
small (lists, trees, forms); diffs, editors and graphs open as panes, which
take their share of the tab and cover nothing.

## Goals / non-goals

- One shape for features on each side: the core (`internal/plugin`), the
  agent (`internal/agent/plugin`) and the web UI (`web/src/plugins`).
- A switch per plugin, in Settings › Plugins.
- Existing features that fit move in: uploads and downloads, program windows.
- Non-goal: plugins loaded at runtime or written by third parties. Plugins
  are compiled into the binary and pass the same guards as any route; a
  loader for foreign code would need a trust boundary the core does not have.

## Design

### Core

A plugin (`plugin.Plugin`) has an id (lower-case letters and digits) and
routes. Its routes are mounted below `/api/p/<id>/` (the core's) or
`/api/m/{id}/p/<id>/` (a machine's: the handler gets the machine, an unknown
one is a 404). A route marked `Mutating` is wrapped by `writable` (refused
in read-only mode) and audited as `<plugin>[.<event>]` once its handler
returned (also when it panicked): with the values of the path's wildcards
(a variable's name), what the handler acted on (`Call.AuditField`: the
file explorer's paths, never contents) and how it ended (`status`, and for
a failure `error`, the code `plugin.WriteError` or `plugin.WriteJSON` gave,
`failed` when the handler answered nothing); a refused request is recorded
with its refusal;
`TestMutatingRoutesAreGuarded` walks the plugins' routes with the core's.
While a plugin is off, its routes answer `404 plugin_disabled`. A plugin that
works while the core runs (a scheduler) implements `Starter`. A plugin
that serves streams agents open towards the core with ops of its own
(`agentproto`, as the vault's `vault`) implements `Streamer`: the core hands
it each such stream while it is on and refuses the stream with
`plugin_disabled` while it is off. A plugin that keeps something about
machines (the vault's allowed machines) implements `MachineForgetter`: the
core calls it when the user removes a machine, whether the plugin is on or
off.

`plugin.Host` is the core as plugins see it: the machines, `Broadcast`
(a `/ws` message `plugin {plugin, m, data}` to every page), the audit log,
read-only mode, the settings and the logger. `plugin.Request` and
`plugin.Open` run an action of the plugin's machine side; an agent's failure
keeps its code, which `plugin.WriteError` passes to the UI (`offline` 409,
`transport` 502, `not_found` 404, other codes 400). Params and results of
any size up to 64 MiB pass: over 32 KiB they travel as a body after the
header or reply line instead of inside it (`params_length`,
`plugin_length`, [architecture](../architecture.md)), so a Git blob of
8 MiB, a large patch or status, or a first log page with every ref is not
cut by the line's 1 MiB bound. The stream `plugin.Open` returns is closed
when the caller's context ends, also after the reply (a save that sends
its text and waits for a second reply returns with its request); closing
the stream ends that watch.

The switches are settings: `plugins.<id>.enabled` (on by default unless
`registry.pluginsOff` names the plugin, as it names `vscode`), generated
by `plugin.Settings` into the section `plugins`; a plugin with a setting
of its own (`Toggled`) uses that. A plugin whose content runs on the UI's
own origin, where its scripts reach whatever the page reaches (VS Code's
windows), is a `BrowserRisk`: it gets a second switch,
`plugins.<id>.browser`, always off by default, for browsers, and
`plugins.<id>.enabled` is then the desktop app's. The core tells the two
kinds of clients apart (`plugin.Client`: the desktop app's requests carry
the token of its launch, [08](08-web-access-and-security.md)) and applies
the requesting client's switch (`plugin.EnabledFor`) to the plugin's
routes and to the core's own routes of a plugin (`withPlugin`);
`plugin.Enabled`, for what serves every client (agents' streams,
schedulers), is on while either is. `internal/registry` lists the core's
plugins (`Plugins`). A plugin's own settings are a settings module with a
section of its own whose `Plugin` field names the plugin
(`settings.Section{ID: "usage", Plugin: "usage"}`, served as `plugin` by
`/api/settings`): the UIs list that section under the plugins and say
when its plugin is off ([13](13-settings-and-appearance.md));
`TestPluginSectionsNameCorePlugins` checks that every such section names
a plugin of the core.

### Agent

The op `plugin` (`Header.Plugin`, `Header.Action`, `Header.Params`) runs the
handler a plugin's package registered with `plugin.Register`; the reply's
`Plugin` field carries its result (`plugin.Reply`), or the reply is followed
by JSON lines until either side closes the stream (`plugin.Stream`, as
`detect` does). Failures carry a code (`plugin.Errorf`). Handlers get the
agent's directories, its path expansion and the environment of processes it
starts (`plugin.Env`), and their params read in full (from the header, or
the body after it). An unknown plugin fails with `unknown_plugin`. A handler
that panics fails its action with `failed` (or, when it had answered, its
stream is closed), is logged, and the agent and the other actions go on;
goroutines a handler starts are its own to guard.

An action runs with the agent's context; the core giving up (its request
ended or timed out, the machine was left) closes the action's stream. An
action that reads nothing more from the stream after the header opts in
with `plugin.UntilClosed`, a context that ends when a one-byte read of the
stream returns, and stops then: the file explorer's copies and removals
(checked before each entry and each 1 MiB of a file), the AI usage
plugin's limits and cost scans, `plugin.Stream`, and code-server's download
on a machine. It is opt-in because an action that reads the stream (the
file explorer's save reads its text's chunks) cannot also wait on it. The
Git plugin's actions end their processes the same way.

### Web UI

A plugin (`PluginDef`, `web/src/plugins/api.ts`) contributes:

- **panels** of the right sidebar, each with a rail button and, optionally,
  a command that shows it;
- **pane views**: the layout's leaf `{view: {id, plugin, kind, …}}`, keyed
  `view:<id>`, drawn by the plugin's component for that kind; the fields
  besides `id`, `plugin` and `kind` are the plugin's
  (`L.setViewFields`, `actions.openView`, which reuses a pane of the kind
  the caller accepts, the one of the focused pane's tab first, else opens
  one in a tab of its own, as editors, diffs and graphs open, or split
  beside the focused pane, whose tab alone is then searched for one to
  reuse); a kind gives the pane's title, path and directory, whether it
  is a preview (its title in italics), a hook saying that what it shows
  is gone (`useGone`: its title struck through in its header and tab,
  with a note in their tooltips, as the file explorer's editors of
  deleted files are; `components/PluginPane.tsx` `ViewTitle` draws them)
  and the entries its header's and tab's menus start with (`menu`); a
  plugin's `useFileGone` says the same of any file of a machine, for the
  app's own panes that show one (previews, `components/PluginPane.tsx`
  `FileTitle`): the first plugin that is on with one answers (the file
  explorer), and with none on nothing is marked, so the app imports no
  plugin's module for it;
- **terminal surfaces** (`terminalSurfaces`: `{id, component, covers?}`):
  what it draws over a shown terminal's pane, in one layer for all
  plugins below the pane's header that takes none of the terminal's room
  (`registry.ts` `TerminalSurfaces`, each in its error boundary; kept
  panes draw none). A surface's id is its own among every plugin's
  (`definePlugins` refuses an empty or repeated one) and owns its covers.
  `covers(m, terminal, leaf)`, a pure function called as the pane is
  rendered, says what the surface covers of the terminal for that leaf
  (`all`, `part` or nothing), so a pane shown again is covered from its
  first frame; a mounted surface sets what changes otherwise with
  `useSetCover` (`state/covers.ts`, with its id). The strongest of them
  applies; a terminal covered all is not drawn and gives up the keyboard,
  and stays attached at its pane's size ([26](26-web-terminals.md)). A
  surface that takes the pane's focus registers a handle with
  `useSurfaceFocus` (`state/panes.ts`, in a layout effect, so it is
  registered before the terminal mounted in the same commit): focusing
  the pane (`withView`) focuses it, while typing and pasting into the pane
  (`paneHandle`, `withPane`) still reach the terminal;
- **header actions** (`headerActions`): buttons in a terminal pane's
  header before the pane's own (`TerminalHeaderActions` in
  `PaneHeader.tsx`), reached with the arrows like the header's own
  (`tabIndex` -1); a press leaves the keyboard where it is, and they hide
  with the pane's own buttons on panes without the focus and in narrow
  headers unless the plugin keeps one shown;
- **commands**: handlers of commands declared in
  `internal/keybindings/commands.go`, checked before the app's own;
- **status bar items**, **palette items** and a handler of its `/ws`
  messages;
- **a settings page** (`settings: {section, layout?, extra?}`): the
  section of its settings, which the Plugins page opens, a component that
  lays out the page's settings in place of their rows one after the other
  (`layout`, given the settings the scope shows and `rows`, which draws
  some of them as the dialog's rows: pages of its own within the page;
  it also gets `lead`, the plugin with its switch, to draw where its first
  page starts, and `visit`, which changes when the page is chosen in the
  dialog's list again, so that it shows its first page then;
  a search lists the rows it finds as on any page), and a component drawn
  at the end of that page (`extra`, given `readOnly`: actions that are no
  setting, such as an import and an export). A plugin that names a
  section without settings gets a page for its `extra` alone.

A plugin's messages are files of its directory
(`web/src/plugins/<id>/i18n/en.ts` and one per locale,
[12](12-internationalization.md)), so that changes to two plugins meet in
no file of messages.

`web/src/plugins/index.ts` lists the plugins in order. `registry.ts` filters
them by their setting: a plugin that is off loses its panels, commands,
items and messages; its panes keep their place and say the plugin is off.
A pane of a plugin this version does not have says so too, and the layout
keeps it as it is. A plugin whose setting machines can have of their own
(program windows' `gui.enabled`) is on while its value for every machine
(the User setting) or any machine's own value is on; its switch on the
Plugins page is the User setting and says so. A plugin with `browserRisk`
(the core's `BrowserRisk`) follows the switch of the kind of client the
core says the page is (`client` of `GET /api/settings`, a browser until it
answers): `enableSetting` is `plugins.<id>.browser` in a browser. Its
switch on the Plugins page is that one and says so, and turning the
browsers' switch on, wherever (the Plugins page, a pane's button, the
settings' rows), asks first (`setPluginSwitch`, `acceptRisk`): a dialog
with the plugin's texts, what its content can reach, and **Enable** only
once the box that the user understands the risk is ticked; turning it off,
and the desktop app's switch, ask nothing.

**Settings pages.** Settings › Plugins lists every plugin with its
switch; a plugin with a settings page has a settings button on its row
that opens the page. In the dialog's navigation the plugins' pages follow
the Plugins page, indented and in the plugins' order (in a machine's
scope, which has no Plugins page, under a heading of their own); the
plugin a section belongs to is the core's word for it (`Section.plugin`),
else the plugin naming it (`registry.ts` `pluginSection`,
`sectionPlugin`). A page starts with the plugin, its description and its
switch (`settings/PluginsPage.tsx` `PluginHeader`; in a machine's scope
without the switch, which is the User setting); while the plugin is off
the page says so, its entry in the navigation is dimmed, and its settings
stay editable, kept for when it is on. The page ends with the plugin's
`extra`. The settings search finds a plugin's settings as any others. The
AI usage plugin's page is its section `usage`, laid out as its own
settings and a list of its providers, each opening the provider's
settings ([29](29-ai-usage.md)).

**Building blocks.** Plugins' panels and panes draw with the app's shared
components rather than their own, so they look and behave alike
([24](24-design-tokens.md) has their styles):

- `components/Picker.tsx`: searchable dropdowns. `<Picker items value
  onChange multiple? create? onCreate? noneLabel? />` is a button showing
  the current value(s) that opens the list (where a `<select>` would be);
  `pick(anchor, {items, value?, create?, placeholder?, emptyText?,
  keepOrder?, label?})` opens it at an element or a point and resolves
  with the value chosen (`{create: query}` for the create row, undefined
  when dismissed), `pickMany(anchor, {items, value?})` with the values
  checked. Items (`PickerItem`) have a `value`, `label`, `description`,
  `detail`, `icon`, `group` (a header), `disabled` and `keywords`. The
  search uses the command palette's matcher (`lib/match.ts`) and marks the
  characters it matched; only the rows in view are drawn
  (`lib/windowed.ts`), so thousands of items stay fast. Keys: typing
  filters, ↑ ↓ PgUp PgDn Home End move, Enter chooses (with several:
  accepts), Space toggles with several once an arrow moved or while the
  query is empty (else it types a space), Escape closes and gives the
  focus back; a press outside closes. The list is placed below its anchor,
  above when there is more room there, within the window (as wide as it
  less 8 px gutters on a phone).
- `fileIcons.tsx`: `<FileIcon name kind open? link? />` and the lookup
  `fileIcon(name, kind, open?)` (`{id, icon, color}`): file-type icons as
  VS Code's icon themes give them, in the tokens' file icon hues.
- `components/tree`: `<TreeRow>` (indent guides, twisty, icon, label with
  the filter's match marked, description, a decoration's letter and color,
  actions shown while the row is pointed at or has the keyboard; the
  caller's attributes for clicks, drags and the windowed position);
  selection over the shown rows' ids (`selectOnly`, `selectToggle`,
  `selectRange`, `selectAll`, `clickSelection`) and the keys of a tree
  (`navigationKey`: ↑ ↓ PgUp PgDn Home End with Shift extending, ← → to
  collapse, expand, go to the parent and into a folder, ⌘/Ctrl+A,
  type-ahead with `TypeAhead`); `<Section id title count? actions?>`, a
  collapsible group whose state is kept per browser (`section.<id>`).
  The file explorer is built with them.
- `plugins/files/ops.ts`: what a list of a machine's files does with them,
  as the explorer does ([28](28-file-explorer.md)).
  `fileMenuEntries(m, paths, {isDir?, root?, el?, reveal?})` gives the
  menu entries for paths (a selection, the row pointed at first): Open
  (its files, several at once), Open to the Side, Open Preview (one file),
  Open in VS Code and Open in Terminal (one path), Copy Path, Copy
  Relative Path (to `root`, the explorer's by default), Download (a zip
  for folders and several; not for the desktop app's own machine) and
  Reveal in Explorer (one path; `reveal: false` leaves it out); nothing in
  them changes files, so read-only mode keeps them. `revealInExplorer(m,
  path)` shows the explorer's panel with the path's folders expanded and
  it selected; `openEditor`, `openFiles`, `openToSide`, `quickLook`,
  `openTerminal` and `copyText` are the entries' actions. The Git panel's
  rows use them.
- `lib/pluginApi.ts`: what the plugins' requests to the core share
  (`plugins/*/api.ts`). `PluginError` is a failure with the core's error
  code, of which each plugin has its own class (`FilesError`, `GitError`,
  `VaultError`, `BrowserError`), so `instanceof` tells whose it is;
  `answer(response, fail)` gives an answer's JSON or throws the failure
  `fail` makes of one that is not ok (`failureOf`: the body's `error` and
  `message`, else `http_<status>` and the status text); `jsonInit(method,
  body?, headers?)` is the fetch options of a JSON body; and
  `makeErrorText(Class, prefix, {special?, detail?, fallback?})` makes the
  function that says a failure by the message `<prefix>.<code>`. What a
  plugin does differently stays in its own module: a save's conflict (409)
  in the explorer's, what git said after Git's message, the vault's session
  header and its texts that never show a failure's own words.

What a plugin draws is inside an error boundary (`PluginBoundary`): a pane's
body, the panel shown and each status bar item. One that throws while
drawing shows what failed and **Try Again** (a status item: a small warning
button that tries again) in its place, and the rest of the page goes on;
another view in the pane or another panel draws afresh.

Only the selected tab's panes are mounted, and only the zoomed one while a
pane is zoomed, so a plugin's pane unmounts while it stays in the layout:
another tab, workspace or machine shown, another pane zoomed, its plugin
turned off. Panes that edit files keep their unsaved text then
(`unsaved.ts` `keepEdit`): the Monaco models, that the text is not saved
and the version of the file it was edited from stay in a store keyed by
machine and pane, the pane stays among the unsaved ones (closing it, its
tab or its workspace asks, and Save saves the text without the pane drawn;
leaving the page warns; closing the desktop app lists the files, each
with where it is, and shows the one picked, [16](16-desktop-packaging.md)),
and the pane takes them back when it is drawn
again. They are freed when the pane leaves its machine's layout (closed,
with its tab or workspace, also by another page) or the machine is removed,
once saved, or when the text is clean; a machine whose layout is not read
(away) keeps them. A pane closed with unsaved text (asked about first)
leaves the layout before its component unmounts: the layout no longer has
it, so nothing is kept for it. Each editor pane has a model of its own, so two panes of
one file keep their own text.

The right sidebar (`components/RightBar.tsx`) is a rail at the window's right
edge with a button per panel, and the panel shown beside it. On a wide window
the panel is a column of the app's grid, between the panes and the rail; on a
narrow one (≤ 760 px) it lies over the panes as the left sidebar does, and a
press beside it or Escape hides it. Its width and the panel shown are kept per
browser. **Toggle Right Sidebar** (`view.togglePanel`, ⌘⌥B in the desktop app
on macOS) shows the panel shown last or hides it.

A panel can also be a pane of the layout (`web/src/panelPanes.ts`): the
pane kind `panel` (`{view: {plugin, kind: 'panel', panel}}`, `PANEL_VIEW`),
which every plugin with panels has (`registry.ts` `paneView`), draws the
panel's component in a pane, where it splits, moves, takes a tab, is zoomed
and closes as any pane does, also with Undo Close. A panel becomes one by a
drag of its rail button or its title onto the panes: a pane's edge splits
it there (its middle, as there is nothing to swap, on its right), a tab
puts it beside that tab's focused pane, the rest of the tab bar (the
new-tab button, the empty part after it) or another workspace in the
sidebar gives it a tab of its own; its pane in the tab
shown moves there instead of a second one opening. **Open in Pane** in the
panel's header splits it beside the focused pane. Either way the sidebar
stops showing it; its rail button stays and still shows it there, so a
panel can be in the sidebar and a pane at once (both draw the same state).
**Move to Sidebar** in the pane's header and menu closes the pane and shows
the panel in the sidebar. What shows a panel for the user (Reveal in
Explorer, a usage notification) focuses its pane in the tab shown, else
shows it in the sidebar (`showPanel`). A pane whose panel this version
does not have says so. Read-only pages do not drag panels into panes.

### Plugins

| Plugin | Setting | What it adds |
| --- | --- | --- |
| `transfers` | always on | The uploads and downloads trays of the status bar ([06](06-quick-look-and-files.md)). |
| `gui` | `gui.enabled` (per machine; the Plugins page sets the User value) | The program windows' tray and palette items ([14](14-gui-windows.md)). |
| `vscode` | `plugins.vscode.enabled` (the desktop app), `plugins.vscode.browser` (browsers, after accepting the risk); both off by default | VS Code (code-server) in panes: the commands `code.open`, `code.diff`, `code.gitGraph`, the panes' buttons and menu items, the windows' layer ([05](05-vscode-panes.md)). Its routes are the core's own (`/api/m/{id}/code/*`, `/m/{id}/code/`, `/api/m/{id}/bridge`), which answer `plugin_disabled` to a client whose switch is off (`withPlugin`), stopping code-server excepted. Turning a switch off also closes that client's proxied connections, VS Code windows open in other browsers included, and, once both are off, ends a code-server preparation under way. Its settings page is code-server's section (`codeServer`, marked `Plugin: "vscode"`). |
| `files` | `plugins.files.enabled` | The file explorer's panel and its editor pane, with Monaco loaded on first use, and its settings page (section `files`) ([28](28-file-explorer.md)). |
| `vault` | `plugins.vault.enabled` | The variable vault: its panel, approval prompts and file dialogs, its settings page (section `vault`, ending with Import and Export), the op `vault` and the `mcp` command ([30](30-variable-vault.md)). |
| `usage` | `plugins.usage.enabled` | The AI usage panel, its status bar items (the accounts' tightest window, and the session of the agent in the focused pane), its settings page (section `usage`) and its scheduler in the core ([29](29-ai-usage.md)). |
| `git` | `plugins.git.enabled` | Source Control's panel, the graph and diff panes, the file explorer's decorations of changed files, and its settings page (section `git`) ([31](31-git.md)). |
| `monitor` | `plugins.monitor.enabled` | Live resource dashboard (⌘+hover on sidebar machines and an upward-floating status bar item), the Task Manager panel/pane with tree view and search, and its settings page (section `monitor`) ([34](34-system-monitor.md)). |
| `agents` | `plugins.agents.enabled` | Coding agents' conversations over their terminals' panes (a terminal surface), the switch in the header (a header action), the commands `agents.toggleView` and `agents.newTab`, the new-tab menu's agents, the routes that read transcripts and confirm sessions, and, while on, the sessions the machines resolve for the detected agents ([35](35-agent-native-view.md)). |
| `history` | `plugins.history.enabled` (and `history.capture`, off by default, per machine) | Snapshots of the terminals' output on each machine's disk, taken by a scheduler in the core, shown above the new shell of a terminal whose program was replaced; its settings page (section `history`, ending with what the machine keeps and **Clear Saved Output**) ([36](36-terminal-history.md)). |

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Plugins loaded at runtime (JavaScript bundles, a Go plugin loader, WebAssembly) | Foreign code in the page runs as the user's shell; a sandbox with a narrow API is a project of its own and every route would need a second review. |
| A dock beside the panes for large content | Covered the panes on narrow windows ([05](05-vscode-panes.md)); panes already split, move and close. |
| A generic exec op for plugins | Every plugin would build command lines in the core and the agent would run what it is sent; actions with their own arguments keep what runs on machines in the agent's code. |
| One switch for all plugins | Plugins differ in what they reach (credentials, networks); each is turned off on its own. |

## Failure modes

- A plugin's machine side on an older agent: agents come from the same build
  as the core, so this happens only during an upgrade; the action fails with
  `unknown_plugin` and the UI shows the error.
- A machine offline: actions fail with `offline` (409).
- A plugin turned off while its pane is open: the pane says so and keeps its
  place, and an editor's unsaved text is kept; turning it on draws it again.
- A plugin's handler that panics on a machine: its action fails with
  `failed`; the agent and other actions go on.
- A plugin's component that throws: its pane, panel or status item shows the
  error with Try Again; the page goes on.
- The core gives up on an action (request ended, timeout): its stream is
  closed and actions that opted in (`plugin.UntilClosed`) stop.

## Testing

- `internal/server/plugins_test.go`: patterns, unknown machines, the switch,
  default values, agents' streams of a plugin's op, audit records with the
  handler's fields and the outcome (`TestPluginChangesAuditTheirOutcome`),
  VS Code turned off ending its work (`TestVSCodeOffEndsItsWork`), a
  `BrowserRisk` plugin's two switches (`TestPluginSettingsDefaults`) and
  its routes and VS Code's following the requesting client's
  (`TestCodeRoutesFollowTheirClientsSwitch`);
  `TestMutatingRoutesAreGuarded` includes a fake plugin's routes.
- `internal/server/plugins_unix_test.go`: 2 MiB params and results through
  `plugin.Request` and an in-process agent, the stream of `plugin.Open`
  closed when the caller's context ends.
- `internal/agent/plugin/plugin_test.go`: replies, codes, large results as
  bodies, `UntilClosed`, streams that end when the core closes them.
- `internal/agent/plugins_test.go`: params as a body, panics that fail the
  action.
- `internal/agentproto/proto_test.go`: bodies after a line.
- `web/src/__tests__/plugins.test.ts`: switches (also one per machine), the
  rail and panels, commands, messages, panes of plugins that are off or
  unknown.
- `web/src/__tests__/surfaces.test.ts`: no layer while no plugin that is
  on has a surface, each plugin's surface and header buttons, a surface
  that fails, the strongest cover, covers said at render time and while
  mounted, owners; the pane's focus with a surface, also when both mount
  in one commit; `surfaceFocus.test.ts`: the keyboard of a terminal that
  becomes covered.
- `web/src/__tests__/panelPanes.test.ts`: a panel drawn in a pane and named
  after it, drops on a pane's edges and middle, a tab, the new-tab button,
  its pane moved instead of a second one, Open in Pane, Move to Sidebar,
  `showPanel`.
- `web/src/__tests__/vscodeRisk.test.ts`: the switch of the page's kind
  of client, the risk dialog before the browsers' switch turns on.
- `internal/registry/registry_test.go`: plugins' sections name plugins of
  the core (`TestPluginSectionsNameCorePlugins`).
- `web/src/__tests__/pluginSettings.test.ts`: plugins' pages under the
  Plugins page (and under a heading in a machine's scope), opened from a
  plugin's row, the page's switch and its note while the plugin is off,
  a page of an `extra` alone, the search finding a plugin's settings;
  `usageSettings.test.ts`: a page a plugin lays out itself (`layout`,
  the AI usage plugin's), its rows' controls, the way back from a page of
  its own (its button, and the page chosen in the list again), search and
  read-only mode.
- `web/src/__tests__/picker.test.ts`, `tree.test.ts`, `fileIcons.test.ts`:
  the building blocks.
- `web/src/__tests__/pluginFramework.test.ts`: error boundaries of panes,
  panels and status items, the Plugins page's per-machine switch, editors'
  font following the settings.
- `web/src/__tests__/keptEdits.test.ts`: an editor's and a diff's unsaved
  text kept while the pane is away (also in another tab), asked about,
  saved without the pane and freed when the layout loses the pane; nothing
  kept for an editor or a diff closed with unsaved text.
- `design/testdata/layout/plugin-views.json`: plugins' panes in the layout.
