package server

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/hc"
	"herdr-ide/internal/machines"
)

// Terminals of the machines' terminal cores (herdr-core, feature 21) for
// clients that draw terminals themselves: the WebSocket /api/v1/term carries
// calls and events as JSON text frames and terminal bytes as binary frames
// [stream u32 LE][kind u8][payload].

// Binary frame kinds, as herdr-core numbers them.
const (
	termData      = 0 // output to the client, input from it
	termAutomatic = 6 // from the client: its terminal's own answers
	termResize    = 3 // to the client: cols u16 LE, rows u16 LE
)

// Backend states and the codes of a backend that is not ready.
const (
	termStarting = "starting"
	termReady    = "ready"
	termError    = "error"

	termCodeOffline    = "machine_offline"
	termCodeNotBundled = "not_bundled"
	termCodeNotRunning = "not_running"
	termCodeInstall    = "install_failed"
	termCodeStart      = "start_failed"
	termCodeConnect    = "connect_failed"
	termCodeLost       = "disconnected"
)

// termIdle is how long a backend's connection stays without clients.
const termIdle = 10 * time.Second

// termReadMethods may be called by every client, termWriteMethods by
// writable ones. Methods that reach beyond terminals and documents (files,
// commands, other machines, the core itself) are not offered.
var (
	termReadMethods = map[string]bool{
		"terminal.list": true, "terminal.get": true, "terminal.read": true,
		"doc.get": true, "templates.list": true,
	}
	termWriteMethods = map[string]bool{
		"terminal.run": true, "terminal.kill": true, "terminal.rm": true,
		"terminal.keep": true, "terminal.label": true, "terminal.interrupt": true,
		"doc.set": true,
	}
)

type termHub struct {
	s        *Server
	mu       sync.Mutex
	backends map[string]*termBackend
}

// termBackend is the core's connection to one machine's terminal core,
// shared by the clients that subscribed to the machine.
type termBackend struct {
	s  *Server
	id string

	mu      sync.Mutex
	conn    *hc.Conn
	state   string
	code    string
	version string
	terms   map[string]map[string]any // by address, as the core reports them
	subs    map[*termClient]bool
	stop    context.CancelFunc
	wake    chan struct{}
	idle    *time.Timer
}

func (h *termHub) backend(id string) *termBackend {
	h.mu.Lock()
	defer h.mu.Unlock()
	b := h.backends[id]
	if b == nil {
		b = &termBackend{s: h.s, id: id, state: termStarting, subs: map[*termClient]bool{}, wake: make(chan struct{}, 1)}
		h.backends[id] = b
	}
	return b
}

// wakeUp ends a backend's wait before its next try (its machine connected).
func (h *termHub) wakeUp(id string) {
	h.mu.Lock()
	b := h.backends[id]
	h.mu.Unlock()
	if b != nil {
		select {
		case b.wake <- struct{}{}:
		default:
		}
	}
}

func (b *termBackend) stateMsg() map[string]any {
	return map[string]any{"t": "backend", "m": b.id, "state": b.state, "code": b.code, "version": b.version}
}

func (b *termBackend) snapshotMsg() map[string]any {
	list := make([]map[string]any, 0, len(b.terms))
	for _, t := range b.terms {
		list = append(list, t)
	}
	return map[string]any{"t": "snapshot", "m": b.id, "terminals": list}
}

// subscribe adds c and tells it the backend's state and, when it is ready,
// its terminals; the first subscriber starts the backend.
func (b *termBackend) subscribe(c *termClient) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.subs[c] {
		return
	}
	b.subs[c] = true
	if b.idle != nil {
		b.idle.Stop()
		b.idle = nil
	}
	c.sendJSON(b.stateMsg())
	if b.state == termReady {
		c.sendJSON(b.snapshotMsg())
	}
	if b.stop == nil {
		ctx, cancel := context.WithCancel(context.Background())
		b.stop = cancel
		go b.run(ctx)
	}
}

// unsubscribe removes c; a backend without clients closes its connection
// after termIdle. The terminal core and its programs keep running.
func (b *termBackend) unsubscribe(c *termClient) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.subs[c] {
		return
	}
	delete(b.subs, c)
	if len(b.subs) > 0 || b.stop == nil {
		return
	}
	b.idle = time.AfterFunc(termIdle, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if len(b.subs) == 0 && b.stop != nil {
			b.stop()
			b.stop = nil
		}
	})
}

