package agent

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"herdr-ide/internal/brand"
)

// The display keeper ties Xvfb to the herdr server whose panes use it. Xvfb
// exits guiIdleSeconds after its last client left; its clients are the
// agent's window manager (while the core is connected), programs, and the
// keeper: the agent binary run as "gui-keep", which holds a connection to
// the display while the session's herdr server runs. So the display stays
// while panes may start programs on it, and ends soon after the server
// stops and the programs exit. One keeper runs per instance
// (run/gui-keep.lock); it follows a server that restarts within keepGrace.

const (
	keepPoll  = 5 * time.Second
	keepGrace = 30 * time.Second
)

func (g *gui) keepLockPath() string { return filepath.Join(g.a.runDir, "gui-keep.lock") }

// lockKeeper takes the keeper's lock without waiting; nil when another
// keeper holds it.
func lockKeeper(path string) *os.File {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil
	}
	if syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		f.Close()
		return nil
	}
	return f
}

// keep starts a keeper for the session's server unless one runs or the
// display does not. A keeper may be about to leave (its server was gone
// for keepGrace) as the request comes: then it is tried once more after
// keepPoll.
func (g *gui) keep(session string) error {
	started, err := g.startKeeper(session)
	if err == nil && !started {
		time.AfterFunc(keepPoll+time.Second, func() {
			if _, err := g.startKeeper(session); err != nil {
				g.a.logger.Printf("gui: keeping the display: %v", err)
			}
		})
	}
	return err
}

// startKeeper starts a keeper unless one runs (false) or the display does
// not (true: nothing to try again).
func (g *gui) startKeeper(session string) (bool, error) {
	st := g.readState()
	if st.Display == 0 || !g.running(st.Display) {
		return true, nil
	}
	f := lockKeeper(g.keepLockPath())
	if f == nil {
		return false, nil // one runs
	}
	f.Close()
	exe, err := os.Executable()
	if err != nil {
		return true, err
	}
	cmd := exec.Command(exe, "gui-keep", "--instance", g.a.instance, "--session", session)
	cmd.Env = cleanEnv()
	cmd.Dir = g.a.home
	// Its own session: it outlives the agent and the ssh connection.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if lf, err := os.OpenFile(filepath.Join(g.a.base, "gui-keep.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err == nil {
		cmd.Stdout, cmd.Stderr = lf, lf
		defer lf.Close()
	}
	if err := cmd.Start(); err != nil {
		return true, err
	}
	go cmd.Wait()
	return true, nil
}

// KeepDisplay is the "gui-keep" command: it holds a connection to the
// instance's display until the session's herdr server stopped (and no new
// one came within keepGrace), the display ended or ctx is done.
func KeepDisplay(ctx context.Context, instance, session string, logger *log.Logger) error {
	if !brand.ValidInstance(instance) {
		return fmt.Errorf("invalid instance name %q", instance)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	base := filepath.Join(home, brand.DataDir(instance))
	a := &Agent{logger: logger, home: home, base: base, runDir: filepath.Join(base, "run"), instance: instance}
	return (&gui{a: a}).keepDisplay(ctx, session, keepPoll, keepGrace)
}

func (g *gui) keepDisplay(ctx context.Context, session string, poll, grace time.Duration) error {
	lock := lockKeeper(g.keepLockPath())
	if lock == nil {
		return nil // another keeper
	}
	defer lock.Close()
	st := g.readState()
	if st.Display == 0 || !g.running(st.Display) {
		return nil
	}
	x, err := g.connect(st.Display)
	if err != nil {
		return err
	}
	defer x.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		// No events are selected: this returns when the display ends.
		for {
			if ev, err := x.WaitForEvent(); ev == nil && err == nil {
				cancel()
				return
			}
		}
	}()
	socket := g.a.herdrSocket(session)
	g.a.logger.Printf("keeping display :%d while the herdr server at %s runs", st.Display, socket)
	err = watchServer(ctx, socket, poll, grace)
	g.a.logger.Printf("done: %v", err)
	return nil
}

// watchServer returns nil once the herdr server listening on socket has
// stopped and none took its place within grace, or ctx's error.
func watchServer(ctx context.Context, socket string, poll, grace time.Duration) error {
	t := time.NewTicker(poll)
	defer t.Stop()
	var srv serverProc
	gone := time.Now()
	for {
		if srv.alive() {
			gone = time.Now()
		} else if srv = findServer(socket); srv.pid != 0 {
			gone = time.Now()
		} else if time.Since(gone) > grace {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// serverProc is a process, told apart from a later one with its pid by
// its start time.
type serverProc struct {
	pid   int
	start string
}

// findServer returns this user's process listening on socket.
func findServer(socket string) serverProc {
	c, err := net.DialTimeout("unix", socket, time.Second)
	if err != nil {
		return serverProc{}
	}
	defer c.Close()
	pid, uid, err := peerCred(c.(*net.UnixConn))
	if err != nil || uid != os.Getuid() || pid <= 0 {
		return serverProc{}
	}
	start, err := procStart(pid)
	if err != nil {
		return serverProc{}
	}
	return serverProc{pid: pid, start: start}
}

func (p serverProc) alive() bool {
	if p.pid == 0 {
		return false
	}
	start, err := procStart(p.pid)
	return err == nil && start == p.start
}

// procStart is a process's start time (field 22 of /proc/<pid>/stat).
func procStart(pid int) (string, error) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return "", err
	}
	// The command name in parentheses may contain spaces; the fields after
	// it start with the third.
	i := strings.LastIndexByte(string(b), ')')
	if i < 0 {
		return "", errors.New("unexpected stat")
	}
	f := strings.Fields(string(b[i+1:]))
	if len(f) < 20 {
		return "", errors.New("unexpected stat")
	}
	return f[19], nil
}
