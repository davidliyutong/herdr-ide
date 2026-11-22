//go:build unix

package acp

import (
	"context"
	"sync"
)

const (
	// outboxHigh and outboxLow bound what waits for the host: once more
	// than outboxHigh calls wait, the reading of the agent's output waits
	// until no more than outboxLow do. The host takes events at once
	// (chatadapter.Sink), so this is a backstop.
	outboxHigh = 4096
	outboxLow  = 1024
)

// outbox hands a session's events and changes to the host in the order
// they were made, from a goroutine of its own: the session makes them under
// its lock and never calls the host with it held, so that a host that
// calls the session with a lock of its own held cannot deadlock with it.
type outbox struct {
	mu     sync.Mutex
	q      []func()
	queued uint64        // calls pushed so far
	ran    uint64        // calls made so far
	moved  chan struct{} // closed and replaced whenever calls were made
	wake   chan struct{}
	closed bool
	done   chan struct{} // closed once closed and every call was made
}

func newOutbox() *outbox {
	o := &outbox{moved: make(chan struct{}), wake: make(chan struct{}, 1), done: make(chan struct{})}
	go o.run()
	return o
}

// push adds a call; it never blocks. Calls after close are dropped.
func (o *outbox) push(f func()) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return
	}
	o.q = append(o.q, f)
	o.queued++
	select {
	case o.wake <- struct{}{}:
	default:
	}
}

// mark is the number of calls pushed so far: what reached waits for.
func (o *outbox) mark() uint64 {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.queued
}

// reached returns once the first n calls were made, the outbox is done, or
// ctx ends.
func (o *outbox) reached(ctx context.Context, n uint64) {
	for {
		o.mu.Lock()
		ran, moved := o.ran, o.moved
		o.mu.Unlock()
		if ran >= n {
			return
		}
		select {
		case <-moved:
		case <-o.done:
			return
		case <-ctx.Done():
			return
		}
	}
}

// throttle waits while too many calls wait: for the reader of the agent's
// output, which must not hold the session's lock.
func (o *outbox) throttle() {
	o.mu.Lock()
	n := len(o.q)
	o.mu.Unlock()
	if n <= outboxHigh {
		return
	}
	for {
		o.mu.Lock()
		n, moved := len(o.q), o.moved
		o.mu.Unlock()
		if n <= outboxLow {
			return
		}
		select {
		case <-moved:
		case <-o.done:
			return
		}
	}
}

// close makes the calls pushed so far and then ends; done is closed then.
func (o *outbox) close() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.closed {
		o.closed = true
		select {
		case o.wake <- struct{}{}:
		default:
		}
	}
}

func (o *outbox) run() {
	defer close(o.done)
	for {
		o.mu.Lock()
		q, closed := o.q, o.closed
		o.q = nil
		o.mu.Unlock()
		for _, f := range q {
			f()
		}
		if len(q) > 0 {
			o.mu.Lock()
			o.ran += uint64(len(q))
			close(o.moved)
			o.moved = make(chan struct{})
			o.mu.Unlock()
		}
		if closed && len(q) == 0 {
			return
		}
		if len(q) == 0 {
			<-o.wake
		}
	}
}
