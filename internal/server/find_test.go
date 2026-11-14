package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Searching only reads, so read-only pages may; the agent's error codes
// come back as codes. (The search itself: internal/panefind and
// TestIntegrationPaneFind.)
func TestFind(t *testing.T) {
	mg, _, logger := agentMachine(t)
	srv := httptest.NewServer(New(mg, Options{Logger: logger, ReadOnly: true}).Handler())
	defer srv.Close()
	post := func(body string) (int, map[string]string) {
		t.Helper()
		res, err := http.Post(srv.URL+"/api/m/x/find", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]string
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	if code, out := post(`{"pane":"w1:p1","query":"(","regex":true}`); code != 400 || out["error"] != "invalid_regex" || out["detail"] == "" {
		t.Errorf("invalid regex: %d %v", code, out)
	}
	if code, out := post(`{"pane":"w1:p1","query":""}`); code != 400 || out["error"] != "invalid" {
		t.Errorf("empty query: %d %v", code, out)
	}
	if code, out := post(`{"pane":"w1:p1","query":"` + strings.Repeat("a", 5000) + `"}`); code != 400 || out["error"] != "query_too_large" {
		t.Errorf("long query: %d %v", code, out)
	}
	// No herdr runs in this machine's session.
	if code, out := post(`{"pane":"w1:p1","query":"needle"}`); code != http.StatusBadGateway || out["error"] != "transport" {
		t.Errorf("no herdr: %d %v", code, out)
	}
	if code, _ := post(`{"pane":"w1:p1","query":"x"`); code != 400 {
		t.Errorf("bad body: %d", code)
	}
}
