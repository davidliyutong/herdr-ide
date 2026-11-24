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
	"sync/atomic"
	"syscall"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
)

// A machine's node is the agent as a service: a process of its own that
// listens on a socket in the instance's run directory and serves every
// client that connects as a session of one agent (Agent.Serve), the core
// of the machine itself as well as cores that came over ssh (`node dial`):
// they share its code-server, displays and sockets. It
// runs detached from its clients, in a session of its own, and ends once it
// has had no client for NodeIdle.
//
// Each build has its own node, socket and lock (node-<build>.sock,
// node-<build>.lock): a client reaches the node of its own build, which
// speaks its protocol, while a node of another build serves its own clients
// until they leave.

// NodeIdle is how long a node runs without a client.
var NodeIdle = 15 * time.Second

// nodeStartWait bounds how long a client waits for a node it started.
var nodeStartWait = 15 * time.Second

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

func nodeSocket(runDir, build string) string {
	return filepath.Join(runDir, "node-"+build+".sock")
}

// RunNode serves the instance's node of this build until it has had no
// client for NodeIdle, a client asks it to stop or ctx ends. It returns nil
// at once when a node of this build already serves the instance.
func RunNode(ctx context.Context, opts Options) error {
	logger := opts.Logger
	if logger == nil {
		logger = log.New(os.Stderr, brand.CoreBin+" node: ", log.LstdFlags)
	}
	_, _, runDir, err := dataDirs(opts.Instance, logger)
	if err != nil {
		return err
	}
	build, err := BuildID()
	if err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(runDir, "node-"+build+".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil
		}
		return err
	}
	// Holding the lock, any socket at the path is a dead node's.
	sock := nodeSocket(runDir, build)
	_ = os.Remove(sock)
	l, err := net.Listen("unix", sock)
	if err != nil {
		return err
	}
	if err := os.Chmod(sock, 0o600); err != nil {
		l.Close()
		return err
	}
	logger.Printf("serving %s (build %s, pid %d)", sock, build, os.Getpid())
	agent, err := NewAgent(Options{Instance: opts.Instance, Logger: logger})
	if err != nil {
		l.Close()
		return err
	}
	defer agent.Close()

	// Retiring gives the socket and the lock up: no new client reaches
	// this node, which ends once its clients have left.
	var (
		retireOnce sync.Once
		retired    atomic.Bool
	)
	retire := func() {
		retireOnce.Do(func() {
			retired.Store(true)
			l.Close()
			_ = os.Remove(sock)
			lock.Close()
		})
	}
	defer retire()
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	go func() {
		<-ctx.Done()
		l.Close()
	}()
	if exe, err := nodeExecutable(); err == nil {
		go retireWhenGone(ctx, exe, nodeExeCheck, retire, logger)
	}
	var (
		mu      sync.Mutex
		clients int
		running sync.WaitGroup
	)
	// A client that connects while the timer fires keeps the node.
	idle := time.AfterFunc(NodeIdle, func() {
		mu.Lock()
		defer mu.Unlock()
		if clients == 0 {
			stop()
		}
	})
	for {
		c, err := l.Accept()
		if err != nil {
			if ctx.Err() == nil && !retired.Load() {
				logger.Printf("accept: %v", err)
			}
			break
		}
		mu.Lock()
		clients++
		idle.Stop()
		mu.Unlock()
		running.Add(1)
		go func() {
			defer running.Done()
			defer func() {
				mu.Lock()
				clients--
				if clients == 0 {
					idle.Reset(NodeIdle)
				}
				mu.Unlock()
			}()
			serveNodeClient(ctx, agent, c.(*net.UnixConn), logger, stop)
		}()
	}
	running.Wait()
	logger.Printf("stopped")
	return nil
}

// nodeExecutable is the file a node runs.
var nodeExecutable = os.Executable

// nodeExeCheck is how often a node checks that its executable is still there.
var nodeExeCheck = 5 * time.Second

