// Package agentkinds is the registry of the coding agents the terminals
// recognize: for each kind, its name, the AI usage plugin's provider of its
// subscription, the command lines that start it, start it with a session
// chosen by the caller, continue a directory's latest conversation and
// resume a session by its id, the parser of its session transcripts, and
// how the chat host runs it headless (Chat). It is data only and builds
// for every system the core runs on.
//
// The ids are the detector's (internal/agent/detect manifests), which
// uisettings.Agents lists too; scripts/registry writes the kinds into
// design/generated/registry.json (key "agents") for the web UI
// (web/src/conversation/kinds.ts), a Chat spec with its adapter only.
// Adding a kind is a row here, a manifest and, for a native view of its
// conversations, a transcript parser; for chats, a Chat spec whose adapter
// is one of Adapters (internal/chatadapter).
package agentkinds

import (
	"bytes"
	"encoding/json"
	"maps"
	"regexp"
	"slices"
	"strings"
)

// Placeholder stands for a session id in a command line's tokens.
const Placeholder = "{id}"

// Kind is one kind of coding agent.
type Kind struct {
	// ID is the detector's id (the manifests' id), e.g. "claude".
	ID string `json:"id"`
	// Title is the agent's name for people, e.g. "Claude Code".
	Title string `json:"title"`
	// UsageProvider is the AI usage plugin's provider of the agent's
	// subscription (internal/usage), "" when it has none; the detector's
	// "agy" is the provider "antigravity".
	UsageProvider string `json:"usageProvider,omitempty"`
	// Start is the argv that starts the agent; nil for an agent the UIs
	// do not offer to start.
	Start []string `json:"start,omitempty"`
	// NewSession is appended to Start to start the agent with a session id
	// chosen by the caller (Placeholder); nil when the agent takes none.
	NewSession []string `json:"newSession,omitempty"`
	// ContinueLatest is the command line, as tokens, that continues the
	// directory's latest conversation; nil when the agent has none.
	ContinueLatest []string `json:"continueLatest,omitempty"`
	// ResumeByID is the command line, as tokens, that resumes a session by
	// its id (Placeholder); nil when the agent has none.
	ResumeByID []string `json:"resumeById,omitempty"`
	// Transcript names the parser of the agent's session transcripts
	// ("claude", "codex"); "" when its conversations have no native view.
	Transcript string `json:"transcript,omitempty"`
	// Chat is how the chat host runs the agent headless; nil for an agent
	// it does not run.
	Chat *ChatSpec `json:"chat,omitempty"`
}

// The adapters of the chat host (internal/chatadapter), by the protocol
// they speak.
const (
	// AdapterClaude: Claude Code's SDK protocol (stream-json and control
	// requests on stdin and stdout).
	AdapterClaude = "claude"
	// AdapterCodex: Codex's app-server (JSON-RPC on stdio).
	AdapterCodex = "codex"
	// AdapterACP: the Agent Client Protocol on stdio.
	AdapterACP = "acp"
)

// Adapters lists the chat host's adapters.
var Adapters = []string{AdapterClaude, AdapterCodex, AdapterACP}

// ChatSpec is how the chat host runs an agent headless. Only Adapter
// leaves the machine's side: the command, its environment and the session
// metadata are not in the kind's JSON.
type ChatSpec struct {
	// Adapter is the protocol the agent speaks (Adapters).
	Adapter string `json:"adapter"`
	// Argv is the command the adapter adds its protocol's own arguments
	// to; Argv[0] is looked up in the user's PATH and is the program Start
	// runs too.
	Argv []string `json:"-"`
	// Env is added to the agent's environment.
	Env map[string]string `json:"-"`
	// NewSessionMeta is the _meta of ACP's session/new (an ACP agent's
	// settings that are not in the protocol), nil for none.
	NewSessionMeta json.RawMessage `json:"-"`
}

// The agents' command lines, as tokens.
func argv(s string) []string { return strings.Fields(s) }

