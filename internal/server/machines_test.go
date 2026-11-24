package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"veldr/internal/machines"
	"veldr/internal/plugin"
	"veldr/internal/transport"
)

// machinesFixture is a core with the local machine, a stored SSH machine
// and an --ssh machine, over a machines file in a temporary directory. The
// machines do not connect.
type machinesFixture struct {
	t     *testing.T
	path  string
	mg    *machines.Manager
	audit *strings.Builder
	srv   *Server
}

func newMachinesFixture(t *testing.T) *machinesFixture {
	f := &machinesFixture{t: t, path: filepath.Join(t.TempDir(), "machines.json"), audit: &strings.Builder{}}
	reg, err := machines.OpenRegistry(f.path, nil)
	if err != nil {
		t.Fatal(err)
	}
	reg.Put(machines.Spec{ID: "gpu", Label: "gpu", Target: "u@gpu", Enabled: true})
	f.mg = machines.NewManager([]machines.Spec{
		{ID: machines.LocalID, Label: "local", Kind: machines.KindLocal, Enabled: true},
		{ID: "gpu", Label: "gpu", Kind: machines.KindSSH, Target: "u@gpu", Enabled: true},
		{ID: "extra", Label: "extra", Kind: machines.KindSSH, Target: "extra", Enabled: true},
	}, nil, log.New(io.Discard, "", 0))
	f.mg.UseRegistry(reg)
	f.srv = f.server(false)
	return f
}

func (f *machinesFixture) server(readOnly bool) *Server {
	return New(f.mg, Options{ReadOnly: readOnly, Logger: log.New(io.Discard, "", 0), Audit: f.audit})
}

func (f *machinesFixture) request(s *Server, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Host = "127.0.0.1:7780"
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}

// stored returns the machines file's records.
func (f *machinesFixture) stored() []machines.Spec {
	r, err := machines.OpenRegistry(f.path, nil)
	if err != nil {
		f.t.Fatal(err)
	}
	return r.Specs()
}

func (f *machinesFixture) audited(events ...string) {
	f.t.Helper()
	for _, want := range events {
		if !strings.Contains(f.audit.String(), want) {
			f.t.Fatalf("audit lacks %s: %s", want, f.audit.String())
		}
	}
}

type httpCase struct {
	readOnly           bool
	method, path, body string
	code               int
	want               string
}

func (f *machinesFixture) run(cases []httpCase) {
	f.t.Helper()
	for _, c := range cases {
		if w := f.request(f.server(c.readOnly), c.method, c.path, c.body); w.Code != c.code || !strings.Contains(w.Body.String(), c.want) {
			f.t.Errorf("%s %s %s read-only=%v: %d %s", c.method, c.path, c.body, c.readOnly, w.Code, w.Body)
		}
	}
}

