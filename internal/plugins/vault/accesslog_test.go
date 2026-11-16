package vault

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	vaultstore "herdr-ide/internal/vault"
)

// reopened is a plugin of the same vault as p, as after a restart of the
// core: the access log is read from its file.
func reopened(t *testing.T, p *Plugin) *Plugin {
	t.Helper()
	if p.alog != nil {
		p.alog.close()
	}
	return &Plugin{Path: p.Path, Timeout: p.Timeout}
}

// The access log is kept beside the vault's file (0600) and read back by
// a core that starts again: releases, refusals with their count and the
// values pages took are all there, with who asked.
func TestAccessLogSurvivesARestart(t *testing.T) {
	p, h, s := newTest(t)
	s.Set("KEY", vaultstore.Update{Value: str("s3cret"), Machines: &[]string{"m1"}})
	ctx := context.Background()
	chain := []agentproto.VaultProcess{{Pid: 4242, Name: "vault-mcp"}, {Pid: 4200, Name: "claude"}}
	if r := p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}, Client: "claude", Terminal: "t1", Cwd: "/work", Process: chain}); !r.OK {
		t.Fatalf("get %+v", r)
	}
	for i := 0; i < 3; i++ {
		p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"NOPE"}})
	}
	c := newClient(p, h)
	c.session(t)
	if code, _ := c.do("POST", "/api/p/vault/vars/KEY/reveal", ""); code != 200 {
		t.Fatalf("reveal %d", code)
	}
	path := accessLogPath(p.Path)
	if st, err := os.Stat(path); err != nil || (runtime.GOOS != "windows" && st.Mode().Perm() != 0o600) {
		t.Fatalf("access log %v %v", st, err)
	}
	b, _ := os.ReadFile(path)
	if strings.Contains(string(b), "s3cret") {
		t.Fatal("a value in the access log")
	}

	p2 := reopened(t, p)
	c2 := newClient(p2, h)
	_, out := c2.do("GET", "/api/p/vault/log", "")
	var log []Access
	json.Unmarshal([]byte(mustJSON(out["log"])), &log)
	if len(log) != 3 {
		t.Fatalf("log after a restart %+v", log)
	}
	if a := log[0]; a.Tool != "reveal" || a.Result != ResultRevealed || a.M != "" || a.Names[0] != "KEY" || a.Remote == "" {
		t.Errorf("reveal %+v", a)
	}
	if a := log[1]; a.Result != "not_found" || a.Count != 3 {
		t.Errorf("refusals %+v", a)
	}
	if a := log[2]; a.Result != ResultAllowed || a.M != "m1" || a.Client != "claude" || a.Terminal != "t1" || a.Cwd != "/work" ||
		len(a.Process) != 2 || a.Process[1] != chain[1] {
		t.Errorf("release %+v", a)
	}
	// New records follow the old ones.
	p2.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "list"})
	if l := p2.Log(); len(l) != 4 || l[0].Result != ResultListed || l[0].ID <= l[1].ID {
		t.Errorf("after the restart %+v", l)
	}
}

// Every release is a record of its own, in the access log and in the audit
// log, whatever refusals of the same call come between or around it, and
// no number of refusals pushes a release out of the log.
func TestReleasesAreNeverCoalesced(t *testing.T) {
	for _, r := range []string{ResultAllowed, ResultApproved, ResultApprovedAlways, ResultRevealed, ResultExported} {
		if noisy(r) || !released(r) {
			t.Errorf("%s is coalesced or not a release", r)
		}
	}
	p, h, s := newTest(t)
	p.noisyEvery = time.Hour
	s.Set("KEY", vaultstore.Update{Value: str("v"), Machines: &[]string{"m1"}})
	ctx := context.Background()
	get := agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}, Client: "claude"}
	s.Lock()
	p.Handle(ctx, h, "m1", get) // vault_locked
	s.Unlock(pass)
	for i := 0; i < 5; i++ {
		if r := p.Handle(ctx, h, "m1", get); !r.OK {
			t.Fatal(r)
		}
		s.Lock()
		p.Handle(ctx, h, "m1", get)
		p.Handle(ctx, h, "m1", get)
		s.Unlock(pass)
	}
	allowed := 0
	for _, a := range p.Log() {
		if a.Result == ResultAllowed {
			allowed++
			if a.Count > 1 {
				t.Errorf("a release coalesced %+v", a)
			}
		}
	}
	if records, calls := accounted(h, ResultAllowed); allowed != 5 || records != 5 || calls != 5 {
		t.Errorf("releases: %d in the log, %d audited (%d calls)", allowed, records, calls)
	}
	// Refusals that differ from each other, more than the log keeps of
	// them, push out refusals only.
	p.alog.maxOthers = 20
	for i := 0; i < 50; i++ {
		p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{fmt.Sprintf("NOPE_%d", i)}})
	}
	allowed, others := 0, 0
	for _, a := range p.Log() {
		if released(a.Result) {
			allowed++
		} else {
			others++
		}
	}
	if allowed != 5 || others != 20 {
		t.Errorf("after a flood of refusals: %d releases, %d others", allowed, others)
	}
}

