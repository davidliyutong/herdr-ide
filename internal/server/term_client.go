package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/hc"
)

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
	// conn is the connection it is attached through; stop ends its pump
	// without closing it.
	conn *hc.Conn
	stop context.CancelFunc
	// sizing is the backend that counts it as a stream setting its
	// terminal's size (termBackend.joined), nil for an observer: it is
	// handed back there whether or not the client still follows the
	// machine.
	sizing *termBackend
	// backend is the backend of the machine it was attached through, which
	// knows it while it lasts (termBackend.track), whether or not the
	// client still follows the machine.
	backend *termBackend
	// machine and terminal are what it shows (the terminal's address);
	// focused is the client's last focus report for it.
	machine, terminal string
	focused           bool
	// unacked is the output sent to the client that it has not returned as
	// credit; an ack returns at most this much (termClient.mu).
	unacked int64
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
			c.release(ts)
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
		// Credit for output the client was sent and has not returned yet,
		// no more: a client cannot make the terminal core send ahead of
		// what it draws.
		c.mu.Lock()
		ts := c.streams[m.S]
		n := 0
		if ts != nil && m.N > 0 {
			n = int(min(int64(m.N), ts.unacked))
			ts.unacked -= int64(n)
		}
		c.mu.Unlock()
		if n > 0 {
			ts.st.Ack(n)
		}
	case "resize":
		if ts := c.stream(m.S); ts != nil && !ts.observe {
			ts.st.Resize(m.Cols, m.Rows)
		}
	case "focus":
		// An observer's focus changes nothing: neither the terminal core's
		// viewer nor whether a finished turn counts as seen.
		ts := c.stream(m.S)
		if ts == nil || ts.observe {
			break
		}
		c.mu.Lock()
		ts.focused = m.Focused
		b := c.subs[ts.machine]
		c.mu.Unlock()
		ts.st.Focus(m.Focused)
		// Looking at a terminal whose turn ended has seen it.
		if m.Focused && b != nil {
			b.seen(ts.terminal)
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
			c.release(ts)
		}
	}
}

// release lets go of a stream the client no longer has (it detached, or
// left): an observer's is closed; one that set its terminal's size goes to
// the backend, which keeps the last one of a terminal attached
// (termBackend.left). The program is told the viewer's focus is gone,
// which herdr-core does not say for a viewer that stays.
func (c *termClient) release(ts *termStream) {
	ts.stop()
	ts.backend.untrack(ts)
	if ts.sizing == nil {
		ts.st.Close()
		return
	}
	if ts.focused {
		ts.st.Focus(false)
	}
	ts.sizing.left(ts.conn, ts.terminal, ts.st, true)
}

// subscribed returns the backend of a machine the client subscribed to and
// its connection when it is ready, nil otherwise.
func (c *termClient) subscribed(m string) (*termBackend, *hc.Conn) {
	c.mu.Lock()
	b := c.subs[m]
	c.mu.Unlock()
	if b == nil {
		return nil, nil
	}
	return b, b.connection()
}

// noTerminal answers a call or an attach that names a terminal that is
// none of the clients' (a hidden one, errHiddenTerm, or another machine's,
// errOtherMachine) as the terminal core answers for a terminal it does not
// have, and audits it with why.
func (c *termClient) noTerminal(m *termIn, method, param, target string, why error) {
	reason := "hidden"
	if errors.Is(why, errOtherMachine) {
		reason = "machine"
	}
	c.s.audit.log(c.req, "denied.term", map[string]any{"machine": m.M, "method": method, "param": param, "terminal": target, "reason": reason})
	if _, local, ok := strings.Cut(target, "/"); ok {
		target = local
	}
	c.fail(m.RID, "not_found", "no terminal "+strconv.Quote(target))
}

// targetParams are the parameters by which a call of the allowlist names a
// terminal: the one it acts on, who calls, and a new terminal's parent.
var targetParams = []string{"terminal", "caller", "parent"}

// stringMap reports whether raw is a JSON object of strings, as the
// terminal core reads labels: null, an array, a value of another type, or
// an object with a value that is not a string (null included) is not.
func stringMap(raw json.RawMessage) bool {
	var m map[string]json.RawMessage
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' || json.Unmarshal(raw, &m) != nil {
		return false
	}
	for _, v := range m {
		var s string
		if len(v) == 0 || v[0] != '"' || json.Unmarshal(v, &s) != nil {
			return false
		}
	}
	return true
}