// Adding stores an SSH machine and adds it to the running core; targets
// that would read as options, odd labels, a target the core has and
// read-only browsers are refused.
func TestMachineAdd(t *testing.T) {
	f := newMachinesFixture(t)
	f.run([]httpCase{
		{false, "POST", "/api/machines", `{"target":"-oProxyCommand=x"}`, 400, `"error":"invalid_target"`},
		{false, "POST", "/api/machines", `{"target":"a b"}`, 400, `"error":"invalid_target"`},
		{false, "POST", "/api/machines", `{"target":""}`, 400, `"error":"invalid_target"`},
		{false, "POST", "/api/machines", `{"target":"h!x"}`, 400, `"error":"invalid_target"`},
		{false, "POST", "/api/machines", `{"target":"box;id"}`, 400, `"error":"invalid_target"`},
		{false, "POST", "/api/machines", `{"target":"$(id)"}`, 400, `"error":"invalid_target"`},
		{false, "POST", "/api/machines", `{"target":"box\u000aid"}`, 400, `"error":"invalid_target"`},
		{false, "POST", "/api/machines", `{"target":"box","label":"a\nb"}`, 400, `"error":"invalid"`},
		{false, "POST", "/api/machines", `{"target":"box","label":"` + strings.Repeat("x", 65) + `"}`, 400, `"error":"invalid"`},
		{false, "POST", "/api/machines", `{`, 400, `"error":"invalid"`},
		{false, "POST", "/api/machines", `{"target":"u@gpu"}`, 409, "machine_exists"},
		{false, "POST", "/api/machines", `{"target":"extra"}`, 409, "machine_exists"},
		{true, "POST", "/api/machines", `{"target":"box"}`, 403, "read-only"},
		{false, "GET", "/api/machines/add?target=box", "", 404, ""},
		{false, "POST", "/api/machines/refresh", "", 404, ""},
	})
	if n := len(f.mg.States()); n != 3 {
		t.Fatalf("%d machines after refusals", n)
	}

	w := f.request(f.srv, "POST", "/api/machines", `{"target":" u@new-host ","label":" New host "}`)
	var st machines.State
	json.Unmarshal(w.Body.Bytes(), &st)
	if w.Code != http.StatusCreated || st.Label != "New host" || st.Target != "u@new-host" || st.Kind != machines.KindSSH || !st.Enabled || len(st.ID) != 16 {
		t.Fatalf("add: %d %s", w.Code, w.Body)
	}
	if f.mg.Get(st.ID) == nil || len(f.mg.States()) != 4 {
		t.Fatal("not added to the core")
	}
	got := f.stored()
	if len(got) != 2 || got[1] != (machines.Spec{ID: st.ID, Label: "New host", Kind: machines.KindSSH, Target: "u@new-host", Enabled: true}) {
		t.Fatalf("stored %+v", got)
	}
	// Without a label, the target names it.
	w = f.request(f.srv, "POST", "/api/machines", `{"target":"plain"}`)
	if w.Code != http.StatusCreated || !strings.Contains(w.Body.String(), `"label":"plain"`) {
		t.Fatalf("add without a label: %d %s", w.Code, w.Body)
	}
	// User names and aliases OpenSSH takes.
	for _, target := range []string{"user+tag@host", "me@[fe80::1%en0]:2222", "ssh://u@h:22", "ユーザー@ホスト"} {
		body, _ := json.Marshal(map[string]string{"target": target})
		if w := f.request(f.srv, "POST", "/api/machines", string(body)); w.Code != http.StatusCreated {
			t.Fatalf("add %q: %d %s", target, w.Code, w.Body)
		}
	}
	f.audited(`"event":"machine.add"`, `"target":"u@new-host"`, `"error":"machine exists"`)
}

// Renaming changes the label at once; it is stored for stored machines and
// kept for this run for --ssh ones. Empty, odd or taken labels, the local
// machine and read-only browsers are refused.
func TestMachineRename(t *testing.T) {
	f := newMachinesFixture(t)
	f.run([]httpCase{
		{false, "PUT", "/api/m/gpu/label", `{"label":"  "}`, 400, "invalid"},
		{false, "PUT", "/api/m/gpu/label", `{"label":"a\u0007b"}`, 400, "invalid"},
		{false, "PUT", "/api/m/gpu/label", `{}`, 400, "invalid"},
		{false, "PUT", "/api/m/gpu/label", `{"label":"extra"}`, 409, "label_taken"},
		{false, "PUT", "/api/m/nope/label", `{"label":"x"}`, 404, "unknown"},
		{true, "PUT", "/api/m/gpu/label", `{"label":"x"}`, 403, "read-only"},
	})
	w := f.request(f.srv, "PUT", "/api/m/gpu/label", `{"label":" -GPU box "}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"label":"-GPU box"`) || f.mg.Get("gpu").Label() != "-GPU box" {
		t.Fatalf("rename: %d %s", w.Code, w.Body)
	}
	if got := f.stored(); got[0].Label != "-GPU box" {
		t.Fatalf("stored %+v", got)
	}
	if w := f.request(f.srv, "PUT", "/api/m/extra/label", `{"label":"Extra"}`); w.Code != http.StatusOK || f.mg.Get("extra").Label() != "Extra" || len(f.stored()) != 1 {
		t.Fatalf("--ssh machine: %d %s %+v", w.Code, w.Body, f.stored())
	}
	if w := f.request(f.srv, "PUT", "/api/m/local/label", `{"label":"Workstation"}`); w.Code != http.StatusOK || f.mg.Get("local").Label() != "Workstation" {
		t.Fatalf("local machine: %d %s", w.Code, w.Body)
	}
	f.audited(`"event":"machine.rename"`, `"from":"gpu"`, `"label":"-GPU box"`)
}

