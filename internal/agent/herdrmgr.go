package agent

// Managing the herdr in use from the UI (docs/features/17): the copy of the
// bundled herdr the application keeps, the session's server, and updates
// through herdr's own updater.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
)

// herdrManifestURL is herdr's stable-channel update manifest, the one
// `herdr update` reads (a variable for tests).
var herdrManifestURL = "https://herdr.dev/latest.json"

var herdrVersionRe = regexp.MustCompile(`^\d+\.\d+\.\d+([.+-][0-9A-Za-z.+-]*)?$`)

// managedHerdrDir holds the managed copy and the log of servers started
// from the UI. It is shared by all instances, like herdr's own state.
func (a *Agent) managedHerdrDir() string {
	return filepath.Join(a.home, brand.DataDir(""), "herdr")
}

func (a *Agent) managedHerdrPath() string { return filepath.Join(a.managedHerdrDir(), "herdr") }

// managedHerdr returns the copy of the bundled herdr that the application
// keeps outside its release directory, which may be a signed app bundle and
// must not change. A newer bundled herdr (after an application upgrade)
// replaces the copy; herdr's own updater replaces it in place. Without a
// bundled herdr an existing copy is still used. "" when there is neither.
func (a *Agent) managedHerdr() string {
	path := a.managedHerdrPath()
	have := isExecutable(path)
	if a.bundledHerdr == "" || !isExecutable(a.bundledHerdr) {
		if have {
			return path
		}
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if have && !versionLess(herdrVersion(ctx, path), herdrVersion(ctx, a.bundledHerdr)) {
		return path
	}
	if err := copyExecutable(a.bundledHerdr, path); err != nil {
		a.logger.Printf("keeping a copy of the bundled herdr: %v", err)
		return a.bundledHerdr
	}
	return path
}

func copyExecutable(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".herdr-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o755); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}

// herdrCommand runs herdr without the pane context of a herdr the core may
// itself run in.
func (a *Agent) herdrCommand(ctx context.Context, bin string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = cleanEnv()
	cmd.Dir = a.home
	return cmd
}

func herdrVersion(ctx context.Context, bin string) string {
	cmd := exec.CommandContext(ctx, bin, "--version")
	cmd.Env = cleanEnv()
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(out)), "herdr"))
}

// versionLess compares the numeric major.minor.patch of two versions;
// anything after them, and unparsable parts, count as equal or zero.
func versionLess(a, b string) bool {
	pa, pb := versionParts(a), versionParts(b)
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] < pb[i]
		}
	}
	return false
}

func versionParts(v string) [3]int {
	var out [3]int
	for i, part := range strings.SplitN(strings.TrimPrefix(v, "v"), ".", 3) {
		end := 0
		for end < len(part) && part[end] >= '0' && part[end] <= '9' {
			end++
		}
		out[i], _ = strconv.Atoi(part[:end])
	}
	return out
}

// serverState is what listens on a session's herdr socket.
type serverState int

const (
	serverAbsent       serverState = iota // no socket, or nothing listening
	serverOurs                            // a process of this user
	serverForeign                         // another user's process
	serverUnresponsive                    // a listener that takes no connections
)

// socketPeer reports the process at the other end of a unix connection (a
// variable for tests).
var socketPeer = peerCred

var (
	errForeignServer = errors.New("another user's process listens on the herdr socket")
	errUnresponsive  = errors.New("the herdr socket takes no connections")
)

