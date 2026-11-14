package panefind

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/fnv"
	"strconv"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/herdr"
)

// Caller makes one herdr API request (herdr.Client).
type Caller interface {
	CallInto(ctx context.Context, method string, params any, out any) error
}

// MaxCells bounds the text read (rows times columns): a larger scrollback
// is searched from its newest rows back.
const MaxCells = 4 << 20

// attempts at reading while the pane's size changes in between.
const attempts = 4

// ErrNoText: the pane has no text to read (herdr refused every read).
var ErrNoText = errors.New("pane text unavailable")

// Pane searches a pane's text through herdr: its size (pane.get, checked
// cell by cell), then all of its rows in one pane.selection.read, which
// herdr answers from one consistent state of the terminal, then Search.
// Rows written after the read are not searched. A request whose Known
// still holds is answered Unchanged without searching.
func Pane(ctx context.Context, c Caller, req agentproto.FindRequest) (*Result, error) {
	m, err := Compile(Options{Query: req.Query, Regex: req.Regex, MatchCase: req.MatchCase, WholeWord: req.WholeWord})
	if err != nil {
		return nil, err
	}
	origin := req.Cursor
	if req.Previous != nil {
		origin = req.Previous.End
		if req.Backward {
			origin = req.Previous.Start
		}
	}
	// Forward from a cursor (no current match), a match starting right
	// there is the first one: the start of the text has no cell before it.
	inclusive := !req.Backward && req.Previous == nil
	var last error
	for range attempts {
		rows, cols, err := size(ctx, c, req.Pane, req.Cols)
		if err != nil {
			return nil, err
		}
		first := uint32(0)
		if limit := uint32(max(1, MaxCells/cols)); rows > limit {
			first = rows - limit
		}
		var sel struct {
			Text string `json:"text"`
		}
		err = c.CallInto(ctx, "pane.selection.read", map[string]any{
			"pane_id": req.Pane,
			"anchor":  Point{Row: first},
			"cursor":  Point{Row: rows - 1, Col: uint16(cols - 1)},
		}, &sel)
		if unavailable(err) {
			// The pane shrank (cleared, resized) since its size was read.
			last = err
			continue
		}
		if err != nil {
			return nil, err
		}
		text := fingerprint(req, first, cols, sel.Text)
		if req.Known != "" && req.Known == text {
			return &Result{Matches: []Range{}, Unchanged: true, Text: text}, nil
		}
		res := Search(sel.Text, first, cols, m, req.Backward, origin, inclusive)
		res.Text = text
		return &res, nil
	}
	return nil, fmt.Errorf("%w: %v", ErrNoText, last)
}

// fingerprint identifies the matches of req's query in text laid out from
// row first in cols columns: a hash of all of them.
func fingerprint(req agentproto.FindRequest, first uint32, cols int, text string) string {
	h := fnv.New64a()
	var b [8]byte
	for _, n := range []uint64{uint64(first), uint64(cols), uint64(len(req.Query))} {
		binary.LittleEndian.PutUint64(b[:], n)
		h.Write(b[:])
	}
	h.Write([]byte(req.Query))
	h.Write([]byte{flag(req.Regex), flag(req.MatchCase), flag(req.WholeWord)})
	h.Write([]byte(text))
	return strconv.FormatUint(h.Sum64(), 36)
}

func flag(b bool) byte {
	if b {
		return 1
	}
	return 0
}

func unavailable(err error) bool {
	var ae *herdr.APIError
	return errors.As(err, &ae) && ae.Code == "selection_unavailable"
}

// cell reports whether the pane has the cell (row, col): herdr reads the
// text of a cell that exists and refuses one outside the pane.
func cell(ctx context.Context, c Caller, pane string, row uint32, col int) (bool, error) {
	if col < 0 || col > 0xffff {
		return false, nil
	}
	p := Point{Row: row, Col: uint16(col)}
	var sel struct{}
	err := c.CallInto(ctx, "pane.selection.read", map[string]any{"pane_id": pane, "anchor": p, "cursor": p}, &sel)
	if unavailable(err) {
		return false, nil
	}
	return err == nil, err
}

// size returns the pane's rows (scrollback included) and columns. herdr
// reports the rows (pane.get's scroll metrics) but not the columns, so the
// browser's width is checked, else found, cell by cell.
func size(ctx context.Context, c Caller, pane string, hint int) (uint32, int, error) {
	var info struct {
		Pane struct {
			Scroll *struct {
				Max  uint32 `json:"max_offset_from_bottom"`
				Rows uint32 `json:"viewport_rows"`
			} `json:"scroll"`
		} `json:"pane"`
	}
	if err := c.CallInto(ctx, "pane.get", map[string]any{"pane_id": pane}, &info); err != nil {
		return 0, 0, err
	}
	cols, err := edge(func(n int) (bool, error) { return cell(ctx, c, pane, 0, n) }, hint, 1<<16)
	if err != nil {
		return 0, 0, err
	}
	hintRows := 0
	if s := info.Pane.Scroll; s != nil {
		hintRows = int(s.Max + s.Rows)
	}
	rows, err := edge(func(n int) (bool, error) { return cell(ctx, c, pane, uint32(n), 0) }, hintRows, 1<<31)
	if err != nil {
		return 0, 0, err
	}
	if rows == 0 || cols == 0 {
		return 0, 0, ErrNoText
	}
	return uint32(rows), cols, nil
}

// edge returns n, the number of indexes for which has is true, given that
// it is true for 0..n-1 and false from n on, with n at most limit. The two
// probes around hint settle n when the hint is right; otherwise the search
// goes on from the hint, by doubling steps away from it and then halving,
// so a hint that is close costs few probes.
func edge(has func(int) (bool, error), hint, limit int) (int, error) {
	lo, hi := 0, limit // lo <= n <= hi
	down := false      // n is below the hint: step down from hi
	if hint > 0 && hint <= limit {
		in, err := has(hint - 1)
		if err != nil {
			return 0, err
		}
		if !in {
			hi, down = hint-1, true
		} else if hint == limit {
			return hint, nil
		} else {
			out, err := has(hint)
			if err != nil {
				return 0, err
			}
			if !out {
				return hint, nil
			}
			lo = hint + 1
		}
	}
	// Doubling steps from the known end: up from lo, or down from hi.
	for step := 1; lo < hi; step *= 2 {
		if down {
			i := max(hi-step, lo) // n <= i when has(i) is false
			ok, err := has(i)
			if err != nil {
				return 0, err
			}
			if ok {
				lo = i + 1
				break
			}
			hi = i
		} else {
			i := min(lo+step-1, hi-1) // n > i when has(i) is true
			ok, err := has(i)
			if err != nil {
				return 0, err
			}
			if !ok {
				hi = i
				break
			}
			lo = i + 1
		}
	}
	// Halving between them.
	for lo < hi {
		mid := lo + (hi-lo)/2
		ok, err := has(mid)
		if err != nil {
			return 0, err
		}
		if ok {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	return lo, nil
}
