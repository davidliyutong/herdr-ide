package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// patience is how long a test waits for something that must happen.
const patience = 5 * time.Second

// fakeAgent is the agent's end of a connection: the test reads the lines the
// client writes to its standard input and writes those of its standard
// output.
type fakeAgent struct {
	t      *testing.T
	stdin  *io.PipeReader
	stdout *io.PipeWriter
	lines  chan string // the client's lines; closed when stdin ended
}

// msg is a line of the client.
type msg struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	Result  json.RawMessage `json:"result"`
	Error   *Error          `json:"error"`
	line    string
}

// start connects a client to a fake agent. When the test ends it closes the
// pipes and the connection and checks that no goroutine of the connection
// is left.
func start(t *testing.T, h Handler) (*Conn, *fakeAgent) {
	t.Helper()
	return startMax(t, h, MaxMessage)
}

func startMax(t *testing.T, h Handler, limit int) (*Conn, *fakeAgent) {
	t.Helper()
	fromAgent, stdout := io.Pipe()
	stdin, toAgent := io.Pipe()
	a := &fakeAgent{t: t, stdin: stdin, stdout: stdout, lines: make(chan string, 1024)}
	go func() {
		defer close(a.lines)
		br := bufio.NewReader(stdin)
		for {
			line, err := br.ReadString('\n')
			if line != "" {
				a.lines <- line
			}
			if err != nil {
				return
			}
		}
	}()
	c := newConn(fromAgent, toAgent, h, limit)
	t.Cleanup(func() {
		stdout.Close()
		stdin.Close()
		c.Close()
		ended(t, c)
	})
	return c, a
}

// waiting is the number of calls the connection keeps a place for.
func waiting(c *Conn) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.pending)
}

// ended fails the test when goroutines of the connection still run.
func ended(t *testing.T, c *Conn) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		c.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(patience):
		t.Error("goroutines of the connection still run")
	}
}

// await takes the next value of ch.
func await[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(patience):
		t.Fatalf("timeout waiting for %s", what)
		panic("unreachable")
	}
}

// next is the client's next message: one line, one JSON object.
func (a *fakeAgent) next() msg {
	a.t.Helper()
	select {
	case line, ok := <-a.lines:
		if !ok {
			a.t.Fatal("the client's output ended")
		}
		var m msg
		if !strings.HasSuffix(line, "\n") || strings.Count(line, "\n") != 1 {
			a.t.Fatalf("not one line: %q", line)
		}
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			a.t.Fatalf("client wrote %q: %v", line, err)
		}
		if m.JSONRPC != "2.0" {
			a.t.Fatalf("client wrote %q: no jsonrpc 2.0", line)
		}
		m.line = line
		return m
	case <-time.After(patience):
		a.t.Fatal("timeout waiting for a message of the client")
		panic("unreachable")
	}
}

// rest ends the agent's standard input and returns the lines of the client
// that no next took.
func (a *fakeAgent) rest() []string {
	a.t.Helper()
	a.stdin.Close()
	var lines []string
	for {
		select {
		case line, ok := <-a.lines:
			if !ok {
				return lines
			}
			lines = append(lines, line)
		case <-time.After(patience):
			a.t.Fatal("timeout waiting for the end of the client's output")
		}
	}
}

// write writes to the agent's standard output as it is.
func (a *fakeAgent) write(s string) {
	a.t.Helper()
	errc := make(chan error, 1)
	go func() {
		_, err := io.WriteString(a.stdout, s)
		errc <- err
	}()
	select {
	case err := <-errc:
		if err != nil {
			a.t.Fatalf("agent write: %v", err)
		}
	case <-time.After(patience):
		a.t.Fatalf("the client does not read %q", s)
	}
}

// send writes one line.
func (a *fakeAgent) send(line string) {
	a.t.Helper()
	a.write(line + "\n")
}

// reply answers a request of the client with a result.
func (a *fakeAgent) reply(req msg, result string) {
	a.t.Helper()
	a.send(fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":%s}`, req.ID, result))
}

// update sends a session/update notification with params.
func (a *fakeAgent) update(params string) {
	a.t.Helper()
	a.send(`{"jsonrpc":"2.0","method":"session/update","params":` + params + `}`)
}

// exit closes the agent's standard output, as an agent that ends does.
func (a *fakeAgent) exit() { a.stdout.Close() }

// note is a notification a recorder got.
type note struct {
	method string
	params string
}

// recorder is a Handler that keeps the notifications in the order of their
// calls and leaves requests to the test.
type recorder struct {
	mu      sync.Mutex
	notes   []note
	inside  atomic.Int32
	overlap atomic.Bool // two Notification calls ran at once
	seen    chan note   // every notification, once
	serve   func(ctx context.Context, method string, params json.RawMessage) (any, error)
}

func newRecorder() *recorder { return &recorder{seen: make(chan note, 1024)} }

func (r *recorder) Notification(method string, params json.RawMessage) {
	if r.inside.Add(1) != 1 {
		r.overlap.Store(true)
	}
	defer r.inside.Add(-1)
	n := note{method, string(params)}
	r.mu.Lock()
	r.notes = append(r.notes, n)
	r.mu.Unlock()
	r.seen <- n
}

func (r *recorder) Request(ctx context.Context, method string, params json.RawMessage) (any, error) {
	if r.serve == nil {
		return nil, ErrMethodNotFound
	}
	return r.serve(ctx, method, params)
}

// got is what the recorder has so far.
func (r *recorder) got() []note {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]note(nil), r.notes...)
}

// outcome is how a call of the client ended.
type outcome[T any] struct {
	res T
	err error
}

// async runs a call of the client beside the test, which plays the agent.
func async[T any](call func() (T, error)) <-chan outcome[T] {
	ch := make(chan outcome[T], 1)
	go func() {
		res, err := call()
		ch <- outcome[T]{res, err}
	}()
	return ch
}

// asyncErr is async for a call without a result.
func asyncErr(call func() error) <-chan error {
	ch := make(chan error, 1)
	go func() { ch <- call() }()
	return ch
}
