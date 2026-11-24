//go:build unix

// Package agent implements the agent: the per-machine helper that the core
// reaches over a yamux session, served by the machine's node (the command
// "node" of the one binary, node.go) on its socket, which ssh reaches
// through `node dial`. It runs on Linux and macOS only (every file is built
// for unix): its sockets, peer checks, process groups, code-server and
// program windows (Xvfb) are POSIX.
package agent

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"veldr/internal/brand"

	"github.com/hashicorp/yamux"

	"veldr/internal/agentproto"
	"veldr/internal/hostdirs"
)

// Agent is a machine's agent for one instance: what the agent sessions of
// a node share (its code-server, displays, sockets, terminal core), each
// session serving the streams of one core (Serve).
type Agent struct {
	logger    *log.Logger
	instance  string
	home      string
	base      string // ~/<brand.DataDir(instance)>, shared by hosts sharing the home
	hostDir   string // base/hosts/<host key>: this host's own files (hostdirs)
	runDir    string // host-local runtime directory, mode 0700 (hostdirs.RunDir)
	uploadDir string // base/uploads

	hcOp     sync.Mutex // serializes installing, starting and stopping herdr-core
	hcMu     sync.Mutex
	hcHashed hcHashed // the installed executable when it was last hashed

	privacyMu sync.Mutex // one Full Disk Access check at a time

	cs  *codeServer
	gui *gui

	// stop ends what the agent runs for all its sessions (its sockets,
	// housekeeping), which running counts.
	stop    context.CancelFunc
	ctx     context.Context
	running sync.WaitGroup

	sessMu   sync.Mutex
	sessions map[*session]struct{}
	sessSeq  uint64
}

// session is one core's agent session.
type session struct {
	ys *yamux.Session
	// id numbers the agent's sessions; client names the core (its
	// process), the same for its sessions after reconnects.
	id      uint64
	client  string
	sshConn string // SSH_CONNECTION of the ssh session the core came through
	// csPipes counts the session's open connections to code-server, csLast
	// is when it last opened one (Unix nanoseconds).
	csPipes atomic.Int32
	csLast  atomic.Int64
}

// Options configure an agent.
type Options struct {
	// Instance selects ~/<brand.DataDir(Instance)>; empty is the default.
	Instance string
	Logger   *log.Logger
	// SSHConnection is SSH_CONNECTION of the ssh session the core reached
	// the machine through, which hello reports; empty for the local machine.
	SSHConnection string
	// Client names the core of a session (agentproto.NodeHello.Client).
	Client string
}

// dataDirs returns the instance's directories on this host, made private
// (the run directory holds sockets with no other authentication; they
// stay private even if they existed with looser permissions).
func dataDirs(instance string) (hostdirs.Dirs, error) {
	d, err := hostdirs.For(instance)
	if err != nil {
		return d, err
	}
	return d, d.Make()
}

// Serve runs an agent of its own over conn until the session ends: the
// agent of one session (the tests'). A node's sessions share one agent
// (NewAgent, Agent.Serve).
func Serve(ctx context.Context, conn io.ReadWriteCloser, opts Options) error {
	a, err := NewAgent(opts)
	if err != nil {
		return err
	}
	defer a.Close()
	return a.Serve(ctx, conn, opts.Client, opts.SSHConnection)
}

// NewAgent prepares the instance's data directory and starts what the
// agent runs for every session: its sockets, housekeeping and the vault's
// MCP link. Close ends them.
func NewAgent(opts Options) (*Agent, error) {
	logger := opts.Logger
	if logger == nil {
		logger = log.New(os.Stderr, brand.CoreBin+" agent: ", log.LstdFlags)
	}
	dirs, err := dataDirs(opts.Instance)
	if err != nil {
		return nil, err
	}
	ctx, stop := context.WithCancel(context.Background())
	a := &Agent{
		logger:    logger,
		instance:  opts.Instance,
		home:      dirs.Home,
		base:      dirs.Base,
		hostDir:   dirs.Host,
		runDir:    dirs.Run,
		uploadDir: filepath.Join(dirs.Base, "uploads"),
		ctx:       ctx,
		stop:      stop,
		sessions:  map[*session]struct{}{},
	}
	a.cs = newCodeServer(a)
	a.gui = newGUI(a)
	a.spawn(func() { a.housekeep(ctx) })
	a.spawn(func() { a.serveBridge(ctx) })
	a.spawn(func() { a.serveVault(ctx) })
	a.spawn(a.linkMCP)
	return a, nil
}

// spawn runs f, which Close waits for.
func (a *Agent) spawn(f func()) {
	a.running.Add(1)
	go func() {
		defer a.running.Done()
		f()
	}()
}