// probeServer tells what listens on socket. Only a missing socket or a
// refused connection mean that no server runs: a listener whose backlog is
// full (EAGAIN on Linux) or that times out may be a hung server that still
// owns its panes, and must not be replaced.
// A peer that is not identified, which on macOS also happens when the
// listener closed the connection first, counts as another user's after a
// few tries.
func probeServer(socket string) serverState {
	for try := 0; ; try++ {
		c, err := net.DialTimeout("unix", socket, 200*time.Millisecond)
		if err != nil {
			return dialState(err)
		}
		_, uid, err := socketPeer(c.(*net.UnixConn))
		c.Close()
		switch {
		case err == nil && uid == os.Getuid():
			return serverOurs
		case err == nil || try == 2:
			return serverForeign
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func dialState(err error) serverState {
	switch {
	case errors.Is(err, syscall.ENOENT), errors.Is(err, syscall.ENOTDIR), errors.Is(err, syscall.ECONNREFUSED):
		return serverAbsent
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM):
		return serverForeign
	}
	return serverUnresponsive
}

// probeErr is the error for a state in which nothing may be started or
// stopped, nil otherwise.
func probeErr(st serverState) error {
	switch st {
	case serverForeign:
		return errForeignServer
	case serverUnresponsive:
		return errUnresponsive
	}
	return nil
}

func (a *Agent) herdrStatus(ctx context.Context, h agentproto.Header) *agentproto.HerdrStatus {
	st := &agentproto.HerdrStatus{}
	bin, err := a.resolveHerdr(h.HerdrBin)
	if err != nil {
		// herdr was removed or moved, or never installed: a server started
		// before still runs (its executable stays open) and keeps its panes,
		// but nothing can start, stop or restart it here.
		st.Error = "not_found"
		st.Running = probeServer(a.herdrSocket(h.Session)) == serverOurs
		return st
	}
	st.Bin = bin
	st.Managed = bin == a.managedHerdrPath()
	st.Version = herdrVersion(ctx, bin)
	// herdr reports a stopped server in JSON too; its exit status is not used.
	out, _ := a.herdrCommand(ctx, bin, herdrArgs(h.Session, "status", "server", "--json")...).Output()
	var server struct {
		Running       bool    `json:"running"`
		Version       *string `json:"version"`
		RestartNeeded bool    `json:"restart_needed"`
	}
	if json.Unmarshal(out, &server) == nil {
		st.Running = server.Running
		if server.Version != nil {
			st.ServerVersion = *server.Version
		}
		st.RestartNeeded = server.RestartNeeded
	} else {
		st.Running = probeServer(a.herdrSocket(h.Session)) == serverOurs
	}
	return st
}

// startHerdrServer starts the session's server detached from the core, as
// the herdr TUI does: it belongs to the user and outlives the application.
// Its output goes to a log replaced at every start; herdr keeps its own logs.
func (a *Agent) startHerdrServer(ctx context.Context, bin, session string) (string, error) {
	socket := a.herdrSocket(session)
	switch st := probeServer(socket); st {
	case serverOurs:
		return "", nil
	case serverForeign, serverUnresponsive:
		return "", probeErr(st)
	}
	if err := os.MkdirAll(a.managedHerdrDir(), 0o700); err != nil {
		return "", err
	}
	logPath := filepath.Join(a.managedHerdrDir(), "server.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC|os.O_APPEND, 0o600)
	if err != nil {
		return "", err
	}
	cmd := exec.Command(bin, herdrArgs(session, "server")...)
	cmd.Env = cleanEnv()
	cmd.Dir = a.home
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	err = cmd.Start()
	logFile.Close()
	if err != nil {
		return "", err
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	// The server leads its own session and process group: a server that
	// did not come up is ended with what it started.
	kill := func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case err := <-exited:
			if probeServer(socket) == serverOurs { // another client started the server first
				return "", nil
			}
			return fileTail(logPath), fmt.Errorf("herdr server exited: %v", err)
		case <-tick.C:
			switch probeServer(socket) {
			case serverOurs:
				return "", nil
			case serverForeign:
				kill()
				return "", errForeignServer
			}
		case <-deadline.C:
			kill()
			return fileTail(logPath), errors.New("herdr server did not open its socket within 15 s")
		case <-ctx.Done():
			kill()
			return "", ctx.Err()
		}
	}
}

// startHerdr starts the session's server and, on Linux, keeps the display
// while it runs, since its panes may use it. It returns an error code and
// herdr's output.
func (a *Agent) startHerdr(ctx context.Context, bin, session string) (code, output string) {
	out, err := a.startHerdrServer(ctx, bin, session)
	if err != nil {
		return probeCode(err, "start_failed"), joinOutput(out, err)
	}
	if runtime.GOOS == "linux" {
		if err := a.gui.keep(session); err != nil {
			a.logger.Printf("gui: keeping the display: %v", err)
		}
	}
	return "", ""
}

// probeCode is the status code for err: the probe's own codes, else code.
func probeCode(err error, code string) string {
	switch {
	case errors.Is(err, errForeignServer):
		return "foreign_server"
	case errors.Is(err, errUnresponsive):
		return "server_unresponsive"
	}
	return code
}

// herdrStopTimeout bounds `herdr server stop`, which waits for a server that
// may hang; herdrStopWait is how long a restart waits for the stopped
// server's socket to go away (variables for tests).
var (
	herdrStopTimeout = 30 * time.Second
	herdrStopWait    = 10 * time.Second
)

// restartHerdr stops the session's server, if this user's server runs, and
// starts one. A server that is not running is only started (herdr's stop
// fails without one); nothing is started after a failed stop, or while the
// socket belongs to another user or takes no connections.
func (a *Agent) restartHerdr(ctx context.Context, bin, session string) (code, output string) {
	socket := a.herdrSocket(session)
	switch st := probeServer(socket); st {
	case serverForeign, serverUnresponsive:
		return probeCode(probeErr(st), ""), ""
	case serverOurs:
		if out, err := a.stopHerdrServer(ctx, bin, session); err != nil {
			return probeCode(err, "stop_failed"), joinOutput(out, err)
		}
		// herdr's stop returns once the server has exited; one that still
		// answered would turn the start into a no-op.
		deadline := time.Now().Add(herdrStopWait)
		for probeServer(socket) != serverAbsent {
			if time.Now().After(deadline) {
				return "stop_failed", "herdr server still answers after stop"
			}
			select {
			case <-ctx.Done():
				return "stop_failed", ctx.Err().Error()
			case <-time.After(100 * time.Millisecond):
			}
		}
	}
	return a.startHerdr(ctx, bin, session)
}

// stopHerdrServer runs herdr's stop for the session's server, but sends
// nothing to a socket of another user.
func (a *Agent) stopHerdrServer(ctx context.Context, bin, session string) (string, error) {
	if st := probeServer(a.herdrSocket(session)); st == serverForeign {
		return "", errForeignServer
	}
	ctx, cancel := context.WithTimeout(ctx, herdrStopTimeout)
	defer cancel()
	var out tailBuffer
	cmd := a.herdrCommand(ctx, bin, herdrArgs(session, "server", "stop")...)
	cmd.Stdout, cmd.Stderr = &out, &out
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		err = fmt.Errorf("herdr server stop did not return within %s", herdrStopTimeout)
	}
	return out.String(), err
}

// updateHerdr runs herdr's own updater on the managed copy: it verifies the
// download against the digest in herdr's manifest, replaces the copy and
// hands running servers over to the new build where herdr supports it.
func (a *Agent) updateHerdr(ctx context.Context, bin string) (string, error) {
	var out tailBuffer
	cmd := a.herdrCommand(ctx, bin, "update", "--handoff")
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return out.String(), err
}

func latestHerdr(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, herdrManifestURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: %s", herdrManifestURL, resp.Status)
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&manifest); err != nil {
		return "", err
	}
	if !herdrVersionRe.MatchString(manifest.Version) {
		return "", fmt.Errorf("invalid version %q in %s", manifest.Version, herdrManifestURL)
	}
	return manifest.Version, nil
}

