// Package chatproto is the protocol of the chat host's unix socket: JSON
// lines, one JSON object per line, UTF-8, at most MaxLine bytes each.
//
// The chat host is the long-lived process of a machine that runs coding
// agents headless, each through its adapter (internal/chatadapter: Claude
// Code's SDK protocol, Codex's app-server, the Agent Client Protocol), and
// keeps what each conversation did in its log. A client (the core, for its
// pages) connects to <run dir>/SocketName and reads the host's Hello. It
// then sends one Request and reads one Response. Every request but OpAttach
// and OpWatch ends the connection after its response. After the response to
// OpAttach the host writes the chat's stored events with a sequence number
// above Request.From, then every new one, live increments among them, an
// Event per line, until either side closes; meanwhile the client may send
// Command lines, each answered by an Event of type EventAck. After the
// response to OpWatch the host writes a ChatState line whenever a chat
// changes, until either side closes.
//
// Requests name agents by their kinds (internal/agentkinds ids with a Chat
// spec), never by a command line: what runs is the machine's to decide.
// Agents' own JSON (an ACP session update, a tool call) is handed on as
// raw members, as the adapter made it.
package chatproto

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"time"
)

const (
	// Proto is the protocol's version, stated in the host's Hello.
	Proto = 2
	// MaxLine is the longest line either side sends or takes, in bytes
	// without its newline.
	MaxLine = 16 << 20
	// MaxPrompt is the most content a prompt may carry: the JSON of its
	// content blocks, in bytes.
	MaxPrompt = 8 << 20
	// MaxImage is the most bytes an image block of a prompt may carry, its
	// data decoded.
	MaxImage = 5 << 20
	// MaxEvent is the most bytes of a stored event's JSON. The host cuts
	// what is longer: a tool call's output to its first and last
	// ToolOutputEnd bytes, anything else to a notice that it was left out.
	MaxEvent = 1 << 20
	// ToolOutputEnd is how much of a tool call's output a stored event
	// keeps at each end when the whole would not fit MaxEvent.
	ToolOutputEnd = 16 << 10
	// SocketName is the socket's file name in the instance's run directory.
	SocketName = "chat.sock"
)

// Hello is the first line of a connection, written by the host.
type Hello struct {
	Host HostInfo `json:"host"`
}

// HostInfo names a chat host.
type HostInfo struct {
	Proto   int    `json:"proto"`
	Version string `json:"version"`
	PID     int    `json:"pid"`
}

// The operations of a Request.
const (
	// OpAgents tells which of Request.Kinds can be started on the machine
	// (Response.Agents, one for each, in their order).
	OpAgents = "agents"
	// OpChats lists every chat the host keeps, closed ones included, the
	// most recently updated first (Response.Chats).
	OpChats = "chats"
	// OpNew makes a chat: it starts the agent of Request.Kind in
	// Request.Cwd, with a new session or with Request.Resume's, under
	// Request.Options. The answer comes at once, the chat in StateStarting
	// (Response.Chat); what follows comes as events.
	OpNew = "new"
	// OpAttach subscribes to the events of Request.Chat after
	// Request.From (Response.Chat and Response.First, then events).
	OpAttach = "attach"
	// OpClose ends the agent process of Request.Chat and keeps the chat,
	// in StateClosed, until the host's limits remove it. A closed chat
	// takes prompts again: the host resumes its session.
	OpClose = "close"
	// OpDelete forgets Request.Chat and its log, ending its agent process
	// first. The agent's own session files stay.
	OpDelete = "delete"
	// OpSessions lists the sessions the agent of Request.Kind kept for the
	// directory Request.Cwd, a page at a time from Request.Cursor
	// (Response.Sessions, Response.NextCursor).
	OpSessions = "sessions"
	// OpWatch subscribes to the states of every chat: Response.States
	// holds them all, then each change comes as a ChatState line.
	OpWatch = "watch"
	// OpSeen tells that the user saw Request.Chat up to Request.Seq: a
	// turn that ended at or before it is no longer StatusDone.
	OpSeen = "seen"
	// OpConfigure gives the host the core's settings for this machine
	// (Request.Settings), which it clamps (HostSettings.Clamp). The core
	// sends it when it connects and when they change.
	OpConfigure = "configure"
	// OpShutdown ends the host so that another version can take over. It
	// is refused with CodeBusy while a chat is in StateWorking or
	// StateWaiting; otherwise the host ends every agent process, which the
	// next host resumes by session id at the next prompt.
	OpShutdown = "shutdown"
)

