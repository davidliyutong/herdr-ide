# 32. Browser pane and port forwards

## Context

A development server started on a machine listens on that machine's
`localhost`. To look at it the user ran `ssh -L` beside the app, or opened
VS Code for its port view; a link such as `http://localhost:3000` printed in
a terminal of a remote machine opened the browser at the user's own
`localhost`, where nothing listens. VS Code's port proxy is off on purpose
([05](05-vscode-panes.md)): it would serve the machine's services with the
UI's origin, where their scripts could type into every terminal.

The agent already carries streams between the core and a machine; a
forward needs nothing more on the machine.

## Goals / non-goals

- A **browser pane**: a tab of the UI that shows a web page, with an
  address field, back, forward and reload.
- **Port forwards**: a port of a machine's loopback interface reachable on
  the core host's, made when the user opens a page of it and ended when
  unused.
- A link printed in a terminal opens where it works: a remote machine's
  `localhost` through a forward.
- A menu of the kinds of tab at the tab bar's new-tab button.

Non-goals: forwards for clients that are not on the core's host (a page
reached through a reverse proxy: its `localhost` is another computer);
forwarding to hosts other than the machine's own loopback; a full browser
(bookmarks, history, extensions, downloads management); browsing arbitrary
sites in a browser client, where a frame cannot show them.

## Design

### Forwards (`internal/plugins/browser`, `internal/agent/plugin/browser`)

- The agent's action `dial {port}` connects the stream to the port on the
  machine's `127.0.0.1` (else `::1`), answers, and copies both ways until
  either side ends. It dials loopback only: the core reaches what a program
  of the machine could, not the machine's network. `listening` lists the
  TCP ports the user's programs listen on, on loopback or every address
  (Linux: `/proc/net/tcp` and `tcp6` for the user's sockets, the programs'
  names from the sockets among the user's processes' descriptors; macOS:
  `lsof`; at most 200).
- The core makes a forward with `POST /api/m/{id}/p/browser/forwards
  {port}`: it listens on the core host's loopback and carries each
  connection through `plugin.Open(…, "dial")`, one stream per connection
  (at most 128 at a time). It listens on the port asked for when that is
  free and above 1023, so the page's address is the one the service
  expects, else on one the system picks, which the pane says, since some
  development servers refuse a Host of another port.
- "localhost" names `127.0.0.1` and `::1`, and a browser tries either
  first, so a forward takes its port on both (`internal/loopback`). A port
  whose `::1` side another program holds, or that cannot be taken for any
  other reason, is not used: a browser could reach another program in the
  forward's stead. Only a host without IPv6 loopback (the system says it
  has no such address or family) listens on `127.0.0.1` alone.
- A forward is found again by its machine and port, listed
  (`GET /api/p/browser/forwards`), and ends when it is stopped
  (`DELETE …/forwards/{port}`), its machine is removed, the core stops, the
  plugin is turned off, or it was unused for `browser.forwardIdle` minutes
  (30; 0: until stopped); its connections end with it. At most 32.
- A use of a forward is a connection accepted, bytes carried in either
  direction (noted at most once a second) or a client asking for it again.
  A connection that only stays open is none: a forward whose connections
  carried nothing for the idle time ends with them, so a program that holds
  a connection open does not keep a way into the machine.
- A listener that fails to accept for now (no descriptors left, a
  connection gone before it was taken, a deadline) tries again after a
  pause that doubles from 5 ms to 1 s; any other failure ends the forward,
  which leaves the list with its listeners and connections, and is logged.
- Forwards are for clients on the core's own host (`plugin.Call.SameHost`:
  a loopback peer and Host, no proxy in between; `403 forward_local_only`
  otherwise, and the list says `available: false`), and for other machines
  than the local one, whose ports need none.

### Origins

A forwarded service is another site than the UI and must stay one.

- It is served on a port of its own, hence an origin of its own. The
  core's guard takes an `Origin` on loopback only when it is the request's
  own ([08](08-web-access-and-security.md)), so a forwarded page's scripts
  cannot open the UI's WebSockets or call its API.
- Cookies ignore ports, so the frame never loads a forward under the UI's
  host name: a UI on `127.0.0.1` (the desktop app) loads
  `http://localhost:<port>`, a UI on `localhost` loads
  `http://127.0.0.1:<port>` (`otherHost` in
  `web/src/plugins/browser/api.ts`). The same holds for a service of the
  local machine, loaded without a forward.
