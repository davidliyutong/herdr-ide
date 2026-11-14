package hc

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

// Stream is an attached terminal: the first paint and then the program's raw
// output one way, input the other.
type Stream struct {
	c       *Conn
	channel uint32
	q       *queue
	// automatic: the whole path takes automatic input as its own frame kind.
	automatic bool
}

// Output is one message of a stream: output bytes, or the terminal's new
// grid (Cols and Rows set, for an attach with resize notifications), which
// applies before the output that follows it.
type Output struct {
	Data       []byte
	Cols, Rows int
}

// Attach opens a stream to a live terminal.
func (c *Conn) Attach(ctx context.Context, p AttachParams) (*Stream, *Attached, error) {
	s := &Stream{c: c, q: newQueue()}
	var res Attached
	err := c.call(ctx, "terminal.attach", p, &res, func(raw json.RawMessage) uint32 {
		var r struct {
			Channel uint32 `json:"channel"`
		}
		if json.Unmarshal(raw, &r) != nil || r.Channel == 0 {
			return 0
		}
		c.register(r.Channel, s.q)
		return r.Channel
	})
	if err != nil {
		return nil, nil, err
	}
	if res.Channel == 0 {
		return nil, nil, fmt.Errorf("hc: terminal.attach: reply without a channel")
	}
	s.channel, s.automatic = res.Channel, res.AutomaticInput
	return s, &res, nil
}

// Recv waits for the next output. It returns io.EOF once the core has closed
// the stream (Exit says why) and everything before was received. The bytes
// count against the stream's credit until Ack returns them.
func (s *Stream) Recv(ctx context.Context) (Output, error) {
	for {
		it, err := s.q.pop(ctx)
		if err != nil {
			return Output{}, err
		}
		switch {
		case it.kind == kindData:
			return Output{Data: it.payload}, nil
		case len(it.payload) == 4:
			return Output{
				Cols: int(binary.LittleEndian.Uint16(it.payload)),
				Rows: int(binary.LittleEndian.Uint16(it.payload[2:])),
			}, nil
		}
	}
}

// Ack returns the credit of n output bytes that were passed on, so the core
// sends as fast as the slowest hop takes them. A viewer more than 4 MiB
// behind gets a fresh paint from the core instead of the backlog.
func (s *Stream) Ack(n int) error {
	if n <= 0 {
		return nil
	}
	return s.c.send(s.channel, kindCredit, binary.LittleEndian.AppendUint32(nil, uint32(n)))
}

// Exit is how the terminal's program ended, once Recv returned io.EOF; nil
// before, and when the stream ended for another reason.
func (s *Stream) Exit() *Exit {
	s.q.mu.Lock()
	defer s.q.mu.Unlock()
	if s.q.exit == nil || s.q.exit.Reason == "" {
		return nil
	}
	return s.q.exit
}

// Write sends what the person typed, pasted or did with the mouse, encoded
// for the program's modes by the viewer: the core never encodes keys.
func (s *Stream) Write(p []byte) (int, error) { return s.write(kindData, p) }

// WriteAutomatic sends bytes the viewer's terminal produced by itself
// (answers to the program's queries), which do not count as the person's
// activity: they neither take over the terminal's size nor end its quiet
// period. On a path that does not know them they are sent as typed bytes.
func (s *Stream) WriteAutomatic(p []byte) (int, error) {
	if !s.automatic {
		return s.write(kindData, p)
	}
	return s.write(kindAutomaticInput, p)
}

func (s *Stream) write(kind byte, p []byte) (int, error) {
	const chunk = 1 << 20 // the program reads a stream: any split is valid
	sent := 0
	for len(p) > 0 {
		n := min(len(p), chunk)
		if err := s.c.send(s.channel, kind, p[:n]); err != nil {
			return sent, err
		}
		sent += n
		p = p[n:]
	}
	return sent, nil
}

// Resize sets the terminal's grid as this viewer shows it. The viewer that
// was active last (attached, typed, resized or gained focus) sets the size.
func (s *Stream) Resize(cols, rows int) error {
	if cols < 1 || rows < 1 || cols > 0xffff || rows > 0xffff {
		return fmt.Errorf("hc: resize to %dx%d", cols, rows)
	}
	p := binary.LittleEndian.AppendUint16(nil, uint16(cols))
	return s.c.send(s.channel, kindResize, binary.LittleEndian.AppendUint16(p, uint16(rows)))
}

// Focus tells the core whether the viewer has the focus.
func (s *Stream) Focus(focused bool) error {
	b := byte(0)
	if focused {
		b = 1
	}
	return s.c.send(s.channel, kindFocus, []byte{b})
}

// Facts updates the viewer's display facts.
func (s *Stream) Facts(d Display) error {
	p, err := json.Marshal(d)
	if err != nil {
		return err
	}
	return s.c.send(s.channel, kindFacts, p)
}

// Close detaches the viewer; the terminal keeps running.
func (s *Stream) Close() error {
	s.c.closeChannel(s.channel, s.q)
	return nil
}

// Events is an event subscription.
type Events struct {
	c       *Conn
	channel uint32
	q       *queue
	buf     []byte // the start of a line whose end has not arrived
}

