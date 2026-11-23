package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var bg = context.Background()

func TestErrorResponse(t *testing.T) {
	c, a := start(t, nil)
	errc := asyncErr(func() error {
		return c.Call(bg, MethodSessionList, ListSessionsParams{Cursor: "stale"}, &ListSessionsResult{})
	})
	req := a.next()
	a.send(fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"error":{"code":-32602,"message":"Invalid params","data":{"cursor": "stale"}}}`, req.ID))

	err := await(t, errc, "the call")
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("err = %v, want an *Error", err)
	}
	if e.Code != CodeInvalidParams || e.Message != "Invalid params" || string(e.Data) != `{"cursor": "stale"}` {
		t.Fatalf("error = %+v, data %s", e, e.Data)
	}
	if errors.Is(err, ErrClosed) || errors.Is(err, ErrMethodNotFound) {
		t.Fatalf("err = %v matches errors it is not", err)
	}

	// An agent that does not know a method says so with -32601.
	errc = asyncErr(func() error { return c.Call(bg, MethodSessionList, ListSessionsParams{}, nil) })
	req = a.next()
	a.send(fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"no such method: session/list"}}`, req.ID))
	if err := await(t, errc, "the call"); !errors.Is(err, ErrMethodNotFound) {
		t.Fatalf("err = %v, want ErrMethodNotFound", err)
	}

	// An error that is no error object still fails the call.
	errc = asyncErr(func() error { return c.Call(bg, MethodSessionList, nil, nil) })
	req = a.next()
	a.send(fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"error":"boom"}`, req.ID))
	if err := await(t, errc, "the call"); !errors.As(err, &e) || e.Code != CodeInternalError || string(e.Data) != `"boom"` {
		t.Fatalf("err = %v", err)
	}
}

func TestAgentRequests(t *testing.T) {
	h := newRecorder()
	h.serve = func(ctx context.Context, method string, params json.RawMessage) (any, error) {
		switch method {
		case "fail":
			return nil, errors.New("open /home/user/.secrets/token: permission denied")
		case "refuse":
			return nil, &Error{Code: -32000, Message: "Not now", Data: json.RawMessage(`{"retry":true}`)}
		case "baddata":
			return nil, &Error{Code: -32001, Message: "Busy", Data: json.RawMessage("not JSON")}
		case "wrapped":
			return nil, fmt.Errorf("hidden context: %w", &Error{Code: CodeInvalidParams, Message: "Invalid params"})
		case "unencodable":
			return make(chan int), nil
		case "nothing":
			return nil, nil
		case "echo":
			return map[string]json.RawMessage{"params": params}, nil
		}
		return nil, fmt.Errorf("%w: %s", ErrMethodNotFound, method)
	}
	c, a := start(t, h)

	tests := []struct {
		request string // without the jsonrpc member
		want    string
	}{
		// The client states no fs and no terminal capability; a request
		// for them is one for an unknown method.
		{`"id":1,"method":"fs/read_text_file","params":{"sessionId":"s","path":"/etc/passwd"}`,
			`{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}`},
		{`"id":2,"method":"terminal/create","params":{"sessionId":"s","command":"sh"}`,
			`{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found"}}`},
		{`"id":3,"method":"fail"`,
			`{"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"Internal error"}}`},
		{`"id":4,"method":"refuse"`,
			`{"jsonrpc":"2.0","id":4,"error":{"code":-32000,"message":"Not now","data":{"retry":true}}}`},
		{`"id":40,"method":"baddata"`,
			`{"jsonrpc":"2.0","id":40,"error":{"code":-32001,"message":"Busy"}}`},
		{`"id":5,"method":"wrapped"`,
			`{"jsonrpc":"2.0","id":5,"error":{"code":-32602,"message":"Invalid params"}}`},
		{`"id":6,"method":"unencodable"`,
			`{"jsonrpc":"2.0","id":6,"error":{"code":-32603,"message":"Internal error"}}`},
		{`"id":7,"method":"nothing"`,
			`{"jsonrpc":"2.0","id":7,"result":null}`},
		// The id goes back as the agent wrote it, whatever its type.
		{`"id":"req-8","method":"echo","params":{"a": [1, 2]}`,
			`{"jsonrpc":"2.0","id":"req-8","result":{"params":{"a":[1,2]}}}`},
		{`"id":9.5,"method":"echo"`,
			`{"jsonrpc":"2.0","id":9.5,"result":{"params":null}}`},
	}
	for _, tt := range tests {
		a.send(`{"jsonrpc":"2.0",` + tt.request + `}`)
		if got := strings.TrimSuffix(a.next().line, "\n"); got != tt.want {
			t.Errorf("request %s\n got %s\nwant %s", tt.request, got, tt.want)
		}
	}
	if err := c.Err(); err != nil {
		t.Fatalf("connection ended: %v", err)
	}
}

