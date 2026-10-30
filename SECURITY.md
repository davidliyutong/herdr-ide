# Security

herdr-ide gives its users interactive shells, file access and code execution
on every connected machine, with the permissions of the account running it.
Treat access to it like ssh access to all those machines.

## Threat model

**Trusted:** the user running the core, the machines it connects to (and
their herdr servers), the reverse proxy and whoever it authenticates.

**Not trusted:** other local users on the core host and on the machines,
other web pages open in the same browser, the network between browser and
proxy, and output shown in terminals.

## What the code enforces

| Risk | Mitigation |
| --- | --- |
| Accidental exposure of the port | Listens on loopback by default; a non-loopback `--listen` is refused unless a proxy secret is configured or `--insecure-listen` is given. |
| Requests bypassing the proxy | `--proxy-secret-file`: requests not from a same-host browser must carry `X-herdr-ide-Proxy-Secret` (constant-time comparison); the header is stripped before reaching code-server. |
| DNS rebinding, cross-site WebSocket hijacking | Host and Origin must be loopback or an `--allowed-origin`. |
| Clickjacking, script injection through served files | CSP with `script-src 'self'` and `frame-ancestors 'self'` on the UI; files are served with `nosniff`, a sandboxing CSP, and HTML/JS as `text/plain`; code-server responses get `X-Frame-Options: SAMEORIGIN`. |
| Local services of a machine running with the UI's origin | code-server's port proxy (`/proxy/<port>/`, `/absproxy/<port>/`) is disabled (`--disable-proxy`) and the core refuses those paths in any case (audited as `denied.port_proxy`), also for a code-server started by an earlier build. Otherwise a page served by any process listening on the machine, including another user's on a shared machine, could script `/ws`. |
| Abuse of herdr's API from the UI | Method allowlist (workspace/tab/pane/agent/layout/worktree calls, snapshot, plugin actions); no server control, integration or plugin installation, raw event streams or client-shell calls. `--read-only` narrows it to reads. |
| Other users on the core host hijacking ssh | ssh control sockets live in `/tmp/herdr-ide-<uid>/s`, which must be a directory owned by the user with no group/other access, or the core refuses to start. |
| Other users on a machine | Agent state is in `~/.herdr-ide` (0700); code-server and the bridge listen only on unix sockets there (0600); nothing listens on TCP. |
| Tampered downloads | code-server releases and extensions are verified against pinned SHA-256 digests or `.sha256` sidecars; mismatches are refused. |
| Archive path traversal | Tarball extraction rejects absolute paths, `..` and links leaving the install directory. |
| Downloads made by machines (`--code-server-install=download`) | The machine fetches only `http(s)` URLs built from the core's `--code-server-url` template, with curl or wget and no shell; the tarball is checked against the digest the core knows before it is unpacked. A digest learnt on first use is recorded on the core like the core's own downloads. |
| Changing settings from the UI | `PUT /api/settings` passes the same guards as every other request, is refused in `--read-only`, accepts only defined settings with validated values (enums, absolute paths, no control characters), and is audited (`settings.set`). A setting given on the command line cannot be changed. The code-server path chosen there is run on the machines, which gives no more than the shell access the UI already has. |
| Accountability | `--audit-log` records connections, mutating calls, uploads, VS Code and bridge use, and refusals. |

Not provided by herdr-ide: user authentication, TLS, rate limiting, per-user
authorization. Use the reverse proxy for these.

## Supported versions

Security fixes go to the latest release and to `main`.

## Reporting a vulnerability

Please report privately instead of opening a public issue: use the
repository host's private vulnerability reporting ("Report a vulnerability"
under the Security tab) or contact the maintainers. Include the version
(`herdr-ide version`), configuration flags and steps to reproduce. You will
get an acknowledgement within a few days.
