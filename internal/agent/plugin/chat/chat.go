//go:build unix

// Package chat is the machine side of the chat plugin
// (internal/plugins/chat): the relay between the core and this machine's
// chat host, which runs coding agents headless and keeps their
// conversations (internal/chathost, protocol internal/chatproto). Its one
// action:
//
//   - open: a connection to the chat host's socket for the core's relay.
//     This version has no chat host and answers unsupported.
package chat

import (
	"context"
	"encoding/json"
	"net"

	"herdr-ide/internal/agent/plugin"
)

// ID names the plugin on every side.
const ID = "chat"

// ActionOpen is the plugin's action.
const ActionOpen = "open"

func init() { plugin.Register(ID, handle) }

func handle(_ context.Context, st net.Conn, action string, _ json.RawMessage, _ *plugin.Env) error {
	if action != ActionOpen {
		return plugin.Reply(st, nil, plugin.Errorf("bad_params", "chat: unknown action %q", action))
	}
	return plugin.Reply(st, nil, plugin.Errorf("unsupported", "chat: this machine has no chat host"))
}
