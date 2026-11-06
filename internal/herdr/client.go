// Package herdr speaks herdr's public JSON socket API.
//
// The server handles exactly one request per connection (newline-delimited
// JSON), except events.subscribe which turns the connection into an event
// stream. Dial therefore opens a fresh connection for every call.
package herdr

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"herdr-ide/internal/brand"
	"net"
	"strconv"
	"sync/atomic"
	"time"
)

// Client issues API requests over connections produced by Dial.
type Client struct {
	Dial func(ctx context.Context) (net.Conn, error)
	// DialRequest, when set, is used instead of Dial: it opens a connection
	// with request (one JSON line) already sent. herdr drops a connection
	// whose request has not arrived 5 s after it accepted it, which a dialer
	// that reaches the socket over a slow link avoids by sending the request
	// along with the connection setup instead of a round trip later.
	DialRequest func(ctx context.Context, request []byte) (net.Conn, error)
	seq         atomic.Uint64
}

// open connects and sends one request line.
func (c *Client) open(ctx context.Context, req request) (net.Conn, error) {
	b, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	b = append(b, '\n')
	if c.DialRequest != nil {
		return c.DialRequest(ctx, b)
	}
	conn, err := c.Dial(ctx)
	if err != nil {
		return nil, err
	}
	stop := watchContext(ctx, conn)
	_, err = conn.Write(b)
	stop()
	if err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

// APIError is an error response from herdr.
type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *APIError) Error() string { return e.Code + ": " + e.Message }

type request struct {
	ID     string `json:"id"`
	Method string `json:"method"`
	Params any    `json:"params"`
}

type response struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *APIError       `json:"error"`
}

const maxLine = 64 << 20

func (c *Client) nextID() string {
	return brand.Slug + ":" + strconv.FormatUint(c.seq.Add(1), 10)
}

func watchContext(ctx context.Context, conn net.Conn) (stop func()) {
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-done:
		}
	}()
	return func() { close(done) }
}

func readLine(r *bufio.Reader) ([]byte, error) {
	var out []byte
	for {
		chunk, err := r.ReadSlice('\n')
		out = append(out, chunk...)
		if err == nil {
			return out, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			if len(out) > maxLine {
				return nil, errors.New("herdr: response line too long")
			}
			continue
		}
		return out, err
	}
}

// Call performs one request and returns the raw result object.
func (c *Client) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if params == nil {
		params = map[string]any{}
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
	}
	conn, err := c.open(ctx, request{ID: c.nextID(), Method: method, Params: params})
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	stop := watchContext(ctx, conn)
	defer stop()

	line, err := readLine(bufio.NewReaderSize(conn, 64<<10))
	if err != nil && len(line) == 0 {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("herdr %s: %w", method, err)
	}
	var resp response
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, fmt.Errorf("herdr %s: bad response: %w", method, err)
	}
	if resp.Error != nil {
		return nil, resp.Error
	}
	return resp.Result, nil
}

// CallInto decodes the result into out.
func (c *Client) CallInto(ctx context.Context, method string, params any, out any) error {
	raw, err := c.Call(ctx, method, params)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

// Event is one line of an events.subscribe stream.
type Event struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

// ErrEventsLost reports that herdr dropped events for a lagging subscriber;
// callers must resubscribe and take a fresh snapshot.
var ErrEventsLost = errors.New("herdr: events lost")

// Subscribe opens an event stream. fn is called for every event until the
// stream ends, ctx is cancelled or fn returns an error.
func (c *Client) Subscribe(ctx context.Context, subs []map[string]any, onStarted func(), fn func(Event) error) error {
	conn, err := c.open(ctx, request{ID: c.nextID(), Method: "events.subscribe", Params: map[string]any{"subscriptions": subs}})
	if err != nil {
		return err
	}
	defer conn.Close()
	stop := watchContext(ctx, conn)
	defer stop()

	r := bufio.NewReaderSize(conn, 64<<10)
	line, err := readLine(r)
	if err != nil {
		return fmt.Errorf("herdr subscribe: %w", err)
	}
	var first response
	if err := json.Unmarshal(line, &first); err != nil {
		return fmt.Errorf("herdr subscribe: bad response: %w", err)
	}
	if first.Error != nil {
		return first.Error
	}
	if onStarted != nil {
		onStarted()
	}
	for {
		line, err := readLine(r)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("herdr subscribe: %w", err)
		}
		// events_lost arrives as an error response carrying the request id.
		var probe struct {
			ID    string    `json:"id"`
			Error *APIError `json:"error"`
		}
		if json.Unmarshal(line, &probe) == nil && probe.Error != nil {
			if probe.Error.Code == "events_lost" {
				return ErrEventsLost
			}
			return probe.Error
		}
		var ev Event
		if err := json.Unmarshal(line, &ev); err != nil {
			continue
		}
		if ev.Event == "" {
			continue
		}
		if err := fn(ev); err != nil {
			return err
		}
	}
}
