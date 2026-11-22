package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// ProtocolVersion is the major version of the protocol this client speaks.
const ProtocolVersion = 1

// ErrProtocolVersion is in the error of Initialize (errors.Is) when the
// agent answered with another protocol version than ProtocolVersion; the
// error names that version.
var ErrProtocolVersion = errors.New("acp: agent speaks a protocol version this client does not")

// The methods a client calls.
const (
	MethodInitialize             = "initialize"
	MethodAuthenticate           = "authenticate"
	MethodSessionNew             = "session/new"
	MethodSessionLoad            = "session/load"
	MethodSessionResume          = "session/resume"
	MethodSessionPrompt          = "session/prompt"
	MethodSessionCancel          = "session/cancel" // a notification
	MethodSessionSetMode         = "session/set_mode"
	MethodSessionSetConfigOption = "session/set_config_option"
	MethodSessionList            = "session/list"
)

// The methods of an agent that a Handler meets.
const (
	// MethodSessionUpdate is the notification of everything a session
	// does; its params are a SessionNotification.
	MethodSessionUpdate = "session/update"
	// MethodSessionRequestPermission is the request for the user's word on
	// a tool call; its params are a PermissionRequest, its result a
	// PermissionResponse.
	MethodSessionRequestPermission = "session/request_permission"
)

// Implementation names a client or an agent (clientInfo, agentInfo).
type Implementation struct {
	// Name is for programs, and for display when there is no Title.
	Name string `json:"name"`
	// Title is for people.
	Title   string `json:"title,omitempty"`
	Version string `json:"version"`
}

// initializeParams are the params of initialize. The capabilities are this
// package's to state, not the caller's: it serves none of the methods they
// would promise.
type initializeParams struct {
	ProtocolVersion    int                `json:"protocolVersion"`
	ClientCapabilities clientCapabilities `json:"clientCapabilities"`
	ClientInfo         Implementation     `json:"clientInfo"`
}

type clientCapabilities struct {
	FS struct {
		ReadTextFile  bool `json:"readTextFile"`
		WriteTextFile bool `json:"writeTextFile"`
	} `json:"fs"`
	Terminal bool `json:"terminal"`
}

// InitializeResult is the agent's answer to initialize.
type InitializeResult struct {
	// ProtocolVersion is the version the agent chose: the client's when
	// the agent speaks it, else the latest the agent speaks.
	ProtocolVersion   int               `json:"protocolVersion"`
	AgentCapabilities AgentCapabilities `json:"agentCapabilities"`
	// AgentInfo is empty for an agent that does not name itself.
	AgentInfo Implementation `json:"agentInfo"`
	// AuthMethods is the array of the ways to sign in, as the agent sent
	// it. The id of one whose type is agent (or that has no type) goes to
	// Authenticate.
	AuthMethods json.RawMessage `json:"authMethods,omitempty"`
	// Meta is the agent's own data (_meta), as it sent it.
	Meta json.RawMessage `json:"_meta,omitempty"`
}

