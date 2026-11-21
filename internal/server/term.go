package server

import (
	"time"
)

// Terminals of the machines' terminal cores (herdr-core, feature 21) for
// clients that draw terminals themselves: the WebSocket /api/v1/term carries
// calls and events as JSON text frames and terminal bytes as binary frames
// [stream u32 LE][kind u8][payload].

// Binary frame kinds, as herdr-core numbers them.
const (
	termData      = 0 // output to the client, input from it
	termAutomatic = 6 // from the client: its terminal's own answers
	termResize    = 3 // to the client: cols u16 LE, rows u16 LE
)

// Backend states and the codes of a backend that is not ready.
const (
	termStarting = "starting"
	termReady    = "ready"
	termError    = "error"

	termCodeOffline    = "machine_offline"
	termCodeNotBundled = "not_bundled"
	termCodeNotRunning = "not_running"
	termCodeInstall    = "install_failed"
	termCodeStart      = "start_failed"
	termCodeConnect    = "connect_failed"
	termCodeLost       = "disconnected"
	termCodeStopped    = "stopped"
)

// termIdle is how long a backend's connection stays without clients.
const termIdle = 10 * time.Second

// termReadMethods may be called by every client, termWriteMethods by
// writable ones. Methods that reach beyond terminals and documents (files,
// commands, other machines, the core itself) are not offered.
var (
	termReadMethods = map[string]bool{
		"terminal.list": true, "terminal.get": true, "terminal.read": true,
		"doc.get": true, "templates.list": true,
	}
	termWriteMethods = map[string]bool{
		"terminal.run": true, "terminal.kill": true, "terminal.rm": true,
		"terminal.keep": true, "terminal.label": true, "terminal.interrupt": true,
		"doc.set": true,
	}
)
