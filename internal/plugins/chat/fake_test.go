package chat

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/chatproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
)

// fakeChatHost is a machine's chat host in the test: chatproto over
// in-process pipes, behind the opener the plugin uses instead of the
// machine's open action.
type fakeChatHost struct {
	t *testing.T

	mu sync.Mutex
	// running: a host serves (an open without start gets not_running
	// otherwise); proto and pid are what its hello states.
	running bool
	proto   int
	pid     int
	// dropAfter: an event that a connection does not take within it ends
	// that connection, as the host drops a subscriber that falls behind;
	// 0 waits 10 s.
	dropAfter time.Duration
	// openErr fails every open with that code.
	openErr string
	// opens are the start flags of the opens; requests every request.
	opens    []bool
	requests []chatproto.Request
	commands []chatproto.Command
	// chats and states; available kinds; sessions.
	chats    map[string]chatproto.Chat
	states   []chatproto.ChatState
	agents   map[string]bool
	sessions []chatproto.Session
	// reqErr refuses requests of an op; ackErr answers commands of an op
	// with an error; holdAcks keeps every ack until released.
	reqErr   map[string]*chatproto.Error
	ackErr   map[string]*chatproto.Error
	holdAcks bool
	held     []func()

	watchers map[*fakeConn]bool
	attached map[*fakeConn]string
	conns    map[*fakeConn]bool
	changed  chan struct{}
}

type fakeConn struct {
	conn net.Conn
	mu   sync.Mutex
}

func (c *fakeConn) write(v any) error {
	return c.writeWithin(v, 10*time.Second)
}

func (c *fakeConn) writeWithin(v any, d time.Duration) error {
	b, err := chatproto.Line(v)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.conn.SetWriteDeadline(time.Now().Add(d))
	_, err = c.conn.Write(b)
	return err
}

func newFakeChatHost(t *testing.T) *fakeChatHost {
	return &fakeChatHost{t: t, running: true, proto: chatproto.Proto, pid: 1, chats: map[string]chatproto.Chat{}, agents: map[string]bool{},
		reqErr: map[string]*chatproto.Error{}, ackErr: map[string]*chatproto.Error{}, watchers: map[*fakeConn]bool{},
		attached: map[*fakeConn]string{}, conns: map[*fakeConn]bool{}, changed: make(chan struct{}, 1)}
}

func (f *fakeChatHost) poke() {
	select {
	case f.changed <- struct{}{}:
	default:
	}
}

// open is the plugin's opener.
func (f *fakeChatHost) open(ctx context.Context, m string, start bool) (net.Conn, error) {
	f.mu.Lock()
	f.opens = append(f.opens, start)
	switch {
	case f.openErr != "":
		code := f.openErr
		f.mu.Unlock()
		return nil, &plugin.Error{Code: code, Message: "refused"}
	case !f.running && !start:
		f.mu.Unlock()
		return nil, &plugin.Error{Code: codeNotRunning, Message: "no chat host"}
	}
	f.running = true
	client, server := net.Pipe()
	c := &fakeConn{conn: server}
	f.conns[c] = true
	f.mu.Unlock()
	go f.serve(c)
	return client, nil
}

