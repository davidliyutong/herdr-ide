//go:build unix

package codex

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// startProcess runs argv (argv[0] an absolute path) in dir with env as its
// whole environment, in a process group of its own: a command the
// app-server left running goes with it, and a signal to the host's group
// does not reach it.
func startProcess(argv []string, dir string, env []string) (*process, error) {
	if len(argv) == 0 {
		return nil, errors.New("codex: no command")
	}
	var files []*os.File
	closeAll := func() {
		for _, f := range files {
			f.Close()
		}
	}
	pipe := func() (r, w *os.File, err error) {
		if r, w, err = os.Pipe(); err == nil {
			files = append(files, r, w)
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
		SysProcAttr: &syscall.SysProcAttr{Setpgid: true},
	}
	if err := cmd.Start(); err != nil {
		closeAll()
		return nil, err
	}
	inR.Close()
	outW.Close()
	errW.Close()
	p := newProcess(cmd.Process.Pid, inW, outR)
	drained := make(chan struct{})
	go func() {
		io.Copy(p.tail, errR)
		close(drained)
	}()
	go func() {
		p.waitErr = cmd.Wait()
		close(p.exited)
		go p.sweep()
		// A command the app-server left behind may hold its output and
		// its standard error open: what came before its end is read for
		// a while, then the pipes are closed.
		t := time.NewTimer(drainWait)
		select {
		case <-drained:
		case <-t.C:
		}
		t.Stop()
		errR.Close()
		time.AfterFunc(drainWait, func() { outR.Close() })
	}()
	return p, nil
}

// groupPoll is how often a sweep looks whether the process group is gone.
const groupPoll = 20 * time.Millisecond

// signal sends sig to the process group; false when there is none left.
func (p *process) signal(sig syscall.Signal) bool {
	return syscall.Kill(-p.pid, sig) == nil
}

// groupAlive tells whether a process of the app-server's group is still
// there.
func (p *process) groupAlive() bool { return syscall.Kill(-p.pid, 0) == nil }

// sweep ends what the app-server left running in its group once it is
// gone, whether it was ended or exited by itself: the commands it started
// get SIGTERM, and what is still there killWait later SIGKILL.
func (p *process) sweep() {
	defer close(p.swept)
	if !p.groupAlive() {
		return
	}
	p.signal(syscall.SIGTERM)
	deadline := time.Now().Add(killWait)
	for p.groupAlive() && time.Now().Before(deadline) {
		time.Sleep(groupPoll)
	}
	if p.groupAlive() {
		p.signal(syscall.SIGKILL)
	}
}

// end ends the app-server gracefully: its input closed, then SIGTERM to its
// group after closeWait, then SIGKILL after killWait more (a Codex killed
// outright leaves its shell snapshots in ~/.codex/shell_snapshots). It
// returns once the process was waited for and what it left running in its
// group was ended (sweep).
func (p *process) end() {
	p.endOnce.Do(func() {
		p.stdin.Close()
		if !p.waitExit(closeWait) {
			p.signal(syscall.SIGTERM)
			if !p.waitExit(killWait) {
				p.signal(syscall.SIGKILL)
				<-p.exited
			}
		}
	})
	<-p.exited
	<-p.swept
}

func (p *process) waitExit(d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-p.exited:
		return true
	case <-t.C:
		return false
	}
}
