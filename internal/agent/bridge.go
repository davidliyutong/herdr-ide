//go:build unix

package agent

import (
	"context"
	"net"
	"path/filepath"

	"herdr-ide/internal/agentproto"
)

// serveBridge accepts connections from the VS Code bridge extension on
// <run>/bridge.sock and tunnels each one to the core, once the extension
// sent its first message (its hello).
//
// Another agent of the same instance may serve the socket: one that
// lingers after a reconnect, or one of a second core connected to this
// machine. The newest agent takes it over, and serves it until it exits;
// the others serve it again once it is free (serveSocket).
func (a *Agent) serveBridge(ctx context.Context) {
	a.serveSocket(ctx, "bridge", filepath.Join(a.runDir, "bridge.sock"), func(c net.Conn) {
		go a.relayFirst(c, agentproto.Header{Op: agentproto.OpBridge}, 0, nil)
	})
}
