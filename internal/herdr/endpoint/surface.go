package endpoint

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
)

// Optional surface encodings negotiated in the hello.
const (
	DeltaKind  = "endpoint.surface-delta.v1"
	ScrollKind = "endpoint.surface-scroll.v1"
)

// Grid is the retained surface of one connection: the last complete surface
// with every later patch applied. Every PaneSurface, PaneSurfacePatch and
// optional surface encoding must pass through it in order.
type Grid struct {
	Surface *Surface // nil until the first complete surface
}

var errBaseline = errors.New("endpoint: surface update does not match its baseline")

// Full replaces the retained surface.
func (g *Grid) Full(s *Surface) { g.Surface = s }

func (g *Grid) matches(p *Patch) bool {
	s := g.Surface
	return s != nil && s.BootID == p.BootID && s.ProjectionRevision == p.ProjectionRevision &&
		s.SurfaceRevision == p.BaseRevision && p.SurfaceRevision == p.BaseRevision+1
}

func rowsFit(rows []PatchRow, w, h uint16) bool {
	for _, r := range rows {
		if r.Y >= h || int(r.X)+len(r.Cells) > int(w) || len(r.Cells) == 0 {
			return false
		}
	}
	return true
}

func applyRows(cells []Cell, w uint16, rows []PatchRow) {
	for _, r := range rows {
		copy(cells[int(r.Y)*int(w)+int(r.X):], r.Cells)
	}
}

// mergePanes replaces panes by id.
func mergePanes(panes []Pane, upd []Pane) {
	for _, u := range upd {
		for i := range panes {
			if panes[i].ID == u.ID {
				panes[i] = u
			}
		}
	}
}

// Patch applies p. herdr only patches the revision it last sent; a patch
// that does not match is a protocol error (the connection restarts).
func (g *Grid) Patch(p *Patch) error {
	if !g.matches(p) {
		return errBaseline
	}
	s := g.Surface
	if !rowsFit(p.Rows, s.Frame.W, s.Frame.H) {
		return errors.New("endpoint: surface patch exceeds the grid")
	}
	for _, r := range p.Rows {
		for _, c := range r.Cells {
			if c.HasLink && int(c.Link) >= len(s.Frame.Links) {
				return errors.New("endpoint: surface patch has an invalid hyperlink index")
			}
		}
	}
	applyRows(s.Frame.Cells, s.Frame.W, p.Rows)
	mergePanes(s.Panes, p.Panes)
	s.Frame.Cursor = p.Cursor
	s.SurfaceRevision = p.SurfaceRevision
	return nil
}

// Delta applies an endpoint.surface-delta.v1 control and returns the
// complete surface it describes.
func (g *Grid) Delta(data string) (*Surface, error) {
	base := g.Surface
	if base == nil {
		return nil, errBaseline
	}
	if len(data) > MaxFrame {
		return nil, errors.New("endpoint: surface delta exceeds the frame limit")
	}
	b, err := base64.RawStdEncoding.DecodeString(data)
	if err != nil {
		return nil, fmt.Errorf("endpoint: surface delta: %w", err)
	}
	r := &reader{b: b}
	baseProj, err := r.u64()
	if err != nil {
		return nil, err
	}
	baseRev, err := r.u64()
	if err != nil {
		return nil, err
	}
	s, err := r.surface(true)
	if err != nil {
		return nil, err
	}
	if s.Frame.W != base.Frame.W || s.Frame.H != base.Frame.H {
		return nil, errors.New("endpoint: surface delta dimensions do not match the baseline")
	}
	rows, err := r.patchRows()
	if err != nil {
		return nil, err
	}
	if len(rows) > maxSpans || !rowsFit(rows, s.Frame.W, s.Frame.H) {
		return nil, errors.New("endpoint: surface delta exceeds the grid")
	}
	hasPopup, err := r.option()
	if err != nil {
		return nil, err
	}
	var popupRows []PatchRow
	var popupCells []Cell
	popupReplace := false
	if hasPopup {
		v, err := r.variant()
		if err != nil {
			return nil, err
		}
		switch v {
		case 0:
			if popupRows, err = r.patchRows(); err != nil {
				return nil, err
			}
		case 1:
			popupReplace = true
			if popupCells, err = r.cells(); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("endpoint: popup grid update %d", v)
		}
	}
	if r.remaining() != 0 {
		return nil, errors.New("endpoint: trailing surface delta bytes")
	}
	if s.BootID != base.BootID || baseProj != base.ProjectionRevision || baseRev != base.SurfaceRevision ||
		s.SurfaceRevision != base.SurfaceRevision+1 || s.ProjectionRevision < base.ProjectionRevision {
		return nil, errBaseline
	}
	cells := append([]Cell(nil), base.Frame.Cells...)
	applyRows(cells, s.Frame.W, rows)
	s.Frame.Cells = cells
	switch {
	case s.Popup == nil && hasPopup, s.Popup != nil && !hasPopup:
		return nil, errors.New("endpoint: popup delta is missing or unexpected")
	case s.Popup != nil:
		f := &s.Popup.Frame
		n := int(f.W) * int(f.H)
		if popupReplace {
			if len(popupCells) != n {
				return nil, errors.New("endpoint: popup grid has the wrong size")
			}
			f.Cells = popupCells
		} else {
			prev := base.Popup
			if prev == nil || prev.TerminalID != s.Popup.TerminalID || prev.Frame.W != f.W || prev.Frame.H != f.H || len(prev.Frame.Cells) != n {
				return nil, errors.New("endpoint: popup delta does not match its baseline")
			}
			if !rowsFit(popupRows, f.W, f.H) {
				return nil, errors.New("endpoint: popup delta exceeds the grid")
			}
			f.Cells = append([]Cell(nil), prev.Frame.Cells...)
			applyRows(f.Cells, f.W, popupRows)
		}
	}
	for _, f := range []*Frame{&s.Frame, popupFrame(s.Popup)} {
		if f == nil {
			continue
		}
		for _, c := range f.Cells {
			if c.HasLink && int(c.Link) >= len(f.Links) {
				return nil, errors.New("endpoint: surface delta has an invalid hyperlink index")
			}
		}
	}
	g.Surface = s
	return s, nil
}

