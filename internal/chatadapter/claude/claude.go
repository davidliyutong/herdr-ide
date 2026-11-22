//go:build unix

// Package claude is the chat host's adapter of Claude Code (chatadapter
// "claude"). It runs the claude program headless the way Anthropic's Agent
// SDK does, speaking the SDK's protocol: stream-json messages and control
// requests, one JSON object a line, on the program's standard input and
// output. The protocol has no published specification: its shapes are
// those of the TypeScript SDK's type definitions (version SDKVersion,
// whose command line and environment this package reproduces) and of the
// recordings of Claude Code 2.1.330 in design/testdata/chat/claude.
//
// A session is one claude process (in a process group of its own) of one
// Claude Code session: --session-id for a new chat, --resume for one taken
// up. The adapter starts it, sends initialize, and maps what it says:
// stream_event deltas to live increments (an item is a message's content
// block, "<message id>/<block index>", or a tool call by its id), the
// assistant frame of a block to the block's whole event, tool results to
// tool call updates (through internal/agent/transcript's mapping, the one
// the import uses), subagents' frames to events with a Parent, system and
// result frames to turns, notices and the chat's usage. The program's own
// requests (can_use_tool) become permissions and questions of the host's
// Sink; answers to requests this adapter did not make (the program echoes
// the answers it is sent) are passed over.
package claude

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"

	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/brand"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

// SDKVersion is the version of @anthropic-ai/claude-agent-sdk whose way of
// starting the program and whose message shapes this adapter follows; it
// is passed to the program as CLAUDE_AGENT_SDK_VERSION, as the SDK does.
const SDKVersion = "0.3.323"

// The adapter's bounds.
var (
	// initTimeout bounds the answer to initialize, requestTimeout every
	// other control request (variables: tests shorten them).
	initTimeout    = 60 * time.Second
	requestTimeout = 30 * time.Second
	// closeGrace is how long a closed program may take to exit before its
	// group gets SIGTERM, killGrace how long after that before SIGKILL.
	closeGrace = 2 * time.Second
	killGrace  = 5 * time.Second
)

const (
	// maxStderr is how much of the end of the program's standard error is
	// kept, for the error of a session that ended: what the host keeps.
	maxStderr = chatproto.MaxStderr
	// maxCommands bounds the slash commands a chat states, maxModels the
	// models, maxQuestions the questions of an AskUserQuestion and
	// maxOptions the options of one; maxText the bytes of each of their
	// strings.
	maxCommands  = 1000
	maxModels    = 256
	maxQuestions = 16
	maxOptions   = 64
	maxText      = 4 << 10
)

// The ids of the configuration options a chat of Claude Code has.
const (
	optionMode   = "mode"
	optionModel  = "model"
	optionEffort = "effort"
	// effortDefault is the effort option's value that leaves the effort to
	// the model's default.
	effortDefault = "default"
)

// Adapter is Claude Code's adapter.
type Adapter struct{}

func init() { chatadapter.Register(agentkinds.AdapterClaude, Adapter{}) }

