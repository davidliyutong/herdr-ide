package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"veldr/internal/agentproto"
	"veldr/internal/hc"
	"veldr/internal/machines"
)

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
	// stopped: the terminal core was stopped from the UI, so the backend
	// starts none until it is started again (or the backend starts anew).
	stopped bool
	// hidden are the addresses of the terminals of the product's own
	// helpers (hiddenTerminal: the chat host), which are not in terms.
	// Clients are told nothing of them and cannot address them (resolve).
	hidden map[string]bool
	// core is how the terminal core calls itself: an address may say its
	// id or its name before a terminal of its own ("box/t7").
	core hc.CoreInfo
	// agents are the coding agents detected in the terminals (op detect),
	// merged into their records as agent and agent_status.
	agents map[string]agentproto.DetectEvent
	// typing counts, by terminal, the clients' streams that set its size
	// (the ones not observing). parked is the stream of the last of them
	// to leave, kept attached and unread until the next one has attached
	// or the terminal ends: herdr-core gives a terminal without such a
	// viewer its headless size (200x120 unless the user's configuration
	// says otherwise), and a full-screen program would lay itself out for
	// that whenever no page shows it. Both are of the connection now.
	typing map[string]int
	parked map[string]*hc.Stream
	// streams are the clients' streams attached through the backend,
	// which end when their terminal becomes hidden (closeStreamsLocked).
	streams map[*termStream]bool
	// pub orders the publications of the state on the machine.
	pub sync.Mutex
	// gone: the machine was removed; the backend publishes nothing more
	// (a machine added again under the same id has a backend of its own).
	gone bool
}

func (b *termBackend) wakeUp() {
	select {
	case b.wake <- struct{}{}:
	default:
	}
}

// publish shows the backend's state in its machine's state (and the
// display's keeper follows a ready terminal core).
func (b *termBackend) publish() {
	b.pub.Lock()
	defer b.pub.Unlock()
	b.mu.Lock()
	if b.gone {
		b.mu.Unlock()
		return
	}
	var st *machines.HCState
	if b.stop != nil {
		st = &machines.HCState{State: b.state, Code: b.code, Version: b.version}
	}
	b.mu.Unlock()
	if mc := b.s.mg.Get(b.id); mc != nil {
		mc.SetHC(st)
		b.s.gui.ServerReady(mc, st != nil && st.State == termReady)
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
		b.stopped = false
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
		closing := len(b.subs) == 0 && b.stop != nil
		if closing {
			b.stop()
			b.stop = nil
		}
		b.mu.Unlock()
		if closing {
			b.publish()
		}
	})
}

// joined counts a client's stream that sets terminal's size, attached
// through conn; the stream parked for the terminal ends now that it has
// another viewer.
func (b *termBackend) joined(conn *hc.Conn, terminal string) {
	b.mu.Lock()
	var old *hc.Stream
	if b.conn == conn {
		if b.typing == nil {
			b.typing = map[string]int{}
		}
		b.typing[terminal]++
		old = b.parked[terminal]
		delete(b.parked, terminal)
	}
	b.mu.Unlock()
	if old != nil {
		old.Close()
	}
}

// left takes a stream that set terminal's size from the client that had
// it. With park (the client let go of it, the terminal lives on) the last
// one of a terminal stays attached, so that the terminal keeps its size;
// any other is closed.
func (b *termBackend) left(conn *hc.Conn, terminal string, st *hc.Stream, park bool) {
	b.mu.Lock()
	keep := false
	if b.conn == conn {
		if b.typing[terminal] > 1 {
			b.typing[terminal]--
		} else {
			delete(b.typing, terminal)
			t := b.terms[terminal]
			keep = park && t != nil && t["state"] == "live"
		}
	}
	var old *hc.Stream
	if keep {
		if b.parked == nil {
			b.parked = map[string]*hc.Stream{}
		}
		old, b.parked[terminal] = b.parked[terminal], st
	}
	b.mu.Unlock()
	if !keep {
		st.Close()
	}
	if old != nil {
		old.Close()
	}
}

