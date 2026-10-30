package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"herdr-ide/internal/herdr"
	"herdr-ide/internal/machines"
)

// inMsg is any message from the browser.
type inMsg struct {
	T    string `json:"t"`
	SID  uint32 `json:"sid"`
	M    string `json:"m"`
	Pane string `json:"pane"`

	Cols     int    `json:"cols"`
	Rows     int    `json:"rows"`
	CellW    int    `json:"cw"`
	CellH    int    `json:"ch"`
	Mode     string `json:"mode"`
	Takeover bool   `json:"takeover"`

	D string `json:"d"`
	B []byte `json:"b"`

	Dir    string `json:"dir"`
	Lines  int    `json:"lines"`
	Col    *int   `json:"col"`
	Row    *int   `json:"row"`
	Mods   int    `json:"mods"`
	Action string `json:"action"`
	Button string `json:"button"`

	// theme: "dark" or "light"
	Kind string `json:"kind"`

	RID    int64           `json:"rid"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type outMsg struct {
	binary bool
	data   []byte
}

type wsClient struct {
	s      *Server
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	send   chan outMsg
	// req is the upgrade request (identity for the audit log).
	req *http.Request

	mu      sync.Mutex
	viewers map[uint32]*viewer
}

const sendQueue = 8192

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin is verified by guard (which also knows the proxy origins).
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionContextTakeover,
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(64 << 20)
	ctx, cancel := context.WithCancel(context.Background())
	c := &wsClient{s: s, conn: conn, ctx: ctx, cancel: cancel, send: make(chan outMsg, sendQueue), viewers: map[uint32]*viewer{}, req: r}
	s.audit.log(r, "ws.connect", nil)
	defer s.audit.log(r, "ws.disconnect", nil)
	defer c.close()
	s.clientsMu.Lock()
	s.clients[c] = true
	s.clientsMu.Unlock()
	defer func() {
		s.clientsMu.Lock()
		delete(s.clients, c)
		s.clientsMu.Unlock()
	}()

	go c.writeLoop()
	c.sendJSON(map[string]any{"t": "machines", "list": s.mg.States()})
	unsub := s.mg.Subscribe(func(st machines.State) {
		c.sendJSON(map[string]any{"t": "machine", "state": st})
	}, func(ev machines.AgentEvent) {
		c.sendJSON(map[string]any{"t": "agent", "m": ev.Machine, "data": ev.Data})
	})
	defer unsub()

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var m inMsg
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		c.dispatch(&m)
	}
}

func (c *wsClient) close() {
	c.cancel()
	c.mu.Lock()
	viewers := c.viewers
	c.viewers = map[uint32]*viewer{}
	c.mu.Unlock()
	for _, v := range viewers {
		c.s.leave(v)
	}
	c.conn.Close(websocket.StatusNormalClosure, "")
}

func (c *wsClient) writeLoop() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case m := <-c.send:
			typ := websocket.MessageText
			if m.binary {
				typ = websocket.MessageBinary
			}
			ctx, cancel := context.WithTimeout(c.ctx, 20*time.Second)
			err := c.conn.Write(ctx, typ, m.data)
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		}
	}
}

func (c *wsClient) enqueue(m outMsg) {
	select {
	case c.send <- m:
	case <-c.ctx.Done():
	default:
		// A client this far behind cannot be repaired by dropping frames
		// (they are diffs); drop the connection so it resyncs from scratch.
		c.s.logger.Printf("ws: client send queue overflow, disconnecting")
		c.cancel()
	}
}

func (c *wsClient) sendJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	c.enqueue(outMsg{data: b})
}

func (c *wsClient) viewer(sid uint32) *viewer {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.viewers[sid]
}

func (c *wsClient) dispatch(m *inMsg) {
	switch m.T {
	case "attach":
		c.attach(m)
	case "detach":
		c.mu.Lock()
		v := c.viewers[m.SID]
		delete(c.viewers, m.SID)
		c.mu.Unlock()
		if v != nil {
			c.s.leave(v)
		}
	case "claim":
		if c.s.opts.ReadOnly {
			return
		}
		if v := c.viewer(m.SID); v != nil {
			if m.Cols > 0 && m.Rows > 0 {
				c.s.resize(v, m.Cols, m.Rows, m.CellW, m.CellH)
			}
			c.s.claim(v)
		}
	case "resize":
		if v := c.viewer(m.SID); v != nil && m.Cols > 0 && m.Rows > 0 {
			c.s.resize(v, m.Cols, m.Rows, m.CellW, m.CellH)
		}
	case "in", "inb", "scroll", "mouse":
		if v := c.viewer(m.SID); v != nil {
			c.s.command(v, m)
		}
	case "api":
		go c.api(m)
	case "retry":
		if mc := c.s.mg.Get(m.M); mc != nil {
			mc.Retry()
		}
	case "ping":
		c.sendJSON(map[string]any{"t": "pong", "rid": m.RID})
	case "theme":
		// VS Code windows follow the theme chosen in the browser; watchers
		// cannot use VS Code and do not change it.
		if !c.s.opts.ReadOnly {
			c.s.bridge.setTheme(m.Kind)
		}
	}
}

// attach starts (or restarts) the viewer for sid. mode "observe" never
// takes control; anything else lets the arbiter decide.
func (c *wsClient) attach(m *inMsg) {
	if m.M == "" || m.Pane == "" {
		return
	}
	c.mu.Lock()
	old := c.viewers[m.SID]
	delete(c.viewers, m.SID)
	c.mu.Unlock()
	if old != nil {
		c.s.leave(old)
	}
	if c.ctx.Err() != nil {
		return
	}
	v := &viewer{c: c, sid: m.SID, key: paneKey{m.M, m.Pane}, cols: m.Cols, rows: m.Rows, cellW: m.CellW, cellH: m.CellH}
	c.mu.Lock()
	c.viewers[m.SID] = v
	c.mu.Unlock()
	observe := m.Mode == "observe" || c.s.opts.ReadOnly
	c.s.join(v, observe)
	if m.Takeover && !observe {
		c.s.claim(v)
	}
}

func (c *wsClient) api(m *inMsg) {
	reply := map[string]any{"t": "api.res", "rid": m.RID}
	mc := c.s.mg.Get(m.M)
	if mc == nil {
		reply["error"] = map[string]string{"code": "unknown_machine", "message": "unknown machine " + m.M}
		c.sendJSON(reply)
		return
	}
	if !c.s.apiAllowed(m.Method) {
		c.s.audit.log(c.req, "denied.api", map[string]any{"machine": m.M, "method": m.Method})
		reply["error"] = map[string]string{"code": "forbidden", "message": m.Method + " is not allowed from the web UI"}
		c.sendJSON(reply)
		return
	}
	if !machines.IsReadOnlyMethod(m.Method) {
		c.s.audit.log(c.req, "api", map[string]any{"machine": m.M, "method": m.Method, "params": json.RawMessage(m.Params)})
	}
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Minute)
	defer cancel()
	var params any = map[string]any{}
	if len(m.Params) > 0 && string(m.Params) != "null" {
		params = m.Params
	}
	res, err := mc.Call(ctx, m.Method, params)
	if err != nil {
		var ae *herdr.APIError
		if errors.As(err, &ae) {
			reply["error"] = ae
		} else {
			reply["error"] = map[string]string{"code": "transport", "message": err.Error()}
		}
	} else {
		reply["result"] = res
	}
	c.sendJSON(reply)
}

func readFullLine(r *bufio.Reader) ([]byte, error) {
	var out []byte
	for {
		chunk, err := r.ReadSlice('\n')
		if err == nil {
			if out == nil {
				return chunk, nil
			}
			return append(out, chunk...), nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			out = append(out, chunk...)
			continue
		}
		return nil, err
	}
}