- The page's policy is made for each request (`appCSP`): beside the UI
  itself it allows frames of the other loopback name only, on any port,
  `http://127.0.0.1:*` for a UI on `localhost` and `http://localhost:*` for
  one on `127.0.0.1`. A framed page that navigates itself to the UI's own
  host name on another port, where it would share that host's cookies, is
  blocked. A UI on any other host (a reverse proxy's name, `[::1]`) gets
  the UI's own frames alone, as does the desktop app, whose panes are
  webviews that this policy does not govern.
- The core's own address is no page for a pane: an address on the UI's
  origin, or, for a UI on a loopback host, on any loopback host with the
  UI's port (the core answers under each), is refused where it is typed
  (`parseAddress`, with a message that says it is the app's own address), where a text links to it (`web/src/lib/webUrl.ts`) and
  where a guest of the desktop app goes or attaches
  (`desktop/src/policy.ts`). In a pane of a remote machine a loopback
  address is that machine's own, so a port of the core's number is taken
  there as the machine's port and shown through its forward, whose local
  port is another one; a link to it in a terminal is not opened, since a
  text's links pass the rule for this computer.

### The pane (`web/src/plugins/browser`)

- A plugin pane (`view: {plugin: browser, kind: page, url, m?, port?}`):
  `url` is the address as the user means it (`http://localhost:3000/docs`);
  with `m` and `port` it is that machine's port, shown through a forward.
  The layout holds it, so every client shows the tab; each client makes its
  own frame. `m` is the machine of the layout the view is in, or the pane
  shows an error and asks the core for nothing.
- **A forward is made only after the user's own action in the page.** The
  layout is written by every client and by every script of the page, and a
  page shown in a pane opens windows by itself, so a view with `m` and
  `port` is not the user asking for a way into that machine. The page
  keeps, while it lives and nowhere else, the ports the user asked for in
  it (`grantForward`): typed into a pane's address field, chosen in
  **Ports**, opened from a link clicked in a terminal, or confirmed in a
  pane; stopping a forward in **Ports** takes its port back
  (`revokeForward`). For such a port the pane makes or finds the forward. For any other
  it reads the core's list: a forward that exists is used; one that does
  not is not made, and the pane says that the port is not forwarded now,
  with **Forward and open**. A page that was reloaded, or another client
  showing the same tab, therefore attaches to the forwards there are and
  asks for the others.
- Frames live in a layer of their own (`frames.ts`, `BrowserLayer.tsx`), as
  VS Code's do ([05](05-vscode-panes.md)): an element per view on screen,
  placed over its pane and never moved in the document, so moving a pane or
  switching tabs, workspaces or machines does not reload a page. A frame
  off screen stays 10 minutes, at most 4 of them; a view that left its
  layout loses its frame. The frames are other origins: the page never
  reaches into them.
- In a browser the frame is an `<iframe>` with `sandbox` (scripts, its own
  origin, forms, popups, modals, downloads; no navigation of the UI's
  window) and no referrer. Only loopback addresses can be framed; another
  address opens outside, and the pane says so. The page cannot see where
  the user went inside a frame: back and forward step through the
  addresses loaded from the toolbar, and the address field shows the last
  of them.
- In the desktop app the frame is Electron's `<webview>`
  (`desktopShell.browser`), which shows any `http` or `https` page and
  reports its navigation: the address field, back and forward follow the
  page, the tab takes the page's title, and the view's `url` follows, so a
  restart comes back to it. The shell decides each attach
  (`desktop/src/policy.ts`): only the main window's page, only the
  partition `persist:browser`, only `http(s)` addresses without
  credentials, with the guest's preferences rewritten whatever the page
  asked (no preload, no Node, sandboxed, context isolated). The partition
  has its own cookies and storage (the desktop cookie that marks the app's
  requests is the default session's alone) and grants no permission but
  full screen. A guest's navigation stays in the pane (`http(s)` only,
  never the core's address), and a window it opens becomes a new browser
  tab: three within ten seconds for one page, since scripts open windows
  without the user and Electron has no popup blocker. That tab leads into
  no machine by itself (`openPopup`): an address on the local port of a
  forward that exists is that forward's machine and port, bound to it
  without the right to make it again; any other address is its own, a
  loopback one the user's own computer's, whatever machine is shown.
- The toolbar: back, forward, reload, the address field (a bare `3000` or
  `localhost:3000` is that port; a host without a scheme gets `http://` on
  loopback and `https://` otherwise), a chip naming the machine and port of
  a forwarded page, **Ports** (the machine's listening ports to open, the
  forwards with a stop button) and open outside. An empty pane shows a
  start page with the machine's listening ports.
- A frame with `m` and `port` has its forward before it loads and uses it
  again every 5 minutes while it is mounted, which keeps the forward from
  ending idle; a failure shows its reason with Retry. When the forward
  ended all the same, that timer makes it again only for a port the user
  asked for in this page; otherwise the page is taken off the frame and
  the pane asks.
- Commands: `browser.open` (a new tab with an empty browser pane),
  `browser.reload`.

### Links in terminals (`web/src/terminal/links.ts`)

⌘/Ctrl+click on a URL opens it, by `browser.openLinks` (**pane**, the
default, or **external**):

- a loopback URL in a terminal of a remote machine opens in a new tab as a
  browser pane of that machine's port, when forwards are available to this
  client;
- a loopback URL in a terminal of the local machine opens in a new tab when
  the UI itself is on a loopback host;
- any other URL opens in a new tab in the desktop app, and outside in a
  browser;
- with **external**, with the plugin off, and where the above does not
  apply, the URL opens outside as before.

A URL is opened only when it is absolute `http(s)://` (or `mailto:`), as
the browser resolves it, and not the core's own address (see Origins). The
click is the user asking for the port it leads to.

### The new-tab menu (`web/src/components/Workspace.tsx`)

A click on the tab bar's new-tab button makes a terminal. ⌘/Ctrl+click, a
right click and the chevron beside it open a menu of the kinds of tab:
**Terminal**, then what the plugins that are on contribute
(`PluginDef.newTabItems`): **VS Code**, **Browser**.

### Routes and settings

`GET /api/p/browser/forwards`, `POST` and `DELETE`
`/api/m/{id}/p/browser/forwards[/{port}]` (writes, audited as
`browser.forward` and `browser.forward_stop` with the ports),
`GET /api/m/{id}/p/browser/listening`. Settings: `plugins.browser.enabled`,
`browser.openLinks`, `browser.forwardIdle`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| code-server's port proxy, or a path below the UI's origin | The service's scripts would run with the UI's origin: terminals, files, the vault ([05](05-vscode-panes.md)). |
| An HTTP proxy in the core that rewrites the service's pages | Absolute paths, WebSockets and development servers' host checks break under a prefix; a forward carries bytes and the page is the one the service serves. |
| A host name per forward (`3000.m.localhost`) on the core's port | Needs a wildcard name and certificate behind every reverse proxy, and Safari does not resolve names below `localhost`. |
| Forwards for clients behind a reverse proxy | Their `localhost` is another computer; a public port per forward would be a listener the deployment does not know. |
| The same loopback name as the UI | Cookies ignore ports: the UI's cookies (the desktop app's token, a proxy's session) would go to the service. |
| Listening on `127.0.0.1` only | "localhost" may lead to `::1` first, where another program on that port would answer in the forward's stead. |
| An `<iframe>` in the desktop app too | A frame cannot show sites that forbid framing, nor tell the page where the user navigated. |
| `WebContentsView` instead of `<webview>` | A native view lies over the page: menus, dialogs and the tiling layout would have to move it and hide it by hand. |
| Generalizing VS Code's frame layer | It reaches into its frames (same origin) for focus and the bridge; a layer for foreign frames shares the placement and nothing else. |
| Dialing any host from the machine | The machine would become a way into its network for whoever can call the core. |
| A pane makes its forward whenever it is shown | A view is data of the layout, which any client and any script of the page writes, and a page in a pane opens windows by itself: `window.open('http://localhost:2375/')` in the desktop app made a forward into the machine shown and loaded it, with no click. |
| Remembering what the user asked for across reloads (in the layout, in storage) | Whatever the page can read back, a script of the page can write; the list of forwards that exist is the core's, and a pane attaches to those without asking. |
| The same policy for every request (`frame-src` with both loopback names) | A framed page could navigate itself to the UI's own host name on another port and share that host's cookies there. |
| Counting an open connection as use | One connection held open by any program of the core host, or by a page, would keep a way into the machine for as long as it liked. |

## Failure modes

- **A client not on the core's host** → no forwards (`forward_local_only`);
  the pane says so, links open outside.
- **The machine is offline** → the forward's connections close; the pane
  shows `offline` with Retry.
- **Nothing listens on the port** → the connection is closed at once; the
  frame shows the browser's own error.
- **The port is taken on the core host** → another local port, named in
  the pane's chip.
- **A site forbids framing** (a browser client) → the frame stays empty;
  open outside is in the toolbar.
- **A forward ended** while its tab stayed open → idle, or stopped by
  another client: within 5 minutes the mounted frame makes it again when
  the user asked for the port in this page; never asked for here: its
  page is taken off then and the pane asks (**Forward and open**). Stopped
  in this page's **Ports**: the pages it carried are taken off at once
  (`unloadForward`) and their panes ask.
- **Core restart** → forwards are gone; the same holds.
- **The page was reloaded, the app restarted, or another client shows the
  tab** → the pane uses the forward if it still exists, else asks.
- **A view names another machine than its layout's** → an error in the
  pane, no request; a new address typed there is the layout's machine's.
- **A remote machine's port has the number of the core's own** → typed
  into a pane of that machine (or chosen in its Ports) it is the machine's
  port, through a forward on another local port; a ⌘/Ctrl-click on such a
  link in a terminal opens nothing. On the core's own computer the number
  is the core, refused, and left out of Ports.
- **A forward's listener fails** (not for now only) → the forward ends and
  is logged; its pane makes it again or asks, as above.

## Security

A forward is a listener on the core host's loopback that leads into a
machine: any program and user of the core host can connect to it while it
exists, as with `ssh -L`, and what answers is the machine's service. It is
plain TCP on a port that can be guessed, without a Host check, so a web
page in any of the user's browsers can send it requests it cannot read the
answers of. Hence a forward exists only after the user asked for it and
ends when it is not used. The forwarded page is kept apart from the UI by
its origin, by the guard, by the other loopback name, which is the only
one the UI's page may frame, and, in the desktop app, by a session of its
own; the UI itself is never a page of a pane
([SECURITY.md](../../SECURITY.md)).

## Testing

- `internal/plugins/browser/browser_test.go` (a real agent in the test's
  process): bytes through a forward on both loopback addresses, the same
  forward found again, the list and its `available`, stopping with open
  connections; refusals (a client elsewhere, the local machine, bad ports),
  a port without a service; idle forwards ending, a removed machine's
  forwards, the bound; what counts as use (asking again, a connection
  accepted, bytes carried, noted once a second) and a forward ending with
  a silent connection open, the setting's time, 0 and the plugin off; the
  bound on a forward's connections; a listener that fails for now tried
  again with a pause, one that fails for good ending its forward alone,
  with a log line; the port asked for when free, another when it is taken
  on either loopback address, never a system port; the machine's listening
  ports.
- `internal/loopback`: the other address taken, held by another program,
  absent from the host, and not taken for any other reason.
- `internal/agent/plugin/browser`: `dial` to a service on either loopback
  address with bytes both ways, ending with the service, the core or the
  agent, and its refusals (no service, no port, an unknown action); the
  list's order and bound; on Linux the kernel's tables read
  (`listening_linux_test.go`).
- `internal/server/server_test.go`: other loopback origins refused
  (`TestGuard`), the frames the page's policy allows by the request's Host
  and client (`TestCSPOnAppShell`).
- `web/src/__tests__/browser*.test.ts(x)`: the address rule and what is
  typed, the core's own address refused under every loopback name; frames
  kept, hidden and dropped and not recreated when a pane moves; the pane
  (the forward before the load, the frame's address on either UI host,
  failures, Ports); a view found in the layout (no forward made and the
  question, the forward that exists used, another machine's view without a
  request, the list failing, a client that can use none, the keep-alive
  not bringing a forward back), the address field and Ports granting;
  popups (a loopback address as this computer's, a forward's local port
  bound to that forward, nothing for other schemes); links by machine, UI
  host, client and setting, and the click granting; the new-tab menu.
  `terminalLinks.test.ts` and `markdown.test.tsx`: links to the core's
  port under another loopback name refused.
- `desktop/src/policy.test.ts`: which attaches are allowed and the
  guest's preferences after one, navigation, the core's address refused to
  guests under every loopback name, permissions, the popups' bound, the
  main window alone holding webviews; `preload.test.ts`: the popup
  channel.
