//go:build unix

// Package chathost is the chat host: the long-lived process of a machine
// that runs coding agents headless, each through its adapter
// (internal/chatadapter), keeps what their conversations did in a journal
// (chat-<host>.db, SQLite: DBName) and serves them on a unix socket in the
// protocol of internal/chatproto.
//
// One host serves an instance of a machine: the socket chatproto.SocketName
// in the instance's run directory, taken under a lock of that directory, a
// socket nobody answers on replaced. It runs as a hidden terminal of the
// instance's terminal core, so neither ssh nor the machine's agent going
// away ends it. It ends when it is told to (chatproto.OpShutdown, for a host
// of another version to take over, refused while an agent works or waits),
// on a signal of the terminal core (SIGHUP, then SIGTERM, then SIGKILL), or
// when it has had no agent process and no connection for a minute; the
// chats stay in the journal, and their agents resume their sessions by id
// at the next prompt. A host that has not ended chatproto.StopGrace after
// it began to stop kills its agents' groups and exits (Options.Exit).
//
// Full access (chatproto.HostSettings.AllowFull) is off until a configure
// of the host's own process allows it; once it is off, a chat whose agent
// runs with it starts its agent again in the default mode, and an agent
// that takes it by itself is set back. A session another process runs (a
// terminal's, chatadapter.Running) is neither resumed nor imported.
//
// A chat is a conversation with one agent session. Its agent process runs
// while the chat is used: it is ended once the chat was idle for the
// settings' IdleStopMinutes (the chat sleeps), and when more agents would
// run than MaxLive (the one idle the longest sleeps). What runs is the
// machine's to decide: requests name agent kinds (internal/agentkinds),
// whose Chat spec gives the command, looked up in the PATH of the user's
// login shell, and the agents get that shell's environment without the
// variables of the host's terminal, of ssh and of the agents' own sessions.
//
// The journal keeps every stored event of every chat, within the settings'
// bounds: a chat's events beyond MaxChatBytes go oldest first; beyond
// MaxTotalBytes, MaxChats and RetentionDays the oldest closed chats go
// first. The agents' own session files are never touched.
package chathost

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
	"herdr-ide/internal/store"
)

const (
	// requestTimeout is how long a connection has to send its request, and
	// to take the answer.
	requestTimeout = 10 * time.Second
	// dialTimeout is how long a host that starts waits for one that may
	// serve the socket already.
	dialTimeout = time.Second
	// maxConns is the number of connections served at a time.
	maxConns = 256
	// maxProbes is the number of session listings that may run at a time,
	// and maxCalls the number of commands one attached connection may have
	// waiting for an agent.
	maxProbes = 4
	maxCalls  = 8
	// maxKinds is the most kinds OpAgents asks about.
	maxKinds = 64
	// maxDiscard is how much of a line that is too long is read before the
	// answer that says so, for the answer to reach a client still writing.
	maxDiscard = 4 * chatproto.MaxLine
	// stopFlush is how long the attached connections have to take the end
	// of their chats when the host stops.
	stopFlush = 2 * time.Second
	// enforceBytes is how many bytes of events are written between two
	// checks of the journal's bounds; they are checked every hour besides.
	enforceBytes = 1 << 20
)

// ErrRunning is Serve's error when another host serves the run directory's
// socket.
var ErrRunning = errors.New("chathost: another chat host serves the socket")

// Options configure Serve.
type Options struct {
	// Base is the instance's data directory on the machine: the journal is
	// this host's DBName in it (store.HostFile).
	Base string
	// Run is the instance's run directory, which exists and is the user's
	// alone (0700). The host serves chatproto.SocketName in it.
	Run string
	// Logger gets the host's log; none without.
	Logger *log.Logger
	// Signals are the signals the terminal core sends to end the host
	// (SIGHUP, SIGTERM, SIGINT): on the first, every agent's process group
	// gets SIGTERM and the adapters end their agents; what is left gets
	// SIGKILL at the next signal, or killAfter later at the latest, and
	// Serve returns.
	Signals <-chan os.Signal
	// Exit, when set, ends the process of a host that has not ended
	// chatproto.StopGrace after it began to stop (something of it hangs):
	// its children's process groups are killed, and Exit(1) is called.
	Exit func(code int)

	// The host's times, which tests shorten; each is its default when 0.
	// idleExit: how long the host stays without an agent process and a
	// connection (60 s). startTimeout: how long an agent has to make its
	// session or list its sessions (60 s). callTimeout: how long an agent
	// has to answer a command (30 s). closeGrace: how long an adapter has
	// to end its agent gracefully (10 s). killAfter: how long the agents
	// have after SIGTERM on a signal (300 ms). minute: the unit of
	// IdleStopMinutes (1 min). day: the unit of RetentionDays (24 h).
	// enforceEvery: how often the journal's bounds are checked (1 h).
	// infoDelay: how long changes of a chat its adapter states wait to be
	// told together (250 ms). stopDeadline: how long after it began to stop
	// a host is ended by Exit (chatproto.StopGrace).
	idleExit, startTimeout, callTimeout, closeGrace, killAfter, minute, day, enforceEvery, infoDelay, stopDeadline time.Duration
	// settings replaces the settings, not clamped, until a configure;
	// onHost is told the host (tests).
	settings *chatproto.HostSettings
	onHost   func(*host)
	// environ replaces the login shell that tells the user's environment,
	// kinds the registry of agent kinds and adapters the adapters' (tests).
	environ  func(context.Context) []string
	kinds    func(string) (*agentkinds.ChatSpec, bool)
	adapters func(string) (chatadapter.Adapter, bool)
}

func or(d, def time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return def
}

// host is a chat host that serves.
type host struct {
	o         Options
	logger    *log.Logger
	env       *environment
	j         *journal
	probes    chan struct{} // a place for each session listing
	startedAt time.Time

	// ctx ends when the host stops: with it end the starts and calls that
	// wait.
	ctx      context.Context
	cancel   context.CancelFunc
	quit     chan struct{} // closed to make Serve return
	once     sync.Once
	stopping atomic.Bool
	fast     atomic.Bool    // the host stops on a signal of the terminal core
	wg       sync.WaitGroup // the goroutines of connections and chats

	settings atomic.Pointer[chatproto.HostSettings]
	written  atomic.Int64 // bytes of events written since the last check of the bounds

	// newMu makes a chat's check of the session it resumes and its entry
	// in chats one step: two chats never take up one session.
	newMu sync.Mutex

	mu    sync.Mutex
	chats map[string]*chat
	// conns are the connections served, true for one attached to a chat
	// or watching: that one ends when it wrote what it still had.
	conns      map[net.Conn]bool
	quietSince time.Time // since when no agent and no connection; zero otherwise
	quietTimer *time.Timer

	room sync.Mutex // one start at a time makes room among MaxLive

	// wmu guards the watchers and states: the state each chat's watchers
	// were told last (its last broadcast), what a watcher that comes is
	// told first.
	wmu      sync.Mutex
	watchers map[*subscriber]struct{}
	states   map[string]chatproto.ChatState

	// pmu guards ending: the sessions whose agents are being ended.
	pmu    sync.Mutex
	ending map[chatadapter.Session]struct{}

	poke    chan struct{} // the host's quiet may have changed
	enforce chan struct{} // the journal's bounds are to be checked
	ended   chan struct{} // a session was ended
}

