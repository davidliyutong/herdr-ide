package server

import (
	"context"
	"encoding/json"
	"flag"
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

	"herdr-ide/internal/keybindings"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/settings"
)

func testSettings(t *testing.T) *settings.Store {
	t.Helper()
	st := settings.New(filepath.Join(t.TempDir(), "settings.json"), settings.Module{
		Sections: []settings.Section{{ID: "s"}},
		Defs: []settings.Def{
			{Key: "s.mode", Type: settings.TypeEnum, Default: "a", Enum: []string{"a", "b"}, Section: "s"},
			{Key: "s.size", Type: settings.TypeNumber, Default: 13, Section: "s"},
			{Key: "s.locked", Type: settings.TypeString, Default: "", Section: "s", Flag: "locked"},
			{Key: "s.gui", Type: settings.TypeBool, Default: true, Scope: settings.ScopeRemoteMachine, Section: "s"},
		},
	})
	fs := flag.NewFlagSet("x", flag.ContinueOnError)
	st.RegisterFlags(fs)
	fs.Parse([]string{"--locked", "x"})
	if err := st.Load(); err != nil {
		t.Fatal(err)
	}
	return st
}

type settingsFixture struct {
	srv   *Server
	h     http.Handler
	st    *settings.Store
	kb    *keybindings.Store
	audit *strings.Builder
}

func newSettingsFixture(t *testing.T, readOnly bool) *settingsFixture {
	t.Helper()
	mg := machines.NewManager([]machines.Spec{
		{ID: "local", Kind: machines.KindLocal, Enabled: true},
		{ID: "r1", Kind: machines.KindSSH, Target: "r1", Enabled: true},
	}, nil, log.New(io.Discard, "", 0))
	f := &settingsFixture{st: testSettings(t), kb: keybindings.New(filepath.Join(t.TempDir(), "keybindings.json"), keybindings.Commands),
		audit: &strings.Builder{}}
	f.srv = New(mg, Options{Logger: log.New(io.Discard, "", 0), Settings: f.st, Keybindings: f.kb, ReadOnly: readOnly,
		Audit: f.audit, AllowedOrigins: []string{"https://ide.example.com"}})
	f.h = f.srv.Handler()
	return f
}

func (f *settingsFixture) do(method, path, body string, header ...string) (int, string) {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr, r.Host = "127.0.0.1:5555", "127.0.0.1:7780"
	for i := 0; i+1 < len(header); i += 2 {
		r.Header.Set(header[i], header[i+1])
	}
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	return w.Code, w.Body.String()
}

func TestSettingsAPI(t *testing.T) {
	f := newSettingsFixture(t, false)
	code, body := f.do("GET", "/api/settings", "")
	var got struct {
		Sections    []settings.Section
		Definitions []settings.DefJSON
		Values      map[string]settings.Value
		Problems    []settings.Problem
		ReadOnly    bool `json:"read_only"`
		File        string
	}
	if code != 200 || json.Unmarshal([]byte(body), &got) != nil {
		t.Fatalf("GET = %d %s", code, body)
	}
	if len(got.Definitions) != 4 || got.Definitions[1].Type != settings.TypeNumber || got.Values["s.locked"].Source != settings.SourceFlag ||
		!got.Values["s.locked"].Locked || got.Values["s.size"].Value != 13.0 || got.File == "" || got.Problems == nil {
		t.Fatalf("GET = %s", body)
	}
	for _, c := range []struct {
		method, path, body, want string
		status                   int
	}{
		{"PUT", "/api/settings", `{"key":"s.mode","value":"b"}`, `"s.mode":{"value":"b","source":"global"}`, 200},
		{"PUT", "/api/settings", `{"key":"s.size","value":15.5}`, `"value":15.5`, 200},
		{"PUT", "/api/settings", `{"key":"s.size","value":"15"}`, `"error":"invalid"`, 400},
		{"PUT", "/api/settings", `{"key":"s.mode","value":"z"}`, `"error":"invalid"`, 400},
		{"PUT", "/api/settings", `{"key":"s.mode"}`, `"error":"invalid"`, 400},
		{"PUT", "/api/settings", `{"key":"s.locked","value":"y"}`, `"error":"locked"`, 409},
		{"PUT", "/api/settings", `{"key":"nope","value":"y"}`, `"error":"unknown"`, 404},
		{"PUT", "/api/settings", `{"key":"s.mode","value":"a","machine":"r1"}`, `"error":"scope"`, 400},
		{"PUT", "/api/settings", `{"key":"s.gui","value":false,"machine":"no-such-machine"}`, `"error":"unknown"`, 404},
		{"PUT", "/api/settings", `{"key":"s.gui","value":false,"machine":"local"}`, `"error":"scope"`, 400},
		{"PUT", "/api/settings", `{"key":"s.gui","value":false,"machine":"r1"}`, `"machines":{"r1":false}`, 200},
		{"PUT", "/api/settings", `not json`, `"error":"invalid"`, 400},
		{"DELETE", "/api/settings?key=s.gui&machine=r1", ``, `"s.gui":{"value":true,"source":"default"}`, 200},
		{"DELETE", "/api/settings?key=s.mode", ``, `"s.mode":{"value":"a","source":"default"}`, 200},
		{"DELETE", "/api/settings?key=s.locked", ``, `"error":"locked"`, 409},
	} {
		if code, b := f.do(c.method, c.path, c.body); code != c.status || !strings.Contains(b, c.want) {
			t.Errorf("%s %s %s = %d %s", c.method, c.path, c.body, code, b)
		}
	}
	if f.st.Get("s.size") != 15.5 {
		t.Errorf("size = %v", f.st.Get("s.size"))
	}
	if a := f.audit.String(); !strings.Contains(a, `"settings.set"`) || !strings.Contains(a, `"settings.reset"`) {
		t.Errorf("audit = %s", a)
	}
	// The Host/Origin guard applies to writes.
	if code, _ := f.do("PUT", "/api/settings", `{"key":"s.mode","value":"b"}`, "Origin", "https://evil.example"); code != 403 {
		t.Errorf("cross-site PUT = %d", code)
	}
}

