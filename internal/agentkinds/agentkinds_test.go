package agentkinds_test

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"herdr-ide/internal/agent/detect"
	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/uisettings"
	"herdr-ide/internal/usage"
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
		if c, ok := agentkinds.Command(k.ContinueLatest, ""); ok {
			cont[k.ID] = c
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
	if c, ok := agentkinds.Command(claude.ResumeByID, "0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f"); !ok || c != "claude --resume 0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f" {
		t.Errorf("claude resume %q %v", c, ok)
	}
	if got := append(claude.Start, claude.NewSession...); !slices.Equal(got, []string{"claude", "--session-id", agentkinds.Placeholder}) {
		t.Errorf("claude new session %v", got)
	}
	codex, _ := agentkinds.ByID("codex")
	if c, ok := agentkinds.Command(codex.ResumeByID, "0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f"); !ok || c != "codex resume 0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f" {
		t.Errorf("codex resume %q %v", c, ok)
	}
	if codex.NewSession != nil {
		t.Errorf("codex takes a session id: %v", codex.NewSession)
	}
	if _, ok := agentkinds.ByID("nobody"); ok {
		t.Error("an unknown id has a kind")
	}
}

// Only a lower-case UUID is a session id, and nothing else reaches a
// command line: quotes, separators, substitutions and newlines are refused.
func TestSessionIDsAndCommands(t *testing.T) {
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
		if c, ok := agentkinds.Command([]string{"claude", "--resume", agentkinds.Placeholder}, bad); ok || c != "" {
			t.Errorf("%q made %q", bad, c)
		}
	}
	if c, ok := agentkinds.Command([]string{"agent", "--session=" + agentkinds.Placeholder}, good); !ok || c != "agent --session="+good {
		t.Errorf("a placeholder within a token: %q %v", c, ok)
	}
	if c, ok := agentkinds.Command([]string{"codex", "resume", "--last"}, "x; rm -rf ~"); !ok || c != "codex resume --last" || strings.Contains(c, "rm") {
		t.Errorf("a command without a placeholder: %q %v", c, ok)
	}
	if _, ok := agentkinds.Command(nil, good); ok {
		t.Error("no tokens made a command")
	}
}

// The registry cannot be changed through what All and ByID return.
func TestKindsAreCopies(t *testing.T) {
	k, _ := agentkinds.ByID("claude")
	k.Start[0] = "rm"
	all := agentkinds.All()
	all[0].ResumeByID[0] = "rm"
	if again, _ := agentkinds.ByID("claude"); again.Start[0] != "claude" || again.ResumeByID[0] != "claude" {
		t.Errorf("the registry changed: %+v", again)
	}
}

// The kinds' JSON, as the web UI reads it from the generated registry.
func TestKindJSON(t *testing.T) {
	codex, _ := agentkinds.ByID("codex")
	b, err := json.Marshal(codex)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"codex","title":"Codex","usageProvider":"codex","start":["codex"],"continueLatest":["codex","resume","--last"],"resumeById":["codex","resume","{id}"],"transcript":"codex"}`
	if string(b) != want {
		t.Errorf("got  %s\nwant %s", b, want)
	}
	droid, _ := agentkinds.ByID("droid")
	if b, _ := json.Marshal(droid); string(b) != `{"id":"droid","title":"Droid"}` {
		t.Errorf("droid %s", b)
	}
}