// AgentCapabilities are an agent's capabilities, typed as far as a host
// decides by them. A capability left out is one the agent does not have.
type AgentCapabilities struct {
	// LoadSession: session/load is available.
	LoadSession        bool               `json:"loadSession,omitempty"`
	PromptCapabilities PromptCapabilities `json:"promptCapabilities"`
	// SessionCapabilities are the session methods beyond the baseline
	// (session/new, session/prompt, session/cancel, session/update).
	SessionCapabilities SessionCapabilities `json:"sessionCapabilities"`
	// Raw is the whole object as the agent sent it, with what is not typed
	// here; nil when the agent sent none. It is read, never encoded.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON keeps the object beside its typed members.
func (a *AgentCapabilities) UnmarshalJSON(b []byte) error {
	type typed AgentCapabilities
	var t typed
	if err := json.Unmarshal(b, &t); err != nil {
		return err
	}
	*a = AgentCapabilities(t)
	if present(b) {
		a.Raw = append(json.RawMessage(nil), b...)
	}
	return nil
}

// PromptCapabilities are the content blocks a prompt may hold beyond text
// and resource_link, which every agent takes.
type PromptCapabilities struct {
	// Image: image blocks.
	Image bool `json:"image,omitempty"`
	// Audio: audio blocks.
	Audio bool `json:"audio,omitempty"`
	// EmbeddedContext: resource blocks, a resource's contents in the
	// prompt.
	EmbeddedContext bool `json:"embeddedContext,omitempty"`
}

// SessionCapabilities are agentCapabilities.sessionCapabilities, as far as
// this package calls what they stand for.
type SessionCapabilities struct {
	// List: session/list is available.
	List Supported `json:"list,omitempty"`
	// Resume: session/resume is available, which takes up a session
	// without replaying it.
	Resume Supported `json:"resume,omitempty"`
}

// Supported is a capability the protocol states with an object, {} so far:
// the agent has it when the member is there and not null.
type Supported bool

// UnmarshalJSON takes any value but null and false for the capability:
// the object may get members.
func (s *Supported) UnmarshalJSON(b []byte) error {
	*s = Supported(present(b) && string(b) != "false")
	return nil
}

// MarshalJSON writes the capability as the protocol does.
func (s Supported) MarshalJSON() ([]byte, error) {
	if s {
		return []byte("{}"), nil
	}
	return []byte("null"), nil
}

// NewSessionParams are the params of session/new.
type NewSessionParams struct {
	// Cwd is the session's working directory, an absolute path on the
	// agent's machine.
	Cwd string `json:"cwd"`
	// MCPServers are the MCP servers the agent is to connect to, each as
	// the protocol describes it. The member is required: without servers
	// it is sent as an empty array, never as null.
	MCPServers []json.RawMessage `json:"mcpServers"`
	// Meta is _meta: settings of the agent's own that are not in the
	// protocol (Grok's yoloMode); nil for none.
	Meta json.RawMessage `json:"_meta,omitempty"`
}

// MarshalJSON sends no servers as an empty array.
func (p NewSessionParams) MarshalJSON() ([]byte, error) {
	type wire NewSessionParams
	p.MCPServers = orEmpty(p.MCPServers)
	return marshal(wire(p))
}

// NewSessionResult is the answer to session/new.
type NewSessionResult struct {
	SessionID string `json:"sessionId"`
	// Modes is the session's mode state (currentModeId, availableModes),
	// as the agent sent it; nil when it has none.
	Modes json.RawMessage `json:"modes,omitempty"`
	// ConfigOptions is the array of the session's configuration options
	// with their current values, as the agent sent it; nil when it has
	// none. An agent that gives both means these to be used, not Modes.
	ConfigOptions json.RawMessage `json:"configOptions,omitempty"`
	// Models is the unstable session model state (currentModelId,
	// availableModels) of the agents that give it; nil without.
	Models json.RawMessage `json:"models,omitempty"`
	// Meta is the agent's own data about the session.
	Meta json.RawMessage `json:"_meta,omitempty"`
}

// LoadSessionParams are the params of session/load, and of session/resume.
type LoadSessionParams struct {
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	// MCPServers are sent as in NewSessionParams.
	MCPServers []json.RawMessage `json:"mcpServers"`
	// Meta is sent as in NewSessionParams.
	Meta json.RawMessage `json:"_meta,omitempty"`
}

// MarshalJSON sends no servers as an empty array.
func (p LoadSessionParams) MarshalJSON() ([]byte, error) {
	type wire LoadSessionParams
	p.MCPServers = orEmpty(p.MCPServers)
	return marshal(wire(p))
}

// LoadSessionResult is the answer to session/load and to session/resume:
// the state an agent may give with it, as in NewSessionResult.
type LoadSessionResult struct {
	Modes         json.RawMessage `json:"modes,omitempty"`
	ConfigOptions json.RawMessage `json:"configOptions,omitempty"`
	Models        json.RawMessage `json:"models,omitempty"`
}

// PromptParams are the params of session/prompt.
type PromptParams struct {
	SessionID string `json:"sessionId"`
	// Prompt is the user's message as content blocks (TextBlock, or the
	// blocks a UI made). Blocks other than text and resource_link need the
	// agent's PromptCapabilities.
	Prompt []json.RawMessage `json:"prompt"`
}

// MarshalJSON sends a prompt without blocks as an empty array.
func (p PromptParams) MarshalJSON() ([]byte, error) {
	type wire PromptParams
	p.Prompt = orEmpty(p.Prompt)
	return marshal(wire(p))
}

// PromptResult is the answer to session/prompt, at the end of the turn.
type PromptResult struct {
	StopReason StopReason `json:"stopReason"`
	// Usage is the turn's tokens, as an agent that gives them sent them
	// (inputTokens, outputTokens, ...); nil without.
	Usage json.RawMessage `json:"usage,omitempty"`
	// Meta is the agent's own data about the turn (Grok's usage and cost).
	Meta json.RawMessage `json:"_meta,omitempty"`
}

// StopReason is why an agent ended a prompt turn.
type StopReason string

const (
	// StopEndTurn: the model finished without asking for more tools.
	StopEndTurn StopReason = "end_turn"
	// StopMaxTokens: the token limit was reached.
	StopMaxTokens StopReason = "max_tokens"
	// StopMaxTurnRequests: the turn took more model requests than allowed.
	StopMaxTurnRequests StopReason = "max_turn_requests"
	// StopRefusal: the agent refuses to go on.
	StopRefusal StopReason = "refusal"
	// StopCancelled: the client cancelled the turn (Cancel).
	StopCancelled StopReason = "cancelled"
)

// SetModeParams are the params of session/set_mode.
type SetModeParams struct {
	SessionID string `json:"sessionId"`
	// ModeID is one of the session's availableModes.
	ModeID string `json:"modeId"`
}

// SetConfigOptionParams are the params of session/set_config_option.
type SetConfigOptionParams struct {
	SessionID string `json:"sessionId"`
	// ConfigID is the id of the option.
	ConfigID string `json:"configId"`
	// Value is the value of one of the option's options. Options are of
	// type select: boolean ones need a client capability
	// (session.configOptions.boolean) that this client does not state.
	Value string `json:"value"`
}

// SetConfigOptionResult is the answer to session/set_config_option.
type SetConfigOptionResult struct {
	// ConfigOptions is the array of all options with their current
	// values, as the agent sent it: setting one may change others.
	ConfigOptions json.RawMessage `json:"configOptions,omitempty"`
}

// ListSessionsParams are the params of session/list. All are optional.
type ListSessionsParams struct {
	// Cwd keeps the sessions of one working directory, an absolute path.
	Cwd string `json:"cwd,omitempty"`
	// Cursor is the NextCursor of the page before. Cursors are the
	// agent's: they are neither read nor kept.
	Cursor string `json:"cursor,omitempty"`
}

// ListSessionsResult is one page of an agent's sessions.
type ListSessionsResult struct {
	Sessions []SessionInfo `json:"sessions"`
	// NextCursor asks for the next page; "" on the last one.
	NextCursor string `json:"nextCursor,omitempty"`
}

// SessionInfo is a session an agent knows.
type SessionInfo struct {
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	// Title may be one the agent made of the first prompt; "" without.
	Title string `json:"title,omitempty"`
	// UpdatedAt is the time of the last activity, ISO 8601, as the agent
	// wrote it; "" without.
	UpdatedAt string `json:"updatedAt,omitempty"`
	// Meta is the agent's own data about the session.
	Meta json.RawMessage `json:"_meta,omitempty"`
}

// SessionNotification is the params of session/update as far as a host
// reads them: whose update it is. The update itself is the UI's.
type SessionNotification struct {
	SessionID string          `json:"sessionId"`
	Update    json.RawMessage `json:"update"`
}

// PermissionRequest is the params of session/request_permission.
type PermissionRequest struct {
	SessionID string `json:"sessionId"`
	// ToolCall is the tool call to decide on, as the agent sent it.
	ToolCall json.RawMessage    `json:"toolCall"`
	Options  []PermissionOption `json:"options"`
}

// PermissionOption is one answer a user may give.
type PermissionOption struct {
	OptionID string `json:"optionId"`
	// Name is the label, the agent's text.
	Name string               `json:"name"`
	Kind PermissionOptionKind `json:"kind"`
}

// PermissionOptionKind hints at what an option does, for its icon and
// treatment; its name is the agent's text. The agent keeps what the user
// chose for "always", and decides how far that reaches.
type PermissionOptionKind string

const (
	PermissionAllowOnce    PermissionOptionKind = "allow_once"
	PermissionAllowAlways  PermissionOptionKind = "allow_always"
	PermissionRejectOnce   PermissionOptionKind = "reject_once"
	PermissionRejectAlways PermissionOptionKind = "reject_always"
)

// PermissionResponse is the result of session/request_permission.
type PermissionResponse struct {
	Outcome PermissionOutcome `json:"outcome"`
}

// PermissionOutcome is the user's decision: "selected" with the option, or
// "cancelled".
type PermissionOutcome struct {
	Outcome  string `json:"outcome"`
	OptionID string `json:"optionId,omitempty"`
}

// PermissionSelected is the answer of a user who chose an option.
func PermissionSelected(optionID string) PermissionResponse {
	return PermissionResponse{Outcome: PermissionOutcome{Outcome: "selected", OptionID: optionID}}
}

// PermissionCancelled is the answer to a request whose prompt turn was
// cancelled: a client owes it to every request that still waits when it
// sends Cancel.
func PermissionCancelled() PermissionResponse {
	return PermissionResponse{Outcome: PermissionOutcome{Outcome: "cancelled"}}
}

// TextBlock is a text content block for a prompt.
func TextBlock(text string) json.RawMessage {
	b, _ := marshal(struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}{"text", text})
	return b
}

