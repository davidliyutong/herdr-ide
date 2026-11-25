# 32. Browser pane and port forwards

## Context

A development server started on a machine listens on that machine's
`localhost`. Reaching it meant `ssh -L` beside the app or VS Code's port
view, and a `http://localhost:3000` link printed in a remote terminal
opened the user's own `localhost`, where nothing listens. VS Code's port
proxy is off on purpose ([05](05-vscode-panes.md)): it would serve the
machine's services on the UI's origin, where their scripts could type into
every terminal.

The agent already carries streams between the core and a machine, so a
forward needs nothing new on the machine.

## Goals / non-goals

Goals:

- A **browser pane**: a tab showing a web page, with address field, back,
  forward and reload.
- **Port forwards**: a machine's loopback port reachable on the core
  host's loopback, made when the user opens it and ended when unused.
- `localhost` links in terminals and documents open where they work; links
  to other computers open in the user's own browser.
- A menu of tab kinds at the tab bar's new-tab button.

Non-goals: forwards for clients not on the core's host (behind a reverse
proxy their `localhost` is another computer); forwarding to hosts other
than the machine's loopback; a full browser (bookmarks, history,
extensions, downloads); arbitrary sites in a browser client, where a frame
cannot show them.

## Design

### Forwards

`backend/features/browser` (core: `forwards.ts`),
`backend/features/browser/machine.ts` (machine).

- **Machine.** The action `dial {port}` connects the stream to the port on
  `127.0.0.1` (else `::1`) and copies both ways. Loopback only: the core
  reaches what a program of the machine could, not the machine's network.
  `listening` lists the user's listening TCP ports with program names
  (Linux `/proc/net/tcp*`, macOS `lsof`; at most 200).
- **Core.** `POST /api/m/{id}/p/browser/forwards {port}` listens on the
  core host's loopback and carries each connection over its own stream
  (at most 128 per forward, 32 forwards). It takes the same port number
  when free and above 1023, since some dev servers check the Host's port;
  otherwise a system-chosen port, which the pane shows.
- **Both loopback names.** A browser may try `127.0.0.1` or `::1` first
  for "localhost", so a forward takes its port on both
  (`backend/shared/host/loopback.ts`). If the `::1` side is held by
  another program the port is not used, since a browser could reach that
  program instead. Only a host without IPv6 loopback listens on
  `127.0.0.1` alone.
- **Lifetime.** A forward ends when stopped (`DELETE …/forwards/{port}`),
  its machine is removed, the core stops, the plugin is turned off, or it
  is unused for `browser.forwardIdle` minutes (30; 0 = until stopped). Use
  means an accepted connection, bytes carried, or a client asking for it
  again. An idle open connection is not use, so no program can hold a way
  into the machine open indefinitely. Temporary accept errors are retried
  with back-off; any other listener failure ends the forward and is
  logged.
