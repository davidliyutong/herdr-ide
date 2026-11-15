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
	"strings"
	"testing"

	"herdr-ide/internal/machines"
	"herdr-ide/internal/transport"
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
		{false, "PUT", "/api/m/local/label", `{"label":"x"}`, 400, "local"},
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
	f.audited(`"event":"machine.rename"`, `"from":"gpu"`, `"label":"-GPU box"`)
}

// Removing drops the machine and its record; the local machine stays.
func TestMachineRemove(t *testing.T) {
	f := newMachinesFixture(t)
	f.run([]httpCase{
		{false, "DELETE", "/api/m/local", "", 400, "local"},
		{false, "DELETE", "/api/m/nope", "", 404, "unknown"},
		{true, "DELETE", "/api/m/gpu", "", 403, "read-only"},
	})
	if w := f.request(f.srv, "DELETE", "/api/m/gpu", ""); w.Code != http.StatusOK || f.mg.Get("gpu") != nil || len(f.stored()) != 0 {
		t.Fatalf("remove: %d %s", w.Code, w.Body)
	}
	if w := f.request(f.srv, "DELETE", "/api/m/extra", ""); w.Code != http.StatusOK || f.mg.Get("extra") != nil {
		t.Fatalf("remove --ssh: %d %s", w.Code, w.Body)
	}
	f.audited(`"event":"machine.remove"`, `"target":"u@gpu"`)
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
// machine_offline.
func TestHCEndpointsGuard(t *testing.T) {
	f := newMachinesFixture(t)
	f.run([]httpCase{
		{true, "POST", "/api/m/gpu/hc/stop", "", 403, "read-only"},
		{false, "POST", "/api/m/gpu/hc/explode", "", 404, ""},
		{false, "POST", "/api/m/nope/hc/stop", "", 404, ""},
		{false, "POST", "/api/m/gpu/hc/stop", "", 409, "machine_offline"},
		{true, "GET", "/api/m/gpu/hc", "", 409, "machine_offline"},
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
