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

// signal sends sig to the process group; false when there is none left.
func (p *process) signal(sig syscall.Signal) bool {
	return syscall.Kill(-p.pid, sig) == nil
}

// end ends the app-server gracefully: its input closed, then SIGTERM to its
// group after closeWait, then SIGKILL after killWait more (a Codex killed
// outright leaves its shell snapshots in ~/.codex/shell_snapshots). Once
// the app-server itself is gone, what is left of its group gets SIGTERM:
// the commands it started and left running. It returns once the process
// was waited for.
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
		p.signal(syscall.SIGTERM)
	})
	<-p.exited
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