// checkTargets answers a call that would reach a terminal that is none of
// the clients' or make a hidden one, and reports whether it did; otherwise
// it names each terminal the call names by its address (resolve). Labels
// that are not an object of strings are refused as the terminal core would
// (usage): what the core reads is what was checked. A run or a label that
// sets the hidden label, or a run that takes the chat host's name, is
// refused, and so is a call that names a hidden terminal or another
// machine's, as its terminal, as who calls or as a new terminal's parent
// (answered as for a terminal that does not exist). None of these reaches
// the terminal core; a target the backend does not know is looked up
// there (terminal.get) before.
func (c *termClient) checkTargets(ctx context.Context, b *termBackend, conn *hc.Conn, m *termIn, params map[string]json.RawMessage) bool {
	raw, hasLabels := params["labels"]
	if hasLabels && !stringMap(raw) {
		c.fail(m.RID, "usage", "")
		return true
	}
	if m.Method == "terminal.run" || m.Method == "terminal.label" {
		var labels map[string]string
		var name string
		json.Unmarshal(raw, &labels)
		json.Unmarshal(params["name"], &name)
		param := ""
		if _, set := labels[agentproto.HiddenLabel]; set {
			param = "labels"
		} else if name == agentproto.ChatHostName {
			param = "name"
		}
		if param != "" {
			c.s.audit.log(c.req, "denied.term", map[string]any{"machine": m.M, "method": m.Method, "param": param})
			c.fail(m.RID, "refused", "")
			return true
		}
	}
	for _, param := range targetParams {
		var target string
		raw := bytes.TrimSpace(params[param])
		if string(raw) == "null" || json.Unmarshal(raw, &target) != nil {
			continue // absent, or not a terminal the core takes
		}
		addr, err := b.resolve(ctx, conn, target)
		switch {
		case errors.Is(err, errHiddenTerm) || errors.Is(err, errOtherMachine):
			c.noTerminal(m, m.Method, param, target, err)
			return true
		case err != nil:
			c.failErr(m.RID, err)
			return true
		case addr != target:
			params[param], _ = json.Marshal(addr)
		}
	}
	return false
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
		c.s.audit.log(c.req, "denied.term", map[string]any{"machine": m.M, "method": m.Method, "param": "on"})
		c.fail(m.RID, "refused", "")
		return
	}
	if c.readOnly && m.Method == "terminal.read" {
		readScreenOnly(params)
	}
	b, conn := c.subscribed(m.M)
	if conn == nil {
		c.fail(m.RID, "unavailable", "")
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 60*time.Second)
	defer cancel()
	if c.checkTargets(ctx, b, conn, m, params) {
		return
	}
	ev := map[string]any{"machine": m.M, "terminal": params["terminal"], "argv": params["argv"]}
	if m.Method == "terminal.run" {
		// The audit entry names the variables the client gave, not their
		// values, which may be secrets.
		var given map[string]string
		if raw, set := params["env"]; set && json.Unmarshal(raw, &given) != nil {
			c.fail(m.RID, "usage", "")
			return
		}
		if len(given) > 0 {
			ev["client_env"] = slices.Sorted(maps.Keys(given))
		}
		ev["cwd"] = params["cwd"]
		// New programs get the machine's virtual display (feature 14); its
		// variables replace any the client gave, so a client cannot point
		// them elsewhere.
		if mc := c.s.mg.Get(m.M); mc != nil {
			var added []string
			if env := c.s.displayEnv(mc); len(env) > 0 {
				names, ok := addEnv(params, env, true)
				if !ok {
					c.fail(m.RID, "usage", "")
					return
				}
				added = names
			}
			// Programs on an ssh machine learn that their terminal is shown
			// elsewhere (sshEnv); what the client gave stays.
			if env := c.s.sshEnv(mc); len(env) > 0 {
				names, ok := addEnv(params, env, false)
				if !ok {
					c.fail(m.RID, "usage", "")
					return
				}
				added = append(added, names...)
			}
			if len(added) > 0 {
				sort.Strings(added)
				ev["env"] = added
			}
		}
	}
	switch m.Method {
	case "terminal.run", "terminal.kill", "terminal.rm", "terminal.interrupt", "terminal.keep":
		c.s.audit.log(c.req, m.Method, ev)
	}
	var result json.RawMessage
	if err := conn.Call(ctx, m.Method, params, &result); err != nil {
		c.failErr(m.RID, err)
		return
	}
	if m.Method == "terminal.list" {
		var ok bool
		if result, ok = b.visible(result); !ok {
			c.fail(m.RID, "unavailable", "")
			return
		}
	}
	c.sendJSON(map[string]any{"t": "res", "rid": m.RID, "result": result})
}

