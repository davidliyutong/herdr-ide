// Package chatadapter is the seam between the chat host
// (internal/chathost) and the adapters that drive coding agents headless:
// Claude Code's SDK protocol ("claude"), Codex's app-server ("codex") and
// the Agent Client Protocol ("acp"), the names of agentkinds.ChatSpec's
// Adapter. An adapter registers itself (Register) from its package's init;
// the host looks it up by the name of the chat's kind (Lookup). The host
// owns chats, their logs, clients, limits and every process lifetime
// decision; an adapter owns one agent process per Session and turns its
// protocol into chatproto events.
//
// Every adapter follows these rules, which the spikes against the agents
// showed to be needed:
//
//   - It runs Argv as given (argv[0] is absolute; the host resolved it
//     from the kind's Chat spec) with Env as the whole environment, adding
//     only its protocol's own variables. It never takes a command line,
//     a path to run or an environment variable from a client.
//   - It answers every request of the agent it does not serve with its
//     protocol's "method not found" (JSON-RPC -32601), never by dropping
//     it: an agent that is not answered waits (opencode asks
//     fs/write_text_file although the client said it does not write
//     files).
//   - It passes over frames, notifications, members and values it does
//     not know, logging their kinds once, and never fails a turn for one;
//     a vendor's notification it has no mapping for becomes no event.
//   - It ignores answers to requests it did not make (Claude Code echoes
//     the control responses it is sent) and routes the agent's own
//     requests by their method, not their id (Codex numbers its requests
//     from 0 too).
//   - It never writes the user's configuration: Codex threads start and
//     resume with sandbox "read-only" and get their real policy per turn
//     (a thread started with "workspace-write" adds the directory to
//     ~/.codex/config.toml as trusted); Claude Code's "allow for this
//     session" sends only the addRules suggestions, with their destination
//     rewritten to "session" (a setMode suggestion would switch the mode);
//     models and efforts are set through the protocol, never by a slash
//     command that saves them.
//   - It ends the agent gracefully: Close closes the agent's input, then
//     sends SIGTERM to its process group, and SIGKILL only after a grace
//     period (Codex killed outright leaves its shell snapshots behind).
//     It starts the agent in a process group of its own, so that a
//     command the agent left running goes with it.
//   - It never blocks the agent's output on the host: Sink.Event returns
//     at once; Sink.Permission and Sink.Question block the request that
//     asked, not the reading of the agent's output.
//   - It sends what streams (text, thoughts, a tool's input, a command's
//     output) as live events (chatproto.Event.Live) and, once an item is
//     complete or changes otherwise, one event with the item's whole
//     content under the same Item: only those are stored.
//   - It tells each prompt once: the host stores the EventUser of a
//     prompt it believes starts a turn (PromptParams.Recorded). Whether a
//     turn runs is the adapter's to know, decided under its own lock: a
//     prompt not Recorded that starts a turn gets its EventUser (Content,
//     ClientID) from the adapter before the turn's start; a Recorded one
//     that finds a turn running is told as EventQueued with its ClientID,
//     which the UIs merge with the stored EventUser.
//   - It may call the Sink from any goroutine, with locks of its own
//     held: the host never calls a Session method while holding a lock
//     its Sink methods take.
//
// A Session may also have a method PID() int: the id of its agent's
// process, the leader of the agent's process group (0 while none runs).
// The host asserts it to signal the group itself: SIGKILL when the agent
// outlives Close's grace, SIGTERM and then SIGKILL when the host is told
// to stop at once (a signal of the terminal core).
//
// Errors an adapter returns are *chatproto.Error when it knows the code
// (CodeUnsupported for what the agent cannot do, CodeAuthRequired,
// CodeProtocol, CodeBusy, CodeNotFound); the host answers any other error
// as CodeFailed.
package chatadapter

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"sync"

	"herdr-ide/internal/chatproto"
)

