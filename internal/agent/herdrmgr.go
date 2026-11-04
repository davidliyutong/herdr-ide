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

func dialable(socket string) bool {
	c, err := net.DialTimeout("unix", socket, 200*time.Millisecond)
	if err == nil {
		c.Close()
	}
	return err == nil
}

func (a *Agent) herdrStatus(ctx context.Context, h agentproto.Header) *agentproto.HerdrStatus {
	st := &agentproto.HerdrStatus{}
	bin, err := a.resolveHerdr(h.HerdrBin)
	if err != nil {
		st.Error = "not_found"
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
		st.Running = dialable(a.herdrSocket(h.Session))
	}
	return st
}

// startHerdrServer starts the session's server detached from the core, as
// the herdr TUI does: it belongs to the user and outlives the application.
// Its output goes to a log replaced at every start; herdr keeps its own logs.
func (a *Agent) startHerdrServer(ctx context.Context, bin, session string) (string, error) {
	socket := a.herdrSocket(session)
	if dialable(socket) {
		return "", nil
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
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case err := <-exited:
			if dialable(socket) { // another client started the server first
				return "", nil
			}
			return fileTail(logPath), fmt.Errorf("herdr server exited: %v", err)
		case <-tick.C:
			if dialable(socket) {
				return "", nil
			}
		case <-deadline.C:
			_ = cmd.Process.Kill()
			return fileTail(logPath), errors.New("herdr server did not open its socket within 15 s")
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			return "", ctx.Err()
		}
	}
}

func (a *Agent) stopHerdrServer(ctx context.Context, bin, session string) (string, error) {
	var out tailBuffer
	cmd := a.herdrCommand(ctx, bin, herdrArgs(session, "server", "stop")...)
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
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
	case "status", "check", "start", "stop", "update":
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
	case "start", "stop", "update":
		a.herdrOp.Lock()
		defer a.herdrOp.Unlock()
		bin, err := a.resolveHerdr(h.HerdrBin)
		if err != nil {
			code = "not_found"
			break
		}
		switch h.Action {
		case "start":
			if out, err := a.startHerdrServer(ctx, bin, h.Session); err != nil {
				code, output = "start_failed", joinOutput(out, err)
			} else if runtime.GOOS == "linux" {
				// Its panes may use the display: keep it while it runs.
				if err := a.gui.keep(h.Session); err != nil {
					a.logger.Printf("gui: keeping the display: %v", err)
				}
			}
		case "stop":
			if out, err := a.stopHerdrServer(ctx, bin, h.Session); err != nil {
				code, output = "stop_failed", joinOutput(out, err)
			}
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
