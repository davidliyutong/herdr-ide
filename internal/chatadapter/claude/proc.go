//go:build unix

package claude

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"time"

	"herdr-ide/internal/chatproto"
)

// proc is one run of the claude program: its pipes, the control requests
// it was sent and waits to answer, and the requests of its own being
// answered.
type proc struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	out   io.ReadCloser
	// wmu orders the lines written to stdin.
	wmu sync.Mutex
	// stderr keeps the end of what the program wrote to its standard error.
	stderr *tail
	// exited is closed once the program was waited for; waitErr is why it
	// ended.
	exited  chan struct{}
	waitErr error
	// prefix makes this run's control request ids its own.
	prefix string
	// closeGrace and killGrace are the package's at the run's start.
	closeGrace, killGrace time.Duration

	mu      sync.Mutex
	next    int
	pending map[string]*call
	// gone: the program's output ended; no answer comes any more.
	gone bool
	// incoming are the cancels of the program's own requests being
	// answered (control_cancel_request), by request id.
	incoming map[string]context.CancelFunc
	// stopping: stop was called.
	stopping bool
}

// call is a control request waiting for its answer: done is closed with
// resp or err set, or fn is called with them.
type call struct {
	done chan struct{}
	resp json.RawMessage
	err  error
	fn   func(json.RawMessage, error)
}

// tail keeps the last bytes written to it.
type tail struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - t.max; over > 0 {
		t.buf = append(t.buf[:0], t.buf[over:]...)
	}
	return len(p), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

// startProc starts argv in dir with env as its whole environment, in a
// process group of its own.
func startProc(argv, env []string, dir string) (*proc, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env, cmd.Dir = env, dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	p := &proc{cmd: cmd, stderr: &tail{max: maxStderr}, exited: make(chan struct{}), pending: map[string]*call{}, incoming: map[string]context.CancelFunc{},
		closeGrace: closeGrace, killGrace: killGrace}
	cmd.Stderr = p.stderr
	var err error
	if p.stdin, err = cmd.StdinPipe(); err != nil {
		return nil, err
	}
	if p.out, err = cmd.StdoutPipe(); err != nil {
		return nil, err
	}
	var b [4]byte
	rand.Read(b[:])
	p.prefix = "req_" + hex.EncodeToString(b[:]) + "_"
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go func() {
		p.waitErr = cmd.Wait()
		close(p.exited)
	}()
	return p, nil
}

// reader is the program's standard output, a line at a time.
func (p *proc) reader() *bufio.Reader { return bufio.NewReaderSize(p.out, 64<<10) }

// write writes v as one line.
func (p *proc) write(v any) error {
	b, err := chatproto.Line(v)
	if err != nil {
		return err
	}
	p.wmu.Lock()
	defer p.wmu.Unlock()
	if _, err := p.stdin.Write(b); err != nil {
		return &chatproto.Error{Code: chatproto.CodeEnded, Message: "claude: the agent's input is closed: " + err.Error()}
	}
	return nil
}

// controlRequest is a control request of either side.
type controlRequest struct {
	Type      string          `json:"type"`
	RequestID string          `json:"request_id"`
	Request   json.RawMessage `json:"request"`
}

// controlResponse is the answer to a control request, of either side.
type controlResponse struct {
	Type     string       `json:"type"`
	Response responseBody `json:"response"`
}

type responseBody struct {
	Subtype   string          `json:"subtype"`
	RequestID string          `json:"request_id"`
	Response  json.RawMessage `json:"response,omitempty"`
	Error     string          `json:"error,omitempty"`
}

// send writes the control request of subtype with the members of body (an
// object, or nil) and registers c for its answer.
func (p *proc) send(subtype string, body any, c *call) (string, error) {
	req := map[string]any{}
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return "", err
		}
		if err := json.Unmarshal(b, &req); err != nil {
			return "", err
		}
	}
	req["subtype"] = subtype
	p.mu.Lock()
	if p.gone {
		p.mu.Unlock()
		return "", errGone
	}
	p.next++
	id := p.prefix + strconv.Itoa(p.next)
	p.pending[id] = c
	p.mu.Unlock()
	if err := p.write(controlRequest{Type: "control_request", RequestID: id, Request: mustJSON(req)}); err != nil {
		p.mu.Lock()
		delete(p.pending, id)
		p.mu.Unlock()
		return "", err
	}
	return id, nil
}

// errGone is the error of a request to a program whose output ended.
var errGone = &chatproto.Error{Code: chatproto.CodeEnded, Message: "claude: the agent ended"}

// request sends a control request and waits for its answer, at most
// timeout and until ctx ends.
func (p *proc) request(ctx context.Context, subtype string, body any, timeout time.Duration) (json.RawMessage, error) {
	c := &call{done: make(chan struct{})}
	id, err := p.send(subtype, body, c)
	if err != nil {
		return nil, err
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case <-c.done:
		return c.resp, c.err
	case <-t.C:
		err = &chatproto.Error{Code: chatproto.CodeFailed, Message: fmt.Sprintf("claude: no answer to %s within %v", subtype, timeout)}
	case <-ctx.Done():
		err = ctx.Err()
	}
	p.mu.Lock()
	delete(p.pending, id)
	p.mu.Unlock()
	return nil, err
}