// The operations of a Command. Each is answered by an EventAck.
const (
	// OpPrompt sends Command.Content to the agent. While a turn runs the
	// host queues the message, or steers it into the running turn where
	// the agent can (EventQueued); a chat in StateSleeping or StateClosed
	// is resumed first.
	OpPrompt = "prompt"
	// OpCancel cancels the turn, every permission and question that waits,
	// and the queued messages.
	OpCancel = "cancel"
	// OpPermission answers the permission Command.Request with
	// Command.Option, or with Command.Cancelled.
	OpPermission = "permission"
	// OpAnswer answers the question Command.Request with Command.Answers,
	// or skips it with Command.Cancelled.
	OpAnswer = "answer"
	// OpSetConfig sets the configuration option Command.Config (a
	// ConfigOption's ID) to Command.Value, one of its values: the model,
	// the effort, the mode and the agents' own options.
	OpSetConfig = "set_config"
	// OpCancelQueued withdraws the queued message Command.Message before
	// the agent took it.
	OpCancelQueued = "cancel_queued"
	// OpCompact compacts (summarizes) the conversation's context.
	OpCompact = "compact"
	// OpRename sets the chat's title to Command.Title.
	OpRename = "rename"
	// OpHandoff ends the agent process so that its session can continue
	// in a terminal: the chat is then Chat.HandedOff. Refused with
	// CodeBusy while a turn runs.
	OpHandoff = "handoff"
)

// Options are what a new chat starts with; "" leaves each to the agent's
// default (for Mode, HostSettings.DefaultMode). Each is a value of the
// chat's ConfigOption of that category, which the host checks once the
// agent listed them.
type Options struct {
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
	Mode   string `json:"mode,omitempty"`
}

// The permission modes of the host's settings (HostSettings.DefaultMode,
// the setting chat.permissionMode): each adapter maps them to its agent's.
const (
	// ModeDefault asks before edits and commands.
	ModeDefault = "default"
	// ModeAcceptEdits makes edits in the working directory without asking.
	ModeAcceptEdits = "acceptEdits"
	// ModePlan plans first and asks to approve the plan.
	ModePlan = "plan"
	// ModeFull asks for nothing: full access.
	ModeFull = "full"
)

// Modes lists the permission modes, ModeDefault first.
var Modes = []string{ModeDefault, ModeAcceptEdits, ModePlan, ModeFull}

// Request is the one line a client sends after the host's Hello.
type Request struct {
	Op string `json:"op"`
	// Kinds are the agents OpAgents asks about.
	Kinds []string `json:"kinds,omitempty"`
	// Kind is the agent of OpNew and OpSessions.
	Kind string `json:"kind,omitempty"`
	// Cwd is the working directory of OpNew's chat, an absolute path, and
	// the directory whose sessions OpSessions lists.
	Cwd string `json:"cwd,omitempty"`
	// Resume is the agent's id of a session OpNew takes up instead of
	// making one.
	Resume string `json:"resume,omitempty"`
	// Import also brings Resume's earlier conversation into the new chat's
	// log, as stored events before the first of its own.
	Import bool `json:"import,omitempty"`
	// Options are what OpNew's chat starts with.
	Options *Options `json:"options,omitempty"`
	// Chat is the chat of OpAttach, OpClose, OpDelete and OpSeen.
	Chat string `json:"chat,omitempty"`
	// From is the last sequence number an attaching client has: the stored
	// events after it are sent.
	From uint64 `json:"from,omitempty"`
	// Seq is what OpSeen tells the user saw.
	Seq uint64 `json:"seq,omitempty"`
	// Cursor is the NextCursor of the page before, for OpSessions.
	Cursor string `json:"cursor,omitempty"`
	// Settings are OpConfigure's.
	Settings *HostSettings `json:"settings,omitempty"`
}

