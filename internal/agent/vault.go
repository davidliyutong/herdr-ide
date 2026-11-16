//go:build unix

package agent

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/vaultmcp"
)

// maxVaultConns bounds the MCP server connections relayed at once; more
// wait in the listen queue.
const maxVaultConns = 16

// serveVault accepts connections of the variable vault's MCP servers on
// <run>/vault.sock (0600, in the 0700 run directory, and only from this
// user's processes) and relays each to the core over a stream with op
// vault. It ends with the agent; the newest agent of the instance serves
// the socket (serveSocket).
func (a *Agent) serveVault(ctx context.Context) {
	slots := make(chan struct{}, maxVaultConns)
	a.serveSocket(ctx, "vault", filepath.Join(a.runDir, "vault.sock"), func(c net.Conn) {
		pid, uid, err := peerCred(c.(*net.UnixConn))
		if err != nil || uid != os.Getuid() {
			a.logger.Printf("vault: refused a connection from uid %d (%v)", uid, err)
			c.Close()
			return
		}
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
			c.Close()
			return
		}
		go func() {
			defer func() { <-slots }()
			a.relayVault(c, processChain(pid))
		}()
	})
}

// processChain is the process pid (connected to vault.sock) and its
// parents, up to agentproto.MaxVaultProcesses, as the kernel names them:
// the core records who asked with every access (the request's own claims
// about its client are not trusted). It stops at init and at a process
// that is gone.
func processChain(pid int) []agentproto.VaultProcess {
	var chain []agentproto.VaultProcess
	for pid > 1 && len(chain) < agentproto.MaxVaultProcesses {
		ppid, name, ok := parentOf(pid)
		if !ok {
			break
		}
		chain = append(chain, agentproto.VaultProcess{Pid: pid, Name: name})
		if ppid == pid {
			break
		}
		pid = ppid
	}
	return chain
}

// relayVault pipes one MCP server connection to the core, once it sent its
// request (within 30 s, as the core waits for it), with the process chain
// behind it in the stream's header.
func (a *Agent) relayVault(c net.Conn, chain []agentproto.VaultProcess) {
	a.relayFirst(c, agentproto.Header{Op: agentproto.OpVault, Process: chain}, 30*time.Second, func(rep agentproto.Reply) {
		// The core refused (the plugin is off): the MCP server reads why.
		code := rep.Code
		if code == "" {
			code = "unavailable"
		}
		agentproto.WriteLine(c, agentproto.VaultResponse{Code: code, Error: rep.Error})
	})
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

// LinkMCP makes dir/<slug>-mcp (vaultmcp.LinkName: the stable path an MCP
// configuration names, so it outlives upgrades) a link to exe, replacing
// another link atomically.
func LinkMCP(dir, exe string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	link := filepath.Join(dir, vaultmcp.LinkName)
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
