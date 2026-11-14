package panefind

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

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
		res := Search(text, 0, 80, mustCompile(t, c.o), false, Point{}, false)
		if res.Total != c.want {
			t.Errorf("%+v: %d matches, want %d", c.o, res.Total, c.want)
		}
	}
	// Invalid expressions name the reason as a code and the part at fault
	// as written, without the case flag added to it.
	for _, c := range []struct {
		o            Options
		reason, expr string
	}{
		{Options{Query: "a(b", Regex: true}, "missing_paren", "a(b"},
		{Options{Query: "a(b", Regex: true, MatchCase: true}, "missing_paren", "a(b"},
		{Options{Query: "*", Regex: true}, "missing_repeat_arg", "*"},
		{Options{Query: `x(?=y)`, Regex: true}, "perl_op", "(?="},
		{Options{Query: `[z-a]`, Regex: true}, "char_range", "z-a"},
	} {
		var inv *InvalidError
		if _, err := Compile(c.o); !errors.As(err, &inv) || inv.Reason != c.reason || inv.Expr != c.expr {
			t.Errorf("%+v: %v", c.o, err)
		}
	}
	if _, err := Compile(Options{Query: "(", Regex: false}); err != nil {
		t.Errorf("literal parenthesis: %v", err)
	}
	if _, err := Compile(Options{Query: strings.Repeat("a", MaxQuery+1)}); !errors.Is(err, ErrTooLarge) {
		t.Errorf("long query: %v", err)
	}
}

// A match that is not a whole word hides no other: one starting inside or
// after it, or a longer one at the same place, is found; marks combining
// with a letter belong to its word.
func TestWholeWord(t *testing.T) {
	for _, c := range []struct {
		name, text string
		o          Options
		want       []Range
	}{
		{"overlapping", "xa a a", Options{Query: "a a"}, []Range{rng(0, 3, 0, 5)}},
		{"longer at the same place", "abc", Options{Query: "ab|abc", Regex: true}, []Range{rng(0, 0, 0, 2)}},
		{"combining mark", "café cafe", Options{Query: "cafe"}, []Range{rng(0, 5, 0, 8)}},
		{"word after the mark", "éx x", Options{Query: "x"}, []Range{rng(0, 3, 0, 3)}},
		{"several", "a-a aa a", Options{Query: "a"}, []Range{rng(0, 0, 0, 0), rng(0, 2, 0, 2), rng(0, 7, 0, 7)}},
		// \b asserts about the text before: matched on whole lines only.
		{"anchored", "foo xfoo foo", Options{Query: `\bfoo`, Regex: true}, []Range{rng(0, 0, 0, 2), rng(0, 9, 0, 11)}},
		{"start of line", "ab ab", Options{Query: `^ab|b`, Regex: true}, []Range{rng(0, 0, 0, 1)}},
	} {
		c.o.WholeWord = true
		res := Search(c.text, 0, 80, mustCompile(t, c.o), false, Point{}, true)
		if fmt.Sprint(res.Matches) != fmt.Sprint(append([]Range{}, c.want...)) {
			t.Errorf("%s: %v, want %v", c.name, res.Matches, c.want)
		}
	}
	// A long match rejected at every start: the extra work stops and the
	// line is still searched.
	line := "q" + strings.Repeat("a", 200_000) + "b c b"
	m := mustCompile(t, Options{Query: `a+b|c`, Regex: true, WholeWord: true})
	began := time.Now()
	if res := Search(line, 0, 1<<15, m, false, Point{}, true); res.Total != 1 {
		t.Errorf("rejected again and again: %d matches", res.Total)
	}
	// Without the bound this takes minutes (quadratic in the line).
	if d := time.Since(began); d > 2*time.Second*slowdown {
		t.Errorf("rejected again and again: %s", d)
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
		res := Search(c.text, 0, c.cols, mustCompile(t, Options{Query: c.query}), false, Point{}, false)
		if fmt.Sprint(res.Matches) != fmt.Sprint(c.want) {
			t.Errorf("%s: %v, want %v", c.name, res.Matches, c.want)
		}
	}
	// Rows count from where the text starts.
	res := Search("x\nneedle", 40, 80, mustCompile(t, Options{Query: "needle"}), false, Point{}, false)
	if res.Matches[0] != rng(41, 0, 41, 5) || res.FirstRow != 40 {
		t.Errorf("first row: %+v", res)
	}
}

