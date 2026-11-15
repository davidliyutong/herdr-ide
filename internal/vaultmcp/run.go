package vaultmcp

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

// Defaults of run_with_env.
const (
	DefaultTimeout = 120 * time.Second
	MaxTimeout     = 600 * time.Second
	MaxOutput      = 64 << 10
	// maxValue is the longest value the vault keeps: output is captured
	// that much beyond MaxOutput so a value cut by the limit is still
	// masked.
	maxValue = 64 << 10
)

// Runner runs run_with_env's commands.
type Runner struct {
	// Shell runs the command with -c (default sh).
	Shell string
	// MaxOutput is how much output is returned (default MaxOutput).
	MaxOutput int
	// DefaultTimeout and MaxTimeout bound a command's time (defaults
	// DefaultTimeout and MaxTimeout).
	DefaultTimeout, MaxTimeout time.Duration
}

// capped keeps the first max bytes written and counts the rest.
type capped struct {
	mu    sync.Mutex
	b     []byte
	max   int
	total int
}

func (c *capped) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total += len(p)
	if room := c.max - len(c.b); room > 0 {
		c.b = append(c.b, p[:min(room, len(p))]...)
	}
	return len(p), nil
}

// Mask replaces every occurrence of the values in s with ***, longest
// values first. It hides values as they are, not encoded or split.
func Mask(s string, values map[string]string) string {
	vs := make([]string, 0, len(values))
	for _, v := range values {
		if v != "" {
			vs = append(vs, v)
		}
	}
	sort.Slice(vs, func(i, j int) bool { return len(vs[i]) > len(vs[j]) })
	for _, v := range vs {
		s = strings.ReplaceAll(s, v, "***")
	}
	return s
}

// Run runs command with sh -c in dir with env added to this process's
// environment, and returns the exit status and the masked output; failed
// when the command failed, timed out or could not start.
func (r Runner) Run(ctx context.Context, command string, env map[string]string, dir string, timeout time.Duration) (out string, failed bool) {
	shell, limit, def, maxT := r.Shell, r.MaxOutput, r.DefaultTimeout, r.MaxTimeout
	if shell == "" {
		shell = "sh"
	}
	if limit <= 0 {
		limit = MaxOutput
	}
	if def <= 0 {
		def = DefaultTimeout
	}
	if maxT <= 0 {
		maxT = MaxTimeout
	}
	if timeout <= 0 {
		timeout = def
	}
	timeout = min(timeout, maxT)
	cmd := exec.Command(shell, "-c", command)
	cmd.Dir = dir
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	buf := &capped{max: limit + maxValue}
	cmd.Stdout, cmd.Stderr = buf, buf
	// Programs left in the background must not keep the call open (they
	// hold the output's pipe), nor outlive it with the values in their
	// environment: the group is killed whenever the command returns.
	cmd.WaitDelay = 2 * time.Second
	newGroup(cmd)
	if err := cmd.Start(); err != nil {
		return Mask("cannot start: "+err.Error(), env), true
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var err error
	var note string
	select {
	case err = <-done:
		killGroup(cmd)
	case <-timer.C:
		killGroup(cmd)
		err = <-done
		note = fmt.Sprintf("[timed out after %s; the command was killed]\n", timeout)
	case <-ctx.Done():
		killGroup(cmd)
		err = <-done
		note = "[cancelled; the command was killed]\n"
	}
	buf.mu.Lock()
	output := Mask(string(buf.b), env)
	total := buf.total
	buf.mu.Unlock()
	truncated := total > limit
	if len(output) > limit {
		output = output[:limit]
		truncated = true
	}
	// The exit status of the shell, also when Wait gave up on the output
	// of programs it left in the background (exec.ErrWaitDelay).
	status := -1
	if cmd.ProcessState != nil {
		status = cmd.ProcessState.ExitCode()
	} else if err == nil {
		status = 0
	}
	var bg string
	if errors.Is(err, exec.ErrWaitDelay) && note == "" {
		bg = "[programs left in the background were killed]\n"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "exit status: %d\n", status)
	b.WriteString(note)
	b.WriteString(bg)
	b.WriteString(output)
	if truncated {
		if !strings.HasSuffix(output, "\n") {
			b.WriteString("\n")
		}
		fmt.Fprintf(&b, "[output truncated: %d of %d bytes]\n", limit, total)
	}
	return b.String(), status != 0 || note != ""
}
