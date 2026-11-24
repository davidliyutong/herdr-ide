package search

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"veldr/internal/machines"
	"veldr/internal/plugin"
)

// One route, a machine's, that reads only: read-only mode searches too.
func TestRoutes(t *testing.T) {
	p := New()
	rts := p.Routes()
	if len(rts) != 1 {
		t.Fatalf("%d routes", len(rts))
	}
	if pat := plugin.Pattern(p.ID(), rts[0]); pat != "POST /api/m/{id}/p/search/search" || rts[0].Mutating || !rts[0].Machine {
		t.Errorf("%s mutating %v", pat, rts[0].Mutating)
	}
}

func TestParams(t *testing.T) {
	long := strings.Repeat("x", MaxQuery+1)
	globs := strings.Repeat("x", MaxGlobs+1)
	for _, body := range []string{
		"", "not json", `{}`,
		`{"dir":"~","query":""}`,
		`{"dir":"","query":"a"}`,
		`{"dir":"~","query":"a\nb"}`,
		`{"dir":"~","query":"` + long + `"}`,
		`{"dir":"~","query":"a","include":"` + globs + `"}`,
		`{"dir":"~","query":"a","maxResults":-1}`,
		`{"dir":"~","query":"a","maxResults":5001}`,
		`{"dir":"~","query":"` + strings.Repeat("x", maxBody) + `"}`,
	} {
		w := httptest.NewRecorder()
		search(&plugin.Call{}, w, httptest.NewRequest("POST", "/search", strings.NewReader(body)))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%.50q: %d", body, w.Code)
		}
	}
	if err := check(Params{Dir: "~", Query: "a", Include: "*.go", MaxResults: 10}); err != nil {
		t.Error(err)
	}
}

// A machine without an agent session answers offline.
func TestOffline(t *testing.T) {
	mg := machines.NewManager([]machines.Spec{{ID: "far", Label: "far", Kind: machines.KindSSH, Target: "far", Enabled: false}}, nil, log.New(io.Discard, "", 0))
	for _, c := range []*plugin.Call{{}, {Machine: mg.Get("far")}} {
		w := httptest.NewRecorder()
		search(c, w, httptest.NewRequest("POST", "/search", strings.NewReader(`{"dir":"~","query":"a"}`)))
		var body map[string]string
		json.Unmarshal(w.Body.Bytes(), &body)
		if w.Code != http.StatusConflict || body["error"] != "offline" {
			t.Errorf("%d %v", w.Code, body)
		}
	}
}