// Response is the host's answer to a Request: OK with the members of the
// operation, or Error.
type Response struct {
	OK    bool   `json:"ok,omitempty"`
	Error *Error `json:"error,omitempty"`
	// Agents answers OpAgents, one for each kind asked about.
	Agents []AgentStatus `json:"agents,omitzero"`
	// Chats answers OpChats.
	Chats []Chat `json:"chats,omitzero"`
	// Chat answers OpNew and OpAttach.
	Chat *Chat `json:"chat,omitempty"`
	// First answers OpAttach: the lowest sequence number still stored, or
	// the next one's when none is. A client whose From is lower than
	// First-1 missed events.
	First uint64 `json:"first,omitempty"`
	// Sessions and NextCursor answer OpSessions; NextCursor is "" on the
	// last page.
	Sessions   []Session `json:"sessions,omitzero"`
	NextCursor string    `json:"nextCursor,omitempty"`
	// States answers OpWatch: the state of every chat, as OpChats orders
	// them.
	States []ChatState `json:"states,omitzero"`
}

// The reasons of an AgentStatus that is not available.
const (
	// ReasonNotFound: the agent's program is not in the user's PATH.
	ReasonNotFound = "not_found"
	// ReasonUnsupported: the kind has no chat (no Chat spec), or the
	// program is a version the adapter cannot drive.
	ReasonUnsupported = "unsupported"
)

// AgentStatus tells whether an agent kind can be started.
type AgentStatus struct {
	Kind      string `json:"kind"`
	Available bool   `json:"available"`
	// Version is the program's version, when it tells.
	Version string `json:"version,omitempty"`
	// Reason is why the agent is not available.
	Reason string `json:"reason,omitempty"`
}

// Session is a session an agent kept for a directory.
type Session struct {
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	Title     string `json:"title,omitempty"`
	// UpdatedAt is the time of the session's last activity.
	UpdatedAt time.Time `json:"updatedAt,omitzero"`
	// Chat is the host's chat that has this session, "" for none.
	Chat string `json:"chat,omitempty"`
}

// The states of a chat (Chat.State).
const (
	// StateStarting: the agent is being started and the session made.
	StateStarting = "starting"
	// StateIdle: the agent process runs; no turn does.
	StateIdle = "idle"
	// StateWorking: a turn runs.
	StateWorking = "working"
	// StateWaiting: a turn waits for a permission or a question nobody
	// answered yet.
	StateWaiting = "waiting"
	// StateSleeping: no agent process (stopped when idle, or by a host
	// that ended); the next prompt resumes the session by its id.
	StateSleeping = "sleeping"
	// StateFailed: the agent could not start or ended unexpectedly;
	// Chat.Error says why.
	StateFailed = "failed"
	// StateClosed: the user closed the chat (OpClose).
	StateClosed = "closed"
)

// The statuses of a chat (Chat.Status): what notifications and the UIs'
// dots show, the vocabulary of the agents in terminals.
const (
	// StatusWorking: a turn runs (StateWorking).
	StatusWorking = "working"
	// StatusBlocked: a permission or a question waits (StateWaiting).
	StatusBlocked = "blocked"
	// StatusDone: a turn ended after what the user saw (Chat.Seen), and
	// nobody saw it yet.
	StatusDone = "done"
	// StatusIdle: anything else.
	StatusIdle = "idle"
)

// StatusOf is the status of a chat in state whose last turn ended at the
// sequence number turnEnd (0 for none) and that the user saw up to seen.
func StatusOf(state string, turnEnd, seen uint64) string {
	switch {
	case state == StateWorking:
		return StatusWorking
	case state == StateWaiting:
		return StatusBlocked
	case turnEnd > seen:
		return StatusDone
	}
	return StatusIdle
}

// chatID is the form of the host's chat ids.
var chatID = regexp.MustCompile(`^c[0-9a-f]{16}$`)

// ValidChatID reports whether s is a chat id as the host makes them: "c"
// and 16 lower-case hexadecimal digits.
func ValidChatID(s string) bool { return chatID.MatchString(s) }

// NewChatID returns a new random chat id.
func NewChatID() string {
	var b [8]byte
	rand.Read(b[:])
	return "c" + hex.EncodeToString(b[:])
}