// Adapter drives one protocol of coding agents.
type Adapter interface {
	// Start runs the agent for a chat: a new session, or Resume's. It
	// returns once the session exists (its id known) or failed; the
	// session's events then go to sink until it is Done. ctx bounds the
	// start only: the session lives until Close or the agent's end.
	Start(ctx context.Context, p StartParams, sink Sink) (Session, error)
	// Sessions lists the sessions the agent kept for a directory, a page
	// at a time (next is "" on the last), the most recent first. It may
	// start a short-lived agent process to ask.
	Sessions(ctx context.Context, p SessionsParams) (sessions []chatproto.Session, next string, err error)
	// History emits the stored events of a session's earlier conversation
	// (an import), oldest first: the events the chat's log would hold had
	// the chat run it, without sequence numbers, never live ones.
	History(ctx context.Context, p HistoryParams, emit func(chatproto.Event)) error
}

// Session is an agent process running one session.
type Session interface {
	// ID is the agent's id of the session.
	ID() string
	// Prompt starts a turn with p.Content, or, while one runs, queues it
	// for the agent or steers it into the running turn (an EventQueued
	// under p.Message tells which, and when the agent took it).
	Prompt(ctx context.Context, p PromptParams) error
	// Cancel cancels the running turn; what waits on the agent's side
	// (its permission requests) ends with it.
	Cancel(ctx context.Context) error
	// CancelQueued withdraws the queued message of that id (a
	// PromptParams.Message) before the agent took it.
	CancelQueued(ctx context.Context, message string) error
	// SetConfig sets the configuration option id (a chatproto.ConfigOption
	// of the chat) to value, one of its values.
	SetConfig(ctx context.Context, id, value string) error
	// Compact compacts the conversation's context.
	Compact(ctx context.Context) error
	// Close ends the agent process gracefully; Done is closed once it is
	// gone.
	Close(ctx context.Context) error
	// Done is closed when the agent process ended, for whatever reason.
	Done() <-chan struct{}
	// Err is why the session ended: nil after Close, else what ended it
	// (the agent's exit, a protocol error). Valid once Done is closed.
	Err() error
}

// Sink is where a Session reports to the host.
type Sink interface {
	// Event hands on an event: stored or live (chatproto.Event.Live); the
	// host numbers, stores and fans out. It does not block for long.
	Event(ev chatproto.Event)
	// Permission asks the user, and blocks until answered or ctx ends; an
	// answer of the user, the turn's cancel (Cancelled) or the chat's end
	// (an error).
	Permission(ctx context.Context, r PermissionRequest) (PermissionAnswer, error)
	// Question asks the user questions, as Permission does.
	Question(ctx context.Context, r QuestionRequest) (QuestionAnswer, error)
	// Update changes what the chat states (its session id, title,
	// configuration options, slash commands, usage, capabilities, the
	// agent's version) under the host's lock: fn changes c and returns.
	Update(fn func(c *chatproto.Chat))
}

// ClientInfo names the client to an agent (the product's name and
// version, from internal/brand and agentproto.Version).
type ClientInfo struct {
	Name    string
	Version string
}

// StartParams are what Start runs.
type StartParams struct {
	// Kind is the chat's agent kind (internal/agentkinds).
	Kind string
	// Argv is the kind's Chat spec's command, argv[0] resolved to an
	// absolute path.
	Argv []string
	// Env is the agent's whole environment: the user's login shell's,
	// without the variables of the terminal core's own terminal and of
	// ssh, with the Chat spec's Env added.
	Env []string
	// Cwd is the session's working directory, an absolute path that
	// exists.
	Cwd string
	// Resume is the session to take up; "" for a new one.
	Resume string
	// SessionID is the id the host chose for a new session, a lower-case
	// UUID, for an agent that takes one (Claude Code's --session-id); an
	// adapter whose agent makes its own ignores it.
	SessionID string
	// NewSessionMeta is the Chat spec's _meta for ACP's session/new.
	NewSessionMeta json.RawMessage
	// Options are what the chat starts with; Mode is the setting's default
	// when the chat named none.
	Options chatproto.Options
	Client  ClientInfo
	// Settings are the host's settings, clamped.
	Settings chatproto.HostSettings
	Logger   *log.Logger
}

// SessionsParams are what Sessions lists.
type SessionsParams struct {
	Kind string
	// Argv and Env are as StartParams', for an adapter that asks the agent.
	Argv []string
	Env  []string
	// Cwd is the directory whose sessions are listed.
	Cwd string
	// Cursor is the next of the page before; "" for the first.
	Cursor string
	Logger *log.Logger
}