func popupFrame(p *Popup) *Frame {
	if p == nil {
		return nil
	}
	return &p.Frame
}

// RowMove is one region moved by an endpoint.surface-scroll.v1 control. A
// positive Shift moves content up.
type RowMove struct {
	Rect  Rect
	Shift int16
}

// ScrollPatch applies an endpoint.surface-scroll.v1 control: row moves
// inside pane regions, then an ordinary patch. It returns the moves and the
// patch (with the moved regions' rows added) so receivers can repeat them.
func (g *Grid) ScrollPatch(data string) ([]RowMove, *Patch, error) {
	base := g.Surface
	if base == nil {
		return nil, nil, errBaseline
	}
	b, err := base64.RawStdEncoding.DecodeString(data)
	if err != nil {
		return nil, nil, fmt.Errorf("endpoint: surface scroll: %w", err)
	}
	if len(b) == 0 || b[0] == 0 || b[0] > 64 {
		return nil, nil, errors.New("endpoint: surface scroll has an invalid scroll count")
	}
	n := int(b[0])
	hdr := 1 + n*10
	if len(b) < hdr+4 {
		return nil, nil, errors.New("endpoint: surface scroll is truncated")
	}
	scrolls := make([]RowMove, n)
	for i := range scrolls {
		c := b[1+i*10:]
		u := func(at int) uint16 { return binary.LittleEndian.Uint16(c[at:]) }
		scrolls[i] = RowMove{Rect{u(0), u(2), u(4), u(6)}, int16(u(8))}
	}
	ln := binary.LittleEndian.Uint32(b[hdr:])
	if int(ln) != len(b)-hdr-4 || int(ln) > MaxHandshakeFrame {
		return nil, nil, errors.New("endpoint: surface scroll patch has the wrong length")
	}
	m, err := DecodeMessage(b[hdr+4:])
	if err != nil {
		return nil, nil, err
	}
	p, ok := m.(*Patch)
	if !ok {
		return nil, nil, errors.New("endpoint: surface scroll does not carry a pane patch")
	}
	if !g.matches(p) {
		return nil, nil, errBaseline
	}
	w, h := base.Frame.W, base.Frame.H
	for i, s := range scrolls {
		r := s.Rect
		d := s.Shift
		if d < 0 {
			d = -d
		}
		if r.W == 0 || r.H < 2 || s.Shift == 0 || uint16(d) >= r.H || int(r.X)+int(r.W) > int(w) || int(r.Y)+int(r.H) > int(h) {
			return nil, nil, errors.New("endpoint: surface scroll exceeds the grid")
		}
		for _, o := range scrolls[i+1:] {
			if overlap(r, o.Rect) {
				return nil, nil, errors.New("endpoint: surface scroll regions overlap")
			}
		}
	}
	if !rowsFit(p.Rows, w, h) {
		return nil, nil, errors.New("endpoint: surface patch exceeds the grid")
	}
	for _, s := range scrolls {
		ApplyScroll(base.Frame.Cells, w, s)
	}
	if err := g.Patch(p); err != nil {
		return nil, nil, err
	}
	return scrolls, p, nil
}

func overlap(a, b Rect) bool {
	return a.X < b.X+b.W && b.X < a.X+a.W && a.Y < b.Y+b.H && b.Y < a.Y+a.H
}

// ApplyScroll moves the rows of one region in place with herdr's swap
// order (surface_scroll.rs for_each_swap), shared by every receiver.
func ApplyScroll(cells []Cell, width uint16, s RowMove) {
	r := s.Rect
	stride := int(width)
	start := func(y int) int { return (int(r.Y)+y)*stride + int(r.X) }
	swap := func(a, b int) {
		a, b = start(a), start(b)
		for x := 0; x < int(r.W); x++ {
			cells[a+x], cells[b+x] = cells[b+x], cells[a+x]
		}
	}
	h := int(r.H)
	if s.Shift > 0 {
		d := int(s.Shift)
		for y := 0; y < h-d; y++ {
			swap(y, y+d)
		}
	} else {
		d := int(-s.Shift)
		for y := h - 1; y >= d; y-- {
			swap(y, y-d)
		}
	}
}
