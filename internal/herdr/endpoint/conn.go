package endpoint

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Generation 1 names (src/protocol/endpoint.rs).
const (
	Generation    = 1
	HelloKind     = "endpoint.hello.v1"
	WelcomeKind   = "endpoint.welcome.v1"
	SnapshotKind  = "shell.snapshot.v1"
	PingKind      = "endpoint.health.ping.v1"
	PongKind      = "endpoint.health.pong.v1"
	snapshotCodec = "shell.snapshot.v1"
	surfaceCodec  = "shell.surface.v1"
	inputCodec    = "shell.input.semantic.v1"
	blobCodec     = "shell.blob.v1"
)

// Health timing as in herdr's own client (src/client/endpoint/health.rs).
var (
	pingAfter = 5 * time.Second
	deadAfter = 15 * time.Second
)

type hello struct {
	Generation          uint32   `json:"generation"`
	CellWidthPx         uint32   `json:"cell_width_px"`
	CellHeightPx        uint32   `json:"cell_height_px"`
	SurfaceSize         wireSize `json:"surface_size"`
	PixelMouse          bool     `json:"pixel_mouse"`
	DirectGraphics      bool     `json:"direct_graphics"`
	EndpointKeybindings bool     `json:"endpoint_keybindings"`
	MouseCapture        bool     `json:"mouse_capture"`
	SurfaceActive       bool     `json:"surface_active"`
	SurfaceDelta        bool     `json:"surface_delta"`
	SurfaceScroll       bool     `json:"surface_scroll"`
	SnapshotCodecs      []string `json:"snapshot_codecs"`
	SurfaceCodecs       []string `json:"surface_codecs"`
	InputCodecs         []string `json:"input_codecs"`
	BlobCodecs          []string `json:"blob_codecs"`
}

