package agent

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"herdr-ide/internal/brand"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"herdr-ide/internal/agentproto"
)

// codeServer installs and supervises code-server. Releases are shared by all
// instances (~/<brand.DataDirName>/code-server/<version>); the process,
// settings and extensions belong to the instance. It only ever listens on a
// unix socket in the private run directory. A release is either pushed by the
// core or downloaded by the machine; alternatively a code-server already
// installed on the machine is used (Header.Bin).
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
	stopProcessGroup(p.Pid)
	os.Remove(c.pidPath())
	os.Remove(c.socket())
}

// stopProcessGroup terminates the process group pid belongs to (code-server is
// started with Setpgid, so this includes its helpers), or only pid when that
// group is the agent's own; it waits up to 5 s before SIGKILL.
func stopProcessGroup(pid int) {
	if pid <= 1 || pid == os.Getpid() || !processAlive(pid) {
		return
	}
	target := pid
	if pg, err := syscall.Getpgid(pid); err == nil && pg > 1 && pg != syscall.Getpgrp() {
		target = -pg
	}
	_ = syscall.Kill(target, syscall.SIGTERM)
	for i := 0; i < 50 && processAlive(pid); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if processAlive(pid) {
		_ = syscall.Kill(target, syscall.SIGKILL)
	}
}

// serves reports whether the process on the socket serves VS Code's
// workbench. A code-server whose installation was moved or deleted still
// accepts connections (and answers /healthz) but returns 404 for every page.
func (c *codeServer) serves() bool {
	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", c.socket())
		}},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Get("http://localhost/")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode < 400
}

// replace stops whatever listens on the socket: the recorded process, or
// else the socket's peer (a code-server this agent has no pid file for).
func (c *codeServer) replace() {
	if p, ok := c.readPid(); ok && processAlive(p.Pid) {
		c.kill(p)
		return
	}
	killListener(c.socket())
	os.Remove(c.pidPath())
	os.Remove(c.socket())
}

// killListener stops the process listening on a unix socket, if any.
func killListener(path string) {
	conn, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		return
	}
	pid, err := peerPid(conn.(*net.UnixConn))
	conn.Close()
	if err == nil {
		stopProcessGroup(pid)
	}
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

