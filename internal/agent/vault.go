//go:build unix

package agent

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"slices"
	"time"

	"golang.org/x/sys/unix"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/vaultmcp"
)

// maxVaultConns bounds the MCP server connections relayed at once; more
// wait in the listen queue.
const maxVaultConns = 16

// serveVault accepts connections of the variable vault's MCP servers on
// <run>/vault.sock (0600, in the 0700 run directory, and only from this
// user's processes) and asks the cores of the agent's sessions over
// streams with op vault (relayVault). It ends with the agent; the newest agent of the instance serves
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

// vaultAsk bounds how long a request waits for the MCP server's request,
// and each core for its reply to the stream.
const vaultAsk = 30 * time.Second

// relayVault asks every core of the agent's sessions for one MCP server
// request (once it sent it, within vaultAsk), with the process chain behind
// it in each stream's header: values live in the cores' vaults, and the
// user may answer on any of them. The first core that grants get or env
// answers, and the other cores' streams close, which withdraws their
// questions; list answers with every core's variables. The request fails
// only when every core refused it, with the most telling refusal
// (vaultRefusal). The MCP server going away ends every question.
func (a *Agent) relayVault(c net.Conn, chain []agentproto.VaultProcess) {
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(vaultAsk))
	var raw json.RawMessage
	if err := agentproto.ReadLine(c, &raw); err != nil {
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	var req agentproto.VaultRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		agentproto.WriteLine(c, agentproto.VaultResponse{Code: "bad_request", Error: "not a request"})
		return
	}
	sessions := a.liveSessions()
	if len(sessions) == 0 {
		agentproto.WriteLine(c, agentproto.VaultResponse{Code: "unavailable", Error: "no core is connected"})
		return
	}
	ctx, cancel := context.WithCancel(a.ctx)
	defer cancel()
	go func() {
		var b [1]byte
		c.Read(b[:]) // the MCP server sends nothing more: this is its leaving
		cancel()
	}()
	answers := make(chan agentproto.VaultResponse, len(sessions))
	for _, s := range sessions {
		go func() { answers <- askVault(ctx, s, chain, raw) }()
	}
	var refusals []agentproto.VaultResponse
	var list *agentproto.VaultResponse
	for range sessions {
		resp := <-answers
		switch {
		case !resp.OK:
			refusals = append(refusals, resp)
		case req.Tool == agentproto.VaultList:
			list = mergeVaultLists(list, resp)
		default:
			cancel()
			agentproto.WriteLine(c, resp)
			return
		}
	}
	if list != nil {
		agentproto.WriteLine(c, *list)
		return
	}
	agentproto.WriteLine(c, vaultRefusal(refusals))
}

// askVault asks the core of session s for one request: a refusal when the
// core does not take the stream (its vault plugin is off) or goes away.
func askVault(ctx context.Context, s *session, chain []agentproto.VaultProcess, raw json.RawMessage) agentproto.VaultResponse {
	gone := agentproto.VaultResponse{Code: "unavailable", Error: "the core went away"}
	st, err := s.ys.OpenStream()
	if err != nil {
		return gone
	}
	defer st.Close()
	stop := context.AfterFunc(ctx, func() { st.Close() })
	defer stop()
	_ = st.SetDeadline(time.Now().Add(vaultAsk))
	if err := agentproto.WriteLine(st, agentproto.Header{Op: agentproto.OpVault, Process: chain}); err != nil {
		return gone
	}
	var rep agentproto.Reply
	if err := agentproto.ReadLine(st, &rep); err != nil {
		return gone
	}
	if !rep.OK {
		code := rep.Code
		if code == "" {
			code = "unavailable"
		}
		return agentproto.VaultResponse{Code: code, Error: rep.Error}
	}
	if err := agentproto.WriteLine(st, raw); err != nil {
		return gone
	}
	// The core bounds the wait for the user's answer itself.
	_ = st.SetDeadline(time.Time{})
	var resp agentproto.VaultResponse
	if err := agentproto.ReadLine(st, &resp); err != nil {
		return gone
	}
	return resp
}

// mergeVaultLists adds resp's variables to list: a name listed by several
// cores is listed once, as the first answer had it.
func mergeVaultLists(list *agentproto.VaultResponse, resp agentproto.VaultResponse) *agentproto.VaultResponse {
	if list == nil {
		return &resp
	}
	have := map[string]bool{}
	for _, v := range list.Variables {
		have[v.Name] = true
	}
	for _, v := range resp.Variables {
		if !have[v.Name] {
			list.Variables = append(list.Variables, v)
			have[v.Name] = true
		}
	}
	return list
}

// vaultRefusalOrder ranks refusals: the user's own answer first, then what
// the user can change, then what the request got wrong, then a core that
// could not answer.
var vaultRefusalOrder = []string{"denied", "vault_locked", "inject_only", "not_found", "busy", "bad_request"}

// vaultRefusal is the refusal of a request every core refused.
func vaultRefusal(refusals []agentproto.VaultResponse) agentproto.VaultResponse {
	rank := func(code string) int {
		if i := slices.Index(vaultRefusalOrder, code); i >= 0 {
			return i
		}
		return len(vaultRefusalOrder)
	}
	best := agentproto.VaultResponse{Code: "unavailable", Error: "no core answered"}
	for i, r := range refusals {
		if i == 0 || rank(r.Code) < rank(best.Code) {
			best = r
		}
	}
	return best
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
// configuration names, so it outlives upgrades) the script that runs this
// host's platform link (vaultmcp.LinkScript), and that link, beside it,
// a link to exe; each replaced atomically.
func LinkMCP(dir, exe string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	var u unix.Utsname
	if err := unix.Uname(&u); err != nil {
		return err
	}
	link := filepath.Join(dir, vaultmcp.PlatformLink(unix.ByteSliceToString(u.Sysname[:]), unix.ByteSliceToString(u.Machine[:])))
	if cur, err := os.Readlink(link); err != nil || cur != exe {
		tmp := link + ".new"
		os.Remove(tmp)
		if err := os.Symlink(exe, tmp); err != nil {
			return err
		}
		if err := os.Rename(tmp, link); err != nil {
			return err
		}
	}
	script := filepath.Join(dir, vaultmcp.LinkName)
	if fi, err := os.Lstat(script); err == nil && fi.Mode().IsRegular() {
		if b, err := os.ReadFile(script); err == nil && string(b) == vaultmcp.LinkScript {
			return nil
		}
	}
	tmp := script + ".new"
	os.Remove(tmp)
	if err := os.WriteFile(tmp, []byte(vaultmcp.LinkScript), 0o700); err != nil {
		return err
	}
	return os.Rename(tmp, script)
}