// Serve runs a chat host on the socket of o.Run until ctx ends, a client
// asks it to stop, a signal of o.Signals comes, or it had neither an agent
// process nor a connection for a minute. It returns ErrRunning without
// serving when another host answers on the socket, and replaces a socket
// nobody listens on. Before it returns, every agent is ended and the
// socket removed.
func Serve(ctx context.Context, o Options) error {
	if !filepath.IsAbs(o.Base) || !filepath.IsAbs(o.Run) {
		return errors.New("chathost: the data and run directories must be absolute paths")
	}
	o.idleExit = or(o.idleExit, 60*time.Second)
	o.startTimeout = or(o.startTimeout, 60*time.Second)
	o.callTimeout = or(o.callTimeout, 30*time.Second)
	o.closeGrace = or(o.closeGrace, 10*time.Second)
	o.killAfter = or(o.killAfter, 300*time.Millisecond)
	o.minute = or(o.minute, time.Minute)
	o.day = or(o.day, 24*time.Hour)
	o.enforceEvery = or(o.enforceEvery, time.Hour)
	o.infoDelay = or(o.infoDelay, 250*time.Millisecond)
	o.stopDeadline = or(o.stopDeadline, chatproto.StopGrace)
	if o.kinds == nil {
		o.kinds = func(id string) (*agentkinds.ChatSpec, bool) {
			k, ok := agentkinds.ByID(id)
			return k.Chat, ok && k.Chat != nil
		}
	}
	if o.adapters == nil {
		o.adapters = chatadapter.Lookup
	}
	h := &host{
		o: o, logger: o.Logger,
		probes:    make(chan struct{}, maxProbes),
		startedAt: time.Now().UTC(),
		quit:      make(chan struct{}),
		chats:     map[string]*chat{},
		conns:     map[net.Conn]bool{},
		watchers:  map[*subscriber]struct{}{},
		states:    map[string]chatproto.ChatState{},
		ending:    map[chatadapter.Session]struct{}{},
		poke:      make(chan struct{}, 1),
		enforce:   make(chan struct{}, 1),
		ended:     make(chan struct{}, 1),
	}
	if h.logger == nil {
		h.logger = log.New(io.Discard, "", 0)
	}
	h.env = &environment{logger: h.logger, lookup: o.environ}
	h.ctx, h.cancel = context.WithCancel(context.Background())
	if o.onHost != nil {
		o.onHost(h)
	}
	defer h.cancel()

	path := filepath.Join(o.Run, chatproto.SocketName)
	ln, ino, err := listen(o.Run, path)
	if err != nil {
		return err
	}
	removeSocket := func() {
		// The socket goes first: a host that starts now finds the path
		// free. It is removed only while it is this host's own.
		if cur, ok := inode(path); ok && cur == ino {
			os.Remove(path)
		}
	}
	if h.j, err = openJournal(o.Base); err != nil {
		ln.Close()
		removeSocket()
		return err
	}
	defer h.j.close()
	// The databases of other hosts of a shared home, and the one of before
	// they were named per host, once nobody used them for long.
	if removed, err := store.PruneHostFiles(o.Base, DBName, store.HostFileRetention, time.Now()); err != nil {
		h.logf("removing other hosts' journals: %v", err)
	} else if len(removed) > 0 {
		h.logf("removed the journals nobody used for %s: %v", store.HostFileRetention, removed)
	}
	// Full access is the core's to allow, in this process: a host does not
	// take it from what an earlier one stored.
	settings := h.j.settings()
	settings.AllowFull = false
	settings = settings.Clamp()
	if o.settings != nil {
		settings = *o.settings
	}
	h.settings.Store(&settings)
	if err := h.load(); err != nil {
		ln.Close()
		removeSocket()
		return err
	}
	h.logf("serving %s for %s (version %s, pid %d, %d chats)", path, o.Base, agentproto.Version, os.Getpid(), len(h.chats))

	h.wg.Go(func() { h.accept(ln) })
	h.wg.Go(h.loop)
	h.enforceSoon()
	h.pokeQuiet()

	fast := false
	select {
	case <-ctx.Done():
		h.logf("stopping: %v", context.Cause(ctx))
	case <-h.quit:
	case sig := <-o.Signals:
		h.logf("stopping: %v", sig)
		fast = true
		h.fast.Store(true)
	}
	h.stopping.Store(true)
	if o.Exit != nil {
		hard := time.AfterFunc(o.stopDeadline, func() {
			h.logf("did not stop within %s: its agents are killed, and it exits", o.stopDeadline)
			agentTargets(nil).signal(syscall.SIGKILL)
			o.Exit(1)
		})
		defer hard.Stop()
	}
	h.end("stopping")
	ln.Close()
	removeSocket()
	h.stopAgents(fast)
	h.cancel()

	h.mu.Lock()
	if h.quietTimer != nil {
		h.quietTimer.Stop()
	}
	for conn, attached := range h.conns {
		if attached {
			// It is told how its chat ended, if it reads that soon.
			conn.SetReadDeadline(time.Now().Add(stopFlush))
		} else {
			conn.Close()
		}
	}
	chats := h.list()
	h.mu.Unlock()
	for _, c := range chats {
		c.mu.Lock()
		// What the adapter changed last is stored now: no timer of the
		// chat writes once the journal is closed.
		if c.infoDirty && !c.deleted {
			c.emitInfo()
		}
		if c.infoTimer != nil {
			c.infoTimer.Stop()
			c.infoTimer = nil
		}
		c.stopped = true
		for s := range c.subs {
			s.finish()
		}
		c.mu.Unlock()
	}
	h.wmu.Lock()
	for s := range h.watchers {
		s.finish()
	}
	h.wmu.Unlock()
	h.wg.Wait()
	h.logf("stopped")
	return nil
}

func (h *host) logf(format string, args ...any) { h.logger.Printf(format, args...) }

// end makes Serve return.
func (h *host) end(why string) {
	h.once.Do(func() {
		h.logf("stopping: %s", why)
		close(h.quit)
	})
}