// binFor returns the code-server executable a request refers to: the
// release in the agent's directory, or an installed one (Header.Bin).
func (c *codeServer) binFor(h agentproto.Header) (string, error) {
	if h.Bin == "" {
		bin := c.bin(h.Version)
		if !isExecutable(bin) {
			return "", errors.New("code-server is not installed")
		}
		return bin, nil
	}
	if h.Bin != "auto" {
		p := h.Bin
		if strings.HasPrefix(p, "~/") {
			p = filepath.Join(c.a.home, p[2:])
		}
		if !filepath.IsAbs(p) {
			return "", fmt.Errorf("code-server path %q is not absolute", h.Bin)
		}
		if !isExecutable(p) {
			return "", fmt.Errorf("%s is not an executable", p)
		}
		return p, nil
	}
	// The agent's PATH comes from a non-interactive ssh session, so also look
	// where the install script, Homebrew and distribution packages put it.
	if p, err := exec.LookPath("code-server"); err == nil {
		return p, nil
	}
	dirs := []string{filepath.Join(c.a.home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"}
	for _, d := range dirs {
		if p := filepath.Join(d, "code-server"); isExecutable(p) {
			return p, nil
		}
	}
	return "", fmt.Errorf("no code-server on PATH or in %s", strings.Join(dirs, ", "))
}

func (c *codeServer) status(h agentproto.Header) *agentproto.CSStatus {
	st := &agentproto.CSStatus{Version: h.Version, Socket: c.socket()}
	if bin, err := c.binFor(h); err == nil {
		st.Installed = true
		st.Bin = bin
	} else if h.Bin != "" {
		st.Error = err.Error()
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
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, CS: c.status(h)})
	case "download":
		digest, err := c.download(ctx, h)
		if err != nil {
			return agentproto.Fail(st, err)
		}
		cs := c.status(h)
		cs.Digest = digest
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, CS: cs})
	case "install":
		if err := agentproto.WriteLine(st, agentproto.Reply{OK: true}); err != nil {
			return err
		}
		err := c.install(h.Version, &agentproto.ChunkReader{R: st})
		if err != nil {
			return agentproto.Fail(st, err)
		}
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, CS: c.status(h)})
	case "start":
		if err := c.start(ctx, h); err != nil {
			return agentproto.Fail(st, err)
		}
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, CS: c.status(h)})
	case "stop":
		c.stop()
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, CS: c.status(h)})
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
		bin, err := c.binFor(h)
		if err != nil {
			return agentproto.Fail(st, err)
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

// download fetches a release tarball with the machine's curl or wget (so
// its proxy and CA settings apply), verifies it and installs it. It returns
// the tarball's SHA-256.
func (c *codeServer) download(ctx context.Context, h agentproto.Header) (string, error) {
	u, err := url.Parse(h.URL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", fmt.Errorf("bad download URL %q", h.URL)
	}
	if err := os.MkdirAll(c.root(), 0o755); err != nil {
		return "", err
	}
	// Below root(), so a file left by a crash goes with the old-version cleanup.
	f, err := os.CreateTemp(c.root(), ".download-*")
	if err != nil {
		return "", err
	}
	f.Close()
	defer os.Remove(f.Name())
	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	var cmd *exec.Cmd
	if p, err := exec.LookPath("curl"); err == nil {
		cmd = exec.CommandContext(ctx, p, "-fsSL", "--retry", "2", "-o", f.Name(), h.URL)
	} else if p, err := exec.LookPath("wget"); err == nil {
		cmd = exec.CommandContext(ctx, p, "-q", "-O", f.Name(), h.URL)
	} else {
		return "", errors.New("neither curl nor wget is available on the machine")
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("download %s: %v %s", h.URL, err, lastN(string(out), 400))
	}
	r, err := os.Open(f.Name())
	if err != nil {
		return "", err
	}
	defer r.Close()
	sum := sha256.New()
	if _, err := io.Copy(sum, r); err != nil {
		return "", err
	}
	got := hex.EncodeToString(sum.Sum(nil))
	if h.Digest != "" && got != h.Digest {
		return "", fmt.Errorf("%s: sha256 %s does not match expected %s", h.URL, got, h.Digest)
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	if err := c.install(h.Version, r); err != nil {
		return "", err
	}
	return got, nil
}

func (c *codeServer) baseArgs() []string {
	return []string{"--user-data-dir", c.dataDir(), "--extensions-dir", c.extDir()}
}

// serveArgs are the arguments of the code-server process.
func (c *codeServer) serveArgs() []string {
	return append([]string{
		"--socket", c.socket(), "--socket-mode", "600",
		"--auth", "none",
		// The port proxy (/proxy/<port>/, /absproxy/<port>/) would serve
		// whatever listens on the machine with the UI's origin.
		"--disable-proxy",
		"--disable-telemetry", "--disable-update-check",
		"--disable-workspace-trust", "--disable-getting-started-override",
		"--ignore-last-opened",
		"--reconnection-grace-time", strconv.Itoa(csGraceSeconds),
		"--idle-timeout-seconds", strconv.Itoa(csIdleSeconds),
	}, c.baseArgs()...)
}

func (c *codeServer) start(ctx context.Context, h agentproto.Header) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.alive() {
		if c.serves() {
			// Adopt a running process whose owner is gone so that it is
			// still stopped eventually.
			if p, ok := c.readPid(); ok && !processAlive(p.Owner) {
				p.Owner = os.Getpid()
				c.writePid(p)
			}
			return nil
		}
		c.a.logger.Printf("the code-server on %s does not serve VS Code (moved or deleted installation?); replacing it", c.socket())
		c.replace()
	}
	if p, ok := c.readPid(); ok {
		c.kill(p) // stale or hung
	}
	bin, err := c.binFor(h)
	if err != nil {
		return err
	}
	if h.Bin == "" {
		now := time.Now()
		_ = os.Chtimes(c.dir(h.Version), now, now) // in use: keep it in cleanups
	}
	os.Remove(c.socket())
	for _, d := range []string{c.dataDir(), c.extDir()} {
		os.MkdirAll(d, 0o700)
	}
	cmd := exec.Command(bin, c.serveArgs()...)
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
	c.writePid(csPid{Pid: cmd.Process.Pid, Owner: os.Getpid(), Version: h.Version, Started: time.Now().Unix()})
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
	bin, err := c.binFor(h)
	if err != nil {
		return "", err
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
	err = cmd.Run()
	return out.String(), err
}
