package vault

import (
	"context"
	"database/sql"
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

	"veldr/internal/agentproto"
	"veldr/internal/machines"
	"veldr/internal/plugin"
	"veldr/internal/store"
	vaultstore "veldr/internal/vault"
)

// reopened is a plugin of the same vault as p, as after a restart of the
// core: the access log is read from its file.
func reopened(t *testing.T, p *Plugin) *Plugin {
	t.Helper()
	if p.alog != nil {
		p.alog.close()
	}
	p2 := &Plugin{Path: p.Path, Timeout: p.Timeout}
	closeOnCleanup(t, p2)
	return p2
}

// The access log is kept in the core's database beside the vault's file
// (0600) and read back by a core that starts again: releases, refusals
// with their count and the values pages took are all there, with who
// asked.
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
	path := coreDBOf(accessLogPath(p.Path))
	if path != plugin.CoreDBFile(filepath.Join(filepath.Dir(p.Path), "settings.json")) {
		t.Fatalf("database %s", path)
	}
	if st, err := os.Stat(path); err != nil || (runtime.GOOS != "windows" && st.Mode().Perm() != 0o600) {
		t.Fatalf("access log %v %v", st, err)
	}
	for _, f := range []string{path, path + "-wal"} {
		b, _ := os.ReadFile(f)
		if strings.Contains(string(b), "s3cret") {
			t.Fatal("a value in the access log")
		}
	}

	p2 := reopened(t, p)
	c2 := newClient(p2, h)
	c2.session(t)
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
	s.Unlock(pass, testWindow)
	for i := 0; i < 5; i++ {
		if r := p.Handle(ctx, h, "m1", get); !r.OK {
			t.Fatal(r)
		}
		s.Lock()
		p.Handle(ctx, h, "m1", get)
		p.Handle(ctx, h, "m1", get)
		s.Unlock(pass, testWindow)
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
	// The core's database cannot be opened: a directory takes its name.
	if err := os.Mkdir(coreDBOf(accessLogPath(p.Path)), 0o700); err != nil {
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

// The database keeps the newest records of each class within the bounds,
// and reads back the same.
func TestAccessLogBounds(t *testing.T) {
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
	if len(want) != 10 || want[0].Names[0] != "N39" || want[9].Names[0] != "N30" {
		t.Fatalf("%d records: %s", len(want), mustJSON(want))
	}
	if rel, oth := accessRows(t, path); rel != 5 || oth != 5 {
		t.Fatalf("rows: %d releases, %d others", rel, oth)
	}
	l2 := newAccessLog(path, nil)
	l2.maxReleases, l2.maxOthers = 5, 5
	if got := l2.list(); mustJSON(got) != mustJSON(want) {
		t.Errorf("read back\n%s\nwant\n%s", mustJSON(got), mustJSON(want))
	}
}

// accessRows counts the access log's rows in the core's database beside
// path, by class.
func accessRows(t *testing.T, path string) (releases, others int) {
	t.Helper()
	db, err := store.OpenShared(coreDBOf(path))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.QueryRow("SELECT count(*) FROM vault_access WHERE released").Scan(&releases)
	db.QueryRow("SELECT count(*) FROM vault_access WHERE NOT released").Scan(&others)
	return releases, others
}

// A write that fails refuses its release and leaves nothing behind; the
// next release is written and read back after a restart.
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
	orig := writeRecord
	defer func() { writeRecord = orig }()
	writeRecord = func(tx *sql.Tx, id uint64, rel bool, record []byte, keep int) error {
		orig(tx, id, rel, record, keep) // written, then rolled back
		return errors.New("disk I/O error")
	}
	if a, err := release(l, "B"); err == nil || a.Result != ResultLogFailed {
		t.Fatalf("a failed write: %+v %v", a, err)
	}
	writeRecord = orig
	if _, err := release(l, "C"); err != nil {
		t.Fatal(err)
	}
	if got := names(l); got != "C:allowed,B:log_failed,A:allowed" {
		t.Errorf("in memory %s", got)
	}
	l.close()
	if got := names(newAccessLog(path, nil)); got != "C:allowed,A:allowed" {
		t.Errorf("read back %s", got)
	}
}

// The file the log was kept in before, as that core wrote it (a record
// written again with its count, a half line a crash left, lines that do not
// parse), is imported once and removed; a core that starts again does not
// import anything again. New records follow the imported ones.
func TestAccessLogImport(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault-dev-access.jsonl")
	at := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	line := func(a Access) string { b, _ := json.Marshal(a); return string(b) + "\n" }
	legacy := line(Access{ID: 1, Time: at, M: "m1", Tool: "get", Names: []string{"KEY"}, Client: "claude", Result: ResultAllowed}) +
		line(Access{ID: 2, Time: at, M: "m1", Tool: "get", Names: []string{"NOPE"}, Result: "not_found"}) +
		"not json\n" +
		line(Access{ID: 2, Time: at.Add(time.Minute), M: "m1", Tool: "get", Names: []string{"NOPE"}, Result: "not_found", Count: 3}) +
		line(Access{Time: at, Tool: "get", Result: ResultAllowed}) + // no ID
		line(Access{ID: 5, Time: at, Tool: "reveal", Names: []string{"KEY"}, Remote: "127.0.0.1:1", Result: ResultRevealed}) +
		`{"id":6,"time":"2026-11-0`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	l := newAccessLog(path, nil)
	got := l.list()
	if len(got) != 3 || got[0].ID != 5 || got[1].ID != 2 || got[1].Count != 3 || got[2].Client != "claude" {
		t.Fatalf("imported %s", mustJSON(got))
	}
	if _, err := os.Lstat(path); err == nil {
		t.Fatal("the file stayed")
	}
	if a, err := l.add(Access{Time: time.Now(), Tool: "get", Names: []string{"X"}, Result: ResultAllowed}, false, true); err != nil || a.ID != 6 {
		t.Fatalf("after the import %+v %v", a, err)
	}
	l.close()
	// A file left again is not imported again: the import ran.
	os.WriteFile(path, []byte(legacy), 0o600)
	if got := newAccessLog(path, nil).list(); len(got) != 4 || got[0].ID != 6 {
		t.Errorf("after a second start %s", mustJSON(got))
	}
	if _, err := os.Lstat(path); err == nil {
		t.Error("the file left again stayed")
	}

	// An import that fails leaves the file for the next start.
	dir2 := t.TempDir()
	bad := filepath.Join(dir2, "vault-access.jsonl")
	os.Mkdir(bad, 0o700) // not a file: it cannot be read
	if got := newAccessLog(bad, nil).list(); len(got) != 0 {
		t.Errorf("imported %s", mustJSON(got))
	}
	if _, err := os.Lstat(bad); err != nil {
		t.Error("a failed import removed what it imports")
	}
	db, err := store.OpenShared(coreDBOf(bad))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if done, _ := db.Imported(accessFeature, "access-log"); done {
		t.Error("a failed import recorded")
	}
}

// Tables of a newer version are read, not written: releases are refused
// (log_failed), refusals are kept in memory.
func TestAccessLogNewerVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault-access.jsonl")
	l := newAccessLog(path, nil)
	if _, err := l.add(Access{Time: time.Now(), Tool: "get", Names: []string{"A"}, Result: ResultAllowed}, false, true); err != nil {
		t.Fatal(err)
	}
	l.close()
	db, err := store.OpenShared(coreDBOf(path))
	if err != nil {
		t.Fatal(err)
	}
	db.Exec("UPDATE store_features SET version = version + 1 WHERE feature = ?", accessFeature)
	db.Close()

	l = newAccessLog(path, nil)
	if got := l.list(); len(got) != 1 || got[0].Names[0] != "A" {
		t.Fatalf("read %s", mustJSON(got))
	}
	if a, err := l.add(Access{Time: time.Now(), Tool: "get", Names: []string{"B"}, Result: ResultAllowed}, false, true); !errors.Is(err, errNewer) || a.Result != ResultLogFailed {
		t.Errorf("release %+v %v", a, err)
	}
	if a, err := l.add(Access{Time: time.Now(), Tool: "get", Names: []string{"C"}, Result: "not_found"}, true, false); err != nil || a.Result != "not_found" {
		t.Errorf("refusal %+v %v", a, err)
	}
	if rel, oth := accessRows(t, path); rel != 1 || oth != 0 {
		t.Errorf("written: %d %d", rel, oth)
	}
}