// unpark ends the stream parked for a terminal that is over (b.mu held).
func (b *termBackend) unpark(terminal string) {
	if st := b.parked[terminal]; st != nil {
		delete(b.parked, terminal)
		go st.Close()
	}
}

func (b *termBackend) setState(state, code string) {
	b.mu.Lock()
	if state != termReady {
		b.conn, b.terms, b.hidden = nil, nil, nil
		// The streams went with the connection.
		for _, st := range b.parked {
			go st.Close()
		}
		b.typing, b.parked = nil, nil
	}
	if b.state == state && b.code == code {
		b.mu.Unlock()
		return
	}
	b.state, b.code = state, code
	for c := range b.subs {
		c.sendJSON(b.stateMsg())
	}
	b.mu.Unlock()
	b.publish()
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
	b.conn, b.terms, b.hidden, b.state, b.code = nil, nil, nil, termStarting, ""
	b.mu.Unlock()
	b.publish()
}

// ensure makes the machine's terminal core run the executable this build
// carries and returns once it answers; with restart, a core that runs is
// restarted (its successor adopts the programs). A read-only core installs
// and starts nothing: it uses a core that already runs. After a stop from
// the UI none is started until it is started again.
func (b *termBackend) ensure(ctx context.Context, mc *machines.Machine, restart bool) (code string) {
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
	case installed || restart:
		// The running core is from another build (or a restart was asked
		// for): its successor adopts the programs, which keep running.
		action = "restart"
	}
	if action == "" {
		return ""
	}
	if readOnly {
		return termCodeNotRunning
	}
	b.mu.Lock()
	stopped := b.stopped
	b.mu.Unlock()
	if stopped && !st.Running {
		return termCodeStopped
	}
	// The agent hashes the executable again and runs it only when it is
	// this build's.
	rep, err = sess.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: action, Digest: digest})
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
	if code := b.ensure(ctx, mc, false); code != "" {
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
	b.conn, b.version, b.core, b.state, b.code = conn, hello.Version, hello.Core, termReady, ""
	b.terms, b.hidden = indexTerminals(snap)
	b.agents = map[string]agentproto.DetectEvent{}
	for c := range b.subs {
		c.sendJSON(b.stateMsg())
		c.sendJSON(b.snapshotMsg())
	}
	b.mu.Unlock()
	b.publish()
	// Which coding agents run in the terminals, while this connection lasts.
	dctx, dcancel := context.WithCancel(ctx)
	defer dcancel()
	go b.detect(dctx, mc)

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

// Why a terminal a client names is none of the clients' (resolve).
var (
	// errHiddenTerm: a hidden terminal (hiddenTerminal), or the name kept
	// for the chat host, whether one runs or not.
	errHiddenTerm = errors.New("a hidden terminal")
	// errOtherMachine: a terminal of another machine, one the terminal
	// core added (machine.add) or that dialed in to it. The core's own
	// machines are the server's, each with a terminal core of its own;
	// a client reaches none through another's.
	errOtherMachine = errors.New("a terminal of another machine")
)

// otherMachine reports whether addr, a terminal's address as the terminal
// core reports it, is one of another machine: "box/t7". The core's own
// terminals have addresses without a machine ("t7").
func otherMachine(addr string) bool { return strings.Contains(addr, "/") }

// localLocked is target, a terminal as a client names it ("t7", a name, or
// either after a machine: "box/t7"), as the terminal core names one of its
// own: without the core's own id or name before it. ok is false for a
// target after any other machine (errOtherMachine), and for one that is no
// address at all ("box/", "a/b/c"). b.mu is held.
func (b *termBackend) localLocked(target string) (local string, ok bool) {
	m, local, cut := strings.Cut(target, "/")
	if !cut {
		return target, true
	}
	if m == "" || local == "" || strings.Contains(local, "/") || m != b.core.ID && m != b.core.Name {
		return "", false
	}
	return local, true
}

// isHidden reports whether the terminal at addr is hidden.
func (b *termBackend) isHidden(addr string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.hidden[addr]
}

// resolve is the address of the terminal that target, a terminal as a
// client names it, names, as the terminal core reads it. A terminal the
// clients know is named by its address (also after the core's own id or
// name); any other target (a name, or the address of a terminal whose
// creation has not reached the backend yet, or that is hidden and whose
// event has not) is looked up with terminal.get first, and the call that
// follows names the terminal found by its address: what a name names can
// change, an address cannot. errHiddenTerm or errOtherMachine for a
// terminal that is none of the clients', without asking the terminal core
// when the backend knows; the terminal core's error when the lookup fails.
func (b *termBackend) resolve(ctx context.Context, conn *hc.Conn, target string) (string, error) {
	b.mu.Lock()
	local, ok := b.localLocked(target)
	hidden := b.hidden[local] || agentproto.IsChatHostName(local)
	_, known := b.terms[local]
	b.mu.Unlock()
	switch {
	case !ok:
		return "", errOtherMachine
	case hidden:
		return "", errHiddenTerm
	case known:
		return local, nil
	}
	var rec map[string]any
	if err := conn.Call(ctx, "terminal.get", map[string]string{"terminal": local}, &rec); err != nil {
		return "", err
	}
	addr, _ := rec["address"].(string)
	switch {
	case addr == "":
		return "", errors.New("hc: terminal.get: a record without an address")
	case otherMachine(addr):
		return "", errOtherMachine
	case hiddenTerminal(rec) || b.isHidden(addr):
		return "", errHiddenTerm
	}
	return addr, nil
}

// visible is the result of terminal.list with only the clients' terminals:
// without the hidden ones and those of other machines, and without the
// machines the terminal core added (its "machines"); false for a result
// that is no list of terminals.
func (b *termBackend) visible(result json.RawMessage) (json.RawMessage, bool) {
	var res map[string]json.RawMessage
	var list []json.RawMessage
	if json.Unmarshal(result, &res) != nil || json.Unmarshal(res["terminals"], &list) != nil {
		return nil, false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	kept := make([]json.RawMessage, 0, len(list))
	for _, raw := range list {
		var rec map[string]any
		if json.Unmarshal(raw, &rec) != nil {
			return nil, false
		}
		addr, _ := rec["address"].(string)
		if !b.hidden[addr] && !hiddenTerminal(rec) && !otherMachine(addr) {
			kept = append(kept, raw)
		}
	}
	var machines []json.RawMessage
	_, hasMachines := res["machines"]
	if hasMachines && (json.Unmarshal(res["machines"], &machines) != nil || len(machines) > 0) {
		res["machines"] = json.RawMessage("[]")
	} else if len(kept) == len(list) {
		return result, true
	}
	var err error
	if res["terminals"], err = json.Marshal(kept); err != nil {
		return nil, false
	}
	out, err := json.Marshal(res)
	return out, err == nil
}

// connection returns the backend's connection when it is ready.
func (b *termBackend) connection() *hc.Conn {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.conn
}

// handleHCStatus reports a machine's terminal core: the installed
// executable's digest, whether a core answers, its version, session and
// socket (agentproto.HCStatus).
func (s *Server) handleHCStatus(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	sess := mc.Session()
	if sess == nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": termCodeOffline})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	rep, err := sess.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "status"})
	if err != nil || rep.HC == nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "transport"})
		return
	}
	writeJSON(w, http.StatusOK, rep.HC)
}