// listen makes the host's socket (0600) in the run directory. Hosts that
// start at the same time take turns, by a lock on the directory: the
// second one finds the first one's socket answering.
func listen(runDir, path string) (net.Listener, uint64, error) {
	dir, err := os.Open(runDir)
	if err != nil {
		return nil, 0, err
	}
	defer dir.Close() // and with it the lock
	st, err := dir.Stat()
	if err != nil {
		return nil, 0, err
	}
	if !st.IsDir() || st.Mode().Perm()&0o077 != 0 {
		return nil, 0, fmt.Errorf("chathost: %s is not a directory of the user alone (0700)", runDir)
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && int(sys.Uid) != os.Getuid() {
		return nil, 0, fmt.Errorf("chathost: %s is another user's", runDir)
	}
	if err := syscall.Flock(int(dir.Fd()), syscall.LOCK_EX); err != nil {
		return nil, 0, fmt.Errorf("chathost: lock %s: %w", runDir, err)
	}
	if st, err := os.Lstat(path); err == nil {
		if st.Mode()&os.ModeSocket == 0 {
			return nil, 0, fmt.Errorf("chathost: %s is not a socket", path)
		}
		conn, err := net.DialTimeout("unix", path, dialTimeout)
		if err == nil {
			conn.Close()
			return nil, 0, ErrRunning
		}
		if !errors.Is(err, syscall.ECONNREFUSED) && !errors.Is(err, syscall.ENOENT) {
			// Something listens there and does not take the connection.
			return nil, 0, fmt.Errorf("%w: %v", ErrRunning, err)
		}
		// Nobody listens: the socket of a host that was killed.
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, 0, err
		}
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, 0, err
	}
	// Removed by Serve, and only while it is this host's.
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		os.Remove(path)
		return nil, 0, err
	}
	ino, _ := inode(path)
	return ln, ino, nil
}

// inode is the inode of the file at path.
func inode(path string) (uint64, bool) {
	st, err := os.Lstat(path)
	if err != nil {
		return 0, false
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return uint64(sys.Ino), true
}

// load reads the journal's chats. A chat whose agent ran when the last
// host ended sleeps now: what waited was cancelled with it, and its turn
// ended in an error.
func (h *host) load() error {
	rows, err := h.j.loadChats()
	if err != nil {
		return err
	}
	for _, r := range rows {
		c := newChat(h, r)
		first, err := h.j.first(r.ID)
		if err != nil {
			return err
		}
		c.first = first
		if first == 0 {
			c.first = r.Seq + 1
		}
		ids, err := h.j.clientIDs(r.ID, maxClientIDs)
		if err != nil {
			return err
		}
		c.mu.Lock()
		for _, id := range ids {
			c.tookClient(id)
		}
		switch r.State {
		case chatproto.StateStarting, chatproto.StateIdle, chatproto.StateWorking, chatproto.StateWaiting:
			c.recover()
		default:
			c.rest = r.State
		}
		c.r.Status = chatproto.StatusOf(c.r.State, c.r.TurnEnd, c.r.Seen)
		c.lastState = c.r.StateOf()
		h.wmu.Lock()
		h.states[r.ID] = c.lastState
		h.wmu.Unlock()
		c.mu.Unlock()
		h.chats[r.ID] = c
	}
	return nil
}

// accept serves the connections until the listener is closed.
func (h *host) accept(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			// Out of file descriptors, as a rule: later there are some.
			h.logf("accept: %v", err)
			select {
			case <-h.quit:
				return
			case <-time.After(100 * time.Millisecond):
			}
			continue
		}
		h.mu.Lock()
		switch {
		case h.stopping.Load():
			h.mu.Unlock()
			conn.Close()
			continue
		case len(h.conns) >= maxConns:
			h.mu.Unlock()
			h.wg.Go(func() {
				defer conn.Close()
				if h.hello(conn) {
					h.reply(conn, refuse(chatproto.CodeTooMany, "too many connections"))
				}
			})
			continue
		}
		h.conns[conn] = false
		h.mu.Unlock()
		h.pokeQuiet()
		h.wg.Go(func() {
			h.serve(conn)
			conn.Close()
			h.mu.Lock()
			delete(h.conns, conn)
			h.mu.Unlock()
			h.pokeQuiet()
		})
	}
}

// pokeQuiet tells the loop that the host's quiet may have changed.
func (h *host) pokeQuiet() {
	select {
	case h.poke <- struct{}{}:
	default:
	}
}

// enforceSoon tells the loop to check the journal's bounds.
func (h *host) enforceSoon() {
	select {
	case h.enforce <- struct{}{}:
	default:
	}
}

// wrote counts bytes of events written, and has the journal's bounds
// checked after enforceBytes of them.
func (h *host) wrote(n int) {
	if h.written.Add(int64(n)) >= enforceBytes {
		h.written.Store(0)
		h.enforceSoon()
	}
}

// loop checks the host's quiet and the journal's bounds until the host
// stops.
func (h *host) loop() {
	t := time.NewTicker(h.o.enforceEvery)
	defer t.Stop()
	for {
		select {
		case <-h.quit:
			return
		case <-h.poke:
			h.checkQuiet()
		case <-h.enforce:
			h.enforceBounds()
		case <-t.C:
			h.enforceBounds()
		}
	}
}

// checkQuiet ends a host that had no agent process and no connection for
// idleExit.
func (h *host) checkQuiet() {
	live := h.liveAgents(nil) > 0
	h.pmu.Lock()
	live = live || len(h.ending) > 0
	h.pmu.Unlock()
	h.mu.Lock()
	defer h.mu.Unlock()
	if live || len(h.conns) > 0 || h.stopping.Load() {
		h.quietSince = time.Time{}
		if h.quietTimer != nil {
			h.quietTimer.Stop()
			h.quietTimer = nil
		}
		return
	}
	now := time.Now()
	if h.quietSince.IsZero() {
		h.quietSince = now
	}
	if wait := h.o.idleExit - now.Sub(h.quietSince); wait > 0 {
		if h.quietTimer == nil {
			h.quietTimer = time.AfterFunc(wait, func() {
				h.mu.Lock()
				h.quietTimer = nil
				h.mu.Unlock()
				h.pokeQuiet()
			})
		}
		return
	}
	h.end(fmt.Sprintf("no agent and no connection for %s", h.o.idleExit))
}

// list are the chats, the most recently updated first. The caller holds
// h.mu.
func (h *host) list() []*chat {
	chats := make([]*chat, 0, len(h.chats))
	for _, c := range h.chats {
		chats = append(chats, c)
	}
	return chats
}

// sorted are the chats as OpChats orders them, with their views.
func (h *host) sorted() ([]*chat, []chatproto.Chat) {
	h.mu.Lock()
	chats := h.list()
	h.mu.Unlock()
	views := make([]chatproto.Chat, len(chats))
	for i, c := range chats {
		views[i] = c.view()
	}
	idx := make([]int, len(chats))
	for i := range idx {
		idx[i] = i
	}
	sort.Slice(idx, func(a, b int) bool {
		x, y := &views[idx[a]], &views[idx[b]]
		if !x.Updated.Equal(y.Updated) {
			return x.Updated.After(y.Updated)
		}
		return x.ID < y.ID
	})
	outC := make([]*chat, len(chats))
	outV := make([]chatproto.Chat, len(chats))
	for i, k := range idx {
		outC[i], outV[i] = chats[k], views[k]
	}
	return outC, outV
}

// liveAgents counts the chats whose agent runs or starts, but not except.
func (h *host) liveAgents(except *chat) int {
	h.mu.Lock()
	chats := h.list()
	h.mu.Unlock()
	n := 0
	for _, c := range chats {
		if c == except {
			continue
		}
		c.mu.Lock()
		if c.sess != nil || c.starting {
			n++
		}
		c.mu.Unlock()
	}
	return n
}

