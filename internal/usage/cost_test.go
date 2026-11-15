package usage

import (
	"bytes"
	"compress/gzip"
	"context"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const claudeLog1 = `{"type":"user","timestamp":"2026-11-15T09:00:00Z","message":{"role":"user","content":"hi"}}
{"timestamp":"2026-11-15T09:00:01Z","requestId":"req-1","cwd":"/home/u/alpha","message":{"role":"assistant","model":"claude-opus-4-6-20260101","id":"msg-1","usage":{"input_tokens":1000,"cache_read_input_tokens":2000,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200},"output_tokens":100}}}
{"timestamp":"2026-11-15T09:00:02Z","requestId":"req-1","cwd":"/home/u/alpha","message":{"role":"assistant","model":"claude-opus-4-6-20260101","id":"msg-1","usage":{"input_tokens":1000,"cache_read_input_tokens":2000,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200},"output_tokens":500}}}
{"timestamp":"2026-11-15T09:00:03Z","requestId":"req-x","message":{"role":"assistant","model":"<synthetic>","id":"msg-x","usage":{"input_tokens":5,"output_tokens":5}}}
`

// The same response again in a forked session.
const claudeLog2 = `{"timestamp":"2026-11-15T09:00:02Z","requestId":"req-1","cwd":"/home/u/alpha","message":{"role":"assistant","model":"claude-opus-4-6-20260101","id":"msg-1","usage":{"input_tokens":1000,"cache_read_input_tokens":2000,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200},"output_tokens":400}}}
`

const codexNew = `{"timestamp":"2026-11-15T10:00:00Z","type":"session_meta","payload":{"cwd":"/work/beta"}}
{"timestamp":"2026-11-15T10:00:00Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5.5","cwd":"/work/beta"}}
{"timestamp":"2026-11-15T10:00:05Z","type":"token_usage_record","payload":{"turn_id":"t1","response_id":"r1","usage":{"input_tokens":300000,"cached_input_tokens":100000,"output_tokens":1000,"reasoning_output_tokens":200}}}
{"timestamp":"2026-11-15T10:00:06Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300000},"last_token_usage":{"input_tokens":300000,"cached_input_tokens":100000,"output_tokens":1000}}}}
`

const codexLegacy = `{"timestamp":"2026-11-14T10:00:00Z","type":"turn_context","payload":{"model":"gpt-5.3-codex","cwd":"/work/gamma"}}
{"timestamp":"2026-11-14T10:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}}}
{"timestamp":"2026-11-14T10:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}}}
{"timestamp":"2026-11-14T10:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":250},"last_token_usage":{"input_tokens":150,"cached_input_tokens":50,"output_tokens":20}}}}
`

const grokUpdates = `{"method":"session/update","params":{"_meta":{"agentTimestampMs":1794744000000},"update":{"sessionUpdate":"turn_completed","usage":{"modelUsage":{"grok-4.6-0709":{"modelCalls":2,"inputTokens":500000,"cachedReadTokens":100000,"cacheCreationTokens":0,"outputTokens":1000,"reasoningTokens":300}}}}}}
`

const grokEvents = `{"type":"turn_started","session_id":"s1","model_id":"grok-4.6"}
`

const grokUnified = `{"ts":"2026-11-15T11:00:00Z","msg":"shell.turn.inference_done","sid":"s1","ctx":{"prompt_tokens":1000,"cached_prompt_tokens":200,"completion_tokens":50,"reasoning_tokens":10}}
{"ts":"2026-11-15T11:00:01Z","msg":"shell.turn.inference_retry","sid":"s1"}
`

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func costFixtures(t *testing.T, e *Env) {
	write(t, filepath.Join(e.Home, ".claude/projects/-home-u-alpha/s1.jsonl"), claudeLog1)
	write(t, filepath.Join(e.Home, ".claude/projects/-home-u-alpha/sub/fork.jsonl"), claudeLog2)
	write(t, filepath.Join(e.Home, ".codex/sessions/2026/11/15/rollout-new.jsonl"), codexNew)
	write(t, filepath.Join(e.Home, ".codex/archived_sessions/rollout-old.jsonl"), codexLegacy)
	write(t, filepath.Join(e.Home, ".grok/sessions/%2Fwork%2Fdelta/abc/updates.jsonl"), grokUpdates)
	write(t, filepath.Join(e.Home, ".grok/sessions/%2Fwork%2Fdelta/abc/events.jsonl"), grokEvents)
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write([]byte(grokUnified))
	zw.Close()
	write(t, filepath.Join(e.Home, ".grok/logs/unified.jsonl.1.gz"), gz.String())
}

func rowsBy(rep *CostReport) map[string]CostRow {
	out := map[string]CostRow{}
	for _, r := range rep.Rows {
		k := r.Provider + "|" + r.Model + "|" + r.Project
		if prev, ok := out[k]; ok {
			prev.Cost += r.Cost
			prev.Output += r.Output
			prev.Requests += r.Requests
			r = prev
		}
		out[k] = r
	}
	return out
}

func TestCost(t *testing.T) {
	e := testEnv(t, nil)
	costFixtures(t, e)
	rep, err := Cost(context.Background(), e, CostOptions{Since: testNow.Add(-30 * 24 * time.Hour).Unix()})
	if err != nil {
		t.Fatal(err)
	}
	rows := rowsBy(rep)
	// Claude: one response (the most output of its copies), 5 m and 1 h
	// cache writes at their own prices, the synthetic message left out.
	c := rows["claude|claude-opus-4-6|alpha"]
	if c.Requests != 1 || c.Output != 500 || c.CacheWrite != 300 || !near(c.Cost, (1000*5+2000*0.5+100*6.25+200*10+500*25)/1e6) {
		t.Errorf("claude %+v", c)
	}
	// Codex, new format: the long-context tier; the token_count after it
	// is a replay.
	x := rows["codex|gpt-5.5|beta"]
	if x.Requests != 1 || x.Input != 200000 || x.Cached != 100000 || !near(x.Cost, (200000*10+100000*1+1000*45)/1e6) {
		t.Errorf("codex new %+v", x)
	}
	// Codex, legacy: a total that does not move is a replay.
	l := rows["codex|gpt-5.3-codex|gamma"]
	if l.Requests != 2 || !near(l.Cost, (100*1.75+10*14)/1e6+(100*1.75+50*0.175+20*14)/1e6) {
		t.Errorf("codex legacy %+v", l)
	}
	// Grok: the tier by the turn's average prompt (250k: the long one).
	g := rows["grok|grok-4.6|delta"]
	if g.Requests != 2 || !near(g.Cost, (400000*4+100000*1+1000*12)/1e6) {
		t.Errorf("grok %+v", g)
	}
	// Legacy Grok: the model from the session's events, retries counted.
	lg := rows["grok|grok-4.6|"]
	if lg.Requests != 1 || !near(lg.Cost, (800*2+200*0.5+50*6)/1e6) || rep.Retries != 1 {
		t.Errorf("grok legacy %+v retries %d", lg, rep.Retries)
	}
	if rep.Files != 6 || len(rep.Unpriced) != 0 {
		t.Errorf("files %d unpriced %v", rep.Files, rep.Unpriced)
	}
	// Days are the user's.
	rep, _ = Cost(context.Background(), e, CostOptions{Since: testNow.Add(-30 * 24 * time.Hour).Unix(), TZOffset: 15 * 60, Providers: []string{Claude}})
	if len(rep.Rows) != 1 || rep.Rows[0].Day != "2026-11-16" {
		t.Errorf("tz rows %+v", rep.Rows)
	}
	// Since leaves out what was before.
	rep, _ = Cost(context.Background(), e, CostOptions{Since: time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC).Unix(), Providers: []string{Codex}})
	if len(rep.Rows) != 1 || rep.Rows[0].Model != "gpt-5.5" {
		t.Errorf("since rows %+v", rep.Rows)
	}
}