// HistoryParams are the session whose conversation History emits.
type HistoryParams struct {
	Kind string
	// Argv and Env are as StartParams', for an adapter that asks the agent.
	Argv      []string
	Env       []string
	Cwd       string
	SessionID string
	// After is the Item of the last event an earlier History of this
	// session emitted: only what came after it is emitted (the turns the
	// session made in a terminal after a handoff). "" emits the whole
	// conversation.
	After  string
	Logger *log.Logger
}

// PromptParams are a message of the user.
type PromptParams struct {
	// Content are ACP content blocks (text, image, resource_link), checked
	// by the host against chatproto.MaxPrompt and chatproto.MaxImage.
	Content []json.RawMessage
	// Message is the host's id of the message, which EventQueued and
	// CancelQueued name.
	Message string
	// ClientID is the page's id of the message, for EventUser and
	// EventQueued.
	ClientID string
	// Recorded: the host stored the prompt's EventUser, believing that no
	// turn ran. An adapter that finds a turn running queues the message
	// (EventQueued with ClientID). Without it, the host believed a turn
	// ran: an adapter that finds none emits the EventUser (Content,
	// ClientID) itself, before the turn's start.
	Recorded bool
}

// PermissionRequest is a permission the agent asks.
type PermissionRequest struct {
	// Kind is chatproto.PermissionTool, PermissionCommand, PermissionFile,
	// PermissionPlan, PermissionMCP or PermissionOther.
	Kind string
	// ToolCall is what is asked for, as an ACP ToolCall (toolCallId,
	// title, kind, status, content with a diff or the command, locations,
	// rawInput).
	ToolCall json.RawMessage
	// Options are the answers to choose from: the agent's own (ACP), or
	// the host's for an agent without them (OptionAllowOnce ...).
	Options []chatproto.PermissionOption
	// Parent is the tool call id of the subagent that asks, "" for the
	// main agent.
	Parent string
}

// PermissionAnswer is the user's answer to a permission.
type PermissionAnswer struct {
	// Option is the optionId chosen; "" when Cancelled.
	Option    string
	Cancelled bool
}

// QuestionRequest is questions the agent asks the user.
type QuestionRequest struct {
	Questions []chatproto.Question
	// ToolCall is the tool call that asks, as an ACP ToolCall, when there
	// is one.
	ToolCall json.RawMessage
	Parent   string
}

// QuestionAnswer is the user's answers, by chatproto.Question.ID: option
// labels or the user's own words. Cancelled when the user skipped them.
type QuestionAnswer struct {
	Answers   map[string][]string
	Cancelled bool
}

// The permission options the host shows for an agent that has none of its
// own (Claude Code, Codex), by optionId: adapters offer these, and the UIs
// know them.
const (
	// OptionAllowOnce allows this call.
	OptionAllowOnce = "allow_once"
	// OptionAllowSession allows calls like it for the rest of the session,
	// without writing a setting (kind allow_always).
	OptionAllowSession = "allow_session"
	// OptionRejectOnce refuses this call.
	OptionRejectOnce = "reject_once"
	// OptionPlanPrefix starts the options of a plan's approval
	// (chatproto.PermissionPlan): "plan:<mode>" approves the plan and goes
	// on in that mode (a chatproto.Modes value other than ModePlan);
	// OptionRejectOnce keeps planning.
	OptionPlanPrefix = "plan:"
)

// PlanOption is the option that approves a plan and goes on in mode.
func PlanOption(mode string) string { return OptionPlanPrefix + mode }

var (
	mu       sync.Mutex
	adapters = map[string]Adapter{}
)

// Register adds an adapter under name; packages call it from init. A name
// registered twice, or an empty one, panics.
func Register(name string, a Adapter) {
	mu.Lock()
	defer mu.Unlock()
	if name == "" || a == nil {
		panic("chatadapter: an adapter without a name")
	}
	if _, dup := adapters[name]; dup {
		panic("chatadapter: registered twice: " + name)
	}
	adapters[name] = a
}

// Lookup returns the adapter registered under name.
func Lookup(name string) (Adapter, bool) {
	mu.Lock()
	defer mu.Unlock()
	a, ok := adapters[name]
	return a, ok
}

// Names lists the registered adapters, sorted.
func Names() []string {
	mu.Lock()
	defer mu.Unlock()
	names := make([]string, 0, len(adapters))
	for n := range adapters {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}