// Close ends what the agent runs, waiting at most handlerDrain, so it is
// done (a socket was removed) before the process may exit, and stops the
// code-server it started.
func (a *Agent) Close() {
	a.stop()
	waitAtMost(&a.running, handlerDrain)
	a.cs.stopAll()
}

// Serve serves one core's session over conn until it ends: the core's
// process is client (empty when unknown) and it came through the ssh
// session sshConn (SSH_CONNECTION; empty for the local machine).
func (a *Agent) Serve(ctx context.Context, conn io.ReadWriteCloser, client, sshConn string) error {
	ys, err := yamux.Server(conn, agentproto.YamuxConfig(a.logger))
	if err != nil {
		return err
	}
	a.sessMu.Lock()
	a.sessSeq++
	s := &session{ys: ys, id: a.sessSeq, client: client, sshConn: sshConn}
	a.sessions[s] = struct{}{}
	a.sessMu.Unlock()
	defer func() {
		a.sessMu.Lock()
		delete(a.sessions, s)
		a.sessMu.Unlock()
	}()
	// The session's requests are waited for when it ends, at most
	// handlerDrain, so they are done (a save or an upload removed what it
	// staged).
	var running sync.WaitGroup
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-ctx.Done():
		case <-a.ctx.Done():
		}
		ys.Close()
	}()
	for {
		st, err := ys.AcceptStream()
		if err != nil {
			ended := errors.Is(err, io.EOF) || ys.IsClosed()
			// The requests still running fail with their streams.
			cancel()
			ys.Close()
			waitAtMost(&running, handlerDrain)
			if ended {
				return nil
			}
			return err
		}
		running.Add(1)
		go func() {
			defer running.Done()
			a.handle(ctx, s, st)
		}()
	}
}

// drain tells the cores of the agent's sessions that the node next serves
// the instance now (OpNodeDrain), after giving it the code-server.
func (a *Agent) drain(next int) {
	a.cs.handOver(next)
	for _, s := range a.liveSessions() {
		go func() {
			st, err := s.ys.OpenStream()
			if err != nil {
				return
			}
			defer st.Close()
			_ = st.SetDeadline(time.Now().Add(15 * time.Second))
			if agentproto.WriteLine(st, agentproto.Header{Op: agentproto.OpNodeDrain}) == nil {
				var rep agentproto.Reply
				_ = agentproto.ReadLine(st, &rep)
			}
		}()
	}
}

// live reports whether the session's connection is open (a session
// without one stands for a core in tests).
func (s *session) live() bool { return s.ys == nil || !s.ys.IsClosed() }

// otherUses reports whether a session other than s has a connection to
// code-server open.
func (a *Agent) otherUses(s *session) bool {
	for _, o := range a.liveSessions() {
		if o != s && o.csPipes.Load() > 0 {
			return true
		}
	}
	return false
}

// liveSessions returns the agent's sessions, oldest first.
func (a *Agent) liveSessions() []*session {
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	list := make([]*session, 0, len(a.sessions))
	for s := range a.sessions {
		if s.live() {
			list = append(list, s)
		}
	}
	slices.SortFunc(list, func(x, y *session) int { return cmp.Compare(x.id, y.id) })
	return list
}

// handlerDrain is how long Serve waits, once its session ended, for its
// requests to end, and Close for what the agent runs.
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

func (a *Agent) handle(ctx context.Context, s *session, st net.Conn) {
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
		err = agentproto.WriteLine(st, agentproto.Reply{OK: true, Info: a.info(), SSH: s.sshConn})
		st.Close()
	case agentproto.OpFsStat, agentproto.OpFsList, agentproto.OpFsRead, agentproto.OpFsWrite:
		err = a.handleFS(st, h)
	case agentproto.OpFsArchive:
		err = a.handleArchive(st, h)
	case agentproto.OpDialUnix:
		err = a.handleDialUnix(s, st, h)
	case agentproto.OpCodeServer:
		err = a.cs.handle(ctx, s, st, h)
	case agentproto.OpGUI:
		err = a.gui.handle(ctx, s, st, h)
	case agentproto.OpHC:
		err = a.handleHC(ctx, st, h)
	case agentproto.OpHCAPI:
		err = a.pipeUnix(st, a.hcSocket())
	case agentproto.OpDetect:
		err = a.handleDetect(ctx, st, h)
	case agentproto.OpPrivacy:
		err = a.handlePrivacy(ctx, st)
	case agentproto.OpPlugin:
		err = a.handlePlugin(ctx, s, st, h)
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

func (a *Agent) handleDialUnix(s *session, st net.Conn, h agentproto.Header) error {
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
	// Connections to code-server keep it for the session (codeServer.release)
	// and lead the VS Code bridge's connections to it (serveBridge).
	if path == a.cs.socket() {
		s.csPipes.Add(1)
		s.csLast.Store(time.Now().UnixNano())
		defer s.csPipes.Add(-1)
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
