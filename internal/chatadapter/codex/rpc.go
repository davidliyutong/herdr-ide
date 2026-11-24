package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"veldr/internal/chatproto"
)

// The JSON-RPC codes the adapter answers with.
const (
	codeMethodNotFound = -32601
)

// rpcError is an error the app-server answered a request with. Codex
// answers every error with -32600 and a message (unknown methods, bad
// parameters, unknown threads alike).
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return fmt.Sprintf("codex: %s (%d)", e.Message, e.Code) }

// envelope is a line of the app-server: a response ({id, result|error}), a
// notification ({method, params}, with Codex's emittedAtMs) or a request of
// its own ({method, id, params}; its ids are its own, from 0, and collide
// with ours: what has a method is no response).
type envelope struct {
	ID          json.RawMessage `json:"id"`
	Method      string          `json:"method"`
	Params      json.RawMessage `json:"params"`
	Result      json.RawMessage `json:"result"`
	Error       *rpcError       `json:"error"`
	EmittedAtMs int64           `json:"emittedAtMs"`
}

// handler takes what the app-server sends on its own. notify is called on
// the connection's reader, in order, and must not block; request too, and
// answers the request (at once or later) through r.
type handler interface {
	notify(method string, params json.RawMessage, at time.Time)
	request(r *serverRequest)
}

// conn is a JSON-RPC connection to an app-server process: newline-delimited
// JSON without the jsonrpc member, our requests numbered from 1.
type conn struct {
	proc *process
	h    handler
	log  *log.Logger

	wmu  sync.Mutex
	next atomic.Int64

	mu      sync.Mutex
	pending map[int64]chan reply
	ended   bool
	readErr error

	// closed is closed once the reader ended: the app-server's output was
	// closed or broke.
	closed chan struct{}

	// What was passed over: lines that are no JSON-RPC message, longer
	// than chatproto.MaxLine, answers to requests we did not make, and
	// notifications without a mapping, by method (logged once each).
	malformed, oversized, strayReplies atomic.Int64
	umu                                sync.Mutex
	unknown                            map[string]int
}

type reply struct {
	result json.RawMessage
	err    error
}

// errClosed is the error of a request whose answer cannot come: the
// connection ended.
var errClosed = errors.New("codex: the app-server is gone")

func newConn(p *process, mk func(*conn) handler, logger *log.Logger) *conn {
	c := &conn{proc: p, log: logger, pending: map[int64]chan reply{}, closed: make(chan struct{}), unknown: map[string]int{}}
	c.h = mk(c)
	go c.read()
	return c
}

func (c *conn) logf(format string, args ...any) {
	if c.log != nil {
		c.log.Printf("codex: "+format, args...)
	}
}