// The current match is chosen as herdr's search chooses it: forward, the
// first starting after the origin; backward, the last ending before it;
// wrapping around at either end. Inclusive takes one at the origin too.
func TestCurrent(t *testing.T) {
	text := "x a\nb x\nc x"
	m := mustCompile(t, Options{Query: "x"})
	end := pt(1<<32-1, 0)
	for _, c := range []struct {
		backward, inclusive bool
		origin              Point
		want                int
	}{
		{true, false, end, 2},
		{true, false, pt(2, 2), 1},  // the current match's start
		{true, false, pt(0, 0), 2},  // wraps to the newest
		{false, false, pt(0, 0), 1}, // the current match's end
		{false, false, pt(2, 2), 0}, // wraps to the oldest
		// From the start with no current match: the first cell's match.
		{false, true, pt(0, 0), 0},
		{false, true, pt(1, 2), 1},
		{true, true, pt(1, 2), 1},
		{true, true, pt(1, 1), 0},
	} {
		res := Search(text, 0, 80, m, c.backward, c.origin, c.inclusive)
		if res.Current == nil || res.CurrentGlobal == nil || *res.Current != *res.CurrentGlobal {
			t.Fatalf("current %v %v", res.Current, res.CurrentGlobal)
		}
		if got := *res.CurrentGlobal; got != c.want {
			t.Errorf("backward %v inclusive %v from %+v: %d, want %d", c.backward, c.inclusive, c.origin, got, c.want)
		}
	}
	if res := Search(text, 0, 80, mustCompile(t, Options{Query: "z"}), true, end, false); res.Total != 0 || res.Current != nil || res.Matches == nil {
		t.Errorf("no match: %+v", res)
	}
}

