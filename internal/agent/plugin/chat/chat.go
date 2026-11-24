//go:build unix

// Package chat is the machine side of the chat plugin
// (internal/plugins/chat): the relay between the core and this machine's
// chat host, which runs coding agents headless and keeps their
// conversations (internal/chathost, protocol internal/chatproto). Its one
// action:
//
//   - open (OpenParams): a connection to the chat host's socket
//     (<run dir>/chat.sock) for the core. After the reply the stream
//     carries the host's bytes both ways, the host's Hello first, until
//     either side closes; one open is one connection to the host.
//
// The host is no child of the agent: when no host serves the socket, the
// agent has the instance's terminal core run one, the agent's own
// executable, as a terminal no client shows (plugin.Env.RunHidden). It
// then lives as the user's terminals do, while agents, ssh sessions and
// cores come and go, and ends by itself when it has had nothing to do for
// a while, when the terminal core stops, or when the agent of a newer
// build asks it to make way (never one of an older build: two cores of
// different builds that reach one machine do not take turns). A host's
// terminal that holds the host's name while nothing serves the socket for
// longer than a host takes to end is stuck: the agent has the terminal
// core kill it (plugin.Env.KillHidden) and starts another. Nothing listens
// on the machine for the core: the core opens a stream per connection.
package chat

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"veldr/internal/agent/plugin"
	"veldr/internal/agentproto"
	"veldr/internal/chatproto"
)

// ID names the plugin on every side.
const ID = "chat"

// ActionOpen is the plugin's action.
const ActionOpen = "open"

// OpenParams are the parameters of open; none are the defaults.
type OpenParams struct {
	// Start false asks for a host that serves already: when none does, the
	// open fails with CodeNotRunning instead of starting one, and a host of
	// another build is used as it is (while it speaks this agent's
	// protocol) instead of being asked to make way. A watch that only
	// follows the chats uses it, so that it neither starts a host nor
	// keeps one from ending.
	Start *bool `json:"start,omitempty"`
}

// The codes of an open that made no connection.
const (
	// CodeNotRunning: no chat host serves, and the open was not to start
	// one (OpenParams.Start false).
	CodeNotRunning = "not_running"
	// CodeNoTerminalCore: the instance's terminal core does not run, and
	// the chat host runs as one of its terminals.
	CodeNoTerminalCore = "no_terminal_core"
	// CodeStartFailed: the chat host did not start, or did not serve in
	// time.
	CodeStartFailed = "start_failed"
	// CodeUpgrading: a chat host of another build serves, speaks another
	// protocol than this agent, and does not make way while a chat works
	// or waits; a later open finds this build's host.
	CodeUpgrading = "upgrading"
)

// Variables so that tests need not wait or run another program.
var (
	// startTimeout is how long a host has to serve once the terminal core
	// was asked to run it, and pollEvery how often its socket is tried.
	startTimeout = 15 * time.Second
	pollEvery    = 100 * time.Millisecond
	// askAgain is how long after the terminal core was asked it is asked
	// again, each time twice as long up to askMax: the host's name may
	// still be that of a host that ends (it ends its agents first), and
	// the terminal core then starts nothing.
	askAgain = 500 * time.Millisecond
	askMax   = 2 * time.Second
	// executable is the program the terminal core runs as the host: the
	// agent's own (the core's for the local machine, whose agent runs in
	// the core's process).
	executable = os.Executable
	// stopGrace is how long a host takes to end at the most
	// (chatproto.StopGrace): an old host that makes way is waited for this
	// long, and a name taken this long past startTimeout while nothing
	// serves is a stuck host's.
	stopGrace = chatproto.StopGrace
	// goneEvery is how often an old host's process is looked for.
	goneEvery = 50 * time.Millisecond
)

const (
	// dialTimeout is how long the socket has to take a connection, and
	// helloTimeout how long a host has to say who it is.
	dialTimeout  = time.Second
	helloTimeout = 5 * time.Second
	// maxHello is the longest first line taken from a host.
	maxHello = 64 << 10
	// shutdownTimeout is how long a host has to answer that it ends.
	shutdownTimeout = 10 * time.Second
)

func init() { plugin.Register(ID, handle) }

func handle(ctx context.Context, st net.Conn, action string, params json.RawMessage, env *plugin.Env) error {
	if action != ActionOpen {
		return plugin.Reply(st, nil, plugin.Errorf("bad_params", "chat: unknown action %q", action))
	}
	var p OpenParams
	if err := plugin.Decode(params, &p); err != nil {
		return plugin.Reply(st, nil, err)
	}
	return open(ctx, st, env, p.Start == nil || *p.Start)
}

