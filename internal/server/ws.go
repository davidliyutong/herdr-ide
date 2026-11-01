package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"herdr-ide/internal/herdr"
	"herdr-ide/internal/herdr/endpoint"
	"herdr-ide/internal/machines"
)

// inMsg is any message from the browser.
type inMsg struct {
	T    string `json:"t"`
	M    string `json:"m"`
	Pane string `json:"pane"`

	// view
	Tab  string `json:"tab"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
	CW   int    `json:"cw"`
	CH   int    `json:"ch"`

	// in: pane input events
	Ev []endpoint.InputEvent `json:"ev"`
	// focus
	Focused bool `json:"focused"`
	// host: the browser's terminal colors
	Host *hostMsg `json:"host"`

	// theme: "dark" or "light"
	Kind string `json:"kind"`

	// active: milliseconds since the user last used the page.
	Idle int64 `json:"idle"`

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
	// readOnly browsers watch: no input, and no takeover from a writable one.
	readOnly bool

	// active is when the user last used this page (guarded by
	// Server.clientsMu); the most recently used page plays sounds.
	active time.Time
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
	c := &wsClient{s: s, conn: conn, ctx: ctx, cancel: cancel, send: make(chan outMsg, sendQueue), req: r, readOnly: s.opts.ReadOnly}
	s.audit.log(r, "ws.connect", nil)
	defer s.audit.log(r, "ws.disconnect", nil)
	defer c.close()
	s.clientsMu.Lock()
	c.active = time.Now()
	s.clients[c] = true
	s.clientsMu.Unlock()
	defer func() {
		s.clientsMu.Lock()
		delete(s.clients, c)
		s.clientsMu.Unlock()
	}()

	go c.writeLoop()
	c.sendJSON(map[string]any{"t": "machines", "list": s.mg.States()})
	for _, st := range s.gui.States() {
		c.sendJSON(map[string]any{"t": "gui", "state": st})
	}
	unsub := s.mg.Subscribe(func(st machines.State) {
		c.sendJSON(map[string]any{"t": "machine", "state": st})
	}, func(ev machines.AgentEvent) {
		c.sendJSON(map[string]any{"t": "agent", "m": ev.Machine, "data": ev.Data, "sound": s.soundClient() == c})
	})
	defer unsub()
	s.surfJoin(c)

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
	c.s.surfLeave(c)
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

func (c *wsClient) dispatch(m *inMsg) {
	switch m.T {
	case "view":
		c.s.surfView(c, viewMsg{M: m.M, Tab: m.Tab, Pane: m.Pane, Cols: m.Cols, Rows: m.Rows, CW: m.CW, CH: m.CH})
	case "takeover":
		c.s.surfTakeover(c)
	case "in":
		c.s.surfInput(c, m.M, m.Pane, m.Ev)
	case "focus":
		c.s.surfFocus(c, m.M, m.Focused)
	case "host":
		if m.Host != nil {
			c.s.surfHost(c, *m.Host)
		}
	case "api":
		go c.api(m)
	case "retry":
		if mc := c.s.mg.Get(m.M); mc != nil {
			mc.Retry()
		}
	case "ping":
		c.sendJSON(map[string]any{"t": "pong", "rid": m.RID})
	case "active":
		c.s.markActive(c, time.Duration(m.Idle)*time.Millisecond)
	case "theme":
		// VS Code windows follow the theme chosen in the browser; watchers
		// cannot use VS Code and do not change it.
		if !c.readOnly {
			c.s.bridge.setTheme(m.Kind)
		}
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
	defer func() {
		// A malformed request must not take the core down.
		if r := recover(); r != nil {
			c.s.logger.Printf("api %s: %v", m.Method, r)
			reply["error"] = map[string]string{"code": "internal", "message": "internal error"}
			c.sendJSON(reply)
		}
	}()
	withEnv, added := c.s.withPaneEnv(mc, m.Method, m.Params)
	if !machines.IsReadOnlyMethod(m.Method) {
		ev := map[string]any{"machine": m.M, "method": m.Method, "params": json.RawMessage(m.Params)}
		if len(added) > 0 {
			ev["env_added"] = added
		}
		c.s.audit.log(c.req, "api", ev)
	}
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Minute)
	defer cancel()
	var params any = map[string]any{}
	if len(added) > 0 {
		params = withEnv
	} else if len(m.Params) > 0 && string(m.Params) != "null" {
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
