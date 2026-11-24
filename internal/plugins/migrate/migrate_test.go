package migrate

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
)

// Reads are a machine's and answered read-only; what changes the
// previous namespace is mutating and audited.
func TestRoutes(t *testing.T) {
	var got []string
	for _, rt := range New().Routes() {
		mutating := rt.Method == http.MethodPost
		if !rt.Machine || rt.Mutating != mutating || mutating != (rt.Audit != "") {
			t.Errorf("route %+v", rt)
		}
		got = append(got, plugin.Pattern(ID, rt))
	}
	want := []string{
		"GET /api/m/{id}/p/migrate/status",
		"GET /api/m/{id}/p/migrate/scan",
		"POST /api/m/{id}/p/migrate/release",
		"POST /api/m/{id}/p/migrate/stop",
		"POST /api/m/{id}/p/migrate/remove",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("routes %v", got)
	}
}

func machine(t *testing.T) *machines.Machine {
	mg := machines.NewManager([]machines.Spec{{ID: "box", Kind: machines.KindSSH, Target: "box"}}, nil, log.New(io.Discard, "", 0))
	return mg.Get("box")
}

func post(p *Plugin, mc *machines.Machine, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/m/box/p/migrate/release", strings.NewReader(body))
	p.postRelease(&plugin.Call{Machine: mc}, w, r)
	return w
}

// A release passes the layout and addresses on; a machine's conflict is
// 409; a release without a layout never reaches the machine.
func TestRelease(t *testing.T) {
	p := New()
	var got agentproto.MigrateRelease
	conflict := false
	p.call = func(_ context.Context, _ *machines.Machine, action string, params, _ any) error {
		if action != agentproto.MigrateActionRelease {
			t.Errorf("action %q", action)
		}
		got = params.(agentproto.MigrateRelease)
		if conflict {
			return &plugin.Error{Code: "conflict", Message: "changed"}
		}
		return nil
	}
	mc := machine(t)
	if w := post(p, mc, `{"layout":{"version":2},"version":4,"terminals":["t1"]}`); w.Code != 200 || got.Version != 4 || !reflect.DeepEqual(got.Terminals, []string{"t1"}) {
		t.Fatalf("release %d %+v", w.Code, got)
	}
	var v map[string]any
	if json.Unmarshal(got.Layout, &v) != nil || v["version"] != float64(2) {
		t.Errorf("layout %s", got.Layout)
	}
	conflict = true
	if w := post(p, mc, `{"layout":{},"version":4,"terminals":[]}`); w.Code != http.StatusConflict {
		t.Errorf("conflict: %d", w.Code)
	}
	got = agentproto.MigrateRelease{}
	if w := post(p, mc, `{"version":4}`); w.Code != http.StatusBadRequest || got.Version != 0 {
		t.Errorf("without a layout: %d", w.Code)
	}
}
