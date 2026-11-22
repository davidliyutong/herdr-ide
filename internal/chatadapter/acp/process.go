//go:build unix

package acp

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// stderrKeep is how much of the end of an agent's standard error is
	// kept, for the error of a session that ended.
	stderrKeep = 16 << 10
	// stderrDrain is how long the rest of an agent's standard error is
	// waited for once its process group is gone: a program that left the
	// group may hold the pipe open.
	stderrDrain = time.Second
	// groupPoll is how often stop looks whether a process group is gone.
	groupPoll = 20 * time.Millisecond
)

// process is an agent's program: a process group of its own, with pipes to
// its standard input and from its standard output, and the end of what it
// wrote to its standard error.
type process struct {
	cmd    *exec.Cmd
	pgid   int
	stdin  *os.File // the write end
	stdout *os.File // the read end
	errR   *os.File // the read end of its standard error
	tail   *ring

	exited  chan struct{} // closed once the process was waited for
	drained chan struct{} // closed once its standard error was read to its end
	once    sync.Once
	stopped chan struct{} // closed once stop did all it does
}

// startProcess runs argv (argv[0] an absolute path) in dir with env as the
// whole environment, in a process group of its own. Whoever started it ends
// it with stop, also when it exited by itself: what it left running in its
// group goes then.
func startProcess(argv []string, dir string, env []string) (*process, error) {
	if len(argv) == 0 || !strings.HasPrefix(argv[0], "/") {
		return nil, errors.New("the agent's command is not an absolute path")
	}
	var pipes []*os.File
	closeAll := func() {
		for _, f := range pipes {
			f.Close()
		}
	}
	pipe := func() (r, w *os.File, err error) {
		if r, w, err = os.Pipe(); err == nil {
			pipes = append(pipes, r, w)
		}
		return
	}
	inR, inW, err := pipe()
	if err != nil {
		return nil, err
	}
	outR, outW, err := pipe()
	if err != nil {
		closeAll()
		return nil, err
	}
	errR, errW, err := pipe()
	if err != nil {
		closeAll()
		return nil, err
	}
	cmd := &exec.Cmd{
		Path: argv[0], Args: argv, Dir: dir, Env: env,
		Stdin: inR, Stdout: outW, Stderr: errW,
		// A group of its own: the agent goes with what it started, and a
		// signal to the host's group does not reach it.
		SysProcAttr: &syscall.SysProcAttr{Setpgid: true},
	}
	if err := cmd.Start(); err != nil {
		closeAll()
		return nil, err
	}
	inR.Close()
	outW.Close()
	errW.Close()
	p := &process{
		cmd: cmd, pgid: cmd.Process.Pid, stdin: inW, stdout: outR, errR: errR,
		tail:   &ring{max: stderrKeep},
		exited: make(chan struct{}), drained: make(chan struct{}), stopped: make(chan struct{}),
	}
	go func() {
		cmd.Wait()
		close(p.exited)
	}()
	go func() {
		io.Copy(p.tail, errR)
		close(p.drained)
	}()
	return p, nil
}

// stop ends the process group gracefully, without waiting for it: the
// agent's input is closed, and an agent that is still there grace later
// gets SIGTERM, with the rest of its group; what is left of the group term
// after that gets SIGKILL. A group the agent left behind when it exited
// gets the same, from SIGTERM on. The pipes are closed then, and stopped
// is closed.
func (p *process) stop(grace, term time.Duration) {
	p.once.Do(func() {
		go func() {
			defer close(p.stopped)
			p.stdin.Close()
			if !wait(p.exited, grace) {
				p.signal(syscall.SIGTERM)
				if !wait(p.exited, term) {
					p.signal(syscall.SIGKILL)
				}
				<-p.exited
			}
			// The agent is gone; what it started in its group goes too.
			if p.groupAlive() {
				p.signal(syscall.SIGTERM)
				deadline := time.Now().Add(term)
				for p.groupAlive() && time.Now().Before(deadline) {
					time.Sleep(groupPoll)
				}
				if p.groupAlive() {
					p.signal(syscall.SIGKILL)
				}
			}
			if !wait(p.drained, stderrDrain) {
				p.errR.Close()
				<-p.drained
			}
			p.errR.Close()
			p.stdout.Close()
		}()
	})
}

// kill ends the process group at once: for an agent that never got its
// session.
func (p *process) kill() {
	p.signal(syscall.SIGKILL)
	p.stop(0, 0)
}

// wait returns whether ch was closed within d.
func wait(ch <-chan struct{}, d time.Duration) bool {
	if d <= 0 {
		select {
		case <-ch:
			return true
		default:
			return false
		}
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ch:
		return true
	case <-t.C:
		return false
	}
}

func (p *process) signal(sig syscall.Signal) { syscall.Kill(-p.pgid, sig) }

// groupAlive tells whether a process of the agent's group is still there.
func (p *process) groupAlive() bool { return syscall.Kill(-p.pgid, 0) == nil }

// stderr is the end of what the process wrote to its standard error.
func (p *process) stderr() string { return p.tail.String() }

// status is how the process ended ("exit status 1"), once it did.
func (p *process) status() string {
	select {
	case <-p.exited:
		if st := p.cmd.ProcessState; st != nil {
			return st.String()
		}
	default:
	}
	return ""
}

// ring keeps the last max bytes written to it.
type ring struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (r *ring) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := len(p)
	if len(p) >= r.max {
		p = p[len(p)-r.max:]
		r.buf = r.buf[:0]
	} else if over := len(r.buf) + len(p) - r.max; over > 0 {
		r.buf = r.buf[:copy(r.buf, r.buf[over:])]
	}
	r.buf = append(r.buf, p...)
	return n, nil
}

// String is what the ring holds, as text: bytes that are no UTF-8, and a
// character cut at the ring's start, become U+FFFD.
func (r *ring) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.ToValidUTF8(string(r.buf), "�")
}
