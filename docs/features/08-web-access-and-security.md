# 08 · Web access and security

## Context

The IDE must be usable from other devices, not only the host it runs on.
Whoever can use it controls shells on every connected machine. Authentication
is left to a reverse proxy the user already operates (Tailscale, Caddy with
an identity provider, nginx with oauth2-proxy).

## Goals / non-goals

Goals: plain browser or PWA access; safe defaults when the proxy is missing
or misconfigured; protection against hostile web pages and other local users;
an audit trail.

Non-goals: built-in user accounts, TLS termination, per-user permissions.

## Design

**Delivery.** One binary serves the UI (embedded `web/dist`), the event
channel (`/ws`), the terminal protocol (`/api/v1/term`), the HTTP API and
the code-server proxy on `127.0.0.1:7780` by default (the desktop app's own
core on `127.0.0.1:7781`, [16](16-desktop-packaging.md)).

**Guardrails** (`internal/server/security.go`, `server.go`), in request order:

1. Security headers on every response (`nosniff`,
   `Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy`). Same-origin
   requests keep their Origin (under `no-referrer` a POST without CORS would
   carry `Origin: null`, which the Origin check refuses); other sites get no
   referrer.
2. **Proxy secret** (`--proxy-secret-file`): requests not from a same-host
   browser must carry `X-herdr-ide-Proxy-Secret` (constant-time compare). A
   same-host proxy is recognized by its non-loopback Host or
   `X-Forwarded-For`, so it cannot skip the secret.
3. **Host / Origin allowlist**: loopback plus `--allowed-origin`, against DNS
   rebinding and cross-site WebSocket hijacking.
4. **Read-only mode** (`--read-only`): terminals are shown but only
   observed: no input, size or focus reaches them, writing calls of the
   terminal protocol are refused and no terminal core is installed or
   started ([22](22-terminal-protocol.md)). Every mutating endpoint answers
   `403` (`writable` in `internal/server/server.go`): uploads, ssh
   authentication, bridge commands, VS Code, settings and keybindings,
   adding, renaming, removing, enabling and disabling machines, starting,
   stopping and restarting terminal cores, and enabling or closing program
   windows; retrying machines over `/ws` is refused too (`denied.retry`).
   Viewing and downloading files and cancelling one's own download stay
   allowed, and so does stopping code-server, which only releases it.
   `TestMutatingRoutesAreGuarded` walks the server's route table
   (`Server.routes`) and requires every route that can change something to
   refuse another site's Origin and to answer `403` in read-only mode, the
   stop of code-server excepted, so a route added without `writable`
   fails.
5. **Terminal protocol allowlist** (`termReadMethods`, `termWriteMethods`
   in `internal/server/term.go`): clients reach the terminal core's
   methods about terminals and documents only, never `machine.*`,
   `file.*`, `server.*` or a call with `on` (another machine of that core);
   refused calls are audited (`denied.term`); attaching is a message of its
   own ([22](22-terminal-protocol.md)).