// Ordering names every machine once; the order is stored, and a core that
// starts over the machines file lists them in it.
func TestMachineOrder(t *testing.T) {
	f := newMachinesFixture(t)
	f.run([]httpCase{
		{false, "PUT", "/api/machines/order", `{}`, 400, "invalid"},
		{false, "PUT", "/api/machines/order", `{"order":["gpu","local"]}`, 400, "invalid"},
		{false, "PUT", "/api/machines/order", `{"order":["gpu","gpu","local"]}`, 400, "invalid"},
		{false, "PUT", "/api/machines/order", `{"order":["gpu","nope","local"]}`, 400, "invalid"},
		{true, "PUT", "/api/machines/order", `{"order":["gpu","extra","local"]}`, 403, "read-only"},
	})
	ids := func(mg *machines.Manager) []string {
		var out []string
		for _, st := range mg.States() {
			out = append(out, st.ID)
		}
		return out
	}
	want := []string{"gpu", "extra", "local"}
	if w := f.request(f.srv, "PUT", "/api/machines/order", `{"order":["gpu","extra","local"]}`); w.Code != http.StatusOK || !reflect.DeepEqual(ids(f.mg), want) {
		t.Fatalf("order: %d %s %v", w.Code, w.Body, ids(f.mg))
	}
	reg, err := machines.OpenRegistry(f.path, nil)
	if err != nil {
		t.Fatal(err)
	}
	mg := machines.NewManager([]machines.Spec{
		{ID: machines.LocalID, Label: "local", Kind: machines.KindLocal, Enabled: true},
		{ID: "new", Label: "new", Kind: machines.KindSSH, Target: "new", Enabled: true},
		{ID: "gpu", Label: "gpu", Kind: machines.KindSSH, Target: "u@gpu", Enabled: true},
	}, nil, log.New(io.Discard, "", 0))
	mg.UseRegistry(reg)
	if got := ids(mg); !reflect.DeepEqual(got, []string{"gpu", "local", "new"}) {
		t.Fatalf("after a restart: %v", got)
	}
	f.audited(`"event":"machine.order"`)
}

// Removing drops the machine and its record; the local machine stays.
func TestMachineRemove(t *testing.T) {
	f := newMachinesFixture(t)
	f.run([]httpCase{
		{false, "DELETE", "/api/m/local", "", 400, "local"},
		{false, "DELETE", "/api/m/nope", "", 404, "unknown"},
		{true, "DELETE", "/api/m/gpu", "", 403, "read-only"},
	})
	forgetter := &forgetPlugin{}
	f.srv.opts.Plugins = append(f.srv.opts.Plugins, forgetter)
	if w := f.request(f.srv, "DELETE", "/api/m/gpu", ""); w.Code != http.StatusOK || f.mg.Get("gpu") != nil || len(f.stored()) != 0 {
		t.Fatalf("remove: %d %s", w.Code, w.Body)
	}
	if strings.Join(forgetter.ids, ",") != "gpu" {
		t.Errorf("plugins told of %v", forgetter.ids)
	}
	if w := f.request(f.srv, "DELETE", "/api/m/extra", ""); w.Code != http.StatusOK || f.mg.Get("extra") != nil {
		t.Fatalf("remove --ssh: %d %s", w.Code, w.Body)
	}
	f.audited(`"event":"machine.remove"`, `"target":"u@gpu"`)
}

// A removed machine leaves nothing behind: its terminal backend (whose
// clients no longer count it), its code-server proxy and activity, and
// whether it was ready, so one added again under the same id starts afresh.
func TestMachineRemoveForgets(t *testing.T) {
	f := newMachinesFixture(t)
	s := f.srv
	b := s.term.backend("gpu")
	c := &termClient{s: s, subs: map[string]*termBackend{"gpu": b}}
	b.mu.Lock()
	b.subs[c] = true
	b.stopped = true
	b.mu.Unlock()
	s.csProxy.proxy(f.mg.Get("gpu"))
	s.csProxy.touch("gpu", 1)
	s.readyMu.Lock()
	s.ready["gpu"] = true
	s.readyMu.Unlock()

	if w := f.request(s, "DELETE", "/api/m/gpu", ""); w.Code != http.StatusOK {
		t.Fatalf("remove: %d %s", w.Code, w.Body)
	}
	if s.term.existing("gpu") != nil || len(c.subs) != 0 || len(b.subs) != 0 || !b.gone {
		t.Fatalf("terminal backend kept: %v %v %v", s.term.existing("gpu"), c.subs, b.gone)
	}
	s.csProxy.mu.Lock()
	_, rp := s.csProxy.proxies["gpu"]
	_, act := s.csProxy.active["gpu"]
	_, last := s.csProxy.last["gpu"]
	s.csProxy.mu.Unlock()
	if rp || act || last {
		t.Fatalf("code-server proxy kept: %v %v %v", rp, act, last)
	}
	s.readyMu.Lock()
	ready := s.ready["gpu"]
	s.readyMu.Unlock()
	if ready {
		t.Fatal("still ready")
	}
	if nb := s.term.backend("gpu"); nb == b || nb.stopped {
		t.Fatal("the same id got the old backend")
	}
}

