# 32 · Browser pane and port forwards

## Context

A development server on a machine listens on that machine's `localhost`, so a `localhost` link printed in a remote terminal would open the user's own; VS Code's port proxy is off on purpose ([05](05-vscode-panes.md)).

## Goals / non-goals

Goals: a **browser pane**; **port forwards** of a machine's loopback ports to the hub host's loopback, made when the user opens one and ended when unused; `localhost` links that open where they work.

Non-goals: forwards for clients not on the hub's host; forwarding to hosts other than the machine's loopback; a full browser; arbitrary sites in a browser client, where a frame cannot show them.

## Design

**Forwards** (`backend/features/browser`: `forwards.ts`, `hub.ts`, machine side `machine.ts`; routes and settings in [reference.md](../reference.md)). The machine's `dial {port}` connects a stream to the port on `127.0.0.1` (else `::1`), never another host, and `listening` lists the user's listening TCP ports; nothing listens on the machine. The hub listens on the hub host's loopback, on both `127.0.0.1` and `::1` since a browser may try either for "localhost", never on a port another program holds on either (`backend/shared/host/loopback.ts`), and carries each connection over a stream of its own. It takes the same port number when free (some dev servers check the Host's port), else another, which the pane names. A forward ends when stopped, with its machine, the plugin or the hub, or when unused for `browser.forwardIdle` minutes; an idle open connection is no use, so no program can hold a way into the machine open. Forwards serve only clients on the hub's own host (`sameHost`), others get `403 forward_local_only`.

**Origins.** A forwarded service is another site than the UI and stays one. Its own port gives it its own origin, which the hub's guard refuses ([08](08-web-access-and-security.md)). Cookies ignore ports, so a browser frames a forward under the other loopback name than the UI's (`otherHost` in `web/src/plugins/browser/api.ts`), and the UI's CSP (`appCSP`) allows frames of that name only. The hub's own address is never a page for a pane (`web/src/lib/webUrl.ts`, `desktop/src/policy.ts`).

**The pane** (`web/src/plugins/browser`; commands `browser.open`, `browser.reload`). The view `{plugin: browser, kind: page, url, m?, port?}` lives in the layout, which every client and any page script can write, so a view naming a port is no request for a forward: the page keeps in memory the ports the user asked for (`grantForward`: typed, chosen in **Ports**, a terminal link clicked, or confirmed with **Forward and open**) and only uses existing forwards for the others. Frames live in a layer of their own (`frames.ts`, `BrowserLayer.tsx`), as VS Code's do. In a browser the pane is a sandboxed `<iframe>` for loopback addresses only. In the desktop app it is a `<webview>` in the isolated partition `persist:browser`, whose attaches, guest preferences, navigation and popups the shell vets (`desktop/src/policy.ts`); a popup becomes a browser tab that grants no forward, and names resolve through the system resolver so VPN names work.

**Links** (`web/src/terminal/openLink.ts`, `linkPlace`). Terminal and document web links follow `browser.openLinks`: `loopback` (default) opens loopback addresses in a pane and others in the user's browser, where their sign-ins and proxy are; `all` also others in a pane (desktop app); `external` all outside. A terminal link's click grants its port, since its tooltip names the address; a document's link does not, as link text can hide it (`[guide](http://localhost:2375/…)` would expose the Docker API). The new-tab menu lists **Browser** among the plugins' tab kinds ([27](27-plugins.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| code-server's port proxy, or a path under the UI's origin | The service's scripts would run with the UI's origin: terminals, files, the vault. |
| A rewriting HTTP proxy in the hub | Absolute paths, WebSockets and host checks break under a prefix; a forward carries bytes unchanged. |
| A host name per forward (`3000.m.localhost`) | Needs wildcard names and certificates behind every reverse proxy; Safari does not resolve names below `localhost`. |
| Framing under the UI's own loopback name | Cookies ignore ports: the UI's cookies would go to the service. |
| `<iframe>` in the desktop app | Cannot show sites that forbid framing or report navigation. |
| A forward whenever a pane shows a port, or granted ports persisted | Layout and storage are writable by page scripts: `window.open('http://localhost:2375/')` would forward with no click. |

## Failure modes

- **Client not on the hub's host**: no forwards; links open outside.
- **Forward ended** (idle, stopped elsewhere, hub restart): remade for a granted port; otherwise the pane asks.
- **Local service on `::1` only**: a UI on `localhost` frames `127.0.0.1`, where nothing answers.

## Security

A forward is a listener on the hub host's loopback leading into a machine: any program or user of the hub host can connect to it, as with `ssh -L`, and any web page in the user's browsers can send it blind requests. Hence it exists only after the user asked for it in this page, and ends when unused. Origins and the desktop app's own session keep the forwarded page apart from the UI ([SECURITY.md](../../SECURITY.md)).

## Testing

- `backend/features/browser/*.test.ts` (forwards over a fake `dial`, idle expiry, bounds, guards), `backend/shared/host/loopback.test.ts`, `backend/kernel/http/http.test.ts` (origins, frames).
- `web/src/__tests__/browser*.test.ts(x)` (addresses, frames, grants, popups, links), `desktop/src/policy.test.ts` (guests, navigation, popups).
