package monitor

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"veldr/internal/plugin"
)

func TestRoutesShape(t *testing.T) {
	p := New()
	if p.ID() != "monitor" {
		t.Fatalf("ID = %q", p.ID())
	}
	rts := p.Routes()
	if len(rts) != 3 {
		t.Fatalf("got %d routes, want 3", len(rts))
	}
	want := map[string]bool{
		"GET /api/m/{id}/p/monitor/metrics":   false,
		"GET /api/m/{id}/p/monitor/processes": false,
		"POST /api/m/{id}/p/monitor/signal":   true,
	}
	for _, rt := range rts {
		pat := plugin.Pattern(p.ID(), rt)
		mut, ok := want[pat]
		if !ok {
			t.Errorf("unexpected route %s", pat)
			continue
		}
		if rt.Mutating != mut {
			t.Errorf("route %s Mutating=%v, want %v", pat, rt.Mutating, mut)
		}
		if mut && rt.Audit == "" {
			t.Errorf("mutating route %s has empty Audit", pat)
		}
	}
}

func TestHandleSignalRejectsInvalidPID(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/m/local/p/monitor/signal", strings.NewReader(`{"pid":1,"signal":"term"}`))
	rec := httptest.NewRecorder()
	call := &plugin.Call{}
	handleSignal(call, rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"invalid_pid"`) {
		t.Fatalf("body = %s, want invalid_pid", rec.Body.String())
	}
	af := call.AuditFields()
	if af["pid"] != 1 || af["signal"] != "TERM" {
		t.Fatalf("audit fields = %+v", af)
	}
}