6. **CSP** on the UI (`script-src 'self' 'wasm-unsafe-eval'` for the
   terminal emulator's WebAssembly, `frame-ancestors 'self'`, …), on every
   page the core serves, the app shell served for the UI's own routes
   included; an `/api/…` path no route takes is 404, not the shell.
7. **Audit log** (`--audit-log`): JSON lines for connections (`ws.*`,
   `term.*`), mutating calls (settings, keybindings, machines, terminal
   cores, terminals run and ended), uploads and downloads, VS Code and
   bridge use, program windows, ssh authentication and denials, with the
   user from `--user-header` or common proxy headers.

**Content on the UI's origin** (`internal/server/client.go`). VS Code's
windows are code-server proxied below `/m/{id}/code/`, on the UI's own
origin: any script in them (an extension, a webview, a page an extension
opens) can do what the page can, on every machine. VS Code is therefore
off by default, with two switches ([05](05-vscode-panes.md)):
`plugins.vscode.enabled` for the desktop app's windows and
`plugins.vscode.browser` for browsers, which the UI turns on only after
the user ticked that they understand this risk and pressed **Enable** (the
acceptance is the setting, kept in the settings file until turned off).
The core applies the switch of the requesting client to every route of
VS Code (code-server's status and start, the proxy with its WebSockets,
the bridge's commands) and sends VS Code's bridge messages only to pages
whose switch is on, so a browser never loads code-server while its switch
is off, whatever the desktop app's. A request is the desktop app's when
it carries the token of the app's launch (32 random bytes the app hands
its core on stdin and sets as an HttpOnly, SameSite=Strict, host-only
session cookie for the core's origin in its own Electron session, compared
in constant time, [16](16-desktop-packaging.md)); anything else is a
browser. `GET /api/settings` and `GET /api/config` tell the page which
switch applies (`client`), so the UI shows that one.

**Startup checks** (`cmd/herdr-ide`): a non-loopback `--listen` is refused
unless a proxy secret is configured or `--insecure-listen` is given; on
Linux and macOS the ssh control directory must be private (a core on
Windows keeps none and offers no ssh login,
[02](02-multi-machine-transport.md)).

**On machines**: nothing listens on TCP; sockets (the terminal core's
`hc.sock`, code-server's `cs.sock`, the bridge's `bridge.sock`) live in the
instance's 0700 run directory with 0600 modes, and the agent's `dial-unix`
reaches only sockets there ([02](02-multi-machine-transport.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Electron as the only delivery format | Would exclude access from other devices. The optional [desktop shell](16-desktop-packaging.md) wraps the same web core; browser delivery remains available. |
| Tauri desktop app | macOS WKWebView does not provide service workers to arbitrary origins; VS Code webviews (Git Graph, media preview) break. |
| Built-in password login | Duplicates what proxies do better (SSO, 2FA, device trust); authentication is delegated to the proxy by design. |
| Blocklist of dangerous terminal core methods | New methods would be exposed by default. |
| One VS Code switch for every client | A desktop user who turned VS Code on would find it on in any browser opening the same core and data, without having accepted there that its scripts run with the page's access. |
| Telling the desktop app by `desktopShell` or its user agent | Both are the page's own claims: any page, VS Code's scripts in a browser included, can make them. Only a secret the browser never sees tells the app's requests apart. |
| The desktop token in the core's environment | Programs the core starts (the local agent's terminals, code-server) would inherit it unless every path scrubbed it, and `/proc/<pid>/environ` keeps the original; stdin is inherited by nothing. |
| A header the desktop app adds to its requests (`webRequest`) | Every request of every window would pass through the main process, and service workers' and WebSockets' requests depend on Electron's proxying; a cookie of the session is sent by Chromium itself. |
| Serving code-server from an origin of its own | Would close the risk itself, but needs a second host name or port that every deployment's proxy, certificate and allowed origins would have to carry. |

## Failure modes

- **Missing `--allowed-origin`** → the proxy's requests get 403 "host not
  allowed" (fails closed).
- **Plain HTTP over a LAN address** → works for terminals, but VS Code
  webviews, clipboard and notifications are unavailable; HTTPS is required.
- **A core the desktop app did not start** (`herdr-ide serve` from a
  terminal or a service) → it has no desktop token, so every client is a
  browser and VS Code follows `plugins.vscode.browser`. A desktop app
  whose cookie could not be set reports a startup failure instead of
  showing a page that would count as a browser.

## Testing

- `internal/server/server_test.go`: Host/Origin guard (`TestGuard`), proxy
  secret: local, remote, wrong secret, same-host proxy
  (`TestProxySecret`), CSP and headers on the shell, a client-side route
  and an unknown API path (`TestCSPOnAppShell`), every mutating route
  refusing other origins and read-only mode (`TestMutatingRoutesAreGuarded`,
  `TestReadOnlyRetryKeepsTheSession`), refused port proxy paths
  (`TestCodeServerPortProxyRefused`).
- `internal/server/plugins_test.go`, `client_test.go`: VS Code's routes
  refusing a browser while only the desktop app's switch is on and the
  other way round, a wrong or cut token, a core without one and no cookie
  taken as a browser (`TestCodeRoutesFollowTheirClientsSwitch`), the
  client reported to the page (`TestClientReported`), the cookie kept from
  code-server (`TestDesktopCookieNotForwarded`), bridge messages only to
  pages whose switch is on (`TestBridgeMessagesFollowTheClientsSwitch`),
  each switch ending its client's connections
  (`TestVSCodeOffEndsItsWork`); `cmd/herdr-ide/parent_test.go`: the
  launcher's hello on stdin (`TestReadHello`).
- `internal/server/term_test.go`: the terminal protocol's allowlist and its
  audit (`TestTermProtocol`), read-only terminals (`TestTermReadOnly`,
  `TestTermWithoutCore`).
- `internal/server/settings_test.go` (`TestSettingsReadOnly`),
  `internal/server/machines_test.go` (read-only browsers refused, the
  terminal core's endpoints guarded: `TestHCEndpointsGuard`).
- `internal/transport/sys_unix_test.go`: control directory ownership and
  modes (`TestCheckPrivateDir`); `internal/transport/transport_test.go`:
  no control options without one (`TestSSHArgsWithoutControlDir`);
  `internal/server/machines_test.go`: no ssh login without one
  (`TestSSHLoginNeedsAControlDir`); `internal/agent/agent_test.go`: the private
  run directory and `dial-unix` restricted to it
  (`TestHelloAndPrivateRunDir`, `TestDialRestriction`).
