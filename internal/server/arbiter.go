package server

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"net"
	"strings"
	"sync"
	"time"

	"herdr-ide/internal/agentproto"
)

// Pane arbitration across browsers.
//
// herdr allows one controller per pane; the controller's size becomes the
// PTY size. Among the browsers connected to this core, the most recently
// active one controls a pane and every other viewer gets its own observe
// stream at the controller's size (each stream starts with a full frame, so
// switching never shows a half-drawn screen). A viewer that types or clicks
// claims control; when the controller leaves, the most recently active
// remaining viewer takes over.

type paneKey struct{ m, pane string }

type paneState struct {
	controller       *viewer
	ctlCols, ctlRows int
	viewers          map[*viewer]bool
}

type viewer struct {
	c   *wsClient
	sid uint32
	key paneKey

	// guarded by Server.panesMu
	cols, rows int
	cellW      int
	cellH      int
	active     time.Time
	mode       string
	gen        uint64
	stream     *termStream
}

// termStream is one herdr terminal session stream.
type termStream struct {
	v    *viewer
	gen  uint64
	mode string
	conn net.Conn
	wmu  sync.Mutex
	once sync.Once
}

func (t *termStream) write(v any) {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	_ = t.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_ = agentproto.WriteLine(t.conn, v)
}

func (t *termStream) close() {
	t.once.Do(func() {
		// Closing the stream ends herdr's stdin, which releases control.
		t.conn.Close()
	})
}

func (s *Server) paneState(k paneKey) *paneState {
	ps := s.panes[k]
	if ps == nil {
		ps = &paneState{viewers: map[*viewer]bool{}}
		s.panes[k] = ps
	}
	return ps
}

// join registers a viewer and opens its stream (control if nobody controls).
func (s *Server) join(v *viewer, observeOnly bool) {
	s.panesMu.Lock()
	defer s.panesMu.Unlock()
	ps := s.paneState(v.key)
	ps.viewers[v] = true
	v.active = time.Now()
	if observeOnly {
		s.openLocked(v, "observe", v.cols, v.rows, false)
		return
	}
	if ps.controller == nil || ps.controller == v {
		s.controlLocked(ps, v)
		return
	}
	s.openLocked(v, "observe", ps.ctlCols, ps.ctlRows, false)
}

func (s *Server) controlLocked(ps *paneState, v *viewer) {
	ps.controller = v
	ps.ctlCols, ps.ctlRows = v.cols, v.rows
	s.openLocked(v, "control", v.cols, v.rows, true)
}

// claim makes v the controller of its pane.
func (s *Server) claim(v *viewer) {
	s.panesMu.Lock()
	defer s.panesMu.Unlock()
	ps := s.panes[v.key]
	if ps == nil || !ps.viewers[v] {
		return
	}
	v.active = time.Now()
	if ps.controller == v && v.mode == "control" {
		return
	}
	old := ps.controller
	s.controlLocked(ps, v)
	for o := range ps.viewers {
		if o != v && (o == old || o.mode == "observe") {
			s.openLocked(o, "observe", ps.ctlCols, ps.ctlRows, false)
		}
	}
}

// resize records a viewer's container size; the controller's size is sent to
// herdr and observers follow it.
func (s *Server) resize(v *viewer, cols, rows, cw, ch int) {
	s.panesMu.Lock()
	v.cols, v.rows, v.cellW, v.cellH = cols, rows, cw, ch
	ps := s.panes[v.key]
	if ps == nil || ps.controller != v || ps.ctlCols == cols && ps.ctlRows == rows {
		s.panesMu.Unlock()
		return
	}
	ps.ctlCols, ps.ctlRows = cols, rows
	var t *termStream
	if v.stream != nil && v.mode == "control" {
		t = v.stream
	}
	for o := range ps.viewers {
		if o != v && o.mode == "observe" {
			s.openLocked(o, "observe", cols, rows, false)
		}
	}
	s.panesMu.Unlock()
	// Network write outside panesMu: a stalled link must not freeze every
	// pane of every machine.
	if t != nil {
		t.write(map[string]any{"type": "terminal.resize", "cols": cols, "rows": rows, "cell_width_px": cw, "cell_height_px": ch})
	}
}

// leave removes a viewer; control passes to the most recently active one.
func (s *Server) leave(v *viewer) {
	s.panesMu.Lock()
	defer s.panesMu.Unlock()
	v.gen++
	if v.stream != nil {
		v.stream.close()
		v.stream = nil
	}
	ps := s.panes[v.key]
	if ps == nil {
		return
	}
	delete(ps.viewers, v)
	if ps.controller == v {
		ps.controller = nil
		var next *viewer
		for o := range ps.viewers {
			if next == nil || o.active.After(next.active) {
				next = o
			}
		}
		if next != nil {
			s.controlLocked(ps, next)
			for o := range ps.viewers {
				if o != next {
					s.openLocked(o, "observe", ps.ctlCols, ps.ctlRows, false)
				}
			}
		}
	}
	if len(ps.viewers) == 0 {
		delete(s.panes, v.key)
	}
}

