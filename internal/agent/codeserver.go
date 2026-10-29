package agent

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"webherdr/internal/brand"

	"webherdr/internal/agentproto"
)

// codeServer installs and supervises code-server. Releases are shared by all
// instances (~/<brand.DataDirName>/code-server/<version>); the process,
// settings and extensions belong to the instance. It only ever listens on a
// unix socket in the private run directory.
//
// Ownership and reclamation: run/cs.pid records which agent started the
// process. An agent stops the process it owns when it exits or when the core
// asks (idle timeout); a process whose owner is gone (agent killed) is
// adopted or reaped by the next agent. code-server itself also exits after
// --idle-timeout-seconds without connections, as a last resort.
type codeServer struct {
	a  *Agent
	mu sync.Mutex
}

// Process limits passed to code-server.
const (
	csGraceSeconds = 300  // keep a disconnected window's extension host 5 min
	csIdleSeconds  = 3600 // code-server exits by itself after 1 h unused
)

type csPid struct {
	Pid     int    `json:"pid"`
	Owner   int    `json:"owner"`
	Version string `json:"version"`
	Started int64  `json:"started"`
}

func newCodeServer(a *Agent) *codeServer {
	c := &codeServer{a: a}
	c.reapOrphan()
	return c
}

func (c *codeServer) root() string {
	return filepath.Join(c.a.home, brand.DataDirName, "code-server")
}
func (c *codeServer) pidPath() string     { return filepath.Join(c.a.runDir, "cs.pid") }
func (c *codeServer) dir(v string) string { return filepath.Join(c.root(), v) }
func (c *codeServer) socket() string      { return filepath.Join(c.a.runDir, "cs.sock") }
func (c *codeServer) dataDir() string     { return filepath.Join(c.a.base, "cs-data") }
func (c *codeServer) extDir() string      { return filepath.Join(c.a.base, "cs-ext") }
func (c *codeServer) bin(v string) string {
	return filepath.Join(c.dir(v), "bin", "code-server")
}

func processAlive(pid int) bool {
	return pid > 0 && syscall.Kill(pid, 0) == nil
}

func (c *codeServer) readPid() (csPid, bool) {
	var p csPid
	b, err := os.ReadFile(c.pidPath())
	if err != nil || json.Unmarshal(b, &p) != nil {
		return p, false
	}
	return p, true
}

func (c *codeServer) writePid(p csPid) {
	b, _ := json.Marshal(p)
	_ = os.WriteFile(c.pidPath(), b, 0o600)
}

// kill terminates the process group recorded in the pid file.
func (c *codeServer) kill(p csPid) {
	if processAlive(p.Pid) {
		_ = syscall.Kill(-p.Pid, syscall.SIGTERM)
		for i := 0; i < 50 && processAlive(p.Pid); i++ {
			time.Sleep(100 * time.Millisecond)
		}
		if processAlive(p.Pid) {
			_ = syscall.Kill(-p.Pid, syscall.SIGKILL)
		}
	}
	os.Remove(c.pidPath())
	os.Remove(c.socket())
}

// reapOrphan stops a code-server whose owning agent no longer exists.
func (c *codeServer) reapOrphan() {
	c.mu.Lock()
	defer c.mu.Unlock()
	p, ok := c.readPid()
	if !ok || processAlive(p.Owner) {
		return
	}
	if processAlive(p.Pid) {
		c.a.logger.Printf("stopping orphaned code-server pid %d (owner %d gone)", p.Pid, p.Owner)
	}
	c.kill(p)
}

// stop terminates code-server (explicit request or idle timeout).
func (c *codeServer) stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if p, ok := c.readPid(); ok {
		c.kill(p)
	}
}

// stopAll runs when the agent exits: only a process this agent owns is
// stopped, so another core's session on the same machine keeps working.
func (c *codeServer) stopAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if p, ok := c.readPid(); ok && p.Owner == os.Getpid() {
		c.kill(p)
	}
}

