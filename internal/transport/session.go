// Package transport establishes yamux sessions to webherdr agents: in-process
// for the local machine, over ssh stdio for remote machines.
package transport

import (
	"context"
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

	"webherdr/internal/agent"
	"webherdr/internal/agentproto"
)

// Session is a live connection to one agent.
type Session struct {
	ys     *yamux.Session
	closer io.Closer
	done   chan struct{}
	once   sync.Once
	errMu  sync.Mutex
	err    error
}

func newSession(conn io.ReadWriteCloser, closer io.Closer, logger *log.Logger) (*Session, error) {
	ys, err := yamux.Client(conn, agent.YamuxConfig(logger))
	if err != nil {
		return nil, err
	}
	s := &Session{ys: ys, closer: closer, done: make(chan struct{})}
	go func() {
		<-ys.CloseChan()
		s.finish(errors.New("agent session closed"))
	}()
	return s, nil
}

func (s *Session) finish(err error) {
	s.once.Do(func() {
		s.errMu.Lock()
		s.err = err
		s.errMu.Unlock()
		s.ys.Close()
		if s.closer != nil {
			s.closer.Close()
		}
		close(s.done)
	})
}

// Close tears the session down.
func (s *Session) Close() error {
	s.finish(errors.New("closed"))
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

// Open starts a stream with header h and waits for the agent's reply.
func (s *Session) Open(ctx context.Context, h agentproto.Header) (net.Conn, *agentproto.Reply, error) {
	st, err := s.ys.OpenStream()
	if err != nil {
		return nil, nil, err
	}
	deadline := time.Now().Add(60 * time.Second)
	if dl, ok := ctx.Deadline(); ok && dl.Before(deadline) {
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

// Accept returns streams opened by the agent (VS Code bridge connections).
func (s *Session) Accept() (net.Conn, error) {
	return s.ys.AcceptStream()
}

// DialLocal starts an in-process agent connected through a socketpair, so the
// local machine uses exactly the same protocol as remote machines.
func DialLocal(ctx context.Context, instance string, logger *log.Logger) (*Session, error) {
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
	go func() {
		if err := agent.Serve(actx, c1, agent.Options{Instance: instance, Logger: log.New(logger.Writer(), "agent[local]: ", log.LstdFlags)}); err != nil {
			logger.Printf("local agent: %v", err)
		}
		c1.Close()
	}()
	s, err := newSession(c0, closerFunc(func() error { cancel(); return c1.Close() }), logger)
	if err != nil {
		cancel()
		c0.Close()
		c1.Close()
		return nil, err
	}
	return s, nil
}

type closerFunc func() error

func (f closerFunc) Close() error { return f() }
