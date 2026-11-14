package server

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/herdr/endpoint"
)

// Pane surfaces through herdr's endpoint protocol.
//
// One browser connection at a time owns this core's view of the machines,
// like a KVM console: it chooses which machine and tab are shown and at what
// size, and its input reaches the panes. While it shows machine m the core
// holds one endpoint connection to m's herdr (agent op herdr-client); herdr
// renders the selected tab into a cell grid at the browser's size, and the
// core keeps that grid and forwards it to the owner. Another browser is told
// that the session is in use and may take it over; the previous owner is
// then told it was taken over. A read-only browser never takes over a
// writable one.

// maxClipboard bounds an OSC 52 write forwarded to the browser (base64).
const maxClipboard = 1 << 20

// sessionGrace keeps endpoint connections open briefly after the owner left,
// so that a page reload does not resize herdr's tabs twice.
const sessionGrace = 10 * time.Second

// surfaces is the per-core state, guarded by its mutex.
type surfaces struct {
	mu       sync.Mutex
	owner    *wsClient
	sessions map[string]*surfSession // by machine
	theme    *endpoint.HostTheme
	gen      uint32
	idle     *time.Timer
}

// surfSession is the endpoint connection to one machine.
type surfSession struct {
	s      *Server
	m      string
	gen    uint32
	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.Mutex
	conn     *endpoint.Conn
	size     endpoint.Size
	tab      string // tab the owner wants shown
	pane     string // pane of that tab with the UI's focus
	lastMeta []byte
	focusing bool
	// wake ends a reconnect wait when the machine's agent session came
	// (back), since the backoff may have grown while it was away.
	wake chan struct{}
}

