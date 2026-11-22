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
// deleted, the plugin was turned off). Each subscription is a connection
// of its own to the machine's chat host, which fans the chat's events
// out. A page has at most MaxSubs subscriptions, MaxSubsPerMachine of one
// machine. The page sends a chat's commands with OpCommand under an id of
// its own (ID), on a subscription of that chat it has, answered by TAck
// with that id, exactly once, also when the subscription ends first; a
// chatproto.Command's own id is the core's. A read-only core refuses every
// command (CodeReadOnly) and takes attaches.
//
// The core sends a page's messages in order and holds at most a bounded
// backlog of them: a page that does not take them as fast as they come is
// disconnected (status 1013, try again later), and attaches again with the
// last sequence number of each chat it has.
//
// The chats' states reach every page through the core's event channel
// (/ws) as plugin {plugin: "chat", m, data: StatesData}; a page that
// (re)connects reads them all first from GET /api/p/chat/states
// (StatesSnapshot) and then applies the messages whose Rev is above the
// snapshot's.

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
	// CodeOffline, CodeUnknownSub, CodeTooMany, CodeNotAttached, CodeLost,
	// CodePluginDisabled).
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
	// CodeTooMany: the page has MaxSubs subscriptions already, or
	// MaxSubsPerMachine of the machine.
	CodeTooMany = "too_many"
	// CodeNotAttached: OpCommand for a chat the page has no subscription
	// to, or one that the page detached before the command's answer came.
	CodeNotAttached = "not_attached"
	// CodeLost: the subscription's connection to the chat host ended (the
	// host ended, or dropped a connection that fell behind, or the
	// connection broke) while the machine stays connected: the page
	// attaches again with its last sequence number. A command whose answer
	// had not come is told so too: it may have been carried out.
	CodeLost = "lost"
	// CodePluginDisabled: the plugin was turned off; the WebSocket closes
	// after telling each subscription.
	CodePluginDisabled = "plugin_disabled"
)

const (
	// MaxClientMessage is the longest message a page sends, in bytes: a
	// command with a prompt of chatproto.MaxPrompt and its envelope.
	MaxClientMessage = chatproto.MaxPrompt + 64<<10
	// MaxSubs is the most subscriptions a page's WebSocket has at once,
	// and MaxSubsPerMachine the most of them to one machine's chats.
	MaxSubs           = 32
	MaxSubsPerMachine = 16
	// MaxPageID is the longest id of a subscription or a command a page
	// gives, in bytes.
	MaxPageID = 64
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
	// changed, a chat that is no more in chatproto.StateDeleted.
	Full bool `json:"full"`
	// Stale is true when the machine is offline/disconnected so cached
	// states cannot be refreshed.
	Stale bool `json:"stale,omitempty"`
	// Rev numbers the machine's states since the core started: each
	// message has the next number, and a snapshot (StatesSnapshot) the
	// number of the last message it holds. A page applies a message only
	// when its Rev is above the one it has.
	Rev uint64 `json:"rev"`
	// HostVersion is the version of the machine's chat host as the watch
	// read it last ("" while none serves); Outdated: that is not this
	// core's build (agentproto.Version), whose host takes its place only
	// when the user restarts it (POST host/stop), which the page reminds
	// of.
	HostVersion string `json:"hostVersion,omitempty"`
	Outdated    bool   `json:"outdated,omitempty"`
}

// StatesSnapshot answers GET /api/p/chat/states: the last states the core
// read of each machine's chats, Full, by machine id. A machine whose chat
// host the core has not read since it started is not there. The states of
// a machine that is not connected are those it had when it was.
type StatesSnapshot struct {
	Machines map[string]StatesData `json:"machines"`
}
