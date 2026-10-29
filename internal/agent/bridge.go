package agent

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"webherdr/internal/agentproto"
)

// serveBridge accepts connections from the VS Code bridge extension on
// <run>/bridge.sock and tunnels each one to the core.
//
// Another agent of the same instance (a second core connected to this
// machine) may already serve the socket; it is left alone rather than
// stolen, and on exit only the socket file this agent created is removed.
func (a *Agent) serveBridge(ctx context.Context) {
	path := filepath.Join(a.runDir, "bridge.sock")
	if c, err := net.DialTimeout("unix", path, time.Second); err == nil {
		c.Close()
		a.logger.Printf("bridge: %s is served by another agent; VS Code commands go to that core", path)
		return
	}
	os.Remove(path) // stale
	ln, err := net.Listen("unix", path)
	if err != nil {
		a.logger.Printf("bridge: %v", err)
		return
	}
	ul := ln.(*net.UnixListener)
	ul.SetUnlinkOnClose(false)
	os.Chmod(path, 0o600)
	var ino uint64
	if st, err := os.Stat(path); err == nil {
		if sys, ok := st.Sys().(*syscall.Stat_t); ok {
			ino = uint64(sys.Ino)
		}
	}
	go func() {
		<-ctx.Done()
		ln.Close()
		if st, err := os.Stat(path); err == nil {
			if sys, ok := st.Sys().(*syscall.Stat_t); ok && uint64(sys.Ino) == ino {
				os.Remove(path)
			}
		}
	}()
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			st, err := a.sess.OpenStream()
			if err != nil {
				c.Close()
				return
			}
			st.SetDeadline(time.Now().Add(15 * time.Second))
			if err := agentproto.WriteLine(st, agentproto.Header{Op: agentproto.OpBridge}); err != nil {
				st.Close()
				c.Close()
				return
			}
			var rep agentproto.Reply
			if err := agentproto.ReadLine(st, &rep); err != nil || !rep.OK {
				st.Close()
				c.Close()
				return
			}
			st.SetDeadline(time.Time{})
			pipe(st, c)
		}()
	}
}