// hello writes the host's first line.
func (h *host) hello(conn net.Conn) bool {
	return h.write(conn, chatproto.Hello{Host: chatproto.HostInfo{Proto: chatproto.Proto, Version: agentproto.Version, PID: os.Getpid()}})
}

// reply writes the answer to a request.
func (h *host) reply(conn net.Conn, res chatproto.Response) bool {
	return h.write(conn, res)
}

func (h *host) write(conn net.Conn, v any) bool {
	b, err := chatproto.Line(v)
	if err != nil || len(b) > chatproto.MaxLine+1 {
		b, _ = chatproto.Line(refuse(chatproto.CodeTooLarge, "the answer does not fit a line"))
	}
	conn.SetWriteDeadline(time.Now().Add(requestTimeout))
	_, err = conn.Write(b)
	return err == nil
}

func refuse(code, message string) chatproto.Response {
	return chatproto.Response{Error: &chatproto.Error{Code: code, Message: message}}
}

func refusal(e *chatproto.Error) chatproto.Response { return chatproto.Response{Error: e} }

func perr(code, message string) *chatproto.Error {
	return &chatproto.Error{Code: code, Message: message}
}

// errorOf is the protocol's error for an adapter's: its own when it is
// one, else CodeFailed.
func errorOf(err error) *chatproto.Error {
	if err == nil {
		return nil
	}
	var e *chatproto.Error
	switch {
	case errors.As(err, &e):
		return capStderr(e)
	case errors.Is(err, context.DeadlineExceeded):
		return perr(chatproto.CodeFailed, "the agent did not answer in time")
	case errors.Is(err, context.Canceled):
		return perr(chatproto.CodeEnded, "the chat ended")
	}
	return perr(chatproto.CodeFailed, err.Error())
}

// serve speaks the protocol on a connection: the hello, one request and its
// answer, and for an attach or a watch what follows.
func (h *host) serve(conn net.Conn) {
	if !h.hello(conn) {
		return
	}
	r := bufio.NewReaderSize(conn, 64<<10)
	conn.SetReadDeadline(time.Now().Add(requestTimeout))
	b, err := chatproto.ReadLine(r)
	if err == chatproto.ErrTooLarge {
		discard(r)
		h.reply(conn, refuse(chatproto.CodeTooLarge, "a line of more than 16 MiB"))
		return
	}
	if err != nil {
		return
	}
	conn.SetReadDeadline(time.Time{})
	var req chatproto.Request
	if err := json.Unmarshal(b, &req); err != nil {
		h.reply(conn, refuse(chatproto.CodeBadRequest, "the request is not a JSON object of the protocol"))
		return
	}
	switch req.Op {
	case chatproto.OpAgents:
		h.reply(conn, h.agents(req))
	case chatproto.OpChats:
		_, views := h.sorted()
		h.reply(conn, chatproto.Response{OK: true, Chats: views})
	case chatproto.OpNew:
		h.reply(conn, h.newChat(req))
	case chatproto.OpAttach:
		h.attach(conn, r, req)
	case chatproto.OpClose:
		h.reply(conn, h.closeChat(req.Chat))
	case chatproto.OpDelete:
		h.reply(conn, h.deleteChat(req.Chat))
	case chatproto.OpSessions:
		h.reply(conn, h.sessions(req))
	case chatproto.OpWatch:
		h.watch(conn, r)
	case chatproto.OpSeen:
		h.reply(conn, h.seen(req))
	case chatproto.OpConfigure:
		h.reply(conn, h.configure(req))
	case chatproto.OpShutdown:
		h.reply(conn, h.shutdown())
	case chatproto.OpTrust:
		h.reply(conn, h.trust(req))
	case chatproto.OpUntrust:
		h.reply(conn, h.untrust(req))
	case chatproto.OpTrusted:
		h.reply(conn, h.listTrusted())
	case chatproto.OpHostStatus:
		h.reply(conn, h.hostStatus())
	default:
		h.reply(conn, refuse(chatproto.CodeBadRequest, "unknown op"))
	}
}

func (h *host) hostStatus() chatproto.Response {
	h.mu.Lock()
	chats := h.list()
	conns := len(h.conns)
	h.mu.Unlock()

	h.wmu.Lock()
	watchers := len(h.watchers)
	h.wmu.Unlock()

	h.pmu.Lock()
	ending := len(h.ending)
	h.pmu.Unlock()

	sessions := make([]chatproto.HostSessionInfo, 0)
	var totalBytes int64
	liveAgents := 0
	for _, c := range chats {
		c.mu.Lock()
		totalBytes += c.r.Bytes
		running := c.sess != nil || c.starting
		if running && !c.deleted {
			liveAgents++
			pid := 0
			if p, ok := c.sess.(pider); ok {
				pid = p.PID()
			}
			var idleSince time.Time
			if c.r.State == chatproto.StateIdle {
				idleSince = c.idleSince.UTC()
			}
			sessions = append(sessions, chatproto.HostSessionInfo{
				Chat:         c.r.ID,
				Kind:         c.r.Kind,
				Title:        c.r.Title,
				Cwd:          c.r.Cwd,
				SessionID:    c.r.SessionID,
				State:        c.r.State,
				Status:       c.r.Status,
				PID:          pid,
				Starting:     c.starting,
				IdleSince:    idleSince,
				Updated:      c.r.Updated,
				Bytes:        c.r.Bytes,
				AgentVersion: c.r.AgentVersion,
			})
		}
		c.mu.Unlock()
	}
	sort.Slice(sessions, func(i, j int) bool {
		if !sessions[i].Updated.Equal(sessions[j].Updated) {
			return sessions[i].Updated.After(sessions[j].Updated)
		}
		return sessions[i].Chat < sessions[j].Chat
	})
	return chatproto.Response{
		OK: true,
		HostStatus: &chatproto.HostStatus{
			Proto:      chatproto.Proto,
			Version:    agentproto.Version,
			PID:        os.Getpid(),
			TerminalID: os.Getenv("HC_TERMINAL_ID"),
			StartedAt:  h.startedAt,
			Socket:     filepath.Join(h.o.Run, chatproto.SocketName),
			Base:       h.o.Base,
			Conns:      conns,
			Watchers:   watchers,
			LiveAgents: liveAgents,
			TotalChats: len(chats),
			TotalBytes: totalBytes,
			Ending:     ending,
			Settings:   *h.settings.Load(),
			Sessions:   sessions,
		},
	}
}

// discard reads the rest of a line that is too long, as far as it comes in
// time and within maxDiscard.
func discard(r *bufio.Reader) {
	for n := 0; n < maxDiscard; {
		part, err := r.ReadSlice('\n')
		n += len(part)
		if err != bufio.ErrBufferFull {
			return
		}
	}
}

// spec is the Chat spec of a kind and its adapter, or why there is none.
func (h *host) spec(kind string) (*agentkinds.ChatSpec, chatadapter.Adapter, *chatproto.Error) {
	spec, ok := h.o.kinds(kind)
	if !ok || spec == nil || len(spec.Argv) == 0 {
		return nil, nil, perr(chatproto.CodeUnsupported, "the kind has no chat")
	}
	a, ok := h.o.adapters(spec.Adapter)
	if !ok {
		return nil, nil, perr(chatproto.CodeUnsupported, "this host has no adapter "+spec.Adapter)
	}
	return spec, a, nil
}