// modelID is what a model option given at the start may be: a model's
// name or alias as Claude Code takes them (claude-opus-5-5,
// claude-opus-5-5[1m], opus).
var modelID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,127}$`)

// efforts are the effort levels Claude Code knows.
var efforts = []string{"low", "medium", "high", "xhigh", "max"}

func badRequest(msg string) error {
	return &chatproto.Error{Code: chatproto.CodeBadRequest, Message: "claude: " + msg}
}

// Start runs Claude Code for a chat; see chatadapter.Adapter.
func (Adapter) Start(ctx context.Context, p chatadapter.StartParams, sink chatadapter.Sink) (chatadapter.Session, error) {
	id := p.SessionID
	if p.Resume != "" {
		id = p.Resume
	}
	switch {
	case len(p.Argv) == 0 || !path.IsAbs(p.Argv[0]):
		return nil, badRequest("the program is not an absolute path")
	case !path.IsAbs(p.Cwd):
		return nil, badRequest("the directory is not an absolute path")
	case !agentkinds.ValidSessionID(id):
		return nil, badRequest("not a session id")
	case p.Options.Mode != "" && !slices.Contains(chatproto.Modes, p.Options.Mode):
		return nil, badRequest("unknown mode")
	case p.Options.Model != "" && !modelID.MatchString(p.Options.Model):
		return nil, badRequest("not a model")
	case p.Options.Effort != "" && p.Options.Effort != effortDefault && !slices.Contains(efforts, p.Options.Effort):
		return nil, badRequest("unknown effort")
	}
	if p.Logger == nil {
		p.Logger = log.New(io.Discard, "", 0)
	}
	s := newSession(p, sink, id)
	if err := s.begin(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// claudeMode is Claude Code's permission mode of a chatproto mode.
func claudeMode(mode string) string {
	switch mode {
	case chatproto.ModeAcceptEdits:
		return "acceptEdits"
	case chatproto.ModePlan:
		return "plan"
	case chatproto.ModeFull:
		return "bypassPermissions"
	}
	return "default"
}

// chatMode is the chatproto mode of Claude Code's permission mode; "" for
// one it has none of (dontAsk, auto).
func chatMode(mode string) string {
	switch mode {
	case "default":
		return chatproto.ModeDefault
	case "acceptEdits":
		return chatproto.ModeAcceptEdits
	case "plan":
		return chatproto.ModePlan
	case "bypassPermissions":
		return chatproto.ModeFull
	}
	return ""
}

// argv is the command line of a run: the spec's command and the SDK's
// arguments.
func (s *session) argv(resume, full bool) []string {
	a := slices.Clone(s.p.Argv)
	// The project's own settings (and with them its hooks, MCP servers and
	// CLAUDE.md) only in a folder someone trusted: Claude Code asks
	// nothing of a program it runs headless.
	sources := "--setting-sources=user"
	if s.trusted {
		sources = "--setting-sources=user,project,local"
	}
	a = append(a, "--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
		"--include-partial-messages", "--permission-prompt-tool", "stdio", sources)
	if resume {
		a = append(a, "--resume="+s.id)
	} else {
		a = append(a, "--session-id="+s.id)
	}
	s.mu.Lock()
	s.launchModel = s.modelArg
	s.mu.Unlock()
	if s.launchModel != "" {
		a = append(a, "--model="+s.launchModel)
	}
	mode := s.p.Options.Mode
	if full {
		mode = chatproto.ModeFull
	} else if mode == chatproto.ModeFull {
		mode = chatproto.ModeDefault
	}
	a = append(a, "--permission-mode="+claudeMode(mode))
	if full {
		a = append(a, "--allow-dangerously-skip-permissions")
	}
	return a
}

// sdkEnv are the variables the SDK sets for the program, which replace the
// environment's.
func sdkEnv() map[string]string {
	return map[string]string{
		// Not sdk-ts: Claude Code hides the SDK's own entry points' sessions
		// from the terminal's /resume list; the product's name keeps them in
		// it, so that a chat can go on in a terminal.
		"CLAUDE_CODE_ENTRYPOINT":              brand.Slug,
		"CLAUDE_CODE_SDK_READS_SESSION_STATE": "1",
		"CLAUDE_AGENT_SDK_VERSION":            SDKVersion,
	}
}

// env is the program's environment: the host's, without NODE_OPTIONS (as
// the SDK drops it) and with the SDK's variables.
func (s *session) env() []string {
	add := sdkEnv()
	var out []string
	for _, kv := range s.p.Env {
		k, _, _ := strings.Cut(kv, "=")
		if _, ok := add[k]; ok || k == "NODE_OPTIONS" {
			continue
		}
		out = append(out, kv)
	}
	keys := make([]string, 0, len(add))
	for k := range add {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		out = append(out, k+"="+add[k])
	}
	return out
}

// initResponse is what initialize answers that the adapter reads.
type initResponse struct {
	Commands []struct {
		Name         string `json:"name"`
		Description  string `json:"description"`
		ArgumentHint string `json:"argumentHint"`
	} `json:"commands"`
	Models                []model `json:"models"`
	Version               string  `json:"claude_code_version"`
	CurrentPermissionMode string  `json:"current_permission_mode"`
}

// model is a model initialize lists.
type model struct {
	Value                 string   `json:"value"`
	Resolved              string   `json:"resolvedModel"`
	DisplayName           string   `json:"displayName"`
	Description           string   `json:"description"`
	SupportsEffort        bool     `json:"supportsEffort"`
	SupportedEffortLevels []string `json:"supportedEffortLevels"`
}

// contextUsage is what get_context_usage answers that the adapter reads.
type contextUsage struct {
	TotalTokens int64   `json:"totalTokens"`
	MaxTokens   int64   `json:"maxTokens"`
	Percentage  float64 `json:"percentage"`
	Model       string  `json:"model"`
}

// cut is s cut to n bytes at a character's start.
func cut(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n]
}

// decode decodes a control response's body into v; a body that does not
// decode is an error of the protocol.
func decode(raw json.RawMessage, v any) error {
	if len(raw) == 0 {
		raw = json.RawMessage("{}")
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return &chatproto.Error{Code: chatproto.CodeProtocol, Message: "claude: an answer of another shape: " + err.Error()}
	}
	return nil
}
