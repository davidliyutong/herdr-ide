//go:build unix

// Package agent implements the agent (the command "agent" of the one
// binary): the per-machine helper that the
// core reaches over a yamux session (ssh stdio for remote machines, an
// in-process pipe for the local machine). It runs on Linux and macOS only
// (every file is built for unix): its sockets, peer checks, process groups,
// code-server and program windows (Xvfb) are POSIX.
package agent

import (
	"context"
	"errors"
	"fmt"
	"herdr-ide/internal/brand"
	"io"
	"log"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/yamux"

	"herdr-ide/internal/agentproto"
)

// Agent serves streams opened by the core.
type Agent struct {
	sess      *yamux.Session
	logger    *log.Logger
	instance  string
	home      string
	base      string // ~/<brand.DataDir(instance)>
	runDir    string // base/run, mode 0700
	uploadDir string // base/uploads

	hcOp     sync.Mutex // serializes installing, starting and stopping herdr-core
	hcMu     sync.Mutex
	hcHashed hcHashed // the installed executable when it was last hashed

	privacyMu sync.Mutex // one Full Disk Access check at a time

	cs  *codeServer
	gui *gui
}

// Options configure an agent.
type Options struct {
	// Instance selects ~/<brand.DataDir(Instance)>; empty is the default.
	Instance string
	Logger   *log.Logger
}

// Serve runs the agent over conn until the session ends.
func Serve(ctx context.Context, conn io.ReadWriteCloser, opts Options) error {
	logger := opts.Logger
	if logger == nil {
		logger = log.New(os.Stderr, brand.CoreBin+" agent: ", log.LstdFlags)
	}
	if !brand.ValidInstance(opts.Instance) {
		return fmt.Errorf("invalid instance name %q", opts.Instance)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	base := filepath.Join(home, brand.DataDir(opts.Instance))
	if opts.Instance == "" {
		migrateLegacyDataDir(home, base, logger)
	}
	runDir := filepath.Join(base, "run")
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		return err
	}
	// The run directory holds sockets with no other authentication; keep it
	// private even if it already existed with looser permissions.
	_ = os.Chmod(base, 0o700)
	_ = os.Chmod(runDir, 0o700)
	// What the agent runs (requests, its sockets, housekeeping) is waited
	// for when the session ends, at most handlerDrain, so it is done (a
	// save or an upload removed what it staged, a socket was removed)
	// before the process may exit.
	var running sync.WaitGroup
	spawn := func(f func()) {
		running.Add(1)
		go func() {
			defer running.Done()
			f()
		}()
	}
	spawn(func() { housekeeping(base, logger) })

	sess, err := yamux.Server(conn, agentproto.YamuxConfig(logger))
	if err != nil {
		return err
	}
	a := &Agent{
		sess:      sess,
		logger:    logger,
		instance:  opts.Instance,
		home:      home,
		base:      base,
		runDir:    runDir,
		uploadDir: filepath.Join(base, "uploads"),
	}
	a.cs = newCodeServer(a)
	defer a.cs.stopAll()
	a.gui = newGUI(a)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		<-ctx.Done()
		sess.Close()
	}()
	spawn(func() { a.serveBridge(ctx) })
	spawn(func() { a.serveVault(ctx) })
	spawn(a.linkMCP)

	for {
		st, err := sess.AcceptStream()
		if err != nil {
			ended := errors.Is(err, io.EOF) || sess.IsClosed()
			// The requests still running fail with their streams, the
			// sockets close with the context.
			cancel()
			sess.Close()
			waitAtMost(&running, handlerDrain)
			if ended {
				return nil
			}
			return err
		}
		spawn(func() { a.handle(ctx, st) })
	}
}

// handlerDrain is how long Serve waits, once its session ended, for what
// it runs (requests, its sockets, housekeeping) to end.
const handlerDrain = 5 * time.Second

// waitAtMost waits for wg at most d, and reports whether it ended.
func waitAtMost(wg *sync.WaitGroup, d time.Duration) bool {
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-done:
		return true
	case <-t.C:
		return false
	}
}