// Large results: a window of Limit around the current match, wherever it
// is, with every match counted.
func TestWindow(t *testing.T) {
	text := strings.Repeat("x", 3000)
	res := Search(text, 0, 100, mustCompile(t, Options{Query: "x"}), true, pt(15, 0), false)
	if res.Total != 3000 || len(res.Matches) != Limit || *res.CurrentGlobal != 1499 || res.Matches[*res.Current] != rng(14, 99, 14, 99) {
		t.Fatalf("window: total %d, %d shown, current %d", res.Total, len(res.Matches), *res.CurrentGlobal)
	}
	if *res.Current != Limit/2 {
		t.Errorf("window not centered: %d", *res.Current)
	}

	// 150 000 matches, one per cell of 150 rows of 1000.
	const rows, cols = 150, 1000
	big := strings.Repeat(strings.Repeat("x", cols)+"\n", rows)
	m := mustCompile(t, Options{Query: "x"})
	check := func(name string, res Result, current int, cell Point) {
		t.Helper()
		if res.Total != rows*cols || len(res.Matches) != Limit || res.CurrentGlobal == nil || *res.CurrentGlobal != current {
			t.Fatalf("%s: total %d, %d shown, current %v", name, res.Total, len(res.Matches), res.CurrentGlobal)
		}
		got := res.Matches[*res.Current]
		if got.Start != cell || got.End != cell {
			t.Errorf("%s: current %+v, want %+v", name, got, cell)
		}
		// The window holds consecutive matches.
		for i := 1; i < len(res.Matches); i++ {
			p, q := res.Matches[i-1].Start, res.Matches[i].Start
			if q.Row*cols+uint32(q.Col) != p.Row*cols+uint32(p.Col)+1 {
				t.Fatalf("%s: matches %d and %d not consecutive: %+v %+v", name, i-1, i, p, q)
			}
		}
	}
	// Backward from the end: the newest match, not one where counting
	// stopped.
	check("newest", Search(big, 0, cols, m, true, pt(1<<32-1, 0), false), rows*cols-1, pt(rows-1, cols-1))
	check("forward in the middle", Search(big, 0, cols, m, false, pt(120, 499), false), 120*cols+500, pt(120, 500))
	check("backward in the middle", Search(big, 0, cols, m, true, pt(120, 500), false), 120*cols+499, pt(120, 499))
	check("forward around the end", Search(big, 0, cols, m, false, pt(rows-1, cols-1), false), 0, pt(0, 0))
	check("backward around the start", Search(big, 0, cols, m, true, pt(0, 0), false), rows*cols-1, pt(rows-1, cols-1))
	check("near the start", Search(big, 0, cols, m, false, pt(0, 3), false), 4, pt(0, 4))
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
	// Forward from the start with no current match: the match in the first
	// cell is the first, not skipped for the next.
	first := &fakePane{rows: 30, cols: 37, text: "needle x needle"}
	if res, err := Pane(context.Background(), first, agentproto.FindRequest{Pane: "w1:p1", Query: "needle"}); err != nil || *res.CurrentGlobal != 0 {
		t.Errorf("forward from the start: %+v %v", res, err)
	}
	// Stepping forward from that match goes on to the next one.
	if res, err := Pane(context.Background(), first, agentproto.FindRequest{Pane: "w1:p1", Query: "needle", Previous: &Range{Start: pt(0, 0), End: pt(0, 5)}}); err != nil || *res.CurrentGlobal != 1 {
		t.Errorf("forward from the first: %+v %v", res, err)
	}
	// A refresh of an answer with every match: unchanged while the text
	// is, without matches; a search again after new output.
	known := res.Text
	req := agentproto.FindRequest{Pane: "w1:p1", Query: "needle", Backward: true, Previous: &Range{Start: pt(3, 0), End: pt(3, 5)}, Known: known}
	if res, err := Pane(context.Background(), f, req); err != nil || !res.Unchanged || len(res.Matches) != 0 || res.Text != known {
		t.Errorf("unchanged: %+v %v", res, err)
	}
	if res, err := Pane(context.Background(), f, agentproto.FindRequest{Pane: "w1:p1", Query: "needles", Known: known}); err != nil || res.Unchanged {
		t.Errorf("another query: %+v %v", res, err)
	}
	before := f.text
	f.text += "\nneedle"
	if res, err := Pane(context.Background(), f, req); err != nil || res.Unchanged || res.Total != 3 {
		t.Errorf("new output: %+v %v", res, err)
	}
	f.text = before
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
	for _, n := range []int{0, 1, 2, 3, 37, 64, 65, 119, 4096, 1 << 16} {
		for _, hint := range []int{0, n, n + 1, n - 1, n + 3, n - 3, 5, 1 << 16, 1<<16 + 9} {
			probes := 0
			got, err := edge(func(i int) (bool, error) { probes++; return i < n, nil }, hint, 1<<16)
			if err != nil || got != n {
				t.Errorf("n %d hint %d: %d %v", n, hint, got, err)
			}
			if hint == n && n > 0 && probes > 2 {
				t.Errorf("n %d: %d probes with the right hint", n, probes)
			}
			// A hint a few off (a pane that grew or shrank since it was
			// measured) costs a few probes more, not a search from 0.
			if (hint == n+3 || hint == n-3) && hint > 0 && hint <= 1<<16 && probes > 8 {
				t.Errorf("n %d hint %d: %d probes", n, hint, probes)
			}
		}
	}
	// A pane far larger than its hint: steps grow from the hint.
	probes := 0
	if got, _ := edge(func(i int) (bool, error) { probes++; return i < 100_037, nil }, 100_000, 1<<31); got != 100_037 || probes > 16 {
		t.Errorf("grown: %d after %d probes", got, probes)
	}
}
