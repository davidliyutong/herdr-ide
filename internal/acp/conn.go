// Package acp is a client for the Agent Client Protocol (ACP), protocol
// version 1, as an editor speaks it to a coding agent it started: JSON-RPC
// 2.0 messages, one per line, on the agent's standard input and output.
//
// The package types what a host of agents reads and writes itself: the
// handshake, the calls that make and drive sessions, and the request for a
// permission. What an agent reports of a session (session/update) is handed
// on as the JSON the agent sent, for the UI that renders it.
//
// The client advertises neither the fs nor the terminal capability, so an
// agent has no reason to send those requests; one comes anyway (opencode
// asks fs/write_text_file after an edit it made itself), and every request
// of the agent gets an answer, ErrMethodNotFound for what the Handler does
// not serve: an agent that is not answered waits. Notifications of a
// vendor's own (methods starting with "_", as Grok's "_x.ai/...") are
// counted and passed over.
package acp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"
)

// MaxMessage is the longest line taken from an agent, in bytes without its
// newline. A line has no length ahead of it, so this is what bounds the
// memory one message can take: a longer line ends the connection with
// ErrTooLarge.
const MaxMessage = 16 << 20

const (
	// readBuffer is the size of the reads of the agent's output; a line is
	// put together from pieces of at most that size.
	readBuffer = 64 << 10
	// keepBuffer is the largest line buffer kept for the next line; one
	// that a long message made larger is given back.
	keepBuffer = 1 << 20
	// maxServing is the most requests of the agent served at once, each in
	// a goroutine of its own: once that many wait (for the user), the
	// reading of the agent's output waits for one of them to end.
	maxServing = 128
)

// The JSON-RPC 2.0 error codes this package sends or names.
const (
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternalError  = -32603
	// CodeAuthRequired is the protocol's error for a request that needs
	// the user to sign in first.
	CodeAuthRequired = -32000
	// CodeResourceNotFound is the protocol's error for what is not there:
	// a session that session/load or session/resume names (the SDKs'
	// RequestError.resourceNotFound).
	CodeResourceNotFound = -32002
)

var (
	// ErrClosed is in the error of every call on a connection that ended
	// (errors.Is), whatever ended it; Err tells what did.
	ErrClosed = errors.New("acp: connection closed")
	// ErrTooLarge ends a connection whose agent wrote a line longer than
	// MaxMessage.
	ErrTooLarge = errors.New("acp: line from the agent longer than MaxMessage (16 MiB)")
	// ErrMethodNotFound is what a Handler returns for a request it does not
	// serve. errors.Is also finds it in the error of a Call whose agent
	// does not know the method.
	ErrMethodNotFound = &Error{Code: CodeMethodNotFound, Message: "Method not found"}
)

// Error is a JSON-RPC error: what an agent answered a Call with, and what a
// Handler returns to choose the error an agent gets.
type Error struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *Error) Error() string {
	return "acp: error " + strconv.Itoa(e.Code) + ": " + e.Message
}

// Is matches another Error of the same code, so that errors.Is(err,
// ErrMethodNotFound) holds for every "method not found", whoever worded it.
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && t != nil && e != nil && t.Code == e.Code
}

// Handler takes what an agent sends without being asked.
type Handler interface {
	// Notification is called for every notification but a vendor's own
	// (a method starting with "_"), in the order received
	// and from one goroutine, the one that reads the agent's output:
	// nothing else is read until it returns. A response reaches its Call
	// only after the notifications received before it were handled, so a
	// session/prompt or session/load call returns after the updates of its
	// turn or replay. A Notification must therefore not wait for a Call on
	// the same connection, and one that blocks stops the connection's
	// input.
	//
	// params are the message's params as the agent sent them, byte for
	// byte, but bytes that are not UTF-8, which become U+FFFD; nil without
	// params. The handler may keep them.
	Notification(method string, params json.RawMessage)

	// Request is called for every request of the agent, each in a goroutine
	// of its own, so that one that waits for the user
	// (session/request_permission) holds up neither notifications nor other
	// requests; at most maxServing at once. The notifications received
	// before the request were handled before it is called. ctx ends with
	// the connection: a request that still waits returns then, and its
	// answer is dropped.
	//
	// result is sent as the response's result. An *Error is sent as it is,
	// ErrMethodNotFound for a method the handler does not serve; any other
	// error is sent as an internal error (CodeInternalError) without its
	// text, which may name paths and other things of the host.
	Request(ctx context.Context, method string, params json.RawMessage) (result any, err error)
}

