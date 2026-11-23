package agentproto

import (
	"encoding/json"
	"time"

	"herdr-ide/internal/brand"
)

// A coding agent's session transcript as a machine reads it: Claude
// Code's JSON lines, parsed (internal/agent/transcript) into
// TranscriptEvents shaped as the Agent Client Protocol's (ACP v1)
// session/update notifications: their members are named as ACP's, and the
// members every event has as an event log's (t, at). Every event is made
// from its own line alone. A transcript is named by its agent's kind and
// session id, never by a path.

// The types of a TranscriptEvent (TranscriptEvent.T).
const (
	// TranscriptUpdate: an ACP session update, in Update.
	TranscriptUpdate = "update"
	// TranscriptUser: a prompt of the user, its ACP content blocks in
	// Content.
	TranscriptUser = "user"
	// TranscriptTurn: a turn started, ended or failed (State, StopReason).
	TranscriptTurn = "turn"
	// TranscriptNotice: something of the session that is no session update
	// (Method, Params; NoticeMethod).
	TranscriptNotice = "notice"
)

// The states of a TranscriptTurn event.
const (
	TurnStart = "start"
	TurnEnd   = "end"
	TurnError = "error"
)

// The notices of a transcript and of a chat (chatproto.EventNotice), by
// name (NoticeMethod). Each list of names the UIs know mirrors these.
const (
	// NoticeCompacted: the conversation was compacted (summarized).
	NoticeCompacted = "compacted"
	// NoticeCommand: a slash command the user ran, or its local output
	// (params {name, args?, output?}).
	NoticeCommand = "command"
	// NoticeError: an error the agent recorded (an API error), or one of
	// the chat host's (params {message, code?, willRetry?}).
	NoticeError = "error"
	// NoticeSkipped: a line was left out, longer than a read takes; the
	// transcript reads on after it.
	NoticeSkipped = "skipped"

	// The chats' own, which no transcript has:

	// NoticeCompacting: the agent began to compact the context;
	// NoticeCompacted follows.
	NoticeCompacting = "compacting"
	// NoticeHandedOff: the chat's session went on in a terminal
	// (chatproto.OpHandoff).
	NoticeHandedOff = "handed_off"
	// NoticeRestarted: the agent's process was started again (params
	// {mode?}: for a permission mode it takes only at its start).
	NoticeRestarted = "restarted"
	// NoticeImported: what follows was imported from the agent's own
	// record of the session (params {lossy}: parts may differ or be
	// missing).
	NoticeImported = "imported"
	// NoticeUntrustedFolder: the agent started without the project's own
	// settings (its hooks, MCP servers and instructions): neither the
	// agent nor the machine's list (chatproto.OpTrust) trusts the folder
	// (params {cwd}).
	NoticeUntrustedFolder = "untrusted_folder"
	// NoticeFullAccessOff: the chat had full access, which the machine's
	// settings no longer allow; its agent started in the default mode
	// (params {mode}: the mode it had).
	NoticeFullAccessOff = "full_access_off"
)

// NoticeMethod is the method of a notice: an ACP extension method,
// "_<product slug>/<name>".
func NoticeMethod(name string) string { return "_" + brand.Slug + "/" + name }

// Limits of reading transcripts.
const (
	// MaxTextBytes is the most text of one event: longer text is cut.
	MaxTextBytes = 256 << 10
	// MaxToolOutput is the most of a tool call's output an event keeps (its
	// start and its end).
	MaxToolOutput = 32 << 10
	// MaxLineEvents is the most events one line of a transcript makes: a
	// parser makes no more of a line.
	MaxLineEvents = 1 << 8
)

// TranscriptEvent is one event of a transcript, made from its line alone.
// Its JSON member names are those of an event log (t, at) and of ACP v1's
// session/update (the others).
type TranscriptEvent struct {
	// T is the event's type (Transcript*).
	T  string    `json:"t"`
	At time.Time `json:"at,omitzero"`
	// Update is the update member of an ACP v1 session/update's params
	// (TranscriptUpdate).
	Update json.RawMessage `json:"update,omitempty"`
	// Content are a prompt's ACP content blocks (TranscriptUser).
	Content []json.RawMessage `json:"content,omitempty"`
	// State is the turn's (TurnStart, TurnEnd, TurnError) and StopReason
	// why it ended, as ACP's (TranscriptTurn).
	State      string `json:"state,omitempty"`
	StopReason string `json:"stopReason,omitempty"`
	// Method and Params are a notice's (TranscriptNotice).
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
}

// The codes of a transcript's readers (a resolve, a session's usage).
const (
	// TranscriptNotFound: the agent kept no transcript of the session (or
	// the kind has none).
	TranscriptNotFound = "not_found"
	// TranscriptCompressed: the transcript is compressed and not read.
	TranscriptCompressed = "compressed"
	// TranscriptTooLarge: the session's transcripts are more than a reader
	// that takes them whole reads (a session's usage).
	TranscriptTooLarge = "too_large"
	// TranscriptBadRequest: the request is not one to answer (an unknown kind, a
	// session that is no session id).
	TranscriptBadRequest = "bad_request"
)

// ResolveRequest asks whether a session is one to resume in a directory:
// the agent of Kind kept the session's transcript, and the session ran in
// Cwd.
type ResolveRequest struct {
	Kind    string `json:"kind"`
	Session string `json:"session"`
	Cwd     string `json:"cwd"`
}

// ResolveReply answers a ResolveRequest: OK, or Code (TranscriptNotFound,
// TranscriptBadRequest, or "other_cwd" when the session ran elsewhere).
type ResolveReply struct {
	OK   bool   `json:"ok"`
	Code string `json:"code,omitempty"`
}

// ResolveOtherCwd is a ResolveReply's code for a session that ran in
// another directory.
const ResolveOtherCwd = "other_cwd"

// SessionUsage is what a session of a coding agent used, at API prices.
// The token members are named as the AI usage plugin's cost rows
// (usage.CostRow).
type SessionUsage struct {
	// Model is the model of the session's latest request.
	Model      string `json:"model,omitempty"`
	Input      int64  `json:"input"`
	Cached     int64  `json:"cached"`
	CacheWrite int64  `json:"cacheWrite"`
	Output     int64  `json:"output"`
	// Reasoning is part of Output.
	Reasoning int64   `json:"reasoning,omitempty"`
	Requests  int64   `json:"requests"`
	Cost      float64 `json:"cost"`
	// Priced: every request's model had a price.
	Priced bool `json:"priced"`
	// ContextUsed is the tokens of the latest request's context, and
	// ContextSize the model's context window (0: unknown).
	ContextUsed int64 `json:"contextUsed,omitempty"`
	ContextSize int64 `json:"contextSize,omitempty"`
}
