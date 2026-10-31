package endpoint

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Frame size caps (herdr's MAX_FRAME_SIZE and MAX_GRAPHICS_FRAME_SIZE). The
// handshake uses the small cap, later messages the large one.
const (
	MaxHandshakeFrame = 2 << 20
	MaxFrame          = 32 << 20
)

// Grid limits herdr applies to surfaces (surface_delta/decode.rs); a surface
// beyond them is a protocol error.
const (
	maxGridDim   = 4096
	maxGridCells = 1_000_000
	maxSpans     = 4096
)

// ReadFrame reads one length-prefixed payload of at most max bytes.
func ReadFrame(r io.Reader, max int) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(hdr[:])
	if int64(n) > int64(max) {
		return nil, fmt.Errorf("endpoint: frame of %d bytes exceeds %d", n, max)
	}
	p := make([]byte, n)
	if _, err := io.ReadFull(r, p); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	return p, nil
}

// frame prefixes a payload with its length.
func frame(payload []byte) []byte {
	out := make([]byte, 4, 4+len(payload))
	binary.LittleEndian.PutUint32(out, uint32(len(payload)))
	return append(out, payload...)
}

// ---- shared types ----

type Rect struct {
	X uint16 `json:"x"`
	Y uint16 `json:"y"`
	W uint16 `json:"w"`
	H uint16 `json:"h"`
}

// Cell is one surface cell. Colors use herdr's packing: 0x000000NN named
// (0 = default), 0x010000II palette index, 0x02RRGGBB true color.
type Cell struct {
	Symbol  string
	Fg, Bg  uint32
	Mod     uint16
	Skip    bool
	HasLink bool
	Link    uint32
}

type Cursor struct {
	X       uint16 `json:"x"`
	Y       uint16 `json:"y"`
	Visible bool   `json:"visible"`
	Shape   uint8  `json:"shape"`
}

type Frame struct {
	Cells  []Cell
	W, H   uint16
	Cursor *Cursor
	Links  []string
}

type Scroll struct {
	OffsetFromBottom    uint64 `json:"offset_from_bottom"`
	MaxOffsetFromBottom uint64 `json:"max_offset_from_bottom"`
	ViewportRows        uint64 `json:"viewport_rows"`
}

type Pane struct {
	ID              string  `json:"id"`
	ContentRevision uint64  `json:"-"`
	Rect            Rect    `json:"rect"`
	Inner           Rect    `json:"inner"`
	Scrollbar       *Rect   `json:"scrollbar,omitempty"`
	Scroll          *Scroll `json:"scroll,omitempty"`
	Focused         bool    `json:"focused"`
	MouseReporting  bool    `json:"mouse"`
	SGRPixelMouse   bool    `json:"-"`
	AltScreen       bool    `json:"alt"`
	PixelW          uint32  `json:"-"`
	PixelH          uint32  `json:"-"`
}

type Split struct {
	Vertical bool   `json:"vertical"`
	Pos      uint16 `json:"pos"`
	Area     Rect   `json:"area"`
	Hit      Rect   `json:"hit"`
	Path     []bool `json:"path"`
}

type PopupSize struct {
	Percent bool   `json:"percent"`
	Value   uint16 `json:"value"`
}

type Popup struct {
	TerminalID     string
	Title          string
	Width, Height  *PopupSize
	Frame          Frame
	MouseReporting bool
	SGRPixelMouse  bool
	PixelW, PixelH uint32
}

// Surface is a complete pane surface (PaneSurfaceFrame) of the connection's
// selected tab. Graphics scenes are decoded and dropped.
type Surface struct {
	BootID             string
	ProjectionRevision uint64
	SurfaceRevision    uint64
	Frame              Frame
	Panes              []Pane
	Splits             []Split
	Popup              *Popup
}

type PatchRow struct {
	X, Y  uint16
	Cells []Cell
}

// Patch updates the previous surface revision (PaneSurfacePatch).
type Patch struct {
	BootID             string
	ProjectionRevision uint64
	BaseRevision       uint64
	SurfaceRevision    uint64
	Rows               []PatchRow
	Panes              []Pane
	Cursor             *Cursor
}

// ---- server messages ----

// Message is a decoded ServerMessage.
type Message interface{ isMessage() }