// retireWhenGone retires the node once its executable is removed (a
// development build run by `go run`, an uninstalled app): the programs it
// starts (chat host, display keeper, the vault's MCP server) run that file,
// so a node of the same build started from another file takes the new
// clients.
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

// serveNodeClient serves one connection to the node: the user's own
// processes only, which say first what they want.
func serveNodeClient(ctx context.Context, agent *Agent, c *net.UnixConn, logger *log.Logger, stop func()) {
	defer c.Close()
	if _, uid, err := peerCred(c); err != nil || uid != os.Getuid() {
		logger.Printf("refused a connection of uid %d (%v)", uid, err)
		return
	}
	var hello agentproto.NodeHello
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	if err := agentproto.ReadLine(c, &hello); err != nil {
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	switch hello.Op {
	case agentproto.NodeServe:
		if err := agent.Serve(ctx, c, hello.Client, hello.SSHConnection); err != nil {
			logger.Printf("client: %v", err)
		}
	case agentproto.NodeStop:
		logger.Printf("asked to stop")
		_ = agentproto.WriteLine(c, agentproto.Reply{OK: true})
		stop()
	default:
		_ = agentproto.Fail(c, fmt.Errorf("unknown node op %q", hello.Op))
	}
}

// DialNode connects to the instance's node of this build, starting one from
// this executable when none answers, and asks it to serve the connection as
// an agent session for the core client (agentproto.NodeHello.Client) that
// came through sshConn (SSH_CONNECTION; empty for the local machine).
func DialNode(ctx context.Context, instance, client, sshConn string, logger *log.Logger) (net.Conn, error) {
	if logger == nil {
		logger = log.New(io.Discard, "", 0)
	}
	_, base, runDir, err := dataDirs(instance, logger)
	if err != nil {
		return nil, err
	}
	build, err := BuildID()
	if err != nil {
		return nil, err
	}
	sock := nodeSocket(runDir, build)
	hello := agentproto.NodeHello{Op: agentproto.NodeServe, Client: client, SSHConnection: sshConn}
	if c, err := dialNodeSocket(sock, hello); err == nil {
		return c, nil
	}
	if err := startNode(instance, base); err != nil {
		return nil, fmt.Errorf("start the node: %w", err)
	}
	wait, cancel := context.WithTimeout(ctx, nodeStartWait)
	defer cancel()
	for {
		c, err := dialNodeSocket(sock, hello)
		if err == nil {
			return c, nil
		}
		select {
		case <-wait.Done():
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, fmt.Errorf("no node answers on %s; see %s: %w", sock, filepath.Join(base, "node.log"), err)
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func dialNodeSocket(sock string, hello agentproto.NodeHello) (net.Conn, error) {
	c, err := net.DialTimeout("unix", sock, 5*time.Second)
	if err != nil {
		return nil, err
	}
	if err := agentproto.WriteLine(c, hello); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

// startNode starts `node` from this executable in a session of its own,
// with its output in the instance's node.log, and does not wait for it.
func startNode(instance, base string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	logPath := filepath.Join(base, "node.log")
	if st, err := os.Stat(logPath); err == nil && st.Size() > nodeLogMax {
		_ = os.Rename(logPath, filepath.Join(base, "node.old.log"))
	}
	out, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	cmd := exec.Command(exe, "node", "--instance", instance)
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

// StopNodes asks every node of the instance, of any build, to stop, and
// reports how many did.
func StopNodes(instance string) (int, error) {
	_, _, runDir, err := dataDirs(instance, log.New(io.Discard, "", 0))
	if err != nil {
		return 0, err
	}
	socks, _ := filepath.Glob(filepath.Join(runDir, "node-*.sock"))
	n := 0
	for _, sock := range socks {
		c, err := dialNodeSocket(sock, agentproto.NodeHello{Op: agentproto.NodeStop})
		if err != nil {
			continue
		}
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		var rep agentproto.Reply
		if agentproto.ReadLine(c, &rep) == nil && rep.OK {
			n++
		}
		c.Close()
	}
	return n, nil
}
