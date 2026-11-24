//go:build unix

package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
	"herdr-ide/internal/hostdirs"
)

// A machine's node is the agent as a service: a process of its own that
// listens on the instance's <run>/node.sock and serves every client that
// connects as a session of one agent (Agent.Serve), the core of the
// machine itself as well as cores that came over ssh (`node dial`): they
// share its code-server, displays and sockets. It runs detached from its
// clients, in a session of its own, and ends once it has had no client for
// NodeIdle.
//
// One node serves an instance (run/node.lock). A client of a newer build
// than the node's (agentproto.NodeInfo.Newer) starts a node of its own
// build, which takes the socket over (NodeTakeover): the old node gives up
// socket and lock, tells its sessions' cores to move (OpNodeDrain), hands
// its code-server over, and ends once they left, at the latest after
// nodeDrainMax. A client of an older build uses the node as it is: the
// protocol only grows.

// NodeIdle is how long a node runs without a client.
var NodeIdle = 15 * time.Second

// nodeStartWait bounds how long a client waits for a node it started.
var nodeStartWait = 15 * time.Second

// nodeTakeoverWait bounds how long a node taking over waits for the lock
// the old node gives up.
var nodeTakeoverWait = 5 * time.Second

// nodeDrainMax bounds how long a node that was taken over serves the
// sessions that have not moved: the longest bounded request.
var nodeDrainMax = 10 * time.Minute

// nodeLogMax is the size at which a node's log is moved to node.old.log
// when a node starts.
const nodeLogMax = 1 << 20

// BuildID names this executable's build: a digest of its content, the same
// for every process that runs it.
var BuildID = sync.OnceValues(func() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	f, err := os.Open(exe)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil))[:12], nil
})

// selfInfo is this process's build, as nodes and their clients tell it.
var selfInfo = sync.OnceValues(func() (agentproto.NodeInfo, error) {
	build, err := BuildID()
	if err != nil {
		return agentproto.NodeInfo{}, err
	}
	info := agentproto.NodeInfo{Build: build, Version: agentproto.Version, Pid: os.Getpid()}
	if exe, err := os.Executable(); err == nil {
		if st, err := os.Stat(exe); err == nil {
			info.ExeTime = st.ModTime().UnixNano()
		}
	}
	return info, nil
})

func nodeSocket(runDir string) string { return filepath.Join(runDir, "node.sock") }

