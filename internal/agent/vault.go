//go:build unix

package agent

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
)

// maxVaultConns bounds the MCP server connections relayed at once; more
// wait in the listen queue.
const maxVaultConns = 16

// MCPLinkName is the stable path's name below <data dir>/bin: a link to
// the executable that serves the mcp command (this agent's, or the core's
// for the local machine), so an MCP configuration outlives upgrades.
const MCPLinkName = brand.Slug + "-mcp"

// serveVault accepts connections of the variable vault's MCP servers on
// <run>/vault.sock (0600, in the 0700 run directory, and only from this
// user's processes) and relays each to the core over a stream with op
// vault. It ends with the agent; as with the bridge, a socket another
// agent of the instance serves is left to it.
func (a *Agent) serveVault(ctx context.Context) {
	path := filepath.Join(a.runDir, "vault.sock")
	if c, err := net.DialTimeout("unix", path, time.Second); err == nil {
		c.Close()
		a.logger.Printf("vault: %s is served by another agent; MCP requests go to that core", path)
		return
	}
	os.Remove(path) // stale
	ln, err := net.Listen("unix", path)
	if err != nil {
		a.logger.Printf("vault: %v", err)
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
	slots := make(chan struct{}, maxVaultConns)
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		if _, uid, err := peerCred(c.(*net.UnixConn)); err != nil || uid != os.Getuid() {
			a.logger.Printf("vault: refused a connection from uid %d (%v)", uid, err)
			c.Close()
			continue
		}
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
			c.Close()
			return
		}
		go func() {
			defer func() { <-slots }()
			a.relayVault(c)
		}()
	}
}

// relayVault pipes one MCP server connection to the core.
func (a *Agent) relayVault(c net.Conn) {
	st, err := a.sess.OpenStream()
	if err != nil {
		c.Close()
		return
	}
	st.SetDeadline(time.Now().Add(15 * time.Second))
	if err := agentproto.WriteLine(st, agentproto.Header{Op: agentproto.OpVault}); err != nil {
		st.Close()
		c.Close()
		return
	}
	var rep agentproto.Reply
	if err := agentproto.ReadLine(st, &rep); err != nil || !rep.OK {
		// The core refused (the plugin is off): the MCP server reads why.
		code := rep.Code
		if code == "" {
			code = "unavailable"
		}
		agentproto.WriteLine(c, agentproto.VaultResponse{Code: code, Error: rep.Error})
		st.Close()
		c.Close()
		return
	}
	st.SetDeadline(time.Time{})
	pipe(st, c)
}

// linkMCP points <data dir>/bin/<slug>-mcp at the running executable,
// which serves the mcp command when started by that name.
func (a *Agent) linkMCP() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	if err := LinkMCP(filepath.Join(a.base, "bin"), exe); err != nil {
		a.logger.Printf("vault: %v", err)
	}
}

// LinkMCP makes dir/<slug>-mcp a link to exe, replacing another link
// atomically.
func LinkMCP(dir, exe string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	link := filepath.Join(dir, MCPLinkName)
	if cur, err := os.Readlink(link); err == nil && cur == exe {
		return nil
	}
	tmp := link + ".new"
	os.Remove(tmp)
	if err := os.Symlink(exe, tmp); err != nil {
		return err
	}
	return os.Rename(tmp, link)
}
