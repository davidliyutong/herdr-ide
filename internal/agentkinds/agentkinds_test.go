package agentkinds_test

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"veldr/internal/agent/detect"
	"veldr/internal/agentkinds"
	"veldr/internal/uisettings"
	"veldr/internal/usage"
)

func ids(list []agentkinds.Kind) []string {
	out := make([]string, len(list))
	for i, k := range list {
		out[i] = k.ID
	}
	return out
}

// The registry, the detector's manifests and the settings' list of agents
// name the same agents; each provider of the AI usage plugin a kind names
// is one of its providers.
func TestKindsMatchManifestsAndSettings(t *testing.T) {
	ms, err := detect.Manifests()
	if err != nil {
		t.Fatal(err)
	}
	var manifests []string
	for id := range ms {
		manifests = append(manifests, id)
	}
	slices.Sort(manifests)
	got := ids(agentkinds.All())
	if len(slices.Compact(slices.Sorted(slices.Values(got)))) != len(got) {
		t.Fatalf("an id is listed twice: %v", got)
	}
	sorted := slices.Sorted(slices.Values(got))
	if !slices.Equal(sorted, manifests) {
		t.Errorf("kinds %v, manifests %v", sorted, manifests)
	}
	if !slices.Equal(sorted, uisettings.Agents) {
		t.Errorf("kinds %v, uisettings.Agents %v", sorted, uisettings.Agents)
	}
	for _, k := range agentkinds.All() {
		if k.Title == "" {
			t.Errorf("%s has no title", k.ID)
		}
		if k.UsageProvider != "" && !slices.Contains(usage.Providers, k.UsageProvider) {
			t.Errorf("%s names the usage provider %q, which internal/usage does not have", k.ID, k.UsageProvider)
		}
		if k.Transcript != "" && (k.ResumeByID == nil || k.ContinueLatest == nil) {
			t.Errorf("%s has a native view but cannot be resumed", k.ID)
		}
		if k.NewSession != nil && k.Start == nil {
			t.Errorf("%s takes a session id but is not started", k.ID)
		}
		for _, tokens := range [][]string{k.NewSession, k.ResumeByID} {
			if tokens != nil && !slices.Contains(tokens, agentkinds.Placeholder) {
				t.Errorf("%s: %v without %s", k.ID, tokens, agentkinds.Placeholder)
			}
		}
	}
	if k, ok := agentkinds.ByID("agy"); !ok || k.UsageProvider != usage.Antigravity {
		t.Errorf("agy %+v", k)
	}
}

// The values the web UI had in its own tables before the registry: the
// commands that continue a directory's latest conversation, and the agents
// the command palette starts, in its order.
func TestKindsKeepTheUIsCommands(t *testing.T) {
	cont := map[string]string{}
	var started []string
	for _, k := range agentkinds.All() {
		if k.ContinueLatest != nil {
			cont[k.ID] = strings.Join(k.ContinueLatest, " ")
		}
		if k.Start != nil {
			started = append(started, k.ID)
			if len(k.Start) != 1 || k.Start[0] != k.ID {
				t.Errorf("%s starts with %v", k.ID, k.Start)
			}
		}
	}
	if len(cont) != 2 || cont["claude"] != "claude --continue" || cont["codex"] != "codex resume --last" {
		t.Errorf("continue %v", cont)
	}
	want := []string{"claude", "codex", "gemini", "opencode", "kimi", "grok", "cursor", "copilot", "qwen", "amp"}
	if !slices.Equal(started, want) {
		t.Errorf("started %v, want %v", started, want)
	}
	claude, _ := agentkinds.ByID("claude")
	if !slices.Equal(claude.ResumeByID, []string{"claude", "--resume", agentkinds.Placeholder}) {
		t.Errorf("claude resume %v", claude.ResumeByID)
	}
	if got := append(claude.Start, claude.NewSession...); !slices.Equal(got, []string{"claude", "--session-id", agentkinds.Placeholder}) {
		t.Errorf("claude new session %v", got)
	}
	codex, _ := agentkinds.ByID("codex")
	if !slices.Equal(codex.ResumeByID, []string{"codex", "resume", agentkinds.Placeholder}) {
		t.Errorf("codex resume %v", codex.ResumeByID)
	}
	if codex.NewSession != nil {
		t.Errorf("codex takes a session id: %v", codex.NewSession)
	}
	if _, ok := agentkinds.ByID("nobody"); ok {
		t.Error("an unknown id has a kind")
	}
}

// Only a lower-case UUID is a session id: quotes, separators,
// substitutions and newlines are refused.
func TestSessionIDs(t *testing.T) {
	good := "0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f"
	if !agentkinds.ValidSessionID(good) {
		t.Fatal("a session id refused")
	}
	for _, bad := range []string{
		"", "0B6F5C1E-8D3A-4C2B-9E1F-2A3B4C5D6E7F", good + " ", " " + good, good + "\n", good + "; rm -rf ~",
		"$(id)", "`id`", "x; rm -rf ~", "'" + good + "'", "0b6f5c1e8d3a4c2b9e1f2a3b4c5d6e7f",
		"0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7", "0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f0", "../../etc/passwd",
		"0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7g",
	} {
		if agentkinds.ValidSessionID(bad) {
			t.Errorf("%q taken for a session id", bad)
		}
	}
}

