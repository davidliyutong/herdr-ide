package git

import (
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"veldr/internal/machines"
	"veldr/internal/plugin"
	"veldr/internal/settings"
)

// auditHost records what the plugin audits.
type auditHost struct{ events []string }

func (h *auditHost) Machines() *machines.Manager   { return nil }
func (h *auditHost) Broadcast(string, string, any) {}
func (h *auditHost) Audit(r *http.Request, event string, fields map[string]any) {
	b, _ := json.Marshal(fields)
	h.events = append(h.events, event+" "+string(b))
}
func (h *auditHost) ReadOnly() bool            { return false }
func (h *auditHost) Settings() *settings.Store { return nil }
func (h *auditHost) Logger() *log.Logger       { return log.New(log.Writer(), "", 0) }

// A change's audit record names what it acted on and how it ended, never
// its patch or message, and paths only by their number.
func TestChangeAudit(t *testing.T) {
	h := &auditHost{}
	body := `{"repo":"/home/u/r","name":"topic","remote":"origin","force":true,"forceWithLease":true,"amend":true,"all":false,` +
		`"mode":"hard","rev":"abc123","hash":"def456","paths":["a","b"],"untracked":["c"],"message":"SECRET-MESSAGE","patch":"SECRET-PATCH"}`
	r := httptest.NewRequest("POST", "/api/m/x/p/git/commit", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	change("commit")(&plugin.Call{Host: h}, w, r)
	if w.Code != http.StatusConflict {
		t.Errorf("status %d", w.Code)
	}
	if len(h.events) != 1 {
		t.Fatalf("events %v", h.events)
	}
	ev := h.events[0]
	for _, want := range []string{"git.commit.done ", `"repo":"/home/u/r"`, `"name":"topic"`, `"remote":"origin"`, `"force":true`,
		`"forceWithLease":true`, `"amend":true`, `"mode":"hard"`, `"rev":"abc123"`, `"hash":"def456"`, `"paths":3`, `"ok":false`, `"code":"offline"`} {
		if !strings.Contains(ev, want) {
			t.Errorf("%s missing: %s", want, ev)
		}
	}
	for _, bad := range []string{"SECRET", `"all"`, `"a"`} {
		if strings.Contains(ev, bad) {
			t.Errorf("%s recorded: %s", bad, ev)
		}
	}
}

func TestRoutes(t *testing.T) {
	reads := map[string]bool{}
	for _, a := range Reads {
		reads[a] = true
	}
	seen := map[string]bool{}
	for _, rt := range New().Routes() {
		if !rt.Machine {
			t.Errorf("%s is not a machine's route", rt.Path)
		}
		// Reads are GETs; every change is guarded and audited.
		if reads[rt.Path] {
			if rt.Method != http.MethodGet || rt.Mutating {
				t.Errorf("read %s %s mutating %v", rt.Method, rt.Path, rt.Mutating)
			}
		} else if rt.Method != http.MethodPost || !rt.Mutating || rt.Audit != rt.Path {
			t.Errorf("%s %s: mutating %v, audit %q", rt.Method, rt.Path, rt.Mutating, rt.Audit)
		}
		if seen[rt.Path] {
			t.Errorf("%s twice", rt.Path)
		}
		seen[rt.Path] = true
	}
	if len(seen) != len(Reads)+len(Writes) {
		t.Errorf("%d routes", len(seen))
	}
}

func TestQueryParams(t *testing.T) {
	r := httptest.NewRequest("GET", "/x?repo=/r&skip=300&limit=10&branch=main&branch=dev&remotes=1&rev=abc&parent=2&other=x", nil)
	p, err := queryParams(r)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"repo": "/r", "skip": 300, "limit": 10, "branches": []string{"main", "dev"}, "remotes": true, "rev": "abc", "parent": 2}
	if !reflect.DeepEqual(p, want) {
		t.Errorf("%v", p)
	}
	if _, err := queryParams(httptest.NewRequest("GET", "/x?skip=a", nil)); err == nil {
		t.Error("bad skip accepted")
	}
}

// The plugin's settings: their defaults (what the UI does without them),
// and values out of their range refused.
func TestSettings(t *testing.T) {
	st := settings.New("", Settings)
	for k, want := range map[string]any{
		SettingMixedLineEndings: "keep",
		SettingChangesView:      "list",
		SettingUntrackedChanges: "mixed",
		SettingAutoFetch:        0.0,
		SettingConfirmSync:      false,
		SettingGraphPageSize:    300.0,
	} {
		if got := st.Get(k); got != want {
			t.Errorf("%s = %v, want %v", k, got, want)
		}
	}
	for k, bad := range map[string]any{
		SettingMixedLineEndings: "lf",
		SettingAutoFetch:        -1.0,
		SettingGraphPageSize:    10.0,
	} {
		if err := st.Set(k, "", bad); err == nil {
			t.Errorf("%s = %v accepted", k, bad)
		}
	}
	if err := st.Set(SettingGraphPageSize, "", 500.0); err != nil {
		t.Errorf("page size 500: %v", err)
	}
}
