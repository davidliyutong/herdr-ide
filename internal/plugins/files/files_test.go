package files

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"veldr/internal/machines"
	"veldr/internal/plugin"
)

func TestRoutes(t *testing.T) {
	seen := map[string]bool{}
	for _, rt := range New().Routes() {
		if !rt.Machine {
			t.Errorf("%s is not a machine's route", rt.Path)
		}
		// Everything but the stat (a POST for the length of its paths) and
		// asking whether Reveal in Finder is offered changes files or runs a
		// program: guarded and audited.
		if rt.Path == "stat" || rt.Method == http.MethodGet {
			if rt.Mutating || (rt.Path == "stat") != (rt.Method == http.MethodPost) {
				t.Errorf("%s %s: mutating %v", rt.Method, rt.Path, rt.Mutating)
			}
		} else if rt.Method != http.MethodPost || !rt.Mutating || rt.Audit != rt.Path {
			t.Errorf("%s %s: mutating %v, audit %q", rt.Method, rt.Path, rt.Mutating, rt.Audit)
		}
		seen[rt.Method+" "+rt.Path] = true
	}
	for _, p := range []string{"stat", "mkdir", "mkdirs", "create", "rename", "move", "copy", "trash", "remove", "write", "upload", "reveal"} {
		if !seen["POST "+p] {
			t.Errorf("no route %s", p)
		}
	}
	if !seen["GET reveal"] {
		t.Error("no route GET reveal")
	}
}

// Reveal in Finder only for the core's own machine and a client on the
// core's host: anything else is refused before the machine is asked.
func TestRevealGate(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	mg := machines.NewManager([]machines.Spec{
		{ID: "far", Label: "far", Kind: machines.KindSSH, Target: "far", Enabled: false},
		{ID: "here", Label: "here", Kind: machines.KindLocal, Enabled: false},
	}, nil, logger)
	run := func(m string, sameHost bool) (int, string, bool) {
		c := &plugin.Call{Machine: mg.Get(m), SameHost: sameHost}
		w := httptest.NewRecorder()
		reveal(c, w, httptest.NewRequest("POST", "/reveal", strings.NewReader(`{"path":"/tmp"}`)))
		var body map[string]string
		json.Unmarshal(w.Body.Bytes(), &body)
		a := httptest.NewRecorder()
		revealAvailable(c, a, httptest.NewRequest("GET", "/reveal", nil))
		var avail map[string]bool
		json.Unmarshal(a.Body.Bytes(), &avail)
		if c.AuditFields()["path"] != "/tmp" {
			t.Errorf("%s: audit %v", m, c.AuditFields())
		}
		return w.Code, body["error"], avail["available"]
	}
	if code, e, ok := run("far", true); code != 400 || e != "remote_machine" || ok {
		t.Errorf("remote machine: %d %s %v", code, e, ok)
	}
	if code, e, ok := run("here", false); code != 403 || e != "local_only" || ok {
		t.Errorf("another computer's browser: %d %s %v", code, e, ok)
	}
	// Past the gate, the local machine's agent is asked (here not connected).
	code, e, ok := run("here", true)
	if supported := runtime.GOOS == "darwin" || runtime.GOOS == "linux"; supported && (code != http.StatusConflict || e != "offline" || !ok) ||
		!supported && (e != "reveal_unavailable" || ok) {
		t.Errorf("the core's host: %d %s %v", code, e, ok)
	}
}

// The stat's paths are a JSON body: 1 to MaxStat of them.
func TestStatParams(t *testing.T) {
	many, _ := json.Marshal(map[string][]string{"paths": make([]string, MaxStat+1)})
	for _, body := range []string{"", "{}", `{"paths": []}`, "not json", string(many)} {
		w := httptest.NewRecorder()
		stat(&plugin.Call{}, w, httptest.NewRequest("POST", "/stat", strings.NewReader(body)))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%.40q: %d", body, w.Code)
		}
	}
}

func TestWriteParams(t *testing.T) {
	req := func(q string) *http.Request { return httptest.NewRequest("POST", "/w?"+q, nil) }
	p, err := writeParams(req("path=/a&mtime=12&size=3"))
	if err != nil || p.Force || p.Expect == nil || p.Expect.MTime != 12 || p.Expect.Size != 3 || !p.Expect.Exists {
		t.Fatalf("expect: %+v %v", p, err)
	}
	if p, err := writeParams(req("path=/a&new=1")); err != nil || p.Expect != nil || p.Force {
		t.Fatalf("new: %+v %v", p, err)
	}
	if p, err := writeParams(req("path=/a&force=1")); err != nil || !p.Force {
		t.Fatalf("force: %+v %v", p, err)
	}
	for _, q := range []string{"mtime=1&size=1", "path=/a", "path=/a&mtime=x&size=1"} {
		if _, err := writeParams(req(q)); err == nil {
			t.Errorf("%s: accepted", q)
		}
	}
}

func TestUploadParams(t *testing.T) {
	req := func(q string) *http.Request { return httptest.NewRequest("POST", "/u?"+q, nil) }
	if p, err := uploadParams(req("path=/a/b.txt")); err != nil || p.Path != "/a/b.txt" || p.Replace {
		t.Fatalf("free name: %+v %v", p, err)
	}
	if p, err := uploadParams(req("path=/a/b.txt&replace=1")); err != nil || !p.Replace {
		t.Fatalf("replace: %+v %v", p, err)
	}
	if _, err := uploadParams(req("replace=1")); err == nil {
		t.Fatal("no path accepted")
	}
	// Over the limit: refused before anything reaches the machine.
	r := httptest.NewRequest("POST", "/u?path=/a", strings.NewReader("x"))
	r.ContentLength = MaxUpload + 1
	w := httptest.NewRecorder()
	upload(&plugin.Call{}, w, r)
	if w.Code != http.StatusRequestEntityTooLarge || !strings.Contains(w.Body.String(), "too_large") {
		t.Fatalf("too large: %d %s", w.Code, w.Body)
	}
}