// handleHCAction starts, stops or restarts a machine's terminal core from
// the UI (POST /api/m/{id}/hc/{start|stop|restart}). Starting installs the
// build's executable when the machine has another one; restarting keeps the
// programs (the core's successor adopts them); stopping ends every program
// of the core and keeps the core stopped until it is started again, also
// while clients stay subscribed. The reply is the core's status.
func (s *Server) handleHCAction(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	action := r.PathValue("action")
	if action != "start" && action != "stop" && action != "restart" {
		http.Error(w, "unknown action", http.StatusNotFound)
		return
	}
	sess := mc.Session()
	if sess == nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": termCodeOffline})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	b := s.term.backend(mc.ID())
	b.mu.Lock()
	b.stopped = action == "stop"
	b.mu.Unlock()
	ev := map[string]any{"machine": mc.ID()}
	code := ""
	if action == "stop" {
		rep, err := sess.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "stop"})
		if err != nil {
			code = "transport"
		} else if !rep.OK {
			code = rep.Code
		}
	} else {
		code = b.ensure(ctx, mc, action == "restart")
	}
	b.wakeUp()
	if code != "" {
		ev["error"] = code
	}
	s.audit.log(r, "hc."+action, ev)
	if code != "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": code})
		return
	}
	rep, err := sess.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "status"})
	if err != nil || rep.HC == nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "transport"})
		return
	}
	writeJSON(w, http.StatusOK, rep.HC)
}