func (b *termBackend) setState(state, code string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if state != termReady {
		b.conn, b.terms = nil, nil
	}
	if b.state == state && b.code == code {
		return
	}
	b.state, b.code = state, code
	for c := range b.subs {
		c.sendJSON(b.stateMsg())
	}
}

func (b *termBackend) run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		code := b.serve(ctx)
		if ctx.Err() != nil {
			break
		}
		b.setState(termError, code)
		if time.Since(start) > 30*time.Second {
			backoff = time.Second
		}
		select {
		case <-ctx.Done():
		case <-b.wake:
			backoff = time.Second
		case <-time.After(backoff):
			backoff = min(backoff*2, 16*time.Second)
		}
	}
	b.mu.Lock()
	b.conn, b.terms, b.state, b.code = nil, nil, termStarting, ""
	b.mu.Unlock()
}

// ensure makes the machine's terminal core run the executable this build
// carries and returns once it answers. A read-only core installs and starts
// nothing: it uses a core that already runs.
func (b *termBackend) ensure(ctx context.Context, mc *machines.Machine) (code string) {
	sess := mc.Session()
	info := mc.State().Info
	if sess == nil || info == nil {
		return termCodeOffline
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	rep, err := sess.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "status"})
	if err != nil || rep.HC == nil {
		return termCodeOffline
	}
	st := rep.HC
	readOnly := b.s.opts.ReadOnly
	var gz []byte
	var digest string
	if b.s.opts.HC != nil {
		gz, digest, _ = b.s.opts.HC(info.OS, info.Arch)
	}
	installed := false
	if digest != "" && st.Digest != digest && !readOnly {
		conn, _, err := sess.Open(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "install", Digest: digest})
		if err != nil {
			return termCodeInstall
		}
		cw := agentproto.ChunkWriter{W: conn}
		_, err = cw.Write(gz)
		if err == nil {
			err = cw.Finish()
		}
		var r agentproto.Reply
		if err == nil {
			err = agentproto.ReadLine(conn, &r)
		}
		conn.Close()
		if err != nil || !r.OK || r.HC == nil {
			b.s.logger.Printf("term %s: install: %v %s", b.id, err, r.Error)
			return termCodeInstall
		}
		b.s.audit.log(nil, "term.install", map[string]any{"machine": b.id, "digest": digest})
		st, installed = r.HC, true
	}
	if st.Digest == "" && !st.Running {
		return termCodeNotBundled
	}
	action := ""
	switch {
	case !st.Running:
		action = "start"
	case installed:
		// The running core is from another build: its successor adopts the
		// programs, which keep running.
		action = "restart"
	}
	if action == "" {
		return ""
	}
	if readOnly {
		return termCodeNotRunning
	}
	rep, err = sess.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: action})
	if err != nil || rep.HC == nil || !rep.HC.Running {
		msg := ""
		if rep != nil {
			msg = rep.Error
		}
		b.s.logger.Printf("term %s: %s: %v %s", b.id, action, err, msg)
		return termCodeStart
	}
	b.s.audit.log(nil, "term."+action, map[string]any{"machine": b.id, "version": rep.HC.Version})
	return ""
}

// serve connects to the machine's terminal core and forwards its events
// until the connection ends; it returns the code of why.
func (b *termBackend) serve(ctx context.Context) (code string) {
	mc := b.s.mg.Get(b.id)
	if mc == nil {
		return termCodeOffline
	}
	b.setState(termStarting, "")
	if code := b.ensure(ctx, mc); code != "" {
		return code
	}
	dctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	nc, _, err := mc.Open(dctx, agentproto.Header{Op: agentproto.OpHCAPI})
	if err != nil {
		return termCodeConnect
	}
	conn, hello, err := hc.Dial(dctx, nc)
	if err != nil {
		b.s.logger.Printf("term %s: %v", b.id, err)
		return termCodeConnect
	}
	defer conn.Close()
	events, snap, err := conn.SubscribeRaw(dctx, hc.SubscribeParams{})
	if err != nil {
		return termCodeConnect
	}
	b.mu.Lock()
	b.conn, b.version, b.state, b.code = conn, hello.Version, termReady, ""
	b.terms = indexTerminals(snap)
	for c := range b.subs {
		c.sendJSON(b.stateMsg())
		c.sendJSON(b.snapshotMsg())
	}
	b.mu.Unlock()

	for {
		// The core sends a heartbeat every 15 s without events.
		rctx, cancel := context.WithTimeout(ctx, 45*time.Second)
		n, err := events.Recv(rctx)
		cancel()
		if err != nil {
			return termCodeLost
		}
		b.event(n)
	}
}

