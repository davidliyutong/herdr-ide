package server

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"herdr-ide/internal/machines"
)

// fakeHerdr is a herdr whose machine commands record their arguments and
// replace herdr's catalog with the file the test prepared for the command.
const fakeHerdr = `#!/bin/sh
printf '%s\n' "$@" > "$FAKE_DIR/args"
cat="$XDG_STATE_HOME/herdr/client/endpoints.json"
if [ -e "$FAKE_DIR/refuse" ]; then echo "herdr refused $2 of $3"; exit 1; fi
case "$1 $2" in
"machine add") echo "saving"; cp "$FAKE_DIR/after-add.json" "$cat" ;;
"machine remove") cp "$FAKE_DIR/after-remove.json" "$cat"; echo "Removed SSH machine $3." ;;
"machine rename") cp "$FAKE_DIR/after-rename.json" "$cat"; echo "Renamed SSH machine $3." ;;
esac
`

const (
	gpuID = "0123456789abcdef0123456789abcdef"
	newID = "fedcba9876543210fedcba9876543210"
	cliID = "00112233445566778899aabbccddeeff"
)

type entry struct {
	id, label string
	enabled   bool
}

func catalogJSON(es ...entry) string {
	var out []string
	for _, e := range es {
		on := "false"
		if e.enabled {
			on = "true"
		}
		out = append(out, `{"id":"`+e.id+`","label":"`+e.label+`","target":"t-`+e.id[:4]+`","session":"default","enabled":`+on+`}`)
	}
	return `{"version":1,"ssh":[` + strings.Join(out, ",") + `]}`
}

var (
	gpu    = entry{gpuID, "gpu", true}
	newM   = entry{newID, "new", true}
	fromUI = entry{cliID, "cli", true}
)

// machinesFixture is a core over a fake herdr's catalog: the local
// machine, herdr's saved machines and an --ssh machine.
type machinesFixture struct {
	t         *testing.T
	fake, cat string
	mg        *machines.Manager
	audit     *strings.Builder
	srv       *Server
	selected  func(machines.Spec) bool
}

func newMachinesFixture(t *testing.T, saved ...entry) *machinesFixture {
	state, fake := t.TempDir(), t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	t.Setenv("FAKE_DIR", fake)
	f := &machinesFixture{t: t, fake: fake, cat: filepath.Join(state, "herdr", "client", "endpoints.json"), audit: &strings.Builder{}}
	os.MkdirAll(filepath.Dir(f.cat), 0o700)
	f.write(f.cat, catalogJSON(saved...))
	f.write(filepath.Join(fake, "herdr"), fakeHerdr)
	specs := []machines.Spec{{ID: machines.LocalID, Label: "local", Kind: machines.KindLocal, Enabled: true}}
	cat, err := machines.SavedSpecs()
	if err != nil {
		t.Fatal(err)
	}
	specs = append(specs, cat...)
	specs = append(specs, machines.Spec{ID: "extra", Label: "extra", Kind: machines.KindSSH, Target: "extra", Enabled: true})
	f.mg = machines.NewManager(specs, nil, log.New(io.Discard, "", 0))
	f.srv = f.server(false)
	return f
}

func (f *machinesFixture) server(readOnly bool) *Server {
	s := New(f.mg, Options{ReadOnly: readOnly, Logger: log.New(io.Discard, "", 0), Audit: f.audit, Catalog: machines.SavedSpecs,
		Selected: func(sp machines.Spec) bool { return f.selected == nil || f.selected(sp) }})
	s.herdrCLI = func() string { return filepath.Join(f.fake, "herdr") }
	return s
}

func (f *machinesFixture) write(path, s string) {
	f.t.Helper()
	if err := os.WriteFile(path, []byte(s), 0o700); err != nil {
		f.t.Fatal(err)
	}
}

// after prepares the catalog herdr's next command leaves.
func (f *machinesFixture) after(cmd string, es ...entry) {
	f.write(filepath.Join(f.fake, "after-"+cmd+".json"), catalogJSON(es...))
}

func (f *machinesFixture) refuse(on bool) {
	if on {
		f.write(filepath.Join(f.fake, "refuse"), "")
	} else {
		os.Remove(filepath.Join(f.fake, "refuse"))
	}
}

func (f *machinesFixture) args() string {
	b, _ := os.ReadFile(filepath.Join(f.fake, "args"))
	return string(b)
}

func (f *machinesFixture) request(s *Server, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Host = "127.0.0.1:7780"
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}

func (f *machinesFixture) audited(events ...string) {
	f.t.Helper()
	for _, want := range events {
		if !strings.Contains(f.audit.String(), want) {
			f.t.Fatalf("audit lacks %s: %s", want, f.audit.String())
		}
	}
}