// kinds are the agents in the order the UIs offer them: those the command
// palette starts first, the others by id.
//
// The chats: Claude Code and Codex through their own protocols; Kimi Code
// and Grok through ACP (`kimi acp`; `grok agent --no-leader stdio`, its
// sessions told not to approve everything, which the user's always-approve
// setting would make them). OpenCode has no chat: `opencode acp` listens
// on a TCP port without authentication.
var kinds = []Kind{
	{ID: "claude", Title: "Claude Code", UsageProvider: "claude", Start: argv("claude"),
		NewSession: argv("--session-id " + Placeholder), ContinueLatest: argv("claude --continue"),
		ResumeByID: argv("claude --resume " + Placeholder), Transcript: "claude",
		Chat: &ChatSpec{Adapter: AdapterClaude, Argv: argv("claude")}},
	{ID: "codex", Title: "Codex", UsageProvider: "codex", Start: argv("codex"),
		ContinueLatest: argv("codex resume --last"), ResumeByID: argv("codex resume " + Placeholder), Transcript: "codex",
		Chat: &ChatSpec{Adapter: AdapterCodex, Argv: argv("codex app-server --listen stdio://")}},
	{ID: "gemini", Title: "Gemini CLI", Start: argv("gemini")},
	{ID: "opencode", Title: "OpenCode", UsageProvider: "opencode", Start: argv("opencode")},
	{ID: "kimi", Title: "Kimi Code", UsageProvider: "kimi", Start: argv("kimi"),
		Chat: &ChatSpec{Adapter: AdapterACP, Argv: argv("kimi acp")}},
	{ID: "grok", Title: "Grok", UsageProvider: "grok", Start: argv("grok"),
		Chat: &ChatSpec{Adapter: AdapterACP, Argv: argv("grok agent --no-leader stdio"), NewSessionMeta: json.RawMessage(`{"yoloMode":false}`)}},
	{ID: "cursor", Title: "Cursor", Start: argv("cursor")},
	{ID: "copilot", Title: "GitHub Copilot", Start: argv("copilot")},
	{ID: "qwen", Title: "Qwen Code", Start: argv("qwen")},
	{ID: "amp", Title: "Amp", Start: argv("amp")},
	{ID: "agy", Title: "Antigravity", UsageProvider: "antigravity"},
	{ID: "cline", Title: "Cline"},
	{ID: "devin", Title: "Devin"},
	{ID: "droid", Title: "Droid"},
	{ID: "hermes", Title: "Hermes"},
	{ID: "kilo", Title: "Kilo Code"},
	{ID: "kiro", Title: "Kiro"},
	{ID: "letta", Title: "Letta Code"},
	{ID: "maki", Title: "Maki"},
	{ID: "muse", Title: "Muse"},
	{ID: "pi", Title: "Pi"},
	{ID: "qodercli", Title: "Qoder CLI"},
}

// All returns every kind, in the order the UIs offer them. The slices are
// copies: the registry cannot be changed through them.
func All() []Kind {
	out := make([]Kind, len(kinds))
	for i, k := range kinds {
		out[i] = k.clone()
	}
	return out
}

// ByID returns the kind of a detector's id.
func ByID(id string) (Kind, bool) {
	for _, k := range kinds {
		if k.ID == id {
			return k.clone(), true
		}
	}
	return Kind{}, false
}

func (k Kind) clone() Kind {
	c := func(s []string) []string {
		if s == nil {
			return nil
		}
		return append([]string(nil), s...)
	}
	k.Start, k.NewSession, k.ContinueLatest, k.ResumeByID = c(k.Start), c(k.NewSession), c(k.ContinueLatest), c(k.ResumeByID)
	if k.Chat != nil {
		chat := *k.Chat
		chat.Argv, chat.Env, chat.NewSessionMeta = c(chat.Argv), maps.Clone(chat.Env), bytes.Clone(chat.NewSessionMeta)
		k.Chat = &chat
	}
	return k
}

// ChatKinds returns the kinds the chat host runs (a Chat spec), in the
// order the UIs offer them; copies, as All's.
func ChatKinds() []Kind {
	var out []Kind
	for _, k := range kinds {
		if k.Chat != nil {
			out = append(out, k.clone())
		}
	}
	return out
}

// ValidAdapter reports whether name is one of Adapters.
func ValidAdapter(name string) bool { return slices.Contains(Adapters, name) }

var sessionID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ValidSessionID reports whether s is a session id as the agents write
// them: a UUID in lower-case hexadecimal, nothing else. Only such an id is
// ever put into a command line.
func ValidSessionID(s string) bool { return sessionID.MatchString(s) }

// Command is the command line of tokens joined by spaces, each Placeholder
// in them replaced by id. It is false when tokens is empty, and when they
// hold a placeholder and id is not a session id (ValidSessionID); id is not
// looked at otherwise.
func Command(tokens []string, id string) (string, bool) {
	if len(tokens) == 0 {
		return "", false
	}
	out := make([]string, len(tokens))
	for i, tok := range tokens {
		if strings.Contains(tok, Placeholder) {
			if !ValidSessionID(id) {
				return "", false
			}
			tok = strings.ReplaceAll(tok, Placeholder, id)
		}
		out[i] = tok
	}
	return strings.Join(out, " "), true
}
