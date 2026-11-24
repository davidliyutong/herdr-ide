// Package transport establishes yamux sessions to veldr agents, which
// machines' nodes serve: through the node's socket for the local machine
// (Linux and macOS, local.go), over ssh stdio and `node dial` for remote
// machines.
package transport

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"time"

	"github.com/hashicorp/yamux"

	"veldr/internal/agentproto"
)

// ClientID names this core to the nodes it reaches (agentproto.NodeHello.
// Client): random, the same for all its sessions while the process runs.
var ClientID = func() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}()

// Session is a live connection to one agent.
type Session struct {
	ys     *yamux.Session
	closer io.Closer
	done   chan struct{}
	once   sync.Once
	errMu  sync.Mutex
	err    error
}

// newSession starts yamux over conn. lost, if not nil, runs when the session
// ends on its own (the connection failed or yamux's keepalive timed out),
// before closer; not when it is closed with Close.
func newSession(conn io.ReadWriteCloser, closer io.Closer, logger *log.Logger, lost func()) (*Session, error) {
	ys, err := yamux.Client(conn, agentproto.YamuxConfig(logger))
	if err != nil {
		return nil, err
	}
	s := &Session{ys: ys, closer: closer, done: make(chan struct{})}
	go func() {
		<-ys.CloseChan()
		s.finish(errors.New("agent session closed"), lost)
	}()
	return s, nil
}

// finish ends the session once; before is run only by the call that ends it.
func (s *Session) finish(err error, before func()) {
	s.once.Do(func() {
		s.errMu.Lock()
		s.err = err
		s.errMu.Unlock()
		if before != nil {
			before()
		}
		s.ys.Close()
		if s.closer != nil {
			s.closer.Close()
		}
		close(s.done)
	})
}

// Close tears the session down.
func (s *Session) Close() error {
	s.finish(errors.New("closed"), nil)
	return nil
}

// Done is closed when the session ends.
func (s *Session) Done() <-chan struct{} { return s.done }

// Err reports why the session ended.
func (s *Session) Err() error {
	s.errMu.Lock()
	defer s.errMu.Unlock()
	return s.err
}

// ReplyTimeout bounds the wait for an agent's reply when the caller's
// context has no deadline, so a stream whose reply never comes ends.
var ReplyTimeout = 60 * time.Second

// Open starts a stream with header h and waits for the agent's reply.
func (s *Session) Open(ctx context.Context, h agentproto.Header) (net.Conn, *agentproto.Reply, error) {
	return s.OpenWith(ctx, h, nil)
}

// OpenWith is Open with body written right after the header line, before
// the reply is read: an op's data that does not fit the line (a plugin's
// params, agentproto.Header.ParamsLength).
func (s *Session) OpenWith(ctx context.Context, h agentproto.Header, body []byte) (net.Conn, *agentproto.Reply, error) {
	st, err := s.ys.OpenStream()
	if err != nil {
		return nil, nil, err
	}
	// The reply comes within ReplyTimeout unless the caller's context says
	// otherwise: actions that answer only after their work (a scan of logs,
	// a git push) give their own, longer deadline.
	deadline := time.Now().Add(ReplyTimeout)
	if dl, ok := ctx.Deadline(); ok {
		deadline = dl
	}
	_ = st.SetDeadline(deadline)
	stop := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			st.Close()
		case <-stop:
		}
	}()
	defer close(stop)
	if err := agentproto.WriteLine(st, h); err != nil {
		st.Close()
		return nil, nil, err
	}
	if len(body) > 0 {
		if _, err := st.Write(body); err != nil {
			st.Close()
			if ctx.Err() != nil {
				return nil, nil, ctx.Err()
			}
			return nil, nil, fmt.Errorf("agent %s: %w", h.Op, err)
		}
	}
	var rep agentproto.Reply
	if err := agentproto.ReadLine(st, &rep); err != nil {
		st.Close()
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		return nil, nil, fmt.Errorf("agent %s: %w", h.Op, err)
	}
	if !rep.OK {
		st.Close()
		return nil, &rep, fmt.Errorf("agent %s: %s", h.Op, rep.Error)
	}
	if rep.EntriesLength > 0 {
		// A listing too large for the line follows it (fs.list).
		if err := readEntries(st, &rep); err != nil {
			st.Close()
			if ctx.Err() != nil {
				return nil, nil, ctx.Err()
			}
			return nil, nil, fmt.Errorf("agent %s: %w", h.Op, err)
		}
	}
	_ = st.SetDeadline(time.Time{})
	return st, &rep, nil
}

// readEntries reads the entries that follow a reply line
// (Reply.EntriesLength, at most agentproto.MaxBody bytes) into rep.Entries.
func readEntries(r io.Reader, rep *agentproto.Reply) error {
	b, err := agentproto.ReadBody(r, rep.EntriesLength)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, &rep.Entries); err != nil {
		return fmt.Errorf("agentproto: entries: %w", err)
	}
	rep.EntriesLength = 0
	return nil
}

// Request opens a stream, returns the reply and closes the stream.
func (s *Session) Request(ctx context.Context, h agentproto.Header) (*agentproto.Reply, error) {
	st, rep, err := s.Open(ctx, h)
	if err != nil {
		return rep, err
	}
	st.Close()
	return rep, nil
}

// Accept returns streams opened by the agent (VS Code bridge connections).
func (s *Session) Accept() (net.Conn, error) {
	return s.ys.AcceptStream()
}

type closerFunc func() error

func (f closerFunc) Close() error { return f() }
