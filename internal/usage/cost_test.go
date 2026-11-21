package usage

import (
	"bytes"
	"compress/gzip"
	"context"
	"math"
	"os"
	"path"
	"path/filepath"
	"runtime"
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
	if err != nil || (runtime.GOOS != "windows" && st.Mode().Perm() != 0o600) {
		t.Fatalf("cache %v %v", st, err)
	}
	// An unchanged file is not read again: the cache's records count.
	c := loadCostCache(cache)
	p := path.Join(e.Home, ".codex/archived_sessions/rollout-old.jsonl")
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
	// A log gone leaves the cache (written once it is old enough).
	os.Remove(f)
	agedCache(t, cache)
	Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Claude}})
	if _, ok := loadCostCache(cache).Files[path.Join(e.Home, ".claude/projects/-home-u-alpha/s1.jsonl")]; ok {
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
	oldKey := path.Join(e.Home, ".claude/projects/p/old.jsonl")
	recentKey := path.Join(e.Home, ".claude/projects/p/new.jsonl")
	if _, ok := c.Files[oldKey]; ok || c.Files[recentKey] == nil || len(c.Files[recentKey].Records) != 1 {
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
	if i, _ := mp.Tier(272000); i != 0 {
		t.Errorf("short tier %d", i)
	}
	if i, _ := mp.Tier(272001); i != 1 {
		t.Errorf("long tier %d", i)
	}
	// The current Claude models: Fable 5.2 not priced as Fable 5, Sonnet
	// 5.5's cache reads, Haiku 5.5's two rate cards split at 100K tokens.
	if key, mp := Pricing.ModelPricing("claude", "claude-fable-5-2"); key != "claude-fable-5-2" || !near(mp.Tiers[0].Cost(1e6, 1e6, 1e6, 1e6, 1e6), 8+0.2+10+16+40) {
		t.Errorf("fable 5.2: %q", key)
	}
	if _, mp := Pricing.ModelPricing("claude", "claude-sonnet-5-5"); !near(mp.Tiers[0].Cost(0, 1e6, 0, 0, 0), 0.1) {
		t.Errorf("sonnet 5.5 cache reads")
	}
	_, mp = Pricing.ModelPricing("claude", "claude-haiku-5-5")
	if _, tier := mp.Tier(100000); !near(tier.Cost(1e6, 1e6, 0, 0, 1e6), 0.1+0.01+0.5) {
		t.Errorf("haiku 5.5 short prompt")
	}
	if _, tier := mp.Tier(100001); !near(tier.Cost(1e6, 1e6, 0, 0, 1e6), 0.5+0.05+2.5) {
		t.Errorf("haiku 5.5 long prompt")
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

func TestOwnPrices(t *testing.T) {
	own, err := ParsePrices([]string{"grok-5 3 0.75 9", "  ", "claude-opus-4-6 1 0.1 2 1.5", "claude-opus 100 100 100"})
	if err != nil || len(own) != 3 {
		t.Fatalf("parse %v %v", own, err)
	}
	if w := own["claude-opus-4-6"].CacheWrite; w == nil || *w != 1.5 || own["grok-5"].CacheWrite != nil {
		t.Errorf("cache write %+v", own)
	}
	for _, bad := range [][]string{
		{"grok-5 1 2"},
		{"grok-5 1 2 3 4 5"},
		{"grok-5 1 2 x"},
		{"grok-5 -1 2 3"},
		{"grok-5 1 2 3e9"},
		{"grok-5 NaN 2 3"},
		{"-grok 1 2 3"},
		{"grok-5 1 2 3", "grok-5 1 2 3"},
		make([]string, MaxOwnPrices+1),
	} {
		if _, err := ParsePrices(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	// The table's grok-4.7, the same as 4.6.
	if key, mp := Pricing.PricingWith("grok", "grok-4.7-fast", nil); key != "grok-4.7" || !near(mp.Tiers[0].Cost(1e6, 1e6, 0, 0, 1e6), 2+0.5+6) {
		t.Errorf("grok 4.7: %q", key)
	}
	// A model the table does not know; the same name replaces the
	// table's; a shorter one of the user loses to the table's, a longer
	// one wins.
	if key, mp := Pricing.PricingWith("grok", "grok-5-mini", own); key != "grok-5" || mp.Tiers[0].Output != 9 {
		t.Errorf("unknown model: %q", key)
	}
	if key, mp := Pricing.PricingWith("claude", "claude-opus-4-6-20260101", own); key != "claude-opus-4-6" || mp.Tiers[0].Input != 1 {
		t.Errorf("same name: %q %+v", key, mp)
	}
	if key, mp := Pricing.PricingWith("claude", "claude-opus-4-5", own); key != "claude-opus-4-5" || mp.Tiers[0].Input != 5 {
		t.Errorf("shorter: %q %+v", key, mp)
	}
	if key, _ := Pricing.PricingWith("claude", "claude-opus-x", own); key != "claude-opus" {
		t.Errorf("longer: %q", key)
	}
	// The scan applies them.
	e := testEnv(t, nil)
	costFixtures(t, e)
	codex, _ := ParsePrices([]string{"gpt-5.3-codex 1 0.1 10"})
	rep, err := Cost(context.Background(), e, CostOptions{Since: testNow.Add(-30 * 24 * time.Hour).Unix(), Providers: []string{Codex}, Prices: codex})
	if err != nil {
		t.Fatal(err)
	}
	if l := rowsBy(rep)["codex|gpt-5.3-codex|gamma"]; !near(l.Cost, (100*1+10*10)/1e6+(100*1+50*0.1+20*10)/1e6) {
		t.Errorf("own price applied %+v", l)
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

// agedCache makes the cache file older than costPersistEvery.
func agedCache(t *testing.T, p string) {
	t.Helper()
	old := time.Now().Add(-costPersistEvery - time.Minute)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatal(err)
	}
}

func appendTo(t *testing.T, f, text string) {
	t.Helper()
	fh, err := os.OpenFile(f, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	fh.WriteString(text)
	fh.Close()
	later := time.Now().Add(time.Minute)
	os.Chtimes(f, later, later)
}

// The cache keeps one record per response: a streamed response's lines
// are one record, the one with the final usage; a cache of another version
// is not read.
func TestCostCacheOneRecordPerResponse(t *testing.T) {
	e := testEnv(t, nil)
	costFixtures(t, e)
	since := testNow.Add(-30 * 24 * time.Hour).Unix()
	Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Claude}})
	cache := filepath.Join(e.Base, CostCacheFile)
	f := path.Join(e.Home, ".claude/projects/-home-u-alpha/s1.jsonl")
	c := loadCostCache(cache)
	if rs := c.Files[f].Records; len(rs) != 1 || rs[0].O != 500 {
		t.Fatalf("records %+v", rs)
	}
	c.Version = costCacheVer - 1
	saveCostCache(cache, c)
	if c = loadCostCache(cache); len(c.Files) != 0 || c.Version != costCacheVer {
		t.Errorf("a cache of another version read: %+v", c)
	}
}

// Logs that grow are read on from where they ended: Codex's rollouts with
// the turn's model, Grok's updates without counting a turn twice; a log
// rewritten up to there is read again; a line counts once it ends.
func TestCostReadsOn(t *testing.T) {
	e := testEnv(t, nil)
	costFixtures(t, e)
	since := testNow.Add(-30 * 24 * time.Hour).Unix()
	if _, err := Cost(context.Background(), e, CostOptions{Since: since}); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(e.Base, CostCacheFile)
	rollout := filepath.Join(e.Home, ".codex/sessions/2026/11/15/rollout-new.jsonl")
	updates := filepath.Join(e.Home, ".grok/sessions/%2Fwork%2Fdelta/abc/updates.jsonl")
	// Mark what was read: a record read again would lose the mark.
	c := loadCostCache(cache)
	c.Files[path.Join(e.Home, ".codex/sessions/2026/11/15/rollout-new.jsonl")].Records[0].O = 7777
	c.Files[path.Join(e.Home, ".grok/sessions/%2Fwork%2Fdelta/abc/updates.jsonl")].Records[0].O = 8888
	saveCostCache(cache, c)
	appendTo(t, rollout, `{"timestamp":"2026-11-15T10:01:00Z","type":"token_usage_record","payload":{"turn_id":"t1","response_id":"r2","usage":{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":10}}}`+"\n")
	appendTo(t, updates, grokUpdates)
	rep, _ := Cost(context.Background(), e, CostOptions{Since: since})
	rows := rowsBy(rep)
	if r := rows["codex|gpt-5.5|beta"]; r.Output != 7777+10 || r.Requests != 2 {
		t.Errorf("rollout read on: %+v", r)
	}
	if r := rows["grok|grok-4.6|delta"]; r.Output != 8888+1000 || r.Requests != 4 {
		t.Errorf("updates read on: %+v", r)
	}

	// A line being written counts once it ends.
	agedCache(t, cache)
	appendTo(t, rollout, `{"timestamp":"2026-11-15T10:02:00Z","type":"token_usage_record","payload":{"turn_id":"t1","response_id":"r3","usage":{"input_tokens":1000,"output_tokens":5}}}`)
	rep, _ = Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Codex}})
	if r := rowsBy(rep)["codex|gpt-5.5|beta"]; r.Requests != 2 {
		t.Errorf("an unfinished line counted: %+v", r)
	}
	agedCache(t, cache)
	appendTo(t, rollout, "\n")
	rep, _ = Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Codex}})
	if r := rowsBy(rep)["codex|gpt-5.5|beta"]; r.Requests != 3 || r.Output != 7777+10+5 {
		t.Errorf("the line once ended: %+v", r)
	}

	// Rewritten, longer than before: read from the start.
	agedCache(t, cache)
	write(t, rollout, strings.Repeat(" ", 10)+codexNew+strings.Repeat(" ", 4000)+"\n")
	later := time.Now().Add(2 * time.Minute)
	os.Chtimes(rollout, later, later)
	rep, _ = Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Codex}})
	if r := rowsBy(rep)["codex|gpt-5.5|beta"]; r.Output != 1000 || r.Requests != 1 {
		t.Errorf("rewritten log: %+v", r)
	}
}