func indexTerminals(list []map[string]any) map[string]map[string]any {
	out := make(map[string]map[string]any, len(list))
	for _, t := range list {
		if addr, _ := t["address"].(string); addr != "" {
			out[addr] = t
		}
	}
	return out
}

// event applies a notification to the backend's terminals, as herdr-core's
// API describes for each type, and forwards it to the subscribers.
func (b *termBackend) event(n hc.RawNotification) {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch n.Method {
	case "missed":
		b.terms = indexTerminals(n.Terminals)
		for c := range b.subs {
			c.sendJSON(b.snapshotMsg())
		}
		return
	case "event":
	default:
		return
	}
	var data map[string]any
	json.Unmarshal(n.Data, &data)
	if n.Terminal != "" {
		t := b.terms[n.Terminal]
		switch n.Type {
		case "created", "restarted":
			b.terms[n.Terminal] = data
		case "removed":
			delete(b.terms, n.Terminal)
		case "labels":
			if rec, ok := data["record"].(map[string]any); ok {
				b.terms[n.Terminal] = rec
			} else if t != nil {
				t["labels"] = data["labels"]
			}
		case "turn":
			if t != nil {
				t["turn"] = data["turn"]
			}
		default: // lost, keep, finished, status, title, size, foreground
			if t == nil {
				break
			}
			if n.Type == "foreground" {
				t["foreground"] = data
				if n.Data == nil || string(n.Data) == "null" {
					delete(t, "foreground")
				}
				break
			}
			for k, v := range data {
				t[k] = v
			}
			switch n.Type {
			case "finished":
				t["state"] = "finished"
				delete(t, "foreground")
			case "lost":
				delete(t, "pid")
				delete(t, "foreground")
			}
		}
	}
	msg := map[string]any{"t": "event", "m": b.id, "type": n.Type, "data": json.RawMessage(n.Data)}
	if n.Terminal != "" {
		msg["terminal"] = n.Terminal
	}
	if len(n.Data) == 0 {
		delete(msg, "data")
	}
	for c := range b.subs {
		c.sendJSON(msg)
	}
}

// connection returns the backend's connection when it is ready.
func (b *termBackend) connection() *hc.Conn {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.conn
}