type wireSize struct {
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// Welcome is herdr's handshake reply.
type Welcome struct {
	Generation    uint32   `json:"generation"`
	ServerVersion string   `json:"server_version"`
	SnapshotCodec string   `json:"snapshot_codec"`
	SurfaceCodec  string   `json:"surface_codec"`
	InputCodec    string   `json:"input_codec"`
	BlobCodec     string   `json:"blob_codec"`
	Methods       []string `json:"methods"`
	Capabilities  []string `json:"capabilities"`
	Error         *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// Snapshot is the part of shell.snapshot.v1 herdr-ide reads.
type Snapshot struct {
	BootID             string `json:"boot_id"`
	Revision           uint64 `json:"revision"`
	FocusedWorkspaceID string `json:"focused_workspace_id"`
	FocusedTabID       string `json:"focused_tab_id"`
	FocusedPaneID      string `json:"focused_pane_id"`
}

// HandshakeError is a rejected handshake. Code is herdr's error code, or
// "unsupported" when herdr does not speak generation 1 at all.
type HandshakeError struct {
	Code    string
	Message string
}

func (e *HandshakeError) Error() string {
	return "endpoint handshake: " + e.Code + ": " + e.Message
}

// Event is something the connection received, after the retained grid was
// updated. Surface events carry the grid's own (complete) surface; patch
// events carry the moves and patch that turned the previous revision into
// the current one.
type Event struct {
	Snapshot  *Snapshot
	Surface   *Surface
	Moves     []RowMove
	Patch     *Patch
	Current   *Surface // the retained surface after Patch
	Clipboard *string  // base64
	Bell      uint16
	Title     *WindowTitle
	Error     string // ClientShellError
}

// Conn is one endpoint connection.
type Conn struct {
	c        net.Conn
	Welcome  Welcome
	wmu      sync.Mutex
	lastRecv atomic.Int64

	gridMu sync.Mutex
	grid   Grid

	mu       sync.Mutex
	snapshot Snapshot
	reqSlot  chan struct{}
	reqID    uint64
	pending  map[string]chan []byte
	partial  map[string][]byte
	closed   chan struct{}
	closeErr error
}

// Options for Dial.
type Options struct {
	Size   Size
	Active bool
}

// Handshake sends the hello on c and reads the welcome. c should be a fresh
// connection to herdr-client.sock.
func Handshake(ctx context.Context, c net.Conn, o Options) (*Conn, error) {
	if !o.Size.Valid() {
		return nil, &HandshakeError{Code: "invalid_surface", Message: "surface size out of range"}
	}
	h := hello{
		Generation: Generation, CellWidthPx: o.Size.CellW, CellHeightPx: o.Size.CellH,
		SurfaceSize:   wireSize{o.Size.Cols, o.Size.Rows},
		SurfaceActive: o.Active, SurfaceDelta: true, SurfaceScroll: true,
		SnapshotCodecs: []string{snapshotCodec}, SurfaceCodecs: []string{surfaceCodec},
		InputCodecs: []string{inputCodec}, BlobCodecs: []string{blobCodec},
	}
	data, _ := json.Marshal(h)
	dl := time.Now().Add(10 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(dl) {
		dl = d
	}
	_ = c.SetDeadline(dl)
	if _, err := c.Write(EncodeControl(HelloKind, string(data))); err != nil {
		return nil, err
	}
	p, err := ReadFrame(c, MaxHandshakeFrame)
	if err != nil {
		return nil, fmt.Errorf("endpoint handshake: %w", err)
	}
	_ = c.SetDeadline(time.Time{})
	m, err := DecodeMessage(p)
	if err != nil {
		return nil, err
	}
	var w Welcome
	switch m := m.(type) {
	case Control:
		if m.Kind != WelcomeKind {
			return nil, &HandshakeError{Code: "unsupported", Message: "unexpected first message " + m.Kind}
		}
		if err := json.Unmarshal([]byte(m.Data), &w); err != nil {
			return nil, &HandshakeError{Code: "invalid_welcome", Message: err.Error()}
		}
	case ShellError:
		return nil, &HandshakeError{Code: "unsupported", Message: m.Message}
	default:
		return nil, &HandshakeError{Code: "unsupported", Message: "herdr does not speak endpoint generation 1"}
	}
	if w.Error != nil {
		return nil, &HandshakeError{Code: w.Error.Code, Message: w.Error.Message}
	}
	if w.Generation != Generation || w.SnapshotCodec != snapshotCodec || w.SurfaceCodec != surfaceCodec ||
		w.InputCodec != inputCodec || w.BlobCodec != blobCodec {
		return nil, &HandshakeError{Code: "no_common_core", Message: "herdr chose another generation or codec"}
	}
	conn := &Conn{
		c: c, Welcome: w,
		reqSlot: make(chan struct{}, 1),
		pending: map[string]chan []byte{},
		partial: map[string][]byte{},
		closed:  make(chan struct{}),
	}
	conn.lastRecv.Store(time.Now().UnixNano())
	return conn, nil
}

// Has reports whether herdr advertised a capability.
func (c *Conn) Has(capability string) bool {
	for _, x := range c.Welcome.Capabilities {
		if x == capability {
			return true
		}
	}
	return false
}

// Send writes framed client messages.
func (c *Conn) Send(b []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.c.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err := c.c.Write(b)
	return err
}

// Close ends the connection.
func (c *Conn) Close() error { return c.c.Close() }

// Done is closed when Run returns.
func (c *Conn) Done() <-chan struct{} { return c.closed }

// Snapshot returns the last shell snapshot.
func (c *Conn) Snapshot() Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshot
}

// WithGrid runs fn with the retained surface, which does not change while
// fn runs. Event callbacks already hold it: call WithGrid only from other
// goroutines.
func (c *Conn) WithGrid(fn func(*Grid)) {
	c.gridMu.Lock()
	defer c.gridMu.Unlock()
	fn(&c.grid)
}

// Run receives until the connection ends, calling fn for each event on the
// receiving goroutine. It sends health pings while the server is quiet.
func (c *Conn) Run(ctx context.Context, fn func(Event)) error {
	defer close(c.closed)
	stop := make(chan struct{})
	defer close(stop)
	go c.health(ctx, stop)
	err := c.recv(fn)
	c.c.Close()
	c.mu.Lock()
	c.closeErr = err
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
	c.mu.Unlock()
	return err
}

func (c *Conn) health(ctx context.Context, stop chan struct{}) {
	t := time.NewTicker(pingAfter / 2)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ctx.Done():
			c.c.Close()
			return
		case <-t.C:
			quiet := time.Since(time.Unix(0, c.lastRecv.Load()))
			if quiet > deadAfter {
				c.c.Close()
				return
			}
			if quiet > pingAfter {
				_ = c.Send(EncodeControl(PingKind, strconv.FormatInt(time.Now().UnixNano(), 10)))
			}
		}
	}
}