// viewMsg is the owner's choice of machine, tab and surface size.
type viewMsg struct {
	M    string `json:"m"`
	Tab  string `json:"tab"`
	Pane string `json:"pane"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
	CW   int    `json:"cw"`
	CH   int    `json:"ch"`
}

type hostMsg struct {
	Fg      [3]uint8   `json:"fg"`
	Bg      [3]uint8   `json:"bg"`
	Palette [][3]uint8 `json:"palette"`
	Dark    bool       `json:"dark"`
}

// ownerState tells c whether it owns the session.
func (s *Server) sendSessionState(c *wsClient, state string) {
	c.sendJSON(map[string]any{"t": "session", "state": state})
}

// surfJoin is called for every new browser connection.
func (s *Server) surfJoin(c *wsClient) {
	st := &s.surf
	st.mu.Lock()
	defer st.mu.Unlock()
	switch st.owner {
	case nil:
		s.setOwnerLocked(c)
	case c:
		// Handed over before joining (the previous owner left meanwhile).
		s.sendSessionState(c, "owner")
	default:
		s.sendSessionState(c, "busy")
	}
}

// surfTakeover makes c the owner unless a read-only browser would displace a
// writable one.
func (s *Server) surfTakeover(c *wsClient) {
	st := &s.surf
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.owner == c {
		s.sendSessionState(c, "owner")
		return
	}
	if prev := st.owner; prev != nil {
		if c.readOnly && !prev.readOnly {
			s.sendSessionState(c, "busy")
			return
		}
		s.sendSessionState(prev, "taken_over")
	}
	s.setOwnerLocked(c)
	s.audit.log(c.req, "session.takeover", nil)
}

func (s *Server) setOwnerLocked(c *wsClient) {
	st := &s.surf
	st.owner = c
	if st.idle != nil {
		st.idle.Stop()
		st.idle = nil
	}
	s.sendSessionState(c, "owner")
	// The new owner starts from complete surfaces.
	for _, ss := range st.sessions {
		ss.mu.Lock()
		ss.lastMeta = nil
		ss.mu.Unlock()
		go ss.resend()
	}
}

// surfLeave is called when a browser connection ends.
func (s *Server) surfLeave(c *wsClient) {
	st := &s.surf
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.owner != c {
		return
	}
	st.owner = nil
	// Hand the session to another writable browser, else keep the
	// connections for a short while for a reload.
	s.clientsMu.Lock()
	var next *wsClient
	for o := range s.clients {
		if o != c && o.ctx.Err() == nil && (next == nil || next.readOnly && !o.readOnly) {
			next = o
		}
	}
	s.clientsMu.Unlock()
	if next != nil {
		s.setOwnerLocked(next)
		return
	}
	st.idle = time.AfterFunc(sessionGrace, func() {
		st.mu.Lock()
		defer st.mu.Unlock()
		if st.owner != nil {
			return
		}
		for m, ss := range st.sessions {
			ss.cancel()
			delete(st.sessions, m)
		}
	})
}

// surfView applies the owner's view: one machine streams, the others close.
func (s *Server) surfView(c *wsClient, v viewMsg) {
	st := &s.surf
	size := endpoint.Size{Cols: clampU16(v.Cols), Rows: clampU16(v.Rows), CellW: clampU32(v.CW), CellH: clampU32(v.CH)}
	if !size.Valid() || v.M == "" || s.mg.Get(v.M) == nil {
		return
	}
	st.mu.Lock()
	if st.owner != c {
		st.mu.Unlock()
		return
	}
	for m, ss := range st.sessions {
		if m != v.M {
			ss.cancel()
			delete(st.sessions, m)
		}
	}
	if c.readOnly {
		// herdr's focused pane is where the session's input goes; a watcher
		// only selects the tab it shows.
		v.Pane = ""
	}
	ss := st.sessions[v.M]
	if ss == nil {
		st.gen++
		ctx, cancel := context.WithCancel(context.Background())
		ss = &surfSession{s: s, m: v.M, gen: st.gen, ctx: ctx, cancel: cancel, size: size, tab: v.Tab, pane: v.Pane, wake: make(chan struct{}, 1)}
		st.sessions[v.M] = ss
		st.mu.Unlock()
		go ss.run()
		return
	}
	st.mu.Unlock()
	ss.mu.Lock()
	resize := ss.size != size
	ss.size = size
	retab := v.Tab != "" && (ss.tab != v.Tab || ss.pane != v.Pane)
	ss.tab = v.Tab
	ss.pane = v.Pane
	conn := ss.conn
	ss.mu.Unlock()
	if conn == nil {
		return
	}
	if resize {
		// One resize at a time: over a slow link a window drag would
		// otherwise queue a complete surface per size (Conn.Resize).
		_ = conn.Resize(size)
	}
	if retab {
		go ss.ensureTab()
	}
}

// session returns the session of machine m if c owns it.
func (s *Server) ownedSession(c *wsClient, m string) *surfSession {
	st := &s.surf
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.owner != c {
		return nil
	}
	return st.sessions[m]
}

func (ss *surfSession) connection() *endpoint.Conn {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	return ss.conn
}

// surfInput forwards pane input from the owner.
func (s *Server) surfInput(c *wsClient, m, pane string, events []endpoint.InputEvent) {
	if c.readOnly || pane == "" {
		return
	}
	ss := s.ownedSession(c, m)
	if ss == nil {
		return
	}
	conn := ss.connection()
	if conn == nil {
		return
	}
	b, err := endpoint.EncodePaneInput(pane, events)
	if err != nil {
		return
	}
	_ = conn.Send(b)
}

// surfFocus reports whether the browser window has focus (focus events).
func (s *Server) surfFocus(c *wsClient, m string, focused bool) {
	if c.readOnly {
		return
	}
	if ss := s.ownedSession(c, m); ss != nil {
		if conn := ss.connection(); conn != nil {
			_ = conn.Send(endpoint.EncodeFocus(focused))
		}
	}
}

// surfHost records the owner's terminal colors and reports them to herdr.
func (s *Server) surfHost(c *wsClient, h hostMsg) {
	if c.readOnly {
		return
	}
	t := &endpoint.HostTheme{Fg: rgb(h.Fg), Bg: rgb(h.Bg), Dark: h.Dark}
	for i, p := range h.Palette {
		if i >= 256 {
			break
		}
		t.Palette = append(t.Palette, rgb(p))
	}
	st := &s.surf
	st.mu.Lock()
	if st.owner != c {
		st.mu.Unlock()
		return
	}
	st.theme = t
	var conns []*endpoint.Conn
	for _, ss := range st.sessions {
		if conn := ss.connection(); conn != nil {
			conns = append(conns, conn)
		}
	}
	st.mu.Unlock()
	for _, conn := range conns {
		_ = conn.Send(endpoint.EncodeHostTheme(*t))
	}
}

func rgb(c [3]uint8) endpoint.RGB { return endpoint.RGB{R: c[0], G: c[1], B: c[2]} }

func clampU16(v int) uint16 {
	if v < 0 {
		return 0
	}
	if v > 65535 {
		return 65535
	}
	return uint16(v)
}

func clampU32(v int) uint32 {
	if v < 0 {
		return 0
	}
	return uint32(v)
}

// owner returns the owning browser, if any.
func (ss *surfSession) owner() *wsClient {
	st := &ss.s.surf
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.sessions[ss.m] != ss {
		return nil
	}
	return st.owner
}

func (ss *surfSession) notify(ev string, extra map[string]any) {
	if o := ss.owner(); o != nil {
		msg := map[string]any{"t": "surf", "m": ss.m, "gen": ss.gen, "ev": ev}
		for k, v := range extra {
			msg[k] = v
		}
		o.sendJSON(msg)
	}
}

// handshakeCode maps a refused handshake to a UI code.
func handshakeCode(err error) string {
	var he *endpoint.HandshakeError
	if errors.As(err, &he) {
		switch he.Code {
		case "unsupported", "unsupported_generation", "no_common_core", "invalid_welcome":
			return "herdr_too_old"
		case "invalid_surface":
			return "invalid_surface"
		}
		return "handshake"
	}
	return ""
}

// wakeSurface makes the endpoint connection to machine m try again at once
// when it is waiting to reconnect: the machine's agent session came (back),
// or its herdr server was started from the UI.
func (s *Server) wakeSurface(m string) {
	s.surf.mu.Lock()
	ss := s.surf.sessions[m]
	s.surf.mu.Unlock()
	if ss == nil {
		return
	}
	ss.mu.Lock()
	waiting := ss.conn == nil
	ss.mu.Unlock()
	if waiting {
		select {
		case ss.wake <- struct{}{}:
		default:
		}
	}
}

// run keeps the endpoint connection up while the session is wanted.
func (ss *surfSession) run() {
	backoff := time.Second
	for ss.ctx.Err() == nil {
		err := ss.connect()
		if ss.ctx.Err() != nil {
			return
		}
		ev := map[string]any{"code": "disconnected"}
		if code := handshakeCode(err); code != "" {
			ev["code"] = code
			backoff = 15 * time.Second // a herdr update or a new size is needed
		}
		if err != nil {
			ev["detail"] = err.Error()
		}
		ss.notify("error", ev)
		select {
		case <-ss.ctx.Done():
			return
		case <-ss.wake:
			backoff = time.Second
			continue
		case <-time.After(backoff):
		}
		if backoff < 8*time.Second {
			backoff *= 2
		}
	}
}

func (ss *surfSession) connect() error {
	mc := ss.s.mg.Get(ss.m)
	if mc == nil {
		return errors.New("unknown machine")
	}
	ctx, cancel := context.WithTimeout(ss.ctx, 30*time.Second)
	raw, _, err := mc.Open(ctx, agentproto.Header{Op: agentproto.OpHerdrClient})
	if err != nil {
		cancel()
		return err
	}
	ss.mu.Lock()
	size := ss.size
	ss.mu.Unlock()
	conn, err := endpoint.Handshake(ctx, raw, endpoint.Options{Size: size, Active: true})
	cancel()
	if err != nil {
		raw.Close()
		return err
	}
	stop := context.AfterFunc(ss.ctx, func() { conn.Close() })
	defer stop()
	ss.mu.Lock()
	ss.conn = conn
	ss.lastMeta = nil
	// The size may have changed during the handshake.
	_ = conn.Resize(ss.size)
	ss.mu.Unlock()
	ss.s.surf.mu.Lock()
	theme := ss.s.surf.theme
	ss.s.surf.mu.Unlock()
	if theme != nil {
		_ = conn.Send(endpoint.EncodeHostTheme(*theme))
	}
	ss.notify("open", map[string]any{"version": conn.Welcome.ServerVersion})
	err = conn.Run(ss.ctx, ss.event)
	ss.mu.Lock()
	ss.conn = nil
	ss.mu.Unlock()
	return err
}

// ensureTab asks herdr to show the tab the owner wants, with the pane the UI
// focuses as herdr's focused pane (herdr highlights its border).
func (ss *surfSession) ensureTab() {
	ss.mu.Lock()
	conn, tab, pane := ss.conn, ss.tab, ss.pane
	if conn == nil || tab == "" || ss.focusing {
		ss.mu.Unlock()
		return
	}
	snap := conn.Snapshot()
	if snap.FocusedTabID == tab && (pane == "" || snap.FocusedPaneID == pane) {
		ss.mu.Unlock()
		return
	}
	ss.focusing = true
	ss.mu.Unlock()
	ctx, cancel := context.WithTimeout(ss.ctx, 10*time.Second)
	var err error
	if pane != "" {
		_, err = conn.Request(ctx, "pane.focus", map[string]string{"pane_id": pane})
	} else {
		_, err = conn.Request(ctx, "tab.focus", map[string]string{"tab_id": tab})
	}
	cancel()
	ss.mu.Lock()
	ss.focusing = false
	again := (ss.tab != tab || ss.pane != pane) && ss.conn == conn
	ss.mu.Unlock()
	if err != nil {
		ss.notify("notice", map[string]any{"code": "tab_focus", "detail": err.Error()})
	}
	if again {
		ss.ensureTab()
	}
}

// event runs on the connection's receiving goroutine.
func (ss *surfSession) event(e endpoint.Event) {
	o := ss.owner()
	switch {
	case e.Snapshot != nil:
		if o != nil {
			o.sendJSON(map[string]any{"t": "surf.tab", "m": ss.m, "gen": ss.gen, "tab": e.Snapshot.FocusedTabID, "ws": e.Snapshot.FocusedWorkspaceID})
		}
		go ss.ensureTab()
	case e.Surface != nil:
		if o != nil {
			ss.sendMeta(o, e.Surface, true)
			o.enqueue(outMsg{binary: true, data: encodeFull(ss.gen, e.Surface)})
		}
	case e.Patch != nil:
		if o != nil {
			ss.sendMeta(o, e.Current, false)
			o.enqueue(outMsg{binary: true, data: encodePatch(ss.gen, e.Moves, e.Patch)})
		}
	case e.Clipboard != nil:
		// The browser asks the user before writing its clipboard.
		if o != nil && !o.readOnly && len(*e.Clipboard) <= maxClipboard {
			o.sendJSON(map[string]any{"t": "clip", "m": ss.m, "data": *e.Clipboard})
		}
	case e.Bell > 0:
		if o != nil {
			o.sendJSON(map[string]any{"t": "bell", "m": ss.m})
		}
	case e.Error != "":
		ss.notify("notice", map[string]any{"code": "herdr_error", "detail": e.Error})
	}
}

// resend gives a new owner the retained surface.
func (ss *surfSession) resend() {
	conn := ss.connection()
	o := ss.owner()
	if conn == nil || o == nil {
		return
	}
	ss.notify("open", map[string]any{"version": conn.Welcome.ServerVersion})
	if tab := conn.Snapshot(); tab.FocusedTabID != "" {
		o.sendJSON(map[string]any{"t": "surf.tab", "m": ss.m, "gen": ss.gen, "tab": tab.FocusedTabID, "ws": tab.FocusedWorkspaceID})
	}
	conn.WithGrid(func(g *endpoint.Grid) {
		if g.Surface != nil {
			ss.sendMeta(o, g.Surface, true)
			o.enqueue(outMsg{binary: true, data: encodeFull(ss.gen, g.Surface)})
		}
	})
}

type surfMeta struct {
	T      string           `json:"t"`
	M      string           `json:"m"`
	Gen    uint32           `json:"gen"`
	W      uint16           `json:"w"`
	H      uint16           `json:"h"`
	Panes  []endpoint.Pane  `json:"panes"`
	Splits []endpoint.Split `json:"splits"`
	Links  []string         `json:"links"`
	Popup  string           `json:"popup,omitempty"`
}

// sendMeta sends pane geometry and modes when they changed.
func (ss *surfSession) sendMeta(o *wsClient, s *endpoint.Surface, force bool) {
	if s == nil {
		return
	}
	meta := surfMeta{T: "surf.meta", M: ss.m, Gen: ss.gen, W: s.Frame.W, H: s.Frame.H, Panes: s.Panes, Splits: s.Splits, Links: s.Frame.Links}
	if meta.Panes == nil {
		meta.Panes = []endpoint.Pane{}
	}
	if meta.Splits == nil {
		meta.Splits = []endpoint.Split{}
	}
	if meta.Links == nil {
		meta.Links = []string{}
	}
	if s.Popup != nil {
		meta.Popup = s.Popup.Title
	}
	b, err := json.Marshal(meta)
	if err != nil {
		return
	}
	ss.mu.Lock()
	same := !force && string(b) == string(ss.lastMeta)
	ss.lastMeta = b
	ss.mu.Unlock()
	if !same {
		o.enqueue(outMsg{data: b})
	}
}

// Binary surface messages to the browser (little endian):
//
//	kind u8 (1 full, 2 patch) | gen u32 | width u16 | height u16 |
//	cursor: flags u8 (bit0 present, bit1 visible), x u16, y u16, shape u8 |
//	moves u16, each x,y,w,h u16 + shift i16 |
//	spans u32, each x u16, y u16, n u16, then n cells
//
// A cell is: symbol length u8 + UTF-8 bytes, fg u32, bg u32, modifier u16,
// flags u8 (bit0 skip, bit1 link) and, with a link, its index u16.
const (
	binFull  = 1
	binPatch = 2
)

func header(kind byte, gen uint32, w, h uint16, c *endpoint.Cursor, moves []endpoint.RowMove, spans int) []byte {
	b := make([]byte, 0, 64)
	b = append(b, kind)
	b = binary.LittleEndian.AppendUint32(b, gen)
	b = binary.LittleEndian.AppendUint16(b, w)
	b = binary.LittleEndian.AppendUint16(b, h)
	if c != nil {
		f := byte(1)
		if c.Visible {
			f |= 2
		}
		b = append(b, f)
		b = binary.LittleEndian.AppendUint16(b, c.X)
		b = binary.LittleEndian.AppendUint16(b, c.Y)
		b = append(b, c.Shape)
	} else {
		b = append(b, 0, 0, 0, 0, 0, 0)
	}
	b = binary.LittleEndian.AppendUint16(b, uint16(len(moves)))
	for _, m := range moves {
		for _, v := range []uint16{m.Rect.X, m.Rect.Y, m.Rect.W, m.Rect.H, uint16(m.Shift)} {
			b = binary.LittleEndian.AppendUint16(b, v)
		}
	}
	return binary.LittleEndian.AppendUint32(b, uint32(spans))
}

func appendCells(b []byte, cells []endpoint.Cell) []byte {
	for _, c := range cells {
		sym := c.Symbol
		if len(sym) > 255 {
			sym = sym[:0]
		}
		b = append(b, byte(len(sym)))
		b = append(b, sym...)
		b = binary.LittleEndian.AppendUint32(b, c.Fg)
		b = binary.LittleEndian.AppendUint32(b, c.Bg)
		b = binary.LittleEndian.AppendUint16(b, c.Mod)
		var f byte
		if c.Skip {
			f |= 1
		}
		if c.HasLink && c.Link <= 0xffff {
			f |= 2
		}
		b = append(b, f)
		if f&2 != 0 {
			b = binary.LittleEndian.AppendUint16(b, uint16(c.Link))
		}
	}
	return b
}

func appendSpan(b []byte, x, y uint16, cells []endpoint.Cell) []byte {
	b = binary.LittleEndian.AppendUint16(b, x)
	b = binary.LittleEndian.AppendUint16(b, y)
	b = binary.LittleEndian.AppendUint16(b, uint16(len(cells)))
	return appendCells(b, cells)
}

func encodeFull(gen uint32, s *endpoint.Surface) []byte {
	w, h := s.Frame.W, s.Frame.H
	b := header(binFull, gen, w, h, s.Frame.Cursor, nil, int(h))
	for y := uint16(0); y < h; y++ {
		row := s.Frame.Cells[int(y)*int(w) : int(y+1)*int(w)]
		b = appendSpan(b, 0, y, row)
	}
	return b
}

func encodePatch(gen uint32, moves []endpoint.RowMove, p *endpoint.Patch) []byte {
	b := header(binPatch, gen, 0, 0, p.Cursor, moves, len(p.Rows))
	for _, r := range p.Rows {
		b = appendSpan(b, r.X, r.Y, r.Cells)
	}
	return b
}