// lostControl handles a takeover by someone outside this core: the viewer
// keeps watching at its own size. code is translated by the UI.
func (s *Server) lostControl(v *viewer, gen uint64, code string) {
	s.panesMu.Lock()
	defer s.panesMu.Unlock()
	if v.gen != gen {
		return
	}
	ps := s.panes[v.key]
	if ps != nil && ps.controller == v {
		ps.controller = nil
	}
	s.openLocked(v, "observe", v.cols, v.rows, false)
	v.c.sendJSON(map[string]any{"t": "term", "sid": v.sid, "ev": "notice", "code": code})
}

// openLocked replaces v's stream with a new one (asynchronously).
func (s *Server) openLocked(v *viewer, mode string, cols, rows int, takeover bool) {
	v.gen++
	gen := v.gen
	if v.stream != nil {
		v.stream.close()
		v.stream = nil
	}
	v.mode = mode
	if cols <= 0 || rows <= 0 {
		cols, rows = 80, 24
	}
	mc := s.mg.Get(v.key.m)
	c := v.c
	go func() {
		if mc == nil {
			c.sendJSON(map[string]any{"t": "term", "sid": v.sid, "ev": "error", "message": "unknown machine"})
			return
		}
		ctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
		conn, _, err := mc.Open(ctx, agentproto.Header{
			Op: agentproto.OpTerm, Mode: mode, Target: v.key.pane, Cols: cols, Rows: rows, Takeover: takeover,
		})
		cancel()
		s.panesMu.Lock()
		if v.gen != gen {
			s.panesMu.Unlock()
			if conn != nil {
				conn.Close()
			}
			return
		}
		if err != nil {
			s.panesMu.Unlock()
			c.sendJSON(map[string]any{"t": "term", "sid": v.sid, "ev": "error", "message": err.Error()})
			return
		}
		t := &termStream{v: v, gen: gen, mode: mode, conn: conn}
		v.stream = t
		s.panesMu.Unlock()
		c.sendJSON(map[string]any{"t": "term", "sid": v.sid, "ev": "open", "mode": mode, "cols": cols, "rows": rows})
		s.pump(t)
	}()
}

// command forwards input-like messages; input from an observer claims the
// pane first (the client queues its input until control is granted).
func (s *Server) command(v *viewer, m *inMsg) {
	s.panesMu.Lock()
	t := v.stream
	mode := v.mode
	v.active = time.Now()
	s.panesMu.Unlock()
	if t == nil || mode != "control" {
		return
	}
	switch m.T {
	case "in":
		if m.D != "" {
			t.write(map[string]any{"type": "terminal.input", "text": m.D})
		}
	case "inb":
		if len(m.B) > 0 {
			t.write(map[string]any{"type": "terminal.input", "bytes": m.B})
		}
	case "scroll":
		lines := m.Lines
		if lines <= 0 {
			lines = 1
		}
		cmd := map[string]any{"type": "terminal.scroll", "direction": m.Dir, "lines": lines, "modifiers": m.Mods}
		if m.Col != nil && m.Row != nil {
			cmd["column"] = *m.Col
			cmd["row"] = *m.Row
		}
		t.write(cmd)
	case "mouse":
		if m.Col == nil || m.Row == nil {
			return
		}
		button := m.Button
		if button == "" {
			button = "left"
		}
		t.write(map[string]any{"type": "terminal.mouse", "action": m.Action, "button": button, "column": *m.Col, "row": *m.Row, "modifiers": m.Mods})
	}
}

type frameLine struct {
	Type    string `json:"type"`
	Seq     uint64 `json:"seq"`
	Width   uint16 `json:"width"`
	Height  uint16 `json:"height"`
	Full    bool   `json:"full"`
	Bytes   []byte `json:"bytes"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

// pump forwards herdr frames as binary messages:
// [sid u32][flags u8][width u16][height u16][ansi bytes...].
func (s *Server) pump(t *termStream) {
	v := t.v
	c := v.c
	r := bufio.NewReaderSize(t.conn, 256<<10)
	reason := "closed"
	for {
		line, err := readFullLine(r)
		if err != nil {
			break
		}
		var f frameLine
		if err := json.Unmarshal(line, &f); err != nil {
			continue
		}
		switch f.Type {
		case "terminal.frame":
			s.panesMu.Lock()
			stale := v.gen != t.gen
			s.panesMu.Unlock()
			if stale {
				continue
			}
			buf := make([]byte, 9+len(f.Bytes))
			binary.BigEndian.PutUint32(buf[0:4], v.sid)
			if f.Full {
				buf[4] = 1
			}
			binary.BigEndian.PutUint16(buf[5:7], f.Width)
			binary.BigEndian.PutUint16(buf[7:9], f.Height)
			copy(buf[9:], f.Bytes)
			c.enqueue(outMsg{binary: true, data: buf})
		case "terminal.closed":
			reason = f.Reason
		case "agent.error":
			reason = f.Message
		}
	}
	t.close()
	s.panesMu.Lock()
	current := v.stream == t && v.gen == t.gen
	if current {
		v.stream = nil
	}
	s.panesMu.Unlock()
	if !current || c.ctx.Err() != nil {
		return
	}
	if t.mode == "control" && strings.Contains(reason, "taken over") {
		s.lostControl(v, t.gen, "taken_over")
		return
	}
	c.sendJSON(map[string]any{"t": "term", "sid": v.sid, "ev": "closed", "reason": reason})
}