// agents tells which kinds' programs the user's PATH has.
func (h *host) agents(req chatproto.Request) chatproto.Response {
	if len(req.Kinds) > maxKinds {
		return refuse(chatproto.CodeBadRequest, "too many kinds")
	}
	user := h.env.get(h.ctx)
	res := chatproto.Response{OK: true, Agents: make([]chatproto.AgentStatus, 0, len(req.Kinds))}
	for _, kind := range req.Kinds {
		st := chatproto.AgentStatus{Kind: kind}
		if spec, _, e := h.spec(kind); e != nil {
			st.Reason = chatproto.ReasonUnsupported
		} else if _, ok := lookPath(spec.Argv[0], agentEnv(user, spec.Env, "")); !ok {
			st.Reason = chatproto.ReasonNotFound
		} else {
			st.Available = true
		}
		res.Agents = append(res.Agents, st)
	}
	return res
}

// sessionID is the form of an agent's session id the host takes from a
// client: what the agents make (UUIDs, their own ids), and nothing that
// could read as more than one argument or an option.
var sessionID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`)

// validOption tells whether s may be a value of a chat's Options.
func validOption(s string) bool {
	if len(s) > 256 || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// checkCwd says what is wrong with a chat's directory; nil when it is the
// absolute path of a directory that exists.
func checkCwd(cwd string) *chatproto.Error {
	if cwd == "" || !filepath.IsAbs(cwd) || filepath.Clean(cwd) != cwd {
		return perr(chatproto.CodeBadRequest, "cwd is not a clean absolute path")
	}
	if !isDir(cwd) {
		return perr(chatproto.CodeBadRequest, "cwd is not a directory")
	}
	return nil
}

// newChat makes a chat and starts its agent; the answer does not wait for
// that.
func (h *host) newChat(req chatproto.Request) chatproto.Response {
	if _, _, e := h.spec(req.Kind); e != nil {
		return refusal(e)
	}
	if e := checkCwd(req.Cwd); e != nil {
		return refusal(e)
	}
	if req.Resume != "" && !sessionID.MatchString(req.Resume) {
		return refuse(chatproto.CodeBadRequest, "resume is no session id")
	}
	if req.Import && req.Resume == "" {
		return refuse(chatproto.CodeBadRequest, "import needs a session to resume")
	}
	var opts chatproto.Options
	if req.Options != nil {
		opts = *req.Options
	}
	if !validOption(opts.Model) || !validOption(opts.Effort) || (opts.Mode != "" && !slices.Contains(chatproto.Modes, opts.Mode)) {
		return refuse(chatproto.CodeBadRequest, "options out of their bounds")
	}
	if opts.Mode == chatproto.ModeFull && !h.settings.Load().AllowFull {
		return refuse(chatproto.CodeNotAllowed, "full access is not allowed on this machine")
	}
	if h.stopping.Load() {
		return refuse(chatproto.CodeEnded, "the host stops")
	}
	if req.Resume != "" {
		if e := h.inTerminal(req.Kind, req.Cwd, req.Resume); e != nil {
			return refusal(e)
		}
	}
	h.newMu.Lock()
	defer h.newMu.Unlock()
	if req.Resume != "" {
		if other := h.chatOfSession(req.Kind, req.Resume); other != "" {
			return refuse(chatproto.CodeBadRequest, "chat "+other+" has the session")
		}
	}
	if e := h.roomForChat(); e != nil {
		return refusal(e)
	}
	t := now()
	// A session taken up is the chat's from the start; one made for it is
	// fresh until it had a turn.
	r := row{Chat: chatproto.Chat{ID: chatproto.NewChatID(), Kind: req.Kind, Cwd: req.Cwd, SessionID: req.Resume,
		State: chatproto.StateStarting, Status: chatproto.StatusIdle, Created: t, Updated: t}, Options: opts, Fresh: req.Resume == ""}
	c := newChat(h, r)
	c.first = 1
	if err := h.j.insertChat(r); err != nil {
		h.logf("new chat: %v", err)
		return refuse(chatproto.CodeFailed, "the journal did not take the chat")
	}
	h.mu.Lock()
	h.chats[r.ID] = c
	h.mu.Unlock()
	c.mu.Lock()
	st := c.beginStart()
	view := c.snapshot()
	c.notify()
	c.mu.Unlock()
	h.pokeQuiet()
	h.wg.Go(func() {
		if req.Import {
			c.catchMu.Lock()
			c.history(st.ctx, req.Resume, importAll)
			c.catchMu.Unlock()
		}
		c.launch(st, req.Resume)
	})
	return chatproto.Response{OK: true, Chat: view}
}

// inTerminal is CodeInTerminal's error when a process other than the
// host's runs an agent's session (chatadapter.Running), so that the host
// neither resumes nor imports it; nil otherwise, or when the adapter
// cannot tell.
func (h *host) inTerminal(kind, cwd, session string) *chatproto.Error {
	spec, a, e := h.spec(kind)
	if e != nil {
		return nil
	}
	r, ok := a.(chatadapter.Running)
	if !ok {
		return nil
	}
	ctx, cancel := context.WithTimeout(h.ctx, h.o.startTimeout)
	defer cancel()
	err := r.InTerminal(ctx, chatadapter.HistoryParams{Kind: kind, Env: agentEnv(h.env.get(ctx), spec.Env, cwd), Cwd: cwd,
		SessionID: session, Logger: h.logger})
	var pe *chatproto.Error
	if errors.As(err, &pe) && pe.Code == chatproto.CodeInTerminal {
		return capStderr(pe)
	}
	return nil
}

// chatOfSession is the chat of a kind that has a session, "" for none.
func (h *host) chatOfSession(kind, session string) string {
	h.mu.Lock()
	chats := h.list()
	h.mu.Unlock()
	for _, c := range chats {
		c.mu.Lock()
		has := c.r.Kind == kind && c.r.SessionID == session && !c.deleted
		c.mu.Unlock()
		if has {
			return c.r.ID
		}
	}
	return ""
}

// lookup is a chat by its id; nil for none.
func (h *host) lookup(id string) *chat {
	if !chatproto.ValidChatID(id) {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.chats[id]
}

// attach subscribes the connection to a chat and takes its commands until
// either side closes.
func (h *host) attach(conn net.Conn, r *bufio.Reader, req chatproto.Request) {
	c := h.lookup(req.Chat)
	s := newSubscriber(conn)
	if c == nil || !c.subscribe(s, req.From) {
		h.reply(conn, refuse(chatproto.CodeUnknownChat, "no such chat"))
		return
	}
	h.mu.Lock()
	if _, served := h.conns[conn]; served {
		h.conns[conn] = true
	}
	if h.stopping.Load() {
		// The host's end found the connection before it was attached.
		conn.SetReadDeadline(time.Now().Add(stopFlush))
	}
	h.mu.Unlock()
	go s.run()
	if !req.NoCatchUp {
		c.catchUpLater()
	}
	calls := make(chan struct{}, maxCalls)
	// The connection is closed at once when it ends for any reason but a
	// line the client must be told of.
	leave := s.drop
	for {
		b, err := chatproto.ReadLine(r)
		if err == chatproto.ErrTooLarge {
			conn.SetReadDeadline(time.Now().Add(requestTimeout))
			discard(r)
			s.ack("", perr(chatproto.CodeTooLarge, "a line of more than 16 MiB"))
			leave = s.finish
			break
		}
		if err != nil {
			break
		}
		if len(b) == 0 {
			continue
		}
		var cmd chatproto.Command
		if err := json.Unmarshal(b, &cmd); err != nil {
			s.ack("", perr(chatproto.CodeBadRequest, "the command is not a JSON object of the protocol"))
			continue
		}
		h.command(c, s, cmd, calls)
	}
	c.unsubscribe(s)
	leave()
	<-s.done
}

// command runs a command of an attached connection and acks it. A command
// that waits for the agent does not hold up the ones after it.
func (h *host) command(c *chat, s *subscriber, cmd chatproto.Command, calls chan struct{}) {
	var call func() *chatproto.Error
	switch cmd.Op {
	case chatproto.OpPrompt:
		call = func() *chatproto.Error { return c.prompt(cmd) }
	case chatproto.OpCancel:
		call = c.cancelTurn
	case chatproto.OpPermission:
		s.ack(cmd.ID, c.answerPermission(cmd))
	case chatproto.OpAnswer:
		s.ack(cmd.ID, c.answerQuestion(cmd))
	case chatproto.OpSetConfig:
		call = func() *chatproto.Error { return c.setConfig(cmd.Config, cmd.Value) }
	case chatproto.OpCancelQueued:
		call = func() *chatproto.Error { return c.cancelQueued(cmd.Message) }
	case chatproto.OpCompact:
		call = c.compact
	case chatproto.OpRename:
		s.ack(cmd.ID, c.rename(cmd.Title))
	case chatproto.OpHandoff:
		call = c.handoff
	default:
		s.ack(cmd.ID, perr(chatproto.CodeBadRequest, "unknown op"))
	}
	if call == nil {
		return
	}
	select {
	case calls <- struct{}{}:
	default:
		s.ack(cmd.ID, perr(chatproto.CodeBusy, "too many commands wait for the agent"))
		return
	}
	h.wg.Go(func() {
		defer func() { <-calls }()
		s.ack(cmd.ID, call())
	})
}

// closeChat ends a chat's agent and keeps the chat, closed.
func (h *host) closeChat(id string) chatproto.Response {
	c := h.lookup(id)
	if c == nil {
		return refuse(chatproto.CodeUnknownChat, "no such chat")
	}
	c.mu.Lock()
	if c.deleted {
		c.mu.Unlock()
		return refuse(chatproto.CodeUnknownChat, "no such chat")
	}
	if c.r.State != chatproto.StateClosed || c.r.Closed.IsZero() {
		c.r.Closed = now()
	}
	sess := c.stopAgent(chatproto.StateClosed, nil, perr(chatproto.CodeEnded, "the chat was closed"))
	c.save()
	c.mu.Unlock()
	h.endSession(sess, true)
	return chatproto.Response{OK: true}
}

// deleteChat forgets a chat and its log, its agent ended first.
func (h *host) deleteChat(id string) chatproto.Response {
	c := h.lookup(id)
	if c == nil {
		return refuse(chatproto.CodeUnknownChat, "no such chat")
	}
	c.mu.Lock()
	if c.deleted {
		c.mu.Unlock()
		return refuse(chatproto.CodeUnknownChat, "no such chat")
	}
	sess := c.stopAgent(chatproto.StateClosed, nil, perr(chatproto.CodeEnded, "the chat was deleted"))
	// From here on no prompt starts its agent again.
	c.deleted = true
	c.mu.Unlock()
	h.endSession(sess, true)
	if err := h.forget(c); err != nil {
		h.logf("chat %s: delete: %v", id, err)
		return refuse(chatproto.CodeFailed, "the journal did not delete the chat")
	}
	return chatproto.Response{OK: true}
}

// forget removes a chat: from the host, its agent ended (one that started
// since the chat was found to have none) and its attached connections
// closed, then from the journal.
func (h *host) forget(c *chat) error {
	h.mu.Lock()
	if h.chats[c.r.ID] == c {
		delete(h.chats, c.r.ID)
	}
	h.mu.Unlock()
	c.mu.Lock()
	c.deleted = true
	sess := c.stopAgent(chatproto.StateClosed, nil, nil)
	for s := range c.subs {
		s.finish()
	}
	c.subs = map[*subscriber]struct{}{}
	for _, t := range []*time.Timer{c.infoTimer, c.idleTimer} {
		if t != nil {
			t.Stop()
		}
	}
	st := c.r.StateOf()
	st.State, st.Status = chatproto.StateDeleted, chatproto.StatusIdle
	c.mu.Unlock()
	h.endSession(sess, false)
	h.broadcast(st)
	h.pokeQuiet()
	return h.j.deleteChat(c.r.ID)
}

// endLate ends a session whose start its chat no longer waited for. While
// the host stops, it returns once the agent is gone (killed at once on a
// signal of the terminal core): no agent outlives the host.
func (h *host) endLate(sess chatadapter.Session) {
	stopping := h.stopping.Load()
	if stopping && h.fast.Load() {
		if p, ok := sess.(pider); ok && p.PID() > 1 {
			syscall.Kill(-p.PID(), syscall.SIGKILL)
		}
	}
	h.endSession(sess, stopping)
}

// endSession ends an agent session the host let go of: gracefully, within
// closeGrace, and whatever is left of its process group is killed. With
// wait, it returns once the agent is gone.
func (h *host) endSession(sess chatadapter.Session, wait bool) {
	if sess == nil {
		return
	}
	h.pmu.Lock()
	h.ending[sess] = struct{}{}
	h.pmu.Unlock()
	done := make(chan struct{})
	// Not one of h.wg's: it may start from a timer, and Serve waits for
	// the ending sessions by themselves (waitEnding).
	go func() {
		defer close(done)
		ctx, cancel := context.WithTimeout(context.Background(), h.o.closeGrace)
		err := sess.Close(ctx)
		select {
		case <-sess.Done():
		case <-ctx.Done():
		}
		cancel()
		select {
		case <-sess.Done():
		default:
			h.logf("an agent did not end in %s (%v): killed", h.o.closeGrace, err)
			if p, ok := sess.(pider); ok && p.PID() > 1 {
				syscall.Kill(-p.PID(), syscall.SIGKILL)
			}
		}
		h.pmu.Lock()
		delete(h.ending, sess)
		h.pmu.Unlock()
		select {
		case h.ended <- struct{}{}:
		default:
		}
		h.pokeQuiet()
	}()
	if wait {
		<-done
	}
}

// waitEnding waits until no session is being ended, or until the deadline.
func (h *host) waitEnding(deadline time.Time) {
	t := time.NewTimer(time.Until(deadline))
	defer t.Stop()
	for {
		h.pmu.Lock()
		n := len(h.ending)
		h.pmu.Unlock()
		if n == 0 {
			return
		}
		select {
		case <-h.ended:
		case <-t.C:
			return
		}
	}
}

// sessions lists the sessions an agent kept for a directory, and which
// chat has each.
func (h *host) sessions(req chatproto.Request) chatproto.Response {
	spec, a, e := h.spec(req.Kind)
	if e != nil {
		return refusal(e)
	}
	if req.Cwd == "" || !filepath.IsAbs(req.Cwd) || filepath.Clean(req.Cwd) != req.Cwd {
		return refuse(chatproto.CodeBadRequest, "cwd is not a clean absolute path")
	}
	if len(req.Cursor) > 4096 {
		return refuse(chatproto.CodeBadRequest, "cursor too long")
	}
	select {
	case h.probes <- struct{}{}:
		defer func() { <-h.probes }()
	default:
		return refuse(chatproto.CodeBusy, "too many session listings run")
	}
	ctx, cancel := context.WithTimeout(h.ctx, h.o.startTimeout)
	defer cancel()
	env := agentEnv(h.env.get(ctx), spec.Env, req.Cwd)
	path, ok := lookPath(spec.Argv[0], env)
	if !ok {
		return refuse(chatproto.CodeNotFound, spec.Argv[0]+" is not in the user's PATH")
	}
	list, next, err := a.Sessions(ctx, chatadapter.SessionsParams{Kind: req.Kind, Argv: append([]string{path}, spec.Argv[1:]...),
		Env: env, Cwd: req.Cwd, Cursor: req.Cursor, Logger: h.logger})
	if err != nil {
		return refusal(errorOf(err))
	}
	have := map[string]string{}
	h.mu.Lock()
	chats := h.list()
	h.mu.Unlock()
	for _, c := range chats {
		c.mu.Lock()
		if c.r.Kind == req.Kind && c.r.SessionID != "" && !c.deleted {
			have[c.r.SessionID] = c.r.ID
		}
		c.mu.Unlock()
	}
	res := chatproto.Response{OK: true, Sessions: make([]chatproto.Session, 0, len(list)), NextCursor: next}
	for _, s := range list {
		s.Chat = have[s.SessionID]
		res.Sessions = append(res.Sessions, s)
	}
	return res
}

// watch sends the states of every chat, then each change, until either
// side closes. The states are those the other watchers were told last,
// read under the lock the changes are told under, as the watcher is
// listed: every change after them comes after them, none before.
func (h *host) watch(conn net.Conn, r *bufio.Reader) {
	s := newSubscriber(conn)
	h.mu.Lock()
	if _, served := h.conns[conn]; served {
		h.conns[conn] = true
	}
	h.mu.Unlock()
	h.wmu.Lock()
	states := make([]chatproto.ChatState, 0, len(h.states))
	for _, st := range h.states {
		states = append(states, st)
	}
	sort.Slice(states, func(a, b int) bool {
		if !states[a].Updated.Equal(states[b].Updated) {
			return states[a].Updated.After(states[b].Updated)
		}
		return states[a].ID < states[b].ID
	})
	head, err := chatproto.Line(chatproto.Response{OK: true, States: states})
	if err != nil || len(head) > chatproto.MaxLine+1 {
		head, _ = chatproto.Line(refuse(chatproto.CodeTooLarge, "the answer does not fit a line"))
	}
	s.head = [][]byte{head}
	h.watchers[s] = struct{}{}
	h.wmu.Unlock()
	go s.run()
	// The client sends nothing more: what it reads tells that it left.
	io.Copy(io.Discard, io.LimitReader(r, 1<<20))
	h.wmu.Lock()
	delete(h.watchers, s)
	h.wmu.Unlock()
	s.drop()
	<-s.done
}

// broadcast sends a chat's state to every watcher, and keeps it for the
// watchers that come.
func (h *host) broadcast(st chatproto.ChatState) {
	b, err := chatproto.Line(st)
	if err != nil {
		return
	}
	h.wmu.Lock()
	defer h.wmu.Unlock()
	if st.State == chatproto.StateDeleted {
		delete(h.states, st.ID)
	} else {
		h.states[st.ID] = st
	}
	for s := range h.watchers {
		if !s.push(b) {
			delete(h.watchers, s)
		}
	}
}

// seen notes what the user saw of a chat.
func (h *host) seen(req chatproto.Request) chatproto.Response {
	c := h.lookup(req.Chat)
	if c == nil {
		return refuse(chatproto.CodeUnknownChat, "no such chat")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.deleted {
		return refuse(chatproto.CodeUnknownChat, "no such chat")
	}
	if seq := min(req.Seq, c.r.Seq); seq > c.r.Seen {
		c.r.Seen = seq
		c.save()
		c.notify()
	}
	return chatproto.Response{OK: true}
}

// configure takes the core's settings. Without full access, a chat whose
// agent runs in a mode of full access starts it again in the default mode
// (revokeFull).
func (h *host) configure(req chatproto.Request) chatproto.Response {
	if req.Settings == nil {
		return refuse(chatproto.CodeBadRequest, "configure needs settings")
	}
	s := req.Settings.Clamp()
	h.settings.Store(&s)
	if err := h.j.putSettings(s); err != nil {
		h.logf("settings: %v", err)
	}
	h.mu.Lock()
	chats := h.list()
	h.mu.Unlock()
	for _, c := range chats {
		var sess chatadapter.Session
		c.mu.Lock()
		c.armIdle()
		if !s.AllowFull {
			sess = c.revokeFull()
		}
		c.mu.Unlock()
		h.endSession(sess, false)
	}
	h.makeRoom(nil)
	h.enforceSoon()
	return chatproto.Response{OK: true}
}

// shutdown ends the host for another version to take over, unless an
// agent works, waits or starts.
func (h *host) shutdown() chatproto.Response {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.chats {
		c.mu.Lock()
		busy := c.starting || c.r.State == chatproto.StateWorking || c.r.State == chatproto.StateWaiting
		c.mu.Unlock()
		if busy {
			return refuse(chatproto.CodeBusy, "a chat works, waits or starts")
		}
	}
	// No chat starts an agent from here on.
	h.stopping.Store(true)
	go h.end("asked to")
	return chatproto.Response{OK: true}
}

// roomForChat makes room for one more chat within MaxChats: the oldest
// closed chat goes; CodeTooMany when none can.
func (h *host) roomForChat() *chatproto.Error {
	max := h.settings.Load().MaxChats
	for {
		h.mu.Lock()
		n := len(h.chats)
		h.mu.Unlock()
		if n < max {
			return nil
		}
		victims := h.closedOldestFirst()
		if len(victims) == 0 {
			return perr(chatproto.CodeTooMany, fmt.Sprintf("the host keeps %d chats, none closed", n))
		}
		h.logf("chat %s: removed, the oldest closed one of %d chats", victims[0].r.ID, n)
		if err := h.forget(victims[0]); err != nil {
			h.logf("chat %s: remove: %v", victims[0].r.ID, err)
			return perr(chatproto.CodeFailed, "the journal did not remove a chat")
		}
	}
}

// closedOldestFirst are the closed chats, the one closed first first.
func (h *host) closedOldestFirst() []*chat {
	h.mu.Lock()
	chats := h.list()
	h.mu.Unlock()
	type closed struct {
		c  *chat
		at time.Time
	}
	var out []closed
	for _, c := range chats {
		c.mu.Lock()
		if c.r.State == chatproto.StateClosed && c.sess == nil && !c.starting && !c.deleted {
			out = append(out, closed{c, c.r.Closed})
		}
		c.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].at.Equal(out[j].at) {
			return out[i].at.Before(out[j].at)
		}
		return out[i].c.r.ID < out[j].c.r.ID
	})
	cs := make([]*chat, len(out))
	for i, o := range out {
		cs[i] = o.c
	}
	return cs
}

// enforceBounds keeps the journal within the settings: closed chats past
// their retention go, then the oldest closed chats while there are more
// chats than MaxChats or more bytes than MaxTotalBytes; when no closed chat
// is left and the bytes are still too many, the largest chats lose their
// oldest events.
func (h *host) enforceBounds() {
	s := h.settings.Load()
	cutoff := time.Now().Add(-time.Duration(s.RetentionDays) * h.o.day)
	for _, c := range h.closedOldestFirst() {
		c.mu.Lock()
		old := c.r.Closed.Before(cutoff)
		c.mu.Unlock()
		if !old {
			break
		}
		h.logf("chat %s: removed, closed more than %d days ago", c.r.ID, s.RetentionDays)
		if err := h.forget(c); err != nil {
			h.logf("chat %s: remove: %v", c.r.ID, err)
			return
		}
	}
	for {
		h.mu.Lock()
		n := len(h.chats)
		chats := h.list()
		h.mu.Unlock()
		var total int64
		var largest *chat
		var largestBytes int64
		for _, c := range chats {
			c.mu.Lock()
			total += c.r.Bytes
			if c.r.Bytes > largestBytes {
				largest, largestBytes = c, c.r.Bytes
			}
			c.mu.Unlock()
		}
		if n <= s.MaxChats && total <= s.MaxTotalBytes {
			return
		}
		if victims := h.closedOldestFirst(); len(victims) > 0 {
			h.logf("chat %s: removed, the oldest closed one (%d chats, %d bytes)", victims[0].r.ID, n, total)
			if err := h.forget(victims[0]); err != nil {
				h.logf("chat %s: remove: %v", victims[0].r.ID, err)
				return
			}
			continue
		}
		if total <= s.MaxTotalBytes || largest == nil {
			return
		}
		largest.mu.Lock()
		before := largest.r.Bytes
		largest.trim(max(before-(total-s.MaxTotalBytes), 0))
		progress := largest.r.Bytes < before
		largest.mu.Unlock()
		if !progress {
			return
		}
	}
}

// makeRoom stops the agents idle the longest while more run than MaxLive,
// counting except as one that runs. It is false when the agents that run
// all work, wait or start.
func (h *host) makeRoom(except *chat) bool {
	h.room.Lock()
	defer h.room.Unlock()
	max := h.settings.Load().MaxLive
	for {
		n := h.liveAgents(except)
		if except != nil {
			n++
		}
		if n <= max {
			return true
		}
		h.mu.Lock()
		chats := h.list()
		h.mu.Unlock()
		var victim *chat
		var since time.Time
		for _, c := range chats {
			if c == except {
				continue
			}
			c.mu.Lock()
			idle := c.sess != nil && c.r.State == chatproto.StateIdle
			if idle && (victim == nil || c.idleSince.Before(since)) {
				victim, since = c, c.idleSince
			}
			c.mu.Unlock()
		}
		if victim == nil {
			return false
		}
		victim.mu.Lock()
		var sess chatadapter.Session
		if victim.sess != nil && victim.r.State == chatproto.StateIdle {
			h.logf("chat %s: its agent stopped, idle the longest of %d", victim.r.ID, n)
			sess = victim.stopAgent(chatproto.StateSleeping, nil, nil)
		}
		victim.mu.Unlock()
		h.endSession(sess, false)
	}
}

// stopAgents ends every agent as the host stops; the chats sleep. Fast,
// on a signal of the terminal core, which kills the host a second later:
// every agent's process group gets SIGTERM at once while the adapters end
// their agents, and SIGKILL at the next signal or after killAfter.
// Otherwise the adapters have closeGrace to end their agents, and what is
// left of them is killed.
func (h *host) stopAgents(fast bool) {
	h.mu.Lock()
	chats := h.list()
	h.mu.Unlock()
	var sessions []chatadapter.Session
	for _, c := range chats {
		c.mu.Lock()
		if c.sess != nil || c.starting {
			rest, e := chatproto.StateSleeping, (*chatproto.Error)(nil)
			if c.r.SessionID == "" {
				rest, e = chatproto.StateFailed, perr(chatproto.CodeEnded, "the chat host stopped before the session existed")
			}
			if sess := c.stopAgent(rest, e, perr(chatproto.CodeEnded, "the chat host stopped")); sess != nil {
				sessions = append(sessions, sess)
			}
		}
		c.mu.Unlock()
	}
	h.pmu.Lock()
	for s := range h.ending {
		if !slices.Contains(sessions, s) {
			sessions = append(sessions, s)
		}
	}
	h.pmu.Unlock()
	as := make([]any, len(sessions))
	for i, s := range sessions {
		as[i] = s
	}
	if !fast {
		for _, s := range sessions {
			h.pmu.Lock()
			_, ending := h.ending[s]
			h.pmu.Unlock()
			if !ending {
				h.endSession(s, false)
			}
		}
		h.waitEnding(time.Now().Add(h.o.closeGrace + time.Second))
		agentTargets(as).signal(syscall.SIGKILL)
		return
	}
	t := agentTargets(as)
	t.signal(syscall.SIGTERM)
	ctx, cancel := context.WithTimeout(context.Background(), h.o.killAfter)
	defer cancel()
	all := make(chan struct{})
	go func() {
		var closed sync.WaitGroup
		for _, s := range sessions {
			closed.Go(func() {
				s.Close(ctx)
				select {
				case <-s.Done():
				case <-ctx.Done():
				}
			})
		}
		closed.Wait()
		close(all)
	}()
	select {
	case <-all:
	case <-ctx.Done():
	case <-h.o.Signals:
	}
	// What started meanwhile goes too.
	agentTargets(as).signal(syscall.SIGKILL)
	t.signal(syscall.SIGKILL)
}

// newID is a new random id with a prefix: of a permission, a question, a
// queued message.
func newID(prefix string) string {
	var b [8]byte
	rand.Read(b[:])
	return prefix + hex.EncodeToString(b[:])
}

// newUUID is a new random UUID (version 4), in lower case.
func newUUID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// clientInfo is what the agents are told of their client.
func clientInfo() chatadapter.ClientInfo {
	return chatadapter.ClientInfo{Name: brand.Slug, Version: agentproto.Version}
}