func TestCostCache(t *testing.T) {
	e := testEnv(t, nil)
	costFixtures(t, e)
	since := testNow.Add(-30 * 24 * time.Hour).Unix()
	if _, err := Cost(context.Background(), e, CostOptions{Since: since}); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(e.Base, CostCacheFile)
	st, err := os.Stat(cache)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("cache %v %v", st, err)
	}
	// An unchanged file is not read again: the cache's records count.
	c := loadCostCache(cache)
	p := filepath.Join(e.Home, ".codex/archived_sessions/rollout-old.jsonl")
	ent := c.Files[p]
	ent.Records[0].O = 999
	saveCostCache(cache, c)
	rep, _ := Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Codex}})
	if rowsBy(rep)["codex|gpt-5.3-codex|gamma"].Output != 999+20 {
		t.Errorf("cache not used: %+v", rep.Rows)
	}
	// A Claude log that grew is read on from where it ended.
	f := filepath.Join(e.Home, ".claude/projects/-home-u-alpha/s1.jsonl")
	fh, _ := os.OpenFile(f, os.O_APPEND|os.O_WRONLY, 0)
	fh.WriteString(`{"timestamp":"2026-11-15T09:10:00Z","requestId":"req-2","cwd":"/home/u/alpha","message":{"role":"assistant","model":"claude-haiku-4-5","id":"msg-2","usage":{"input_tokens":10,"output_tokens":20}}}` + "\n")
	fh.Close()
	later := time.Now().Add(time.Minute)
	os.Chtimes(f, later, later)
	rep, _ = Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Claude}})
	rows := rowsBy(rep)
	if rows["claude|claude-haiku-4-5|alpha"].Requests != 1 || rows["claude|claude-opus-4-6|alpha"].Requests != 1 {
		t.Errorf("grown log: %+v", rep.Rows)
	}
	// A log gone leaves the cache.
	os.Remove(f)
	Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Claude}})
	if _, ok := loadCostCache(cache).Files[f]; ok {
		t.Errorf("removed log still cached")
	}
}