func (c *codeServer) alive() bool {
	conn, err := net.DialTimeout("unix", c.socket(), time.Second)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func (c *codeServer) status(v string) *agentproto.CSStatus {
	st := &agentproto.CSStatus{Version: v, Socket: c.socket()}
	if isExecutable(c.bin(v)) {
		st.Installed = true
	}
	st.Running = c.alive()
	return st
}

func (c *codeServer) handle(ctx context.Context, st net.Conn, h agentproto.Header) error {
	defer st.Close()
	if h.Version == "" || strings.ContainsAny(h.Version, "/\\") || strings.Contains(h.Version, "..") {
		return agentproto.Fail(st, errors.New("code-server: bad version"))
	}
	switch h.Action {
	case "status":
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, CS: c.status(h.Version)})
	case "install":
		if err := agentproto.WriteLine(st, agentproto.Reply{OK: true}); err != nil {
			return err
		}
		err := c.install(h.Version, &agentproto.ChunkReader{R: st})
		if err != nil {
			return agentproto.Fail(st, err)
		}
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, CS: c.status(h.Version)})
	case "start":
		if err := c.start(ctx, h.Version); err != nil {
			return agentproto.Fail(st, err)
		}
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, CS: c.status(h.Version)})
	case "stop":
		c.stop()
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, CS: c.status(h.Version)})
	case "install-ext":
		// Args are extension ids; with Path set, the stream carries a vsix
		// (chunked) that is installed from a temporary file.
		if err := agentproto.WriteLine(st, agentproto.Reply{OK: true}); err != nil {
			return err
		}
		out, err := c.installExt(ctx, h, st)
		if err != nil {
			return agentproto.Fail(st, fmt.Errorf("%v: %s", err, lastN(out, 600)))
		}
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, Exec: &agentproto.ExecResult{Stdout: lastN(out, 2000)}})
	case "uninstall-ext":
		bin := c.bin(h.Version)
		if !isExecutable(bin) {
			return agentproto.Fail(st, errors.New("code-server is not installed"))
		}
		args := c.baseArgs()
		for _, id := range h.Args {
			args = append(args, "--uninstall-extension", id)
		}
		// Not installed is fine; the result is informational.
		cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		out, _ := exec.CommandContext(cctx, bin, args...).CombinedOutput()
		cancel()
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, Exec: &agentproto.ExecResult{Stdout: lastN(string(out), 2000)}})
	case "marker":
		// Path names a marker file below the extensions dir (used to remember
		// which bridge build is installed). Args[0]=="set" creates it.
		p := filepath.Join(c.extDir(), filepath.Base(h.Path))
		if len(h.Args) > 0 && h.Args[0] == "set" {
			os.MkdirAll(c.extDir(), 0o755)
			if err := os.WriteFile(p, nil, 0o644); err != nil {
				return agentproto.Fail(st, err)
			}
		}
		_, err := os.Stat(p)
		return agentproto.WriteLine(st, agentproto.Reply{OK: err == nil})
	}
	return agentproto.Fail(st, fmt.Errorf("code-server: unknown action %q", h.Action))
}

func lastN(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return "…" + s[len(s)-n:]
	}
	return s
}

// install extracts a code-server release tarball (top-level directory
// stripped) into code-server/<version> atomically.
func (c *codeServer) install(version string, r io.Reader) error {
	if err := os.MkdirAll(c.root(), 0o755); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(c.root(), ".install-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	zr, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	tr := tar.NewReader(zr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := filepath.Clean(hdr.Name)
		// Strip the top-level code-server-<v>-<os>-<arch>/ directory.
		if i := strings.IndexByte(name, '/'); i >= 0 {
			name = name[i+1:]
		} else {
			continue
		}
		if name == "" || strings.HasPrefix(name, "..") || filepath.IsAbs(name) {
			continue
		}
		dst := filepath.Join(tmp, name)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode)&0o755|0o600)
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			if err := f.Close(); err != nil {
				return err
			}
		case tar.TypeSymlink:
			// Only relative links that stay inside the install directory.
			target := filepath.Join(filepath.Dir(dst), hdr.Linkname)
			if filepath.IsAbs(hdr.Linkname) || !strings.HasPrefix(target, tmp+string(os.PathSeparator)) {
				continue
			}
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return err
			}
			if err := os.Symlink(hdr.Linkname, dst); err != nil {
				return err
			}
		}
	}
	// Drain the chunk framing terminator.
	io.Copy(io.Discard, r)
	if !isExecutable(filepath.Join(tmp, "bin", "code-server")) {
		return errors.New("tarball does not contain bin/code-server")
	}
	// The bundled node must run here (old glibc is the usual failure).
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if out, err := runOutput(ctx, filepath.Join(tmp, "lib", "node"), "--version"); err != nil {
		return fmt.Errorf("code-server's node cannot run on this machine (glibc too old?): %v %s", err, out)
	}
	final := c.dir(version)
	os.RemoveAll(final)
	if err := os.Rename(tmp, final); err != nil {
		return err
	}
	// Other versions may belong to other cores; drop those unused for a while.
	if ents, err := os.ReadDir(c.root()); err == nil {
		cutoff := time.Now().Add(-versionRetention)
		for _, e := range ents {
			info, err := e.Info()
			if err != nil || e.Name() == version || info.ModTime().After(cutoff) {
				continue
			}
			os.RemoveAll(filepath.Join(c.root(), e.Name()))
		}
	}
	return nil
}

