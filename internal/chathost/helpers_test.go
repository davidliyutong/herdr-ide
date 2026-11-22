//go:build unix

package chathost

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

// patience is how long a test waits for something that must happen.
const patience = 15 * time.Second

// testHost is a chat host that serves in the test's process, with a fake
// adapter.
type testHost struct {
	t    *testing.T
	o    Options
	fake *fakeAdapter
	run  string
	base string
	sock string
	cwd  string // a directory for chats
	stop context.CancelFunc
	log  *syncBuffer

	finished chan struct{} // closed when Serve returned
	err      error         // what Serve returned

	hmu  sync.Mutex
	host *host // the host that serves
}

// served is the host that serves.
func (h *testHost) served() *host {
	h.hmu.Lock()
	defer h.hmu.Unlock()
	return h.host
}

// openTestJournal opens the host's journal beside it.
func openTestJournal(t *testing.T, h *testHost) *journal {
	t.Helper()
	j, err := openJournal(h.base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { j.close() })
	return j
}

// set changes the fake adapter under its lock.
func (a *fakeAdapter) set(f func(a *fakeAdapter)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f(a)
}

// syncBuffer is a log that goroutines write.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// runDir makes a run directory with a path short enough for a socket.
func runDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "ch")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// testSettings are the settings of a test host: the defaults.
func testSettings() *chatproto.HostSettings {
	s := chatproto.DefaultHostSettings()
	return &s
}

// startHost serves a host with the options of a test: it does not end by
// itself, and takes the test's environment for the user's.
func startHost(t *testing.T, change func(*testHost)) *testHost {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	dir := runDir(t)
	exe := testExecutable(t)
	h := &testHost{t: t, run: dir, base: filepath.Join(t.TempDir(), "base"), sock: filepath.Join(dir, chatproto.SocketName),
		cwd: t.TempDir(), log: &syncBuffer{}, fake: newFakeAdapter()}
	h.o = Options{
		Base: h.base, Run: dir, Logger: log.New(h.log, "", log.Lmicroseconds),
		idleExit: time.Hour, minute: time.Hour, enforceEvery: time.Hour, infoDelay: 20 * time.Millisecond,
		closeGrace: 5 * time.Second, settings: testSettings(),
		environ: func(context.Context) []string { return os.Environ() },
		kinds:   fakeSpecs(exe),
	}
	h.o.adapters = func(name string) (chatadapter.Adapter, bool) { return h.fake, name == fakeAdapterName }
	h.o.onHost = func(x *host) {
		h.hmu.Lock()
		h.host = x
		h.hmu.Unlock()
	}
	if change != nil {
		change(h)
	}
	h.serve()
	return h
}

// serve runs Serve with the host's options, and waits until it answers on
// its socket: the socket listens before the journal is open, the host
// says hello after.
func (h *testHost) serve() {
	h.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	h.stop = cancel
	finished := make(chan struct{})
	h.finished = finished
	go func() {
		h.err = Serve(ctx, h.o)
		close(finished)
	}()
	h.t.Cleanup(func() {
		cancel()
		select {
		case <-finished:
		case <-time.After(patience):
			h.t.Error("the host did not stop")
		}
		if h.t.Failed() {
			h.t.Logf("the host's log:\n%s", h.log)
		}
	})
	eventually(h.t, "the host's hello", func() bool {
		select {
		case <-finished:
			h.t.Fatalf("Serve returned: %v", h.err)
		default:
		}
		conn, err := net.Dial("unix", h.sock)
		if err != nil {
			return false
		}
		defer conn.Close()
		conn.SetReadDeadline(time.Now().Add(patience))
		_, err = chatproto.ReadLine(bufio.NewReader(conn))
		return err == nil
	})
}

// restart stops the host and serves another one with the same options.
func (h *testHost) restart() {
	h.t.Helper()
	h.stop()
	h.wait()
	h.serve()
}

// wait is what Serve returned, once it did.
func (h *testHost) wait() error {
	h.t.Helper()
	select {
	case <-h.finished:
		return h.err
	case <-time.After(patience):
		h.t.Fatal("the host did not stop")
		return nil
	}
}

// eventually waits until ok holds.
func eventually(t testing.TB, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(patience)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// client is a connection to the host.
type client struct {
	t     *testing.T
	conn  net.Conn
	r     *bufio.Reader
	hello chatproto.Hello
}

// dial connects and reads the host's hello.
func (h *testHost) dial() *client {
	h.t.Helper()
	conn, err := net.DialTimeout("unix", h.sock, patience)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { conn.Close() })
	c := &client{t: h.t, conn: conn, r: bufio.NewReader(conn)}
	c.read(&c.hello)
	return c
}