// Machines are added and removed through herdr's own commands; the core
// follows herdr's catalog. Targets that would read as options, the local
// machine, --ssh machines and read-only browsers are refused.
func TestMachineAddAndRemove(t *testing.T) {
	f := newMachinesFixture(t, gpu)
	f.after("add", gpu, newM)
	f.after("remove", gpu)
	srv := httptest.NewServer(f.srv.Handler())
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	for _, c := range []struct {
		readOnly     bool
		method, path string
		code         int
		body         string
	}{
		{false, "GET", "/api/machines/add?target=-oProxyCommand=x", 400, "invalid"},
		{false, "GET", "/api/machines/add?target=a%20b", 400, "invalid"},
		{false, "GET", "/api/machines/add?target=gpu&session=-x", 400, "invalid"},
		{false, "GET", "/api/machines/add?target=gpu&label=a%0Ab", 400, "invalid"},
		{false, "GET", "/api/machines/add?target=", 400, "invalid"},
		{true, "GET", "/api/machines/add?target=gpu", 403, "read-only"},
		{false, "DELETE", "/api/m/local", 400, "not_saved"},
		{false, "DELETE", "/api/m/extra", 400, "not_saved"},
		{false, "DELETE", "/api/m/nope", 404, "unknown"},
		{true, "DELETE", "/api/m/" + gpuID, 403, "read-only"},
	} {
		if w := f.request(f.server(c.readOnly), c.method, c.path, ""); w.Code != c.code || !strings.Contains(w.Body.String(), c.body) {
			t.Errorf("%s %s read-only=%v: %d %s", c.method, c.path, c.readOnly, w.Code, w.Body)
		}
	}

	// Adding: herdr's terminal, then the new machine joins, also when the
	// core's selection (--local-only) would leave it out of a reload.
	f.selected = func(machines.Spec) bool { return false }
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/machines/add?target=user@new-host&label=New%20host&session=work&cols=80&rows=24", nil)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) != websocket.StatusNormalClosure {
				t.Fatalf("%v after %q", err, out.String())
			}
			if reason := closeReason(err); reason != "added "+newID {
				t.Fatalf("close reason %q", reason)
			}
			break
		}
		out.Write(data)
	}
	if !strings.Contains(out.String(), "saving") {
		t.Fatalf("terminal output %q", out.String())
	}
	if args := f.args(); args != "machine\nadd\n--label=New host\n--remote-session=work\nuser@new-host\n" {
		t.Fatalf("herdr args %q", args)
	}
	if mc := f.mg.Get(newID); mc == nil || !mc.State().Saved {
		t.Fatal("the new machine was not added")
	}
	if n := len(f.mg.States()); n != 4 {
		t.Fatalf("%d machines", n)
	}

	// Removing: herdr refuses, then removes it.
	f.refuse(true)
	if w := f.request(f.srv, "DELETE", "/api/m/"+newID, ""); w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "herdr refused remove") || f.mg.Get(newID) == nil {
		t.Fatalf("refused removal: %d %s", w.Code, w.Body)
	}
	f.refuse(false)
	if w := f.request(f.srv, "DELETE", "/api/m/"+newID, ""); w.Code != http.StatusOK || f.mg.Get(newID) != nil {
		t.Fatalf("removal: %d %s", w.Code, w.Body)
	}
	if args := f.args(); args != "machine\nremove\n"+newID+"\n" {
		t.Fatalf("herdr args %q", args)
	}
	if w := f.request(f.srv, "DELETE", "/api/m/"+newID, ""); w.Code != http.StatusNotFound {
		t.Fatalf("second removal: %d %s", w.Code, w.Body)
	}
	f.audited(`"machine.add"`, `"machine.added"`, `"machine.remove"`, `"target":"user@new-host"`)
}