- **Same host only.** Forwards serve clients on the core's own host
  (the request's `sameHost`: loopback peer and Host, no proxy); otherwise
  `403 forward_local_only` and the list says `available: false`. The
  local machine needs no forward.

### Origins

A forwarded service is another site than the UI and must stay one.

- Its own port gives it its own origin. The core's guard accepts a
  loopback `Origin` only when it is the request's own
  ([08](08-web-access-and-security.md)), so a forwarded page cannot open
  the UI's WebSockets or call its API.
- Cookies ignore ports, so a forward is never framed under the UI's host
  name: a UI on `127.0.0.1` (the desktop app) loads
  `http://localhost:<port>`, a UI on `localhost` loads
  `http://127.0.0.1:<port>` (`otherHost` in
  `web/src/plugins/browser/api.ts`); the same for the local machine's
  services.
- The page's CSP is built per request (`appCSP`): besides the UI it allows
  frames of the *other* loopback name only, so a framed page cannot
  navigate itself to the UI's host name on another port and share its
  cookies. A UI on any other host gets no foreign frames.
- The core's own address is never a page for a pane: it is refused when
  typed (`parseAddress`), as a link target (`web/src/lib/webUrl.ts`) and
  for desktop guests (`desktop/src/policy.ts`). In a remote machine's pane
  a port with the core's number is the machine's port, shown through a
  forward.

### The pane

`web/src/plugins/browser`. The view is `{plugin: browser, kind: page, url,
m?, port?}`; with `m` and `port` it shows that machine's port through a
forward. The layout holds it, so every client shows the tab; `m` must be
the layout's own machine.

- **A forward is made only after the user's own action in the page.** The
  layout is written by every client and any script of the page, and a page
  in a pane opens windows by itself, so a view naming a port is not a
  request for a way into the machine. The page keeps in memory only the
  ports the user asked for (`grantForward`): typed in the address field,
  chosen in **Ports**, a terminal link ⌘/Ctrl-clicked, or confirmed in the
  pane. For other ports the pane uses an existing forward or offers
  **Forward and open**. After a reload or in another client, panes attach
  to existing forwards and ask for the rest. Stopping a forward in Ports
  revokes the grant.
- **Frames** live in a layer of their own (`frames.ts`,
  `BrowserLayer.tsx`), placed over the pane and never moved in the DOM, so
  moving panes or switching tabs does not reload a page. Hidden frames
  stay 10 minutes, at most 4. A mounted frame re-uses its forward every
  5 minutes, which keeps it from going idle; if it ended anyway, it is
  remade only for a granted port.
- **Browser client**: a sandboxed `<iframe>` (no top navigation, no
  referrer), loopback addresses only; others open outside. The page cannot
  see navigation inside the frame, so back and forward step through
  addresses loaded from the toolbar.
- **Desktop app**: Electron's `<webview>` shows any `http(s)` page and
  reports navigation, so the address field, title and stored `url` follow
  the page. The shell vets each attach (`desktop/src/policy.ts`): main
  window only, partition `persist:browser` (own cookies and storage, no
  permissions but full screen), `http(s)` without credentials, guest
  preferences forced (no preload, no Node, sandboxed, context isolated).
  Navigation stays in the pane and never reaches the core's address. A
  window the page opens becomes a new browser tab (at most three per ten
  seconds, as Electron has no popup blocker) that grants no forward: an
  address on an existing forward's local port binds to that forward,
  anything else is this computer's.
- **Name resolution** (desktop): the app uses the system resolver
  (`configureHostResolver({enableBuiltInResolver: false})`) so names
  resolved via VPN or DNS tools work as in the system browser; Chromium's
  built-in resolver on macOS may not see them. Sessions use the system
  proxy. A failed load is shown under the toolbar; for an unresolved
  remote name it offers **Open in System Browser**, opening only on that
  click and only an address that passes `safeWebUrl`.
- **Toolbar**: back, forward, reload, address field (`3000` or
  `localhost:3000` is that port; loopback hosts default to `http://`,
  others `https://`), a chip naming a forward's machine and port,
  **Ports** (listening ports to open, forwards to stop) and open outside.
  Names below `localhost` on a remote machine are shown through the
  forward as `localhost`.
- Commands: `browser.open`, `browser.reload`.

### Links in terminals and documents

`web/src/terminal/openLink.ts`, `linkPlace` in
`web/src/plugins/browser/api.ts`. ⌘/Ctrl+click on a terminal URL and a
click on a web link in a preview pane follow `browser.openLinks`:

- `loopback` (default): loopback addresses (`localhost` and names below
  it, `127.0.0.1`, `[::1]`, `0.0.0.0`) open in a browser pane — a remote
  machine's through its forward, the local machine's directly. Other
  computers' addresses open in the user's browser, where their sign-ins,
  proxy and resolver are.
- `all`: also other addresses in a pane (desktop app only).
- `external`: everything outside.

Where a pane cannot show the address (plugin off, forwards unavailable,
UI on another host) the link opens outside. Only absolute `http(s)://`
URLs (and `mailto:`, outside) open, never the core's own address, and
without a referrer.

A terminal link's click is a request for its port, since its tooltip names
the address. A document's link is not: the document is anyone's text and
link text can hide the address (`[guide](http://localhost:2375/…)` would
expose the Docker API). It names its address in a tooltip, and the pane
uses an existing forward or asks with **Forward and open**.

### New-tab menu

`web/src/components/Workspace.tsx`. A click on the new-tab button opens a
terminal; ⌘/Ctrl+click, right click or the chevron opens a menu:
**Terminal**, then the enabled plugins' `PluginDef.newTabItems` (**VS
Code**, **Browser**).

### Routes and settings