func (c *Conn) recv(fn func(Event)) error {
	for {
		p, err := ReadFrame(c.c, MaxFrame)
		if err != nil {
			return err
		}
		c.lastRecv.Store(time.Now().UnixNano())
		m, err := DecodeMessage(p)
		if err != nil {
			return err
		}
		c.gridMu.Lock()
		err = c.handle(m, fn)
		c.gridMu.Unlock()
		if err != nil {
			return err
		}
	}
}

// handle applies one message and reports it; gridMu is held.
func (c *Conn) handle(m Message, fn func(Event)) error {
	switch m := m.(type) {
	case *Surface:
		c.grid.Full(m)
		fn(Event{Surface: m})
	case *Patch:
		if err := c.grid.Patch(m); err != nil {
			return err
		}
		fn(Event{Patch: m, Current: c.grid.Surface})
	case Control:
		switch m.Kind {
		case SnapshotKind:
			var s Snapshot
			if err := json.Unmarshal([]byte(m.Data), &s); err != nil {
				return fmt.Errorf("endpoint: snapshot: %w", err)
			}
			c.mu.Lock()
			c.snapshot = s
			c.mu.Unlock()
			fn(Event{Snapshot: &s})
		case DeltaKind:
			s, err := c.grid.Delta(m.Data)
			if err != nil {
				return err
			}
			fn(Event{Surface: s})
		case ScrollKind:
			moves, p, err := c.grid.ScrollPatch(m.Data)
			if err != nil {
				return err
			}
			fn(Event{Moves: moves, Patch: p, Current: c.grid.Surface})
		}
	case ResponseChunk:
		c.chunk(m)
	case Clipboard:
		d := m.Data
		fn(Event{Clipboard: &d})
	case Bell:
		fn(Event{Bell: m.Count})
	case WindowTitle:
		t := m
		fn(Event{Title: &t})
	case ShellError:
		fn(Event{Error: m.Message})
	case Shutdown:
		return errors.New("endpoint: herdr server shut down")
	}
	return nil
}

func (c *Conn) chunk(m ResponseChunk) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch, ok := c.pending[m.RequestID]
	if !ok {
		return
	}
	buf := append(c.partial[m.RequestID], m.Data...)
	if len(buf) > MaxFrame {
		delete(c.partial, m.RequestID)
		delete(c.pending, m.RequestID)
		close(ch)
		return
	}
	if !m.Final {
		c.partial[m.RequestID] = buf
		return
	}
	delete(c.partial, m.RequestID)
	delete(c.pending, m.RequestID)
	ch <- buf
}

// RequestError is an error reply to an endpoint request.
type RequestError struct{ Code, Message string }

func (e *RequestError) Error() string { return e.Code + ": " + e.Message }

// Request runs one endpoint API request (herdr allows one in flight per
// connection) and returns its result.
func (c *Conn) Request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	select {
	case c.reqSlot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.closed:
		return nil, net.ErrClosed
	}
	defer func() { <-c.reqSlot }()
	c.mu.Lock()
	c.reqID++
	id := "r" + strconv.FormatUint(c.reqID, 10)
	ch := make(chan []byte, 1)
	c.pending[id] = ch
	boot := c.snapshot.BootID
	c.mu.Unlock()
	cleanup := func() {
		c.mu.Lock()
		delete(c.pending, id)
		delete(c.partial, id)
		c.mu.Unlock()
	}
	req, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		cleanup()
		return nil, err
	}
	if err := c.Send(EncodeRequest(boot, string(req))); err != nil {
		cleanup()
		return nil, err
	}
	select {
	case b, ok := <-ch:
		if !ok {
			return nil, errors.New("endpoint: connection closed before the reply")
		}
		var res struct {
			Result json.RawMessage `json:"result"`
			Error  *RequestError   `json:"error"`
		}
		if err := json.Unmarshal(b, &res); err != nil {
			return nil, err
		}
		if res.Error != nil {
			return nil, res.Error
		}
		return res.Result, nil
	case <-ctx.Done():
		cleanup()
		return nil, ctx.Err()
	}
}
