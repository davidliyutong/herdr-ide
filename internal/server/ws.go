package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
)

// /ws is the event channel of the clients (the browser UI and the desktop
// app's page and shell): machines, program windows, agents, settings,
// keybindings, the VS Code bridge and downloads. Terminals have their own
// WebSocket (/api/v1/term, term.go).

// inMsg is any message from a client.
type inMsg struct {
	T string `json:"t"`
	M string `json:"m"`

	// theme: "dark" or "light"
	Kind string `json:"kind"`

	// active: milliseconds since the user last used the page.
	Idle int64 `json:"idle"`

	// download.watch: the downloads the page follows; download.cancel: the
	// one it cancels.
	IDs []string `json:"ids"`
	ID  string   `json:"id"`

	RID int64 `json:"rid"`
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
	send   chan []byte
	// req is the upgrade request (identity for the audit log).
	req *http.Request
	// readOnly clients watch: they cannot make machines reconnect or change
	// VS Code's theme.
	readOnly bool
	// client is the kind of client of the page (clientOf its upgrade
	// request): VS Code's bridge messages reach it only while VS Code is
	// on for it.
	client plugin.Client

	// active is when the user last used this page (guarded by
	// Server.clientsMu); the most recently used page plays sounds. A client
	// plays none before it reports activity. activeSeq breaks same-tick ties.
	active    time.Time
	activeSeq uint64
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
	conn.SetReadLimit(1 << 20)
	ctx, cancel := context.WithCancel(context.Background())
	c := &wsClient{s: s, conn: conn, ctx: ctx, cancel: cancel, send: make(chan []byte, sendQueue), req: r, readOnly: s.opts.ReadOnly, client: s.clientOf(r)}
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
		s.forgetWatcher(c)
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
	c.conn.Close(websocket.StatusNormalClosure, "")
}

func (c *wsClient) writeLoop() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case b := <-c.send:
			ctx, cancel := context.WithTimeout(c.ctx, 20*time.Second)
			err := c.conn.Write(ctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		}
	}
}

func (c *wsClient) sendJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case c.send <- b:
	case <-c.ctx.Done():
	default:
		// A client this far behind has missed events; drop the connection
		// so that it reconnects and starts from the current state.
		c.s.logger.Printf("ws: client send queue overflow, disconnecting")
		c.cancel()
	}
}

func (c *wsClient) dispatch(m *inMsg) {
	switch m.T {
	case "retry":
		// Ends the wait before a machine's next connection attempt; not for
		// watchers, as an attempt may start an ssh login.
		mc := c.s.mg.Get(m.M)
		if mc == nil {
			break
		}
		if c.readOnly {
			c.s.audit.log(c.req, "denied.retry", map[string]any{"machine": m.M})
			break
		}
		mc.Wake()
	case "download.watch":
		// A page follows its own downloads, also in read-only mode, where
		// it may download.
		c.s.watchDownloads(c, m.IDs)
	case "download.cancel":
		c.s.cancelDownload(c, m.ID)
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