func TestSettingsReadOnly(t *testing.T) {
	f := newSettingsFixture(t, true)
	if code, body := f.do("GET", "/api/settings", ""); code != 200 || !strings.Contains(body, `"read_only":true`) {
		t.Errorf("GET = %d %s", code, body)
	}
	for _, c := range [][3]string{
		{"PUT", "/api/settings", `{"key":"s.mode","value":"b"}`},
		{"DELETE", "/api/settings?key=s.mode", ""},
		{"PUT", "/api/keybindings", `[]`},
	} {
		if code, _ := f.do(c[0], c[1], c[2]); code != http.StatusForbidden {
			t.Errorf("%s %s = %d", c[0], c[1], code)
		}
	}
	if f.st.String("s.mode", "") != "a" {
		t.Error("read-only mode changed a setting")
	}
	if _, err := os.Stat(f.kb.Path()); !os.IsNotExist(err) {
		t.Error("read-only mode wrote the keybindings")
	}
}

func TestKeybindingsAPI(t *testing.T) {
	f := newSettingsFixture(t, false)
	code, body := f.do("GET", "/api/keybindings", "")
	var got struct {
		Commands  []keybindings.CommandJSON
		Defaults  map[string][]keybindings.Rule
		Effective map[string][]keybindings.Rule
		Conflicts map[string][]keybindings.Conflict
		User      []json.RawMessage
	}
	if code != 200 || json.Unmarshal([]byte(body), &got) != nil {
		t.Fatalf("GET = %d %s", code, body)
	}
	if len(got.Commands) < 40 || len(got.Defaults["mac"]) == 0 || len(got.Effective["pc-browser"]) == 0 || got.User == nil {
		t.Fatalf("GET = %s", body)
	}
	code, body = f.do("PUT", "/api/keybindings", `[{"key":"ctrl+k t","command":"tab.new"},{"key":"ctrl+b c","command":"-tab.new"}]`)
	if code != 200 || !strings.Contains(body, `{"key":"ctrl+k t","command":"tab.new","when":"terminal"}`) || strings.Contains(body, `"ctrl+b c","command":"tab.new"`) {
		t.Errorf("PUT = %d %s", code, body)
	}
	for _, bad := range []string{`{"key":"ctrl+k"}`, `[{"key":"k","command":"tab.new"}]`, `[1]`, `not json`} {
		if code, body := f.do("PUT", "/api/keybindings", bad); code != 400 || !strings.Contains(body, `"error":"invalid"`) {
			t.Errorf("PUT %s = %d %s", bad, code, body)
		}
	}
	if code, _ := f.do("PUT", "/api/keybindings", `[]`, "Origin", "https://evil.example"); code != 403 {
		t.Errorf("cross-site PUT = %d", code)
	}
	if len(f.kb.State().User) != 2 {
		t.Error("a refused PUT changed the rules")
	}
	if !strings.Contains(f.audit.String(), `"keybindings.set"`) {
		t.Errorf("audit = %s", f.audit.String())
	}
}

// Every change, through the API or the files, reaches the /ws clients with
// the new state.
func TestSettingsPush(t *testing.T) {
	f := newSettingsFixture(t, false)
	srv := httptest.NewServer(f.h)
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?events=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	next := func(kind string) map[string]json.RawMessage {
		t.Helper()
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				t.Fatalf("waiting for %s: %v", kind, err)
			}
			var m map[string]json.RawMessage
			json.Unmarshal(data, &m)
			if string(m["t"]) == `"`+kind+`"` {
				return m
			}
		}
	}
	f.do("PUT", "/api/settings", `{"key":"s.mode","value":"b"}`)
	if m := next("settings"); !strings.Contains(string(m["values"]), `"s.mode":{"value":"b"`) || m["problems"] == nil {
		t.Errorf("push = %v", m)
	}
	os.WriteFile(f.st.Path(), []byte(`{"s.size": 20, "typo": 1}`), 0o600)
	future := time.Now().Add(time.Minute)
	os.Chtimes(f.st.Path(), future, future)
	f.st.Reload()
	if m := next("settings"); !strings.Contains(string(m["values"]), `"s.size":{"value":20`) || !strings.Contains(string(m["problems"]), `"typo"`) {
		t.Errorf("push after an edit = %v", m)
	}
	f.do("PUT", "/api/keybindings", `[{"key":"ctrl+k t","command":"tab.new"}]`)
	if m := next("keybindings"); !strings.Contains(string(m["effective"]), `"ctrl+k t"`) || m["conflicts"] == nil {
		t.Errorf("keybindings push = %v", m)
	}
}