// open makes sure a chat host serves the run directory's socket (with
// start, else it takes one that serves), answers, and then carries bytes
// both ways between the stream and a connection to the host until either
// side ends: the host's first line, which says who it is, comes first, as
// the host wrote it.
func open(ctx context.Context, st net.Conn, env *plugin.Env, start bool) error {
	var h *host
	var err error
	if start {
		h, err = connect(ctx, env)
	} else {
		h, err = serving(env)
	}
	if err != nil {
		return plugin.Reply(st, nil, err)
	}
	stop := context.AfterFunc(ctx, func() {
		h.conn.Close()
		st.Close()
	})
	defer stop()
	err = agentproto.WriteLine(st, agentproto.Reply{OK: true})
	if err == nil {
		_, err = st.Write(h.hello)
	}
	if err != nil {
		h.conn.Close()
		st.Close()
		return err
	}
	pipe(st, h.conn)
	return nil
}

// host is a connection to a chat host that said who it is.
type host struct {
	conn net.Conn
	// hello is the host's first line with its newline, as it came.
	hello []byte
	info  chatproto.HostInfo
}

// dial connects to the chat host on sock and reads its first line.
func dial(sock string) (*host, error) {
	conn, err := net.DialTimeout("unix", sock, dialTimeout)
	if err != nil {
		return nil, err
	}
	conn.SetReadDeadline(time.Now().Add(helloTimeout))
	// Byte by byte: what follows the line is the core's to read.
	var line []byte
	for one := make([]byte, 1); len(line) == 0 || line[len(line)-1] != '\n'; {
		if _, err := io.ReadFull(conn, one); err != nil {
			conn.Close()
			return nil, fmt.Errorf("the chat host's first line: %w", err)
		}
		if line = append(line, one[0]); len(line) > maxHello {
			conn.Close()
			return nil, errors.New("the chat host's first line is too long")
		}
	}
	conn.SetReadDeadline(time.Time{})
	var hello chatproto.Hello
	if err := json.Unmarshal(line, &hello); err != nil || hello.Host.Proto < 1 {
		conn.Close()
		return nil, fmt.Errorf("the chat host's first line is no hello: %q", truncate(line))
	}
	return &host{conn: conn, hello: line, info: hello.Host}, nil
}

func truncate(b []byte) []byte {
	if len(b) > 120 {
		return b[:120]
	}
	return b
}

// connecting is held while a host is started or replaced: the streams the
// core opens at the same time find the host the first of them started,
// instead of each asking the terminal core for one. One start at a time.
var connecting sync.Mutex

// connect returns a connection to the machine's chat host, which it starts
// when none serves. A host of an older build than this agent's is asked to
// make way, which it does when no chat works or waits: once its process is
// gone, a host of this build takes its place. A host that does not make
// way, and one of a newer build or of a build whose age is not known (a
// development build), is used as it is while it speaks this agent's
// protocol; otherwise the open fails with CodeUpgrading.
func connect(ctx context.Context, env *plugin.Env) (*host, error) {
	sock := filepath.Join(env.RunDir, chatproto.SocketName)
	if h, err := dial(sock); err == nil {
		if h.info.Version == agentproto.Version || (!older(h.info.Version, agentproto.Version) && h.info.Proto == chatproto.Proto) {
			return h, nil
		}
		h.conn.Close()
	}
	connecting.Lock()
	defer connecting.Unlock()
	h, err := dial(sock)
	if err != nil {
		return start(ctx, env, sock, 0)
	}
	if h.info.Version == agentproto.Version {
		return h, nil
	}
	if !older(h.info.Version, agentproto.Version) {
		// Never a downgrade, nor a guess.
		if h.info.Proto != chatproto.Proto {
			h.conn.Close()
			return nil, upgrading(h.info)
		}
		return h, nil
	}
	// An older build's host. Its connection is not kept while it is asked:
	// a host closes a connection that sends no request in time.
	h.conn.Close()
	if shutdown(sock) {
		logf(env, "chat: the host of version %s (pid %d) ends for one of version %s", h.info.Version, h.info.PID, agentproto.Version)
		if !gone(ctx, h.info.PID, stopGrace) {
			logf(env, "chat: the host of pid %d did not end within %s", h.info.PID, stopGrace)
		}
		return start(ctx, env, sock, h.info.PID)
	}
	if h.info.Proto != chatproto.Proto {
		return nil, upgrading(h.info)
	}
	if h, err = dial(sock); err != nil {
		// It ended meanwhile.
		return start(ctx, env, sock, 0)
	}
	if h.info.Proto != chatproto.Proto {
		h.conn.Close()
		return nil, upgrading(h.info)
	}
	return h, nil
}

// gone waits until process pid is no more, for at most wait; it reports
// whether it is gone. A pid that is not a process of the user's is none of
// a host's.
func gone(ctx context.Context, pid int, wait time.Duration) bool {
	if pid <= 1 {
		return true
	}
	deadline := time.Now().Add(wait)
	for {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) || errors.Is(err, syscall.EPERM) {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(goneEvery):
		}
	}
}

// older tells whether build version a is older than b
// (agentproto.OlderVersion).
func older(a, b string) bool { return agentproto.OlderVersion(a, b) }

// serving returns a connection to the chat host that serves, of any build
// that speaks this agent's protocol, and starts none.
func serving(env *plugin.Env) (*host, error) {
	h, err := dial(filepath.Join(env.RunDir, chatproto.SocketName))
	if err != nil {
		return nil, plugin.Errorf(CodeNotRunning, "no chat host serves")
	}
	if h.info.Proto != chatproto.Proto {
		h.conn.Close()
		return nil, upgrading(h.info)
	}
	return h, nil
}

