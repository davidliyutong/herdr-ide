package usage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"veldr/internal/agentproto"
)

// marker stands for what a transcript says: prompts, replies, thinking,
// tool input and output, titles. It must never reach a session's numbers.
const marker = "MARKER-5f1c-SECRET"

// The usage of the responses of the sanitized Claude Code 2.1.330
// transcript (one tool-using turn), as its assistant lines carry it.
var claude2130Usage = []struct {
	id, usage string
	lines     int
}{
	{"msg_011ChGeKiCQxZc8aSc6G2EeE", `{"input_tokens":2,"cache_creation_input_tokens":22324,"cache_read_input_tokens":31717,"output_tokens":571,"output_tokens_details":{"thinking_tokens":402},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":22324,"ephemeral_5m_input_tokens":0},"inference_geo":"global","iterations":[{"input_tokens":2,"output_tokens":571,"cache_read_input_tokens":31717,"cache_creation_input_tokens":22324,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":22324},"type":"message"}],"speed":"standard","fallback_credit":null}`, 3},
	{"msg_011ChGeLmcahN8tFqHsJWzvr", `{"input_tokens":2,"cache_creation_input_tokens":701,"cache_read_input_tokens":54041,"output_tokens":172,"output_tokens_details":{"thinking_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":701,"ephemeral_5m_input_tokens":0},"inference_geo":"global","iterations":[{"input_tokens":2,"output_tokens":172,"cache_read_input_tokens":54041,"cache_creation_input_tokens":701,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":701},"type":"message"}],"speed":"standard","fallback_credit":null}`, 2},
	{"msg_011ChGeLuHwA5jVxN35N8AjP", `{"input_tokens":2,"cache_creation_input_tokens":203,"cache_read_input_tokens":54742,"output_tokens":190,"output_tokens_details":{"thinking_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":203,"ephemeral_5m_input_tokens":0},"inference_geo":"global","iterations":[{"input_tokens":2,"output_tokens":190,"cache_read_input_tokens":54742,"cache_creation_input_tokens":203,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":203},"type":"message"}],"speed":"standard","fallback_credit":null}`, 2},
	{"msg_011ChGeMDdzh7ZAxZoXdBruX", `{"input_tokens":2,"cache_creation_input_tokens":323,"cache_read_input_tokens":54945,"output_tokens":136,"output_tokens_details":{"thinking_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":323,"ephemeral_5m_input_tokens":0},"inference_geo":"global","iterations":[{"input_tokens":2,"output_tokens":136,"cache_read_input_tokens":54945,"cache_creation_input_tokens":323,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":323},"type":"message"}],"speed":"standard","fallback_credit":null}`, 2},
	{"msg_011ChGeMK2TNB6tiAsZKg8An", `{"input_tokens":2,"cache_creation_input_tokens":169,"cache_read_input_tokens":55268,"output_tokens":145,"output_tokens_details":{"thinking_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":169,"ephemeral_5m_input_tokens":0},"inference_geo":"global","iterations":[{"input_tokens":2,"output_tokens":145,"cache_read_input_tokens":55268,"cache_creation_input_tokens":169,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":169},"type":"message"}],"speed":"standard","fallback_credit":null}`, 1},
}

// claudeAssistant is an assistant line as Claude Code 2.1.330 writes it:
// one content block of a response.
func claudeAssistant(id string, sec int, model, usage, block string, sidechain bool) string {
	return fmt.Sprintf(`{"parentUuid":"8490b89a-94d8-4ea0-aa99-918b0f3470de","isSidechain":%t,"message":{"model":%q,"id":%q,"type":"message","role":"assistant","content":[%s],"container":null,"stop_reason":"tool_use","stop_sequence":null,"usage":%s,"context_management":null},"requestedModel":%q,"type":"assistant","uuid":"54b56f9f-ae4e-467b-8ae6-%012d","timestamp":"2026-11-21T19:42:%02d.031Z","userType":"external","entrypoint":"cli","cwd":"/home/dev/project","sessionId":"e6cdc860-1055-488f-9ed2-8b8019061bb9","version":"2.1.330","gitBranch":"HEAD"}`+"\n",
		sidechain, model, id, block, usage, model, sec, sec%60)
}

// claude2130 is a transcript in the shapes of Claude Code 2.1.330's: the
// lines that are no conversation, a prompt, the responses of
// claude2130Usage block by block (thinking, text, tool use), tool results
// with their toolUseResult, the end of the turn. Every text is marker.
func claude2130() string {
	var b strings.Builder
	b.WriteString(`{"type":"mode","mode":"default","sessionId":"e6cdc860-1055-488f-9ed2-8b8019061bb9"}` + "\n")
	b.WriteString(`{"type":"permission-mode","permissionMode":"default","sessionId":"e6cdc860-1055-488f-9ed2-8b8019061bb9"}` + "\n")
	b.WriteString(`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"` + marker + ` write a file"},"uuid":"u1","timestamp":"2026-11-21T19:42:41.240Z","cwd":"/home/dev/project","sessionId":"e6cdc860-1055-488f-9ed2-8b8019061bb9","version":"2.1.330"}` + "\n")
	b.WriteString(`{"type":"attachment","attachment":{"type":"skill_listing","content":"` + marker + strings.Repeat(" skill", 20000) + `"},"timestamp":"2026-11-21T19:42:41.300Z"}` + "\n")
	b.WriteString(`{"type":"api-request-shape","shape":{"messages":[{"role":"user","content":"` + marker + `"}],"model":"claude-haiku-5-5"},"timestamp":"2026-11-21T19:42:41.400Z"}` + "\n")
	b.WriteString(`{"type":"ai-title","aiTitle":"` + marker + `","sessionId":"e6cdc860-1055-488f-9ed2-8b8019061bb9"}` + "\n")
	blocks := []string{
		`{"type":"thinking","thinking":"","signature":"` + marker + `"}`,
		`{"type":"text","text":"` + marker + ` I will write it."}`,
		`{"type":"tool_use","id":"toolu_01","name":"Write","input":{"file_path":"/home/dev/project/` + marker + `.txt","content":"` + marker + `"}}`,
	}
	sec := 44
	for i, r := range claude2130Usage {
		for j := range r.lines {
			b.WriteString(claudeAssistant(r.id, sec, "claude-haiku-5-5", r.usage, blocks[(3-r.lines+j)%3], false))
			sec++
		}
		if i < len(claude2130Usage)-1 {
			b.WriteString(`{"parentUuid":"x","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01","type":"tool_result","content":"` + marker + `"}]},"uuid":"u2","timestamp":"2026-11-21T19:42:55.741Z","toolUseResult":{"type":"create","filePath":"/home/dev/project/` + marker + `","content":"` + marker + `","structuredPatch":[],"originalFile":null},"cwd":"/home/dev/project","sessionId":"e6cdc860-1055-488f-9ed2-8b8019061bb9"}` + "\n")
		}
	}
	b.WriteString(`{"parentUuid":"b8ae","isSidechain":false,"type":"system","subtype":"turn_duration","durationMs":9725,"messageCount":34,"timestamp":"2026-11-21T19:43:04.683Z","uuid":"880e","cwd":"/home/dev/project","sessionId":"e6cdc860-1055-488f-9ed2-8b8019061bb9"}` + "\n")
	b.WriteString(`{"type":"cost-state","sessionId":"e6cdc860-1055-488f-9ed2-8b8019061bb9","stub":true}` + "\n")
	b.WriteString(`{"type":"last-prompt","lastPrompt":"` + marker + `","sessionId":"e6cdc860-1055-488f-9ed2-8b8019061bb9"}` + "\n")
	return b.String()
}

