// Package chat is the core's side of the chat plugin: conversations with
// coding agents that a machine's chat host runs headless
// (internal/chatproto), relayed to the pages over one WebSocket per page
// (wire.go) and through the machine side (internal/agent/plugin/chat). Its
// settings are in the section "chat", per machine, and reach each
// machine's host as chatproto.HostSettings (HostSettings); its switch is
// plugins.chat.enabled (plugin.Settings).
//
// Its routes, a machine's below /api/m/{id}/p/chat and the page's
// WebSocket /api/p/chat/ws, are declared; this version has no chat host
// and answers each 501 not_implemented.
package chat

import (
	"net/http"

	"herdr-ide/internal/plugin"
)

// ID names the plugin on every side.
const ID = "chat"

// CodeNotImplemented is the error code of the routes this version
// declares without serving them.
const CodeNotImplemented = "not_implemented"

// Plugin is the chat plugin.
type Plugin struct{}

// New returns the plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) ID() string { return ID }

// Routes of the plugin:
//
//   - GET    /api/m/{id}/p/chat/agents: the agents the machine's chat host
//     can start ([]chatproto.AgentStatus);
//   - GET    /api/m/{id}/p/chat/chats: its chats, closed ones included
//     ([]chatproto.Chat);
//   - GET    /api/m/{id}/p/chat/sessions?kind=&cwd=&cursor=: the sessions
//     an agent kept for a directory ({sessions, nextCursor});
//   - POST   /api/m/{id}/p/chat/new: a new chat (chatproto.Request's kind,
//     cwd, resume, import and options), audited as chat.new;
//   - POST   /api/m/{id}/p/chat/close?chat=: ends a chat's agent and keeps
//     the chat, audited as chat.close;
//   - DELETE /api/m/{id}/p/chat/chat?chat=: forgets a chat and its log,
//     audited as chat.delete;
//   - POST   /api/m/{id}/p/chat/seen?chat=&seq=: the user saw the chat up
//     to seq, which ends its done status for every page, audited as
//     chat.seen;
//   - GET    /api/p/chat/ws: the page's WebSocket (wire.go).
func (p *Plugin) Routes() []plugin.Route {
	return []plugin.Route{
		{Method: http.MethodGet, Path: "agents", Machine: true, Handler: notImplemented},
		{Method: http.MethodGet, Path: "chats", Machine: true, Handler: notImplemented},
		{Method: http.MethodGet, Path: "sessions", Machine: true, Handler: notImplemented},
		{Method: http.MethodPost, Path: "new", Machine: true, Mutating: true, Audit: "new", Handler: notImplemented},
		{Method: http.MethodPost, Path: "close", Machine: true, Mutating: true, Audit: "close", Handler: notImplemented},
		{Method: http.MethodDelete, Path: "chat", Machine: true, Mutating: true, Audit: "delete", Handler: notImplemented},
		{Method: http.MethodPost, Path: "seen", Machine: true, Mutating: true, Audit: "seen", Handler: notImplemented},
		{Method: http.MethodGet, Path: "ws", Handler: notImplemented},
	}
}

// notImplemented answers a route this version does not serve.
func notImplemented(_ *plugin.Call, w http.ResponseWriter, _ *http.Request) {
	plugin.WriteJSON(w, http.StatusNotImplemented, map[string]string{"error": CodeNotImplemented, "message": "this version has no chat host"})
}