// termShells are the terminals of a machine's terminal core that clients
// see, for typing the display's variables into their shells (gui.Shells).
type termShells struct{ b *termBackend }

var errNoTerminals = errors.New("the terminal core is not connected")

func (t termShells) All(context.Context) ([]string, error) {
	t.b.mu.Lock()
	defer t.b.mu.Unlock()
	var out []string
	for addr, rec := range t.b.terms {
		if rec["state"] == "live" {
			out = append(out, addr)
		}
	}
	sort.Strings(out)
	return out, nil
}

// get reads a terminal's record now: its foreground is read about twice a
// second, so the cached one may be older.
func (t termShells) get(ctx context.Context, addr string) (*hc.Conn, *hc.Terminal, error) {
	conn := t.b.connection()
	if conn == nil {
		return nil, nil, errNoTerminals
	}
	// A hidden terminal a request names, or another machine's, is no
	// terminal: nothing is asked about it, and nothing typed into it. The
	// record read is the terminal's as it is now: one that is hidden by
	// now (its event has not reached the backend yet) is none either.
	notFound := &hc.Error{Kind: "not_found", Message: "no terminal " + strconv.Quote(addr)}
	t.b.mu.Lock()
	local, ok := t.b.localLocked(addr)
	hidden := t.b.hidden[local] || agentproto.IsChatHostName(local)
	t.b.mu.Unlock()
	if !ok || hidden {
		return nil, nil, notFound
	}
	var rec hc.Terminal
	if err := conn.Call(ctx, "terminal.get", map[string]string{"terminal": local}, &rec); err != nil {
		return nil, nil, err
	}
	if rec.Address == "" || otherMachine(rec.Address) || hiddenRecord(&rec) || t.b.isHidden(rec.Address) {
		return nil, nil, notFound
	}
	return conn, &rec, nil
}

// Shell is the terminal's program, waiting at its prompt when it leads the
// foreground process group.
func (t termShells) Shell(ctx context.Context, addr string) (int, bool, error) {
	_, rec, err := t.get(ctx, addr)
	if err != nil {
		return 0, false, err
	}
	if rec.State != "live" || rec.PID == nil {
		return 0, false, nil
	}
	return *rec.PID, rec.Foreground != nil && rec.Foreground.PID == *rec.PID, nil
}

// Send types text as a viewer of the terminal's own size, so typing
// changes no viewer's size.
func (t termShells) Send(ctx context.Context, addr, text string) error {
	conn, rec, err := t.get(ctx, addr)
	if err != nil {
		return err
	}
	// The terminal the record is, by its address.
	st, a, err := conn.Attach(ctx, hc.AttachParams{Terminal: rec.Address, Cols: max(rec.Cols, 1), Rows: max(rec.Rows, 1), Resumed: true})
	if err != nil {
		return err
	}
	defer st.Close()
	if hiddenRecord(&a.Terminal) {
		return &hc.Error{Kind: "not_found", Message: "no terminal " + strconv.Quote(addr)}
	}
	_, err = st.Write([]byte(text))
	return err
}