// codex0170 is a rollout in the shapes of Codex CLI 0.170.0's (the
// sanitized fixture's lines, their texts marker): a turn with a command,
// two responses and their token counts.
var codex0170 = `{"timestamp":"2026-11-21T19:43:47.797Z","ordinal":0,"type":"session_meta","payload":{"id":"01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3","session_id":"01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3","timestamp":"2026-11-21T19:43:47.797Z","cwd":"/home/dev/project","originator":"codex-tui","cli_version":"0.170.0","source":"vscode","model_provider":"openai","base_instructions":{"text":"` + marker + `"}}}
{"timestamp":"2026-11-21T19:44:00.321Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"01a1ffa3-14b8-7ca1-b982-111d6782c73f","started_at":1795290240,"model_context_window":828400,"collaboration_mode_kind":"default"}}
{"timestamp":"2026-11-21T19:44:00.400Z","ordinal":2,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"` + marker + `"}]}}
{"timestamp":"2026-11-21T19:44:01.000Z","ordinal":8,"type":"world_state","payload":{"state":"` + marker + strings.Repeat(" w", 25000) + `"}}
{"timestamp":"2026-11-21T19:44:01.088Z","ordinal":9,"type":"turn_context","payload":{"turn_id":"01a1ffa3-14b8-7ca1-b982-111d6782c73f","cwd":"/home/dev/project","model":"gpt-6.1-sol","effort":"xhigh","approval_policy":"never","summary":"none"}}
{"timestamp":"2026-11-21T19:44:01.131Z","ordinal":12,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3","turn_id":"01a1ffa3-14b8-7ca1-b982-111d6782c73f","item":{"type":"UserMessage","id":"01a1ffa3-1869-71d3-971f-43bf33b0ccd9","content":[{"type":"text","text":"` + marker + `","text_elements":[]}]}}}
{"timestamp":"2026-11-21T19:44:03.027Z","ordinal":13,"type":"event_msg","payload":{"type":"item_completed","turn_id":"01a1ffa3-14b8-7ca1-b982-111d6782c73f","item":{"type":"AgentMessage","id":"msg_1","content":[{"type":"Text","text":"` + marker + `"}],"phase":"commentary"}}}
{"timestamp":"2026-11-21T19:44:03.431Z","ordinal":16,"type":"token_usage_record","payload":{"thread_id":"01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3","turn_id":"01a1ffa3-14b8-7ca1-b982-111d6782c73f","session_id":"01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3","root_turn_id":"01a1ffa3-14b8-7ca1-b982-111d6782c73f","response_id":"resp_0585b3c4ccfa505e016b01f4815ca087d0b93330fbad20f603","usage":{"input_tokens":26763,"cached_input_tokens":13312,"cache_write_input_tokens":0,"output_tokens":46,"reasoning_output_tokens":0,"total_tokens":26809},"turn_token_usage":{"input_tokens":26763,"cached_input_tokens":13312,"cache_write_input_tokens":0,"output_tokens":46,"reasoning_output_tokens":0,"total_tokens":26809},"thread_token_usage":{"input_tokens":26763,"cached_input_tokens":13312,"cache_write_input_tokens":0,"output_tokens":46,"reasoning_output_tokens":0,"total_tokens":26809}}}
{"timestamp":"2026-11-21T19:44:04.497Z","ordinal":17,"type":"event_msg","payload":{"type":"item_completed","turn_id":"01a1ffa3-14b8-7ca1-b982-111d6782c73f","item":{"type":"CommandExecution","id":"exec-8a63","command":["/bin/zsh","-lc","echo ` + marker + `"],"cwd":"file:///home/dev/project","status":"completed","aggregated_output":"` + marker + `","exit_code":0,"duration":{"secs":0,"nanos":10834}}}}
{"timestamp":"2026-11-21T19:44:04.504Z","ordinal":19,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":26763,"cached_input_tokens":13312,"cache_write_input_tokens":0,"output_tokens":46,"reasoning_output_tokens":0,"total_tokens":26809},"last_token_usage":{"input_tokens":26763,"cached_input_tokens":13312,"cache_write_input_tokens":0,"output_tokens":46,"reasoning_output_tokens":0,"total_tokens":26809},"last_usage_includes_reasoning":true,"model_context_window":828400},"rate_limits":{"limit_id":"codex","primary":{"used_percent":49.0,"window_minutes":300,"resets_at":1795305689},"plan_type":"plus"}}}
{"timestamp":"2026-11-21T19:44:07.561Z","ordinal":20,"type":"event_msg","payload":{"type":"item_completed","turn_id":"01a1ffa3-14b8-7ca1-b982-111d6782c73f","item":{"type":"Reasoning","id":"rs_1","summary_text":["` + marker + `"],"raw_content":["` + marker + `"]}}}
{"timestamp":"2026-11-21T19:44:07.894Z","ordinal":24,"type":"token_usage_record","payload":{"thread_id":"01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3","turn_id":"01a1ffa3-14b8-7ca1-b982-111d6782c73f","session_id":"01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3","root_turn_id":"01a1ffa3-14b8-7ca1-b982-111d6782c73f","response_id":"resp_0585b3c4ccfa505e016b01f484c7cc87d0ae7d0f1f7987bec5","usage":{"input_tokens":26834,"cached_input_tokens":26624,"cache_write_input_tokens":0,"output_tokens":107,"reasoning_output_tokens":84,"total_tokens":26941},"turn_token_usage":{"input_tokens":53597,"cached_input_tokens":39936,"cache_write_input_tokens":0,"output_tokens":153,"reasoning_output_tokens":84,"total_tokens":53750},"thread_token_usage":{"input_tokens":53597,"cached_input_tokens":39936,"cache_write_input_tokens":0,"output_tokens":153,"reasoning_output_tokens":84,"total_tokens":53750}}}
{"timestamp":"2026-11-21T19:44:07.896Z","ordinal":25,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":53597,"cached_input_tokens":39936,"cache_write_input_tokens":0,"output_tokens":153,"reasoning_output_tokens":84,"total_tokens":53750},"last_token_usage":{"input_tokens":26834,"cached_input_tokens":26624,"cache_write_input_tokens":0,"output_tokens":107,"reasoning_output_tokens":84,"total_tokens":26941},"last_usage_includes_reasoning":true,"model_context_window":828400},"rate_limits":{"limit_id":"codex","primary":{"used_percent":50.0,"window_minutes":300,"resets_at":1795305689},"plan_type":"plus"}}}
{"timestamp":"2026-11-21T19:44:07.920Z","ordinal":26,"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex","primary":{"used_percent":50.0,"window_minutes":300,"resets_at":1795305689}}}}
{"timestamp":"2026-11-21T19:44:07.934Z","ordinal":27,"type":"event_msg","payload":{"type":"task_complete","turn_id":"01a1ffa3-14b8-7ca1-b982-111d6782c73f","last_agent_message":"` + marker + `","duration_ms":7620}}
`