`GET /api/p/browser/forwards`, `POST`/`DELETE`
`/api/m/{id}/p/browser/forwards[/{port}]` (mutating, audited as
`browser.forward` and `browser.forward_stop`),
`GET /api/m/{id}/p/browser/listening`. Settings:
`plugins.browser.enabled`, `browser.openLinks`, `browser.forwardIdle`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| code-server's port proxy, or a path under the UI's origin | The service's scripts would run with the UI's origin: terminals, files, the vault. |
| A rewriting HTTP proxy in the core | Absolute paths, WebSockets and dev servers' host checks break under a prefix; a forward carries bytes unchanged. |
| A host name per forward (`3000.m.localhost`) | Needs wildcard names and certificates behind every reverse proxy; Safari does not resolve names below `localhost`. |
| Forwards for clients behind a reverse proxy | Their `localhost` is another computer; a public port per forward is a listener the deployment does not know. |
| Framing under the UI's own loopback name | Cookies ignore ports: the UI's cookies would go to the service. |
| Listening on `127.0.0.1` only | "localhost" may resolve to `::1` first, where another program could answer. |
| A CSP allowing both loopback names | A framed page could navigate to the UI's host name on another port and share its cookies. |
| `<iframe>` in the desktop app | Cannot show sites that forbid framing or report navigation. |
| `WebContentsView` instead of `<webview>` | A native view lies over the page; menus, dialogs and tiling would have to move and hide it by hand. |
| Reusing VS Code's frame layer | It reaches into same-origin frames for focus and the bridge; only placement is shared. |
| Dialing any host from the machine | The machine would become a way into its network. |
| Making a forward whenever a pane is shown | Views are layout data any client or page script writes; `window.open('http://localhost:2375/')` would forward into the machine with no click. |
| Persisting granted ports (layout, storage) | Whatever the page can read back, a page script can write; existing forwards come from the core. |
| Counting an open connection as use | Any program holding one connection would keep a way into the machine open. |
| Granting the port on a document link click | One click on a disguised link would expose a machine service on the core host's loopback to every local program and web page. |
| Other computers' links in a pane by default | The user's browser holds their sign-ins, proxy and resolver; `all` keeps the option. |
| Popups of other computers in the system browser | Electron cannot tell whether a window came from a click; a page could open anything in the browser holding the user's sessions. |
| Chromium's built-in resolver | It may miss names the system resolves via VPNs and DNS tools. |

## Failure modes

- **Client not on the core's host**: no forwards (`forward_local_only`);
  links open outside.
- **Machine offline**: the forward's connections close; the pane shows
  `offline` with Retry.
- **Nothing listens on the port**: the connection closes; the frame shows
  the browser's error.
- **Port taken on the core host**: another local port, named in the chip.
- **Site forbids framing** (browser client): the frame stays empty; open
  outside is in the toolbar.
- **Forward ended** (idle, stopped elsewhere, core restart): a granted port
  is remade within 5 minutes; otherwise the page is unloaded and the pane
  asks. Stopped in this page's Ports: unloaded at once.
- **View names another machine than its layout's**: an error, no request.
- **Listener failure**: the forward ends and is logged.
- **Name does not resolve** (desktop): shown with **Open in System
  Browser**. A page can provoke this to have the button offered; it opens
  only on the user's click.
- **Local service on `::1` only** (Node 17+ on some systems): a UI on
  `localhost` frames `127.0.0.1`, where nothing answers. A remote
  service is reached on either address by `dial`.

## Security

A forward is a listener on the core host's loopback that leads into a
machine: while it exists any program or user of the core host can connect
to it, as with `ssh -L`. It is plain TCP on a guessable port without a
Host check, so any web page in the user's browsers can send it blind
requests. Hence a forward exists only after the user asked for it in this
page, and ends when unused.

The forwarded page is kept apart from the UI by its own origin, the
guard's Origin check, the other loopback name (the only one the UI's page
may frame) and, in the desktop app, a session of its own. The UI itself is
never a page of a pane ([SECURITY.md](../../SECURITY.md)).

## Testing

- `backend/features/browser/browser.test.ts` (a fake of the agent's
  `dial` that connects to this host's loopback): bytes over both loopback
  addresses, reuse, listing, stopping, refusals, idle expiry and what
  counts as use, connection and forward bounds, listener failures, port
  choice, the guards; `settings`: the links setting, its default and
  values it refuses.
- `backend/shared/host/loopback.test.ts`: the other address taken, held,
  absent.
- `backend/features/browser/machine.test.ts`: `dial` both ways and its
  refusals, listening ports.
- `backend/kernel/http/http.test.ts`: `Host and Origin` (other loopback
  origins refused), `frames` (frames by Host and client).
- `web/src/__tests__/browser*.test.ts(x)`: address parsing, the core's
  address refused, frame layer, forwards made only for granted ports,
  popups, links by machine, host, client and setting, document links
  (`browserDocLinks.test.tsx`), webview failures
  (`browserWebview.test.tsx`), the new-tab menu; `terminalLinks.test.ts`
  and `markdown.test.tsx` for the core's port refused.
- `desktop/src/policy.test.ts`: attaches, guest preferences, navigation,
  permissions, popup bound, resolver; `preload.test.ts`: the popup
  channel.
