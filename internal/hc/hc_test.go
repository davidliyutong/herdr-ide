package hc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

type frame struct {
	channel uint32
	kind    byte
	payload []byte
}

// fakeCore is the core's end of a connection: it answers the hello and then
// hands the test every frame the client sends.
type fakeCore struct {
	t      *testing.T
	conn   net.Conn
	frames chan frame
}

const helloOK = `{"jsonrpc":"2.0","id":0,"result":{"generation":1,"version":"0.1.21","framed":true,"core":{"id":"c1","name":"box"},"methods":["hello"],"features":["automatic_input"]}}`

// dial connects a client to a fake core that answers the hello with reply.
func dial(t *testing.T, reply string) (*Conn, *Hello, *fakeCore, error) {
	t.Helper()
	a, b := net.Pipe()
	f := &fakeCore{t: t, conn: b, frames: make(chan frame, 64)}
	t.Cleanup(func() { b.Close() })
	hello := make(chan string, 1)
	go func() {
		br := bufio.NewReader(b)
		line, err := br.ReadString('\n')
		hello <- line
		if err != nil {
			return
		}
		if _, err := io.WriteString(b, reply+"\n"); err != nil {
			return
		}
		for {
			ch, kind, payload, err := readFrame(br)
			if err != nil {
				close(f.frames)
				return
			}
			f.frames <- frame{ch, kind, payload}
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, h, err := Dial(ctx, a)
	if err == nil {
		t.Cleanup(func() { c.Close() })
	}
	var req struct {
		Method string `json:"method"`
		Params struct {
			Framed     bool `json:"framed"`
			Generation int  `json:"generation"`
		} `json:"params"`
	}
	if json.Unmarshal([]byte(<-hello), &req) != nil || req.Method != "hello" || !req.Params.Framed || req.Params.Generation != 1 {
		t.Fatalf("hello request: %+v", req)
	}
	return c, h, f, err
}

func (f *fakeCore) next() frame {
	f.t.Helper()
	select {
	case fr, ok := <-f.frames:
		if !ok {
			f.t.Fatal("client closed the connection")
		}
		return fr
	case <-time.After(5 * time.Second):
		f.t.Fatal("no frame from the client")
	}
	return frame{}
}

// request reads the next call on channel 0.
func (f *fakeCore) request() (id uint64, method string, params json.RawMessage) {
	f.t.Helper()
	fr := f.next()
	var m struct {
		ID     uint64          `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if fr.channel != 0 || fr.kind != kindData || json.Unmarshal(fr.payload, &m) != nil {
		f.t.Fatalf("not a call: %+v", fr)
	}
	return m.ID, m.Method, m.Params
}

func (f *fakeCore) send(frames ...frame) {
	f.t.Helper()
	var b []byte
	for _, fr := range frames {
		b = appendFrame(b, fr.channel, fr.kind, fr.payload)
	}
	if _, err := f.conn.Write(b); err != nil {
		f.t.Fatalf("write: %v", err)
	}
}

func result(id uint64, body string) frame {
	return frame{0, kindData, []byte(`{"jsonrpc":"2.0","id":` + itoa(id) + `,"result":` + body + `}`)}
}

func itoa(n uint64) string { b, _ := json.Marshal(n); return string(b) }

func ctx5(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestFrameRoundTrip(t *testing.T) {
	b := appendFrame(nil, 7, kindResize, []byte{1, 2, 3, 4})
	want := []byte{7, 0, 0, 0, 3, 4, 0, 0, 0, 1, 2, 3, 4}
	if !bytes.Equal(b, want) {
		t.Fatalf("frame %v, want %v", b, want)
	}
	ch, kind, payload, err := readFrame(bytes.NewReader(b))
	if err != nil || ch != 7 || kind != kindResize || !bytes.Equal(payload, []byte{1, 2, 3, 4}) {
		t.Fatalf("read %d %d %v %v", ch, kind, payload, err)
	}
	if _, _, _, err := readFrame(bytes.NewReader(nil)); err != io.EOF {
		t.Fatalf("empty: %v", err)
	}
	if _, _, _, err := readFrame(bytes.NewReader(b[:11])); err != io.ErrUnexpectedEOF {
		t.Fatalf("truncated: %v", err)
	}
	big := binary.LittleEndian.AppendUint32([]byte{1, 0, 0, 0, 0}, MaxPayload+1)
	if _, _, _, err := readFrame(bytes.NewReader(big)); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversized: %v", err)
	}
}

func TestHello(t *testing.T) {
	_, h, _, err := dial(t, helloOK)
	if err != nil {
		t.Fatal(err)
	}
	if h.Version != "0.1.21" || h.Core.Name != "box" || !h.Has("automatic_input") || h.Has("other") {
		t.Fatalf("hello %+v", h)
	}
	for name, reply := range map[string]string{
		"generation": `{"jsonrpc":"2.0","id":0,"result":{"generation":2,"framed":true}}`,
		"plain":      `{"jsonrpc":"2.0","id":0,"result":{"generation":1,"framed":false}}`,
		"error":      `{"jsonrpc":"2.0","id":0,"error":{"code":-32000,"message":"no","data":{"kind":"unsupported"}}}`,
		"garbage":    `hello`,
		"too long":   `{"x":"` + strings.Repeat("a", maxHello+1) + `"}`,
	} {
		if _, _, _, err := dial(t, reply); err == nil {
			t.Errorf("%s: accepted", name)
		} else if name == "error" {
			var e *Error
			if !errors.As(err, &e) || e.Kind != "unsupported" {
				t.Errorf("error reply: %v", err)
			}
		}
	}
}

func TestCalls(t *testing.T) {
	c, _, f, err := dial(t, helloOK)
	if err != nil {
		t.Fatal(err)
	}
	type res struct {
		v   map[string]int
		err error
	}
	out := make(chan res, 2)
	for _, m := range []string{"a", "b"} {
		go func() {
			var v map[string]int
			err := c.Call(ctx5(t), m, nil, &v)
			out <- res{v, err}
		}()
	}
	ids := map[string]uint64{}
	for range 2 {
		id, method, params := f.request()
		if string(params) != "{}" {
			t.Fatalf("params %s", params)
		}
		ids[method] = id
	}
	// Answered in the other order, one with an error.
	f.send(frame{0, kindData, []byte(`{"jsonrpc":"2.0","id":` + itoa(ids["b"]) + `,"error":{"code":-32000,"message":"no terminal t9","data":{"kind":"not_found","hint":"h"}}}`)})
	r := <-out
	var e *Error
	if !errors.As(r.err, &e) || e.Kind != "not_found" || e.Hint != "h" || e.Code != -32000 {
		t.Fatalf("error %v", r.err)
	}
	f.send(result(ids["a"], `{"n":3}`))
	if r = <-out; r.err != nil || r.v["n"] != 3 {
		t.Fatalf("result %+v", r)
	}

	// A call given up is cancelled at the core, and its late reply dropped.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Call(ctx, "slow", nil, nil) }()
	id, _, _ := f.request()
	cancel()
	if err := <-done; err != context.Canceled {
		t.Fatalf("cancelled call: %v", err)
	}
	fr := f.next()
	if !strings.Contains(string(fr.payload), `"$/cancelRequest"`) || !strings.Contains(string(fr.payload), `"id":`+itoa(id)) {
		t.Fatalf("cancel %s", fr.payload)
	}
	f.send(result(id, `{}`))

	// The connection ending fails the calls waiting on it.
	go func() { done <- c.Call(context.Background(), "never", nil, nil) }()
	f.request()
	f.conn.Close()
	if err := <-done; err == nil {
		t.Fatal("call survived the connection")
	}
	<-c.Done()
	if c.Err() == nil || c.Call(context.Background(), "x", nil, nil) == nil {
		t.Fatal("closed connection took a call")
	}
}

func attach(t *testing.T, c *Conn, f *fakeCore, reply string, after ...frame) (*Stream, *Attached) {
	t.Helper()
	type res struct {
		s   *Stream
		a   *Attached
		err error
	}
	out := make(chan res, 1)
	go func() {
		s, a, err := c.Attach(ctx5(t), AttachParams{Terminal: "t7", Cols: 80, Rows: 24, History: 100})
		out <- res{s, a, err}
	}()
	id, method, params := f.request()
	var p AttachParams
	if method != "terminal.attach" || json.Unmarshal(params, &p) != nil || p.Terminal != "t7" || p.Cols != 80 || p.Rows != 24 || p.History != 100 {
		t.Fatalf("attach call %s %s", method, params)
	}
	// The reply and the first frames of the stream in one write: the
	// channel must be known before the frame behind the reply is read.
	f.send(append([]frame{result(id, reply)}, after...)...)
	r := <-out
	if r.err != nil {
		t.Fatal(r.err)
	}
	return r.s, r.a
}

func TestAttach(t *testing.T) {
	c, _, f, err := dial(t, helloOK)
	if err != nil {
		t.Fatal(err)
	}
	ctx := ctx5(t)
	s, a := attach(t, c, f,
		`{"channel":5,"automatic_input":true,"resize_notifications":true,"terminal":{"address":"t7","state":"live","cols":80,"rows":24,"labels":{},"screen":"exact"}}`,
		frame{5, kindResize, []byte{100, 0, 30, 0}},
		frame{5, kindData, []byte("paint")},
	)
	if a.Terminal.Address != "t7" || !a.ResizeNotifications {
		t.Fatalf("attached %+v", a)
	}
	if o, err := s.Recv(ctx); err != nil || o.Cols != 100 || o.Rows != 30 || o.Data != nil {
		t.Fatalf("resize %+v %v", o, err)
	}
	if o, err := s.Recv(ctx); err != nil || string(o.Data) != "paint" {
		t.Fatalf("data %+v %v", o, err)
	}

	expect := func(what string, kind byte, payload []byte) {
		t.Helper()
		if fr := f.next(); fr.channel != 5 || fr.kind != kind || !bytes.Equal(fr.payload, payload) {
			t.Fatalf("%s: %+v", what, fr)
		}
	}
	s.Ack(5)
	expect("credit", kindCredit, []byte{5, 0, 0, 0})
	s.Write([]byte("ls\r"))
	expect("input", kindData, []byte("ls\r"))
	s.WriteAutomatic([]byte("\x1b[?1;2c"))
	expect("automatic input", kindAutomaticInput, []byte("\x1b[?1;2c"))
	s.Resize(120, 40)
	expect("resize", kindResize, []byte{120, 0, 40, 0})
	if s.Resize(0, 40) == nil || s.Resize(70000, 40) == nil {
		t.Fatal("resize out of range accepted")
	}
	s.Focus(true)
	expect("focus", kindFocus, []byte{1})
	bg := "#000000"
	s.Facts(Display{BG: &bg, Cell: []int{8, 16}})
	expect("facts", kindFacts, []byte(`{"bg":"#000000","cell":[8,16]}`))

	// A stream waits without holding up calls or other streams.
	blocked, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	if _, err := s.Recv(blocked); err != context.DeadlineExceeded {
		t.Fatalf("empty stream: %v", err)
	}

	// The program ends: what was sent before is received, then EOF.
	if s.Exit() != nil {
		t.Fatal("exit before the close")
	}
	f.send(frame{5, kindData, []byte("bye")}, frame{5, kindClose, []byte(`{"reason":"exited","exit_code":3,"signal":null}`)})
	if o, err := s.Recv(ctx); err != nil || string(o.Data) != "bye" {
		t.Fatalf("last output %+v %v", o, err)
	}
	if _, err := s.Recv(ctx); err != io.EOF {
		t.Fatalf("after the close: %v", err)
	}
	if x := s.Exit(); x == nil || x.Reason != "exited" || x.ExitCode == nil || *x.ExitCode != 3 {
		t.Fatalf("exit %+v", x)
	}
	// Closing a stream the core ended sends nothing more.
	s.Close()
	go c.Call(ctx, "after", nil, nil)
	if _, method, _ := f.request(); method != "after" {
		t.Fatalf("after closing an ended stream: %s", method)
	}
}

func TestAttachWithoutAutomaticInput(t *testing.T) {
	c, _, f, err := dial(t, helloOK)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := attach(t, c, f, `{"channel":2,"terminal":{"address":"t7"}}`)
	s.WriteAutomatic([]byte("r"))
	if fr := f.next(); fr.kind != kindData || string(fr.payload) != "r" {
		t.Fatalf("automatic input on an old path: %+v", fr)
	}

	// Detaching closes the channel; output still on its way is dropped.
	s.Close()
	if fr := f.next(); fr.channel != 2 || fr.kind != kindClose || len(fr.payload) != 0 {
		t.Fatalf("close %+v", fr)
	}
	f.send(frame{2, kindData, []byte("late")}, frame{2, kindClose, nil})
	if _, err := s.Recv(ctx5(t)); err != ErrClosed {
		t.Fatalf("closed stream: %v", err)
	}
	s.Close()
	done := make(chan error, 1)
	go func() { done <- c.Call(ctx5(t), "after", nil, nil) }()
	id, method, _ := f.request() // not a second close
	if method != "after" {
		t.Fatalf("after closing twice: %s", method)
	}
	f.send(result(id, `{}`))
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestAttachGivenUp(t *testing.T) {
	c, _, f, err := dial(t, helloOK)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, _, err := c.Attach(ctx, AttachParams{Terminal: "t7", Cols: 80, Rows: 24})
		done <- err
	}()
	id, _, _ := f.request()
	cancel()
	if err := <-done; err != context.Canceled {
		t.Fatalf("attach: %v", err)
	}
	f.next() // $/cancelRequest
	// The core attached anyway: the viewer nobody reads is detached.
	f.send(result(id, `{"channel":9,"terminal":{"address":"t7"}}`), frame{9, kindData, []byte("paint")})
	if fr := f.next(); fr.channel != 9 || fr.kind != kindClose {
		t.Fatalf("late attach not closed: %+v", fr)
	}
}

func TestCreditOverrun(t *testing.T) {
	c, _, f, err := dial(t, helloOK)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := attach(t, c, f, `{"channel":3,"terminal":{"address":"t7"}}`)
	chunk := make([]byte, 64<<10)
	go func() {
		for range maxQueued/len(chunk) + 1 {
			if _, err := f.conn.Write(appendFrame(nil, 3, kindData, chunk)); err != nil {
				return
			}
		}
	}()
	select {
	case <-c.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("a core ignoring credit was not disconnected")
	}
	if err := c.Err(); err == nil || !strings.Contains(err.Error(), "credit") {
		t.Fatalf("error %v", err)
	}
	if _, err := s.Recv(ctx5(t)); err == nil || err == io.EOF {
		t.Fatalf("stream of a failed connection: %v", err)
	}
}

func TestEvents(t *testing.T) {
	c, _, f, err := dial(t, helloOK)
	if err != nil {
		t.Fatal(err)
	}
	ctx := ctx5(t)
	type res struct {
		e   *Events
		s   *Subscribed
		err error
	}
	out := make(chan res, 1)
	go func() {
		e, s, err := c.Subscribe(ctx, SubscribeParams{Labels: map[string]string{"app": "x"}})
		out <- res{e, s, err}
	}()
	id, method, params := f.request()
	if method != "events.subscribe" || string(params) != `{"labels":{"app":"x"}}` {
		t.Fatalf("subscribe %s %s", method, params)
	}
	// Lines arrive split anywhere, several to a frame.
	lines := `{"jsonrpc":"2.0","method":"event","params":{"seq":42,"type":"status","terminal":"rohan/t7","data":{"status":{"state":"working"}}}}` + "\n" +
		`{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":42}}` + "\n" +
		`{"jsonrpc":"2.0","method":"event","params":{"seq":43,"type":"doc","machine":"rohan","data":{"name":"layout","version":2}}}` + "\n" +
		`{"jsonrpc":"2.0","method":"missed","params":{"seq":57,"terminals":[{"address":"t1","state":"live"}]}}` + "\n"
	f.send(result(id, `{"channel":4,"seq":41,"terminals":[{"address":"t7","state":"live","status":{"state":"idle"}}]}`),
		frame{4, kindData, []byte(lines[:50])}, frame{4, kindData, []byte(lines[50:])})
	r := <-out
	if r.err != nil {
		t.Fatal(r.err)
	}
	if r.s.Seq != 41 || len(r.s.Terminals) != 1 || r.s.Terminals[0].Status.State != "idle" {
		t.Fatalf("snapshot %+v", r.s)
	}
	credits := make(chan int, 2)
	go func() {
		for range 2 {
			fr := f.next()
			if fr.channel != 4 || fr.kind != kindCredit {
				t.Errorf("not a credit: %+v", fr)
			}
			credits <- int(binary.LittleEndian.Uint32(fr.payload))
		}
	}()
	n, err := r.e.Recv(ctx)
	if err != nil || n.Method != "event" || n.Seq != 42 || n.Type != "status" || n.Terminal != "rohan/t7" || !strings.Contains(string(n.Data), "working") {
		t.Fatalf("event %+v %v", n, err)
	}
	if n, _ = r.e.Recv(ctx); n.Method != "heartbeat" || n.Seq != 42 {
		t.Fatalf("heartbeat %+v", n)
	}
	if n, _ = r.e.Recv(ctx); n.Type != "doc" || n.Machine != "rohan" || n.Terminal != "" {
		t.Fatalf("doc event %+v", n)
	}
	if n, _ = r.e.Recv(ctx); n.Method != "missed" || n.Seq != 57 || len(n.Terminals) != 1 || n.Terminals[0].Address != "t1" {
		t.Fatalf("missed %+v", n)
	}
	if a, b := <-credits, <-credits; a != 50 || b != len(lines)-50 {
		t.Fatalf("credits %d %d", a, b)
	}
	r.e.Close()
	if fr := f.next(); fr.channel != 4 || fr.kind != kindClose {
		t.Fatalf("close %+v", fr)
	}
	if _, err := r.e.Recv(ctx); err != ErrClosed {
		t.Fatalf("closed subscription: %v", err)
	}
}

func TestDialCancelled(t *testing.T) {
	a, b := net.Pipe()
	defer b.Close()
	go io.Copy(io.Discard, b) // a core that never answers
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, _, err := Dial(ctx, a); err != context.DeadlineExceeded {
		t.Fatalf("dial: %v", err)
	}
	if _, err := a.Write([]byte("x")); err == nil {
		t.Fatal("connection left open")
	}
}