// Enabling and disabling is a mutation: refused in read-only mode, checked,
// audited and stored.
func TestMachineEnabled(t *testing.T) {
	f := newMachinesFixture(t)
	f.run([]httpCase{
		{true, "PUT", "/api/m/gpu/enabled", `{"enabled":false}`, 403, "read-only"},
		{false, "PUT", "/api/m/nope/enabled", `{"enabled":false}`, 404, "unknown"},
		{false, "PUT", "/api/m/gpu/enabled", `{}`, 400, "invalid"},
	})
	if !f.mg.Get("gpu").State().Enabled {
		t.Fatal("changed by a refused request")
	}
	w := f.request(f.srv, "PUT", "/api/m/gpu/enabled", `{"enabled":false}`)
	if w.Code != 200 || f.mg.Get("gpu").State().Status != machines.StatusDisabled {
		t.Fatalf("disable: %d %s", w.Code, w.Body)
	}
	if got := f.stored(); got[0].Enabled {
		t.Fatalf("stored %+v", got)
	}
	if w := f.request(f.srv, "PUT", "/api/m/local/enabled", `{"enabled":false}`); w.Code != 200 || len(f.stored()) != 2 {
		t.Fatalf("local: %d %+v", w.Code, f.stored())
	}
	f.audited(`"event":"machine.disable"`, `"machine":"gpu"`)
}

// The terminal core's lifecycle endpoints: refused read-only, unknown
// actions and machines are not found, a machine without its agent answers
// machine_offline. Full Disk Access is reported read-only too.
func TestHCEndpointsGuard(t *testing.T) {
	f := newMachinesFixture(t)
	f.run([]httpCase{
		{true, "POST", "/api/m/gpu/hc/stop", "", 403, "read-only"},
		{false, "POST", "/api/m/gpu/hc/explode", "", 404, ""},
		{false, "POST", "/api/m/nope/hc/stop", "", 404, ""},
		{false, "POST", "/api/m/gpu/hc/stop", "", 409, "machine_offline"},
		{true, "GET", "/api/m/gpu/hc", "", 409, "machine_offline"},
		{true, "GET", "/api/m/gpu/privacy", "", 409, "machine_offline"},
		{true, "GET", "/api/m/nope/privacy", "", 404, ""},
	})
	if strings.Contains(f.audit.String(), `"hc.`) {
		t.Fatalf("audited a refused action: %s", f.audit.String())
	}
}

// A stored machine whose target ValidTarget refuses is listed in error with
// its code, can be renamed and removed, and never reaches ssh, not even
// through the authentication terminal.
func TestMachineWithInvalidTarget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machines.json")
	os.WriteFile(path, []byte(`{"version":1,"machines":[{"id":"bad","label":"bad","kind":"ssh","target":"-oProxyCommand=touch /tmp/x","enabled":true,"future":1}]}`), 0o600)
	reg, err := machines.OpenRegistry(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	mg := machines.NewManager(machines.LoadSpecs(reg.Specs(), nil), func(context.Context, machines.Spec) (*transport.Session, string, error) {
		t.Error("dialed")
		return nil, "", errors.New("dialed")
	}, log.New(io.Discard, "", 0))
	mg.UseRegistry(reg)
	f := &machinesFixture{t: t, path: path, mg: mg, audit: &strings.Builder{}}
	f.srv = f.server(false)
	w := f.request(f.srv, "GET", "/api/machines", "")
	if !strings.Contains(w.Body.String(), `"id":"bad","label":"bad","kind":"ssh","target":"-oProxyCommand=touch /tmp/x","enabled":true,"status":"error","code":"invalid_target"`) {
		t.Fatalf("machines: %s", w.Body)
	}
	f.run([]httpCase{
		{false, "GET", "/api/m/bad/auth", "", 400, `"error":"invalid_target"`},
	})
	if w := f.request(f.srv, "PUT", "/api/m/bad/label", `{"label":"Old box"}`); w.Code != http.StatusOK || f.stored()[0].Label != "Old box" {
		t.Fatalf("rename: %d %s %+v", w.Code, w.Body, f.stored())
	}
	if b, _ := os.ReadFile(path); !strings.Contains(string(b), `"future": 1`) || !strings.Contains(string(b), "ProxyCommand") {
		t.Fatalf("stored %s", b)
	}
	if w := f.request(f.srv, "DELETE", "/api/m/bad", ""); w.Code != http.StatusOK || len(f.stored()) != 0 {
		t.Fatalf("remove: %d %s", w.Code, w.Body)
	}
}

