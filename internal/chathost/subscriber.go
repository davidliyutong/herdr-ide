//go:build unix

package chathost

import (
	"net"
	"sync"
	"time"

	"herdr-ide/internal/chatproto"
)

const (
	// queueEvents and queueBytes are how far an attached or watching
	// connection may fall behind before it is disconnected.
	queueEvents = 8192
	queueBytes  = 16 << 20
	// writeBatch is how many bytes of lines go into one write, and
	// writeTimeout how long a connection has to take one.
	writeBatch   = 64 << 10
	writeTimeout = 30 * time.Second
	// keepBuffer is the largest write buffer kept for the next write.
	keepBuffer = 1 << 20
)

// replay is what an attached connection gets of the chat's log before the
// events that come after it attached: the stored events with a sequence
// number in (after, upTo], read a page at a time.
type replay struct {
	j     *journal
	chat  string
	after uint64
	upTo  uint64
}

// subscriber is an attached or watching connection: the lines it still has
// to get, and the goroutine that writes them. Nothing waits for one: a line
// goes into the queue or, when the connection fell too far behind, the
// connection is closed, and its client attaches again with the last
// sequence number it has.
type subscriber struct {
	conn      net.Conn
	maxEvents int
	maxBytes  int
	wake      chan struct{} // a line was queued, or the connection is to end
	done      chan struct{} // closed when run returned

	mu      sync.Mutex
	head    [][]byte // the answer to the request; not counted
	replay  *replay  // the log before the queue; not counted
	queue   [][]byte // what came since
	queued  int      // the bytes of queue
	closing bool     // nothing more comes: run returns once all is written
	dead    bool     // the connection was given up
}

func newSubscriber(conn net.Conn) *subscriber {
	return &subscriber{
		conn: conn, maxEvents: queueEvents, maxBytes: queueBytes,
		wake: make(chan struct{}, 1), done: make(chan struct{}),
	}
}

// push queues a line. It returns false when that put the connection too far
// behind: the connection is closed then, and gets nothing more.
func (s *subscriber) push(line []byte) bool {
	s.mu.Lock()
	if s.dead || s.closing {
		s.mu.Unlock()
		return true
	}
	// A line of any size is taken by a connection that waits for nothing
	// else: one event may be larger than the queue.
	if len(s.queue) >= s.maxEvents || (len(s.queue) > 0 && s.queued+len(line) > s.maxBytes) {
		s.mu.Unlock()
		s.drop()
		return false
	}
	s.queue = append(s.queue, line)
	s.queued += len(line)
	s.mu.Unlock()
	s.signal()
	return true
}

// ack queues the answer to a command.
func (s *subscriber) ack(id string, e *chatproto.Error) {
	if line, err := chatproto.Line(chatproto.Event{T: chatproto.EventAck, ID: id, Error: e}); err == nil {
		s.push(line)
	}
}

// finish closes the connection once everything queued is written.
func (s *subscriber) finish() {
	s.mu.Lock()
	s.closing = true
	s.mu.Unlock()
	s.signal()
}

// drop closes the connection at once.
func (s *subscriber) drop() {
	s.mu.Lock()
	s.dead = true
	s.head, s.replay, s.queue, s.queued = nil, nil, nil, 0
	s.mu.Unlock()
	s.conn.Close()
	s.signal()
}

func (s *subscriber) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// run writes the lines to the connection, the head first, then the replay,
// then the queue, and closes the connection when it returns: after finish
// or drop, or when a write failed or was not taken in time.
func (s *subscriber) run() {
	defer close(s.done)
	defer s.conn.Close()
	var buf []byte
	for {
		var more bool
		buf, more = s.take(buf[:0])
		if !more {
			return
		}
		if len(buf) == 0 {
			<-s.wake
			continue
		}
		s.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
		if _, err := s.conn.Write(buf); err != nil {
			return
		}
		if cap(buf) > keepBuffer {
			buf = make([]byte, 0, writeBatch)
		}
	}
}

// take appends the next lines to buf: at least one when there is one, and
// more while they fit a write. It is false when there is nothing more to
// write, ever.
func (s *subscriber) take(buf []byte) ([]byte, bool) {
	s.mu.Lock()
	if s.dead {
		s.mu.Unlock()
		return nil, false
	}
	if buf == nil {
		buf = make([]byte, 0, writeBatch)
	}
	for len(s.head) > 0 && (len(buf) == 0 || len(buf)+len(s.head[0]) <= writeBatch) {
		buf = append(buf, s.head[0]...)
		s.head[0] = nil
		s.head = s.head[1:]
	}
	if len(s.head) > 0 {
		s.mu.Unlock()
		return buf, true
	}
	if r := s.replay; r != nil {
		s.mu.Unlock()
		// The log is read without the lock: the queue fills meanwhile.
		lines, last, err := r.j.events(r.chat, r.after, r.upTo, writeBatch)
		s.mu.Lock()
		if s.dead {
			s.mu.Unlock()
			return nil, false
		}
		if err != nil || len(lines) == 0 {
			s.replay = nil
		} else {
			r.after = last
			for _, l := range lines {
				buf = append(buf, l...)
			}
			s.mu.Unlock()
			return buf, true
		}
	}
	for len(s.queue) > 0 && (len(buf) == 0 || len(buf)+len(s.queue[0]) <= writeBatch) {
		line := s.queue[0]
		s.queue[0] = nil
		s.queue = s.queue[1:]
		s.queued -= len(line)
		buf = append(buf, line...)
	}
	more := len(buf) > 0 || !s.closing
	s.mu.Unlock()
	return buf, more
}