func (a *Agent) handle(ctx context.Context, st net.Conn) {
	var h agentproto.Header
	_ = st.SetReadDeadline(time.Now().Add(30 * time.Second))
	if err := agentproto.ReadLine(st, &h); err != nil {
		st.Close()
		return
	}
	_ = st.SetReadDeadline(time.Time{})
	var err error
	switch h.Op {
	case agentproto.OpHello:
		err = agentproto.WriteLine(st, agentproto.Reply{OK: true, Info: a.info(), SSH: os.Getenv("SSH_CONNECTION")})
		st.Close()
	case agentproto.OpFsStat, agentproto.OpFsList, agentproto.OpFsRead, agentproto.OpFsWrite:
		err = a.handleFS(st, h)
	case agentproto.OpFsArchive:
		err = a.handleArchive(st, h)
	case agentproto.OpDialUnix:
		err = a.handleDialUnix(st, h)
	case agentproto.OpCodeServer:
		err = a.cs.handle(ctx, st, h)
	case agentproto.OpGUI:
		err = a.gui.handle(ctx, st, h)
	case agentproto.OpHC:
		err = a.handleHC(ctx, st, h)
	case agentproto.OpHCAPI:
		err = a.pipeUnix(st, a.hcSocket())
	case agentproto.OpDetect:
		err = a.handleDetect(ctx, st, h)
	case agentproto.OpPrivacy:
		err = a.handlePrivacy(ctx, st)
	case agentproto.OpPlugin:
		err = a.handlePlugin(ctx, st, h)
	default:
		err = agentproto.Fail(st, fmt.Errorf("unknown op %q", h.Op))
		st.Close()
	}
	if err != nil && !isClosedErr(err) {
		a.logger.Printf("op %s: %v", h.Op, err)
	}
}

func (a *Agent) info() *agentproto.Info {
	hostname, _ := os.Hostname()
	username := os.Getenv("USER")
	if u, err := user.Current(); err == nil && u.Username != "" {
		username = u.Username
	}
	return &agentproto.Info{
		Version:   agentproto.Version,
		OS:        runtime.GOOS,
		Arch:      runtime.GOARCH,
		Hostname:  hostname,
		Home:      a.home,
		User:      username,
		DataDir:   a.base,
		RunDir:    a.runDir,
		UploadDir: a.uploadDir,
	}
}

// pipe copies in both directions and closes both ends when either side ends.
func pipe(a, b net.Conn) {
	var once sync.Once
	closeBoth := func() {
		a.Close()
		b.Close()
	}
	go func() {
		io.Copy(a, b)
		once.Do(closeBoth)
	}()
	io.Copy(b, a)
	once.Do(closeBoth)
}

// pipeUnix pipes the socket at path; the connection ends with the stream.
func (a *Agent) pipeUnix(st net.Conn, path string) error {
	defer st.Close()
	c, err := net.DialTimeout("unix", path, 5*time.Second)
	if err != nil {
		return agentproto.Fail(st, fmt.Errorf("socket %s: %w", path, err))
	}
	if err := agentproto.WriteLine(st, agentproto.Reply{OK: true}); err != nil {
		c.Close()
		return err
	}
	pipe(st, c)
	return nil
}

func (a *Agent) handleDialUnix(st net.Conn, h agentproto.Header) error {
	defer st.Close()
	// A bare name refers to a socket in the run directory.
	path := h.Path
	if !strings.ContainsRune(path, '/') {
		path = filepath.Join(a.runDir, path)
	}
	path, err := a.expand(path)
	if err != nil {
		return agentproto.Fail(st, err)
	}
	rel, err := filepath.Rel(a.runDir, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		return agentproto.Fail(st, fmt.Errorf("dial-unix: %s is outside %s", path, a.runDir))
	}
	c, err := net.DialTimeout("unix", path, 5*time.Second)
	if err != nil {
		return agentproto.Fail(st, err)
	}
	if err := agentproto.WriteLine(st, agentproto.Reply{OK: true}); err != nil {
		c.Close()
		return err
	}
	pipe(st, c)
	return nil
}

// expand resolves "~" and makes paths absolute relative to home.
func (a *Agent) expand(p string) (string, error) {
	if p == "" {
		return "", errors.New("empty path")
	}
	if p == "~" {
		return a.home, nil
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(a.home, p[2:]), nil
	}
	if !filepath.IsAbs(p) {
		return filepath.Join(a.home, p), nil
	}
	return filepath.Clean(p), nil
}

func isClosedErr(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) || errors.Is(err, yamux.ErrStreamClosed) ||
		errors.Is(err, yamux.ErrSessionShutdown) || errors.Is(err, yamux.ErrConnectionReset) {
		return true
	}
	s := err.Error()
	return strings.Contains(s, "broken pipe") || strings.Contains(s, "connection reset")
}
