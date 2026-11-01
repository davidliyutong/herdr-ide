package endpoint

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// ClientMessage variant tags (frozen in generation 1).
const (
	tagResize       = 12
	tagPaneInput    = 13
	tagRequest      = 15
	tagHostTheme    = 17
	tagFocus        = 18
	tagMouseCapture = 19
	tagControl      = 20
)

// Key codes in ClientKeyCode order.
var keyCodes = map[string]uint32{
	"Backspace": 0, "Enter": 1, "Left": 2, "Right": 3, "Up": 4, "Down": 5,
	"Home": 6, "End": 7, "PageUp": 8, "PageDown": 9, "Tab": 10, "BackTab": 11,
	"Delete": 12, "Insert": 13, "Esc": 14, "Char": 15, "F": 16, "Null": 17,
}

// Key modifier bits (crossterm KeyModifiers).
const (
	ModShift = 1 << iota
	ModCtrl
	ModAlt
	ModSuper
)

// KeyEvent is ClientPaneInputEvent::Key. herdr encodes it for the target
// pane's keyboard mode.
type KeyEvent struct {
	Code          string  `json:"code"`
	Char          string  `json:"char,omitempty"` // one character, for Code "Char"
	F             uint8   `json:"f,omitempty"`    // for Code "F"
	Mods          uint8   `json:"mods,omitempty"`
	Kind          uint8   `json:"kind,omitempty"` // 0 press, 1 repeat, 2 release
	Repeat        uint16  `json:"repeat,omitempty"`
	Shifted       *uint32 `json:"shifted,omitempty"`
	Text          *string `json:"text,omitempty"` // text the key types
	TracksRelease bool    `json:"tracksRelease,omitempty"`
}

// MouseEvent is ClientPaneInputEvent::Mouse; Col and Row are relative to
// the pane's inner rectangle.
type MouseEvent struct {
	Kind   string `json:"kind"` // down|up|drag|move|scrollUp|scrollDown|scrollLeft|scrollRight
	Button uint8  `json:"button,omitempty"`
	Col    uint16 `json:"col"`
	Row    uint16 `json:"row"`
	Mods   uint8  `json:"mods,omitempty"`
	Lines  uint16 `json:"lines,omitempty"`
}

// InputEvent is one ClientPaneInputEvent: exactly one of Key, Text (text
// commit), Mouse or Paste is set, as named by T.
type InputEvent struct {
	T     string      `json:"t"` // key|text|mouse|paste
	Key   *KeyEvent   `json:"key,omitempty"`
	Text  string      `json:"text,omitempty"`
	Mouse *MouseEvent `json:"mouse,omitempty"`
}

var mouseKinds = map[string]uint32{
	"down": 0, "up": 1, "drag": 2, "move": 3,
	"scrollUp": 4, "scrollDown": 5, "scrollLeft": 6, "scrollRight": 7,
}

// MaxInputEvents bounds one input message.
const MaxInputEvents = 256

func (w *writer) inputEvent(e InputEvent) error {
	switch e.T {
	case "key":
		k := e.Key
		if k == nil {
			return fmt.Errorf("endpoint: key event without key")
		}
		code, ok := keyCodes[k.Code]
		if !ok {
			return fmt.Errorf("endpoint: unknown key code %q", k.Code)
		}
		if k.Kind > 2 {
			return fmt.Errorf("endpoint: key kind %d", k.Kind)
		}
		w.variant(0)
		w.variant(code)
		switch k.Code {
		case "Char":
			c, n := utf8.DecodeRuneInString(k.Char)
			if n == 0 || n != len(k.Char) || c == utf8.RuneError {
				return fmt.Errorf("endpoint: Char key needs one character, got %q", k.Char)
			}
			w.char(c)
		case "F":
			w.u8(k.F)
		}
		w.u8(k.Mods)
		w.variant(uint32(k.Kind))
		rep := k.Repeat
		if rep == 0 {
			rep = 1
		}
		w.u16(rep)
		w.optU32(k.Shifted)
		w.optString(k.Text)
		w.bool(k.TracksRelease)
		w.u8(0) // physical_key_id
		w.u8(0) // windows_record
	case "text":
		w.variant(1)
		w.string(e.Text)
	case "mouse":
		m := e.Mouse
		if m == nil {
			return fmt.Errorf("endpoint: mouse event without mouse")
		}
		kind, ok := mouseKinds[m.Kind]
		if !ok {
			return fmt.Errorf("endpoint: unknown mouse kind %q", m.Kind)
		}
		w.variant(2)
		w.variant(kind)
		if kind <= 2 {
			if m.Button > 2 {
				return fmt.Errorf("endpoint: mouse button %d", m.Button)
			}
			w.variant(uint32(m.Button))
		}
		w.variant(0) // ClientMousePosition::Cell
		w.u16(m.Col)
		w.u16(m.Row)
		w.u8(0) // geometry
		w.u8(m.Mods)
		w.u16(m.Lines)
	case "paste":
		w.variant(3)
		w.string(SanitizePaste(e.Text))
	default:
		return fmt.Errorf("endpoint: unknown input event %q", e.T)
	}
	return nil
}

