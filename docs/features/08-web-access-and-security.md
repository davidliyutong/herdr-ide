# 08 · Web access and security

## Context

The IDE must be usable from other devices, and whoever can use it controls shells on every machine. Authentication is left to a reverse proxy the user already runs (Tailscale, Caddy or nginx with an identity provider).

## Goals / non-goals

Goals: browser or PWA access; safe defaults when the proxy is missing or misconfigured; protection against hostile pages and other local users; an audit trail. Non-goals: user accounts, TLS termination, per-user permissions.

## Design

The hub serves the UI, its API and the code-server proxy on `127.0.0.1:7780` by default; the desktop app's hub listens on nothing ([16](16-desktop-packaging.md)). The threat model is in [SECURITY.md](../../SECURITY.md).

### Guardrails

In request order (`backend/kernel/http/guard.ts`, `app.ts`):

1. **Security headers** (`nosniff`, `Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy`).
2. **Proxy secret** (`--proxy-secret-file`) on every request not from a same-host browser, compared in constant time.
3. **Host and Origin** against `--allowed-origin` or loopback (DNS rebinding, cross-site WebSocket hijacking).
4. **Read-only mode** (`--read-only`): every mutating route `403`, terminals observed only; each feature's tests walk its routes (`checkGuarded`), so an unguarded one fails.
5. **Terminal protocol allowlist** (`backend/features/terminals/allowlist.ts`): new herdr-core methods are closed by default.
6. **CSP** on every page (`script-src 'self' 'wasm-unsafe-eval'`, `frame-ancestors 'self'`).
7. **Audit log** (`--audit-log`) of security-relevant events, with the proxy's user header.

A non-loopback `--listen` needs a proxy secret or `--insecure-listen`, and the ssh control directory must be private ([02](02-multi-machine-transport.md)). On machines nothing listens on TCP ([39](39-nodes.md#security)).

### VS Code on the UI's origin

code-server is proxied on the UI's own origin, so a script in it can do what the page can on every machine. VS Code is therefore off by default, with a switch per kind of client ([05](05-vscode-panes.md)): `plugins.vscode.enabled` for the desktop app, `plugins.vscode.browser` for browsers after the user confirms the risk. A request is the desktop app's only when the app's main process hands it over (`backend/kernel/http/app.ts`).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Built-in password login | Proxies do it better (SSO, 2FA, device trust). |
| Blocklist of terminal core methods | New methods would be open by default. |
| One VS Code switch for every client | A desktop opt-in would enable VS Code in browsers that never accepted the risk. |
| code-server on an origin of its own | Every deployment would need a second host or port, certificate and proxy rule. |

## Failure modes

- **Missing `--allowed-origin`**: the proxy's requests get 403 (fails closed).
- **Plain HTTP over a LAN address**: VS Code webviews, the clipboard and notifications need HTTPS.

## Testing

`backend/kernel/http/http.test.ts` (guards, CSP), every feature's guarded-routes test, `backend/features/vscode/hub.test.ts` (per-client switches), `backend/features/terminals/terminals.test.ts` (allowlist, read-only terminals).