// costTotals sums a report's rows as one session's numbers.
func costTotals(rep *CostReport) agentproto.SessionUsage {
	u := agentproto.SessionUsage{Priced: true}
	for _, r := range rep.Rows {
		u.Input += r.Input
		u.Cached += r.Cached
		u.CacheWrite += r.CacheWrite
		u.Output += r.Output
		u.Reasoning += r.Reasoning
		u.Requests += r.Requests
		u.Cost += r.Cost
		u.Priced = u.Priced && r.Priced
	}
	return u
}

func sameTotals(a, b agentproto.SessionUsage) bool {
	return a.Input == b.Input && a.Cached == b.Cached && a.CacheWrite == b.CacheWrite && a.Output == b.Output &&
		a.Reasoning == b.Reasoning && a.Requests == b.Requests && a.Priced == b.Priced && near(a.Cost, b.Cost)
}

func TestSessionCostEqualsCost(t *testing.T) {
	cases := []struct {
		name, provider, rel, log string
	}{
		{"claude 2.1.330", Claude, ".claude/projects/-home-dev-project/e6cdc860-1055-488f-9ed2-8b8019061bb9.jsonl", claude2130()},
		{"claude streamed and synthetic", Claude, ".claude/projects/-home-u-alpha/s1.jsonl", claudeLog1},
		{"codex 0.170.0", Codex, ".codex/sessions/2026/11/21/rollout-2026-11-21T19-43-47-01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3.jsonl", codex0170},
		{"codex new and replayed", Codex, ".codex/sessions/2026/11/15/rollout-new.jsonl", codexNew},
		{"codex legacy", Codex, ".codex/sessions/2026/11/14/rollout-old.jsonl", codexLegacy},
		{"claude without a price", Claude, ".claude/projects/p/s.jsonl", strings.ReplaceAll(claudeLog1, "claude-opus-4-6-20260101", "claude-zeta-1")},
	}
	// The user's prices, in place of the table's and for a model it lacks.
	own := map[string]Tier{
		"gpt-6.1-sol": {Input: 3, Cached: 0.3, Output: 20}, "gpt-5.5": {Input: 1, Cached: 0.1, Output: 8},
		"gpt-5.3-codex": {Input: 2, Cached: 0.2, Output: 9}, "claude-haiku-5-5": {Input: 0.5, Cached: 0.05, Output: 4},
		"claude-opus-4-6": {Input: 6, Cached: 0.6, Output: 30}, "claude-zeta": {Input: 7, Cached: 0.7, Output: 35},
	}
	for _, c := range cases {
		for _, prices := range []map[string]Tier{nil, own} {
			t.Run(fmt.Sprintf("%s/%d prices", c.name, len(prices)), func(t *testing.T) {
				e := testEnv(t, nil)
				p := filepath.Join(e.Home, c.rel)
				write(t, p, c.log)
				// The session read before the spend (its own read), then
				// after it (from the cost cache): the same numbers.
				u1, err := SessionCost(context.Background(), e, c.provider, byName(p), SessionOptions{Prices: prices})
				if err != nil {
					t.Fatal(err)
				}
				rep, err := Cost(context.Background(), e, CostOptions{Providers: []string{c.provider}, Prices: prices})
				if err != nil {
					t.Fatal(err)
				}
				want := costTotals(rep)
				if want.Requests == 0 || !sameTotals(u1, want) {
					t.Errorf("session %+v\n   cost %+v", u1, want)
				}
				memoForget(p)
				u2, err := SessionCost(context.Background(), e, c.provider, byName(p), SessionOptions{Prices: prices})
				if err != nil || !sameTotals(u2, want) || u2.Model != u1.Model || u2.ContextUsed != u1.ContextUsed {
					t.Errorf("from the cache %+v %v, first %+v", u2, err, u1)
				}
			})
		}
	}
}

