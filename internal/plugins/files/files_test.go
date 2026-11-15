package files

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRoutes(t *testing.T) {
	seen := map[string]bool{}
	for _, rt := range New().Routes() {
		if !rt.Machine {
			t.Errorf("%s is not a machine's route", rt.Path)
		}
		// Everything but the stat changes files: guarded and audited.
		if rt.Method == http.MethodGet {
			if rt.Mutating || rt.Path != "stat" {
				t.Errorf("GET %s", rt.Path)
			}
		} else if !rt.Mutating || rt.Audit != rt.Path {
			t.Errorf("%s %s: mutating %v, audit %q", rt.Method, rt.Path, rt.Mutating, rt.Audit)
		}
		seen[rt.Path] = true
	}
	for _, p := range []string{"stat", "mkdir", "create", "rename", "move", "copy", "trash", "remove", "write"} {
		if !seen[p] {
			t.Errorf("no route %s", p)
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
