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

**Delivery.** One binary serves the UI (embedded `web/dist`), the WebSocket
API and the code-server proxy on `127.0.0.1:7780` by default.

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
4. **Read-only mode** (`--read-only`): observe-only panes; uploads, ssh
   authentication, bridge commands and VS Code refused; herdr calls limited
   to reads.
5. **herdr API allowlist**: workspace/tab/pane/agent/layout/worktree methods,
   snapshot and plugin actions; no `server.*`, integrations, plugin
   installation, event streams or client-shell calls.
6. **CSP** on the UI (`script-src 'self'`, `frame-ancestors 'self'`, …).
7. **Audit log** (`--audit-log`): JSON lines for connections, mutating calls,
   uploads, VS Code and bridge use, ssh authentication and denials, with the
   user from `--user-header` or common proxy headers.

**Startup checks** (`cmd/herdr-ide`): a non-loopback `--listen` is refused
unless a proxy secret is configured or `--insecure-listen` is given; the ssh
control directory must be private ([02](02-multi-machine-transport.md)).

**On machines**: nothing listens on TCP; sockets live in a 0700 directory
with 0600 modes.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Electron as the only delivery format | Would exclude access from other devices. The optional [desktop shell](15-desktop-packaging.md) wraps the same web core; browser delivery remains available. |
| Tauri desktop app | macOS WKWebView does not provide service workers to arbitrary origins; VS Code webviews (Git Graph, media preview) break. |
| Built-in password login | Duplicates what proxies do better (SSO, 2FA, device trust); authentication is delegated to the proxy by design. |
| Blocklist of dangerous herdr methods | New herdr methods would be exposed by default. |

## Failure modes

- **Missing `--allowed-origin`** → the proxy's requests get 403 "host not
  allowed" (fails closed).
- **Plain HTTP over a LAN address** → works for terminals, but VS Code
  webviews, clipboard and notifications are unavailable; HTTPS is required.

## Testing

`internal/server/server_test.go`: Host/Origin guard, proxy secret (local,
remote, wrong secret, same-host proxy), API allowlist and read-only, CSP and
headers, read-only refusals. `internal/transport/controldir_test.go`:
control directory ownership and modes.