// requestAsync sends a control request whose answer fn takes, in the
// reading goroutine; fn is not called when the request could not be sent
// (the error is returned).
func (p *proc) requestAsync(subtype string, body any, fn func(json.RawMessage, error)) error {
	_, err := p.send(subtype, body, &call{fn: fn})
	return err
}

// resolve hands the answer r to the request it answers; false when the
// request is not one of this run's pending ones (the program echoes the
// answers it is sent).
func (p *proc) resolve(r responseBody) bool {
	p.mu.Lock()
	c, ok := p.pending[r.RequestID]
	p.mu.Unlock()
	if !ok {
		return false
	}
	// Pending until its answer was taken (resolve and end run in the
	// reading goroutine, one after the other).
	defer func() {
		p.mu.Lock()
		delete(p.pending, r.RequestID)
		p.mu.Unlock()
	}()
	var err error
	if r.Subtype != "success" {
		msg := r.Error
		if msg == "" {
			msg = "the request failed"
		}
		err = &chatproto.Error{Code: chatproto.CodeFailed, Message: "claude: " + msg}
	}
	c.finish(r.Response, err)
	return true
}

func (c *call) finish(resp json.RawMessage, err error) {
	c.resp, c.err = resp, err
	if c.fn != nil {
		c.fn(resp, err)
		return
	}
	close(c.done)
}

// end fails every pending request: the program's output ended.
func (p *proc) end() {
	p.mu.Lock()
	p.gone = true
	pending := p.pending
	p.pending = map[string]*call{}
	incoming := p.incoming
	p.incoming = map[string]context.CancelFunc{}
	p.mu.Unlock()
	for _, c := range pending {
		c.finish(nil, errGone)
	}
	for _, cancel := range incoming {
		cancel()
	}
}

// track registers the cancel of the program's own request id while it is
// answered; false when the output ended.
func (p *proc) track(id string, cancel context.CancelFunc) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.gone {
		return false
	}
	p.incoming[id] = cancel
	return true
}

// untrack forgets the program's request id.
func (p *proc) untrack(id string) {
	p.mu.Lock()
	delete(p.incoming, id)
	p.mu.Unlock()
}

// cancelIncoming cancels the answer to the program's request id
// (control_cancel_request); false when no such request is answered.
func (p *proc) cancelIncoming(id string) bool {
	p.mu.Lock()
	cancel, ok := p.incoming[id]
	delete(p.incoming, id)
	p.mu.Unlock()
	if ok {
		cancel()
	}
	return ok
}

// answer writes the answer to the program's request id: a success with
// resp, or an error.
func (p *proc) answer(id string, resp any, err error) error {
	body := responseBody{Subtype: "success", RequestID: id}
	if err != nil {
		body.Subtype, body.Error = "error", err.Error()
	} else if resp != nil {
		body.Response = mustJSON(resp)
	}
	return p.write(controlResponse{Type: "control_response", Response: body})
}

// signal sends sig to the program's process group.
func (p *proc) signal(sig syscall.Signal) {
	if p.cmd.Process == nil {
		return
	}
	select {
	case <-p.exited:
		return
	default:
	}
	// The group is the program's own (Setpgid): its id is the program's.
	_ = syscall.Kill(-p.cmd.Process.Pid, sig)
}

// stop ends the program gracefully, once: its input is closed, then its
// group gets SIGTERM after closeGrace and SIGKILL killGrace later. It
// returns at once; exited is closed when the program is gone.
func (p *proc) stop() {
	p.mu.Lock()
	if p.stopping {
		p.mu.Unlock()
		return
	}
	p.stopping = true
	p.mu.Unlock()
	// Not under wmu: a write the program does not read blocks holding it,
	// and the close ends that write.
	p.stdin.Close()
	go func() {
		select {
		case <-p.exited:
			return
		case <-time.After(p.closeGrace):
		}
		p.signal(syscall.SIGTERM)
		select {
		case <-p.exited:
			return
		case <-time.After(p.killGrace):
		}
		p.signal(syscall.SIGKILL)
	}()
}

// kill ends the program's group at once.
func (p *proc) kill() {
	p.stop()
	p.signal(syscall.SIGKILL)
}

// exitError says why the program ended: its exit and the end of its
// standard error.
func (p *proc) exitError(code string) *chatproto.Error {
	msg := "claude exited"
	var ee *exec.ExitError
	switch {
	case errors.As(p.waitErr, &ee):
		msg += ": " + ee.ProcessState.String()
	case p.waitErr != nil:
		msg += ": " + p.waitErr.Error()
	}
	return &chatproto.Error{Code: code, Message: msg, Stderr: p.stderr.String()}
}

// mustJSON is v in JSON, the characters of HTML not escaped; v is a value
// of this package's, which always encodes.
func mustJSON(v any) json.RawMessage {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		panic(err)
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}
