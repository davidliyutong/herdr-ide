//go:build unix

package agent

import (
	"bufio"
	"context"
	"net"
	"os"
	"sync/atomic"
	"syscall"
	"time"

	"veldr/internal/agentproto"
)

// socketWatchEvery is how often (in nanoseconds) an agent checks that the
// socket it serves is still its own, or, its socket taken over, whether
// the path is free again: 2 s (tests shorten it).
var socketWatchEvery atomic.Int64

func init() { socketWatchEvery.Store(int64(2 * time.Second)) }

func watchEvery() time.Duration { return time.Duration(socketWatchEvery.Load()) }

// serveSocket serves the unix socket at path (0600, in the 0700 run
// directory) until ctx ends, passing each connection to accept; name
// prefixes the log. The newest agent of the instance takes the socket
// over: after a reconnect the agent of the old session may linger until it
// notices, and the socket must lead to the session that works. An agent
// removes the socket on exit only while it is still its own (the same
// inode), and one whose socket was taken over serves it again once the
// path is free (the newer agent gone, or killed and its socket left), so
// the socket is served while any agent of the instance runs.
func (a *Agent) serveSocket(ctx context.Context, name, path string, accept func(net.Conn)) {
	failed := false // the last listen failed (and was logged)
	for {
		ln, ino, err := listenSocket(path)
		if err != nil {
			if !failed {
				a.logger.Printf("%s: %v", name, err)
			}
			failed = true
		} else {
			failed = false
			done := make(chan struct{})
			go func() {
				defer close(done)
				for {
					c, err := ln.Accept()
					if err != nil {
						return
					}
					accept(c)
				}
			}()
			lost := watchSocket(ctx, path, ino)
			ln.Close()
			<-done
			if !lost {
				if cur, ok := inode(path); ok && cur == ino {
					os.Remove(path)
				}
				return
			}
			a.logger.Printf("%s: %s is served by another agent of the instance; served again here once it is free", name, path)
		}
		if !waitFree(ctx, path) {
			return
		}
	}
}

// listenSocket listens on path, replacing what is there (a stale socket,
// or another agent's, which this one takes over), and returns the socket's
// inode.
func listenSocket(path string) (net.Listener, uint64, error) {
	os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, 0, err
	}
	// Removed on exit only while it is this agent's (serveSocket).
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	os.Chmod(path, 0o600)
	ino, _ := inode(path)
	return ln, ino, nil
}

// inode is the inode of the file at path.
func inode(path string) (uint64, bool) {
	st, err := os.Lstat(path)
	if err != nil {
		return 0, false
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return uint64(sys.Ino), true
}

// watchSocket waits until ctx ends (false) or the socket at path is no
// longer the one of inode ino (true: another agent took it over, or it was
// removed).
func watchSocket(ctx context.Context, path string, ino uint64) bool {
	t := time.NewTicker(watchEvery())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-t.C:
		}
		if cur, ok := inode(path); !ok || cur != ino {
			return true
		}
	}
}

// waitFree waits until nothing serves path (true): the file is gone, or
// nothing answers on it. A connection that checks sends nothing, which
// the agent serving it relays nowhere (relayFirst). False when ctx ends.
func waitFree(ctx context.Context, path string) bool {
	t := time.NewTicker(watchEvery())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-t.C:
		}
		if _, err := os.Lstat(path); err != nil {
			return true
		}
		c, err := net.DialTimeout("unix", path, time.Second)
		if err != nil {
			return true
		}
		c.Close()
	}
}

// relayFirst opens a stream with hdr to the core of the session to picks
// once c sent its first bytes, within wait (none: no limit), and pipes
// them; a connection that sends nothing (another agent checking that the
// socket is served) opens none. refused, when no session serves or the core
// refuses the stream, tells c why.
func (a *Agent) relayFirst(c net.Conn, hdr agentproto.Header, wait time.Duration, to func() *session, refused func(agentproto.Reply)) {
	r := bufio.NewReader(c)
	if wait > 0 {
		c.SetReadDeadline(time.Now().Add(wait))
	}
	if _, err := r.Peek(1); err != nil {
		c.Close()
		return
	}
	c.SetReadDeadline(time.Time{})
	s := to()
	if s == nil {
		if refused != nil {
			refused(agentproto.Reply{Code: "unavailable", Error: "no core is connected"})
		}
		c.Close()
		return
	}
	st, err := s.ys.OpenStream()
	if err != nil {
		c.Close()
		return
	}
	st.SetDeadline(time.Now().Add(15 * time.Second))
	if err := agentproto.WriteLine(st, hdr); err != nil {
		st.Close()
		c.Close()
		return
	}
	var rep agentproto.Reply
	if err := agentproto.ReadLine(st, &rep); err != nil || !rep.OK {
		if refused != nil {
			refused(rep)
		}
		st.Close()
		c.Close()
		return
	}
	st.SetDeadline(time.Time{})
	pipe(st, peeked{c, r})
}

// peeked is a connection whose first bytes were read into r.
type peeked struct {
	net.Conn
	r *bufio.Reader
}

func (p peeked) Read(b []byte) (int, error) { return p.r.Read(b) }
