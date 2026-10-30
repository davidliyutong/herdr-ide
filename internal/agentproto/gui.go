package agentproto

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// GUIStatus describes a machine's virtual display (OpGUI).
type GUIStatus struct {
	// Supported is false where the agent cannot provide a display (macOS).
	Supported bool `json:"supported"`
	// Xvfb is the X server in use or found; empty when there is none.
	Xvfb string `json:"xvfb,omitempty"`
	// Installable reports that the distribution's Xvfb package can be
	// fetched and unpacked in user space (action install).
	Installable bool `json:"installable,omitempty"`
	// Display (":N") and XAuthority are reserved even while the server is
	// not running, so that panes get a stable environment.
	Display    string `json:"display,omitempty"`
	XAuthority string `json:"xauthority,omitempty"`
	Running    bool   `json:"running"`
	// VirtualGL: VGL is vglrun's path, GPU reports a working EGL device and
	// VGLPreload is the LD_PRELOAD value vglrun would use.
	VGL        string `json:"vgl,omitempty"`
	GPU        bool   `json:"gpu,omitempty"`
	VGLPreload string `json:"vgl_preload,omitempty"`
	Error      string `json:"error,omitempty"`
	// Procs (action shells, Header.Args = pids): the given processes of
	// this user that exist.
	Procs []GUIProc `json:"procs,omitempty"`
}

// GUIProc describes a pane's shell process for enabling the display in it.
type GUIProc struct {
	Pid int `json:"pid"`
	// Comm is the executable's name (/proc/<pid>/comm), which tells a shell
	// from a program that replaced it (exec).
	Comm string `json:"comm"`
	// Display: the process was started with this display in its environment.
	Display bool `json:"display,omitempty"`
}

// GUI stream (OpGUI, action "attach"): after the reply both sides exchange
// messages framed as [u8 kind][u32 big-endian length][payload].
const (
	// GUIJSON carries one JSON object: a GUIEvent from the agent or a
	// GUICommand from the core.
	GUIJSON byte = 1
	// GUIFrame (agent → core) carries a GUIFrameHeader and an encoded image.
	GUIFrame byte = 2
)

// MaxGUIMessage bounds one message (a full-screen PNG fits easily).
const MaxGUIMessage = 64 << 20

// WriteGUI writes one message. Callers serialize writes.
func WriteGUI(w io.Writer, kind byte, parts ...[]byte) error {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	if n > MaxGUIMessage {
		return fmt.Errorf("agentproto: gui message of %d bytes", n)
	}
	buf := make([]byte, 5, 5+n)
	buf[0] = kind
	binary.BigEndian.PutUint32(buf[1:], uint32(n))
	for _, p := range parts {
		buf = append(buf, p...)
	}
	_, err := w.Write(buf)
	return err
}

// ReadGUI reads one message.
func ReadGUI(r io.Reader) (kind byte, payload []byte, err error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > MaxGUIMessage {
		return 0, nil, fmt.Errorf("agentproto: gui message of %d bytes", n)
	}
	payload = make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	return hdr[0], payload, nil
}

// GUIWindow is a top-level window of a program.
type GUIWindow struct {
	ID    uint32 `json:"id"`
	Title string `json:"title"`
	W     int    `json:"w"`
	H     int    `json:"h"`
	Pid   int    `json:"pid,omitempty"`
	// Pane and Socket come from the program's HERDR_PANE_ID and
	// HERDR_SOCKET_PATH: the herdr pane (and session) it was started in.
	Pane   string `json:"pane,omitempty"`
	Socket string `json:"socket,omitempty"`
	// Transient is the window this one is a dialog of.
	Transient uint32 `json:"transient,omitempty"`
}

// GUILayer is an override-redirect window (menu, tooltip) drawn over the
// window it belongs to, at X, Y relative to that window.
type GUILayer struct {
	ID     uint32 `json:"id"`
	Window uint32 `json:"window"`
	X      int    `json:"x"`
	Y      int    `json:"y"`
	W      int    `json:"w"`
	H      int    `json:"h"`
}

// GUICursor is the pointer image (PNG) shown over a window.
type GUICursor struct {
	PNG  []byte `json:"png"`
	XHot int    `json:"xhot"`
	YHot int    `json:"yhot"`
}

// GUIEvent is sent by the agent.
type GUIEvent struct {
	// Ev: window (new or changed), gone, layer (new or changed),
	// layer_gone, cursor. The core adds child (a new dialog of the viewed
	// window) for browsers.
	Ev     string     `json:"ev"`
	Window *GUIWindow `json:"window,omitempty"`
	Layer  *GUILayer  `json:"layer,omitempty"`
	ID     uint32     `json:"id,omitempty"`
	Cursor *GUICursor `json:"cursor,omitempty"`
}

// GUICommand is sent by the core. Coordinates are relative to window ID.
type GUICommand struct {
	// Cmd: watch, unwatch (frames wanted or not), ack (frames up to Seq
	// were shown), refresh (send the whole window again), focus, close,
	// pointer, button, wheel, key, release (all pressed keys and buttons).
	Cmd     string `json:"cmd"`
	ID      uint32 `json:"id"`
	Seq     uint32 `json:"seq,omitempty"`
	X       int    `json:"x,omitempty"`
	Y       int    `json:"y,omitempty"`
	Button  int    `json:"button,omitempty"`
	Down    bool   `json:"down,omitempty"`
	Keycode int    `json:"keycode,omitempty"`
	DX      int    `json:"dx,omitempty"`
	DY      int    `json:"dy,omitempty"`
}

// Frame encodings.
const (
	GUIEncJPEG byte = 1
	GUIEncPNG  byte = 2
)

// GUIFrameHeader precedes the image of a GUIFrame message. The core relays
// header and image to browsers unchanged.
type GUIFrameHeader struct {
	Window uint32 // the top-level window
	Layer  uint32 // the window drawn: Window itself or one of its layers
	X, Y   int16  // rectangle within Layer
	W, H   uint16
	Enc    byte
	Seq    uint32 // per Window, increasing
}

// GUIFrameHeaderLen is the encoded size of a GUIFrameHeader.
const GUIFrameHeaderLen = 21

// Marshal encodes h.
func (h GUIFrameHeader) Marshal() []byte {
	b := make([]byte, GUIFrameHeaderLen)
	binary.BigEndian.PutUint32(b[0:], h.Window)
	binary.BigEndian.PutUint32(b[4:], h.Layer)
	binary.BigEndian.PutUint16(b[8:], uint16(h.X))
	binary.BigEndian.PutUint16(b[10:], uint16(h.Y))
	binary.BigEndian.PutUint16(b[12:], h.W)
	binary.BigEndian.PutUint16(b[14:], h.H)
	b[16] = h.Enc
	binary.BigEndian.PutUint32(b[17:], h.Seq)
	return b
}

// ParseGUIFrameHeader decodes the header at the start of a frame payload.
func ParseGUIFrameHeader(b []byte) (GUIFrameHeader, error) {
	if len(b) < GUIFrameHeaderLen {
		return GUIFrameHeader{}, errors.New("agentproto: short gui frame")
	}
	return GUIFrameHeader{
		Window: binary.BigEndian.Uint32(b[0:]),
		Layer:  binary.BigEndian.Uint32(b[4:]),
		X:      int16(binary.BigEndian.Uint16(b[8:])),
		Y:      int16(binary.BigEndian.Uint16(b[10:])),
		W:      binary.BigEndian.Uint16(b[12:]),
		H:      binary.BigEndian.Uint16(b[14:]),
		Enc:    b[16],
		Seq:    binary.BigEndian.Uint32(b[17:]),
	}, nil
}