// memoForget drops what SessionCost kept of a transcript.
func memoForget(p string) {
	sessionMemo.Lock()
	if sf := sessionMemo.files[p]; sf != nil {
		sessionMemo.bytes -= sf.bytes
		delete(sessionMemo.files, p)
	}
	sessionMemo.Unlock()
}

// byName are the transcripts at paths as SessionCost reads them, each
// opened by its name (as a regular file).
func byName(paths ...string) []SessionFile {
	out := make([]SessionFile, len(paths))
	for i, p := range paths {
		out[i] = SessionFile{Name: p, Open: func() (*os.File, error) { return openRegular(p) }}
	}
	return out
}

func TestSessionCostFixtures(t *testing.T) {
	e := testEnv(t, nil)
	cp := filepath.Join(e.Home, ".claude/projects/-home-dev-project/e6cdc860-1055-488f-9ed2-8b8019061bb9.jsonl")
	write(t, cp, claude2130())
	u, err := SessionCost(context.Background(), e, Claude, byName(cp), SessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// Five responses, each counted once however many blocks it had; all
	// its cache writes were 1-hour ones.
	want := agentproto.SessionUsage{
		Model: "claude-haiku-5-5", Input: 10, Cached: 31717 + 54041 + 54742 + 54945 + 55268,
		CacheWrite: 22324 + 701 + 203 + 323 + 169, Output: 571 + 172 + 190 + 136 + 145, Reasoning: 402,
		Requests: 5, Priced: true, ContextUsed: 2 + 55268 + 169, ContextSize: contextWindow(Claude, "claude-haiku-5-5"),
	}
	_, mp := Pricing.ModelPricing(Claude, "claude-haiku-5-5")
	t1 := mp.Tiers[0]
	want.Cost = t1.Cost(want.Input, want.Cached, 0, want.CacheWrite, want.Output)
	if !sameTotals(u, want) || u.Model != want.Model || u.ContextUsed != want.ContextUsed || u.ContextSize != want.ContextSize {
		t.Errorf("claude %+v\n  want %+v", u, want)
	}

	xp := filepath.Join(e.Home, ".codex/sessions/2026/11/21/rollout-2026-11-21T19-43-47-01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3.jsonl")
	write(t, xp, codex0170)
	u, err = SessionCost(context.Background(), e, Codex, byName(xp), SessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// Two responses (the token counts after them are replays); the context
	// is the last count with its info (not the rate limits' alone after it).
	want = agentproto.SessionUsage{
		Model: "gpt-6.1-sol", Input: (26763 - 13312) + (26834 - 26624), Cached: 13312 + 26624,
		Output: 46 + 107, Reasoning: 84, Requests: 2, Priced: true, ContextUsed: 26834, ContextSize: 828400,
	}
	_, mp = Pricing.ModelPricing(Codex, "gpt-6.1-sol")
	_, t1 = mp.Tier(26763)
	_, t2 := mp.Tier(26834)
	want.Cost = t1.Cost(26763-13312, 13312, 0, 0, 46) + t2.Cost(26834-26624, 26624, 0, 0, 107)
	if !sameTotals(u, want) || u.Model != want.Model || u.ContextUsed != want.ContextUsed || u.ContextSize != want.ContextSize {
		t.Errorf("codex %+v\n want %+v", u, want)
	}
}

func TestSessionCostReadsNoContent(t *testing.T) {
	e := testEnv(t, nil)
	cp := filepath.Join(e.Home, "c.jsonl")
	write(t, cp, claude2130())
	sub := filepath.Join(e.Home, "c/subagents/agent-1.jsonl")
	write(t, sub, claude2130())
	xp := filepath.Join(e.Home, "x.jsonl")
	write(t, xp, codex0170)
	for _, s := range []struct {
		provider string
		paths    []string
	}{{Claude, []string{cp, sub}}, {Codex, []string{xp}}} {
		u, err := SessionCost(context.Background(), e, s.provider, byName(s.paths...), SessionOptions{})
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(u)
		if u.Requests == 0 || strings.Contains(string(b), marker) || strings.Contains(string(b), "project") {
			t.Errorf("%s: %s", s.provider, b)
		}
	}
}

func TestSessionCostDedupe(t *testing.T) {
	e := testEnv(t, nil)
	const usage = `{"input_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":0,"output_tokens":%d}`
	block := `{"type":"text","text":"` + marker + `"}`
	// A response logged once per content block, each with the output so
	// far: one request, the most output.
	main := claudeAssistant("msg_A", 1, "claude-opus-5-5", fmt.Sprintf(usage, 5), block, false) +
		claudeAssistant("msg_A", 2, "claude-opus-5-5", fmt.Sprintf(usage, 50), block, false) +
		claudeAssistant("msg_A", 3, "claude-opus-5-5", fmt.Sprintf(usage, 30), block, false) +
		claudeAssistant("msg_B", 4, "claude-opus-5-5", fmt.Sprintf(usage, 7), block, false)
	mp := filepath.Join(e.Home, ".claude/projects/p/s.jsonl")
	write(t, mp, main)
	// The same response again in a subagent's transcript (a fork) counts
	// once, with the most output of its copies.
	sub := filepath.Join(e.Home, ".claude/projects/p/s/subagents/agent-a.jsonl")
	write(t, sub, claudeAssistant("msg_A", 5, "claude-opus-5-5", fmt.Sprintf(usage, 60), block, true))
	u, err := SessionCost(context.Background(), e, Claude, byName(mp, sub), SessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if u.Requests != 2 || u.Output != 60+7 || u.Input != 20 || u.Cached != 2000 {
		t.Errorf("dedupe %+v", u)
	}
}

func TestSessionCostSubagents(t *testing.T) {
	e := testEnv(t, nil)
	block := `{"type":"text","text":"` + marker + `"}`
	u1 := `{"input_tokens":100,"cache_read_input_tokens":2000,"cache_creation_input_tokens":300,"output_tokens":40}`
	u2 := `{"input_tokens":5,"cache_read_input_tokens":4000,"cache_creation_input_tokens":0,"output_tokens":9}`
	mp := filepath.Join(e.Home, ".claude/projects/p/s.jsonl")
	// The main chain's last response, then (in an older version's single
	// transcript) a subagent's line and a made-up error message after it:
	// neither is the session's context.
	write(t, mp, claudeAssistant("msg_1", 1, "claude-opus-5-5", u1, block, false)+
		claudeAssistant("msg_2", 2, "claude-opus-5-5", u2, block, false)+
		claudeAssistant("msg_3", 3, "claude-haiku-5-5", u1, block, true)+
		claudeAssistant("msg_4", 4, "<synthetic>", `{"input_tokens":0,"output_tokens":0}`, block, false))
	sub := filepath.Join(e.Home, ".claude/projects/p/s/subagents/agent-a.jsonl")
	write(t, sub, claudeAssistant("msg_5", 9, "claude-haiku-5-5", u1, block, true))
	gone := filepath.Join(e.Home, ".claude/projects/p/s/subagents/agent-gone.jsonl")
	u, err := SessionCost(context.Background(), e, Claude, byName(mp, sub, gone), SessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if u.Requests != 4 || u.Input != 305 || u.Output != 129 || u.Cached != 10000 || u.CacheWrite != 900 {
		t.Errorf("totals %+v", u)
	}
	if u.Model != "claude-opus-5-5" || u.ContextUsed != 4005 {
		t.Errorf("context from the subagents or the made-up message: %+v", u)
	}
	alone, err := SessionCost(context.Background(), e, Claude, byName(mp), SessionOptions{})
	if err != nil || alone.Requests != 3 {
		t.Errorf("main alone %+v %v", alone, err)
	}
}

func TestSessionCostContext(t *testing.T) {
	e := testEnv(t, nil)
	// A rollout of an older version: no token_usage_record, so the records
	// are the token counts', the context the last count's.
	xp := filepath.Join(e.Home, ".codex/sessions/2026/11/14/rollout-old.jsonl")
	write(t, xp, codexLegacy)
	u, err := SessionCost(context.Background(), e, Codex, byName(xp), SessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if u.Model != "gpt-5.3-codex" || u.Requests != 2 || u.ContextUsed != 150 || u.ContextSize != contextWindow(Codex, "gpt-5.3-codex") {
		t.Errorf("legacy %+v", u)
	}
	// No request yet: the model of the turn, no context.
	np := filepath.Join(e.Home, ".codex/sessions/2026/11/16/rollout-new.jsonl")
	write(t, np, `{"timestamp":"2026-11-16T10:00:00Z","type":"session_meta","payload":{"cwd":"/w"}}
{"timestamp":"2026-11-16T10:00:01Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-6.1-sol","cwd":"/w"}}
`)
	u, err = SessionCost(context.Background(), e, Codex, byName(np), SessionOptions{})
	if err != nil || u.Model != "gpt-6.1-sol" || u.Requests != 0 || u.ContextUsed != 0 || !u.Priced {
		t.Errorf("no request yet %+v %v", u, err)
	}
	// Claude: the latest request's context also when a long tail of other
	// lines follows it.
	cp := filepath.Join(e.Home, ".claude/projects/p/s.jsonl")
	tail := `{"type":"attachment","attachment":{"content":"` + strings.Repeat("x", 300<<10) + `"}}` + "\n"
	write(t, cp, claudeAssistant("msg_1", 1, "claude-opus-5-5", `{"input_tokens":3,"cache_read_input_tokens":20,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":0},"cache_creation_input_tokens":100,"output_tokens":1}`, `{"type":"text","text":"x"}`, false)+
		strings.Repeat(tail, 4))
	u, err = SessionCost(context.Background(), e, Claude, byName(cp), SessionOptions{})
	if err != nil || u.ContextUsed != 123 || u.Model != "claude-opus-5-5" {
		t.Errorf("claude context %+v %v", u, err)
	}
}

func TestSessionCostReadsOn(t *testing.T) {
	e := testEnv(t, nil)
	cp := filepath.Join(e.Home, ".claude/projects/p/s.jsonl")
	block := `{"type":"text","text":"x"}`
	usage := func(out int) string {
		return fmt.Sprintf(`{"input_tokens":1,"cache_read_input_tokens":10,"output_tokens":%d}`, out)
	}
	write(t, cp, claudeAssistant("msg_1", 1, "claude-opus-5-5", usage(5), block, false))
	at := time.Now().Add(-time.Hour)
	os.Chtimes(cp, at, at)
	u, err := SessionCost(context.Background(), e, Claude, byName(cp), SessionOptions{})
	if err != nil || u.Requests != 1 || u.Output != 5 {
		t.Fatalf("first %+v %v", u, err)
	}
	// Unchanged (its size and time): not read again, so a file rewritten
	// in place with the same size and time says what it said.
	write(t, cp, claudeAssistant("msg_9", 1, "claude-opus-5-5", usage(7), block, false))
	os.Chtimes(cp, at, at)
	if u, _ = SessionCost(context.Background(), e, Claude, byName(cp), SessionOptions{}); u.Output != 5 {
		t.Errorf("read again: %+v", u)
	}
	// Grown: read on from where the last read ended, a block of the same
	// response counting once, the last line once it ends.
	write(t, cp, claudeAssistant("msg_1", 1, "claude-opus-5-5", usage(5), block, false))
	appendTo(t, cp, claudeAssistant("msg_1", 2, "claude-opus-5-5", usage(8), block, false)+
		claudeAssistant("msg_2", 3, "claude-opus-5-5", usage(4), block, false)+`{"type":"assistant","message":{"usage"`)
	later := at.Add(time.Minute)
	os.Chtimes(cp, later, later)
	u, err = SessionCost(context.Background(), e, Claude, byName(cp), SessionOptions{})
	if err != nil || u.Requests != 2 || u.Output != 12 || u.ContextUsed != 11 {
		t.Errorf("grown %+v %v", u, err)
	}
	// Rewritten shorter: read from the start.
	write(t, cp, claudeAssistant("msg_3", 1, "claude-opus-5-5", usage(3), block, false))
	latest := later.Add(time.Minute)
	os.Chtimes(cp, latest, latest)
	if u, err = SessionCost(context.Background(), e, Claude, byName(cp), SessionOptions{}); err != nil || u.Requests != 1 || u.Output != 3 {
		t.Errorf("rewritten %+v %v", u, err)
	}
}

func TestSessionCostFromTheCostCache(t *testing.T) {
	e := testEnv(t, nil)
	xp := filepath.Join(e.Home, ".codex/sessions/2026/11/15/rollout-new.jsonl")
	write(t, xp, codexNew)
	at := time.Now().Add(-time.Hour)
	os.Chtimes(xp, at, at)
	if _, err := Cost(context.Background(), e, CostOptions{Providers: []string{Codex}}); err != nil {
		t.Fatal(err)
	}
	// The cache's entry of an unchanged log is what the session counts.
	costMu.Lock()
	memCost.cache.Files[xp].Records[0].O = 999
	costMu.Unlock()
	u, err := SessionCost(context.Background(), e, Codex, byName(xp), SessionOptions{})
	if err != nil || u.Output != 999 || u.Model != "gpt-5.5" {
		t.Errorf("not from the cache: %+v %v", u, err)
	}
	// A log that grew is read on from the cache's offset.
	memoForget(xp)
	appendTo(t, xp, `{"timestamp":"2026-11-15T10:01:00Z","type":"token_usage_record","payload":{"turn_id":"t1","response_id":"r2","usage":{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":10}}}`+"\n")
	later := at.Add(time.Minute)
	os.Chtimes(xp, later, later)
	u, err = SessionCost(context.Background(), e, Codex, byName(xp), SessionOptions{})
	if err != nil || u.Requests != 2 || u.Output != 999+10 {
		t.Errorf("not read on from the cache: %+v %v", u, err)
	}
	// A scan in progress holds the cache: the session is read, not waited
	// for.
	memoForget(xp)
	costMu.Lock()
	done := make(chan agentproto.SessionUsage, 1)
	go func() {
		u, _ := SessionCost(context.Background(), e, Codex, byName(xp), SessionOptions{})
		done <- u
	}()
	select {
	case u = <-done:
		if u.Requests != 2 || u.Output != 1010 {
			t.Errorf("read beside a scan: %+v", u)
		}
	case <-time.After(5 * time.Second):
		t.Error("waited for the scan")
	}
	costMu.Unlock()
}

func TestSessionCostRetention(t *testing.T) {
	e := testEnv(t, nil)
	cp := filepath.Join(e.Home, ".claude/projects/p/s.jsonl")
	old := strings.ReplaceAll(claudeLog2, "2026-11-15T09:00:02Z", testNow.Add(-Retention-time.Hour).Format(time.RFC3339))
	write(t, cp, old+strings.ReplaceAll(claudeLog2, "req-1", "req-2"))
	u, err := SessionCost(context.Background(), e, Claude, byName(cp), SessionOptions{})
	if err != nil || u.Requests != 1 {
		t.Errorf("past the retention %+v %v", u, err)
	}
	rep, _ := Cost(context.Background(), e, CostOptions{Providers: []string{Claude}})
	if want := costTotals(rep); !sameTotals(u, want) {
		t.Errorf("session %+v cost %+v", u, want)
	}
}

func TestSessionCostErrors(t *testing.T) {
	e := testEnv(t, nil)
	p := filepath.Join(e.Home, "s.jsonl")
	write(t, p, claudeLog1)
	for _, prov := range []string{Grok, Kimi, OpenCode, Antigravity, DeepSeek, "", "claude/../x"} {
		if _, err := SessionCost(context.Background(), e, prov, byName(p), SessionOptions{}); !errors.Is(err, ErrSessionProvider) {
			t.Errorf("provider %q: %v", prov, err)
		}
	}
	if _, err := SessionCost(context.Background(), e, Claude, nil, SessionOptions{}); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("no transcript: %v", err)
	}
	if _, err := SessionCost(context.Background(), e, Claude, byName(filepath.Join(e.Home, "missing.jsonl")), SessionOptions{}); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("missing: %v", err)
	}
	// A directory is no transcript.
	if _, err := SessionCost(context.Background(), e, Claude, byName(e.Home), SessionOptions{}); err == nil {
		t.Error("a directory was read")
	}
	// Larger than MaxSessionBytes (a sparse file): refused unread, also as
	// a subagent's.
	big := filepath.Join(e.Home, "big.jsonl")
	f, err := os.Create(big)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(MaxSessionBytes + 1); err != nil {
		t.Fatal(err)
	}
	f.Close()
	for _, paths := range [][]string{{big}, {p, big}} {
		if _, err := SessionCost(context.Background(), e, Claude, byName(paths...), SessionOptions{}); !errors.Is(err, ErrSessionTooLarge) {
			t.Errorf("too large %v: %v", paths, err)
		}
	}
	// A request that ended.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := SessionCost(ctx, e, Claude, byName(p), SessionOptions{}); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled: %v", err)
	}
}

func TestSessionProvider(t *testing.T) {
	for kind, want := range map[string]string{"claude": Claude, "codex": Codex} {
		if got, ok := SessionProvider(kind); !ok || got != want {
			t.Errorf("%s: %q %v", kind, got, ok)
		}
	}
	// Unknown kinds, kinds without a subscription the plugin reads, and
	// kinds whose transcripts are not the provider's logs.
	for _, kind := range []string{"", "nope", "Claude", "claude ", "gemini", "cursor", "opencode", "kimi", "grok", "agy"} {
		if got, ok := SessionProvider(kind); ok {
			t.Errorf("%q: %q", kind, got)
		}
	}
}

func TestSessionMemoBounded(t *testing.T) {
	e := testEnv(t, nil)
	for i := range sessionMemoSize + 5 {
		p := filepath.Join(e.Home, fmt.Sprintf("s%d.jsonl", i))
		write(t, p, claudeLog1)
		if _, err := SessionCost(context.Background(), e, Claude, byName(p), SessionOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	sessionMemo.Lock()
	n := len(sessionMemo.files)
	_, newest := sessionMemo.files[filepath.Join(e.Home, fmt.Sprintf("s%d.jsonl", sessionMemoSize+4))]
	_, oldest := sessionMemo.files[filepath.Join(e.Home, "s0.jsonl")]
	sessionMemo.Unlock()
	if n > sessionMemoSize || !newest || oldest {
		t.Errorf("memo of %d, newest %v, oldest %v", n, newest, oldest)
	}
}

// TestSessionCostOpensNoName: SessionCost reads what Open opens and never
// opens a name itself, also not one that is now a link to a file elsewhere.
func TestSessionCostOpensNoName(t *testing.T) {
	e := testEnv(t, nil)
	block := `{"type":"text","text":"x"}`
	inside := filepath.Join(e.Home, "inside.jsonl")
	write(t, inside, claudeAssistant("msg_in", 1, "claude-opus-5-5", `{"input_tokens":3,"output_tokens":4}`, block, false))
	outside := filepath.Join(t.TempDir(), "outside.jsonl")
	write(t, outside, claudeAssistant("msg_out", 1, "claude-opus-5-5", `{"input_tokens":700,"output_tokens":900}`, block, false))
	name := filepath.Join(e.Home, ".claude/projects/p/00000001-abcd-4ef0-8abc-000000000001.jsonl")
	os.MkdirAll(filepath.Dir(name), 0o700)
	if err := os.Symlink(outside, name); err != nil {
		t.Fatal(err)
	}
	opened := 0
	files := []SessionFile{{Name: name, Open: func() (*os.File, error) {
		opened++
		return openRegular(inside)
	}}}
	u, err := SessionCost(context.Background(), e, Claude, files, SessionOptions{})
	if err != nil || opened != 1 || u.Input != 3 || u.Output != 4 {
		t.Errorf("read %+v %v, opened %d", u, err, opened)
	}
	// The opener's refusal is the answer; a subagent's that is gone is left
	// out, one refused otherwise is not.
	refused := errors.New("not the file located")
	files[0].Open = func() (*os.File, error) { return nil, refused }
	if _, err := SessionCost(context.Background(), e, Claude, files, SessionOptions{}); !errors.Is(err, refused) {
		t.Errorf("refused: %v", err)
	}
	files = append(byName(inside),
		SessionFile{Name: "gone", Open: func() (*os.File, error) { return nil, fmt.Errorf("gone: %w", os.ErrNotExist) }},
		SessionFile{Name: "none"})
	if u, err := SessionCost(context.Background(), e, Claude, files, SessionOptions{}); err != nil || u.Requests != 1 {
		t.Errorf("gone subagents: %+v %v", u, err)
	}
	files[1].Open = func() (*os.File, error) { return nil, refused }
	if _, err := SessionCost(context.Background(), e, Claude, files, SessionOptions{}); !errors.Is(err, refused) {
		t.Errorf("refused subagent: %v", err)
	}
	// What is opened must be a regular file.
	files = []SessionFile{{Name: "dir", Open: func() (*os.File, error) { return os.Open(e.Home) }}}
	if _, err := SessionCost(context.Background(), e, Claude, files, SessionOptions{}); err == nil {
		t.Error("a directory was read")
	}
}

// TestSessionCostModelCut: a model's name, however long, reaches the
// numbers cut to sessionModelBytes at a character.
func TestSessionCostModelCut(t *testing.T) {
	e := testEnv(t, nil)
	block := `{"type":"text","text":"x"}`
	for _, long := range []string{strings.Repeat("M", 1<<20), "claude-" + strings.Repeat("é", 100), "c" + strings.Repeat("日本", 100)} {
		cp := filepath.Join(e.Home, fmt.Sprintf("m%d.jsonl", len(long)))
		write(t, cp, claudeAssistant("msg_x", 1, long, `{"input_tokens":7,"output_tokens":9}`, block, false))
		u, err := SessionCost(context.Background(), e, Claude, byName(cp), SessionOptions{})
		if err != nil || len(u.Model) > sessionModelBytes || len(u.Model) < sessionModelBytes-3 || !utf8.ValidString(u.Model) || !strings.HasPrefix(long, u.Model) {
			t.Errorf("model of %d bytes: %d bytes %q, %v", len(long), len(u.Model), u.Model[:min(len(u.Model), 20)], err)
		}
		b, _ := json.Marshal(u)
		if len(b) > 1024 {
			t.Errorf("reply of %d bytes", len(b))
		}
		xp := filepath.Join(e.Home, fmt.Sprintf("x%d.jsonl", len(long)))
		write(t, xp, `{"timestamp":"2026-11-16T10:00:01Z","type":"turn_context","payload":{"turn_id":"t1","model":"`+long+`","cwd":"/w"}}`+"\n")
		if u, err := SessionCost(context.Background(), e, Codex, byName(xp), SessionOptions{}); err != nil || len(u.Model) > sessionModelBytes || !utf8.ValidString(u.Model) {
			t.Errorf("codex model of %d bytes: %d bytes, %v", len(long), len(u.Model), err)
		}
	}
	if got := cutModel("claude-opus-5-5"); got != "claude-opus-5-5" {
		t.Errorf("short name cut: %q", got)
	}
}

// bound sets a bound for the test.
func bound[T any](t *testing.T, v *T, to T) {
	old := *v
	*v = to
	t.Cleanup(func() { *v = old })
}

// distinct is a Claude transcript of n responses, each its own record.
func distinct(n, from int, proj string) string {
	var b strings.Builder
	for i := range n {
		fmt.Fprintf(&b, `{"type":"assistant","timestamp":"2026-11-21T19:42:44Z","cwd":%q,"message":{"role":"assistant","model":"claude-opus-5-5","id":"m%d","usage":{"input_tokens":1}}}`+"\n", proj, from+i)
	}
	return b.String()
}

// TestSessionCostHeld: a session whose transcripts hold more records than
// are kept is too large, counted before duplicates go and across the
// transcripts; what the memo keeps is bounded in bytes.
func TestSessionCostHeld(t *testing.T) {
	e := testEnv(t, nil)
	bound(t, &sessionMaxRecords, 100)
	mp := filepath.Join(e.Home, "main.jsonl")
	write(t, mp, distinct(60, 0, "/p"))
	sub := filepath.Join(e.Home, "sub.jsonl")
	write(t, sub, distinct(60, 100, "/p"))
	if u, err := SessionCost(context.Background(), e, Claude, byName(mp), SessionOptions{}); err != nil || u.Requests != 60 {
		t.Fatalf("within: %+v %v", u, err)
	}
	// Also when the main transcript's read is the memo's.
	if _, err := SessionCost(context.Background(), e, Claude, byName(mp, sub), SessionOptions{}); !errors.Is(err, ErrSessionTooLarge) {
		t.Errorf("across transcripts: %v", err)
	}
	big := filepath.Join(e.Home, "big.jsonl")
	write(t, big, distinct(101, 0, "/p"))
	if _, err := SessionCost(context.Background(), e, Claude, byName(big), SessionOptions{}); !errors.Is(err, ErrSessionTooLarge) {
		t.Errorf("one transcript: %v", err)
	}
	// Streamed blocks of one response count until they are one.
	streamed := filepath.Join(e.Home, "streamed.jsonl")
	write(t, streamed, strings.Repeat(distinct(1, 0, "/p"), 101))
	if _, err := SessionCost(context.Background(), e, Claude, byName(streamed), SessionOptions{}); !errors.Is(err, ErrSessionTooLarge) {
		t.Errorf("before duplicates go: %v", err)
	}

	// Bytes: records with long strings.
	bound(t, &sessionMaxRecords, 1000)
	bound(t, &sessionMaxHeld, 64<<10)
	long := filepath.Join(e.Home, "long.jsonl")
	write(t, long, distinct(10, 0, "/"+strings.Repeat("d", 8<<10)))
	if _, err := SessionCost(context.Background(), e, Claude, byName(long), SessionOptions{}); !errors.Is(err, ErrSessionTooLarge) {
		t.Errorf("bytes: %v", err)
	}

	// The memo keeps at most sessionMemoBytes.
	bound(t, &sessionMaxHeld, 1<<20)
	bound(t, &sessionMemoBytes, 3*(40*recordSize+400))
	var names []string
	for i := range 6 {
		p := filepath.Join(e.Home, fmt.Sprintf("memo%d.jsonl", i))
		write(t, p, distinct(40, 0, "/p"))
		if _, err := SessionCost(context.Background(), e, Claude, byName(p), SessionOptions{}); err != nil {
			t.Fatal(err)
		}
		names = append(names, p)
	}
	sessionMemo.Lock()
	var sum int64
	for _, sf := range sessionMemo.files {
		sum += sf.bytes
	}
	_, newest := sessionMemo.files[names[5]]
	_, oldest := sessionMemo.files[names[0]]
	total := sessionMemo.bytes
	sessionMemo.Unlock()
	if total != sum || total > sessionMemoBytes || !newest || oldest {
		t.Errorf("memo of %d bytes (sum %d, bound %d), newest %v, oldest %v", total, sum, sessionMemoBytes, newest, oldest)
	}
	// One larger than the memo alone is read, not kept.
	huge := filepath.Join(e.Home, "huge.jsonl")
	write(t, huge, distinct(200, 0, "/p"))
	if u, err := SessionCost(context.Background(), e, Claude, byName(huge), SessionOptions{}); err != nil || u.Requests != 200 {
		t.Errorf("huge %+v %v", u, err)
	}
	sessionMemo.Lock()
	_, kept := sessionMemo.files[huge]
	over := sessionMemo.bytes > sessionMemoBytes
	sessionMemo.Unlock()
	if kept || over {
		t.Errorf("kept %v, over %v", kept, over)
	}
}

// TestSessionCostParallel: at most sessionParallel calls read at once; one
// that waits ends with its ctx.
func TestSessionCostParallel(t *testing.T) {
	e := testEnv(t, nil)
	p := filepath.Join(e.Home, "s.jsonl")
	write(t, p, claudeLog1)
	gate := make(chan struct{})
	entered := make(chan struct{}, 8)
	files := []SessionFile{{Name: p, Open: func() (*os.File, error) {
		entered <- struct{}{}
		<-gate
		return openRegular(p)
	}}}
	done := make(chan error, sessionParallel)
	for range sessionParallel {
		go func() {
			_, err := SessionCost(context.Background(), e, Claude, files, SessionOptions{})
			done <- err
		}()
	}
	for range sessionParallel {
		<-entered
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := SessionCost(ctx, e, Claude, files, SessionOptions{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("a third call: %v", err)
	}
	select {
	case <-entered:
		t.Error("a third call read")
	default:
	}
	close(gate)
	for range sessionParallel {
		if err := <-done; err != nil {
			t.Error(err)
		}
	}
	if _, err := SessionCost(context.Background(), e, Claude, files, SessionOptions{}); err != nil {
		t.Errorf("after: %v", err)
	}
}

// TestSessionCostReadEndsWithCtx: ctx is checked while a transcript is
// read, not only between transcripts.
func TestSessionCostReadEndsWithCtx(t *testing.T) {
	e := testEnv(t, nil)
	p := filepath.Join(e.Home, "s.jsonl")
	write(t, p, distinct(5000, 0, "/p"))
	f, err := openRegular(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	st, _ := f.Stat()
	ctx, cancel := context.WithCancel(context.Background())
	// Ended after the parser's first read: the next fails.
	reads := 0
	h := &held{}
	ent := &fileEntry{Kind: logClaude}
	br := &boundedReader{ctx: ctx, r: readerFunc(func(b []byte) (int, error) {
		reads++
		cancel()
		return f.Read(b[:min(len(b), 4096)])
	}), ent: ent, h: h}
	if _, err := logParsers[logClaude](p, br, false, ent); !errors.Is(err, context.Canceled) || reads != 1 {
		t.Errorf("parse: %v after %d reads", err, reads)
	}
	if _, err := readOnSession(ctx, f, p, logClaude, st.Size(), st.ModTime().UnixNano(), nil, &held{}); !errors.Is(err, context.Canceled) {
		t.Errorf("readOnSession: %v", err)
	}
	if m, used, _ := latestContext(ctxReaderAt{ctx, f}, logClaude, st.Size()); m != "" || used != 0 {
		t.Errorf("latestContext read: %q %d", m, used)
	}
}

type readerFunc func([]byte) (int, error)

func (f readerFunc) Read(b []byte) (int, error) { return f(b) }