// RunNode serves the instance's node until it has had no client for
// NodeIdle, a client asks it to stop, it was taken over and its clients
// left, or ctx ends. It returns nil at once when another node serves the
// instance, unless takeover, which asks that node to give way.
func RunNode(ctx context.Context, opts Options, takeover bool) error {
	logger := opts.Logger
	if logger == nil {
		logger = log.New(os.Stderr, brand.CoreBin+" node: ", log.LstdFlags)
	}
	dirs, err := dataDirs(opts.Instance)
	if err != nil {
		return err
	}
	runDir := dirs.Run
	me, err := selfInfo()
	if err != nil {
		return err
	}
	sock := nodeSocket(runDir)
	lock, err := os.OpenFile(filepath.Join(runDir, "node.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if !tryLock(lock) {
		if !takeover {
			return nil
		}
		if err := askTakeover(sock, me); err != nil {
			return fmt.Errorf("take over: %w", err)
		}
		deadline := time.Now().Add(nodeTakeoverWait)
		for !tryLock(lock) {
			if time.Now().After(deadline) {
				return errors.New("take over: the running node keeps its lock")
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	// Holding the lock, the socket at the path is a dead node's or the one
	// a node taking leave left for this one.
	_ = os.Remove(sock)
	l, err := net.Listen("unix", sock)
	if err != nil {
		return err
	}
	if err := os.Chmod(sock, 0o600); err != nil {
		l.Close()
		return err
	}
	logger.Printf("serving %s (build %s, version %s, pid %d)", sock, me.Build, me.Version, me.Pid)
	agent, err := NewAgent(Options{Instance: opts.Instance, Logger: logger})
	if err != nil {
		l.Close()
		return err
	}
	defer agent.Close()

	ctx, stop := context.WithCancel(ctx)
	defer stop()
	n := &node{l: l, sock: sock, lock: lock, stop: stop, agent: agent, logger: logger, me: me}
	n.idle = time.AfterFunc(NodeIdle, n.idleEnd)
	defer n.leave(true)
	go func() {
		<-ctx.Done()
		l.Close()
	}()
	if exe, err := nodeExecutable(); err == nil {
		go retireWhenGone(ctx, exe, nodeExeCheck, func() { n.leave(true) }, logger)
	}
	var running sync.WaitGroup
	for {
		c, err := l.Accept()
		if err != nil {
			if ctx.Err() == nil && !n.left() {
				logger.Printf("accept: %v", err)
			}
			break
		}
		n.join()
		running.Add(1)
		go func() {
			defer running.Done()
			defer n.part()
			n.serve(ctx, c.(*net.UnixConn))
		}()
	}
	running.Wait()
	logger.Printf("stopped")
	return nil
}

// tryLock takes f's lock without waiting.
func tryLock(f *os.File) bool {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil
}

// node is a running node's state.
type node struct {
	l      net.Listener
	sock   string
	lock   *os.File
	stop   context.CancelFunc
	agent  *Agent
	logger *log.Logger
	me     agentproto.NodeInfo
	idle   *time.Timer

	mu       sync.Mutex
	clients  int
	gone     bool // took leave: no new client reaches it
	draining bool // taken over: ends once its clients left
}

func (n *node) join() {
	n.mu.Lock()
	n.clients++
	n.idle.Stop()
	n.mu.Unlock()
}

func (n *node) part() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.clients--
	if n.clients > 0 {
		return
	}
	if n.draining {
		n.stop()
		return
	}
	n.idle.Reset(NodeIdle)
}

// idleEnd ends the node after NodeIdle without clients; a client that
// connects as the timer fires keeps it.
func (n *node) idleEnd() {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.clients == 0 {
		n.stop()
	}
}

func (n *node) left() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.gone
}

// leave gives the socket (removed when unlink: nobody takes it over) and the
// lock up: no new client reaches this node, which ends once its clients
// have left.
func (n *node) leave(unlink bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.gone {
		return
	}
	n.gone = true
	n.l.Close()
	if unlink {
		_ = os.Remove(n.sock)
	}
	n.lock.Close()
}

// takenOver gives way to the node next (NodeTakeover): the socket and lock
// are its, the code-server too, and the cores are told to move.
func (n *node) takenOver(next agentproto.NodeInfo) {
	n.logger.Printf("taken over by build %s (version %s, pid %d); draining", next.Build, next.Version, next.Pid)
	n.leave(false)
	n.agent.drain(next.Pid)
	n.mu.Lock()
	n.draining = true
	n.mu.Unlock()
	time.AfterFunc(nodeDrainMax, n.stop)
}

// nodeExecutable is the file a node runs.
var nodeExecutable = os.Executable

// nodeExeCheck is how often a node checks that its executable is still there.
var nodeExeCheck = 5 * time.Second

// retireWhenGone retires the node once its executable is removed (a
// development build run by `go run`, an uninstalled app): the programs it
// starts (chat host, display keeper, the vault's MCP server) run that file,
// so a node started from another file takes the new clients.
func retireWhenGone(ctx context.Context, exe string, every time.Duration, retire func(), logger *log.Logger) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if _, err := os.Stat(exe); errors.Is(err, os.ErrNotExist) {
				logger.Printf("%s is gone; taking no new client", exe)
				retire()
				return
			}
		}
	}
}