// termIn is any text message from a terminal client.
type termIn struct {
	T   string `json:"t"`
	RID int64  `json:"rid"`
	M   string `json:"m"`
	S   uint32 `json:"s"`

	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`

	Terminal string      `json:"terminal"`
	Cols     int         `json:"cols"`
	Rows     int         `json:"rows"`
	History  int         `json:"history"`
	Observe  bool        `json:"observe"`
	Display  *hc.Display `json:"display"`
	Focused  bool        `json:"focused"`
	N        int         `json:"n"`
}

type termStream struct {
	st      *hc.Stream
	observe bool
}

type termClient struct {
	s        *Server
	conn     *websocket.Conn
	ctx      context.Context
	cancel   context.CancelFunc
	send     chan outMsg
	req      *http.Request
	readOnly bool

	mu      sync.Mutex
	next    uint32
	streams map[uint32]*termStream
	subs    map[string]*termBackend
}

func (c *termClient) enqueue(m outMsg) {
	select {
	case c.send <- m:
	case <-c.ctx.Done():
	default:
		// Output is credited (a stream has at most 256 KiB on its way), so
		// a full queue is a client that stopped reading.
		c.s.logger.Printf("term: client send queue overflow, disconnecting")
		c.cancel()
	}
}

func (c *termClient) sendJSON(v any) {
	if b, err := json.Marshal(v); err == nil {
		c.enqueue(outMsg{data: b})
	}
}

func (c *termClient) fail(rid int64, kind, message string) {
	c.sendJSON(map[string]any{"t": "res", "rid": rid, "error": map[string]string{"kind": kind, "message": message}})
}

func (c *termClient) failErr(rid int64, err error) {
	var e *hc.Error
	if errors.As(err, &e) {
		c.fail(rid, e.Kind, e.Message)
		return
	}
	c.fail(rid, "unavailable", "")
}

func (s *Server) handleTermWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // Origin is verified by guard
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(16 << 20)
	ctx, cancel := context.WithCancel(context.Background())
	c := &termClient{s: s, conn: conn, ctx: ctx, cancel: cancel, send: make(chan outMsg, sendQueue), req: r,
		readOnly: s.opts.ReadOnly, streams: map[uint32]*termStream{}, subs: map[string]*termBackend{}}
	s.audit.log(r, "term.connect", nil)
	defer s.audit.log(r, "term.disconnect", nil)
	defer func() {
		cancel()
		c.mu.Lock()
		streams, subs := c.streams, c.subs
		c.streams, c.subs = nil, nil
		c.mu.Unlock()
		for _, ts := range streams {
			ts.st.Close()
		}
		for _, b := range subs {
			b.unsubscribe(c)
		}
		conn.Close(websocket.StatusNormalClosure, "")
	}()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case m := <-c.send:
				typ := websocket.MessageText
				if m.binary {
					typ = websocket.MessageBinary
				}
				wctx, wcancel := context.WithTimeout(ctx, 20*time.Second)
				err := conn.Write(wctx, typ, m.data)
				wcancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			c.input(data)
			continue
		}
		var m termIn
		if json.Unmarshal(data, &m) == nil {
			c.dispatch(&m)
		}
	}
}

// input forwards a binary frame from the client to its stream.
func (c *termClient) input(frame []byte) {
	if len(frame) < 5 || c.readOnly {
		return
	}
	c.mu.Lock()
	ts := c.streams[binary.LittleEndian.Uint32(frame)]
	c.mu.Unlock()
	if ts == nil || ts.observe {
		return
	}
	switch frame[4] {
	case termData:
		ts.st.Write(frame[5:])
	case termAutomatic:
		ts.st.WriteAutomatic(frame[5:])
	}
}

func (c *termClient) stream(id uint32) *termStream {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.streams[id]
}

func (c *termClient) dispatch(m *termIn) {
	switch m.T {
	case "ping":
		c.sendJSON(map[string]any{"t": "pong", "rid": m.RID})
	case "sub":
		if c.s.mg.Get(m.M) == nil {
			return
		}
		b := c.s.term.backend(m.M)
		c.mu.Lock()
		known := c.subs == nil || c.subs[m.M] != nil
		if !known {
			c.subs[m.M] = b
		}
		c.mu.Unlock()
		if !known {
			b.subscribe(c)
		}
	case "unsub":
		c.mu.Lock()
		b := c.subs[m.M]
		delete(c.subs, m.M)
		c.mu.Unlock()
		if b != nil {
			b.unsubscribe(c)
		}
	case "call":
		go c.call(m)
	case "attach":
		go c.attach(m)
	case "ack":
		if ts := c.stream(m.S); ts != nil {
			ts.st.Ack(m.N)
		}
	case "resize":
		if ts := c.stream(m.S); ts != nil && !ts.observe {
			ts.st.Resize(m.Cols, m.Rows)
		}
	case "focus":
		if ts := c.stream(m.S); ts != nil && !ts.observe {
			ts.st.Focus(m.Focused)
		}
	case "facts":
		if ts := c.stream(m.S); ts != nil && !ts.observe && m.Display != nil {
			ts.st.Facts(*m.Display)
		}
	case "detach":
		c.mu.Lock()
		ts := c.streams[m.S]
		delete(c.streams, m.S)
		c.mu.Unlock()
		if ts != nil {
			ts.st.Close()
		}
	}
}

// subscribed returns the ready connection of a machine the client
// subscribed to.
func (c *termClient) subscribed(m string) *hc.Conn {
	c.mu.Lock()
	b := c.subs[m]
	c.mu.Unlock()
	if b == nil {
		return nil
	}
	return b.connection()
}

func (c *termClient) call(m *termIn) {
	write := termWriteMethods[m.Method]
	if !write && !termReadMethods[m.Method] {
		c.s.audit.log(c.req, "denied.term", map[string]any{"machine": m.M, "method": m.Method})
		c.fail(m.RID, "refused", "")
		return
	}
	if write && c.readOnly {
		c.fail(m.RID, "read_only", "")
		return
	}
	params := map[string]json.RawMessage{}
	if len(m.Params) > 0 && json.Unmarshal(m.Params, &params) != nil {
		c.fail(m.RID, "usage", "")
		return
	}
	// "on" would address a machine the terminal core itself added.
	if _, other := params["on"]; other {
		c.fail(m.RID, "refused", "")
		return
	}
	conn := c.subscribed(m.M)
	if conn == nil {
		c.fail(m.RID, "unavailable", "")
		return
	}
	switch m.Method {
	case "terminal.run", "terminal.kill", "terminal.rm":
		c.s.audit.log(c.req, m.Method, map[string]any{"machine": m.M, "terminal": params["terminal"], "argv": params["argv"]})
	}
	ctx, cancel := context.WithTimeout(c.ctx, 60*time.Second)
	defer cancel()
	var result json.RawMessage
	if err := conn.Call(ctx, m.Method, params, &result); err != nil {
		c.failErr(m.RID, err)
		return
	}
	c.sendJSON(map[string]any{"t": "res", "rid": m.RID, "result": result})
}

func (c *termClient) attach(m *termIn) {
	conn := c.subscribed(m.M)
	if conn == nil {
		c.fail(m.RID, "unavailable", "")
		return
	}
	observe := m.Observe || c.readOnly
	ctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
	defer cancel()
	st, a, err := conn.Attach(ctx, hc.AttachParams{
		Terminal: m.Terminal, Cols: m.Cols, Rows: m.Rows, History: m.History,
		Observe: observe, ResizeNotifications: observe, Display: m.Display,
	})
	if err != nil {
		c.failErr(m.RID, err)
		return
	}
	c.mu.Lock()
	if c.streams == nil { // the client left meanwhile
		c.mu.Unlock()
		st.Close()
		return
	}
	c.next++
	id := c.next
	c.streams[id] = &termStream{st: st, observe: observe}
	// The reply is queued before the stream's first frame.
	c.sendJSON(map[string]any{"t": "attached", "rid": m.RID, "s": id, "terminal": m.Terminal,
		"cols": a.Terminal.Cols, "rows": a.Terminal.Rows, "observe": observe, "automatic": a.AutomaticInput})
	c.mu.Unlock()
	go c.pump(id, st)
}

// pump forwards a stream's output to the client until it ends. The client
// returns credit with "ack" as it draws, which reaches the terminal core.
func (c *termClient) pump(id uint32, st *hc.Stream) {
	head := binary.LittleEndian.AppendUint32(nil, id)
	for {
		o, err := st.Recv(c.ctx)
		if err != nil {
			c.mu.Lock()
			_, open := c.streams[id]
			delete(c.streams, id)
			c.mu.Unlock()
			if !open {
				return // detached, or the client left
			}
			msg := map[string]any{"t": "closed", "s": id, "reason": termCodeLost}
			if x := st.Exit(); err == io.EOF && x != nil {
				msg["reason"], msg["exit_code"], msg["signal"] = x.Reason, x.ExitCode, x.Signal
			}
			c.sendJSON(msg)
			return
		}
		var frame []byte
		if o.Data == nil {
			frame = append(append(make([]byte, 0, 9), head...), termResize)
			frame = binary.LittleEndian.AppendUint16(frame, uint16(o.Cols))
			frame = binary.LittleEndian.AppendUint16(frame, uint16(o.Rows))
		} else {
			frame = append(append(make([]byte, 0, 5+len(o.Data)), head...), termData)
			frame = append(frame, o.Data...)
		}
		c.enqueue(outMsg{binary: true, data: frame})
	}
}
