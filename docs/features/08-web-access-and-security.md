# 08 · Web access and security

## Context

The IDE must be usable from other devices, not only the host it runs on.
Whoever can use it controls shells on every connected machine.
Authentication is left to a reverse proxy the user already operates
(Tailscale, Caddy with an identity provider, nginx with oauth2-proxy).

## Goals / non-goals

Goals: plain browser or PWA access; safe defaults when the proxy is missing
or misconfigured; protection against hostile web pages and other local
users; an audit trail.

Non-goals: built-in user accounts, TLS termination, per-user permissions.

## Design

### Delivery

One binary serves the UI (embedded `web/dist`), the event channel (`/ws`),
the terminal protocol (`/api/v1/term`), the HTTP API and the code-server
proxy. It listens on `127.0.0.1:7780` by default; the desktop app's own core
on `127.0.0.1:7781` ([16](16-desktop-packaging.md)). Flags are in
[reference.md](../reference.md); the threat model is in
[SECURITY.md](../../SECURITY.md).

### Guardrails

`internal/server/security.go`, `server.go`, in request order:

1. **Security headers** on every response: `nosniff`,
   `Referrer-Policy: same-origin` (so same-origin POSTs keep their Origin),
   `Cross-Origin-Opener-Policy`.
2. **Proxy secret** (`--proxy-secret-file`): requests not from a same-host
   browser must carry `X-veldr-Proxy-Secret`, compared in constant time.
   A same-host proxy is recognized by a non-loopback Host or
   `X-Forwarded-For`, so it cannot skip the secret.
3. **Host / Origin checks**. The Host must be loopback or an
   `--allowed-origin`'s (against DNS rebinding). The Origin must be an
   `--allowed-origin` or, on loopback, the request's own host and port
   (against cross-site WebSocket hijacking). A page on another loopback port
   is another site: the core has no login to stop its scripts.
4. **Read-only mode** (`--read-only`): terminals are observed only (no input,
   size or focus), writing terminal-protocol calls are refused and no
   terminal core is installed or started ([22](22-terminal-protocol.md)).
   Every mutating endpoint answers `403` (`writable` in
   `internal/server/server.go`). Viewing and downloading files, cancelling
   one's own download, and stopping code-server (which only releases it)
   stay allowed. `TestMutatingRoutesAreGuarded` walks the route table, so a
   mutating route added without `writable` fails the tests.
5. **Terminal protocol allowlist** (`termReadMethods`, `termWriteMethods` in
   `internal/server/term.go`): only methods about terminals and documents,
   never `machine.*`, `file.*`, `server.*` or a call with `on`. Refusals are
   audited (`denied.term`). An allowlist means new core methods are closed
   by default.
6. **CSP** on every page the core serves, including the app shell for
   client-side routes: `script-src 'self' 'wasm-unsafe-eval'` (for the
   terminal emulator's WebAssembly), `frame-ancestors 'self'`, …. An unknown
   `/api/…` path is a 404, not the shell.
7. **Audit log** (`--audit-log`): JSON lines for connections, mutating
   calls, uploads and downloads, VS Code and bridge use, program windows,
   ssh authentication and denials, with the user from `--user-header` or
   common proxy headers.

### VS Code on the UI's origin

`internal/server/client.go`. code-server is proxied below `/m/{id}/code/`
on the UI's own origin, so any script in it (an extension, a webview) can do
what the page can, on every machine. VS Code is therefore off by default,
with one switch per kind of client ([05](05-vscode-panes.md)):

- `plugins.vscode.enabled` for the desktop app's windows;
- `plugins.vscode.browser` for browsers, turned on only after the user
  ticks that they understand the risk.

The core applies the requesting client's switch to every VS Code route (status,
start, proxy, WebSockets, bridge commands) and sends bridge messages only to
pages whose switch is on.

A request is the desktop app's only when it carries the token of the app's
launch: 32 random bytes the app hands its core on stdin and sets as an
HttpOnly, SameSite=Strict, host-only cookie in its own Electron session,
compared in constant time ([16](16-desktop-packaging.md)). Anything else is
a browser. `GET /api/settings` and `GET /api/config` report which switch
applies (`client`).

### Startup checks

`cmd/veldr`:

- A non-loopback `--listen` is refused unless a proxy secret is configured
  or `--insecure-listen` is given.
- On Linux and macOS the ssh control directory must be private. A core on
  Windows keeps none and offers no ssh login
  ([02](02-multi-machine-transport.md)).

### On machines

Nothing listens on TCP. Sockets (`hc.sock`, `cs.sock`, `bridge.sock`) live
in the instance's 0700 run directory with 0600 modes, and the agent's
`dial-unix` reaches only sockets there ([02](02-multi-machine-transport.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Electron as the only delivery | Excludes other devices; the [desktop shell](16-desktop-packaging.md) wraps the same core. |
| Tauri desktop app | macOS WKWebView lacks service workers for arbitrary origins; VS Code webviews break. |
| Built-in password login | Proxies do it better (SSO, 2FA, device trust). |
| Blocklist of terminal core methods | New methods would be exposed by default. |
| One VS Code switch for every client | A desktop opt-in would enable VS Code in browsers that never accepted the risk. |
| Detecting the desktop app by `desktopShell` or user agent | Both are claims any page can make; only a secret the browser never sees works. |
| Desktop token in the core's environment | Inherited by child processes and visible in `/proc/<pid>/environ`; stdin is inherited by nothing. |
| A header added by the desktop app (`webRequest`) | Every request through the main process; service workers and WebSockets unreliable. A session cookie is sent by Chromium itself. |
| Any loopback Origin accepted | Any local program's pages (dev servers, forwarded ports) could open the core's WebSockets. |
| code-server on an origin of its own | Removes the risk, but every deployment's proxy, certificate and origins would need a second host or port. |

## Failure modes

- **Missing `--allowed-origin`**: the proxy's requests get 403 "host not
  allowed" (fails closed).
- **Plain HTTP over a LAN address**: terminals work, but VS Code webviews,
  the clipboard and notifications need a secure context; use HTTPS.
- **A core the desktop app did not start** (`veldr serve`): there is no
  desktop token, so every client is a browser and VS Code follows
  `plugins.vscode.browser`. A desktop app whose cookie could not be set
  reports a startup failure rather than run as a browser.

## Testing

- `internal/server/server_test.go`: `TestGuard`, `TestProxySecret`,
  `TestCSPOnAppShell`, `TestMutatingRoutesAreGuarded`,
  `TestReadOnlyRetryKeepsTheSession`, `TestCodeServerPortProxyRefused`.
- `internal/server/plugins_test.go`, `client_test.go`: per-client VS Code
  switches and the desktop token (`TestCodeRoutesFollowTheirClientsSwitch`,
  `TestClientReported`, `TestDesktopCookieNotForwarded`,
  `TestBridgeMessagesFollowTheClientsSwitch`, `TestVSCodeOffEndsItsWork`);
  `cmd/veldr/parent_test.go` (`TestReadHello`).
- `internal/server/term_test.go`: allowlist and audit (`TestTermProtocol`),
  read-only terminals (`TestTermReadOnly`, `TestTermWithoutCore`).
- `internal/server/settings_test.go` (`TestSettingsReadOnly`),
  `internal/server/machines_test.go` (`TestHCEndpointsGuard`,
  `TestSSHLoginNeedsAControlDir`).
- `internal/transport`: `TestCheckPrivateDir`,
  `TestSSHArgsWithoutControlDir`; `internal/agent/agent_test.go`:
  `TestHelloAndPrivateRunDir`, `TestDialRestriction`.