// Without a control directory (Windows: ssh shares no connections) the UI
// offers no ssh login, and the endpoint refuses one; with one it is offered.
func TestSSHLoginNeedsAControlDir(t *testing.T) {
	mg := machines.NewManager([]machines.Spec{{ID: "gpu", Label: "gpu", Kind: machines.KindSSH, Target: "gpu", Enabled: true}},
		func(ctx context.Context, _ machines.Spec) (*transport.Session, string, error) {
			<-ctx.Done()
			return nil, "", ctx.Err()
		}, log.New(io.Discard, "", 0))
	get := func(s *Server, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.Host = "127.0.0.1:7780"
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	without := New(mg, Options{Logger: log.New(io.Discard, "", 0)})
	if w := get(without, "/api/config"); !strings.Contains(w.Body.String(), `"ssh_login":false`) {
		t.Errorf("config: %s", w.Body)
	}
	if w := get(without, "/api/m/gpu/auth"); w.Code != http.StatusNotImplemented || !strings.Contains(w.Body.String(), `"error":"ssh_login_unsupported"`) {
		t.Errorf("auth: %d %s", w.Code, w.Body)
	}
	with := New(mg, Options{Logger: log.New(io.Discard, "", 0), ControlDir: t.TempDir()})
	if w := get(with, "/api/config"); !strings.Contains(w.Body.String(), `"ssh_login":true`) {
		t.Errorf("config: %s", w.Body)
	}
}

// The Add Machine dialog's list of the core host's ssh aliases: aliases
// that are no machine's target yet, with their HostName and User only;
// none from another site or in read-only mode, and an empty list without a
// configuration.
func TestSSHHosts(t *testing.T) {
	f := newMachinesFixture(t)
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".ssh"), 0o700)
	os.WriteFile(filepath.Join(home, ".ssh", "config"), []byte(`Host gpu extra lab bad|alias *.corp
  HostName 10.0.0.5
  User yutong
  IdentityFile ~/.ssh/id_secret
Host EXTRA2 other
`), 0o600)
	home2 := ""
	f.srv.home = func() (string, error) { return home2, nil }
	get := func(s *Server, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/api/ssh/hosts", nil)
		r.Host = "127.0.0.1:7780"
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	// No configuration.
	home2 = t.TempDir()
	if w := get(f.srv, ""); w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("without a config: %d %s", w.Code, w.Body)
	}
	home2 = home
	w := get(f.srv, "http://127.0.0.1:7780")
	var got []map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &got); w.Code != 200 || err != nil {
		t.Fatalf("%d %s %v", w.Code, w.Body, err)
	}
	// gpu is u@gpu's host and extra a target: both are machines already.
	want := []map[string]string{
		{"alias": "lab", "hostname": "10.0.0.5", "user": "yutong"},
		{"alias": "EXTRA2"},
		{"alias": "other"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("hosts = %v, want %v", got, want)
	}
	if strings.Contains(w.Body.String(), "id_secret") {
		t.Errorf("a key path left the core: %s", w.Body)
	}
	if w := get(f.srv, "https://evil.example"); w.Code != http.StatusForbidden {
		t.Errorf("from another site: %d", w.Code)
	}
	ro := f.server(true)
	ro.home = func() (string, error) { return home, nil }
	if w := get(ro, ""); w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), "lab") {
		t.Errorf("read-only: %d %s", w.Code, w.Body)
	}
	// A core whose user has no home directory lists none.
	f.srv.home = func() (string, error) { return "", errors.New("no home") }
	if w := get(f.srv, ""); w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Errorf("without a home: %d %s", w.Code, w.Body)
	}
}

func TestTargetHost(t *testing.T) {
	for in, want := range map[string]string{
		"gpu": "gpu", "me@gpu": "gpu", "ssh://me@gpu:2222": "gpu", "gpu:22": "gpu",
		"me@[fe80::1%en0]:22": "fe80::1%en0", "fe80::1": "fe80::1", "u%40x@h": "h",
	} {
		if got := targetHost(in); got != want {
			t.Errorf("targetHost(%q) = %q, want %q", in, got, want)
		}
	}
}

// forgetPlugin records the machines the core tells it were removed.
type forgetPlugin struct{ ids []string }

func (*forgetPlugin) ID() string                               { return "forget" }
func (*forgetPlugin) Routes() []plugin.Route                   { return nil }
func (p *forgetPlugin) ForgetMachine(_ plugin.Host, id string) { p.ids = append(p.ids, id) }