// The core's database the access log uses is the one beside the settings
// file the vault's file is beside.
func TestAccessLogDatabase(t *testing.T) {
	dir := t.TempDir()
	for _, inst := range []string{"", "-dev"} {
		vault := filepath.Join(dir, "vault"+inst+".json")
		if got, want := coreDBOf(accessLogPath(vault)), plugin.CoreDBFile(filepath.Join(dir, "settings"+inst+".json")); got != want || !strings.HasPrefix(filepath.Base(got), "core"+inst+"-") {
			t.Errorf("%s: %s, want %s", inst, got, want)
		}
	}
	if coreDBOf("") != "" {
		t.Error("a database without a file")
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

// The access log tells what was read, by whom and which apps are exempt:
// it needs an open session, and reading it does not keep one open.
func TestAccessLogNeedsASession(t *testing.T) {
	p := &Plugin{Path: filepath.Join(t.TempDir(), "vault-dev.json")}
	closeOnCleanup(t, p)
	h := &fakeHost{}
	s, _ := p.open(h)
	s.KDF = testKDF
	now := time.Unix(1_000_000, 0)
	p.now = func() time.Time { return now }
	c := newClient(p, h)
	if code, out := c.do("GET", "/api/p/vault/log", ""); code != 401 || out["error"] != "vault_session" {
		t.Fatalf("without a session %d %v", code, out)
	}
	if !strings.Contains(h.auditLog(), "denied.vault_session") {
		t.Error("the refusal is not audited")
	}
	code, out := c.do("POST", "/api/p/vault/passphrase", `{"passphrase":"long enough"}`)
	if code != 200 {
		t.Fatalf("setup %d %v", code, out)
	}
	c.tok = out["session"].(string)
	if code, out := c.do("GET", "/api/p/vault/log", ""); code != 200 || out["log"] == nil {
		t.Fatalf("with a session %d %v", code, out)
	}
	for i := 0; i < 3; i++ {
		now = now.Add(SessionIdle / 2)
		code, _ := c.do("GET", "/api/p/vault/log", "")
		if i < 1 && code != 200 {
			t.Errorf("read %d: %d", i, code)
		}
	}
	if code, _ := c.do("GET", "/api/p/vault/log", ""); code != 401 {
		t.Errorf("session kept by reading the log: %d", code)
	}
	// A locked vault ends every session, and the log with it.
	c.session2(t, "long enough")
	c.do("POST", "/api/p/vault/lock", "")
	if code, _ := c.do("GET", "/api/p/vault/log", ""); code != 401 {
		t.Errorf("locked %d", code)
	}
}

// A read of the log that fails leaves it unread: a record added meanwhile
// gets its ID after every row's (it replaces none, and the bounds do not
// drop it), one whose write fails too is kept in memory, and the next use
// reads the log with both.
func TestAccessLogAfterAFailedRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault-access.jsonl")
	release := func(l *accessLog, name string) (Access, error) {
		return l.add(Access{Time: time.Now(), M: "m1", Tool: "get", Names: []string{name}, Result: ResultAllowed}, false, true)
	}
	l := newAccessLog(path, nil)
	l.maxReleases = 3
	for _, n := range []string{"A", "B", "C"} {
		if _, err := release(l, n); err != nil {
			t.Fatal(err)
		}
	}
	l.close()
	origRead, origWrite := readRecords, writeRecord
	defer func() { readRecords, writeRecord = origRead, origWrite }()
	readRecords = func(*store.DB) ([]Access, error) { return nil, errors.New("database is locked") }
	l = newAccessLog(path, nil)
	l.maxReleases = 3
	a, err := release(l, "D")
	if err != nil || a.ID != 4 {
		t.Fatalf("added while unread: %+v %v", a, err)
	}
	writeRecord = func(*sql.Tx, uint64, bool, []byte, int) error { return errors.New("disk I/O error") }
	if a, err := release(l, "E"); err == nil || a.Result != ResultLogFailed {
		t.Fatalf("a failed write: %+v %v", a, err)
	}
	readRecords, writeRecord = origRead, origWrite
	var got []string
	for _, a := range l.list() {
		got = append(got, fmt.Sprintf("%d:%s:%s", a.ID, a.Names[0], a.Result))
	}
	if want := "5:E:log_failed,4:D:allowed,3:C:allowed,2:B:allowed"; strings.Join(got, ",") != want {
		t.Errorf("read with what was added: %s, want %s", strings.Join(got, ","), want)
	}
	if a, err := release(l, "F"); err != nil || a.ID != 6 {
		t.Errorf("next %+v %v", a, err)
	}
	l.close()
	got = nil
	for _, a := range newAccessLog(path, nil).list() {
		got = append(got, a.Names[0])
	}
	if want := "F,D,C"; strings.Join(got, ",") != want {
		t.Errorf("read back %s, want %s", strings.Join(got, ","), want)
	}
}

// The file the log was kept in before, there again after the import ran
// (a core of an earlier version wrote it since: a downgrade, then the
// upgrade again), is merged, not removed unread: its records the table
// lacks follow the table's, with new IDs, in the order of their times;
// those it has already are not added again.
func TestAccessLogImportAfterDowngrade(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault-access.jsonl")
	at := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	line := func(a Access) string { b, _ := json.Marshal(a); return string(b) + "\n" }
	first := line(Access{ID: 1, Time: at, M: "m1", Tool: "get", Names: []string{"OLD1"}, Result: ResultAllowed}) +
		line(Access{ID: 2, Time: at.Add(time.Minute), M: "m1", Tool: "get", Names: []string{"OLD2"}, Result: "not_found"})
	if err := os.WriteFile(path, []byte(first), 0o600); err != nil {
		t.Fatal(err)
	}
	l := newAccessLog(path, nil)
	if got := l.list(); len(got) != 2 {
		t.Fatalf("imported %s", mustJSON(got))
	}
	if a, err := l.add(Access{Time: at.Add(time.Hour), M: "m1", Tool: "get", Names: []string{"NEW"}, Result: ResultAllowed}, false, true); err != nil || a.ID != 3 {
		t.Fatalf("added %+v %v", a, err)
	}
	l.close()
	// The earlier core wrote the file again: the records imported (a file
	// whose removal failed, which it read) and its own after them, whose
	// IDs follow theirs and take the table's (their times out of order
	// here).
	again := first +
		line(Access{ID: 3, Time: at.Add(3 * time.Hour), M: "m2", Tool: "get", Names: []string{"DOWN2"}, Result: ResultApproved}) +
		line(Access{ID: 4, Time: at.Add(2 * time.Hour), M: "m2", Tool: "list", Result: ResultListed})
	if err := os.WriteFile(path, []byte(again), 0o600); err != nil {
		t.Fatal(err)
	}
	got := newAccessLog(path, nil).list()
	var names []string
	for _, a := range got {
		n := a.Tool
		if len(a.Names) > 0 {
			n = a.Names[0]
		}
		names = append(names, fmt.Sprintf("%d:%s", a.ID, n))
	}
	if want := "5:DOWN2,4:list,3:NEW,2:OLD2,1:OLD1"; strings.Join(names, ",") != want {
		t.Fatalf("merged %s, want %s", strings.Join(names, ","), want)
	}
	if _, err := os.Lstat(path); err == nil {
		t.Error("the file stayed")
	}
	if rel, oth := accessRows(t, path); rel != 3 || oth != 2 {
		t.Errorf("rows: %d releases, %d others", rel, oth)
	}
}