// A scan that changed little does not write the whole cache again while
// the file is recent; one that read a lot, or a cache old enough, does.
func TestCostCacheWritesSeldom(t *testing.T) {
	e := testEnv(t, nil)
	costFixtures(t, e)
	since := testNow.Add(-30 * 24 * time.Hour).Unix()
	Cost(context.Background(), e, CostOptions{Since: since})
	cache := filepath.Join(e.Base, CostCacheFile)
	recent := time.Now().Add(-time.Minute).Truncate(time.Second)
	os.Chtimes(cache, recent, recent)
	f := filepath.Join(e.Home, ".claude/projects/-home-u-alpha/s1.jsonl")
	line := `{"timestamp":"2026-11-15T09:10:00Z","requestId":"req-2","cwd":"/home/u/alpha","message":{"role":"assistant","model":"claude-haiku-4-5","id":"msg-2","usage":{"input_tokens":10,"output_tokens":20}}}` + "\n"
	appendTo(t, f, line)
	rep, _ := Cost(context.Background(), e, CostOptions{Since: since})
	if rowsBy(rep)["claude|claude-haiku-4-5|alpha"].Requests != 1 {
		t.Fatalf("new line not counted: %+v", rep.Rows)
	}
	if st, _ := os.Stat(cache); !st.ModTime().Equal(recent) {
		t.Errorf("cache written for one line")
	}
	// Not written: the next scan reads on from the file's offsets, the
	// same numbers.
	rep, _ = Cost(context.Background(), e, CostOptions{Since: since})
	if rowsBy(rep)["claude|claude-haiku-4-5|alpha"].Requests != 1 {
		t.Fatalf("again: %+v", rep.Rows)
	}
	agedCache(t, cache)
	Cost(context.Background(), e, CostOptions{Since: since})
	if st, _ := os.Stat(cache); time.Since(st.ModTime()) > time.Minute {
		t.Errorf("an old cache not written")
	}
	if rs := loadCostCache(cache).Files[path.Join(e.Home, ".claude/projects/-home-u-alpha/s1.jsonl")].Records; len(rs) != 2 {
		t.Errorf("records %+v", rs)
	}
}