func TestCostRetention(t *testing.T) {
	e := testEnv(t, nil)
	e.Now = func() time.Time { return time.Now() }
	old := time.Now().Add(-100 * 24 * time.Hour)
	f := filepath.Join(e.Home, ".claude/projects/p/old.jsonl")
	write(t, f, strings.ReplaceAll(claudeLog2, "2026-11-15T09:00:02Z", old.UTC().Format(time.RFC3339)))
	os.Chtimes(f, old, old)
	recent := filepath.Join(e.Home, ".claude/projects/p/new.jsonl")
	write(t, recent, strings.ReplaceAll(claudeLog2, "2026-11-15T09:00:02Z", old.UTC().Format(time.RFC3339))+
		strings.ReplaceAll(strings.ReplaceAll(claudeLog2, "2026-11-15T09:00:02Z", time.Now().UTC().Format(time.RFC3339)), "req-1", "req-9"))
	rep, _ := Cost(context.Background(), e, CostOptions{Since: 0})
	if len(rep.Rows) != 1 || rep.Rows[0].Requests != 1 || rep.Since < time.Now().Add(-Retention-time.Minute).Unix() {
		t.Errorf("rows %+v since %d", rep.Rows, rep.Since)
	}
	c := loadCostCache(filepath.Join(e.Base, CostCacheFile))
	if _, ok := c.Files[f]; ok || len(c.Files[recent].Records) != 1 {
		t.Errorf("cache keeps old records: %+v", c.Files)
	}
}

func TestPricingTiers(t *testing.T) {
	key, mp := Pricing.ModelPricing("claude", "claude-opus-4-5-20251101")
	if key != "claude-opus-4-5" || mp == nil {
		t.Fatalf("longest prefix: %q", key)
	}
	if key, _ := Pricing.ModelPricing("claude", "claude-opus-4-1"); key != "claude-opus-4" {
		t.Errorf("prefix %q", key)
	}
	if _, mp := Pricing.ModelPricing("codex", "o3"); mp != nil {
		t.Errorf("unknown model priced")
	}
	_, mp = Pricing.ModelPricing("codex", "gpt-5.5")
	if i, _ := mp.Tier(271999); i != 0 {
		t.Errorf("short tier %d", i)
	}
	if i, _ := mp.Tier(272000); i != 1 {
		t.Errorf("long tier %d", i)
	}
	// Cache writes default to the input price (5 m) and twice it (1 h).
	_, mp = Pricing.ModelPricing("grok", "grok-4.6")
	_, tier := mp.Tier(10)
	if !near(tier.Cost(0, 0, 1e6, 1e6, 0), 2+4) {
		t.Errorf("default cache-write prices: %v", tier.Cost(0, 0, 1e6, 1e6, 0))
	}
	if Pricing.WeekHours != 168 || Pricing.MonthHours != 750 {
		t.Errorf("hours %+v", Pricing)
	}
}

// cancelAfter is a context whose Err turns to Canceled after n checks.
type cancelAfter struct {
	context.Context
	n int
}

func (c *cancelAfter) Err() error {
	if c.n--; c.n < 0 {
		return context.Canceled
	}
	return nil
}

func TestCostCancelKeepsProgress(t *testing.T) {
	e := testEnv(t, nil)
	costFixtures(t, e)
	since := testNow.Add(-30 * 24 * time.Hour).Unix()
	rep, err := Cost(&cancelAfter{Context: context.Background(), n: 2}, e, CostOptions{Since: since})
	if err != context.Canceled || rep != nil {
		t.Fatalf("cancelled scan: %v %+v", err, rep)
	}
	// What was read before the cancel is in the cache.
	c := loadCostCache(filepath.Join(e.Base, CostCacheFile))
	if len(c.Files) != 2 {
		t.Errorf("cached %d files after a cancel, want 2", len(c.Files))
	}
	rep, err = Cost(context.Background(), e, CostOptions{Since: since})
	if err != nil || rep.Files != 6 {
		t.Errorf("full scan after a cancel: %v %+v", err, rep)
	}
}