// readScreenOnly removes from the params of a read-only client's
// terminal.read the history lines it asks for ("lines", in any letter case
// and of any JSON type), so that the terminal core reads the screen only:
// to stitch history above the screen of a program on the alternate screen
// the core scrolls the program (it sends it mouse-wheel input, and other
// viewers see it redrawn), and a read-only client only watches.
func readScreenOnly(params map[string]json.RawMessage) {
	for k := range params {
		if strings.EqualFold(k, "lines") {
			delete(params, k)
		}
	}
}

func (c *termClient) attach(m *termIn) {
	b, conn := c.subscribed(m.M)
	if conn == nil {
		c.fail(m.RID, "unavailable", "")
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
	defer cancel()
	// The terminal by its address (resolve): a name, or an address the
	// backend does not know yet, is looked up first.
	addr, err := b.resolve(ctx, conn, m.Terminal)
	if errors.Is(err, errHiddenTerm) || errors.Is(err, errOtherMachine) {
		c.noTerminal(m, "terminal.attach", "terminal", m.Terminal, err)
		return
	} else if err != nil {
		c.failErr(m.RID, err)
		return
	}
	observe := m.Observe || c.readOnly
	// A viewer's display facts are what the terminal answers programs with;
	// an observer sends none, as it sends no facts later.
	display := m.Display
	if observe {
		display = nil
	}
	st, a, err := conn.Attach(ctx, hc.AttachParams{
		Terminal: addr, Cols: m.Cols, Rows: m.Rows, History: m.History,
		Observe: observe, ResizeNotifications: observe, Display: display,
	})
	if err != nil {
		c.failErr(m.RID, err)
		return
	}
	// The terminal attached to, as its record in the reply says: a hidden
	// one (it became so since it was looked up) is none, and its stream
	// ends unread.
	if a.Terminal.Address != "" {
		addr = a.Terminal.Address
	}
	if hiddenRecord(&a.Terminal) || otherMachine(addr) || b.isHidden(addr) {
		st.Close()
		c.noTerminal(m, "terminal.attach", "terminal", m.Terminal, errHiddenTerm)
		return
	}
	attached := b
	c.mu.Lock()
	b = c.subs[m.M]
	c.mu.Unlock()
	// The terminal has this viewer now: the one kept for its size ends. It
	// is counted before the client has the stream, so that a client leaving
	// meanwhile hands back one that is counted.
	sizing := !observe && b != nil
	if sizing {
		b.joined(conn, addr)
	}
	c.mu.Lock()
	if c.streams == nil { // the client left meanwhile
		c.mu.Unlock()
		if sizing {
			b.left(conn, addr, st, true)
		} else {
			st.Close()
		}
		return
	}
	c.next++
	id := c.next
	pumping, stop := context.WithCancel(c.ctx)
	// The stream is of the terminal's address, whatever the client named:
	// it ends when that terminal becomes hidden (closeStreamsLocked).
	ts := &termStream{st: st, observe: observe, conn: conn, stop: stop, backend: attached, machine: m.M, terminal: addr}
	if sizing {
		ts.sizing = b
	}
	c.streams[id] = ts
	// The reply is queued before the stream's first frame.
	c.sendJSON(map[string]any{"t": "attached", "rid": m.RID, "s": id, "terminal": m.Terminal,
		"cols": a.Terminal.Cols, "rows": a.Terminal.Rows, "observe": observe, "automatic": a.AutomaticInput})
	c.mu.Unlock()
	go c.pump(pumping, id, st)
	// Hidden in the instant before the backend knew the stream, when
	// closeStreamsLocked did not find it: it ends now.
	if hidden := attached.track(ts); hidden {
		st.Close()
	}
}

// pump forwards a stream's output to the client until it ends. The client
// returns credit with "ack" as it draws, which reaches the terminal core.
func (c *termClient) pump(ctx context.Context, id uint32, st *hc.Stream) {
	head := binary.LittleEndian.AppendUint32(nil, id)
	for {
		o, err := st.Recv(ctx)
		if err != nil {
			c.mu.Lock()
			ts, open := c.streams[id]
			delete(c.streams, id)
			c.mu.Unlock()
			if !open {
				return // detached, or the client left
			}
			// The stream is over: it no longer counts for its terminal's size.
			ts.stop()
			ts.backend.untrack(ts)
			if ts.sizing != nil {
				ts.sizing.left(ts.conn, ts.terminal, st, false)
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
			c.mu.Lock()
			if ts := c.streams[id]; ts != nil {
				ts.unacked += int64(len(o.Data))
			}
			c.mu.Unlock()
		}
		c.enqueue(outMsg{binary: true, data: frame})
	}
}
