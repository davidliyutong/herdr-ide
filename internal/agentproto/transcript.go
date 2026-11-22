package agentproto

import (
	"encoding/json"
	"time"

	"herdr-ide/internal/brand"
)

// A coding agent's session transcript (Claude Code's and Codex's JSON
// lines) as a machine reads it (internal/agent/transcript): the machine
// parses the file into TranscriptEvents shaped as the Agent Client
// Protocol's (ACP v1) session/update notifications: their members are
// named as ACP's, and the members every event has as an event log's (seq,
// t, at). A transcript is named by its agent's kind and session id, never
// by a path.
//
// A read is one page of the file, forward from a cursor or back before
// one, and the machine keeps nothing between reads: every event is made
// from its own line alone, and a cursor (a Seq) says where in the file a
// read goes on. Browsers hold cursors as opaque numbers, compared and sent
// back as they came: no bit operations on them (JavaScript's are 32-bit).

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
	// NoticeCleared: the conversation was cleared; a new session follows.
	NoticeCleared = "cleared"
	// NoticeCommand: a slash command the user ran, or its local output
	// (params {name, args?, output?}).
	NoticeCommand = "command"
	// NoticeError: an error the agent recorded (an API error), or one of
	// the chat host's (params {message, code?, willRetry?}).
	NoticeError = "error"
	// NoticeModel: the model changed.
	NoticeModel = "model"
	// NoticeSkipped: a line was left out, longer than a read takes
	// (MaxTailBytes); the transcript reads on after it.
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
)

// NoticeMethod is the method of a notice: an ACP extension method,
// "_<product slug>/<name>".
func NoticeMethod(name string) string { return "_" + brand.Slug + "/" + name }

// Limits of reading transcripts.
const (
	// MaxTailBytes is the most bytes of a transcript one read gives.
	MaxTailBytes = 1 << 20
	// MaxTextBytes is the most text of one event: longer text is cut.
	MaxTextBytes = 256 << 10
	// MaxToolOutput is the most of a tool call's output an event keeps (its
	// start and its end).
	MaxToolOutput = 32 << 10
	// MaxLineEvents is the most events one line of a transcript makes: a
	// parser makes no more of a line, and an event's index within its line
	// takes the low 8 bits of its Seq.
	MaxLineEvents = 1 << 8
)

// Seq is the place of the index-th event of the line at offset (in bytes)
// of its transcript: the offset times 256, plus the index. Events and
// cursors (TranscriptRef.From, TranscriptTail.First and Next) are in this
// space, so a machine resumes a read without keeping anything. An index
// beyond the last a line may have counts as MaxLineEvents-1, and one below
// 0 as 0: neither reaches into the offset. It is exact in JavaScript for
// transcripts below 32 TiB.
func Seq(offset int64, index int) uint64 {
	index = max(0, min(index, MaxLineEvents-1))
	return uint64(offset)<<8 | uint64(index)
}

// SeqOffset is the offset of the line of seq.
func SeqOffset(seq uint64) int64 { return int64(seq >> 8) }

// SeqIndex is the index of seq's event within its line.
func SeqIndex(seq uint64) int { return int(seq & (MaxLineEvents - 1)) }

// TranscriptEvent is one event of a transcript, made from its line alone.
// Its JSON member names are those of an event log (seq, t, at) and of
// ACP v1's session/update (the others).
type TranscriptEvent struct {
	// Seq is the event's place in its transcript (Seq).
	Seq uint64 `json:"seq"`
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

// TranscriptRef names a transcript to read and where.
type TranscriptRef struct {
	// Kind is the agent's (agentkinds), Session its session id
	// (agentkinds.ValidSessionID).
	Kind    string `json:"kind"`
	Session string `json:"session"`
	// From is the Seq a forward read starts at: a previous reply's Next, 0
	// for the transcript's start. A forward cursor that is not in the
	// transcript (beyond its size, or not at a line's start: the file was
	// replaced or truncated) is answered as a first read (Back, From 0),
	// with the file's File, so that the reader starts over.
	From uint64 `json:"from"`
	// Back reads the page before From instead: the latest events before it
	// that MaxTailBytes holds. With From 0 that is the page ending at the
	// transcript's end, a reader's first read, and its Next is where forward
	// reads go on. With another From (the First of the page after it) its
	// Next is From. A back read that reached the transcript's start says
	// More false, and readers ask for no earlier page.
	Back bool `json:"back,omitempty"`
}

// The codes of a TranscriptTail.
const (
	// TranscriptNotFound: the agent kept no transcript of the session (or
	// the kind has none).
	TranscriptNotFound = "not_found"
	// TranscriptCompressed: the transcript is compressed and not read.
	TranscriptCompressed = "compressed"
	// TranscriptTooLarge: the session's transcripts are more than a reader
	// that takes them whole reads (a session's usage). A read in pages
	// never fails for a long line: it leaves the line out with a notice
	// (NoticeSkipped) and reads on.
	TranscriptTooLarge = "too_large"
	// TranscriptBadRequest: the ref is not one to read (an unknown kind, a
	// session that is no session id).
	TranscriptBadRequest = "bad_request"
)

// TranscriptTail is what a read of a transcript gave.
type TranscriptTail struct {
	Kind    string `json:"kind"`
	Session string `json:"session"`
	// File identifies the transcript's file (an opaque digest of its
	// identity, never its path): a reader that sees it change starts over.
	File string `json:"file,omitempty"`
	// First and Next are the Seqs where the events read start and end: the
	// next forward read starts at Next, a page of earlier ones before
	// First (TranscriptRef.Back says what Next is after a back read). A
	// reply with a Code has the ref's From as both.
	First uint64 `json:"first"`
	Next  uint64 `json:"next"`
	// Events, in their order.
	Events []TranscriptEvent `json:"events,omitempty"`
	// More: a limit ended a forward read before the transcript's end, or a
	// back read before its start; false, a back read reached the start.
	More bool `json:"more,omitempty"`
	// Unknown counts the lines read that made no event: kinds of lines the
	// parser does not know. Their content is not sent.
	Unknown int `json:"unknown,omitempty"`
	// Title is the agent's own title of the session, if it has one.
	Title string `json:"title,omitempty"`
	// Code says why nothing was read (Transcript*), "" when it was.
	Code string `json:"code,omitempty"`
}

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
