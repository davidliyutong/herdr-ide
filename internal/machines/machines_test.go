package machines

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"veldr/internal/transport"
)

// Records are written at once and read back; a broken file, or one of
// another kind, is reported and left alone (the registry then keeps
// changes in memory); without a file there are no machines and none is
// written.
func TestRegistryRoundTripAndErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machines.json")
	r, err := OpenRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Put(Spec{ID: "x1", Label: "box", Target: "u@box", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := r.Put(Spec{ID: "y2", Target: "y"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Put(Spec{ID: "x1", Label: "box 2", Target: "u@box", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if err := r.Put(Spec{ID: "", Target: "z"}); err == nil {
		t.Fatal("stored a record without an id")
	}
	if err := r.Delete("y2"); err != nil {
		t.Fatal(err)
	}
	r, err = OpenRegistry(path)
	if err != nil || len(r.Specs()) != 1 || r.Specs()[0] != (Spec{ID: "x1", Label: "box 2", Kind: KindSSH, Target: "u@box"}) {
		t.Fatalf("read back %+v %v", r.Specs(), err)
	}

	os.WriteFile(path, []byte("{"), 0o600)
	r, err = OpenRegistry(path)
	if err == nil {
		t.Fatal("a broken file was accepted")
	}
	r.Put(Spec{ID: "z", Target: "z"})
	if b, _ := os.ReadFile(path); string(b) != "{" {
		t.Fatalf("the broken file was replaced: %s", b)
	}

	os.WriteFile(path, []byte(`{"enabled":{"a1":false}}`), 0o600)
	if _, err := OpenRegistry(path); err == nil {
		t.Fatal("a file without machines was accepted")
	}
	none := filepath.Join(t.TempDir(), "machines.json")
	if r, err := OpenRegistry(none); err != nil || len(r.Specs()) != 0 {
		t.Fatalf("no file: %+v %v", r.Specs(), err)
	}
	if _, err := os.Stat(none); err == nil {
		t.Fatal("wrote a file for no machines")
	}
}

// The local machine comes first, then the stored SSH machines and the --ssh
// targets, each once. A stored machine whose target is refused stays (it
// shows an error); an --ssh one does not (the core refuses to start with
// it).
func TestLoadSpecs(t *testing.T) {
	stored := []Spec{{ID: "a1", Label: "gpu", Kind: KindSSH, Target: "gpu-host", Enabled: true}, {ID: LocalID, Kind: KindLocal, Enabled: true},
		{ID: "evil", Kind: KindSSH, Target: "-oProxyCommand=touch /tmp/x", Enabled: true}}
	specs := LoadSpecs(stored, []Spec{{Target: "extra"}, {ID: "a1", Target: "dup"}, {Target: "-oProxyCommand=sh"}, {Target: "host;id"}})
	if len(specs) != 4 || specs[0].ID != LocalID || !specs[0].Enabled || specs[1].ID != "a1" || specs[2].ID != "evil" {
		t.Fatalf("specs = %+v", specs)
	}
	if s := specs[3]; s.ID != "extra" || s.Kind != KindSSH || s.Label != "extra" {
		t.Fatalf("extra = %+v", s)
	}
}

// Targets are the destinations OpenSSH takes, never one that reads as an
// option or holds whitespace, a control character or a shell
// metacharacter: the vectors every client runs
// (design/testdata/machines/targets.json).
func TestValidTarget(t *testing.T) {
	b, err := os.ReadFile("../../design/testdata/machines/targets.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct{ Accept, Reject []string }
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Accept) < 20 || len(v.Reject) < 30 {
		t.Fatalf("%d and %d vectors", len(v.Accept), len(v.Reject))
	}
	for _, ok := range append(v.Accept, "user+tag@host", "me@[fe80::1%en0]:2222", "ssh://u@h:22", "~alias", "日本") {
		if !ValidTarget(ok) {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range append(v.Reject, "-oProxyCommand=x", "a b", "h`id`", "$(x)", "h\xff", "h\xc3") {
		if ValidTarget(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}

// A stored record whose target is refused is kept: it is stored, written
// back with the file's other entries and the fields this version does not
// know, and listed; new records with such a target are refused.
func TestRegistryKeepsInvalidTargets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machines.json")
	os.WriteFile(path, []byte(`{"version":1,"machines":[
		{"id":"a1","label":"gpu","kind":"ssh","target":"gpu-host","enabled":true},
		{"id":"p1","label":"proxy","kind":"ssh","target":"-oProxyCommand=touch /tmp/pwned","enabled":true},
		{"id":"s1","label":"","kind":"ssh","target":"host;id","enabled":true}]}`), 0o600)
	r, err := OpenRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	got := r.Specs()
	if len(got) != 3 || got[1].ID != "p1" || got[1].Target != "-oProxyCommand=touch /tmp/pwned" || got[2].Label != "s1" {
		t.Fatalf("read %+v", got)
	}
	if err := r.Put(got[0]); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); !strings.Contains(string(b), "ProxyCommand") || !strings.Contains(string(b), "host;id") {
		t.Fatalf("stored %s", b)
	}
	// New records and changed targets must be valid; a stored record keeps
	// its own target through a rename.
	if err := r.Put(Spec{ID: "p2", Target: "-oProxyCommand=x"}); !errors.Is(err, ErrInvalidTarget) {
		t.Fatalf("put: %v", err)
	}
	if err := r.Put(Spec{ID: "a1", Label: "gpu", Target: "a;b", Enabled: true}); !errors.Is(err, ErrInvalidTarget) {
		t.Fatalf("put a changed target: %v", err)
	}
	if err := r.Put(Spec{ID: "p1", Label: "renamed", Kind: KindSSH, Target: "-oProxyCommand=touch /tmp/pwned"}); err != nil {
		t.Fatalf("rename: %v", err)
	}

	// The file's own entries: what this version cannot use is kept as
	// written, unknown fields too, across a read and a write.
	os.WriteFile(path, []byte(`{"version":1,"note":{"by":"hand"},"machines":[
		{"id":"a1","kind":"ssh","target":"gpu-host","enabled":true,"jump":"bastion"},
		{"id":"p1","kind":"ssh","target":"-oProxyCommand=touch /tmp/pwned","enabled":true},
		{"id":"n1","label":"no target","kind":"ssh","enabled":true},
		{"label":"no id","target":"x"},
		{"id":"a1","target":"duplicate"},
		{"id":"d1","kind":"docker","target":"c1"},
		"not a record",
		{"id":"local","kind":"local","enabled":false,"pinned":true}]}`), 0o600)
	r, err = OpenRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, s := range r.Specs() {
		ids = append(ids, s.ID+":"+s.Label)
	}
	if strings.Join(ids, " ") != "a1:gpu-host p1:p1 n1:no target local:" || r.Kept() != 4 {
		t.Fatalf("read %v, kept %d", ids, r.Kept())
	}
	if err := r.Put(Spec{ID: "a1", Label: "GPU", Kind: KindSSH, Target: "gpu-host", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if err := r.Delete("n1"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	var file struct {
		Version  int
		Note     map[string]string
		Machines []json.RawMessage
	}
	if err := json.Unmarshal(b, &file); err != nil || file.Version != 1 || file.Note["by"] != "hand" || len(file.Machines) != 7 {
		t.Fatalf("written %s (%v)", b, err)
	}
	for i, want := range []string{
		`{"id":"a1","label":"GPU","kind":"ssh","target":"gpu-host","enabled":false,"jump":"bastion"}`,
		`{"id":"p1","label":"p1","kind":"ssh","target":"-oProxyCommand=touch /tmp/pwned","enabled":true}`,
		`{"label":"no id","target":"x"}`,
		`{"id":"a1","target":"duplicate"}`,
		`{"id":"d1","kind":"docker","target":"c1"}`,
		`"not a record"`,
		`{"id":"local","label":"","kind":"local","enabled":false,"pinned":true}`,
	} {
		var got bytes.Buffer
		json.Compact(&got, file.Machines[i])
		if got.String() != want {
			t.Errorf("entry %d = %s, want %s", i, got.String(), want)
		}
	}
	// Read again, the same.
	r, err = OpenRegistry(path)
	if err != nil || len(r.Specs()) != 3 || r.Kept() != 4 {
		t.Fatalf("read back %+v %d %v", r.Specs(), r.Kept(), err)
	}
	mg := NewManager(nil, nil, log.New(io.Discard, "", 0))
	if err := mg.Add(Spec{ID: "p3", Target: "-oProxyCommand=x"}); !errors.Is(err, ErrInvalidTarget) {
		t.Fatalf("add: %v", err)
	}
}

// A machine whose stored target is refused shows an error with its code
// and is never dialed: not when the manager runs it, not when it is
// enabled, retried or renamed. Removing it ends it.
func TestInvalidTargetNeverDialed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machines.json")
	os.WriteFile(path, []byte(`{"version":1,"machines":[{"id":"bad","kind":"ssh","target":"h$(id)","enabled":false}]}`), 0o600)
	reg, err := OpenRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	var dials atomic.Int32
	dial := func(ctx context.Context, s Spec) (*transport.Session, string, error) {
		if s.ID == "bad" {
			dials.Add(1)
		}
		return nil, "", errors.New("no")
	}
	mg := NewManager(LoadSpecs(reg.Specs(), nil), dial, log.New(io.Discard, "", 0))
	mg.UseRegistry(reg)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		mg.Run(ctx)
		close(done)
	}()
	st := mg.Get("bad").State()
	if st.Status != StatusError || st.Code != CodeInvalidTarget || st.Label != "bad" {
		t.Fatalf("state %+v", st)
	}
	if err := mg.SetEnabled("bad", true); err != nil {
		t.Fatal(err)
	}
	mg.Get("bad").Wake()
	if err := mg.SetLabel("bad", "old box"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	st = mg.Get("bad").State()
	if st.Status != StatusError || st.Code != CodeInvalidTarget || !st.Enabled || st.Label != "old box" {
		t.Fatalf("state %+v", st)
	}
	if got, _ := reg.Get("bad"); !got.Enabled || got.Label != "old box" || got.Target != "h$(id)" {
		t.Fatalf("stored %+v", got)
	}
	if err := mg.Remove("bad"); err != nil {
		t.Fatal(err)
	}
	cancel()
	<-done
	if n := dials.Load(); n != 0 {
		t.Fatalf("dialed %d times", n)
	}
}

// Where no agent runs (Windows) the local machine is listed in error with
// its code and never dialed; SSH machines connect as anywhere else.
func TestLocalMachineWithoutAnAgent(t *testing.T) {
	defer func(was bool) { LocalSupported = was }(LocalSupported)
	LocalSupported = false
	var local, ssh atomic.Int32
	dial := func(ctx context.Context, s Spec) (*transport.Session, string, error) {
		if s.Kind == KindLocal {
			local.Add(1)
		} else {
			ssh.Add(1)
		}
		return nil, "", errors.New("no")
	}
	mg := NewManager([]Spec{{ID: LocalID, Label: "box (local)", Kind: KindLocal, Enabled: true},
		{ID: "gpu", Label: "gpu", Kind: KindSSH, Target: "gpu", Enabled: true}}, dial, log.New(io.Discard, "", 0))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		mg.Run(ctx)
		close(done)
	}()
	for deadline := time.Now().Add(5 * time.Second); ssh.Load() == 0; time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the SSH machine was not dialed")
		}
	}
	mg.Get(LocalID).Wake()
	time.Sleep(50 * time.Millisecond)
	cancel()
	<-done
	if st := mg.Get(LocalID).State(); st.Status != StatusError || st.Code != CodeLocalUnsupported {
		t.Fatalf("local %+v", st)
	}
	if n := local.Load(); n != 0 {
		t.Fatalf("the local machine was dialed %d times", n)
	}
}

// A machine is ready once its agent answers, quietly.
func TestReadyWhenTheAgentAnswers(t *testing.T) {
	dialLocal := dialAgent(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))

	var logs strings.Builder
	var logMu sync.Mutex
	logger := log.New(writerFunc(func(p []byte) (int, error) {
		logMu.Lock()
		defer logMu.Unlock()
		return logs.Write(p)
	}), "", 0)
	dial := func(ctx context.Context, spec Spec) (*transport.Session, string, error) {
		s, err := dialLocal(ctx, log.New(io.Discard, "", 0))
		return s, "test/test", err
	}
	m := newMachine(Spec{ID: "x", Label: "x", Kind: KindSSH, Target: "x", Enabled: true}, dial, logger, func(State) {})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		m.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	for deadline := time.Now().Add(10 * time.Second); m.State().Status != StatusReady; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("timed out (status %s)", m.State().Status)
		}
	}
	time.Sleep(300 * time.Millisecond)
	if st := m.State(); st.Status != StatusReady || st.Info == nil || st.Platform != "test/test" || m.Session() == nil {
		t.Fatalf("state %s %+v", st.Status, st)
	}
	logMu.Lock()
	defer logMu.Unlock()
	if logs.Len() > 0 {
		t.Fatalf("logged: %s", logs.String())
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// Disabling a connected machine ends its session at once; enabling it
// connects again.
func TestDisableAndEnableAtRuntime(t *testing.T) {
	dialLocal := dialAgent(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	logger := log.New(io.Discard, "", 0)
	var dials atomic.Int32
	dial := func(ctx context.Context, spec Spec) (*transport.Session, string, error) {
		dials.Add(1)
		s, err := dialLocal(ctx, logger)
		return s, "test/test", err
	}
	path := filepath.Join(t.TempDir(), "machines.json")
	reg, _ := OpenRegistry(path)
	reg.Put(Spec{ID: "x", Label: "x", Kind: KindSSH, Target: "x", Enabled: true})
	mg := NewManager([]Spec{{ID: "x", Label: "x", Kind: KindSSH, Target: "x", Enabled: true}}, dial, logger)
	mg.UseRegistry(reg)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		mg.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	m := mg.Get("x")
	waitFor := func(what string, ok func() bool) {
		t.Helper()
		for deadline := time.Now().Add(10 * time.Second); !ok(); time.Sleep(10 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s (status %s, %d dials)", what, m.State().Status, dials.Load())
			}
		}
	}
	waitFor("a session", func() bool { return m.Session() != nil })
	first := m.Session()

	if err := mg.SetEnabled("x", false); err != nil {
		t.Fatal(err)
	}
	waitFor("the session to end", func() bool {
		select {
		case <-first.Done():
			return m.Session() == nil
		default:
			return false
		}
	})
	time.Sleep(100 * time.Millisecond)
	if st := m.State(); st.Status != StatusDisabled || st.Enabled || dials.Load() != 1 {
		t.Fatalf("disabled: status %s enabled %v, %d dials", st.Status, st.Enabled, dials.Load())
	}
	if r, _ := OpenRegistry(path); r.Specs()[0].Enabled {
		t.Fatal("the choice was not saved")
	}

	if err := mg.SetEnabled("x", true); err != nil {
		t.Fatal(err)
	}
	waitFor("a new session", func() bool { s := m.Session(); return s != nil && s != first && dials.Load() == 2 })
	if !m.State().Enabled {
		t.Fatal("not enabled")
	}
	if err := mg.SetEnabled("nope", true); err != ErrUnknownMachine {
		t.Fatalf("unknown machine: %v", err)
	}
}

// Machines added at runtime are stored, join a running manager and connect;
// removing one ends its session, deletes its record and publishes nothing
// more for it. A target or id the core has is refused, and the local machine
// cannot be removed.
func TestAddAndRemoveAtRuntime(t *testing.T) {
	dialLocal := dialAgent(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	logger := log.New(io.Discard, "", 0)
	dial := func(ctx context.Context, spec Spec) (*transport.Session, string, error) {
		s, err := dialLocal(ctx, logger)
		return s, "test/test", err
	}
	path := filepath.Join(t.TempDir(), "machines.json")
	reg, _ := OpenRegistry(path)
	// Stored, but left out of this run (--local-only).
	reg.Put(Spec{ID: "off", Label: "elsewhere", Target: "u@elsewhere", Enabled: true})
	mg := NewManager([]Spec{{ID: LocalID, Label: "local", Kind: KindLocal, Enabled: true}}, dial, logger)
	mg.UseRegistry(reg)
	var afterRemove atomic.Int32
	var removed atomic.Bool
	mg.Subscribe(func(st State) {
		if st.ID == "x" && removed.Load() {
			afterRemove.Add(1)
		}
	}, func(AgentEvent) {})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		mg.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	waitFor := func(what string, ok func() bool) {
		t.Helper()
		for deadline := time.Now().Add(10 * time.Second); !ok(); time.Sleep(10 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s", what)
			}
		}
	}

	spec := Spec{ID: "x", Label: "x", Target: "u@x", Enabled: true}
	if err := mg.Add(spec); err != nil {
		t.Fatal(err)
	}
	for _, dup := range []Spec{spec, {ID: "y", Target: "u@x"}, {ID: "z", Target: "u@elsewhere"}, {ID: "off", Target: "new"}} {
		if err := mg.Add(dup); err != ErrMachineExists {
			t.Fatalf("added %+v: %v", dup, err)
		}
	}
	m := mg.Get("x")
	waitFor("the added machine's session", func() bool { return m.Session() != nil })
	if st := mg.States(); len(st) != 2 || st[1].ID != "x" || st[1].Kind != KindSSH {
		t.Fatalf("states = %+v", st)
	}
	if r, _ := OpenRegistry(path); len(r.Specs()) != 2 || r.Specs()[1].Target != "u@x" {
		t.Fatalf("stored %+v", r.Specs())
	}
	sess := m.Session()

	removed.Store(true)
	if err := mg.Remove("x"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-sess.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("the session did not end")
	}
	if mg.Get("x") != nil || len(mg.States()) != 1 {
		t.Fatalf("still there: %+v", mg.States())
	}
	if n := afterRemove.Load(); n != 0 {
		t.Fatalf("%d states published after the removal", n)
	}
	if b, _ := os.ReadFile(path); strings.Contains(string(b), `"x"`) {
		t.Fatalf("the record was kept: %s", b)
	}
	if err := mg.Remove("x"); err != ErrUnknownMachine {
		t.Fatalf("removed twice: %v", err)
	}
	if err := mg.Remove(LocalID); err != ErrLocalMachine {
		t.Fatalf("removed the local machine: %v", err)
	}

	// A machine added disabled stays so.
	if err := mg.Add(Spec{ID: "y", Label: "y", Target: "u@y"}); err != nil {
		t.Fatal(err)
	}
	if st := mg.Get("y").State(); st.Status != StatusDisabled || st.Enabled {
		t.Fatalf("y = %s enabled %v", st.Status, st.Enabled)
	}
}

// Renaming is stored for stored machines and kept in memory for --ssh ones;
// a label another machine has (also one stored but not running) is refused,
// and the local machine's name is stored once given. Enabling or disabling
// the local machine stores a record of it, without its host's name.
func TestSetLabelAndLocalRecord(t *testing.T) {
	// Disabling the local machine is what is tested: on Windows it has no
	// agent and stays in error otherwise.
	defer func(was bool) { LocalSupported = was }(LocalSupported)
	LocalSupported = true
	path := filepath.Join(t.TempDir(), "machines.json")
	reg, _ := OpenRegistry(path)
	reg.Put(Spec{ID: "a", Label: "a", Target: "a", Enabled: true})
	reg.Put(Spec{ID: "off", Label: "elsewhere", Target: "e", Enabled: true})
	mg := NewManager([]Spec{
		{ID: LocalID, Label: "mac (local)", Kind: KindLocal, Enabled: true},
		{ID: "a", Label: "a", Kind: KindSSH, Target: "a", Enabled: true},
		{ID: "extra", Label: "extra", Kind: KindSSH, Target: "extra", Enabled: true},
	}, nil, log.New(io.Discard, "", 0))
	mg.UseRegistry(reg)
	var labels []string
	mg.Subscribe(func(st State) { labels = append(labels, st.Label) }, func(AgentEvent) {})

	if err := mg.SetLabel("a", "GPU"); err != nil {
		t.Fatal(err)
	}
	if mg.Get("a").Label() != "GPU" || len(labels) == 0 || labels[0] != "GPU" {
		t.Fatalf("label %q, published %v", mg.Get("a").Label(), labels)
	}
	for _, c := range []struct {
		id, label string
		want      error
	}{{"extra", "GPU", ErrLabelTaken}, {"extra", "elsewhere", ErrLabelTaken}, {LocalID, "GPU", ErrLabelTaken}, {"nope", "x", ErrUnknownMachine}} {
		if err := mg.SetLabel(c.id, c.label); err != c.want {
			t.Fatalf("%s → %s: %v", c.id, c.label, err)
		}
	}
	if err := mg.SetLabel("extra", "Extra"); err != nil || mg.Get("extra").Label() != "Extra" {
		t.Fatalf("--ssh machine: %v", err)
	}
	if err := mg.SetEnabled(LocalID, false); err != nil {
		t.Fatal(err)
	}
	r, _ := OpenRegistry(path)
	got := r.Specs()
	if len(got) != 3 || got[0].Label != "GPU" || got[2] != (Spec{ID: LocalID, Kind: KindLocal}) {
		t.Fatalf("stored %+v", got)
	}
	if mg.Get(LocalID).State().Status != StatusDisabled {
		t.Fatal("the local machine is not disabled")
	}
	// Renamed, the local machine keeps its name in its record, which the
	// next start uses instead of the host's.
	if err := mg.SetLabel(LocalID, "Workstation"); err != nil || mg.Get(LocalID).Label() != "Workstation" {
		t.Fatalf("local rename: %v", err)
	}
	r, _ = OpenRegistry(path)
	if s, _ := r.Get(LocalID); s != (Spec{ID: LocalID, Label: "Workstation", Kind: KindLocal}) {
		t.Fatalf("stored local %+v", s)
	}
	if specs := LoadSpecs(r.Specs(), nil); specs[0].Label != "Workstation" || specs[0].Enabled {
		t.Fatalf("loaded local %+v", specs[0])
	}
}
