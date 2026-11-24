//go:build unix

// Package agenttest connects the agent's tests to an agent served in the
// test's process, as a core does over a machine's node: yamux over a
// socketpair, streams opened with a header line and answered with a reply
// line (internal/agentproto). The core that dials agents is the
// TypeScript one (backend/kernel/machines); this is its client side, kept
// for the Go tests only.
package agenttest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"sync"
	"syscall"
	"time"

	"github.com/hashicorp/yamux"

	"veldr/internal/agent"
	"veldr/internal/agentproto"
)

// Session is a live connection to one agent.
type Session struct {
	ys     *yamux.Session
	closer io.Closer
	done   chan struct{}
	once   sync.Once
}

// ReplyTimeout bounds the wait for an agent's reply when the caller's
// context has no deadline.
var ReplyTimeout = 60 * time.Second

// DialLocal starts an agent in this process, connected through a
// socketpair, which ends with the session. A nil opts.Logger logs to
// stderr.
func DialLocal(ctx context.Context, opts agent.Options) (*Session, error) {
	logger := opts.Logger
	if logger == nil {
		logger = log.New(os.Stderr, "", log.LstdFlags)
	}
	if opts.SSHConnection == "" {
		opts.SSHConnection = os.Getenv("SSH_CONNECTION")
	}
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, err
	}
	f0 := os.NewFile(uintptr(fds[0]), "agent-core")
	f1 := os.NewFile(uintptr(fds[1]), "agent-local")
	c0, err := net.FileConn(f0)
	f0.Close()
	if err != nil {
		f1.Close()
		return nil, err
	}
	c1, err := net.FileConn(f1)
	f1.Close()
	if err != nil {
		c0.Close()
		return nil, err
	}
	actx, cancel := context.WithCancel(context.Background())
	served := make(chan struct{})
	go func() {
		defer close(served)
		opts.Logger = log.New(logger.Writer(), "agent[local]: ", log.LstdFlags)
		if err := agent.Serve(actx, c1, opts); err != nil {
			logger.Printf("local agent: %v", err)
		}
		c1.Close()
	}()
	ys, err := yamux.Client(c0, agentproto.YamuxConfig(logger))
	if err != nil {
		cancel()
		c0.Close()
		c1.Close()
		return nil, err
	}
	// Closing waits for the agent's cleanup (it stops the code-server it
	// started), which a remote agent does after its ssh session ends.
	s := &Session{ys: ys, done: make(chan struct{}), closer: closerFunc(func() error {
		cancel()
		err := c1.Close()
		select {
		case <-served:
		case <-time.After(10 * time.Second):
			logger.Printf("local agent did not finish cleaning up")
		}
		return err
	})}
	go func() {
		<-ys.CloseChan()
		s.Close()
	}()
	return s, nil
}

// Close tears the session down and waits for the agent to clean up.
func (s *Session) Close() error {
	s.once.Do(func() {
		s.ys.Close()
		s.closer.Close()
		close(s.done)
	})
	return nil
}

// Done is closed when the session ends.
func (s *Session) Done() <-chan struct{} { return s.done }

// Open starts a stream with header h and waits for the agent's reply.
func (s *Session) Open(ctx context.Context, h agentproto.Header) (net.Conn, *agentproto.Reply, error) {
	return s.OpenWith(ctx, h, nil)
}

// OpenWith is Open with body written right after the header line, before
// the reply is read (agentproto.Header.ParamsLength).
func (s *Session) OpenWith(ctx context.Context, h agentproto.Header, body []byte) (net.Conn, *agentproto.Reply, error) {
	st, err := s.ys.OpenStream()
	if err != nil {
		return nil, nil, err
	}
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
	fail := func(err error) (net.Conn, *agentproto.Reply, error) {
		st.Close()
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		return nil, nil, fmt.Errorf("agent %s: %w", h.Op, err)
	}
	if err := agentproto.WriteLine(st, h); err != nil {
		return fail(err)
	}
	if len(body) > 0 {
		if _, err := st.Write(body); err != nil {
			return fail(err)
		}
	}
	var rep agentproto.Reply
	if err := agentproto.ReadLine(st, &rep); err != nil {
		return fail(err)
	}
	if !rep.OK {
		st.Close()
		return nil, &rep, fmt.Errorf("agent %s: %s", h.Op, rep.Error)
	}
	if rep.EntriesLength > 0 {
		// A listing too large for the line follows it (fs.list).
		b, err := agentproto.ReadBody(st, rep.EntriesLength)
		if err != nil {
			return fail(err)
		}
		if err := json.Unmarshal(b, &rep.Entries); err != nil {
			return fail(errors.Join(errors.New("entries"), err))
		}
		rep.EntriesLength = 0
	}
	_ = st.SetDeadline(time.Time{})
	return st, &rep, nil
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

// Accept returns streams opened by the agent.
func (s *Session) Accept() (net.Conn, error) {
	return s.ys.AcceptStream()
}

type closerFunc func() error

func (f closerFunc) Close() error { return f() }