// Conn is a connection to an agent: calls and notifications to it, side by
// side, and its notifications and requests to a Handler. It does not own
// the agent's pipes: whoever started the agent closes them.
type Conn struct {
	w     io.Writer
	h     Handler
	limit int // MaxMessage; less in tests

	// wsem is the lock of w, one message at a time. It is a channel so
	// that waiting for it ends with a context or with the connection.
	wsem chan struct{}

	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan *incoming // the calls that wait, by id
	err     error                    // why the connection ended; nil while it runs

	done    chan struct{}
	ctx     context.Context // of the requests' handlers; ends with the connection
	cancel  context.CancelFunc
	skipped atomic.Int64
	vendor  atomic.Int64
	serving chan struct{}  // a slot for each request being served
	wg      sync.WaitGroup // the reader and the requests being served
}

// incoming is a line of the agent: a request, a notification or a response.
// The members stay raw until it is known which, so that one of a wrong type
// does not cost the message.
type incoming struct {
	ID     json.RawMessage `json:"id"`
	Method json.RawMessage `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

// outgoing is a line to the agent.
type outgoing struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

// NewConn speaks the protocol on r, the agent's standard output, and w, its
// standard input, and starts reading. h gets the agent's notifications and
// requests; without one, notifications are dropped and requests answered
// with ErrMethodNotFound.
//
// The connection ends when r does, when a write to w fails or with Close.
// The reader's goroutine ends when r returns, so the owner closes r (or ends
// the agent) to be rid of it.
func NewConn(r io.Reader, w io.Writer, h Handler) *Conn {
	return newConn(r, w, h, MaxMessage)
}

func newConn(r io.Reader, w io.Writer, h Handler, limit int) *Conn {
	ctx, cancel := context.WithCancel(context.Background())
	c := &Conn{
		w: w, h: h, limit: limit,
		wsem:    make(chan struct{}, 1),
		pending: map[int64]chan *incoming{},
		serving: make(chan struct{}, maxServing),
		done:    make(chan struct{}),
		ctx:     ctx, cancel: cancel,
	}
	c.wg.Go(func() { c.read(r) })
	return c
}

// Done is closed when the connection ended.
func (c *Conn) Done() <-chan struct{} { return c.done }

// Err is why the connection ended: nil while it runs, ErrClosed after
// Close, io.EOF when the agent closed its output (as a rule, it exited),
// ErrTooLarge for a line longer than MaxMessage, else the error of the read
// or of the write that failed.
func (c *Conn) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// Skipped counts the lines of the agent that were not JSON objects: what a
// program printed to the standard output that belongs to the protocol.
func (c *Conn) Skipped() int { return int(c.skipped.Load()) }

// Vendor counts the agent's notifications of methods that start with "_",
// a vendor's own, which the Handler does not get.
func (c *Conn) Vendor() int { return int(c.vendor.Load()) }

// Close ends the connection: the calls that wait fail with ErrClosed, the
// requests being served see their context end, and the Handler gets nothing
// more, but for a notification that was on its way to it. Close closes
// neither r nor w, and waits for nothing.
func (c *Conn) Close() { c.end(ErrClosed) }

// wait returns when the reader and every request's goroutine ended.
func (c *Conn) wait() { c.wg.Wait() }

// Call sends a request and waits for its response, whose result it decodes
// into result unless that is nil. params are sent as JSON, and left out
// when nil.
//
// An error the agent answered comes back as an *Error. When ctx ends first,
// Call returns its error and the response, should it still come, is
// dropped: the agent is not told, and a prompt turn is cancelled with
// Cancel. A write that another one holds up is waited for as long as ctx
// allows; a write of its own that the agent does not take lasts until the
// owner closes w. Once the connection ended, the error is ErrClosed
// (errors.Is) with what ended it.
func (c *Conn) Call(ctx context.Context, method string, params, result any) error {
	p, err := c.Go(ctx, method, params)
	if err != nil {
		return err
	}
	return p.Wait(ctx, result)
}

// Pending is a request sent whose response is still to be waited for.
type Pending struct {
	c      *Conn
	id     int64
	method string
	ch     chan *incoming
}

// Go sends a request and returns once it is written, before its response:
// what is sent after Go returns reaches the agent after the request (a
// session/cancel after its session/prompt). Wait takes the response. Its
// errors are Call's.
func (c *Conn) Go(ctx context.Context, method string, params any) (*Pending, error) {
	body, err := encodeParams(method, params)
	if err != nil {
		return nil, err
	}
	if err := c.lock(ctx); err != nil {
		return nil, err
	}
	// The id is taken under the write lock: ids reach the agent in
	// increasing order.
	id, ch := c.register()
	err = c.write(&outgoing{JSONRPC: "2.0", ID: strconv.AppendInt(nil, id, 10), Method: method, Params: body})
	c.unlock()
	if err != nil {
		c.forget(id)
		return nil, err
	}
	return &Pending{c: c, id: id, method: method, ch: ch}, nil
}

// Wait waits for the request's response and decodes its result into
// result unless that is nil. Once ctx ended the response is dropped, also
// should it come later. Wait is called once.
func (p *Pending) Wait(ctx context.Context, result any) error {
	c := p.c
	var m *incoming
	select {
	case m = <-p.ch:
	case <-ctx.Done():
		c.forget(p.id)
		return ctx.Err()
	case <-c.done:
		// A response read just before the end counts: agents answer and
		// exit.
		select {
		case m = <-p.ch:
		default:
			c.forget(p.id)
			return c.closed()
		}
	}
	if present(m.Error) {
		e := &Error{}
		if json.Unmarshal(m.Error, e) != nil {
			e = &Error{Code: CodeInternalError, Message: "malformed error in the agent's response", Data: m.Error}
		}
		return e
	}
	if result != nil && present(m.Result) {
		if err := json.Unmarshal(m.Result, result); err != nil {
			return fmt.Errorf("acp: %s: result: %w", p.method, err)
		}
	}
	return nil
}

// Notify sends a notification. It returns once the message is written, or
// with ErrClosed (errors.Is) when the connection ended.
func (c *Conn) Notify(method string, params any) error {
	body, err := encodeParams(method, params)
	if err != nil {
		return err
	}
	if err := c.lock(context.Background()); err != nil {
		return err
	}
	defer c.unlock()
	return c.write(&outgoing{JSONRPC: "2.0", Method: method, Params: body})
}

// lock takes the write lock. It gives up when ctx or the connection ends
// first.
func (c *Conn) lock(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case c.wsem <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	case <-c.done:
		return c.closed()
	}
	if c.Err() != nil { // the lock was free and the connection over
		c.unlock()
		return c.closed()
	}
	return nil
}

func (c *Conn) unlock() { <-c.wsem }

// write sends one message as one line with one Write. The caller holds the
// write lock. A write that fails ends the connection: part of a line may
// have reached the agent, and what follows it would not be a message.
func (c *Conn) write(m *outgoing) error {
	line, err := marshal(m)
	if err != nil {
		return fmt.Errorf("acp: %w", err)
	}
	if _, err := c.w.Write(append(line, '\n')); err != nil {
		c.end(fmt.Errorf("acp: write: %w", err))
		return c.closed()
	}
	return nil
}

// register makes the next call's id and the channel its response comes on.
func (c *Conn) register() (int64, chan *incoming) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextID++
	ch := make(chan *incoming, 1)
	c.pending[c.nextID] = ch
	return c.nextID, ch
}

// forget drops a call that no longer waits; its response, when it comes, is
// one without a call.
func (c *Conn) forget(id int64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

// end ends the connection for the first reason given.
func (c *Conn) end(err error) {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return
	}
	c.err = err
	c.mu.Unlock()
	c.cancel()
	close(c.done)
}

// closed is the error of a call on a connection that ended.
func (c *Conn) closed() error {
	err := c.Err()
	if err == ErrClosed {
		return err
	}
	return fmt.Errorf("%w: %w", ErrClosed, err)
}

// read takes the agent's lines until r ends or the connection does.
func (c *Conn) read(r io.Reader) {
	br := bufio.NewReaderSize(r, readBuffer)
	var buf []byte
	for {
		line, err := c.readLine(br, buf[:0])
		if c.Err() != nil {
			return // ended while the read waited
		}
		if err == nil || err == io.EOF {
			// A last line without a newline is a message too.
			c.dispatch(line)
		}
		switch {
		case err == nil:
		case err == io.EOF, err == ErrTooLarge:
			c.end(err)
			return
		default:
			c.end(fmt.Errorf("acp: read: %w", err))
			return
		}
		if buf = line; cap(buf) > keepBuffer {
			buf = nil
		}
	}
}

// readLine reads a line into buf, without its newline, and never more than
// c.limit bytes of it.
func (c *Conn) readLine(br *bufio.Reader, buf []byte) ([]byte, error) {
	for {
		part, err := br.ReadSlice('\n')
		if n := len(part); n > 0 && part[n-1] == '\n' {
			part = part[:n-1]
		}
		if len(buf)+len(part) > c.limit {
			return nil, ErrTooLarge
		}
		buf = append(buf, part...)
		if err != bufio.ErrBufferFull {
			return buf, err
		}
	}
}

// dispatch handles one line. Agents and what they start print to the
// standard output at times, so a line that is no JSON object is counted
// and skipped; a JSON object that is no message of use (no method, and no
// id of a call that waits) is ignored. Every request is answered, one
// whose method is no string with CodeInvalidRequest.
func (c *Conn) dispatch(line []byte) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return
	}
	if !utf8.Valid(line) {
		// The transport is UTF-8, and what is handed on verbatim must be
		// text. Outside of a string, such bytes are no JSON either way.
		line = bytes.ToValidUTF8(line, []byte(string(utf8.RuneError)))
	}
	var m incoming
	if line[0] != '{' || json.Unmarshal(line, &m) != nil {
		c.skipped.Add(1)
		return
	}
	if present(m.Method) {
		var method string
		if json.Unmarshal(m.Method, &method) != nil {
			method = ""
		}
		switch {
		case present(m.ID):
			if !c.slot() {
				return // the connection ended: nobody is answered any more
			}
			c.wg.Go(func() {
				defer func() { <-c.serving }()
				c.serve(m.ID, method, m.Params)
			})
		case strings.HasPrefix(method, "_"):
			c.vendor.Add(1)
		case method != "" && c.h != nil:
			c.h.Notification(method, m.Params)
		}
		return
	}
	id, err := strconv.ParseInt(string(m.ID), 10, 64)
	if err != nil {
		return
	}
	c.mu.Lock()
	ch := c.pending[id]
	delete(c.pending, id)
	c.mu.Unlock()
	if ch != nil {
		ch <- &m
	}
}

// slot takes a place among the requests being served, waiting for one when
// maxServing are; false when the connection ended first.
func (c *Conn) slot() bool {
	select {
	case c.serving <- struct{}{}:
		return true
	case <-c.done:
		return false
	}
}

// serve answers one request of the agent, with its id as the agent wrote
// it.
func (c *Conn) serve(id json.RawMessage, method string, params json.RawMessage) {
	var result any
	var err error = ErrMethodNotFound
	switch {
	case method == "":
		err = &Error{Code: CodeInvalidRequest, Message: "Invalid Request"}
	case c.h != nil:
		result, err = c.h.Request(c.ctx, method, params)
	}
	out := &outgoing{JSONRPC: "2.0", ID: id}
	if err == nil {
		out.Result, err = marshal(result)
	}
	if err != nil {
		out.Result, out.Error = nil, wireError(err)
	}
	if c.lock(context.Background()) != nil {
		return // the connection ended: nobody waits for the answer
	}
	c.write(out) // a write that fails ends the connection, and that is all there is to do
	c.unlock()
}

// wireError is the error an agent gets for a handler's: an *Error as it
// is, and of any other error nothing but that there was one.
func wireError(err error) *Error {
	var e *Error
	if !errors.As(err, &e) || e == nil {
		return &Error{Code: CodeInternalError, Message: "Internal error"}
	}
	if len(e.Data) > 0 && !json.Valid(e.Data) {
		// Data that is no JSON cannot be sent, and the agent waits for an
		// answer.
		return &Error{Code: e.Code, Message: e.Message}
	}
	return e
}

// present tells whether a member of a message is there and not null.
func present(raw json.RawMessage) bool {
	return len(raw) > 0 && string(raw) != "null"
}

// encodeParams is the params of a message to method; none for nil.
func encodeParams(method string, params any) (json.RawMessage, error) {
	if params == nil {
		return nil, nil
	}
	b, err := marshal(params)
	if err != nil {
		return nil, fmt.Errorf("acp: %s: params: %w", method, err)
	}
	return b, nil
}

// marshal is v as JSON on one line: the encoder leaves no newline inside a
// value, raw ones included, and refuses a raw value that is not JSON. The
// characters of HTML are not escaped, as json.Marshal would: prompts are
// full of them, and no agent needs it.
func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}