// wait waits until cond holds of the host.
func (f *fakeChatHost) wait(what string, cond func() bool) {
	f.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		ok := cond()
		f.mu.Unlock()
		if ok {
			return
		}
		if time.Now().After(deadline) {
			f.t.Fatalf("waited in vain for %s", what)
		}
		select {
		case <-f.changed:
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func (f *fakeChatHost) serve(c *fakeConn) {
	defer func() {
		c.conn.Close()
		f.mu.Lock()
		delete(f.conns, c)
		delete(f.watchers, c)
		delete(f.attached, c)
		f.mu.Unlock()
		f.poke()
	}()
	f.mu.Lock()
	proto, pid := f.proto, f.pid
	f.mu.Unlock()
	if c.write(chatproto.Hello{Host: chatproto.HostInfo{Proto: proto, Version: "test", PID: pid}}) != nil {
		return
	}
	r := bufio.NewReader(c.conn)
	line, err := chatproto.ReadLine(r)
	if err != nil {
		return
	}
	var req chatproto.Request
	if json.Unmarshal(line, &req) != nil {
		return
	}
	f.mu.Lock()
	f.requests = append(f.requests, req)
	refused := f.reqErr[req.Op]
	f.mu.Unlock()
	f.poke()
	if refused != nil {
		c.write(chatproto.Response{Error: refused})
		return
	}
	switch req.Op {
	case chatproto.OpAgents:
		res := chatproto.Response{OK: true}
		f.mu.Lock()
		for _, k := range req.Kinds {
			res.Agents = append(res.Agents, chatproto.AgentStatus{Kind: k, Available: f.agents[k]})
		}
		f.mu.Unlock()
		res.Agents = append(res.Agents, chatproto.AgentStatus{Kind: "notakind", Available: true})
		c.write(res)
	case chatproto.OpChats:
		f.mu.Lock()
		var chats []chatproto.Chat
		for _, ch := range f.chats {
			chats = append(chats, ch)
		}
		f.mu.Unlock()
		c.write(chatproto.Response{OK: true, Chats: chats})
	case chatproto.OpSessions:
		f.mu.Lock()
		s := f.sessions
		f.mu.Unlock()
		c.write(chatproto.Response{OK: true, Sessions: s, NextCursor: "next"})
	case chatproto.OpNew:
		ch := chatproto.Chat{ID: chatproto.NewChatID(), Kind: req.Kind, Cwd: req.Cwd, State: chatproto.StateStarting, Status: chatproto.StatusIdle}
		f.mu.Lock()
		f.chats[ch.ID] = ch
		f.mu.Unlock()
		c.write(chatproto.Response{OK: true, Chat: &ch})
	case chatproto.OpWatch:
		// Listed and answered at once: a change comes after the states.
		f.mu.Lock()
		b, _ := chatproto.Line(chatproto.Response{OK: true, States: slices.Clone(f.states)})
		f.watchers[c] = true
		c.mu.Lock()
		f.mu.Unlock()
		_, err := c.conn.Write(b)
		c.mu.Unlock()
		f.poke()
		if err != nil {
			return
		}
		io.Copy(io.Discard, r)
	case chatproto.OpAttach:
		f.mu.Lock()
		ch, ok := f.chats[req.Chat]
		f.mu.Unlock()
		if !ok {
			c.write(chatproto.Response{Error: &chatproto.Error{Code: chatproto.CodeUnknownChat, Message: "no such chat"}})
			return
		}
		if c.write(chatproto.Response{OK: true, Chat: &ch, First: 1}) != nil {
			return
		}
		f.mu.Lock()
		f.attached[c] = req.Chat
		f.mu.Unlock()
		f.poke()
		for {
			line, err := chatproto.ReadLine(r)
			if err != nil {
				return
			}
			var cmd chatproto.Command
			if json.Unmarshal(line, &cmd) != nil {
				continue
			}
			f.mu.Lock()
			f.commands = append(f.commands, cmd)
			e := f.ackErr[cmd.Op]
			ack := func() { c.write(chatproto.Event{T: chatproto.EventAck, ID: cmd.ID, Error: e}) }
			if f.holdAcks {
				f.held = append(f.held, ack)
				ack = nil
			}
			f.mu.Unlock()
			f.poke()
			if ack != nil {
				ack()
			}
		}
	default:
		c.write(chatproto.Response{OK: true})
	}
}

// release sends the acks held so far.
func (f *fakeChatHost) release() {
	f.mu.Lock()
	held := f.held
	f.held, f.holdAcks = nil, false
	f.mu.Unlock()
	for _, ack := range held {
		ack()
	}
}

// emit writes an event to every connection attached to chat; one that
// does not take it within dropAfter is ended.
func (f *fakeChatHost) emit(chat string, ev chatproto.Event) {
	f.mu.Lock()
	var cs []*fakeConn
	for c, id := range f.attached {
		if id == chat {
			cs = append(cs, c)
		}
	}
	d := f.dropAfter
	f.mu.Unlock()
	for _, c := range cs {
		if d == 0 {
			c.write(ev)
		} else if c.writeWithin(ev, d) != nil {
			c.conn.Close()
		}
	}
}

// attachedTo counts the connections attached to chat.
func (f *fakeChatHost) attachedTo(chat string) int {
	n := 0
	for _, id := range f.attached {
		if id == chat {
			n++
		}
	}
	return n
}

// change sets a chat's state and tells the watchers.
func (f *fakeChatHost) change(st chatproto.ChatState) {
	f.mu.Lock()
	i := slices.IndexFunc(f.states, func(s chatproto.ChatState) bool { return s.ID == st.ID })
	switch {
	case st.State == chatproto.StateDeleted && i >= 0:
		f.states = slices.Delete(f.states, i, i+1)
	case i >= 0:
		f.states[i] = st
	case st.State != chatproto.StateDeleted:
		f.states = append(f.states, st)
	}
	var cs []*fakeConn
	for c := range f.watchers {
		cs = append(cs, c)
	}
	f.mu.Unlock()
	for _, c := range cs {
		c.write(st)
	}
}

// end closes every connection: the host ended. running says whether
// another serves.
func (f *fakeChatHost) end(running bool) {
	f.mu.Lock()
	f.running = running
	var cs []*fakeConn
	for c := range f.conns {
		cs = append(cs, c)
	}
	f.mu.Unlock()
	for _, c := range cs {
		c.conn.Close()
	}
}

// ops are the ops of the requests so far.
func (f *fakeChatHost) ops() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, r := range f.requests {
		out = append(out, r.Op)
	}
	return out
}

func (f *fakeChatHost) count(op string) int {
	n := 0
	for _, r := range f.requests {
		if r.Op == op {
			n++
		}
	}
	return n
}

// testHost is the core in the test (plugin.Host).
type testHost struct {
	mg       *machines.Manager
	st       *settings.Store
	readOnly bool

	mu         sync.Mutex
	audits     []auditEntry
	broadcasts []broadcastEntry
	notes      []map[string]any
	changed    chan struct{}
}

type auditEntry struct {
	event  string
	fields map[string]any
}

type broadcastEntry struct {
	m    string
	data StatesData
}

func newTestHost(t *testing.T) *testHost {
	t.Helper()
	logger := log.New(io.Discard, "", 0)
	mg := machines.NewManager([]machines.Spec{
		{ID: "gpu", Label: "gpu", Kind: machines.KindSSH, Target: "gpu"},
		{ID: "box", Label: "box", Kind: machines.KindSSH, Target: "box"},
	}, nil, logger)
	h := &testHost{mg: mg, st: settings.New("", Settings, plugin.Settings([]plugin.Plugin{New()}, nil)), changed: make(chan struct{}, 1)}
	cancel := mg.Subscribe(func(machines.State) {}, func(ev machines.AgentEvent) {
		var data map[string]any
		json.Unmarshal(ev.Data, &data)
		data["m"] = ev.Machine
		h.mu.Lock()
		h.notes = append(h.notes, data)
		h.mu.Unlock()
		h.poke()
	})
	t.Cleanup(cancel)
	return h
}

func (h *testHost) poke() {
	select {
	case h.changed <- struct{}{}:
	default:
	}
}

func (h *testHost) Machines() *machines.Manager { return h.mg }
func (h *testHost) Broadcast(id, m string, data any) {
	if id != ID {
		return
	}
	d, _ := data.(StatesData)
	h.mu.Lock()
	h.broadcasts = append(h.broadcasts, broadcastEntry{m, d})
	h.mu.Unlock()
	h.poke()
}
func (h *testHost) Audit(_ *http.Request, event string, fields map[string]any) {
	h.mu.Lock()
	h.audits = append(h.audits, auditEntry{event, fields})
	h.mu.Unlock()
	h.poke()
}
func (h *testHost) ReadOnly() bool            { return h.readOnly }
func (h *testHost) Settings() *settings.Store { return h.st }
func (h *testHost) Logger() *log.Logger       { return log.New(io.Discard, "", 0) }

// wait waits until cond holds of the core.
func (h *testHost) wait(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		h.mu.Lock()
		ok := cond()
		h.mu.Unlock()
		if ok {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("waited in vain for %s", what)
		}
		select {
		case <-h.changed:
		case <-time.After(5 * time.Millisecond):
		}
	}
}
