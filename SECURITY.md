# Security

webherdr gives its users interactive shells, file access and code execution
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
| Requests bypassing the proxy | `--proxy-secret-file`: requests not from a same-host browser must carry `X-webherdr-Proxy-Secret` (constant-time comparison); the header is stripped before reaching code-server. |
| DNS rebinding, cross-site WebSocket hijacking | Host and Origin must be loopback or an `--allowed-origin`. |
| Clickjacking, script injection through served files | CSP with `script-src 'self'` and `frame-ancestors 'self'` on the UI; files are served with `nosniff`, a sandboxing CSP, and HTML/JS as `text/plain`; code-server responses get `X-Frame-Options: SAMEORIGIN`. |
| Abuse of herdr's API from the UI | Method allowlist (workspace/tab/pane/agent/layout/worktree calls, snapshot, plugin actions); no server control, integration or plugin installation, raw event streams or client-shell calls. `--read-only` narrows it to reads. |
| Other users on the core host hijacking ssh | ssh control sockets live in `/tmp/webherdr-<uid>/s`, which must be a directory owned by the user with no group/other access, or the core refuses to start. |
| Other users on a machine | Agent state is in `~/.webherdr` (0700); code-server and the bridge listen only on unix sockets there (0600); nothing listens on TCP. |
| Tampered downloads | code-server releases and extensions are verified against pinned SHA-256 digests or `.sha256` sidecars; mismatches are refused. |
| Archive path traversal | Tarball extraction rejects absolute paths, `..` and links leaving the install directory. |
| Accountability | `--audit-log` records connections, mutating calls, uploads, VS Code and bridge use, and refusals. |

Not provided by webherdr: user authentication, TLS, rate limiting, per-user
authorization. Use the reverse proxy for these.

## Supported versions

Security fixes go to the latest release and to `main`.

## Reporting a vulnerability

Please report privately instead of opening a public issue: use the
repository host's private vulnerability reporting ("Report a vulnerability"
under the Security tab) or contact the maintainers. Include the version
(`webherdr version`), configuration flags and steps to reproduce. You will
get an acknowledgement within a few days.
