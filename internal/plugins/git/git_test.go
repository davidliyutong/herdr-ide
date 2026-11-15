package git

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

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