type (
	Shutdown      struct{ Reason *string }
	Clipboard     struct{ Data string } // base64 of OSC 52 bytes
	WindowTitle   struct{ Title *string }
	Bell          struct{ Count uint16 }
	MouseCapture  struct{ Enabled, SGRPixels bool }
	ShellError    struct{ Message string }
	ReportAllKeys struct{ Enabled bool }
	Control       struct{ Kind, Data string }
	// ResponseChunk is part of the reply to an endpoint request.
	ResponseChunk struct {
		BootID, RequestID string
		Final             bool
		Data              []byte
	}
	Notification struct {
		Kind  uint32
		Title string
		Body  *string
		Pane  *string
	}
	// Ignored stands for messages herdr-ide has no use for.
	Ignored struct{ Tag uint32 }
)

func (Shutdown) isMessage()      {}
func (Clipboard) isMessage()     {}
func (WindowTitle) isMessage()   {}
func (Bell) isMessage()          {}
func (MouseCapture) isMessage()  {}
func (ShellError) isMessage()    {}
func (ReportAllKeys) isMessage() {}
func (Control) isMessage()       {}
func (ResponseChunk) isMessage() {}
func (Notification) isMessage()  {}
func (Ignored) isMessage()       {}
func (*Surface) isMessage()      {}
func (*Patch) isMessage()        {}

// DecodeMessage decodes one ServerMessage payload; trailing bytes are an
// error, as in herdr.
func DecodeMessage(p []byte) (Message, error) {
	r := &reader{b: p}
	m, err := r.message()
	if err != nil {
		return nil, err
	}
	if r.remaining() != 0 {
		return nil, fmt.Errorf("endpoint: %d trailing bytes", r.remaining())
	}
	return m, nil
}

func (r *reader) message() (Message, error) {
	tag, err := r.variant()
	if err != nil {
		return nil, err
	}
	switch tag {
	case 0: // Welcome (legacy handshakes only)
		if _, err := r.u32(); err != nil {
			return nil, err
		}
		if _, err := r.variant(); err != nil {
			return nil, err
		}
		e, err := r.optString()
		if err != nil {
			return nil, err
		}
		if e != nil {
			return ShellError{Message: *e}, nil
		}
		return Ignored{tag}, nil
	case 1: // Terminal(TerminalFrame)
		if err := r.skipVarints(3); err != nil {
			return nil, err
		}
		if _, err := r.bool(); err != nil {
			return nil, err
		}
		_, err := r.bytes()
		return Ignored{tag}, err
	case 2: // Graphics
		_, err := r.bytes()
		return Ignored{tag}, err
	case 3:
		s, err := r.optString()
		return Shutdown{s}, err
	case 4: // Notify
		if _, err := r.variant(); err != nil {
			return nil, err
		}
		if _, err := r.string(); err != nil {
			return nil, err
		}
		_, err := r.optString()
		return Ignored{tag}, err
	case 5:
		s, err := r.string()
		return Clipboard{s}, err
	case 6:
		s, err := r.optString()
		return WindowTitle{s}, err
	case 7:
		return Ignored{tag}, nil
	case 8:
		a, err := r.bool()
		if err != nil {
			return nil, err
		}
		b, err := r.bool()
		return MouseCapture{a, b}, err
	case 9:
		n, err := r.u16()
		return Bell{n}, err
	case 10: // GraphicsFile
		if _, err := r.string(); err != nil {
			return nil, err
		}
		if err := r.skipVarints(3); err != nil {
			return nil, err
		}
		if _, err := r.bytes(); err != nil {
			return nil, err
		}
		if _, err := r.string(); err != nil {
			return nil, err
		}
		ok, err := r.option()
		if err == nil && ok {
			err = r.assetKey()
		}
		return Ignored{tag}, err
	case 11:
		return Ignored{tag}, r.skipVarints(2)
	case 12:
		return nil, errors.New("endpoint: binary ClientShellSnapshot is not part of generation 1")
	case 13:
		s, err := r.surface(false)
		return s, err
	case 14:
		return r.notification()
	case 15:
		s, err := r.string()
		return ShellError{s}, err
	case 16:
		if _, err := r.u16(); err != nil {
			return nil, err
		}
		_, err := r.u8()
		return Ignored{tag}, err
	case 17:
		b, err := r.bool()
		return ReportAllKeys{b}, err
	case 18:
		var c ResponseChunk
		if c.BootID, err = r.string(); err != nil {
			return nil, err
		}
		if c.RequestID, err = r.string(); err != nil {
			return nil, err
		}
		if c.Final, err = r.bool(); err != nil {
			return nil, err
		}
		c.Data, err = r.bytes()
		return c, err
	case 19:
		return r.patch()
	case 20:
		var c Control
		if c.Kind, err = r.string(); err != nil {
			return nil, err
		}
		c.Data, err = r.string()
		return c, err
	}
	return nil, fmt.Errorf("endpoint: unknown server message %d", tag)
}