func (c *client) write(v any) {
	c.t.Helper()
	b, err := chatproto.Line(v)
	if err != nil {
		c.t.Fatal(err)
	}
	c.conn.SetWriteDeadline(time.Now().Add(patience))
	if _, err := c.conn.Write(b); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

// line reads the next line.
func (c *client) line() string {
	c.t.Helper()
	c.conn.SetReadDeadline(time.Now().Add(patience))
	b, err := chatproto.ReadLine(c.r)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	return string(b)
}

func (c *client) read(v any) {
	c.t.Helper()
	l := c.line()
	if err := json.Unmarshal([]byte(l), v); err != nil {
		c.t.Fatalf("%v in %s", err, l)
	}
}

// ended fails the test unless the host closed the connection.
func (c *client) ended() {
	c.t.Helper()
	c.conn.SetReadDeadline(time.Now().Add(patience))
	if b, err := c.r.ReadByte(); err == nil {
		c.t.Errorf("the connection goes on after the answer: %q…", b)
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		c.t.Error("the connection stays open after the answer")
	}
}

// do sends a request and returns its answer, after which the host closes
// the connection.
func (h *testHost) do(req chatproto.Request) chatproto.Response {
	h.t.Helper()
	c := h.dial()
	defer c.conn.Close()
	c.write(req)
	var res chatproto.Response
	c.read(&res)
	c.ended()
	return res
}

// ok is do for a request that must succeed.
func (h *testHost) ok(req chatproto.Request) chatproto.Response {
	h.t.Helper()
	res := h.do(req)
	if !res.OK || res.Error != nil {
		h.t.Fatalf("%s: %+v", req.Op, res.Error)
	}
	return res
}

// refused is do for a request that must fail with a code.
func (h *testHost) refused(req chatproto.Request, code string) *chatproto.Error {
	h.t.Helper()
	res := h.do(req)
	if res.OK || res.Error == nil || res.Error.Code != code {
		h.t.Fatalf("%s: ok %v, error %+v; want %s", req.Op, res.OK, res.Error, code)
	}
	return res.Error
}

// chats are the host's chats.
func (h *testHost) chats() []chatproto.Chat {
	h.t.Helper()
	return h.ok(chatproto.Request{Op: chatproto.OpChats}).Chats
}

// chat is one of the host's chats.
func (h *testHost) chat(id string) chatproto.Chat {
	h.t.Helper()
	for _, c := range h.chats() {
		if c.ID == id {
			return c
		}
	}
	h.t.Fatalf("no chat %s", id)
	return chatproto.Chat{}
}

// waitState waits until a chat is in a state.
func (h *testHost) waitState(id, state string) chatproto.Chat {
	h.t.Helper()
	var c chatproto.Chat
	eventually(h.t, "chat "+id+" "+state, func() bool {
		c = h.chat(id)
		return c.State == state
	})
	return c
}

// event is an event as it came.
type event struct {
	chatproto.Event
	raw string
}

// kind names an event for a test: its type, with what tells it from others
// of the type.
func (e event) kind() string {
	switch e.T {
	case chatproto.EventUpdate:
		var u struct {
			Kind string `json:"sessionUpdate"`
		}
		json.Unmarshal(e.Update, &u)
		return "update:" + u.Kind
	case chatproto.EventTurn, chatproto.EventState, chatproto.EventQueued:
		return e.T + ":" + e.State
	case chatproto.EventPermissionDone, chatproto.EventQuestionDone:
		return e.T + ":" + e.By
	case chatproto.EventNotice:
		return e.T + ":" + e.Method
	}
	return e.T
}

// text is the text of an update's content.
func (e event) text() string {
	var u struct {
		Content struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	json.Unmarshal(e.Update, &u)
	return u.Content.Text
}

func kinds(events []event) string {
	names := make([]string, len(events))
	for i, e := range events {
		names[i] = e.kind()
	}
	return strings.Join(names, " ")
}

func isKind(kind string) func(event) bool {
	return func(e event) bool { return e.kind() == kind }
}

// stream is an attached connection whose lines a goroutine reads: a client
// that keeps up.
type stream struct {
	t      *testing.T
	c      *client
	chat   chatproto.Chat // the chat of the attach's answer
	first  uint64
	events chan event
	lives  chan event
	acks   chan event
	closed chan struct{} // the connection ended
	last   uint64        // the last sequence number seen
	ids    int
	// session is the chat's fake session (newChat).
	session *fakeSession
}

// attachRaw attaches a connection and returns it after the answer: nothing
// reads it.
func (h *testHost) attachRaw(chat string, from uint64) (*client, chatproto.Response) {
	h.t.Helper()
	c := h.dial()
	c.write(chatproto.Request{Op: chatproto.OpAttach, Chat: chat, From: from})
	var res chatproto.Response
	c.read(&res)
	if !res.OK || res.Chat == nil {
		h.t.Fatalf("attach: %+v", res.Error)
	}
	return c, res
}

// attach attaches a connection that is read.
func (h *testHost) attach(chat string, from uint64) *stream {
	h.t.Helper()
	c, res := h.attachRaw(chat, from)
	s := &stream{t: h.t, c: c, chat: *res.Chat, first: res.First, last: from,
		events: make(chan event, 1<<16), lives: make(chan event, 1<<16), acks: make(chan event, 1<<10), closed: make(chan struct{})}
	if res.First > from+1 {
		s.last = res.First - 1 // what was between is no longer kept
	}
	c.conn.SetReadDeadline(time.Time{})
	go func() {
		defer close(s.closed)
		for {
			b, err := chatproto.ReadLine(c.r)
			if err != nil {
				return
			}
			e := event{raw: string(b)}
			if json.Unmarshal(b, &e.Event) != nil {
				e.T = "not JSON"
			}
			switch {
			case e.T == chatproto.EventAck:
				s.acks <- e
			case e.Live:
				s.lives <- e
			default:
				s.events <- e
			}
		}
	}()
	return s
}

// next is the chat's next stored event. Sequence numbers have no gaps.
func (s *stream) next() event {
	s.t.Helper()
	var e event
	select {
	case e = <-s.events:
	case <-time.After(patience):
		s.t.Fatal("timeout waiting for an event")
	}
	if e.Seq != s.last+1 || e.At.IsZero() {
		s.t.Errorf("after event %d: %s", s.last, e.raw)
	}
	s.last = e.Seq
	return e
}

// until are the next events up to the first one that matches.
func (s *stream) until(match func(event) bool) []event {
	s.t.Helper()
	var events []event
	for {
		e := s.next()
		events = append(events, e)
		if match(e) {
			return events
		}
	}
}

// expect fails the test unless the next events are of these kinds.
func (s *stream) expect(want ...string) []event {
	s.t.Helper()
	var events []event
	for range want {
		events = append(events, s.next())
	}
	if got := kinds(events); got != strings.Join(want, " ") {
		s.t.Fatalf("events %s, want %s", got, strings.Join(want, " "))
	}
	return events
}

// quiet fails the test when an event comes within a moment.
func (s *stream) quiet() {
	s.t.Helper()
	select {
	case e := <-s.events:
		s.t.Errorf("an event nobody expected: %s", e.raw)
	case <-time.After(100 * time.Millisecond):
	}
}

// ends fails the test unless the host closes the connection.
func (s *stream) ends() {
	s.t.Helper()
	select {
	case <-s.closed:
	case <-time.After(patience):
		s.t.Fatal("the connection stays open")
	}
}

// send sends a command and returns its id.
func (s *stream) send(cmd chatproto.Command) string {
	s.t.Helper()
	s.ids++
	cmd.ID = "c" + strconv.Itoa(s.ids)
	s.c.write(cmd)
	return cmd.ID
}

// command sends a command and returns the error of its ack.
func (s *stream) command(cmd chatproto.Command) *chatproto.Error {
	s.t.Helper()
	return s.ack(s.send(cmd))
}

// ack is the error of the ack of the command id; acks of others that come
// before it are passed over.
func (s *stream) ack(id string) *chatproto.Error {
	s.t.Helper()
	for {
		select {
		case a := <-s.acks:
			if a.Seq != 0 {
				s.t.Fatalf("an ack with a sequence number: %s", a.raw)
			}
			if a.ID != id {
				continue
			}
			return a.Error
		case <-s.closed:
			s.t.Fatal("the connection ended before the ack")
		case <-time.After(patience):
			s.t.Fatal("timeout waiting for an ack")
		}
	}
}

// must sends a command that the host must accept.
func (s *stream) must(cmd chatproto.Command) {
	s.t.Helper()
	if e := s.command(cmd); e != nil {
		s.t.Fatalf("%s: %+v", cmd.Op, e)
	}
}

// mustNot sends a command that the host must refuse with a code.
func (s *stream) mustNot(cmd chatproto.Command, code string) *chatproto.Error {
	s.t.Helper()
	e := s.command(cmd)
	if e == nil || e.Code != code {
		s.t.Fatalf("%s: %+v, want %s", cmd.Op, e, code)
	}
	return e
}

func textBlock(text string) json.RawMessage {
	b, _ := json.Marshal(map[string]string{"type": "text", "text": text})
	return b
}

// prompt sends a message.
func (s *stream) prompt(text string) {
	s.t.Helper()
	s.must(chatproto.Command{Op: chatproto.OpPrompt, Content: []json.RawMessage{textBlock(text)}, ClientID: "u-" + text})
}

// create makes a chat of the fake agent and returns it as the host
// answered.
func (h *testHost) create(req chatproto.Request) chatproto.Chat {
	h.t.Helper()
	req.Op = chatproto.OpNew
	if req.Kind == "" {
		req.Kind = fakeKind
	}
	if req.Cwd == "" {
		req.Cwd = h.cwd
	}
	res := h.ok(req)
	if res.Chat == nil || !chatproto.ValidChatID(res.Chat.ID) || res.Chat.State != chatproto.StateStarting || res.Chat.Seq != 0 {
		h.t.Fatalf("new: %+v", res.Chat)
	}
	return *res.Chat
}

// newChat makes a chat of the fake agent, attaches to it and waits until
// it is idle.
func (h *testHost) newChat() *stream {
	h.t.Helper()
	chat := h.create(chatproto.Request{})
	s := h.attach(chat.ID, 0)
	s.session = h.fake.session(h.t)
	s.until(isKind("state:idle"))
	return s
}

// turn has the chat's agent take a prompt: the events up to the turn's
// start.
func (s *stream) turn(text string) {
	s.t.Helper()
	s.prompt(text)
	s.session.expect(s.t, "prompt:"+text)
	s.until(isKind("turn:start"))
}