// serve serves one connection to the node: the user's own processes only,
// which say first what they want and learn the node's build.
func (n *node) serve(ctx context.Context, c *net.UnixConn) {
	defer c.Close()
	if _, uid, err := peerCred(c); err != nil || uid != os.Getuid() {
		n.logger.Printf("refused a connection of uid %d (%v)", uid, err)
		return
	}
	var hello agentproto.NodeHello
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	if err := agentproto.ReadLine(c, &hello); err != nil {
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	switch hello.Op {
	case agentproto.NodeServe, agentproto.NodeStop, agentproto.NodeTakeover:
	default:
		_ = agentproto.Fail(c, fmt.Errorf("unknown node op %q", hello.Op))
		return
	}
	me := n.me
	if err := agentproto.WriteLine(c, agentproto.Reply{OK: true, Node: &me}); err != nil {
		return
	}
	switch hello.Op {
	case agentproto.NodeServe:
		if err := n.agent.Serve(ctx, c, hello.Client, hello.SSHConnection); err != nil {
			n.logger.Printf("client: %v", err)
		}
	case agentproto.NodeStop:
		n.logger.Printf("asked to stop")
		n.stop()
	case agentproto.NodeTakeover:
		if hello.Node != nil {
			n.takenOver(*hello.Node)
		}
	}
}

// askTakeover asks the node on sock to give way to me.
func askTakeover(sock string, me agentproto.NodeInfo) error {
	c, _, err := dialNodeSocket(sock, agentproto.NodeHello{Op: agentproto.NodeTakeover, Node: &me})
	if err != nil {
		return err
	}
	return c.Close()
}

// DialNode connects to the instance's node and asks it to serve the
// connection as an agent session for the core client
// (agentproto.NodeHello.Client) that came through sshConn (SSH_CONNECTION;
// empty for the local machine). With no node, or one of an older build, it
// starts one from this executable (which takes over from the older one)
// and connects to that.
func DialNode(ctx context.Context, instance, client, sshConn string, logger *log.Logger) (net.Conn, error) {
	if logger == nil {
		logger = log.New(io.Discard, "", 0)
	}
	dirs, err := dataDirs(instance)
	if err != nil {
		return nil, err
	}
	runDir := dirs.Run
	me, err := selfInfo()
	if err != nil {
		return nil, err
	}
	sock := nodeSocket(runDir)
	hello := agentproto.NodeHello{Op: agentproto.NodeServe, Node: &me, Client: client, SSHConnection: sshConn}
	// usable: this build's node, or a newer one.
	usable := func(n *agentproto.NodeInfo) bool { return n != nil && (n.Build == me.Build || !me.Newer(*n)) }
	c, there, err := dialNodeSocket(sock, hello)
	switch {
	case err == nil && usable(there):
		return c, nil
	case err == nil:
		c.Close()
		if there != nil {
			logger.Printf("node: build %s (%s) takes over from %s (%s)", me.Build, me.Version, there.Build, there.Version)
		}
		err = startNode(instance, dirs.Host, true)
	default:
		err = startNode(instance, dirs.Host, false)
	}
	if err != nil {
		return nil, fmt.Errorf("start the node: %w", err)
	}
	wait, cancel := context.WithTimeout(ctx, nodeStartWait)
	defer cancel()
	for {
		c, there, err := dialNodeSocket(sock, hello)
		if err == nil && usable(there) {
			return c, nil
		}
		if err == nil {
			c.Close() // the old node, still giving way
		}
		select {
		case <-wait.Done():
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			// The node that would not give way still serves.
			if c, _, err := dialNodeSocket(sock, hello); err == nil {
				return c, nil
			}
			return nil, fmt.Errorf("no node answers on %s; see %s: %w", sock, filepath.Join(dirs.Host, "node.log"), err)
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// dialNodeSocket connects to the node on sock, says hello and returns the
// node's build.
func dialNodeSocket(sock string, hello agentproto.NodeHello) (net.Conn, *agentproto.NodeInfo, error) {
	c, err := net.DialTimeout("unix", sock, 5*time.Second)
	if err != nil {
		return nil, nil, err
	}
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	var rep agentproto.Reply
	if err := agentproto.WriteLine(c, hello); err != nil {
		c.Close()
		return nil, nil, err
	}
	if err := agentproto.ReadLine(c, &rep); err != nil {
		c.Close()
		return nil, nil, err
	}
	if !rep.OK {
		c.Close()
		return nil, nil, fmt.Errorf("node: %s", rep.Error)
	}
	_ = c.SetDeadline(time.Time{})
	return c, rep.Node, nil
}

// startNode starts `node` from this executable in a session of its own,
// with its output in this host's node.log of the instance (hostDir), and
// does not wait for it.
func startNode(instance, hostDir string, takeover bool) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	logPath := filepath.Join(hostDir, "node.log")
	if st, err := os.Stat(logPath); err == nil && st.Size() > nodeLogMax {
		_ = os.Rename(logPath, filepath.Join(hostDir, "node.old.log"))
	}
	out, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	args := []string{"node", "--instance", instance}
	if takeover {
		args = append(args, "--takeover")
	}
	cmd := exec.Command(exe, args...)
	cmd.Stdout = out
	cmd.Stderr = out
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	// Reaped when it ends; a client that exits first leaves it to init.
	go func() { _ = cmd.Wait() }()
	return nil
}

// StopNodes asks every node of the instance to stop (also those of earlier
// builds, on node-<build>.sock), and reports how many did.
func StopNodes(instance string) (int, error) {
	dirs, err := hostdirs.For(instance)
	if err != nil {
		return 0, err
	}
	runDir := dirs.Run
	socks, _ := filepath.Glob(filepath.Join(runDir, "node*.sock"))
	n := 0
	for _, sock := range socks {
		c, err := net.DialTimeout("unix", sock, 5*time.Second)
		if err != nil {
			continue
		}
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		var rep agentproto.Reply
		if agentproto.WriteLine(c, agentproto.NodeHello{Op: agentproto.NodeStop}) == nil && agentproto.ReadLine(c, &rep) == nil && rep.OK {
			n++
		}
		c.Close()
	}
	return n, nil
}