// The registry cannot be changed through what All, ByID and ChatKinds
// return.
func TestKindsAreCopies(t *testing.T) {
	k, _ := agentkinds.ByID("claude")
	k.Start[0] = "rm"
	k.Chat.Argv[0] = "rm"
	k.Chat.Adapter = "acp"
	all := agentkinds.All()
	all[0].ResumeByID[0] = "rm"
	chats := agentkinds.ChatKinds()
	grok := chats[len(chats)-1]
	grok.Chat.NewSessionMeta[0] = '['
	grok.Chat.Argv = append(grok.Chat.Argv[:1], "--yolo")
	if again, _ := agentkinds.ByID("claude"); again.Start[0] != "claude" || again.ResumeByID[0] != "claude" ||
		again.Chat.Argv[0] != "claude" || again.Chat.Adapter != agentkinds.AdapterClaude {
		t.Errorf("the registry changed: %+v", again)
	}
	if again, _ := agentkinds.ByID("grok"); string(again.Chat.NewSessionMeta) != `{"yoloMode":false}` ||
		!slices.Equal(again.Chat.Argv, []string{"grok", "agent", "--no-leader", "stdio"}) {
		t.Errorf("the registry changed: %+v", again.Chat)
	}
}

// The kinds the chat host runs: each has a detector manifest (so its
// terminals are recognized too), an adapter of the host's, and a command
// whose program is the one the kind starts in a terminal; ACP's session
// metadata is a JSON object. OpenCode has none: its ACP mode listens on a
// TCP port without authentication.
func TestChatKinds(t *testing.T) {
	ms, err := detect.Manifests()
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(agentkinds.ChatKinds()); !slices.Equal(got, []string{"claude", "codex", "kimi", "grok"}) {
		t.Errorf("chat kinds %v", got)
	}
	for _, k := range agentkinds.All() {
		if k.Chat == nil {
			if slices.Contains(ids(agentkinds.ChatKinds()), k.ID) {
				t.Errorf("%s is listed without a chat", k.ID)
			}
			continue
		}
		if _, ok := ms[k.ID]; !ok {
			t.Errorf("%s has a chat but no detector manifest", k.ID)
		}
		if !slices.Contains(agentkinds.Adapters, k.Chat.Adapter) {
			t.Errorf("%s: adapter %q", k.ID, k.Chat.Adapter)
		}
		if len(k.Chat.Argv) == 0 || len(k.Start) == 0 || k.Chat.Argv[0] != k.Start[0] {
			t.Errorf("%s runs %v for chats and %v in terminals", k.ID, k.Chat.Argv, k.Start)
		}
		if m := k.Chat.NewSessionMeta; m != nil {
			var obj map[string]any
			if k.Chat.Adapter != agentkinds.AdapterACP || json.Unmarshal(m, &obj) != nil {
				t.Errorf("%s: session metadata %s", k.ID, m)
			}
		}
	}
	if opencode, _ := agentkinds.ByID("opencode"); opencode.Chat != nil {
		t.Error("opencode has a chat")
	}
	want := map[string]string{
		"claude": "claude [claude]",
		"codex":  "codex [codex app-server --listen stdio://]",
		"kimi":   "acp [kimi acp]",
		"grok":   "acp [grok agent --no-leader stdio]",
	}
	for id, w := range want {
		k, _ := agentkinds.ByID(id)
		if got := k.Chat.Adapter + " " + fmt.Sprint(k.Chat.Argv); got != w {
			t.Errorf("%s: %s, want %s", id, got, w)
		}
	}
	if !slices.Equal(agentkinds.Adapters, []string{"claude", "codex", "acp"}) {
		t.Error("the adapters changed")
	}
}

// The kinds' JSON, as the web UI reads it from the generated registry.
func TestKindJSON(t *testing.T) {
	codex, _ := agentkinds.ByID("codex")
	b, err := json.Marshal(codex)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"codex","title":"Codex","usageProvider":"codex","start":["codex"],"continueLatest":["codex","resume","--last"],"resumeById":["codex","resume","{id}"],"transcript":"codex","chat":{"adapter":"codex"}}`
	if string(b) != want {
		t.Errorf("got  %s\nwant %s", b, want)
	}
	// A chat's command, environment and session metadata stay on the
	// machine's side.
	grok, _ := agentkinds.ByID("grok")
	if b, _ := json.Marshal(grok); string(b) != `{"id":"grok","title":"Grok","usageProvider":"grok","start":["grok"],"chat":{"adapter":"acp"}}` {
		t.Errorf("grok %s", b)
	}
	droid, _ := agentkinds.ByID("droid")
	if b, _ := json.Marshal(droid); string(b) != `{"id":"droid","title":"Droid"}` {
		t.Errorf("droid %s", b)
	}
}
