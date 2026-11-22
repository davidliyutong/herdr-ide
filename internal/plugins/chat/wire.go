package chat

import "herdr-ide/internal/chatproto"

// The page's WebSocket, GET /api/p/chat/ws: one per page, for the chats of
// every machine (a browser opens at most six HTTP/1.1 connections to an
// origin). Messages are JSON text frames, each one of the messages below;
// web/src/plugins/chat/protocol.ts mirrors them.
//
// The page subscribes to a chat with OpAttach under an id of its own
// (Sub): the core answers TAttached with the chat and the lowest stored
// sequence number, then TEvent for each event of the chat after From
// (stored ones, then live ones as they come), until the page sends
// OpDetach or the core sends TDetached (the machine left, the chat was
// deleted, the plugin was turned off). The page sends a chat's commands
// with OpCommand under an id of its own (ID), answered by TAck with that
// id; a chatproto.Command's own id is the core's.
//
// The chats' states reach every page through the core's event channel
// (/ws) as plugin {plugin: "chat", m, data: StatesData}.

// The operations of a ClientMessage.
const (
	OpAttach  = "attach"
	OpDetach  = "detach"
	OpCommand = "command"
)

// ClientMessage is a message of the page.
type ClientMessage struct {
	Op string `json:"op"`
	// Sub is the page's id of a subscription (OpAttach, OpDetach).
	Sub string `json:"sub,omitempty"`
	// ID is the page's id of a command (OpCommand).
	ID string `json:"id,omitempty"`
	// M is the machine of the chat (OpAttach, OpCommand).
	M string `json:"m,omitempty"`
	// Chat is the chat (OpAttach, OpCommand).
	Chat string `json:"chat,omitempty"`
	// From is the last sequence number of the chat the page has: the
	// stored events after it are sent (OpAttach).
	From uint64 `json:"from,omitempty"`
	// Cmd is the command (OpCommand).
	Cmd *chatproto.Command `json:"cmd,omitempty"`
}

// The types of a ServerMessage.
const (
	TAttached = "attached"
	TEvent    = "event"
	TDetached = "detached"
	TAck      = "ack"
)

// ServerMessage is a message of the core.
type ServerMessage struct {
	T string `json:"t"`
	// Sub is the subscription of TAttached, TEvent and TDetached.
	Sub string `json:"sub,omitempty"`
	// Chat and First answer OpAttach (TAttached): the chat as it is, and
	// the lowest sequence number still stored (chatproto.Response.First).
	Chat  *chatproto.Chat `json:"chat,omitempty"`
	First uint64          `json:"first,omitempty"`
	// Ev is an event of the chat (TEvent).
	Ev *chatproto.Event `json:"ev,omitempty"`
	// ID is the command TAck answers.
	ID string `json:"id,omitempty"`
	// Error is why a subscription ended (TDetached) or a command was
	// refused (TAck): a chatproto code, or one of the core's (CodeReadOnly,
	// CodeOffline, CodeUnknownSub, CodeTooMany).
	Error *chatproto.Error `json:"error,omitempty"`
}

// The core's error codes of the WebSocket, besides chatproto's.
const (
	// CodeReadOnly: the core is read-only; commands are refused.
	CodeReadOnly = "read_only"
	// CodeOffline: the chat's machine is not connected.
	CodeOffline = "offline"
	// CodeUnknownSub: OpDetach of a subscription the page does not have.
	CodeUnknownSub = "unknown_sub"
	// CodeTooMany: the page has MaxSubs subscriptions already.
	CodeTooMany = "too_many"
)

const (
	// MaxClientMessage is the longest message a page sends, in bytes: a
	// command with a prompt of chatproto.MaxPrompt and its envelope.
	MaxClientMessage = chatproto.MaxPrompt + 64<<10
	// MaxSubs is the most subscriptions a page's WebSocket has at once.
	MaxSubs = 64
)

// DataStates is the type of StatesData.
const DataStates = "states"

// StatesData is the data of the chat plugin's message on the core's event
// channel for machine m.
type StatesData struct {
	// T is DataStates.
	T      string                `json:"t"`
	States []chatproto.ChatState `json:"states"`
	// Full: States are every chat of the machine, and a chat the page has
	// that is not among them is gone; else they are the chats that
	// changed.
	Full bool `json:"full"`
}