// A release whose record cannot be written does not happen: the MCP
// server gets log_failed without values, a reveal answers 500.
func TestUnloggedReleaseIsRefused(t *testing.T) {
	p, h, s := newTest(t)
	s.Set("KEY", vaultstore.Update{Value: str("s3cret"), Machines: &[]string{"m1"}})
	c := newClient(p, h)
	c.session(t)
	// The log's file cannot be created: a directory takes its name.
	if err := os.Mkdir(accessLogPath(p.Path), 0o700); err != nil {
		t.Fatal(err)
	}
	r := p.Handle(context.Background(), h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}})
	if r.OK || r.Code != ResultLogFailed || r.Values != nil {
		t.Errorf("get %+v", r)
	}
	if code, out := c.do("POST", "/api/p/vault/vars/KEY/reveal", ""); code != 500 || out["error"] != ResultLogFailed || out["value"] != nil {
		t.Errorf("reveal %d %v", code, out)
	}
	if l := p.Log(); len(l) != 2 || l[0].Result != ResultLogFailed || l[1].Result != ResultLogFailed {
		t.Errorf("log %+v", l)
	}
	if !strings.Contains(h.auditLog(), `"result":"log_failed"`) || strings.Contains(h.auditLog(), "s3cret") {
		t.Errorf("audit %s", h.auditLog())
	}
	// Refusals are still answered (their record kept in memory).
	if r := p.Handle(context.Background(), h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"NOPE"}}); r.Code != "not_found" {
		t.Errorf("refusal %+v", r)
	}
}

// The file is written again with the records kept once it holds twice as
// many lines, and reads back the same.
func TestAccessLogIsCompacted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault-access.jsonl")
	l := newAccessLog(path, log.New(os.Stderr, "", 0))
	l.maxReleases, l.maxOthers = 5, 5
	for i := 0; i < 40; i++ {
		result := ResultAllowed
		if i%2 == 1 {
			result = "not_found"
		}
		if _, err := l.add(Access{Time: time.Now(), M: "m1", Tool: "get", Names: []string{fmt.Sprint("N", i)}, Result: result}, noisy(result), released(result)); err != nil {
			t.Fatal(err)
		}
	}
	want := l.list()
	l.close()
	f, _ := os.Open(path)
	lines := 0
	for sc := bufio.NewScanner(f); sc.Scan(); {
		lines++
	}
	f.Close()
	if len(want) != 10 || lines > 20 {
		t.Fatalf("%d records, %d lines", len(want), lines)
	}
	l2 := newAccessLog(path, nil)
	l2.maxReleases, l2.maxOthers = 5, 5
	if got := l2.list(); mustJSON(got) != mustJSON(want) {
		t.Errorf("read back\n%s\nwant\n%s", mustJSON(got), mustJSON(want))
	}
}

// A write that fails partway is cut back, so the next release is read
// back after a restart; a half line a crash left is ended before the next
// record is appended.
func TestAccessLogAfterAFailedWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault-access.jsonl")
	release := func(l *accessLog, name string) (Access, error) {
		return l.add(Access{Time: time.Now(), M: "m1", Tool: "get", Names: []string{name}, Result: ResultAllowed}, false, true)
	}
	names := func(l *accessLog) string {
		var out []string
		for _, a := range l.list() {
			out = append(out, a.Names[0]+":"+a.Result)
		}
		return strings.Join(out, ",")
	}
	l := newAccessLog(path, nil)
	if _, err := release(l, "A"); err != nil {
		t.Fatal(err)
	}
	orig := writeLog
	defer func() { writeLog = orig }()
	writeLog = func(f *os.File, b []byte) (int, error) {
		n, _ := f.Write(b[:len(b)/2])
		return n, errors.New("no space left")
	}
	if a, err := release(l, "B"); err == nil || a.Result != ResultLogFailed {
		t.Fatalf("a failed write: %+v %v", a, err)
	}
	writeLog = orig
	if _, err := release(l, "C"); err != nil {
		t.Fatal(err)
	}
	l.close()
	if got := names(newAccessLog(path, nil)); got != "C:allowed,A:allowed" {
		t.Errorf("read back %s", got)
	}

	// A crash in the middle of a line.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString(`{"id":77,"time":"2026-01-0`)
	f.Close()
	l = newAccessLog(path, nil)
	if _, err := release(l, "D"); err != nil {
		t.Fatal(err)
	}
	l.close()
	if got := names(newAccessLog(path, nil)); got != "D:allowed,C:allowed,A:allowed" {
		t.Errorf("read back after a half line %s", got)
	}
}