func orEmpty(s []json.RawMessage) []json.RawMessage {
	if s == nil {
		return []json.RawMessage{}
	}
	return s
}

// Initialize opens the connection's protocol: it must be the first call. It
// states protocol version 1, no fs and no terminal capability, and client
// as clientInfo.
//
// When the agent answers with another version, the error is
// ErrProtocolVersion (errors.Is) and the result comes with it, to tell the
// user which agent that is; the owner then ends the connection.
func (c *Conn) Initialize(ctx context.Context, client Implementation) (*InitializeResult, error) {
	var res InitializeResult
	err := c.Call(ctx, MethodInitialize, initializeParams{ProtocolVersion: ProtocolVersion, ClientInfo: client}, &res)
	if err != nil {
		return nil, err
	}
	if res.ProtocolVersion != ProtocolVersion {
		return &res, fmt.Errorf("%w: %d", ErrProtocolVersion, res.ProtocolVersion)
	}
	return &res, nil
}

// Authenticate signs in with one of the agent's authMethods, by its id. It
// is for methods the agent runs itself (type agent, or no type), not for
// those of type terminal.
func (c *Conn) Authenticate(ctx context.Context, methodID string) error {
	return c.Call(ctx, MethodAuthenticate, struct {
		MethodID string `json:"methodId"`
	}{methodID}, nil)
}

