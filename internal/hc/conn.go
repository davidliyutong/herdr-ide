package hc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// ErrClosed is returned by calls and streams of a connection that was closed
// here.
var ErrClosed = errors.New("hc: connection closed")

// Conn is a framed connection to a core. Calls run side by side; streams and
// event subscriptions share the connection and end with it.
type Conn struct {
	rw io.ReadWriteCloser
	br *bufio.Reader

	wmu sync.Mutex // one frame at a time

	mu     sync.Mutex
	nextID uint64
	calls  map[uint64]*call
	chans  map[uint32]*queue
	err    error
	done   chan struct{}
}

type call struct {
	done   chan struct{}
	result json.RawMessage
	err    error
	// open, for calls whose result names a channel, registers that channel.
	// The reader runs it before it reads the next frame, as the core sends
	// the channel's frames right behind the reply.
	open func(result json.RawMessage) uint32
	// abandoned: the caller gave up; a channel the reply opens is closed.
	abandoned bool
}

type message struct {
	ID     *uint64         `json:"id"`
	Method string          `json:"method"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			Kind string `json:"kind"`
			Hint string `json:"hint"`
		} `json:"data"`
	} `json:"error"`
}

// Dial says hello on rw, switches it to framed mode and takes rw over: Close
// closes it. The core must speak this package's generation.
func Dial(ctx context.Context, rw io.ReadWriteCloser) (*Conn, *Hello, error) {
	stop := context.AfterFunc(ctx, func() { rw.Close() })
	hello, br, err := handshake(rw, true)
	if !stop() && err == nil {
		err = ctx.Err()
	}
	if err != nil {
		rw.Close()
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return nil, nil, err
	}
	c := &Conn{rw: rw, br: br, nextID: 1, calls: map[uint64]*call{}, chans: map[uint32]*queue{}, done: make(chan struct{})}
	go c.read()
	return c, hello, nil
}

// Probe asks the core on rw who it is and closes rw: whether a core answers
// on a socket, and which version.
func Probe(ctx context.Context, rw io.ReadWriteCloser) (*Hello, error) {
	stop := context.AfterFunc(ctx, func() { rw.Close() })
	hello, _, err := handshake(rw, false)
	stop()
	rw.Close()
	if err != nil && ctx.Err() != nil {
		err = ctx.Err()
	}
	return hello, err
}

func handshake(rw io.ReadWriter, framed bool) (*Hello, *bufio.Reader, error) {
	req, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 0, "method": "hello",
		"params": map[string]any{"framed": framed, "generation": Generation},
	})
	if _, err := rw.Write(append(req, '\n')); err != nil {
		return nil, nil, err
	}
	br := bufio.NewReaderSize(rw, 64<<10)
	var line []byte
	for {
		part, err := br.ReadSlice('\n')
		line = append(line, part...)
		if err == nil {
			break
		}
		if err != bufio.ErrBufferFull {
			return nil, nil, fmt.Errorf("hc: hello: %w", unexpected(err))
		}
		if len(line) > maxHello {
			return nil, nil, fmt.Errorf("hc: hello: reply exceeds %d bytes", maxHello)
		}
	}
	var m message
	if err := json.Unmarshal(line, &m); err != nil {
		return nil, nil, fmt.Errorf("hc: hello: %w", err)
	}
	if m.Error != nil {
		return nil, nil, &Error{Code: m.Error.Code, Message: m.Error.Message, Kind: m.Error.Data.Kind, Hint: m.Error.Data.Hint}
	}
	var h Hello
	if err := json.Unmarshal(m.Result, &h); err != nil {
		return nil, nil, fmt.Errorf("hc: hello: %w", err)
	}
	if h.Generation != Generation {
		return nil, nil, fmt.Errorf("hc: core speaks protocol generation %d, not %d", h.Generation, Generation)
	}
	if framed && !h.Framed {
		return nil, nil, errors.New("hc: core did not switch to framed mode")
	}
	return &h, br, nil
}

// Close ends the connection and everything on it.
func (c *Conn) Close() error {
	c.fail(ErrClosed)
	return nil
}

// Done is closed when the connection has ended; Err then says why.
func (c *Conn) Done() <-chan struct{} { return c.done }

// Err is the reason the connection ended, nil while it is open.
func (c *Conn) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *Conn) fail(err error) {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return
	}
	c.err = err
	calls, chans := c.calls, c.chans
	c.calls, c.chans = nil, nil
	close(c.done)
	c.mu.Unlock()
	c.rw.Close()
	for _, k := range calls {
		k.err = err
		close(k.done)
	}
	for _, q := range chans {
		q.end(nil, err)
	}
}

// send writes one frame.
func (c *Conn) send(channel uint32, kind byte, payload []byte) error {
	if len(payload) > MaxPayload {
		return fmt.Errorf("hc: frame of %d bytes exceeds %d", len(payload), MaxPayload)
	}
	frame := appendFrame(make([]byte, 0, headerLen+len(payload)), channel, kind, payload)
	c.wmu.Lock()
	_, err := c.rw.Write(frame)
	c.wmu.Unlock()
	if err != nil {
		c.fail(err)
		return c.Err()
	}
	return nil
}

func (c *Conn) read() {
	for {
		channel, kind, payload, err := readFrame(c.br)
		if err != nil {
			c.fail(err)
			return
		}
		if channel == 0 {
			if kind == kindData {
				c.reply(payload)
			}
			continue
		}
		c.mu.Lock()
		q := c.chans[channel]
		if q != nil && kind == kindClose {
			delete(c.chans, channel)
		}
		c.mu.Unlock()
		if q == nil {
			continue // a stream closed here; the core had more on the way
		}
		switch kind {
		case kindData, kindResize:
			if !q.push(item{kind: kind, payload: payload}) {
				c.fail(fmt.Errorf("hc: channel %d: the core sent more than its credit", channel))
				return
			}
		case kindClose:
			var exit Exit
			json.Unmarshal(payload, &exit) // empty when it answers our close
			q.end(&exit, io.EOF)
		}
	}
}

// reply completes the call a message on channel 0 answers. Requests and
// notifications from the core (it sends none to a client that did not
// offer methods in its hello) are ignored.
func (c *Conn) reply(payload []byte) {
	var m message
	if json.Unmarshal(payload, &m) != nil || m.ID == nil || m.Method != "" {
		return
	}
	c.mu.Lock()
	k := c.calls[*m.ID]
	delete(c.calls, *m.ID)
	abandoned := k != nil && k.abandoned
	c.mu.Unlock()
	if k == nil {
		return
	}
	if m.Error != nil {
		k.err = &Error{Code: m.Error.Code, Message: m.Error.Message, Kind: m.Error.Data.Kind, Hint: m.Error.Data.Hint}
	} else {
		k.result = m.Result
		if k.open != nil {
			channel := k.open(m.Result)
			if abandoned && channel != 0 {
				c.mu.Lock()
				delete(c.chans, channel)
				c.mu.Unlock()
				// Not from the reader: a write may wait for the peer.
				go c.send(channel, kindClose, nil)
			}
		}
	}
	close(k.done)
}

// Call runs method and decodes its result into result (nil to drop it).
// Errors from the core are *Error.
func (c *Conn) Call(ctx context.Context, method string, params, result any) error {
	return c.call(ctx, method, params, result, nil)
}

func (c *Conn) call(ctx context.Context, method string, params, result any, open func(json.RawMessage) uint32) error {
	if params == nil {
		params = struct{}{}
	}
	k := &call{done: make(chan struct{}), open: open}
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return c.err
	}
	id := c.nextID
	c.nextID++
	c.calls[id] = k
	c.mu.Unlock()

	req, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err == nil {
		err = c.send(0, kindData, req)
	}
	if err != nil {
		c.mu.Lock()
		delete(c.calls, id)
		c.mu.Unlock()
		return err
	}
	select {
	case <-k.done:
	case <-ctx.Done():
		c.mu.Lock()
		_, waiting := c.calls[id]
		if waiting {
			if open != nil {
				k.abandoned = true // its reply still has to close the channel
			} else {
				delete(c.calls, id)
			}
		}
		c.mu.Unlock()
		if waiting {
			cancel, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "$/cancelRequest", "params": map[string]any{"id": id}})
			go c.send(0, kindData, cancel)
			return ctx.Err()
		}
		<-k.done // the reply came at the same moment
	}
	if k.err != nil {
		return k.err
	}
	if result == nil {
		return nil
	}
	return json.Unmarshal(k.result, result)
}

// register adds the queue of a channel the core opened.
func (c *Conn) register(channel uint32, q *queue) {
	c.mu.Lock()
	if c.chans != nil {
		c.chans[channel] = q
	}
	c.mu.Unlock()
}

// closeChannel tells the core a channel is over and drops what still
// arrives on it.
func (c *Conn) closeChannel(channel uint32, q *queue) {
	c.mu.Lock()
	_, open := c.chans[channel]
	delete(c.chans, channel)
	c.mu.Unlock()
	q.end(nil, ErrClosed)
	if open {
		c.send(channel, kindClose, nil)
	}
}

// item is one frame of a channel waiting to be received.
type item struct {
	kind    byte
	payload []byte
}

// queue holds the frames of one channel until they are received.
type queue struct {
	mu    sync.Mutex
	items []item
	bytes int
	exit  *Exit
	err   error // set once the channel is over
	wake  chan struct{}
}

func newQueue() *queue { return &queue{wake: make(chan struct{}, 1)} }

func (q *queue) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// push queues a frame; false when the channel holds more than a core that
// honors credit can have sent.
func (q *queue) push(it item) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.err != nil {
		return true
	}
	if q.bytes+len(it.payload) > maxQueued {
		return false
	}
	q.items = append(q.items, it)
	q.bytes += len(it.payload)
	q.signal()
	return true
}

// end marks the channel over. What is queued is still received first when
// the core ended it (err is io.EOF).
func (q *queue) end(exit *Exit, err error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.err != nil {
		return
	}
	q.exit, q.err = exit, err
	if err != io.EOF {
		q.items, q.bytes = nil, 0
	}
	q.signal()
}

// pop waits for the next frame, or returns the error the channel ended with.
func (q *queue) pop(ctx context.Context) (item, error) {
	for {
		q.mu.Lock()
		if len(q.items) > 0 {
			it := q.items[0]
			q.items[0] = item{}
			q.items = q.items[1:]
			q.bytes -= len(it.payload)
			if len(q.items) > 0 || q.err != nil {
				q.signal()
			}
			q.mu.Unlock()
			return it, nil
		}
		if err := q.err; err != nil {
			q.signal() // for another receiver
			q.mu.Unlock()
			return item{}, err
		}
		q.mu.Unlock()
		select {
		case <-q.wake:
		case <-ctx.Done():
			return item{}, ctx.Err()
		}
	}
}