// Renaming goes through herdr's rename; a label another saved machine has
// is refused (herdr's --machine selects by label), as are empty labels,
// machines that are not herdr's and read-only browsers.
func TestMachineRename(t *testing.T) {
	f := newMachinesFixture(t, gpu, newM)
	for _, c := range []struct {
		readOnly   bool
		path, body string
		code       int
		want       string
	}{
		{false, "/api/m/" + gpuID + "/label", `{"label":"  "}`, 400, "invalid"},
		{false, "/api/m/" + gpuID + "/label", `{"label":"a\u0007b"}`, 400, "invalid"},
		{false, "/api/m/" + gpuID + "/label", `{}`, 400, "invalid"},
		{false, "/api/m/" + gpuID + "/label", `{"label":"new"}`, 409, "label_taken"},
		{false, "/api/m/local/label", `{"label":"x"}`, 400, "not_saved"},
		{false, "/api/m/extra/label", `{"label":"x"}`, 400, "not_saved"},
		{true, "/api/m/" + gpuID + "/label", `{"label":"x"}`, 403, "read-only"},
	} {
		if w := f.request(f.server(c.readOnly), "PUT", c.path, c.body); w.Code != c.code || !strings.Contains(w.Body.String(), c.want) {
			t.Errorf("%s %s read-only=%v: %d %s", c.path, c.body, c.readOnly, w.Code, w.Body)
		}
	}
	if f.args() != "" {
		t.Fatalf("herdr ran: %q", f.args())
	}

	f.refuse(true)
	if w := f.request(f.srv, "PUT", "/api/m/"+gpuID+"/label", `{"label":"GPU box"}`); w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "herdr refused rename") {
		t.Fatalf("refused: %d %s", w.Code, w.Body)
	}
	f.refuse(false)
	f.after("rename", entry{gpuID, "-GPU box", true}, newM)
	w := f.request(f.srv, "PUT", "/api/m/"+gpuID+"/label", `{"label":" -GPU box "}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"label":"-GPU box"`) {
		t.Fatalf("rename: %d %s", w.Code, w.Body)
	}
	// The label is herdr's argument after --label, even when it starts with "-".
	if args := f.args(); args != "machine\nrename\n"+gpuID+"\n--label\n-GPU box\n" {
		t.Fatalf("herdr args %q", args)
	}
	if l := f.mg.Get(gpuID).Label(); l != "-GPU box" {
		t.Fatalf("label %q", l)
	}
	// herdr succeeding without the new label in its catalog is a failure.
	f.after("rename", entry{gpuID, "-GPU box", true}, newM)
	if w := f.request(f.srv, "PUT", "/api/m/"+gpuID+"/label", `{"label":"other"}`); w.Code != http.StatusBadGateway {
		t.Fatalf("unchanged catalog: %d %s", w.Code, w.Body)
	}
	f.audited(`"machine.rename"`, `"from":"gpu"`)
}

// Reloading follows changes made with herdr's own commands: new machines
// the core's selection takes are added, removed ones dropped, renamed and
// enabled or disabled ones updated. A catalog that cannot be read changes
// nothing.
func TestMachinesRefresh(t *testing.T) {
	f := newMachinesFixture(t, gpu, newM)
	if w := f.request(f.server(true), "POST", "/api/machines/refresh", ""); w.Code != http.StatusForbidden {
		t.Fatalf("read-only: %d", w.Code)
	}
	if w := f.request(f.srv, "POST", "/api/machines/refresh", ""); w.Code != http.StatusOK || w.Body.String() != `{"added":null,"removed":null,"updated":null}`+"\n" {
		t.Fatalf("unchanged: %d %s", w.Code, w.Body)
	}

	// herdr machine rename, disable, remove and add in a terminal.
	f.write(f.cat, catalogJSON(entry{gpuID, "gpu box", false}, fromUI))
	f.selected = func(sp machines.Spec) bool { return sp.ID != cliID }
	w := f.request(f.srv, "POST", "/api/machines/refresh", "")
	if want := `{"added":null,"removed":["` + newID + `"],"updated":["` + gpuID + `"]}` + "\n"; w.Code != http.StatusOK || w.Body.String() != want {
		t.Fatalf("selection leaves the new machine out: %d %s", w.Code, w.Body)
	}
	if st := f.mg.Get(gpuID).State(); st.Label != "gpu box" || st.Status != machines.StatusDisabled {
		t.Fatalf("gpu = %s %s", st.Label, st.Status)
	}
	f.selected = nil
	if w := f.request(f.srv, "POST", "/api/machines/refresh", ""); !strings.Contains(w.Body.String(), `"added":["`+cliID+`"]`) {
		t.Fatalf("added: %d %s", w.Code, w.Body)
	}
	// The local machine and --ssh machines are not herdr's to drop.
	if f.mg.Get("local") == nil || f.mg.Get("extra") == nil || len(f.mg.States()) != 4 {
		t.Fatalf("states %+v", f.mg.States())
	}

	f.write(f.cat, "{")
	if w := f.request(f.srv, "POST", "/api/machines/refresh", ""); w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "catalog") {
		t.Fatalf("broken catalog: %d %s", w.Code, w.Body)
	}
	if len(f.mg.States()) != 4 {
		t.Fatal("a broken catalog removed machines")
	}
	f.audited(`"machine.refresh"`, `"removed":["`+newID+`"]`)
}

func closeReason(err error) string {
	var ce websocket.CloseError
	if errors.As(err, &ce) {
		return ce.Reason
	}
	return ""
}
