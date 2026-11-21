package usage

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestKimiModelName(t *testing.T) {
	cases := map[string]string{
		"kimi-code/k3":                        "kimi-k3",
		"kimi-code/k3-256k":                   "kimi-k3-256k",
		"kimi-code/k3.1-pro":                  "kimi-k3.1-pro",
		"kimi-code/k3.1-pro-highspeed":        "kimi-k3.1-pro-highspeed",
		"kimi-code/kimi-for-coding":           "kimi-for-coding",
		"kimi-code/kimi-for-coding-highspeed": "kimi-for-coding-highspeed",
		"moonshot/kimi-k2.7-code":             "kimi-k2.7-code",
		"k2.6":                                "kimi-k2.6",
		"":                                    "unknown",
	}
	for in, want := range cases {
		if got := kimiModelName(in); got != want {
			t.Errorf("kimiModelName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestKimiCost(t *testing.T) {
	e := testEnv(t, nil)

	// Session 1: state.json v2 (cwd), main + sub-agent, turn + session (compaction) scopes,
	// plus step.end loop events that must NOT be double-counted.
	s1 := filepath.Join(e.Home, ".kimi-code/sessions/wd_alpha_a1b2c3d4e5f6/session_1")
	write(t, filepath.Join(s1, "state.json"), `{"id":"session_1","version":2,"cwd":"/work/alpha-repo"}`)
	write(t, filepath.Join(s1, "agents/main/wire.jsonl"),
		`{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":2000,"output":500,"inputCacheRead":10000,"inputCacheCreation":0}}}`+"\n"+
			`{"type":"usage.record","agentId":"main","model":"kimi-code/k3.1-pro","usage":{"inputOther":2000,"output":500,"inputCacheRead":10000,"inputCacheCreation":100},"usageScope":"turn","time":1794736800000}`+"\n"+
			`{"type":"usage.record","agentId":"main","model":"kimi-code/k3-256k","usage":{"inputOther":3000,"output":200,"inputCacheRead":5000,"inputCacheCreation":0},"usageScope":"session","time":1794736900000}`+"\n"+
			`{"type":"usage.record","agentId":"main","model":"kimi-code/k3","usage":{"inputOther":0,"output":0,"inputCacheRead":0,"inputCacheCreation":0},"usageScope":"turn","time":1794737000000}`+"\n",
	)
	write(t, filepath.Join(s1, "agents/agent-0/wire.jsonl"),
		`{"type":"usage.record","agentId":"agent-0","model":"kimi-code/k3.1-pro","usage":{"inputOther":1000,"output":300,"inputCacheRead":4000,"inputCacheCreation":0},"usageScope":"turn","time":1794737100000}`+"\n",
	)

	// Session 2: state.json v1 (workDir) and kimi-for-coding + an unpriced custom model.
	s2 := filepath.Join(e.Home, ".kimi-code/sessions/wd_beta_0123456789ab/session_2")
	write(t, filepath.Join(s2, "state.json"), `{"workDir":"/work/beta-app"}`)
	write(t, filepath.Join(s2, "agents/main/wire.jsonl"),
		`{"type":"usage.record","model":"kimi-code/kimi-for-coding","usage":{"inputOther":5000,"output":400,"inputCacheRead":20000,"inputCacheCreation":0},"usageScope":"turn","time":1794650400000}`+"\n"+
			`{"type":"usage.record","model":"kimi-code/custom-preview","usage":{"inputOther":1000,"output":100,"inputCacheRead":0,"inputCacheCreation":0},"usageScope":"turn","time":1794650500000}`+"\n",
	)

	// Session 3: no state.json -> project name falls back to workspace dir name.
	s3 := filepath.Join(e.Home, ".kimi-code/sessions/wd_fallback-proj_deadbeefcafe/session_3")
	write(t, filepath.Join(s3, "agents/main/wire.jsonl"),
		`{"type":"usage.record","model":"kimi-code/k3.1-pro-highspeed","usage":{"inputOther":1000,"output":250,"inputCacheRead":5000,"inputCacheCreation":0},"usageScope":"turn","time":1794737200000}`+"\n",
	)

	since := testNow.Add(-30 * 24 * time.Hour).Unix()
	rep, err := Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Kimi}})
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Failed) != 0 || rep.Files != 4 {
		t.Fatalf("files=%d failed=%v", rep.Files, rep.Failed)
	}
	rows := rowsBy(rep)

	// k3.1-pro in alpha-repo (main + agent-0): in 3000, cached 14000, cw 100 (priced at input=2), out 800.
	pro := rows["kimi|kimi-k3.1-pro|alpha-repo"]
	wantPro := (3000*2.0 + 14000*0.2 + 100*2.0 + 800*10.0) / 1e6
	if pro.Day != "2026-11-15" || pro.Requests != 2 || pro.Input != 3000 || pro.Cached != 14000 ||
		pro.CacheWrite != 100 || pro.Output != 800 || !pro.Priced || !near(pro.Cost, wantPro) {
		t.Errorf("k3.1-pro: %+v want cost %g", pro, wantPro)
	}

	// k3-256k compaction matches kimi-k3 (in 3, cached 0.3, out 15).
	k3 := rows["kimi|kimi-k3|alpha-repo"]
	wantK3 := (3000*3.0 + 5000*0.3 + 200*15.0) / 1e6
	if k3.Requests != 1 || !k3.Priced || !near(k3.Cost, wantK3) {
		t.Errorf("k3: %+v want cost %g", k3, wantK3)
	}

	// kimi-for-coding in beta-app (state.json v1 workDir): in 0.95, cached 0.19, out 4.
	kfc := rows["kimi|kimi-for-coding|beta-app"]
	wantKfc := (5000*0.95 + 20000*0.19 + 400*4.0) / 1e6
	if kfc.Day != "2026-11-14" || kfc.Requests != 1 || !kfc.Priced || !near(kfc.Cost, wantKfc) {
		t.Errorf("kimi-for-coding: %+v want cost %g", kfc, wantKfc)
	}

	// Unpriced custom model: tokens counted, reported in Unpriced.
	unp := rows["kimi|custom-preview|beta-app"]
	if unp.Requests != 1 || unp.Input != 1000 || unp.Output != 100 || unp.Priced || unp.Cost != 0 ||
		!slices.Equal(rep.Unpriced, []string{"kimi/custom-preview"}) {
		t.Errorf("unpriced: %+v list=%v", unp, rep.Unpriced)
	}

	// Fallback project name from wd_fallback-proj_deadbeefcafe (k3.1-pro-highspeed: in 4, cached 0.2, out 20).
	hs := rows["kimi|kimi-k3.1-pro-highspeed|fallback-proj"]
	wantHs := (1000*4.0 + 5000*0.2 + 250*20.0) / 1e6
	if hs.Requests != 1 || !hs.Priced || !near(hs.Cost, wantHs) {
		t.Errorf("highspeed: %+v want cost %g", hs, wantHs)
	}

	// Incremental append: incomplete line waits for newline, then counts on next scan.
	mainWire := filepath.Join(s1, "agents/main/wire.jsonl")
	appendLine := func(s string) {
		f, err := os.OpenFile(mainWire, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		f.WriteString(s)
		f.Close()
		later := time.Now().Add(time.Minute)
		os.Chtimes(mainWire, later, later)
	}
	partial := `{"type":"usage.record","agentId":"main","model":"kimi-code/k3.1-pro","usage":{"inputOther":500,"output":100,"inputCacheRead":0,"inputCacheCreation":0},"usageScope":"turn","time":1794737300000}`
	appendLine(partial)
	rep2, _ := Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Kimi}})
	if rowsBy(rep2)["kimi|kimi-k3.1-pro|alpha-repo"].Requests != 2 {
		t.Errorf("partial line counted early: %+v", rowsBy(rep2)["kimi|kimi-k3.1-pro|alpha-repo"])
	}
	appendLine("\n")
	rep3, _ := Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Kimi}})
	if got := rowsBy(rep3)["kimi|kimi-k3.1-pro|alpha-repo"]; got.Requests != 3 || got.Output != 900 {
		t.Errorf("appended line not read: %+v", got)
	}

	// KIMI_CODE_HOME override.
	customHome := filepath.Join(e.Home, "alt-kimi")
	e.Getenv = func(k string) string {
		if k == "KIMI_CODE_HOME" {
			return customHome
		}
		return ""
	}
	write(t, filepath.Join(customHome, "sessions/wd_alt_001122334455/session_x/agents/main/wire.jsonl"),
		`{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":100,"output":50,"inputCacheRead":0,"inputCacheCreation":0},"usageScope":"turn","time":1794737400000}`+"\n",
	)
	repAlt, err := Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Kimi}})
	if err != nil || len(repAlt.Rows) != 1 || repAlt.Rows[0].Project != "alt" || repAlt.Rows[0].Model != "kimi-k3" {
		t.Errorf("KIMI_CODE_HOME: %+v %v", repAlt, err)
	}
}
