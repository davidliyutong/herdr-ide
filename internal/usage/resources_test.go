package usage

// What a poll costs the machine: connections, runs of agy, reads of the
// Codex logs.

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The language server's client keeps no connection open after a poll.
func TestLocalClientClosesItsConnections(t *testing.T) {
	var open atomic.Int64
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"userStatus":{"email":"ag@example.com"}}`))
	}))
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		switch s {
		case http.StateNew:
			open.Add(1)
		case http.StateClosed, http.StateHijacked:
			open.Add(-1)
		}
	}
	srv.Start()
	defer srv.Close()
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	e := testEnv(t, nil)
	e.LocalClient = localClient
	for range 5 {
		if m := getUserStatus(context.Background(), e, port, "tok"); m == nil {
			t.Fatal("no answer")
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for open.Load() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("%d connections left open", open.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The process's Envs share one client, so polls reuse its connections.
func TestEnvsShareTheirClient(t *testing.T) {
	a, b := NewEnv("/h", "/b", nil), NewEnv("/h2", "/b2", nil)
	if a.Client != b.Client || a.Memo == nil || a.Memo != b.Memo {
		t.Error("each Env has a client or memo of its own")
	}
}

// agyEnv is an Env without a language server whose agy answers with out
// and err and counts its runs.
func agyEnv(t *testing.T, out string, err error) (*Env, *atomic.Int64) {
	e := testEnv(t, nil)
	e.Memo = &Memo{}
	var runs atomic.Int64
	e.LookPath = func(string) (string, error) { return "/opt/bin/agy", nil }
	e.Command = func(_ context.Context, _ []string, name string, _ ...string) ([]byte, error) {
		if filepath.Base(name) == "ps" {
			return nil, nil
		}
		runs.Add(1)
		return []byte(out), err
	}
	return e, &runs
}

const agyOut = `{"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"name":"Weekly","window":"weekly","remaining_fraction":0.5}]}]}}}`

// agy runs at most every AgyEvery; the polls in between get its answer.
func TestAgyRunsAtMostEvery(t *testing.T) {
	e, runs := agyEnv(t, agyOut, nil)
	now := testNow
	e.Now = func() time.Time { return now }
	ask := func() Account {
		return one(t, Limits(context.Background(), e, Options{Providers: []string{Antigravity}}))
	}
	if a := ask(); a.Status != StatusOK || a.Windows[0].UsedPct != 50 || a.AsOf != testNow.Unix() {
		t.Fatalf("first %+v", a)
	}
	now = now.Add(AgyEvery - time.Second)
	if a := ask(); a.Status != StatusOK || a.AsOf != testNow.Unix() || runs.Load() != 1 {
		t.Fatalf("within AgyEvery: %+v, %d runs", a, runs.Load())
	}
	now = now.Add(time.Second)
	if a := ask(); a.AsOf != now.Unix() || runs.Load() != 2 {
		t.Fatalf("after AgyEvery: %+v, %d runs", a, runs.Load())
	}
}

// A failed agy is not run again for AgyBackoff.
func TestAgyBacksOffAfterAFailure(t *testing.T) {
	e, runs := agyEnv(t, "", errors.New("signal: killed"))
	now := testNow
	e.Now = func() time.Time { return now }
	for range 3 {
		a := one(t, Limits(context.Background(), e, Options{Providers: []string{Antigravity}}))
		if a.Status != StatusError || a.Code != "agy_failed" {
			t.Fatalf("failure %+v", a)
		}
		now = now.Add(AgyEvery)
	}
	if runs.Load() != 1 {
		t.Fatalf("%d runs within the backoff", runs.Load())
	}
	now = testNow.Add(AgyBackoff)
	Limits(context.Background(), e, Options{Providers: []string{Antigravity}})
	if runs.Load() != 2 {
		t.Fatalf("not run after the backoff: %d runs", runs.Load())
	}
	// A run the caller cut short is not kept.
	e2, runs2 := agyEnv(t, "", context.Canceled)
	ctx, cancel := context.WithCancel(context.Background())
	e2.Command = func(context.Context, []string, string, ...string) ([]byte, error) {
		runs2.Add(1)
		cancel()
		return nil, context.Canceled
	}
	Limits(ctx, e2, Options{Providers: []string{Antigravity}})
	if _, ok := e2.Memo.lastAgy("/opt/bin/agy", testNow); ok {
		t.Error("a cancelled run was kept")
	}
}

// Antigravity honors the skip lists: by the email's hash once the language
// server answered, and an id-less account of the machine without running
// anything.
func TestAntigravitySkips(t *testing.T) {
	e, runs := agyEnv(t, agyOut, nil)
	var ps atomic.Int64
	cmd := e.Command
	e.Command = func(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
		if filepath.Base(name) == "ps" {
			ps.Add(1)
		}
		return cmd(ctx, env, name, args...)
	}
	a := one(t, Limits(context.Background(), e, Options{Providers: []string{Antigravity}, SkipLocal: []string{Antigravity}}))
	if a.Status != StatusSkipped || ps.Load() != 0 || runs.Load() != 0 {
		t.Fatalf("skipLocal %+v, ps %d, agy %d", a, ps.Load(), runs.Load())
	}

	ls := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"userStatus":{"email":"ag@example.com","cascadeModelConfigData":{"clientModelConfigs":[{"label":"M","quotaInfo":{"remainingFraction":0.5}}]}}}`))
	}))
	defer ls.Close()
	port := ls.Listener.Addr().(*net.TCPAddr).Port
	e.GOOS = "darwin"
	e.Command = func(_ context.Context, _ []string, name string, _ ...string) ([]byte, error) {
		switch filepath.Base(name) {
		case "ps":
			return []byte("  501   345 /x/language_server_macos_arm --csrf_token tok antigravity\n"), nil
		case "lsof":
			return []byte("n127.0.0.1:" + itoa(int64(port)) + "\n"), nil
		}
		return nil, errors.New("unexpected " + name)
	}
	e.LocalClient = localClient
	a = one(t, Limits(context.Background(), e, Options{Providers: []string{Antigravity}, Skip: []string{"antigravity:" + HashID("ag@example.com")}}))
	if a.Status != StatusSkipped || a.ID != HashID("ag@example.com") || len(a.Windows) != 0 {
		t.Fatalf("skip by id %+v", a)
	}
}

// eachLineBackward gives the lines of a file last first, across its reads'
// boundaries, without a line longer than maxLine.
func TestEachLineBackward(t *testing.T) {
	var lines []string
	var b bytes.Buffer
	for i := range 40 {
		n := (i * 37_000) % 600_000
		l := strings.Repeat(string(rune('a'+i%26)), n) + itoa(int64(i))
		lines = append(lines, l)
		b.WriteString(l + "\n")
	}
	b.WriteString("\n  \nlast-no-newline")
	lines = append(lines, "last-no-newline")
	var got []string
	eachLineBackward(bytes.NewReader(b.Bytes()), int64(b.Len()), func(l []byte) bool {
		got = append(got, string(l))
		return false
	})
	if len(got) != len(lines) {
		t.Fatalf("%d lines, want %d", len(got), len(lines))
	}
	for i := range lines {
		if got[len(got)-1-i] != lines[i] {
			t.Fatalf("line %d differs", i)
		}
	}
	// Stops where fn says; a line too long is left out.
	long := "first\n" + strings.Repeat("x", maxLine+10) + "\nlast\n"
	got = nil
	eachLineBackward(strings.NewReader(long), int64(len(long)), func(l []byte) bool {
		got = append(got, string(l))
		return string(l) == "nothing"
	})
	if strings.Join(got, ",") != "last,first" {
		t.Errorf("long line: %q", got)
	}
}

// The newest Codex log is read for its last rate limits once while it does
// not change.
func TestCodexLogReadOnce(t *testing.T) {
	e := testEnv(t, nil)
	e.Memo = &Memo{}
	home := filepath.Join(e.Home, ".codex")
	f := filepath.Join(home, "sessions/2026/11/15/rollout-a.jsonl")
	filler := `{"timestamp":"2026-11-15T10:00:02.000Z","type":"response_item","payload":{"text":"` + strings.Repeat("y", 300_000) + `"}}` + "\n"
	write(t, f, codexRollout+filler+filler)
	a := codexFromLog(e, home)
	if a == nil || len(a.Windows) != 2 || a.Windows[0].UsedPct != 20 {
		t.Fatalf("from log %+v", a)
	}
	// Unchanged: not opened again (it could not be).
	os.Chmod(f, 0)
	defer os.Chmod(f, 0o600)
	a.ID = "changed by the caller"
	if b := codexFromLog(e, home); b == nil || b.ID != "" || b.Windows[0].UsedPct != 20 {
		t.Fatalf("memo %+v", b)
	}
	// Changed: read again.
	os.Chmod(f, 0o600)
	fh, _ := os.OpenFile(f, os.O_APPEND|os.O_WRONLY, 0)
	fh.WriteString(strings.Replace(codexRollout[strings.Index(codexRollout, "\n")+1:], `"used_percent":20`, `"used_percent":30`, 1))
	fh.Close()
	later := time.Now().Add(time.Minute)
	os.Chtimes(f, later, later)
	if b := codexFromLog(e, home); b == nil || b.Windows[0].UsedPct != 30 {
		t.Fatalf("changed log %+v", b)
	}
}

// One Memo serves concurrent polls.
func TestMemoConcurrent(t *testing.T) {
	m := &Memo{}
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.keepAgy("agy", Account{Provider: Antigravity, Status: StatusOK, Windows: []Window{{UsedPct: float64(i)}}}, testNow)
			m.lastAgy("agy", testNow)
			m.keepCodexLog("h", "p", 1, testNow, &Account{Provider: Codex})
			m.codexLogOf("h", "p", 1, testNow)
		}()
	}
	wg.Wait()
}

// agy 1.5 names no account: its log does, so its account merges with the
// language server's (the email's hash) across machines.
func TestAgyAccountFromItsLog(t *testing.T) {
	e, _ := agyEnv(t, agyOut, nil)
	write(t, filepath.Join(e.Home, agyLog), "I1116 18:36:40.004176 1 server_oauth.go:221] applyAuthResult: email=old@example.com, authMethod=consumer\n"+
		"I1116 18:36:40.004185 1 server_oauth.go:226] OAuth: authenticated successfully as AG@Example.com\n")
	a := one(t, Limits(context.Background(), e, Options{Providers: []string{Antigravity}}))
	if a.Status != StatusOK || a.Email != "AG@Example.com" || a.ID != HashID("ag@example.com") {
		t.Fatalf("account %+v", a)
	}
	// The memo keeps the identity; skipped by it on another machine.
	b := one(t, Limits(context.Background(), e, Options{Providers: []string{Antigravity}, Skip: []string{"antigravity:" + HashID("ag@example.com")}}))
	if b.Status != StatusSkipped || b.ID != a.ID {
		t.Errorf("skip by the log's identity %+v", b)
	}
	// No log: no id.
	e2, _ := agyEnv(t, agyOut, nil)
	if a := one(t, Limits(context.Background(), e2, Options{Providers: []string{Antigravity}})); a.ID != "" {
		t.Errorf("id without a log %+v", a)
	}
}
