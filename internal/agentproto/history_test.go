package agentproto

import (
	"encoding/json"
	"strings"
	"testing"
)

// An entry's restored flag is on the wire only when it is set, beside the
// current generation's fields.
func TestHistoryEntryJSON(t *testing.T) {
	b, _ := json.Marshal(HistoryEntry{Terminal: "t1", HistorySnapshot: HistorySnapshot{PID: 7, At: 1}})
	if strings.Contains(string(b), "restored") {
		t.Fatalf("restored without being set: %s", b)
	}
	b, _ = json.Marshal(HistoryEntry{Terminal: "t1", HistorySnapshot: HistorySnapshot{PID: 7, At: 1}, Restored: true})
	var back map[string]any
	if json.Unmarshal(b, &back) != nil || back["restored"] != true || back["pid"] != float64(7) {
		t.Fatalf("entry %s", b)
	}
}

// A terminal's address is the web UI's (isAddress in
// web/src/term/layout.ts): a letter or digit, then up to 63 letters,
// digits, dashes and underscores; never a dot.
func TestValidHistoryTerminal(t *testing.T) {
	for s, ok := range map[string]bool{
		"t1": true, "T": true, "7": true, "t-1_x": true, "a_": true, strings.Repeat("a", 64): true,
		"": false, "-a": false, "_a": false, ".a": false, "a.b": false, "t1.prev": false, "..": false,
		"a/b": false, "a b": false, "a\n": false, "\x00": false, "é": false, strings.Repeat("a", 65): false,
	} {
		if ValidHistoryTerminal(s) != ok {
			t.Errorf("%q: %v, want %v", s, !ok, ok)
		}
	}
}

// An adopt names two terminals, not the same one; its members are from and
// to, its result's adopted.
func TestHistoryAdopt(t *testing.T) {
	for _, c := range []struct {
		p  HistoryAdoptParams
		ok bool
	}{
		{HistoryAdoptParams{From: "t1", To: "t2"}, true},
		{HistoryAdoptParams{From: "t1", To: "t1"}, false},
		{HistoryAdoptParams{From: "", To: "t2"}, false},
		{HistoryAdoptParams{From: "t1", To: ""}, false},
		{HistoryAdoptParams{From: "../t1", To: "t2"}, false},
		{HistoryAdoptParams{From: "t1", To: "t2.prev"}, false},
	} {
		if ValidHistoryAdopt(c.p) != c.ok {
			t.Errorf("%+v: %v", c.p, !c.ok)
		}
	}
	b, _ := json.Marshal(HistoryAdoptParams{From: "a", To: "b"})
	r, _ := json.Marshal(HistoryAdoptResult{})
	if string(b) != `{"from":"a","to":"b"}` || string(r) != `{"adopted":false}` {
		t.Fatalf("%s %s", b, r)
	}
}
