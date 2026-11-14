package panefind

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/herdr"
)

func mustCompile(t *testing.T, o Options) *Matcher {
	t.Helper()
	m, err := Compile(o)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func pt(row uint32, col uint16) Point { return Point{Row: row, Col: col} }

func rng(r0 uint32, c0 uint16, r1 uint32, c1 uint16) Range {
	return Range{Start: pt(r0, c0), End: pt(r1, c1)}
}

func TestOptions(t *testing.T) {
	text := "Needle needle NEEDLE\nneedles foo_needle needle. (needle) x-needle\nE1234 e99 err"
	for _, c := range []struct {
		o    Options
		want int
	}{
		{Options{Query: "needle"}, 8},
		{Options{Query: "Needle", MatchCase: true}, 1},
		{Options{Query: "needle", MatchCase: true}, 6},
		{Options{Query: "needle", WholeWord: true}, 6},
		{Options{Query: "(needle)", WholeWord: true}, 1},
		{Options{Query: `e\d+`, Regex: true}, 2},
		{Options{Query: `e\d+`, Regex: true, MatchCase: true}, 1},
		{Options{Query: `^needles?`, Regex: true}, 2}, // each line on its own
		{Options{Query: `x*`, Regex: true}, 1},        // empty matches are skipped
		{Options{Query: "e.d", Regex: false}, 0},
		{Options{Query: "le.", Regex: true, WholeWord: true}, 0},
	} {
		res := Search(text, 0, 80, mustCompile(t, c.o), false, Point{})
		if res.Total != c.want {
			t.Errorf("%+v: %d matches, want %d", c.o, res.Total, c.want)
		}
	}
	if _, err := Compile(Options{Query: "(", Regex: true}); !errors.As(err, new(*InvalidError)) {
		t.Errorf("invalid regex: %v", err)
	}
	if _, err := Compile(Options{Query: "(", Regex: false}); err != nil {
		t.Errorf("literal parenthesis: %v", err)
	}
	if _, err := Compile(Options{Query: strings.Repeat("a", MaxQuery+1)}); !errors.Is(err, ErrTooLarge) {
		t.Errorf("long query: %v", err)
	}
}

// Matches land on the cells the terminal put the text in: rows wrap at
// the pane's width, a wide character that does not fit a row's end starts
// the next one, and a grapheme cluster takes one or two cells.
func TestLayout(t *testing.T) {
	for _, c := range []struct {
		name  string
		text  string
		cols  int
		query string
		want  []Range
	}{
		{"ascii", "ab needle", 80, "needle", []Range{rng(0, 3, 0, 8)}},
		{"wrapped", "0123456789needle", 12, "needle", []Range{rng(0, 10, 1, 3)}},
		{"rows after a wrapped line", "0123456789ab\nneedle", 6, "needle", []Range{rng(2, 0, 2, 5)}},
		{"wide", "中文needle", 80, "needle", []Range{rng(0, 4, 0, 9)}},
		{"wide match", "a中文b", 80, "中文", []Range{rng(0, 1, 0, 4)}},
		// 5 columns: 中中 fill 4, the third does not fit and starts row 1.
		{"wide wraps early", "中中中x", 5, "中x", []Range{rng(1, 0, 1, 2)}},
		{"clusters", "👍🏽 é 🇯🇵 x", 80, "x", []Range{rng(0, 8, 0, 8)}},
		{"combining in a match", "café!", 80, "é", []Range{rng(0, 3, 0, 3)}},
		{"empty lines", "\n\nneedle", 80, "needle", []Range{rng(2, 0, 2, 5)}},
		{"exact width", "abcdef\nneedle", 6, "needle", []Range{rng(1, 0, 1, 5)}},
	} {
		res := Search(c.text, 0, c.cols, mustCompile(t, Options{Query: c.query}), false, Point{})
		if fmt.Sprint(res.Matches) != fmt.Sprint(c.want) {
			t.Errorf("%s: %v, want %v", c.name, res.Matches, c.want)
		}
	}
	// Rows count from where the text starts.
	res := Search("x\nneedle", 40, 80, mustCompile(t, Options{Query: "needle"}), false, Point{})
	if res.Matches[0] != rng(41, 0, 41, 5) || res.FirstRow != 40 {
		t.Errorf("first row: %+v", res)
	}
}

// The current match is chosen as herdr's search chooses it: forward, the
// first starting after the origin; backward, the last ending before it;
// wrapping around at either end.
func TestCurrent(t *testing.T) {
	text := "a x\nb x\nc x"
	m := mustCompile(t, Options{Query: "x"})
	cur := func(backward bool, origin Point) int {
		res := Search(text, 0, 80, m, backward, origin)
		if res.Current == nil || res.CurrentGlobal == nil || *res.Current != *res.CurrentGlobal {
			t.Fatalf("current %v %v", res.Current, res.CurrentGlobal)
		}
		return *res.CurrentGlobal
	}
	end := pt(1<<32-1, 0)
	for _, c := range []struct {
		backward bool
		origin   Point
		want     int
	}{
		{true, end, 2},
		{true, pt(2, 2), 1},  // the current match's start
		{true, pt(0, 2), 2},  // wraps to the newest
		{false, pt(0, 2), 1}, // the current match's end
		{false, pt(2, 2), 0}, // wraps to the oldest
		{false, pt(0, 0), 0},
	} {
		if got := cur(c.backward, c.origin); got != c.want {
			t.Errorf("backward %v from %+v: %d, want %d", c.backward, c.origin, got, c.want)
		}
	}
	if res := Search(text, 0, 80, mustCompile(t, Options{Query: "z"}), true, end); res.Total != 0 || res.Current != nil || res.Matches == nil {
		t.Errorf("no match: %+v", res)
	}
}

// Large results: a window of Limit around the current match, counting
// stops at MaxTotal.
func TestWindowAndCap(t *testing.T) {
	text := strings.Repeat("x", 3000)
	res := Search(text, 0, 100, mustCompile(t, Options{Query: "x"}), true, pt(15, 0))
	if res.Total != 3000 || len(res.Matches) != Limit || *res.CurrentGlobal != 1499 || res.Matches[*res.Current] != rng(14, 99, 14, 99) {
		t.Fatalf("window: total %d, %d shown, current %d", res.Total, len(res.Matches), *res.CurrentGlobal)
	}
	if *res.Current != Limit/2 {
		t.Errorf("window not centered: %d", *res.Current)
	}
	big := strings.Repeat(strings.Repeat("x", 1000)+"\n", MaxTotal/1000+5)
	res = Search(big, 0, 1000, mustCompile(t, Options{Query: "x"}), false, Point{})
	if !res.Capped || res.Total != MaxTotal {
		t.Errorf("cap: %d %v", res.Total, res.Capped)
	}
}

// fakePane answers herdr's requests for a pane rows x cols holding text.
type fakePane struct {
	rows, cols int
	text       string
	reads      int
	// shrink makes the first full read fail as if the pane was cleared.
	shrink bool
}

func (f *fakePane) CallInto(_ context.Context, method string, params, out any) error {
	b, _ := json.Marshal(params)
	var p struct {
		Pane   string `json:"pane_id"`
		Anchor Point  `json:"anchor"`
		Cursor Point  `json:"cursor"`
	}
	_ = json.Unmarshal(b, &p)
	if p.Pane != "w1:p1" {
		return &herdr.APIError{Code: "pane_not_found", Message: "pane not found"}
	}
	switch method {
	case "pane.get":
		return json.Unmarshal(fmt.Appendf(nil, `{"pane":{"scroll":{"max_offset_from_bottom":%d,"viewport_rows":10,"offset_from_bottom":0}}}`, f.rows-10), out)
	case "pane.selection.read":
		if int(p.Cursor.Row) >= f.rows || int(p.Cursor.Col) >= f.cols || int(p.Anchor.Col) >= f.cols {
			return &herdr.APIError{Code: "selection_unavailable", Message: "selection text is unavailable"}
		}
		if p.Anchor != p.Cursor {
			f.reads++
			if f.shrink && f.reads == 1 {
				return &herdr.APIError{Code: "selection_unavailable", Message: "selection text is unavailable"}
			}
		}
		text, _ := json.Marshal(f.text)
		return json.Unmarshal(fmt.Appendf(nil, `{"text":%s}`, text), out)
	}
	return fmt.Errorf("unexpected %s", method)
}

func TestPane(t *testing.T) {
	f := &fakePane{rows: 30, cols: 37, text: "first\n" + strings.Repeat("y", 40) + "needle\nneedle"}
	for _, hint := range []int{0, 37, 80, 1} {
		res, err := Pane(context.Background(), f, agentproto.FindRequest{Pane: "w1:p1", Query: "needle", Cols: hint, Backward: true, Cursor: pt(1<<32-1, 0)})
		if err != nil {
			t.Fatal(err)
		}
		// yyy…needle wraps after 37 columns: needle at row 2, 3..8.
		want := []Range{rng(2, 3, 2, 8), rng(3, 0, 3, 5)}
		if fmt.Sprint(res.Matches) != fmt.Sprint(want) || *res.CurrentGlobal != 1 {
			t.Errorf("hint %d: %+v", hint, res)
		}
	}
	// Stepping from the current match to the older one.
	res, err := Pane(context.Background(), f, agentproto.FindRequest{Pane: "w1:p1", Query: "needle", Backward: true, Previous: &Range{Start: pt(3, 0), End: pt(3, 5)}})
	if err != nil || *res.CurrentGlobal != 0 {
		t.Errorf("previous: %+v %v", res, err)
	}
	f.shrink, f.reads = true, 0
	if res, err := Pane(context.Background(), f, agentproto.FindRequest{Pane: "w1:p1", Query: "needle"}); err != nil || res.Total != 2 || f.reads != 2 {
		t.Errorf("read again after the pane changed: %+v %v (%d reads)", res, err, f.reads)
	}
	_, err = Pane(context.Background(), f, agentproto.FindRequest{Pane: "w9:p1", Query: "needle"})
	var ae *herdr.APIError
	if !errors.As(err, &ae) || ae.Code != "pane_not_found" {
		t.Errorf("unknown pane: %v", err)
	}
	if _, err := Pane(context.Background(), f, agentproto.FindRequest{Pane: "w1:p1", Query: "[", Regex: true}); !errors.As(err, new(*InvalidError)) {
		t.Errorf("invalid regex: %v", err)
	}
}

func TestEdge(t *testing.T) {
	for _, n := range []int{1, 2, 3, 37, 64, 65, 119, 4096} {
		for _, hint := range []int{0, n, n + 1, n - 1, 5} {
			probes := 0
			got, err := edge(func(i int) (bool, error) { probes++; return i < n, nil }, hint, 1<<16)
			if err != nil || got != n {
				t.Errorf("n %d hint %d: %d %v", n, hint, got, err)
			}
			if hint == n && probes != 2 {
				t.Errorf("n %d: %d probes with the right hint", n, probes)
			}
		}
	}
	if got, _ := edge(func(int) (bool, error) { return false, nil }, 0, 100); got != 0 {
		t.Errorf("none: %d", got)
	}
}
