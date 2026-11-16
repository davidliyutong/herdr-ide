package vaultmcp

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
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
	return maskOutput(s, values, false)
}

// maskOutput is Mask for output whose capture was cut (cut): its last bytes
// may be the beginning of a value, which no occurrence matches, and which
// masking the rest would bring within the returned part (*** is shorter
// than most values). Bytes that could be (fewer than the longest value's
// length from the end) are dropped, but for an occurrence that began
// before them, which is masked whole.
func maskOutput(s string, values map[string]string, cut bool) string {
	vs := make([]string, 0, len(values))
	for _, v := range values {
		if v != "" {
			vs = append(vs, v)
		}
	}
	if len(vs) == 0 {
		return s
	}
	sort.Slice(vs, func(i, j int) bool { return len(vs[i]) > len(vs[j]) })
	end := len(s)
	if cut {
		end = max(0, len(s)-(len(vs[0])-1))
	}
	// Occurrences, longest values first, none overlapping another: spans
	// stays sorted, so the first one ending after a candidate's start is
	// the one it could overlap.
	type span struct{ from, to int }
	var spans []span
	for _, v := range vs {
		var found []span
		for at := 0; at < len(s); {
			i := strings.Index(s[at:], v)
			if i < 0 {
				break
			}
			i += at
			if k := sort.Search(len(spans), func(k int) bool { return spans[k].to > i }); k < len(spans) && spans[k].from < i+len(v) {
				at = spans[k].to // every start before it overlaps it too
				continue
			}
			found = append(found, span{i, i + len(v)})
			at = i + len(v)
		}
		spans = append(spans, found...)
		slices.SortFunc(spans, func(a, b span) int { return a.from - b.from })
	}
	var b strings.Builder
	at := 0
	for _, sp := range spans {
		if sp.from >= end {
			break
		}
		b.WriteString(s[at:sp.from])
		b.WriteString("***")
		at = sp.to
	}
	if at < end {
		b.WriteString(s[at:end])
	}
	return b.String()
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
	// environment: the group is killed whenever the command returns, and
	// when the server is gone (watchServer).
	cmd.WaitDelay = 2 * time.Second
	newGroup(cmd)
	started, over, err := watchServer(cmd)
	if err != nil {
		return Mask("cannot start: "+err.Error(), env), true
	}
	defer over()
	if err := cmd.Start(); err != nil {
		return Mask("cannot start: "+err.Error(), env), true
	}
	started()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
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
	total := buf.total
	output := maskOutput(string(buf.b), env, total > len(buf.b))
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