// The in-memory cost cache serves unchanged scans without reading the disk
// file again, retains unsaved incremental updates across scans, returns
// NotModified when IfNoneMatch matches, and dedupe allocates nothing when
// records have no keys.
func TestCostInMemoryCacheAndETag(t *testing.T) {
	e := testEnv(t, nil)
	costFixtures(t, e)
	since := testNow.Add(-30 * 24 * time.Hour).Unix()
	o := CostOptions{Since: since, Providers: []string{Claude}}

	first, err := Cost(context.Background(), e, o)
	if err != nil {
		t.Fatal(err)
	}
	if first.ETag == "" || first.NotModified || len(first.Rows) == 0 {
		t.Fatalf("first scan: etag=%q notMod=%v rows=%d", first.ETag, first.NotModified, len(first.Rows))
	}

	// Make the on-disk cache unreadable: the in-memory cache still serves
	// the unchanged scan and honors IfNoneMatch without touching the file.
	cache := filepath.Join(e.Base, CostCacheFile)
	if err := os.Chmod(cache, 0); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(cache, 0o600)

	oMatch := o
	oMatch.IfNoneMatch = first.ETag
	nm, err := Cost(context.Background(), e, oMatch)
	if err != nil {
		t.Fatal(err)
	}
	if !nm.NotModified || nm.ETag != first.ETag || len(nm.Rows) != 0 {
		t.Fatalf("not modified: %+v", nm)
	}

	// Different prices produce a different ETag and full rows.
	oPrice := oMatch
	oPrice.Prices = map[string]Tier{"claude-sonnet-4-6": {Input: 9, Cached: 1, Output: 20}}
	priced, err := Cost(context.Background(), e, oPrice)
	if err != nil {
		t.Fatal(err)
	}
	if priced.NotModified || priced.ETag == first.ETag || len(priced.Rows) == 0 {
		t.Fatalf("price change: notMod=%v etag=%q rows=%d", priced.NotModified, priced.ETag, len(priced.Rows))
	}

	// Appending one line bumps the in-memory generation even when the
	// recent cache file is not persisted yet, so IfNoneMatch misses and
	// the next scan sees the new generation.
	os.Chmod(cache, 0o600)
	recent := time.Now().Add(-time.Minute).Truncate(time.Second)
	os.Chtimes(cache, recent, recent)
	f := filepath.Join(e.Home, ".claude/projects/-home-u-alpha/s1.jsonl")
	appendTo(t, f, `{"timestamp":"2026-11-15T09:10:00Z","requestId":"req-9","cwd":"/home/u/alpha","message":{"role":"assistant","model":"claude-haiku-4-5","id":"msg-9","usage":{"input_tokens":10,"output_tokens":20}}}`+"\n")
	updated, err := Cost(context.Background(), e, oMatch)
	if err != nil {
		t.Fatal(err)
	}
	if updated.NotModified || updated.ETag == first.ETag || rowsBy(updated)["claude|claude-haiku-4-5|alpha"].Requests != 1 {
		t.Fatalf("after append: notMod=%v etag=%q rows=%+v", updated.NotModified, updated.ETag, updated.Rows)
	}
	// Matching the new ETag short-circuits again even while the dirty
	// state lives only in memory.
	oMatch2 := o
	oMatch2.IfNoneMatch = updated.ETag
	nm2, err := Cost(context.Background(), e, oMatch2)
	if err != nil || !nm2.NotModified || len(nm2.Rows) != 0 {
		t.Fatalf("second match: %+v err=%v", nm2, err)
	}

	// Keyless records (Grok, Kimi) do not allocate a dedupe map.
	keyless := []Record{{T: 1, M: "m", I: 10}, {T: 2, M: "m", I: 20}, {T: 3, M: "m", I: 30}}
	if allocs := testing.AllocsPerRun(100, func() {
		if got := dedupe(keyless); len(got) != 3 {
			t.Fatalf("dedupe len %d", len(got))
		}
	}); allocs != 0 {
		t.Errorf("keyless dedupe allocated %.0f times", allocs)
	}
}