func TestNoHandler(t *testing.T) {
	_, a := start(t, nil)
	a.update(`{"sessionId":"s","update":{"sessionUpdate":"plan","entries":[]}}`)
	a.send(`{"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{}}`)
	want := `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}`
	if got := strings.TrimSuffix(a.next().line, "\n"); got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestCallContext(t *testing.T) {
	c, a := start(t, nil)

	ctx, cancel := context.WithCancel(bg)
	errc := asyncErr(func() error { return c.Call(ctx, "slow", nil, nil) })
	slow := a.next()
	cancel()
	if err := await(t, errc, "the cancelled call"); err != context.Canceled {
		t.Fatalf("err = %v, want context.Canceled", err)
	}

	// The response comes late: it is dropped, and the connection goes on.
	if n := waiting(c); n != 0 {
		t.Fatalf("%d calls wait after the only one gave up", n)
	}
	a.reply(slow, `{"late":true}`)
	var got struct {
		N int `json:"n"`
	}
	errc = asyncErr(func() error { return c.Call(bg, "next", nil, &got) })
	next := a.next()
	if string(next.ID) == string(slow.ID) {
		t.Fatalf("id %s used twice", next.ID)
	}
	a.reply(next, `{"n":7}`)
	if err := await(t, errc, "the next call"); err != nil || got.N != 7 {
		t.Fatalf("next call: n = %d, err = %v", got.N, err)
	}

	// A call with a context that is over sends nothing.
	if err := c.Call(ctx, "never", nil, nil); err != context.Canceled {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if err := c.Err(); err != nil {
		t.Fatalf("connection ended: %v", err)
	}
	if rest := a.rest(); len(rest) != 0 {
		t.Fatalf("client wrote %q", rest)
	}
}

func TestAgentExits(t *testing.T) {
	c, a := start(t, nil)
	first := asyncErr(func() error { return c.Call(bg, "one", nil, nil) })
	second := asyncErr(func() error { return c.Call(bg, "two", nil, nil) })
	a.next()
	a.next()
	if err := c.Err(); err != nil {
		t.Fatalf("Err = %v while the connection runs", err)
	}
	a.exit()

	for _, errc := range []<-chan error{first, second} {
		err := await(t, errc, "a pending call")
		if !errors.Is(err, ErrClosed) || !errors.Is(err, io.EOF) {
			t.Fatalf("pending call: err = %v, want ErrClosed with io.EOF", err)
		}
	}
	await(t, c.Done(), "Done")
	if err := c.Err(); err != io.EOF {
		t.Fatalf("Err = %v, want io.EOF", err)
	}
	if err := c.Call(bg, "three", nil, nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("later call: err = %v, want ErrClosed", err)
	}
	if n := waiting(c); n != 0 {
		t.Fatalf("%d calls wait on a connection that ended", n)
	}
	if err := c.Notify("four", nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("later notification: err = %v, want ErrClosed", err)
	}
	if rest := a.rest(); len(rest) != 0 {
		t.Fatalf("client wrote %q after the end", rest)
	}
}

// answering is the standard input of an agent that answers a request and
// exits at once: the answer and the end of its output are both there when
// the write of the request returns.
type answering struct {
	stdout *io.PipeWriter
	done   <-chan struct{}
}

func (w *answering) Write(p []byte) (int, error) {
	var req msg
	if err := json.Unmarshal(p, &req); err != nil {
		return 0, err
	}
	fmt.Fprintf(w.stdout, `{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}`, req.ID) // and no newline
	w.stdout.Close()
	<-w.done
	return len(p), nil
}

// An agent may answer and exit: the answer counts, though the connection
// ended before the call looked for it.
func TestResponseThenExit(t *testing.T) {
	for i := range 100 {
		fromAgent, stdout := io.Pipe()
		w := &answering{stdout: stdout}
		c := NewConn(fromAgent, w, nil)
		w.done = c.Done()
		var got struct {
			OK bool `json:"ok"`
		}
		if err := c.Call(bg, "last", nil, &got); err != nil || !got.OK {
			t.Fatalf("round %d: ok = %v, err = %v", i, got.OK, err)
		}
		if err := c.Err(); err != io.EOF {
			t.Fatalf("round %d: Err = %v, want io.EOF", i, err)
		}
		ended(t, c)
	}
}

func TestLastLineWithoutNewline(t *testing.T) {
	h := newRecorder()
	c, a := start(t, h)
	a.write(`{"jsonrpc":"2.0","method":"session/update","params":{"last":true}}`)
	a.exit()
	await(t, c.Done(), "Done")
	if got := h.got(); len(got) != 1 || got[0].params != `{"last":true}` {
		t.Fatalf("notifications = %v", got)
	}
	if c.Err() != io.EOF || c.Skipped() != 0 {
		t.Fatalf("Err = %v, skipped = %d", c.Err(), c.Skipped())
	}
}

func TestClose(t *testing.T) {
	h := newRecorder()
	entered := make(chan struct{}, 1)
	left := make(chan error, 1)
	h.serve = func(ctx context.Context, method string, params json.RawMessage) (any, error) {
		entered <- struct{}{}
		<-ctx.Done()
		left <- ctx.Err()
		return PermissionCancelled(), nil
	}
	c, a := start(t, h)
	errc := asyncErr(func() error { return c.Call(bg, MethodSessionPrompt, nil, nil) })
	a.next()
	a.send(`{"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{}}`)
	await(t, entered, "the request")
	select {
	case <-c.Done():
		t.Fatal("Done before the end")
	default:
	}

	c.Close()
	c.Close()
	if err := await(t, errc, "the pending call"); err != ErrClosed {
		t.Fatalf("pending call: err = %v, want ErrClosed", err)
	}
	await(t, c.Done(), "Done")
	if err := c.Err(); err != ErrClosed {
		t.Fatalf("Err = %v, want ErrClosed", err)
	}
	if err := await(t, left, "the request's context"); err != context.Canceled {
		t.Fatalf("request's context: %v", err)
	}
	if err := c.Call(bg, "later", nil, nil); err != ErrClosed {
		t.Fatalf("later call: err = %v, want ErrClosed", err)
	}
	if err := c.Cancel("s"); err != ErrClosed {
		t.Fatalf("later notification: err = %v, want ErrClosed", err)
	}

	// Close left the pipes open; the reader ends with the agent's output.
	// The request that waited is not answered any more.
	a.exit()
	ended(t, c)
	if rest := a.rest(); len(rest) != 0 {
		t.Fatalf("client wrote %q after Close", rest)
	}
}

func TestWriteFails(t *testing.T) {
	c, a := start(t, nil)
	a.stdin.Close() // the agent no longer reads
	err := c.Call(bg, MethodInitialize, nil, nil)
	if !errors.Is(err, ErrClosed) || !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("err = %v, want ErrClosed with the write's error", err)
	}
	await(t, c.Done(), "Done")
	if err := c.Err(); !errors.Is(err, io.ErrClosedPipe) || errors.Is(err, ErrClosed) {
		t.Fatalf("Err = %v, want the write's error", err)
	}
	if err := c.Notify(MethodSessionCancel, nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("later notification: err = %v, want ErrClosed", err)
	}
}

// failing is an agent's standard output that breaks.
type failing struct{ err error }

func (f failing) Read([]byte) (int, error) { return 0, f.err }

func TestReadFails(t *testing.T) {
	boom := errors.New("input/output error")
	h := newRecorder()
	r := io.MultiReader(strings.NewReader(`{"jsonrpc":"2.0","method":"session/update","params":{"n":1}}`+"\n"+`{"jsonrpc":"2.0","method":"session/update","params":{"n":2}}`), failing{boom})
	c := NewConn(r, io.Discard, h)
	await(t, c.Done(), "Done")
	if err := c.Err(); !errors.Is(err, boom) || errors.Is(err, ErrClosed) || errors.Is(err, io.EOF) {
		t.Fatalf("Err = %v, want the read's error", err)
	}
	if err := c.Call(bg, "later", nil, nil); !errors.Is(err, ErrClosed) || !errors.Is(err, boom) {
		t.Fatalf("later call: err = %v, want ErrClosed with the read's error", err)
	}
	// The line the error cut is no message.
	if got := h.got(); len(got) != 1 || got[0].params != `{"n":1}` {
		t.Fatalf("notifications = %v", got)
	}
	ended(t, c)
}

// stuck is an agent's standard input that takes nothing.
type stuck struct {
	entered chan struct{}
	release chan struct{}
}

func (s *stuck) Write(p []byte) (int, error) {
	s.entered <- struct{}{}
	<-s.release
	return 0, io.ErrClosedPipe
}

// A write the agent does not take holds up the others, which give up with
// their context or with the connection.
func TestWriteHeldUp(t *testing.T) {
	fromAgent, stdout := io.Pipe()
	w := &stuck{entered: make(chan struct{}, 1), release: make(chan struct{})}
	c := NewConn(fromAgent, w, nil)

	first := asyncErr(func() error { return c.Notify("first", nil) })
	await(t, w.entered, "the first write")

	ctx, cancel := context.WithTimeout(bg, 20*time.Millisecond)
	defer cancel()
	if err := c.Call(ctx, "second", nil, nil); err != context.DeadlineExceeded {
		t.Fatalf("call behind a write: err = %v, want context.DeadlineExceeded", err)
	}
	third := asyncErr(func() error { return c.Notify("third", nil) })
	select {
	case err := <-third:
		t.Fatalf("notification behind a write returned: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	c.Close()
	if err := await(t, third, "the notification behind a write"); err != ErrClosed {
		t.Fatalf("notification behind a write: err = %v, want ErrClosed", err)
	}

	close(w.release) // the owner closes the agent's standard input
	if err := await(t, first, "the first write"); err != ErrClosed {
		t.Fatalf("first write: err = %v, want ErrClosed", err)
	}
	stdout.Close()
	ended(t, c)
}

func TestOversizedLine(t *testing.T) {
	c, a := start(t, nil)
	errc := asyncErr(func() error { return c.Call(bg, MethodSessionPrompt, nil, nil) })
	a.next()

	written := make(chan struct{})
	go func() {
		defer close(written)
		chunk := bytes.Repeat([]byte("a"), 1<<20)
		for range MaxMessage/len(chunk) + 1 { // one chunk more than a line may have
			if _, err := a.stdout.Write(chunk); err != nil {
				return
			}
		}
	}()
	err := await(t, errc, "the pending call")
	if !errors.Is(err, ErrClosed) || !errors.Is(err, ErrTooLarge) {
		t.Fatalf("pending call: err = %v, want ErrClosed with ErrTooLarge", err)
	}
	if err := c.Err(); err != ErrTooLarge || !strings.Contains(err.Error(), "longer than MaxMessage") {
		t.Fatalf("Err = %v, want ErrTooLarge", err)
	}
	a.exit()
	<-written
}

// endless is an agent's standard output with a line that never ends.
type endless struct{ n atomic.Int64 }

func (e *endless) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'a'
	}
	e.n.Add(int64(len(p)))
	return len(p), nil
}

func TestOversizedLineIsNotBuffered(t *testing.T) {
	r := &endless{}
	c := NewConn(r, io.Discard, nil)
	await(t, c.Done(), "Done")
	if err := c.Err(); err != ErrTooLarge {
		t.Fatalf("Err = %v, want ErrTooLarge", err)
	}
	ended(t, c) // the reader stopped though its input goes on
	if n := r.n.Load(); n > MaxMessage+2*readBuffer {
		t.Fatalf("read %d bytes of a line of at most %d", n, MaxMessage)
	}
}

func TestLongestLine(t *testing.T) {
	const limit = 3*readBuffer + 17 // a line of several reads
	line := func(n int) string {
		const head, tail = `{"jsonrpc":"2.0","method":"big","params":"`, `"}`
		return head + strings.Repeat("x", n-len(head)-len(tail)) + tail
	}

	h := newRecorder()
	c, a := startMax(t, h, limit)
	a.send(line(limit))
	if n := await(t, h.seen, "the longest line"); len(n.params) != limit-len(`{"jsonrpc":"2.0","method":"big","params":}`) {
		t.Fatalf("params of %d bytes", len(n.params))
	}
	a.send(line(limit) + "\r") // the carriage return of a CRLF is part of the line
	await(t, c.Done(), "Done")
	if err := c.Err(); err != ErrTooLarge {
		t.Fatalf("Err = %v, want ErrTooLarge", err)
	}
	if got := h.got(); len(got) != 1 {
		t.Fatalf("%d notifications, want 1", len(got))
	}
}

// A long line's buffer is not kept, and no line's params are the buffer of
// the next.
func TestLongLines(t *testing.T) {
	h := newRecorder()
	_, a := start(t, h)
	big := `{"text":"` + strings.Repeat("x", 2*keepBuffer) + `"}`
	want := []string{`{"n":1}`, big, `{"n":2}`, `{"n":3,"text":"longer than the one before"}`, big}
	for _, p := range want {
		a.update(p)
	}
	for range want {
		await(t, h.seen, "a notification")
	}
	for i, n := range h.got() {
		if n.params != want[i] {
			t.Fatalf("notification %d: %d bytes, %.40s; want %d bytes, %.40s", i, len(n.params), n.params, len(want[i]), want[i])
		}
	}
}

func TestNoise(t *testing.T) {
	h := newRecorder()
	c, a := start(t, h)
	res := async(func() (*NewSessionResult, error) { return c.NewSession(bg, NewSessionParams{Cwd: "/w"}) })
	req := a.next()

	// Not JSON objects: skipped and counted.
	a.send("Starting agent 1.2.3 ...")
	a.send(`[{"jsonrpc":"2.0","method":"session/update","params":{"batch":true}}]`)
	a.send(`"text"`)
	a.send("42")
	a.send("null")
	a.send(`{"jsonrpc":"2.0","method":"session/update","params":{"cut":`)
	const skipped = 6
	// Blank lines: nothing.
	a.write("\n   \n\t\r\n")
	// JSON objects that are no messages of use: ignored.
	a.send(`{"level":"info","msg":"a log line as JSON"}`)
	// A vendor's own notification: counted, and the handler gets none.
	a.send(`{"jsonrpc":"2.0","method":"_x.ai/sessions/changed","params":{"upserted":[]}}`)
	// A request whose method is no string is answered all the same: an
	// agent that is not answered waits.
	a.send(`{"jsonrpc":"2.0","method":7,"id":` + string(req.ID) + `}`)
	if got, want := a.next().line, `{"jsonrpc":"2.0","id":`+string(req.ID)+`,"error":{"code":-32600,"message":"Invalid Request"}}`+"\n"; got != want {
		t.Fatalf("answer to a request without a method: %s, want %s", got, want)
	}
	a.send(`{"jsonrpc":"2.0","id":999,"result":{"sessionId":"no such call"}}`)
	a.send(`{"jsonrpc":"2.0","id":"` + string(req.ID) + `","result":{"sessionId":"a string is no id of this client"}}`)
	a.send(`{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}`)
	// Messages between them, one with CRLF and spaces around it.
	a.update(`{"n":1}`)
	a.write("  " + `{"jsonrpc":"2.0","method":"session/update","params":{"n":2}}` + " \r\n")
	// A request with a null id is a notification: there is nothing to answer to.
	a.send(`{"jsonrpc":"2.0","id":null,"method":"session/update","params":{"n":3}}`)
	a.reply(req, `{"sessionId":"sess_1"}`)

	got := await(t, res, "session/new")
	if got.err != nil || got.res.SessionID != "sess_1" {
		t.Fatalf("session/new: %+v, err = %v", got.res, got.err)
	}
	want := []note{{"session/update", `{"n":1}`}, {"session/update", `{"n":2}`}, {"session/update", `{"n":3}`}}
	if notes := h.got(); fmt.Sprint(notes) != fmt.Sprint(want) {
		t.Fatalf("notifications = %v, want %v", notes, want)
	}
	if n := c.Skipped(); n != skipped {
		t.Fatalf("skipped = %d, want %d", n, skipped)
	}
	if n := c.Vendor(); n != 1 {
		t.Fatalf("vendor notifications = %d, want 1", n)
	}
	if err := c.Err(); err != nil {
		t.Fatalf("connection ended: %v", err)
	}
	if rest := a.rest(); len(rest) != 0 {
		t.Fatalf("client answered noise: %q", rest)
	}
}

// What is handed on verbatim must be text: bytes that are not UTF-8 are
// replaced, as a JSON decoder would.
func TestInvalidUTF8(t *testing.T) {
	h := newRecorder()
	_, a := start(t, h)
	a.update("{\"text\":\"caf\xc3\xa9 \xff\xfe!\"}")
	want := "{\"text\":\"caf\xc3\xa9 \xef\xbf\xbd!\"}"
	if n := await(t, h.seen, "the notification"); n.params != want {
		t.Fatalf("params = %q, want %q", n.params, want)
	}
}

func TestOneLinePerMessage(t *testing.T) {
	c, a := start(t, nil)
	block := json.RawMessage("{\n  \"type\": \"text\",\n  \"text\": \"a <b> & c\\nd\"\n}\n")
	res := async(func() (*PromptResult, error) {
		return c.Prompt(bg, PromptParams{SessionID: "s", Prompt: []json.RawMessage{block}})
	})
	req := a.next() // fails on a message of several lines
	want := `{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"sessionId":"s","prompt":[{"type":"text","text":"a <b> & c\nd"}]}}` + "\n"
	if req.line != want {
		t.Fatalf("got  %swant %s", req.line, want)
	}
	a.reply(req, `{"stopReason":"end_turn"}`)
	if got := await(t, res, "the prompt"); got.err != nil {
		t.Fatal(got.err)
	}

	// Params that are not JSON never reach the agent.
	err := c.Call(bg, "bad", json.RawMessage("{\"a\":1}\n{\"b\":2}"), nil)
	if err == nil || errors.Is(err, ErrClosed) {
		t.Fatalf("err = %v, want an error of the params", err)
	}
	if err := c.Notify("bad", make(chan int)); err == nil || errors.Is(err, ErrClosed) {
		t.Fatalf("err = %v, want an error of the params", err)
	}
	if rest := a.rest(); len(rest) != 0 {
		t.Fatalf("client wrote %q", rest)
	}
}

func TestConcurrentCalls(t *testing.T) {
	c, a := start(t, nil)
	const n = 64
	type result struct {
		sent, got int
		err       error
	}
	results := make(chan result, n)
	for i := range n {
		go func() {
			var out struct {
				N int `json:"n"`
			}
			err := c.Call(bg, "echo", map[string]int{"n": i}, &out)
			results <- result{i, out.N, err}
		}()
	}

	reqs := make([]msg, n)
	var last int64
	for i := range reqs {
		reqs[i] = a.next()
		id, err := strconv.ParseInt(string(reqs[i].ID), 10, 64)
		if err != nil || id <= last {
			t.Fatalf("id %s after %d: ids are increasing integers", reqs[i].ID, last)
		}
		last = id
	}
	// The answers come in another order than the requests.
	for i := range n {
		req := reqs[(i*37+11)%n]
		a.reply(req, string(req.Params))
	}
	for range n {
		r := await(t, results, "a call")
		if r.err != nil || r.got != r.sent {
			t.Fatalf("call %d: got %d, err = %v", r.sent, r.got, r.err)
		}
	}
}

// Requests of the agent served at once are bounded: once maxServing wait,
// the agent's output waits; every request is still answered.
func TestServingBound(t *testing.T) {
	h := newRecorder()
	release := make(chan struct{})
	var inside atomic.Int32
	var most atomic.Int32
	h.serve = func(ctx context.Context, method string, params json.RawMessage) (any, error) {
		n := inside.Add(1)
		for {
			m := most.Load()
			if n <= m || most.CompareAndSwap(m, n) {
				break
			}
		}
		defer inside.Add(-1)
		select {
		case <-release:
		case <-ctx.Done():
		}
		return PermissionCancelled(), nil
	}
	_, a := start(t, h)
	const n = maxServing + 10
	sent := make(chan struct{})
	go func() {
		defer close(sent)
		for i := range n {
			fmt.Fprintf(a.stdout, `{"jsonrpc":"2.0","id":%d,"method":"session/request_permission","params":{}}`+"\n", i)
		}
	}()
	deadline := time.Now().Add(patience)
	for inside.Load() < maxServing && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	select {
	case <-sent:
		t.Fatal("the agent wrote every request while maxServing waited")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	await(t, sent, "the agent's requests")
	for range n {
		if m := a.next(); string(m.Result) != `{"outcome":{"outcome":"cancelled"}}` {
			t.Fatalf("answer = %s", m.line)
		}
	}
	if m := most.Load(); m > maxServing {
		t.Fatalf("%d requests served at once, at most %d", m, maxServing)
	}
}

// Go returns once the request is written; what is sent after it follows
// it, and Wait takes the response.
func TestGo(t *testing.T) {
	c, a := start(t, nil)
	p, err := c.GoPrompt(bg, PromptParams{SessionID: "s", Prompt: []json.RawMessage{textBlock("hi")}})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Cancel("s"); err != nil {
		t.Fatal(err)
	}
	req, cancel := a.next(), a.next()
	if req.Method != MethodSessionPrompt || cancel.Method != MethodSessionCancel {
		t.Fatalf("sent %s then %s", req.line, cancel.line)
	}
	a.reply(req, `{"stopReason":"cancelled"}`)
	var res PromptResult
	if err := p.Wait(bg, &res); err != nil || res.StopReason != StopCancelled {
		t.Fatalf("result %+v, err %v", res, err)
	}

	// A Wait whose context ended drops the response.
	p, err = c.Go(bg, "slow", nil)
	if err != nil {
		t.Fatal(err)
	}
	req = a.next()
	ctx, stop := context.WithCancel(bg)
	stop()
	if err := p.Wait(ctx, nil); err != context.Canceled || waiting(c) != 0 {
		t.Fatalf("err = %v, %d calls wait", err, waiting(c))
	}
	a.reply(req, `{}`)
}