// read reads the app-server's lines until its output ends. A line longer
// than chatproto.MaxLine is passed over to its end, a line that is no
// JSON-RPC message too.
func (c *conn) read() {
	br := bufio.NewReaderSize(c.proc.stdout, 64<<10)
	var err error
	for {
		var line []byte
		line, err = chatproto.ReadLine(br)
		if errors.Is(err, chatproto.ErrTooLarge) {
			c.oversized.Add(1)
			c.logf("passed over a line longer than %d bytes", chatproto.MaxLine)
			if err = skipLine(br); err != nil {
				break
			}
			continue
		}
		if err != nil {
			break
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		c.dispatch(line)
	}
	c.mu.Lock()
	c.readErr = err
	c.ended = true
	pending := c.pending
	c.pending = nil
	c.mu.Unlock()
	for _, ch := range pending {
		ch <- reply{err: errClosed}
	}
	close(c.closed)
}

// skipLine reads up to the end of a line.
func skipLine(br *bufio.Reader) error {
	for {
		_, err := br.ReadSlice('\n')
		if err != bufio.ErrBufferFull {
			return err
		}
	}
}

func (c *conn) dispatch(line []byte) {
	var m envelope
	if err := json.Unmarshal(line, &m); err != nil {
		if c.malformed.Add(1) == 1 {
			c.logf("passed over a line that is no JSON-RPC message: %v", err)
		}
		return
	}
	hasID := len(m.ID) > 0 && string(m.ID) != "null"
	switch {
	case m.Method != "" && hasID:
		c.h.request(&serverRequest{c: c, id: m.ID, method: m.Method, params: m.Params})
	case m.Method != "":
		at := time.Now()
		if m.EmittedAtMs > 0 {
			at = time.UnixMilli(m.EmittedAtMs)
		}
		c.h.notify(m.Method, m.Params, at)
	case hasID:
		id, err := strconv.ParseInt(string(m.ID), 10, 64)
		c.mu.Lock()
		ch, ok := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		if err != nil || !ok {
			c.strayReplies.Add(1)
			return
		}
		if m.Error != nil {
			ch <- reply{err: m.Error}
		} else {
			ch <- reply{result: m.Result}
		}
	default:
		if c.malformed.Add(1) == 1 {
			c.logf("passed over a line that is no JSON-RPC message")
		}
	}
}

// passedOver counts a notification the adapter has no mapping for, and
// logs its method the first time.
func (c *conn) passedOver(method string) {
	c.umu.Lock()
	defer c.umu.Unlock()
	if len(c.unknown) >= 256 {
		method = "(others)"
	}
	c.unknown[method]++
	if c.unknown[method] == 1 {
		c.logf("passing over the notification %s", method)
	}
}

// unknownCount is how many notifications were passed over.
func (c *conn) unknownCount() int {
	c.umu.Lock()
	defer c.umu.Unlock()
	n := 0
	for _, k := range c.unknown {
		n += k
	}
	return n
}

// write sends one message.
func (c *conn) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err = c.proc.stdin.Write(b)
	return err
}

// call sends a request and waits for its answer, decoded into out (nil
// for none).
func (c *conn) call(ctx context.Context, method string, params, out any) error {
	id := c.next.Add(1)
	ch := make(chan reply, 1)
	c.mu.Lock()
	if c.ended {
		c.mu.Unlock()
		return errClosed
	}
	c.pending[id] = ch
	c.mu.Unlock()
	msg := map[string]any{"id": id, "method": method}
	if params != nil {
		msg["params"] = params
	}
	if err := c.write(msg); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return errClosed
	}
	select {
	case r := <-ch:
		if r.err != nil {
			return r.err
		}
		if out != nil && len(r.result) > 0 {
			if err := json.Unmarshal(r.result, out); err != nil {
				return &chatproto.Error{Code: chatproto.CodeProtocol, Message: method + ": " + err.Error()}
			}
		}
		return nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return ctx.Err()
	}
}

// notifyServer sends a notification.
func (c *conn) notifyServer(method string) error {
	return c.write(map[string]any{"method": method})
}

func isClosed(ch chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// serverRequest is a request of the app-server, answered once.
type serverRequest struct {
	c      *conn
	id     json.RawMessage
	method string
	params json.RawMessage
	once   sync.Once
}

// key is the request's id as text, for serverRequest/resolved.
func (r *serverRequest) key() string { return requestKey(r.id) }

func (r *serverRequest) reply(result any) {
	r.once.Do(func() {
		if err := r.c.write(map[string]any{"id": r.id, "result": result}); err != nil {
			r.c.logf("answering %s: %v", r.method, err)
		}
	})
}

func (r *serverRequest) fail(code int, message string) {
	r.once.Do(func() {
		if err := r.c.write(map[string]any{"id": r.id, "error": rpcError{Code: code, Message: message}}); err != nil {
			r.c.logf("answering %s: %v", r.method, err)
		}
	})
}

// requestKey is the text of a request id as serverRequest/resolved names
// it (a number or a string), comparable with serverRequest.key.
func requestKey(raw json.RawMessage) string {
	return strings.TrimSpace(string(raw))
}