// Chat is a conversation with an agent, as the host knows it.
type Chat struct {
	ID string `json:"id"`
	// Kind is the agent's kind (internal/agentkinds).
	Kind  string `json:"kind"`
	Title string `json:"title"`
	Cwd   string `json:"cwd"`
	// SessionID is the agent's id of the session; "" until it exists.
	SessionID string `json:"sessionId"`
	State     string `json:"state"`
	Status    string `json:"status"`
	// Error is why the chat is in StateFailed.
	Error   *Error    `json:"error,omitempty"`
	Created time.Time `json:"created"`
	// Updated is the time of the chat's last stored event.
	Updated time.Time `json:"updated"`
	// Seq is the sequence number of the chat's last stored event.
	Seq uint64 `json:"seq"`
	// Seen is the last sequence number the user saw (OpSeen).
	Seen uint64 `json:"seen"`
	// Closed is when the chat was closed (StateClosed); the host's
	// retention counts from it.
	Closed time.Time `json:"closed,omitzero"`
	// HandedOff: the session went on in a terminal (OpHandoff); what it
	// did there is brought into the log when the chat takes a prompt
	// again.
	HandedOff bool `json:"handedOff,omitempty"`
	// AgentVersion is the version of the agent's program.
	AgentVersion string `json:"agentVersion,omitempty"`
	// Config are the session's configuration options with their current
	// values: model, effort, mode and the agent's own.
	Config []ConfigOption `json:"config,omitempty"`
	// Commands are the slash commands the agent offers.
	Commands []SlashCommand `json:"commands,omitempty"`
	// Usage is the session's context and cost, once known.
	Usage *Usage `json:"usage,omitempty"`
	// Capabilities are what the chat's agent can do.
	Capabilities Capabilities `json:"capabilities"`
}

// StateOf is what OpWatch tells of the chat.
func (c *Chat) StateOf() ChatState {
	return ChatState{ID: c.ID, Kind: c.Kind, Title: c.Title, Cwd: c.Cwd, State: c.State, Status: c.Status,
		Updated: c.Updated, Seq: c.Seq, SessionID: c.SessionID}
}

// ChatState is what OpWatch tells of a chat.
type ChatState struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Title     string    `json:"title"`
	Cwd       string    `json:"cwd"`
	State     string    `json:"state"`
	Status    string    `json:"status"`
	Updated   time.Time `json:"updated"`
	Seq       uint64    `json:"seq"`
	SessionID string    `json:"sessionId"`
}

// Capabilities are what a chat's agent can do, for the UIs to offer.
type Capabilities struct {
	// Images: prompts may carry image blocks.
	Images bool `json:"images"`
	// Compact: OpCompact.
	Compact bool `json:"compact"`
	// Queue: OpPrompt while a turn runs (EventQueued).
	Queue bool `json:"queue"`
	// Plan: the agent plans and asks to approve the plan (PermissionPlan).
	Plan bool `json:"plan"`
	// Questions: the agent asks the user questions (EventQuestion).
	Questions bool `json:"questions"`
	// Effort and Model: the chat has a ConfigOption of that category.
	Effort bool `json:"effort"`
	Model  bool `json:"model"`
	// CancelQueued: OpCancelQueued.
	CancelQueued bool `json:"cancelQueued"`
}

// The categories of a ConfigOption the UIs know; others are the agents'.
const (
	CategoryMode         = "mode"
	CategoryModel        = "model"
	CategoryThoughtLevel = "thought_level"
)

// ConfigSelect is the type of a ConfigOption with values to choose from,
// the only one there is.
const ConfigSelect = "select"

// ConfigOption is a session configuration option, in the shape of the
// Agent Client Protocol's: the effort is the category thought_level.
// Values of an agent's grouped options are listed one after the other.
type ConfigOption struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// Category is CategoryMode, CategoryModel, CategoryThoughtLevel or an
	// agent's own.
	Category     string        `json:"category,omitempty"`
	Type         string        `json:"type"`
	CurrentValue string        `json:"currentValue"`
	Options      []ConfigValue `json:"options"`
}