// skipVarints skips n integer fields (all integers but u8 are varints).
func (r *reader) skipVarints(n int) error {
	for i := 0; i < n; i++ {
		if _, err := r.varint(); err != nil {
			return err
		}
	}
	return nil
}

func (r *reader) notification() (Message, error) {
	var n Notification
	var err error
	if n.Kind, err = r.variant(); err != nil {
		return nil, err
	}
	if n.Title, err = r.string(); err != nil {
		return nil, err
	}
	if n.Body, err = r.optString(); err != nil {
		return nil, err
	}
	if ok, err := r.option(); err != nil {
		return nil, err
	} else if ok {
		if _, err := r.variant(); err != nil {
			return nil, err
		}
	}
	for i := 0; i < 3; i++ { // agent, workspace_id, tab_id
		if _, err := r.optString(); err != nil {
			return nil, err
		}
	}
	if n.Pane, err = r.optString(); err != nil {
		return nil, err
	}
	if ok, err := r.option(); err != nil {
		return nil, err
	} else if ok {
		if _, err := r.variant(); err != nil {
			return nil, err
		}
	}
	return n, nil
}

func (r *reader) rect() (Rect, error) {
	var v Rect
	var err error
	if v.X, err = r.u16(); err != nil {
		return v, err
	}
	if v.Y, err = r.u16(); err != nil {
		return v, err
	}
	if v.W, err = r.u16(); err != nil {
		return v, err
	}
	v.H, err = r.u16()
	return v, err
}

func (r *reader) cell() (Cell, error) {
	var c Cell
	var err error
	if c.Symbol, err = r.string(); err != nil {
		return c, err
	}
	if c.Fg, err = r.u32(); err != nil {
		return c, err
	}
	if c.Bg, err = r.u32(); err != nil {
		return c, err
	}
	if c.Mod, err = r.u16(); err != nil {
		return c, err
	}
	if c.Skip, err = r.bool(); err != nil {
		return c, err
	}
	l, err := r.optU32()
	if l != nil {
		c.HasLink, c.Link = true, *l
	}
	return c, err
}

// minCell is the smallest encoding of a cell (empty symbol, one-byte
// colors and modifier, skip, no link).
const minCell = 6

