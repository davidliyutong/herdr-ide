package files

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"herdr-ide/internal/plugin"
)

func TestRoutes(t *testing.T) {
	seen := map[string]bool{}
	for _, rt := range New().Routes() {
		if !rt.Machine {
			t.Errorf("%s is not a machine's route", rt.Path)
		}
		// Everything but the stat (a POST for the length of its paths)
		// changes files: guarded and audited.
		if rt.Path == "stat" {
			if rt.Mutating || rt.Method != http.MethodPost {
				t.Errorf("%s %s: mutating %v", rt.Method, rt.Path, rt.Mutating)
			}
		} else if rt.Method != http.MethodPost || !rt.Mutating || rt.Audit != rt.Path {
			t.Errorf("%s %s: mutating %v, audit %q", rt.Method, rt.Path, rt.Mutating, rt.Audit)
		}
		seen[rt.Path] = true
	}
	for _, p := range []string{"stat", "mkdir", "mkdirs", "create", "rename", "move", "copy", "trash", "remove", "write", "upload"} {
		if !seen[p] {
			t.Errorf("no route %s", p)
		}
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
