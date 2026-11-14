//go:build integration

package agent_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/herdr"
	"herdr-ide/internal/transport"
)

// findText has rows that wrap, wide characters that do not fit a row's end,
// grapheme clusters of several code points, and enough lines for a
// scrollback.
func findText() string {
	var b strings.Builder
	for i := range 300 {
		fmt.Fprintf(&b, "line %04d needle alpha Needle beta NEEDLE gamma\n", i)
	}
	b.WriteString("中文测试 needle 在这里 宽字符 Needle 结束\n")
	b.WriteString("emoji 😀 needle ✔ check ⏺ dot 👍🏽 needle é acute needle 🇯🇵 flag needle 👨‍👩‍👧 family needle\n")
	b.WriteString(strings.Repeat("x", 150) + "needle" + strings.Repeat("y", 100) + " needle-end\n")
	b.WriteString(strings.Repeat("中", 70) + "needle" + strings.Repeat("文", 30) + "\n")
	b.WriteString("foo_needle_bar needles needle. (needle) foo-needle\n")
	b.WriteString("error: 42 errors E1234 warning W99 err0r\n")
	b.WriteString("END-OF-FIND-TEST\n")
	return b.String()
}

func paneFind(ctx context.Context, t *testing.T, s *transport.Session, req agentproto.FindRequest) *agentproto.Reply {
	t.Helper()
	conn, rep, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpPaneFind, Session: itSession, Find: &req})
	if conn != nil {
		conn.Close()
	}
	if err != nil && rep == nil {
		t.Fatal(err)
	}
	return rep
}

// herdrSearch is herdr's own literal search over the same pane.
func herdrSearch(ctx context.Context, t *testing.T, api *herdr.Client, pane, query string) []agentproto.TextRange {
	t.Helper()
	for range 20 {
		var motion struct {
			Rev uint64 `json:"content_revision"`
		}
		if err := api.CallInto(ctx, "pane.copy_motion", map[string]any{"pane_id": pane, "cursor": agentproto.TextPoint{}, "motion": "next_word_start"}, &motion); err != nil {
			t.Fatal(err)
		}
		var res struct {
			Matches []agentproto.TextRange `json:"matches"`
		}
		err := api.CallInto(ctx, "pane.copy_search", map[string]any{
			"pane_id": pane, "query": query, "direction": "forward", "cursor": agentproto.TextPoint{}, "content_revision": motion.Rev,
		}, &res)
		var ae *herdr.APIError
		if errors.As(err, &ae) && ae.Code == "stale_content" {
			time.Sleep(50 * time.Millisecond)
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		return res.Matches
	}
	t.Fatal("pane kept changing")
	return nil
}

// The agent's search (panefind) finds the matches herdr's own search finds,
// at the same cells, and the options herdr's search lacks.
func TestIntegrationPaneFind(t *testing.T) {
	s, api := startHerdr(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pane := newPane(ctx, t, api)
	file := filepath.Join(t.TempDir(), "find.txt")
	if err := os.WriteFile(file, []byte(findText()), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := api.Call(ctx, "pane.send_text", map[string]any{"pane_id": pane, "text": "clear; cat " + file + "\n"}); err != nil {
		t.Fatal(err)
	}
	for i := 0; ; i++ {
		var read struct {
			Read struct {
				Text string `json:"text"`
			} `json:"read"`
		}
		if err := api.CallInto(ctx, "pane.read", map[string]any{"pane_id": pane, "source": "visible"}, &read); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(read.Read.Text, "END-OF-FIND-TEST\n") {
			break
		}
		if i > 100 {
			t.Fatalf("output did not arrive: %q", read.Read.Text)
		}
		time.Sleep(100 * time.Millisecond)
	}

	want := herdrSearch(ctx, t, api, pane, "needle")
	for _, cols := range []int{0, 7, 1000} { // found, a wrong hint, a wrong hint
		rep := paneFind(ctx, t, s, agentproto.FindRequest{Pane: pane, Query: "needle", Cols: cols})
		if !rep.OK || rep.Find == nil {
			t.Fatalf("cols %d: %+v", cols, rep)
		}
		got := rep.Find
		if got.Total != len(want) || len(got.Matches) != len(want) {
			t.Fatalf("cols %d: %d matches (%d shown), herdr finds %d", cols, got.Total, len(got.Matches), len(want))
		}
		for i := range want {
			if got.Matches[i] != want[i] {
				t.Errorf("cols %d: match %d at %+v, herdr has %+v", cols, i, got.Matches[i], want[i])
			}
		}
		if got.Current == nil || *got.Current != 0 {
			t.Errorf("cols %d: current %v, want the first match", cols, got.Current)
		}
	}

	count := func(req agentproto.FindRequest) int {
		t.Helper()
		req.Pane = pane
		rep := paneFind(ctx, t, s, req)
		if !rep.OK || rep.Find == nil {
			t.Fatalf("%+v: %+v", req, rep)
		}
		return rep.Find.Total
	}
	// 300 lines with one of each casing, and the Chinese line.
	if n := count(agentproto.FindRequest{Query: "Needle", MatchCase: true}); n != 301 {
		t.Errorf("match case: %d", n)
	}
	if n := count(agentproto.FindRequest{Query: `E\d+`, Regex: true, MatchCase: true}); n != 1 {
		t.Errorf("regex: %d", n)
	}
	// xneedley, 中needle文, foo_needle_bar and needles are not the word;
	// needle. (needle) foo-needle needle-end are.
	whole := count(agentproto.FindRequest{Query: "needle", WholeWord: true})
	if all := count(agentproto.FindRequest{Query: "needle"}); all-whole != 4 {
		t.Errorf("whole word: %d of %d", whole, all)
	}
	rep := paneFind(ctx, t, s, agentproto.FindRequest{Pane: pane, Query: "(", Regex: true})
	if rep.OK || rep.Code != agentproto.FindInvalidRegex {
		t.Errorf("invalid regex: %+v", rep)
	}
	rep = paneFind(ctx, t, s, agentproto.FindRequest{Pane: "w999:p1", Query: "x"})
	if rep.OK || rep.Code != "pane_not_found" {
		t.Errorf("unknown pane: %+v", rep)
	}
}
