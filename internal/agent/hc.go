package agent

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
	"herdr-ide/internal/hc"
)

// The agent's own herdr-core: an executable the core uploads, and one
// terminal core per instance in a session of its own, so it shares neither
// terminals nor state with a herdr-core the user runs. The terminal core
// belongs to the user's account, not to the agent: it and its programs keep
// running when the agent exits, until the stop action.

const (
	hcBinName = "herdr-core"
	// hcMaxBinary bounds an uploaded executable (releases are about 7 MB).
	hcMaxBinary = 64 << 20
)

// hcHashed caches the digest of the installed executable.
type hcHashed struct {
	size   int64
	mtime  time.Time
	digest string
}

func (a *Agent) hcDir() string { return filepath.Join(a.base, "hc") }
func (a *Agent) hcBin() string { return filepath.Join(a.hcDir(), hcBinName) }

// hcSession names the terminal core: herdr-core keeps a core, its terminals
// and its state per session name.
func (a *Agent) hcSession() string {
	if a.instance == "" {
		return brand.Slug
	}
	return brand.Slug + "-" + a.instance
}

// hcSocket is the terminal core's API socket, in the private run directory;
// its holders' sockets sit beside it.
func (a *Agent) hcSocket() string { return filepath.Join(a.runDir, "hc.sock") }

// hcEnv is the environment of a herdr-core command: the agent's, selecting
// the session and socket, without the variables that would make it act for a
// terminal the agent itself was started in.
func (a *Agent) hcEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		switch name {
		case "HC_SESSION", "HC_SOCKET", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET":
		default:
			env = append(env, kv)
		}
	}
	return append(env, "HC_SESSION="+a.hcSession(), "HC_SOCKET="+a.hcSocket())
}

// hcDigest returns the SHA-256 of the installed executable, "" without one.
func (a *Agent) hcDigest() string {
	info, err := os.Lstat(a.hcBin())
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0o100 == 0 {
		return ""
	}
	a.hcMu.Lock()
	defer a.hcMu.Unlock()
	if c := a.hcHashed; c.digest != "" && c.size == info.Size() && c.mtime.Equal(info.ModTime()) {
		return c.digest
	}
	f, err := os.Open(a.hcBin())
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, io.LimitReader(f, hcMaxBinary+1)); err != nil {
		return ""
	}
	a.hcHashed = hcHashed{size: info.Size(), mtime: info.ModTime(), digest: hex.EncodeToString(h.Sum(nil))}
	return a.hcHashed.digest
}

func (a *Agent) hcStatus(ctx context.Context) *agentproto.HCStatus {
	st := &agentproto.HCStatus{Digest: a.hcDigest(), Session: a.hcSession(), Socket: a.hcSocket()}
	c, err := net.DialTimeout("unix", st.Socket, 2*time.Second)
	if err != nil {
		return st
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if hello, err := hc.Probe(ctx, c); err == nil {
		st.Running, st.Version = true, hello.Version
	}
	return st
}

// hcInstall writes the gzip-compressed executable read from r, checks its
// digest and swaps it in whole, as herdr-core's own update does: a running
// core and its holders keep the executable they started from.
func (a *Agent) hcInstall(digest string, r io.Reader) error {
	if !validDigest(digest) {
		return errors.New("bad digest")
	}
	if a.hcDigest() == digest {
		_, err := io.Copy(io.Discard, r)
		return err
	}
	dir := a.hcDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if ents, err := os.ReadDir(dir); err == nil {
		for _, e := range ents { // installs that did not finish
			if info, err := e.Info(); err == nil && strings.HasPrefix(e.Name(), ".fetch-") && time.Since(info.ModTime()) > stagingRetention {
				os.Remove(filepath.Join(dir, e.Name()))
			}
		}
	}
	zr, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".fetch-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(zr, hcMaxBinary+1))
	if err == nil {
		err = f.Chmod(0o700)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if n > hcMaxBinary {
		return errors.New("executable too large")
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != digest {
		return fmt.Errorf("sha256 %s does not match expected %s", got, digest)
	}
	return os.Rename(f.Name(), a.hcBin())
}

// hcRun runs the installed herdr-core with args for the agent's session.
func (a *Agent) hcRun(ctx context.Context, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, a.hcBin(), args...)
	cmd.Env = a.hcEnv()
	cmd.Dir = a.home
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, truncateText(strings.TrimSpace(string(out)), 2000))
	}
	return nil
}

func truncateText(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func (a *Agent) handleHC(ctx context.Context, st net.Conn, h agentproto.Header) error {
	defer st.Close()
	fail := func(code string, err error) error {
		return agentproto.WriteLine(st, agentproto.Reply{Error: err.Error(), Code: code, HC: a.hcStatus(ctx)})
	}
	if h.Action == "status" {
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, HC: a.hcStatus(ctx)})
	}
	a.hcOp.Lock()
	defer a.hcOp.Unlock()
	switch h.Action {
	case "install":
		if err := agentproto.WriteLine(st, agentproto.Reply{OK: true}); err != nil {
			return err
		}
		if err := a.hcInstall(h.Digest, &agentproto.ChunkReader{R: st}); err != nil {
			return fail(agentproto.HCBadDigest, err)
		}
	case "start":
		// The core answers at once when one is running; herdr-core starts
		// it detached from the agent (a user service or launchd job).
		if a.hcDigest() == "" {
			return fail(agentproto.HCNotInstalled, errors.New("herdr-core is not installed"))
		}
		if err := a.hcRun(ctx, "server", "start", "--json"); err != nil {
			return fail(agentproto.HCStartFailed, err)
		}
		// herdr-core relies on the socket's directory for privacy (the run
		// directory is 0700); the socket itself is made private as well.
		_ = os.Chmod(a.hcSocket(), 0o600)
	case "restart":
		// The core's successor adopts the programs: they keep running.
		if a.hcDigest() == "" {
			return fail(agentproto.HCNotInstalled, errors.New("herdr-core is not installed"))
		}
		if err := a.hcRun(ctx, "server", "restart", "--json"); err != nil {
			return fail(agentproto.HCStartFailed, err)
		}
		_ = os.Chmod(a.hcSocket(), 0o600)
	case "stop":
		// Ends the session's programs.
		if a.hcDigest() == "" {
			return fail(agentproto.HCNotInstalled, errors.New("herdr-core is not installed"))
		}
		if err := a.hcRun(ctx, "server", "stop", "--json"); err != nil {
			return fail(agentproto.HCStopFailed, err)
		}
	default:
		return agentproto.Fail(st, fmt.Errorf("hc: unknown action %q", h.Action))
	}
	return agentproto.WriteLine(st, agentproto.Reply{OK: true, HC: a.hcStatus(ctx)})
}