// MaxInputText bounds the text of one text or paste event.
const MaxInputText = 1 << 20

// SanitizePaste removes ESC and C0/C1 controls other than tab and CR from
// pasted text. herdr wraps a paste in bracketed-paste markers when the
// program asked for them but does not filter the text, so a pasted marker
// (or any escape sequence) could end the paste early and run the rest as
// typed input.
func SanitizePaste(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r == '\t' || r == '\r':
			return r
		case r == '\n':
			return '\r'
		case r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f):
			return -1
		}
		return r
	}, s)
}

// EncodePaneInput builds a framed ClientShellPaneInput.
func EncodePaneInput(paneID string, events []InputEvent) ([]byte, error) {
	if len(events) == 0 || len(events) > MaxInputEvents {
		return nil, fmt.Errorf("endpoint: %d input events", len(events))
	}
	w := &writer{}
	w.variant(tagPaneInput)
	w.string(paneID)
	w.varint(uint64(len(events)))
	for _, e := range events {
		if len(e.Text) > MaxInputText {
			return nil, fmt.Errorf("endpoint: input text of %d bytes", len(e.Text))
		}
		if err := w.inputEvent(e); err != nil {
			return nil, err
		}
	}
	return frame(w.b), nil
}

// Size is a surface size in cells plus the cell size in device pixels.
type Size struct {
	Cols, Rows   uint16
	CellW, CellH uint32
}

// Valid reports whether herdr accepts the size (client_transport.rs).
func (s Size) Valid() bool {
	return s.Cols > 0 && s.Rows > 0 && s.Cols <= maxGridDim && s.Rows <= maxGridDim &&
		int(s.Cols)*int(s.Rows) <= maxGridCells && s.CellW <= 4096 && s.CellH <= 4096
}

// EncodeResize builds a framed ClientShellResize.
func EncodeResize(s Size) []byte {
	w := &writer{}
	w.variant(tagResize)
	w.u32(s.CellW)
	w.u32(s.CellH)
	w.u16(s.Cols)
	w.u16(s.Rows)
	w.bool(false) // pixel_mouse
	return frame(w.b)
}

// EncodeFocus builds a framed ClientShellFocus.
func EncodeFocus(focused bool) []byte {
	w := &writer{}
	w.variant(tagFocus)
	w.bool(focused)
	return frame(w.b)
}

// EncodeControl builds a framed EndpointControl.
func EncodeControl(kind, data string) []byte {
	w := &writer{}
	w.variant(tagControl)
	w.string(kind)
	w.string(data)
	return frame(w.b)
}

// EncodeRequest builds a framed ClientShellEndpointRequest.
func EncodeRequest(bootID, request string) []byte {
	w := &writer{}
	w.variant(tagRequest)
	w.string(bootID)
	w.string(request)
	return frame(w.b)
}

// RGB is a host color.
type RGB struct{ R, G, B uint8 }

// HostTheme reports the browser's terminal colors, so that herdr answers
// pane programs' color queries (OSC 10/11/4, CSI ?996n) with them.
type HostTheme struct {
	Fg, Bg  RGB
	Palette []RGB // indexes 0..len-1, at most 256
	Dark    bool
}

// EncodeHostTheme builds the framed ClientShellHostTheme messages for t.
func EncodeHostTheme(t HostTheme) []byte {
	var out []byte
	msg := func(fill func(w *writer)) {
		w := &writer{}
		w.variant(tagHostTheme)
		fill(w)
		out = append(out, frame(w.b)...)
	}
	color := func(w *writer, c RGB) { w.b = append(w.b, c.R, c.G, c.B) }
	msg(func(w *writer) { w.variant(0); w.variant(0); color(w, t.Fg) })
	msg(func(w *writer) { w.variant(0); w.variant(1); color(w, t.Bg) })
	if n := min(len(t.Palette), 256); n > 0 {
		msg(func(w *writer) {
			w.variant(1)
			w.varint(uint64(n))
			for i := 0; i < n; i++ {
				w.u8(uint8(i))
				color(w, t.Palette[i])
			}
		})
	}
	msg(func(w *writer) {
		w.variant(2)
		if t.Dark {
			w.variant(0)
		} else {
			w.variant(1)
		}
	})
	return out
}