// Subscribe returns the matching terminals and the events after them.
// Documents are not in the snapshot: read them after subscribing, after a
// "missed" and after reconnecting.
func (c *Conn) Subscribe(ctx context.Context, p SubscribeParams) (*Events, *Subscribed, error) {
	var res Subscribed
	e, err := c.subscribe(ctx, p, &res)
	if err != nil {
		return nil, nil, err
	}
	return e, &res, nil
}

// SubscribeRaw is Subscribe for a caller that passes terminal records on as
// the core sent them, with the fields this package does not know.
func (c *Conn) SubscribeRaw(ctx context.Context, p SubscribeParams) (*RawEvents, []map[string]any, error) {
	var res struct {
		Terminals []map[string]any `json:"terminals"`
	}
	e, err := c.subscribe(ctx, p, &res)
	if err != nil {
		return nil, nil, err
	}
	return &RawEvents{e}, res.Terminals, nil
}

func (c *Conn) subscribe(ctx context.Context, p SubscribeParams, result any) (*Events, error) {
	e := &Events{c: c, q: newQueue()}
	err := c.call(ctx, "events.subscribe", p, result, func(raw json.RawMessage) uint32 {
		var r struct {
			Channel uint32 `json:"channel"`
		}
		if json.Unmarshal(raw, &r) != nil || r.Channel == 0 {
			return 0
		}
		c.register(r.Channel, e.q)
		e.channel = r.Channel
		return r.Channel
	})
	if err != nil {
		return nil, err
	}
	if e.channel == 0 {
		return nil, fmt.Errorf("hc: events.subscribe: reply without a channel")
	}
	return e, nil
}

// RawNotification is a Notification whose terminal records are undecoded.
type RawNotification struct {
	Method, Type, Terminal, Machine string
	Seq                             uint64
	Data                            json.RawMessage
	Terminals                       []map[string]any
}

// RawEvents is an event subscription returning RawNotifications.
type RawEvents struct{ e *Events }

// Recv waits for the next notification.
func (r *RawEvents) Recv(ctx context.Context) (RawNotification, error) {
	line, err := r.e.line(ctx)
	if err != nil {
		return RawNotification{}, err
	}
	var m struct {
		Method string `json:"method"`
		Params struct {
			Seq       uint64           `json:"seq"`
			Type      string           `json:"type"`
			Terminal  string           `json:"terminal"`
			Machine   string           `json:"machine"`
			Data      json.RawMessage  `json:"data"`
			Terminals []map[string]any `json:"terminals"`
		} `json:"params"`
	}
	if err := json.Unmarshal(line, &m); err != nil {
		return RawNotification{}, fmt.Errorf("hc: event: %w", err)
	}
	p := m.Params
	return RawNotification{Method: m.Method, Type: p.Type, Terminal: p.Terminal, Machine: p.Machine, Seq: p.Seq, Data: p.Data, Terminals: p.Terminals}, nil
}

// Close ends the subscription.
func (r *RawEvents) Close() error { return r.e.Close() }

// Recv waits for the next notification. A heartbeat arrives every 15 s
// while there are no events; the caller decides how long silence may last.
func (e *Events) Recv(ctx context.Context) (Notification, error) {
	line, err := e.line(ctx)
	if err != nil {
		return Notification{}, err
	}
	return parseNotification(line)
}

// line waits for the next line of the channel. Lines arrive split anywhere
// across frames; the credit of a frame goes back when it is taken.
func (e *Events) line(ctx context.Context) ([]byte, error) {
	for {
		if i := bytes.IndexByte(e.buf, '\n'); i >= 0 {
			line := e.buf[:i:i]
			e.buf = e.buf[i+1:]
			if len(bytes.TrimSpace(line)) == 0 {
				continue
			}
			return line, nil
		}
		if len(e.buf) > MaxPayload {
			err := fmt.Errorf("hc: event exceeds %d bytes", MaxPayload)
			e.c.fail(err)
			return nil, err
		}
		it, err := e.q.pop(ctx)
		if err != nil {
			if err == io.EOF {
				err = io.ErrUnexpectedEOF // the core does not end a subscription
			}
			return nil, err
		}
		if it.kind != kindData {
			continue
		}
		e.buf = append(e.buf, it.payload...)
		if err := e.c.send(e.channel, kindCredit, binary.LittleEndian.AppendUint32(nil, uint32(len(it.payload)))); err != nil {
			return nil, err
		}
	}
}

// Close ends the subscription.
func (e *Events) Close() error {
	e.c.closeChannel(e.channel, e.q)
	return nil
}

func parseNotification(line []byte) (Notification, error) {
	var m struct {
		Method string `json:"method"`
		Params struct {
			Seq       uint64          `json:"seq"`
			Type      string          `json:"type"`
			Terminal  string          `json:"terminal"`
			Machine   string          `json:"machine"`
			Data      json.RawMessage `json:"data"`
			Terminals []Terminal      `json:"terminals"`
		} `json:"params"`
	}
	if err := json.Unmarshal(line, &m); err != nil {
		return Notification{}, fmt.Errorf("hc: event: %w", err)
	}
	p := m.Params
	return Notification{
		Method: m.Method, Seq: p.Seq, Type: p.Type, Terminal: p.Terminal,
		Machine: p.Machine, Data: p.Data, Terminals: p.Terminals,
	}, nil
}
