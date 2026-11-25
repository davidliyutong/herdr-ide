// VS Code's machine side as the core reaches it. It serves no plugin
// actions: code-server is the agent protocol's op code-server (status,
// download, install, start, stop, release, install-ext, marker; the core's
// provision.ts), its socket a pipe of op dial-unix (proxy.ts), and the
// bridge extension's connections are streams of op bridge the agent opens
// towards the core (bridge.ts). The protocol names the feature, and the
// sockets are the names both sides use in the agent's run directory.
import { defineProtocol } from '#shared/proto/protocol.ts';

export const vscodeProtocol = defineProtocol('vscode', {});

/** code-server's socket, below the agent's run directory. */
export const CODE_SOCKET = 'cs.sock';
/** The bridge extension's socket, below the agent's run directory. */
export const BRIDGE_SOCKET = 'bridge.sock';