func fileTail(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	var tail tailBuffer
	_, _ = io.Copy(&tail, f)
	return strings.TrimSpace(tail.String())
}

func joinOutput(out string, err error) string {
	return strings.TrimSpace(strings.TrimSpace(out) + "\n" + err.Error())
}

func (a *Agent) handleHerdr(ctx context.Context, st net.Conn, h agentproto.Header) error {
	defer st.Close()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	switch h.Action {
	case "status", "check", "start", "stop", "restart", "update":
	default:
		return agentproto.Fail(st, fmt.Errorf("unknown herdr action %q", h.Action))
	}
	// An update can take longer than the core waits for a first reply; the
	// result follows as a second line.
	if err := agentproto.WriteLine(st, agentproto.Reply{OK: true}); err != nil {
		return err
	}
	var code, output, latest string
	switch h.Action {
	case "status":
	case "check":
		v, err := latestHerdr(ctx)
		if err != nil {
			code, output = "check_failed", err.Error()
		}
		latest = v
	case "start", "stop", "restart", "update":
		a.herdrOp.Lock()
		defer a.herdrOp.Unlock()
		bin, err := a.resolveHerdr(h.HerdrBin)
		if err != nil {
			code = "not_found"
			break
		}
		switch h.Action {
		case "start":
			code, output = a.startHerdr(ctx, bin, h.Session)
		case "stop":
			if out, err := a.stopHerdrServer(ctx, bin, h.Session); err != nil {
				code, output = probeCode(err, "stop_failed"), joinOutput(out, err)
			}
		case "restart":
			code, output = a.restartHerdr(ctx, bin, h.Session)
		case "update":
			if bin != a.managedHerdrPath() {
				code = "not_managed"
			} else if out, err := a.updateHerdr(ctx, bin); err != nil {
				code, output = "update_failed", joinOutput(out, err)
			} else {
				output = strings.TrimSpace(out)
			}
		}
	}
	status := a.herdrStatus(ctx, h)
	status.Latest = latest
	if code != "" {
		status.Error = code
	}
	status.Output = output
	return agentproto.WriteLine(st, agentproto.Reply{OK: true, Herdr: status})
}
