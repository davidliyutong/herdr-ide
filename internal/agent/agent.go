// Package agent implements herdr-ide-agent: the per-machine helper that the
// core reaches over a yamux session (ssh stdio for remote machines, an
// in-process pipe for the local machine).
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
	home      string
	base      string // ~/<brand.DataDir(instance)>
	runDir    string // base/run, mode 0700
	uploadDir string // base/uploads

	herdrMu      sync.Mutex
	herdrCache   map[string]string // hint -> resolved binary
	bundledHerdr string            // last resort when no installed herdr is found

	cs  *codeServer
	gui *gui
}

// YamuxConfig is shared by both ends of the session.
func YamuxConfig(logger *log.Logger) *yamux.Config {
	cfg := yamux.DefaultConfig()
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = 15 * time.Second
	cfg.ConnectionWriteTimeout = 30 * time.Second
	cfg.MaxStreamWindowSize = 1 << 20
	cfg.AcceptBacklog = 512
	cfg.LogOutput = nil
	cfg.Logger = logger
	return cfg
}

// Options configure an agent.
type Options struct {
	// Instance selects ~/<brand.DataDir(Instance)>; empty is the default.
	Instance string
	Logger   *log.Logger
	// BundledHerdr is the herdr shipped beside the core, used by the local
	// agent only when no installed herdr is found. Remote agents leave it empty.
	BundledHerdr string
}

// Serve runs the agent over conn until the session ends.
func Serve(ctx context.Context, conn io.ReadWriteCloser, opts Options) error {
	logger := opts.Logger
	if logger == nil {
		logger = log.New(os.Stderr, brand.AgentBin+": ", log.LstdFlags)
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
	go housekeeping(base, logger)

	sess, err := yamux.Server(conn, YamuxConfig(logger))
	if err != nil {
		return err
	}
	a := &Agent{
		sess:         sess,
		logger:       logger,
		home:         home,
		base:         base,
		runDir:       runDir,
		uploadDir:    filepath.Join(base, "uploads"),
		herdrCache:   map[string]string{},
		bundledHerdr: opts.BundledHerdr,
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
	go a.serveBridge(ctx)

	for {
		st, err := sess.AcceptStream()
		if err != nil {
			if errors.Is(err, io.EOF) || sess.IsClosed() {
				return nil
			}
			return err
		}
		go a.handle(ctx, st)
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
		err = agentproto.WriteLine(st, agentproto.Reply{OK: true, Info: a.info(h)})
		st.Close()
	case agentproto.OpHerdrAPI:
		err = a.handleHerdrAPI(st, h)
	case agentproto.OpTerm:
		err = a.handleTerm(ctx, st, h)
	case agentproto.OpExec:
		err = a.handleExec(ctx, st, h)
	case agentproto.OpFsStat, agentproto.OpFsList, agentproto.OpFsRead, agentproto.OpFsWrite:
		err = a.handleFS(st, h)
	case agentproto.OpDialUnix:
		err = a.handleDialUnix(st, h)
	case agentproto.OpCodeServer:
		err = a.cs.handle(ctx, st, h)
	case agentproto.OpGUI:
		err = a.gui.handle(ctx, st, h)
	default:
		err = agentproto.Fail(st, fmt.Errorf("unknown op %q", h.Op))
		st.Close()
	}
	if err != nil && !isClosedErr(err) {
		a.logger.Printf("op %s: %v", h.Op, err)
	}
}

func (a *Agent) info(h agentproto.Header) *agentproto.Info {
	hostname, _ := os.Hostname()
	username := os.Getenv("USER")
	if u, err := user.Current(); err == nil && u.Username != "" {
		username = u.Username
	}
	inf := &agentproto.Info{
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
	bin, err := a.resolveHerdr(h.HerdrBin)
	if err != nil {
		inf.HerdrError = err.Error()
		return inf
	}
	inf.HerdrBin = bin
	inf.HerdrSocket = a.herdrSocket(h.Session)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if out, err := runOutput(ctx, bin, "--version"); err == nil {
		inf.HerdrVersion = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(out), "herdr"))
	}
	return inf
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

func (a *Agent) handleHerdrAPI(st net.Conn, h agentproto.Header) error {
	defer st.Close()
	path := a.herdrSocket(h.Session)
	c, err := net.DialTimeout("unix", path, 5*time.Second)
	if err != nil {
		return agentproto.Fail(st, fmt.Errorf("herdr socket %s: %w", path, err))
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