func (c *codeServer) baseArgs() []string {
	return []string{"--user-data-dir", c.dataDir(), "--extensions-dir", c.extDir()}
}

func (c *codeServer) start(ctx context.Context, version string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.alive() {
		// Adopt a running process whose owner is gone so that it is still
		// stopped eventually.
		if p, ok := c.readPid(); ok && !processAlive(p.Owner) {
			p.Owner = os.Getpid()
			c.writePid(p)
		}
		return nil
	}
	if p, ok := c.readPid(); ok {
		c.kill(p) // stale or hung
	}
	bin := c.bin(version)
	now := time.Now()
	_ = os.Chtimes(c.dir(version), now, now) // in use: keep it in cleanups
	if !isExecutable(bin) {
		return errors.New("code-server is not installed")
	}
	os.Remove(c.socket())
	for _, d := range []string{c.dataDir(), c.extDir()} {
		os.MkdirAll(d, 0o700)
	}
	args := append([]string{
		"--socket", c.socket(), "--socket-mode", "600",
		"--auth", "none",
		"--disable-telemetry", "--disable-update-check",
		"--disable-workspace-trust", "--disable-getting-started-override",
		"--ignore-last-opened",
		"--reconnection-grace-time", strconv.Itoa(csGraceSeconds),
		"--idle-timeout-seconds", strconv.Itoa(csIdleSeconds),
	}, c.baseArgs()...)
	cmd := exec.Command(bin, args...)
	// The bridge extension finds the agent's socket through this variable.
	cmd.Env = append(cleanEnv(), "VSCODE_PROXY_URI=", brand.Env("BRIDGE_SOCKET")+"="+filepath.Join(c.a.runDir, "bridge.sock"))
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	logPath := filepath.Join(c.a.base, "code-server.log")
	if lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err == nil {
		cmd.Stdout = lf
		cmd.Stderr = lf
		defer lf.Close()
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	c.writePid(csPid{Pid: cmd.Process.Pid, Owner: os.Getpid(), Version: version, Started: time.Now().Unix()})
	exited := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		exited <- err // buffered: start() may hold c.mu while waiting
		// Remove the pid file only if it still describes this process.
		c.mu.Lock()
		if p, ok := c.readPid(); ok && p.Pid == cmd.Process.Pid {
			os.Remove(c.pidPath())
		}
		c.mu.Unlock()
	}()
	deadline := time.After(90 * time.Second)
	for {
		if c.alive() {
			return nil
		}
		select {
		case err := <-exited:
			b, _ := os.ReadFile(logPath)
			return fmt.Errorf("code-server exited: %v: %s", err, lastN(string(b), 800))
		case <-deadline:
			return errors.New("code-server did not start within 90s (see " + logPath + ")")
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (c *codeServer) installExt(ctx context.Context, h agentproto.Header, st net.Conn) (string, error) {
	bin := c.bin(h.Version)
	if !isExecutable(bin) {
		return "", errors.New("code-server is not installed")
	}
	var targets []string
	if h.Path != "" {
		f, err := os.CreateTemp("", brand.Slug+"-*.vsix")
		if err != nil {
			return "", err
		}
		defer os.Remove(f.Name())
		if _, err := io.Copy(f, &agentproto.ChunkReader{R: st}); err != nil {
			f.Close()
			return "", err
		}
		f.Close()
		targets = append(targets, f.Name())
	}
	targets = append(targets, h.Args...)
	if len(targets) == 0 {
		return "", errors.New("nothing to install")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	args := c.baseArgs()
	for _, t := range targets {
		args = append(args, "--install-extension", t)
	}
	args = append(args, "--force")
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = cleanEnv()
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}
