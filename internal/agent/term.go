package agent

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"herdr-ide/internal/agentproto"
)

// handleTerm runs `herdr terminal session control|observe` and connects its
// JSON-lines stdio to the stream. Closing the stream's write side ends stdin,
// which makes herdr send Detach (terminal.release) and exit.
func (a *Agent) handleTerm(ctx context.Context, st net.Conn, h agentproto.Header) error {
	defer st.Close()
	if h.Mode != "control" && h.Mode != "observe" {
		return agentproto.Fail(st, fmt.Errorf("term: bad mode %q", h.Mode))
	}
	if h.Target == "" || h.Cols <= 0 || h.Rows <= 0 {
		return agentproto.Fail(st, errors.New("term: target, cols and rows are required"))
	}
	bin, err := a.resolveHerdr(h.HerdrBin)
	if err != nil {
		return agentproto.Fail(st, err)
	}
	args := []string{"terminal", "session", h.Mode, h.Target,
		"--cols", strconv.Itoa(h.Cols), "--rows", strconv.Itoa(h.Rows)}
	if h.Mode == "control" && h.Takeover {
		args = append(args, "--takeover")
	}
	cmd := exec.Command(bin, herdrArgs(h.Session, args...)...)
	cmd.Env = cleanEnv()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return agentproto.Fail(st, err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return agentproto.Fail(st, err)
	}
	var stderr tailBuffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return agentproto.Fail(st, err)
	}
	if err := agentproto.WriteLine(st, agentproto.Reply{OK: true}); err != nil {
		killGroup(cmd)
		cmd.Wait()
		return err
	}

	done := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(done) }) }

	// stream -> herdr stdin
	go func() {
		io.Copy(stdin, st)
		stdin.Close()
		// Give herdr a moment to release control gracefully.
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			killGroup(cmd)
		}
	}()
	// herdr stdout -> stream
	go func() {
		io.Copy(st, stdout)
		finish()
	}()
	select {
	case <-done:
	case <-ctx.Done():
		killGroup(cmd)
		<-done
	}
	err = cmd.Wait()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		agentproto.WriteLine(st, map[string]string{"type": "agent.error", "message": msg})
	}
	return nil
}

func killGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	time.AfterFunc(2*time.Second, func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	})
}

// cleanEnv drops herdr pane context inherited from a parent herdr pane so the
// CLI does not treat itself as running inside one.
func cleanEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		switch k {
		case "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SESSION":
			continue
		}
		env = append(env, kv)
	}
	return env
}

// tailBuffer keeps the last 8 KiB written to it.
type tailBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf.Write(p)
	if t.buf.Len() > 8192 {
		b := t.buf.Bytes()
		keep := append([]byte(nil), b[len(b)-8192:]...)
		t.buf.Reset()
		t.buf.Write(keep)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.buf.String()
}