func upgrading(info chatproto.HostInfo) error {
	return plugin.Errorf(CodeUpgrading, "the chat host (version %s, pid %d) speaks protocol %d, this agent %d, and a chat keeps it running",
		info.Version, info.PID, info.Proto, chatproto.Proto)
}

// shutdown asks the host on sock to end, on a connection of its own, and
// reports whether it does: a host with a chat that works or waits answers
// that it is busy.
func shutdown(sock string) bool {
	h, err := dial(sock)
	if err != nil {
		return false
	}
	defer h.conn.Close()
	h.conn.SetDeadline(time.Now().Add(shutdownTimeout))
	req, err := chatproto.Line(chatproto.Request{Op: chatproto.OpShutdown})
	if err != nil {
		return false
	}
	if _, err := h.conn.Write(req); err != nil {
		return false
	}
	line, err := chatproto.ReadLine(bufio.NewReader(h.conn))
	var res chatproto.Response
	return err == nil && json.Unmarshal(line, &res) == nil && res.OK
}

// start has the terminal core run a chat host of this build and returns a
// connection to it once it serves: once a host says hello that is not the
// one of pid old, which made way and may still answer while it ends. A
// name that stays taken past startTimeout while nothing serves is waited
// for until a host that ends would have ended (stopGrace); then the
// terminal that holds it is killed (plugin.Env.KillHidden), and the
// terminal core asked again. The caller holds connecting.
func start(ctx context.Context, env *plugin.Env, sock string, old int) (*host, error) {
	if env.RunHidden == nil {
		return nil, plugin.Errorf(CodeStartFailed, "the agent runs no hidden terminals")
	}
	exe, err := executable()
	if err != nil {
		return nil, plugin.Errorf(CodeStartFailed, "the agent's executable: %v", err)
	}
	argv := []string{exe, "chat-host", "--base", env.Base, "--run", env.RunDir}
	began := time.Now()
	deadline := began.Add(startTimeout)
	ask, wait := time.Now(), askAgain
	const (
		starting = iota // the terminal core runs the host
		held            // a terminal holds the name: it may still end
		killed          // it did not, and was killed
	)
	phase := starting
	for {
		if !time.Now().Before(ask) {
			if err := env.RunHidden(ctx, agentproto.ChatHostName, argv); errors.Is(err, plugin.ErrNoTerminalCore) {
				return nil, &plugin.Error{Code: CodeNoTerminalCore, Err: err}
			} else if err != nil {
				return nil, &plugin.Error{Code: CodeStartFailed, Err: err}
			}
			ask, wait = time.Now().Add(wait), min(2*wait, askMax)
		}
		h, err := dial(sock)
		switch {
		case err == nil && old > 0 && h.info.PID == old:
			// The host that made way, still ending.
			h.conn.Close()
		case err == nil:
			// Another agent (of another build) may have started it.
			if h.info.Proto != chatproto.Proto {
				h.conn.Close()
				return nil, upgrading(h.info)
			}
			return h, nil
		}
		if !time.Now().Before(deadline) {
			next := 0 * time.Second
			switch phase {
			case starting:
				if env.KillHidden != nil {
					if taken, err := env.KillHidden(ctx, agentproto.ChatHostName, argv, false); err == nil && taken {
						phase, next = held, began.Add(startTimeout+stopGrace).Sub(time.Now())
					}
				}
			case held:
				ok, err := env.KillHidden(ctx, agentproto.ChatHostName, argv, true)
				if ok {
					logf(env, "chat: the host's terminal held its name and served nothing for %s: killed", time.Since(began).Round(time.Second))
				} else if err != nil {
					logf(env, "chat: a stuck host's terminal: %v", err)
				}
				if ok || err == nil {
					// The name is free: once more.
					phase, next, ask, wait = killed, startTimeout, time.Now(), askAgain
				}
			}
			if next <= 0 {
				logf(env, "chat: the host does not serve %s: %v", sock, err)
				return nil, plugin.Errorf(CodeStartFailed, "the chat host did not serve within %s", time.Since(began).Round(time.Second))
			}
			deadline = time.Now().Add(next)
		}
		select {
		case <-ctx.Done():
			return nil, plugin.Errorf(CodeStartFailed, "the agent stops")
		case <-time.After(pollEvery):
		}
	}
}

func logf(env *plugin.Env, format string, args ...any) {
	if env.Logger != nil {
		env.Logger.Printf(format, args...)
	}
}

// pipe copies in both directions and closes both ends when either ends.
func pipe(a, b net.Conn) {
	var once sync.Once
	end := func() {
		once.Do(func() {
			a.Close()
			b.Close()
		})
	}
	done := make(chan struct{})
	go func() {
		io.Copy(a, b)
		end()
		close(done)
	}()
	io.Copy(b, a)
	end()
	<-done
}