func (r *reader) cells() ([]Cell, error) {
	n, err := r.length(minCell)
	if err != nil {
		return nil, err
	}
	out := make([]Cell, n)
	for i := range out {
		if out[i], err = r.cell(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (r *reader) cursor() (*Cursor, error) {
	ok, err := r.option()
	if err != nil || !ok {
		return nil, err
	}
	var c Cursor
	if c.X, err = r.u16(); err != nil {
		return nil, err
	}
	if c.Y, err = r.u16(); err != nil {
		return nil, err
	}
	if c.Visible, err = r.bool(); err != nil {
		return nil, err
	}
	c.Shape, err = r.u8()
	return &c, err
}

func gridOK(w, h uint16) error {
	if w > maxGridDim || h > maxGridDim || int(w)*int(h) > maxGridCells {
		return fmt.Errorf("endpoint: surface %dx%d exceeds the grid limits", w, h)
	}
	return nil
}

// frameData decodes FrameData. With metaOnly (surface-delta metadata) the
// cell sequence must be empty.
func (r *reader) frameData(metaOnly bool) (Frame, error) {
	var f Frame
	var err error
	if f.Cells, err = r.cells(); err != nil {
		return f, err
	}
	if metaOnly && len(f.Cells) != 0 {
		return f, errors.New("endpoint: surface delta metadata carries cells")
	}
	if f.W, err = r.u16(); err != nil {
		return f, err
	}
	if f.H, err = r.u16(); err != nil {
		return f, err
	}
	if err := gridOK(f.W, f.H); err != nil {
		return f, err
	}
	if !metaOnly && len(f.Cells) != int(f.W)*int(f.H) {
		return f, fmt.Errorf("endpoint: %d cells for a %dx%d frame", len(f.Cells), f.W, f.H)
	}
	if f.Cursor, err = r.cursor(); err != nil {
		return f, err
	}
	n, err := r.length(1)
	if err != nil {
		return f, err
	}
	f.Links = make([]string, n)
	for i := range f.Links {
		if f.Links[i], err = r.string(); err != nil {
			return f, err
		}
	}
	_, err = r.bytes() // kitty graphics bytes; empty for shell surfaces
	return f, err
}

func (r *reader) pane() (Pane, error) {
	var p Pane
	var err error
	if p.ID, err = r.string(); err != nil {
		return p, err
	}
	if p.ContentRevision, err = r.u64(); err != nil {
		return p, err
	}
	if p.Rect, err = r.rect(); err != nil {
		return p, err
	}
	if p.Inner, err = r.rect(); err != nil {
		return p, err
	}
	if ok, err := r.option(); err != nil {
		return p, err
	} else if ok {
		sb, err := r.rect()
		if err != nil {
			return p, err
		}
		p.Scrollbar = &sb
	}
	if ok, err := r.option(); err != nil {
		return p, err
	} else if ok {
		var s Scroll
		if s.OffsetFromBottom, err = r.u64(); err != nil {
			return p, err
		}
		if s.MaxOffsetFromBottom, err = r.u64(); err != nil {
			return p, err
		}
		if s.ViewportRows, err = r.u64(); err != nil {
			return p, err
		}
		p.Scroll = &s
	}
	for _, f := range []*bool{&p.Focused, &p.MouseReporting, &p.SGRPixelMouse, &p.AltScreen} {
		if *f, err = r.bool(); err != nil {
			return p, err
		}
	}
	if p.PixelW, err = r.u32(); err != nil {
		return p, err
	}
	p.PixelH, err = r.u32()
	return p, err
}

func (r *reader) panes() ([]Pane, error) {
	n, err := r.length(20)
	if err != nil {
		return nil, err
	}
	out := make([]Pane, n)
	for i := range out {
		if out[i], err = r.pane(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (r *reader) split() (Split, error) {
	var s Split
	d, err := r.variant()
	if err != nil {
		return s, err
	}
	if d > 1 {
		return s, fmt.Errorf("endpoint: split direction %d", d)
	}
	s.Vertical = d == 1
	if s.Pos, err = r.u16(); err != nil {
		return s, err
	}
	if s.Area, err = r.rect(); err != nil {
		return s, err
	}
	if s.Hit, err = r.rect(); err != nil {
		return s, err
	}
	n, err := r.length(1)
	if err != nil {
		return s, err
	}
	s.Path = make([]bool, n)
	for i := range s.Path {
		if s.Path[i], err = r.bool(); err != nil {
			return s, err
		}
	}
	return s, nil
}

func (r *reader) popupSize() (*PopupSize, error) {
	ok, err := r.option()
	if err != nil || !ok {
		return nil, err
	}
	v, err := r.variant()
	if err != nil {
		return nil, err
	}
	switch v {
	case 0:
		n, err := r.u16()
		return &PopupSize{Value: n}, err
	case 1:
		n, err := r.u8()
		return &PopupSize{Percent: true, Value: uint16(n)}, err
	}
	return nil, fmt.Errorf("endpoint: popup size variant %d", v)
}

func (r *reader) popup(metaOnly bool) (*Popup, error) {
	ok, err := r.option()
	if err != nil || !ok {
		return nil, err
	}
	var p Popup
	if p.TerminalID, err = r.string(); err != nil {
		return nil, err
	}
	if p.Title, err = r.string(); err != nil {
		return nil, err
	}
	if p.Width, err = r.popupSize(); err != nil {
		return nil, err
	}
	if p.Height, err = r.popupSize(); err != nil {
		return nil, err
	}
	if p.Frame, err = r.frameData(metaOnly); err != nil {
		return nil, err
	}
	if p.MouseReporting, err = r.bool(); err != nil {
		return nil, err
	}
	if p.SGRPixelMouse, err = r.bool(); err != nil {
		return nil, err
	}
	if p.PixelW, err = r.u32(); err != nil {
		return nil, err
	}
	p.PixelH, err = r.u32()
	return &p, err
}

func (r *reader) assetKey() error {
	src, err := r.variant()
	if err != nil {
		return err
	}
	switch src {
	case 0: // Terminal{target, image_id}
		if _, err := r.variant(); err != nil {
			return err
		}
		if _, err := r.string(); err != nil {
			return err
		}
		if _, err := r.u32(); err != nil {
			return err
		}
	case 1: // PaneLayer{pane_id, layer_id}
		if _, err := r.string(); err != nil {
			return err
		}
		if _, err := r.string(); err != nil {
			return err
		}
	default:
		return fmt.Errorf("endpoint: graphics source %d", src)
	}
	if _, err := r.u32(); err != nil {
		return err
	}
	if _, err := r.u32(); err != nil {
		return err
	}
	if _, err := r.variant(); err != nil {
		return err
	}
	if _, err := r.u64(); err != nil {
		return err
	}
	_, err = r.u64()
	return err
}

func (r *reader) graphicsScene() error {
	n, err := r.length(1)
	if err != nil {
		return err
	}
	for i := 0; i < n; i++ {
		if err := r.assetKey(); err != nil {
			return err
		}
		if _, err := r.bytes(); err != nil {
			return err
		}
	}
	if n, err = r.length(1); err != nil {
		return err
	}
	for i := 0; i < n; i++ {
		if err := r.assetKey(); err != nil {
			return err
		}
		for j := 0; j < 3; j++ { // logical_placement_id, x, y
			if _, err := r.varint(); err != nil {
				return err
			}
		}
		for j := 0; j < 8; j++ { // cols … y_offset
			if _, err := r.u32(); err != nil {
				return err
			}
		}
		if _, err := r.i32(); err != nil {
			return err
		}
		if _, err := r.u32(); err != nil {
			return err
		}
	}
	if n, err = r.length(1); err != nil {
		return err
	}
	for i := 0; i < n; i++ {
		if err := r.assetKey(); err != nil {
			return err
		}
	}
	return nil
}

// surface decodes PaneSurfaceFrame; metaOnly for surface-delta metadata.
func (r *reader) surface(metaOnly bool) (*Surface, error) {
	s := &Surface{}
	var err error
	if s.BootID, err = r.string(); err != nil {
		return nil, err
	}
	if s.ProjectionRevision, err = r.u64(); err != nil {
		return nil, err
	}
	if s.SurfaceRevision, err = r.u64(); err != nil {
		return nil, err
	}
	if s.Frame, err = r.frameData(metaOnly); err != nil {
		return nil, err
	}
	if s.Panes, err = r.panes(); err != nil {
		return nil, err
	}
	n, err := r.length(10)
	if err != nil {
		return nil, err
	}
	s.Splits = make([]Split, n)
	for i := range s.Splits {
		if s.Splits[i], err = r.split(); err != nil {
			return nil, err
		}
	}
	if s.Popup, err = r.popup(metaOnly); err != nil {
		return nil, err
	}
	if err := r.graphicsScene(); err != nil {
		return nil, err
	}
	return s, nil
}

func (r *reader) patchRows() ([]PatchRow, error) {
	n, err := r.length(3)
	if err != nil {
		return nil, err
	}
	if n > maxSpans*64 {
		return nil, fmt.Errorf("endpoint: %d patch rows", n)
	}
	out := make([]PatchRow, n)
	for i := range out {
		if out[i].X, err = r.u16(); err != nil {
			return nil, err
		}
		if out[i].Y, err = r.u16(); err != nil {
			return nil, err
		}
		if out[i].Cells, err = r.cells(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (r *reader) patch() (*Patch, error) {
	p := &Patch{}
	var err error
	if p.BootID, err = r.string(); err != nil {
		return nil, err
	}
	if p.ProjectionRevision, err = r.u64(); err != nil {
		return nil, err
	}
	if p.BaseRevision, err = r.u64(); err != nil {
		return nil, err
	}
	if p.SurfaceRevision, err = r.u64(); err != nil {
		return nil, err
	}
	if p.Rows, err = r.patchRows(); err != nil {
		return nil, err
	}
	if p.Panes, err = r.panes(); err != nil {
		return nil, err
	}
	p.Cursor, err = r.cursor()
	return p, err
}