// NewSession makes a session. It may fail until the user signed in, with
// the agent's error.
func (c *Conn) NewSession(ctx context.Context, p NewSessionParams) (*NewSessionResult, error) {
	var res NewSessionResult
	if err := c.Call(ctx, MethodSessionNew, p, &res); err != nil {
		return nil, err
	}
	if res.SessionID == "" {
		return nil, fmt.Errorf("acp: %s: result without sessionId", MethodSessionNew)
	}
	return &res, nil
}

// ResumeSession takes up a session the agent kept without replaying it. It
// needs the capability SessionCapabilities.Resume
// (agentCapabilities.sessionCapabilities.resume).
func (c *Conn) ResumeSession(ctx context.Context, p LoadSessionParams) (*LoadSessionResult, error) {
	var res LoadSessionResult
	if err := c.Call(ctx, MethodSessionResume, p, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// LoadSession takes up a session the agent kept. It needs the capability
// AgentCapabilities.LoadSession (agentCapabilities.loadSession). The agent
// replays the conversation as session/update notifications before it
// answers: the Handler had all of them when LoadSession returns.
func (c *Conn) LoadSession(ctx context.Context, p LoadSessionParams) (*LoadSessionResult, error) {
	var res LoadSessionResult
	if err := c.Call(ctx, MethodSessionLoad, p, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// Prompt sends the user's message and returns at the end of the turn, which
// may be long: the agent's output comes as session/update notifications
// meanwhile, all handled when Prompt returns. To stop the turn, send Cancel
// and keep waiting: the agent then answers with StopCancelled. A ctx that
// ends does not stop the agent.
func (c *Conn) Prompt(ctx context.Context, p PromptParams) (*PromptResult, error) {
	var res PromptResult
	if err := c.Call(ctx, MethodSessionPrompt, p, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// GoPrompt sends the user's message and returns once it is written: a
// Cancel sent after it reaches the agent after the prompt. The Pending's
// Wait returns at the end of the turn, as Prompt does, with a
// PromptResult.
func (c *Conn) GoPrompt(ctx context.Context, p PromptParams) (*Pending, error) {
	return c.Go(ctx, MethodSessionPrompt, p)
}

// Cancel asks the agent to stop the session's prompt turn (the notification
// session/cancel). Updates may still come; the turn is over when Prompt
// returns. The requests for a permission that wait are the caller's to
// answer with PermissionCancelled.
func (c *Conn) Cancel(sessionID string) error {
	return c.Notify(MethodSessionCancel, struct {
		SessionID string `json:"sessionId"`
	}{sessionID})
}

// SetMode switches the session's mode. The protocol keeps session modes
// for clients without configuration options and announces their removal: a
// session that has ConfigOptions is switched with SetConfigOption (its
// option of category mode).
func (c *Conn) SetMode(ctx context.Context, p SetModeParams) error {
	return c.Call(ctx, MethodSessionSetMode, p, nil)
}

// SetConfigOption sets one of the session's configuration options, at any
// time, also during a turn. The answer is the state of all of them.
func (c *Conn) SetConfigOption(ctx context.Context, p SetConfigOptionParams) (*SetConfigOptionResult, error) {
	var res SetConfigOptionResult
	if err := c.Call(ctx, MethodSessionSetConfigOption, p, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// ListSessions asks for a page of the sessions the agent knows. It needs
// the capability AgentCapabilities.SessionCapabilities.List
// (agentCapabilities.sessionCapabilities.list). Listing loads nothing: a
// session of the list is taken up with LoadSession.
func (c *Conn) ListSessions(ctx context.Context, p ListSessionsParams) (*ListSessionsResult, error) {
	var res ListSessionsResult
	if err := c.Call(ctx, MethodSessionList, p, &res); err != nil {
		return nil, err
	}
	return &res, nil
}