// ConfigValue is a value of a ConfigOption.
type ConfigValue struct {
	Value       string `json:"value"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// SlashCommand is a command the agent takes as a prompt "/<name> ...".
type SlashCommand struct {
	Name         string `json:"name"`
	Description  string `json:"description,omitempty"`
	ArgumentHint string `json:"argumentHint,omitempty"`
}

// Usage is a session's context window and cost.
type Usage struct {
	// Used and Size are the context window's tokens in use and in all;
	// Size is 0 while unknown.
	Used int64 `json:"used"`
	Size int64 `json:"size"`
	// Percentage is the agent's own measure of the context in use, when it
	// gives one; else Used/Size.
	Percentage float64 `json:"percentage,omitempty"`
	// Cost is the session's cost so far.
	Cost *Cost `json:"cost,omitempty"`
	// Limits are the subscription's rate limit windows the agent reports.
	Limits []Limit `json:"limits,omitempty"`
}

// Cost is an amount of money.
type Cost struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
}

// Limit is a rate limit window of the agent's subscription.
type Limit struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
	// UsedPercent is how much of the window's allowance is used, 0 to 100.
	UsedPercent float64 `json:"usedPercent"`
	// ResetsAt is when the window starts again, in seconds since the
	// epoch; 0 when unknown.
	ResetsAt int64 `json:"resetsAt,omitempty"`
	// WindowMinutes is the window's length.
	WindowMinutes int `json:"windowMinutes,omitempty"`
}

// The bounds of HostSettings: their defaults, and the least and the most
// each may be (what the core's settings offer, internal/plugins/chat, and
// what Clamp enforces whatever is asked).
const (
	IdleStopMinutesDefault, IdleStopMinutesMin, IdleStopMinutesMax = 30, 5, 1440
	MaxLiveDefault, MaxLiveMin, MaxLiveMax                         = 8, 1, 32
	MaxChatsDefault, MaxChatsMin, MaxChatsMax                      = 500, 50, 2000
	RetentionDaysDefault, RetentionDaysMin, RetentionDaysMax       = 30, 1, 365
	MaxTotalMBDefault, MaxTotalMBMin, MaxTotalMBMax                = 512, 64, 2048
	MaxChatMBDefault, MaxChatMBMin, MaxChatMBMax                   = 64, 8, 256
)

// HostSettings are the core's settings for a machine's chat host
// (OpConfigure). A zero member means its default.
type HostSettings struct {
	// IdleStopMinutes: an agent process with no turn and nothing waiting
	// for this long is ended; its chat sleeps.
	IdleStopMinutes int `json:"idleStopMinutes,omitempty"`
	// MaxLive: the most agent processes at once; one more ends the one
	// idle the longest.
	MaxLive int `json:"maxLive,omitempty"`
	// MaxChats: the most chats kept; the oldest closed ones go first.
	MaxChats int `json:"maxChats,omitempty"`
	// RetentionDays: a closed chat is kept this long.
	RetentionDays int `json:"retentionDays,omitempty"`
	// MaxTotalBytes: the most bytes of every chat's log together; the
	// oldest closed chats go first.
	MaxTotalBytes int64 `json:"maxTotalBytes,omitempty"`
	// MaxChatBytes: the most bytes of a chat's log; its oldest events go
	// first.
	MaxChatBytes int64 `json:"maxChatBytes,omitempty"`
	// DefaultMode is the permission mode of a chat whose Options name none
	// (Modes).
	DefaultMode string `json:"defaultMode,omitempty"`
}

// DefaultHostSettings are the settings of a host nobody configured.
func DefaultHostSettings() HostSettings { return HostSettings{}.Clamp() }

const mib = 1 << 20

// Clamp returns s with each member within its bounds: a zero member its
// default, one out of its bounds the nearest bound, and a DefaultMode
// that is no mode ModeDefault.
func (s HostSettings) Clamp() HostSettings {
	s.IdleStopMinutes = clamp(s.IdleStopMinutes, IdleStopMinutesDefault, IdleStopMinutesMin, IdleStopMinutesMax)
	s.MaxLive = clamp(s.MaxLive, MaxLiveDefault, MaxLiveMin, MaxLiveMax)
	s.MaxChats = clamp(s.MaxChats, MaxChatsDefault, MaxChatsMin, MaxChatsMax)
	s.RetentionDays = clamp(s.RetentionDays, RetentionDaysDefault, RetentionDaysMin, RetentionDaysMax)
	s.MaxTotalBytes = clamp(s.MaxTotalBytes, MaxTotalMBDefault*mib, MaxTotalMBMin*mib, MaxTotalMBMax*mib)
	s.MaxChatBytes = clamp(s.MaxChatBytes, MaxChatMBDefault*mib, MaxChatMBMin*mib, MaxChatMBMax*mib)
	if !slices.Contains(Modes, s.DefaultMode) {
		s.DefaultMode = ModeDefault
	}
	return s
}

func clamp[T int | int64](v, def, lo, hi T) T {
	switch {
	case v == 0:
		return def
	case v < lo:
		return lo
	case v > hi:
		return hi
	}
	return v
}

// The types of an Event.
const (
	// EventUpdate: a session update in the shape of the Agent Client
	// Protocol's (the update member of a session/update's params), in
	// Event.Update.
	EventUpdate = "update"
	// EventUser: a prompt as the host accepted it, in Event.Content, with
	// the page's Event.ClientID.
	EventUser = "user"
	// EventTurn: a turn started, ended (Event.StopReason) or failed
	// (Event.Error); Event.State is TurnStart, TurnEnd or TurnError.
	EventTurn = "turn"
	// EventPermission: the agent asks the permission Event.ID, of
	// Event.Kind, for Event.ToolCall, to be answered with one of
	// Event.Options.
	EventPermission = "permission"
	// EventPermissionDone: the permission Event.ID was answered with
	// Event.Outcome, by Event.By.
	EventPermissionDone = "permission_done"
	// EventQuestion: the agent asks the user Event.Questions, together as
	// the question Event.ID.
	EventQuestion = "question"
	// EventQuestionDone: the question Event.ID was answered with
	// Event.Answers, by Event.By; no answers when it was skipped or
	// cancelled.
	EventQuestionDone = "question_done"
	// EventQueued: a message sent while a turn ran, Event.Message with
	// Event.Content and the page's Event.ClientID, is in Event.State:
	// QueuedWaiting, QueuedTaken or QueuedCancelled.
	EventQueued = "queued"
	// EventState: the chat is in Event.State now, for Event.Error.
	EventState = "state"
	// EventInfo: the chat as it is now, in Event.Chat: once the session
	// exists, and when the host changed what a Chat states.
	EventInfo = "info"
	// EventNotice: something of the session that is no session update, in
	// Event.Method (an extension method, "_<product slug>/<name>", as
	// agentproto.NoticeMethod makes them) and Event.Params.
	EventNotice = "notice"
	// EventAck: the answer to the Command Event.ID, with Event.Error when it
	// was refused. Acks have no sequence number and are not stored.
	EventAck = "ack"
)

// The states of an EventTurn.
const (
	TurnStart = "start"
	TurnEnd   = "end"
	TurnError = "error"
)

// The states of an EventQueued.
const (
	// QueuedWaiting: the message waits for the turn to take it.
	QueuedWaiting = "queued"
	// QueuedTaken: the agent took the message, into the running turn or
	// as the next one.
	QueuedTaken = "taken"
	// QueuedCancelled: the message was withdrawn (OpCancelQueued,
	// OpCancel) and never reached the agent.
	QueuedCancelled = "cancelled"
)

// The kinds of a permission (Event.Kind).
const (
	// PermissionTool: a tool call of another kind.
	PermissionTool = "tool"
	// PermissionCommand: a command to run.
	PermissionCommand = "command"
	// PermissionFile: a change of files.
	PermissionFile = "file"
	// PermissionPlan: the approval of a plan; its options name the mode
	// to go on in (chatadapter.OptionPlanPrefix).
	PermissionPlan = "plan"
	// PermissionMCP: a tool of an MCP server.
	PermissionMCP = "mcp"
	// PermissionOther: anything else.
	PermissionOther = "other"
)

// Who answered a permission or a question (Event.By).
const (
	// ByUser: a client's OpPermission or OpAnswer.
	ByUser = "user"
	// ByCancel: the turn was cancelled.
	ByCancel = "cancel"
	// ByEnded: the turn or the chat ended.
	ByEnded = "ended"
)

// Event is a line of an attached connection: something a chat did, or the
// answer to a command.
//
// A stored event has a sequence number and stays in the chat's log within
// the host's limits. A live event (Live) is an increment of an item being
// streamed (text, a thought, a tool's input or a command's output): it has
// no sequence number, goes only to the clients attached at the time and is
// never stored. Once an item is complete, or changes otherwise, the host
// stores one event with its whole content under the same Item: a client
// replaces what it accumulated live for that Item with it. A client that
// attaches again gets the stored events after its From and discards the
// items it has only live increments of.
type Event struct {
	// Seq numbers a chat's stored events from 1; none for a live event or
	// an ack.
	Seq uint64 `json:"seq,omitempty"`
	// T is the event's type.
	T  string    `json:"t"`
	At time.Time `json:"at,omitzero"`
	// ID is the permission's (EventPermission, EventPermissionDone), the
	// question's (EventQuestion, EventQuestionDone) or the command's
	// (EventAck).
	ID string `json:"id,omitempty"`
	// Live marks a streaming increment.
	Live bool `json:"live,omitempty"`
	// Item is the id of the item an EventUpdate belongs to: a message, a
	// thought, a tool call.
	Item string `json:"item,omitempty"`
	// Parent is the tool call id of the subagent the event belongs to, ""
	// for the main agent's.
	Parent string `json:"parent,omitempty"`

	// Update is the session update (EventUpdate).
	Update json.RawMessage `json:"update,omitempty"`
	// Content are a prompt's content blocks (EventUser, EventQueued).
	Content []json.RawMessage `json:"content,omitempty"`
	// ClientID is the page's id of the message (Command.ClientID) for
	// EventUser and EventQueued.
	ClientID string `json:"clientId,omitempty"`
	// Message is the host's id of a queued message (EventQueued), which
	// OpCancelQueued names.
	Message string `json:"message,omitempty"`
	// State is the turn's (EventTurn), the chat's (EventState) or the
	// queued message's (EventQueued).
	State      string `json:"state,omitempty"`
	StopReason string `json:"stopReason,omitempty"`
	Error      *Error `json:"error,omitempty"`
	// Kind is a permission's: PermissionTool, PermissionCommand,
	// PermissionFile, PermissionPlan, PermissionMCP or PermissionOther.
	Kind string `json:"kind,omitempty"`
	// ToolCall and Options are what a permission is asked for, as an ACP
	// tool call, and the answers to choose from (EventPermission); Outcome
	// and By how it was answered (EventPermissionDone).
	ToolCall json.RawMessage    `json:"toolCall,omitempty"`
	Options  []PermissionOption `json:"options,omitempty"`
	Outcome  *Outcome           `json:"outcome,omitempty"`
	By       string             `json:"by,omitempty"`
	// Questions are what EventQuestion asks; Answers what
	// EventQuestionDone was answered, by Question.ID.
	Questions []Question          `json:"questions,omitempty"`
	Answers   map[string][]string `json:"answers,omitempty"`
	// Chat is the chat as it is now (EventInfo).
	Chat *Chat `json:"chat,omitempty"`
	// Method and Params are a notice's (EventNotice).
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
}

// The kinds of a PermissionOption.
const (
	AllowOnce    = "allow_once"
	AllowAlways  = "allow_always"
	RejectOnce   = "reject_once"
	RejectAlways = "reject_always"
)

// PermissionOption is an answer a user may give to a permission.
type PermissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	// Kind is AllowOnce, AllowAlways, RejectOnce or RejectAlways.
	Kind string `json:"kind"`
}

// The outcomes of a permission (Outcome.Outcome).
const (
	OutcomeSelected  = "selected"
	OutcomeCancelled = "cancelled"
)

// Outcome is how a permission was answered.
type Outcome struct {
	Outcome  string `json:"outcome"`
	OptionID string `json:"optionId,omitempty"`
}

// Question is one question of an EventQuestion.
type Question struct {
	ID string `json:"id"`
	// Header is a short label of the question (a chip, a tab).
	Header   string `json:"header,omitempty"`
	Question string `json:"question"`
	// MultiSelect: more than one option may be chosen.
	MultiSelect bool `json:"multiSelect,omitempty"`
	// AllowOther: an answer of the user's own words may be given.
	AllowOther bool `json:"allowOther,omitempty"`
	// Secret: the answer is not to be shown as typed (a password).
	Secret  bool             `json:"secret,omitempty"`
	Options []QuestionOption `json:"options,omitempty"`
}

// QuestionOption is an answer to choose. Answers name options by Label.
type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	// Preview is what choosing it would look like (Markdown).
	Preview string `json:"preview,omitempty"`
}

// Command is a line a client sends while attached. ID is the client's, and
// comes back in the command's ack.
type Command struct {
	Op string `json:"op"`
	ID string `json:"id"`
	// Content are the content blocks of OpPrompt, as the Agent Client
	// Protocol defines them: text, image {mimeType, data} (at most
	// MaxImage bytes each) and resource_link (a file named with @); at
	// most MaxPrompt bytes in all.
	Content []json.RawMessage `json:"content,omitempty"`
	// ClientID is the page's id of OpPrompt's message, given back in its
	// EventUser or EventQueued.
	ClientID string `json:"clientId,omitempty"`
	// Request is the permission OpPermission answers, the question
	// OpAnswer answers.
	Request string `json:"request,omitempty"`
	// Option is the optionId chosen (OpPermission).
	Option string `json:"option,omitempty"`
	// Answers are OpAnswer's, by Question.ID: option labels, or the
	// user's own words for a question that allows them.
	Answers map[string][]string `json:"answers,omitempty"`
	// Cancelled answers a permission without an option, or skips a
	// question.
	Cancelled bool `json:"cancelled,omitempty"`
	// Config and Value are the option OpSetConfig sets and its value.
	Config string `json:"config,omitempty"`
	Value  string `json:"value,omitempty"`
	// Message is the queued message OpCancelQueued withdraws.
	Message string `json:"message,omitempty"`
	// Title is OpRename's.
	Title string `json:"title,omitempty"`
}

// The codes of an Error.
const (
	// CodeBadRequest: the request, the command or the chat's directory is
	// not what the protocol asks for.
	CodeBadRequest = "bad_request"
	// CodeUnknownChat: the host has no such chat.
	CodeUnknownChat = "unknown_chat"
	// CodeTooMany: the host keeps as many chats as its settings allow and
	// none can go.
	CodeTooMany = "too_many"
	// CodeBusy: a turn runs, the chat still starts, or a chat works or
	// waits (OpShutdown).
	CodeBusy = "busy"
	// CodeNotFound: the agent's program, the session, the permission or
	// the question is not there.
	CodeNotFound = "not_found"
	// CodeStartFailed: the agent did not start or made no session.
	CodeStartFailed = "start_failed"
	// CodeProtocol: the agent speaks another version of its protocol.
	CodeProtocol = "protocol"
	// CodeAuthRequired: the agent wants the user to sign in first.
	CodeAuthRequired = "auth_required"
	// CodeUnsupported: the agent lacks the capability.
	CodeUnsupported = "unsupported"
	// CodeTooLarge: a line longer than MaxLine, a prompt over MaxPrompt or
	// an image over MaxImage.
	CodeTooLarge = "too_large"
	// CodeEnded: the chat's agent is gone.
	CodeEnded = "ended"
	// CodeFailed: the agent answered with an error, or not at all.
	CodeFailed = "failed"
	// CodeInTerminal: the session runs in a terminal; two processes do not
	// write one session.
	CodeInTerminal = "in_terminal"
	// CodeHandedOff: the chat's session went on in a terminal (OpHandoff)
	// and the command needs its agent process.
	CodeHandedOff = "handed_off"
	// CodeSleeping: the chat has no agent process (StateSleeping,
	// StateClosed) and the command needs one; a prompt resumes it.
	CodeSleeping = "sleeping"
)

// Error is why a request, a command, a turn or a chat failed. Message is
// for logs and for a reader who wants the detail; programs go by Code.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	// Stderr is the end of what the agent wrote to its standard error, for
	// a chat that failed.
	Stderr string `json:"stderr,omitempty"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// ErrTooLarge is ReadLine's error for a line longer than MaxLine.
var ErrTooLarge = errors.New("chatproto: line longer than MaxLine (16 MiB)")

// ReadLine reads the next line, without its newline; the line is the
// caller's to keep. It never holds more than MaxLine bytes of a line: a
// longer one is answered with ErrTooLarge as soon as it is known to be,
// with its end, the newline at least, still to be read. A reader that goes
// on after that reads up to the newline first. What comes before the end of
// the input without a newline is no line.
func ReadLine(r *bufio.Reader) ([]byte, error) {
	return readLine(r, MaxLine)
}

func readLine(r *bufio.Reader, limit int) ([]byte, error) {
	var line []byte
	for {
		part, err := r.ReadSlice('\n')
		if n := len(part); n > 0 && part[n-1] == '\n' {
			part = part[:n-1]
		}
		if len(line)+len(part) > limit {
			if err == nil {
				r.UnreadByte() // the newline
			}
			return nil, ErrTooLarge
		}
		line = append(line, part...)
		switch err {
		case nil:
			return line, nil
		case bufio.ErrBufferFull:
		default:
			return nil, err
		}
	}
}

// Line is v as one line with its newline. Raw members are written as they
// are but for insignificant space, and the characters of HTML are not
// escaped.
func Line(v any) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}