// A refusal repeated is written again with its count once the while is
// over, so the count survives a restart too.
func TestCoalescedCountIsWritten(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault-access.jsonl")
	l := newAccessLog(path, nil)
	l.flushEvery = 20 * time.Millisecond
	rec := Access{Time: time.Now(), M: "m1", Tool: "get", Names: []string{"NOPE"}, Result: "not_found"}
	for i := 0; i < 4; i++ {
		l.add(rec, true, false)
	}
	time.Sleep(200 * time.Millisecond)
	l.close()
	if got := newAccessLog(path, nil).list(); len(got) != 1 || got[0].Count != 4 {
		t.Errorf("read back %+v", got)
	}
}

// What the agent saw of the process that asked comes from the stream's
// header, never from the request line, and is recorded and shown with
// the prompt.
func TestWhoAskedComesFromTheAgent(t *testing.T) {
	p, h, s := newTest(t)
	p.Timeout = 5 * time.Second
	s.Set("KEY", vaultstore.Update{Value: str("v")})
	mg := machines.NewManager([]machines.Spec{{ID: "m1", Label: "box", Kind: machines.KindSSH, Target: "box"}}, nil, log.New(os.Stderr, "", 0))
	chain := []agentproto.VaultProcess{{Pid: 7, Name: "mcp"}, {Pid: 6, Name: "codex"}}
	a, b := net.Pipe()
	go p.ServeAgent(h, mg.Get("m1"), b, agentproto.Header{Op: agentproto.OpVault, Process: chain})
	var rep agentproto.Reply
	if err := agentproto.ReadLine(a, &rep); err != nil || !rep.OK {
		t.Fatal(rep, err)
	}
	// A request line that claims a process of its own.
	a.Write([]byte(`{"tool":"env","names":["KEY"],"client":"claude","cwd":"/w","process":[{"pid":1,"name":"trusted"}]}` + "\n"))
	req := (<-h.sent)["request"].(*Request)
	if len(req.Process) != 2 || req.Process[1].Name != "codex" || req.Cwd != "/w" {
		t.Errorf("request %+v", req)
	}
	if req2 := p.answerRequest(req.ID, AnswerDeny); req2 == nil {
		t.Fatal("not answered")
	}
	var resp agentproto.VaultResponse
	agentproto.ReadLine(a, &resp)
	a.Close()
	if resp.Code != "denied" {
		t.Errorf("response %+v", resp)
	}
	l := p.Log()
	if len(l) != 1 || l[0].Result != ResultDenied || len(l[0].Process) != 2 || l[0].Process[0].Pid != 7 || l[0].Cwd != "/w" {
		t.Errorf("log %+v", l)
	}
	if audit := h.auditLog(); !strings.Contains(audit, `"process":[{"pid":7,"name":"mcp"},{"pid":6,"name":"codex"}]`) || strings.Contains(audit, "trusted") {
		t.Errorf("audit %s", audit)
	}
}

// A requester that goes away before an answer is recorded as cancelled
// (coalesced like refusals), nobody answering as expired.
func TestCancelledAndExpired(t *testing.T) {
	p, h, s := newTest(t)
	s.Set("KEY", vaultstore.Update{Value: str("v")})
	p.Timeout = 50 * time.Millisecond
	if r := p.Handle(context.Background(), h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}}); r.Code != "denied" {
		t.Fatalf("expired %+v", r)
	}
	<-h.sent
	p.Timeout = 5 * time.Second
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan agentproto.VaultResponse)
	go func() { done <- p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}}) }()
	<-h.sent
	cancel()
	if r := <-done; r.Code != "denied" {
		t.Fatalf("cancelled %+v", r)
	}
	if l := p.Log(); len(l) != 2 || l[0].Result != ResultCancelled || l[1].Result != ResultExpired {
		t.Errorf("log %+v", l)
	}
	if !noisy(ResultCancelled) || noisy(ResultExpired) {
		t.Error("cancelled requests are repeated at will, expired ones are not")
	}
}
