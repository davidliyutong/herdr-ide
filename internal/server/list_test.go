//go:build unix

package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// /list through a real agent: a directory of more names than a reply line
// holds (an archive just unpacked) is listed in full, its entries after
// the line; an empty one has an empty list.
func TestListLargeAndEmptyDirectories(t *testing.T) {
	mg, _, logger := agentMachine(t)
	srv := httptest.NewServer(New(mg, Options{Logger: logger}).Handler())
	defer srv.Close()
	dir := t.TempDir()
	big := filepath.Join(dir, "big")
	os.MkdirAll(big, 0o755)
	os.MkdirAll(filepath.Join(dir, "empty"), 0o755)
	const n = 15000
	for i := 0; i < n; i++ {
		if err := os.WriteFile(filepath.Join(big, fmt.Sprintf("extracted-file-with-a-long-name-%06d.txt", i)), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	list := func(p string) (int, map[string]json.RawMessage) {
		t.Helper()
		res, err := http.Get(srv.URL + "/api/m/x/list?" + url.Values{"path": {p}}.Encode())
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var body map[string]json.RawMessage
		json.NewDecoder(res.Body).Decode(&body)
		return res.StatusCode, body
	}
	status, body := list(big)
	var entries []struct {
		Name string `json:"name"`
	}
	json.Unmarshal(body["entries"], &entries)
	if status != 200 || len(entries) != n || entries[0].Name != "extracted-file-with-a-long-name-000000.txt" {
		t.Fatalf("large directory: %d, %d entries, %s", status, len(entries), body["error"])
	}
	if status, body := list(filepath.Join(dir, "empty")); status != 200 || string(body["entries"]) != "[]" {
		t.Fatalf("empty directory: %d %s", status, body["entries"])
	}
	// A small listing still comes in the line.
	if status, body := list(dir); status != 200 || len(body["entries"]) < 10 {
		t.Fatalf("small directory: %d %s", status, body["entries"])
	}
}
