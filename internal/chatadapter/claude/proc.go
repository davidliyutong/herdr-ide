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
	"os"
	"os/exec"
	"strconv"
	"strings"
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
	stdin *os.File // the write end
	out   *os.File // the read end
	errR  *os.File // the read end of its standard error
	// wmu orders the lines written to stdin.
	wmu sync.Mutex
	// stderr keeps the end of what the program wrote to its standard error.
	stderr *tail
	// exited is closed once the program was waited for; waitErr is why it
	// ended. done is closed after that, once its process group is gone too
	// (sweep) and its standard error was read to its end.
	exited  chan struct{}
	waitErr error
	done    chan struct{}
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

// String is what the tail holds, as text: a character cut at its start is
// left out, bytes that are no UTF-8 become U+FFFD.
func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	b := t.buf
	for i := 0; i < len(b) && i < 3 && b[i]&0xC0 == 0x80; i++ {
		b = b[1:]
	}
	return strings.ToValidUTF8(string(b), "\uFFFD")
}

// The waits of a run's end, besides closeGrace and killGrace (variables:
// tests shorten them).
var (
	// groupPoll is how often the end of a run looks whether its process
	// group is gone.
	groupPoll = 20 * time.Millisecond
	// drainWait is how long the rest of the program's output and standard
	// error is read once its group is gone: a program that left the group
	// may hold the pipes open.
	drainWait = time.Second
)

// startProc starts argv in dir with env as its whole environment, in a
// process group of its own. Its pipes are files: a command it left
// running that holds them open does not hold up its end (exec would copy
// a writer's standard error until every holder closed it).
func startProc(argv, env []string, dir string) (*proc, error) {
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
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env, cmd.Dir = env, dir
	cmd.Stdin, cmd.Stdout, cmd.Stderr = inR, outW, errW
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// No pipe of exec's to wait for; should there be one, Wait does not
	// wait for its other holders longer than this.
	cmd.WaitDelay = killGrace
	if err := cmd.Start(); err != nil {
		closeAll()
		return nil, err
	}
	inR.Close()
	outW.Close()
	errW.Close()
	p := &proc{cmd: cmd, stdin: inW, out: outR, errR: errR, stderr: &tail{max: maxStderr},
		exited: make(chan struct{}), done: make(chan struct{}),
		pending: map[string]*call{}, incoming: map[string]context.CancelFunc{},
		closeGrace: closeGrace, killGrace: killGrace}
	var b [4]byte
	rand.Read(b[:])
	p.prefix = "req_" + hex.EncodeToString(b[:]) + "_"
	drained := make(chan struct{})
	go func() {
		io.Copy(p.stderr, errR)
		close(drained)
	}()
	go func() {
		p.waitErr = cmd.Wait()
		close(p.exited)
		// The program is gone: what it left running in its group (MCP
		// servers, hooks, commands) goes too.
		p.sweep()
		if !waitFor(drained, drainWait) {
			errR.Close()
			<-drained
		}
		errR.Close()
		p.stdin.Close()
		close(p.done)
		// The output of a program that left the group and holds the pipe
		// open ends too, once what came before was read.
		time.AfterFunc(drainWait, func() { outR.Close() })
	}()
	return p, nil
}

// sweep ends what is left of the run's process group once the program
// itself exited: SIGTERM, then SIGKILL when a process of it is still there
// killGrace later.
func (p *proc) sweep() {
	pgid := p.cmd.Process.Pid
	alive := func() bool { return syscall.Kill(-pgid, 0) == nil }
	if !alive() {
		return
	}
	syscall.Kill(-pgid, syscall.SIGTERM)
	deadline := time.Now().Add(p.killGrace)
	for alive() && time.Now().Before(deadline) {
		time.Sleep(groupPoll)
	}
	if alive() {
		syscall.Kill(-pgid, syscall.SIGKILL)
	}
}

// waitFor tells whether ch was closed within d.
func waitFor(ch <-chan struct{}, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ch:
		return true
	case <-t.C:
		return false
	}
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

// signal sends sig to the program's process group, until the group is
// gone (its id may be another's then).
func (p *proc) signal(sig syscall.Signal) {
	if p.cmd.Process == nil {
		return
	}
	select {
	case <-p.done:
		return
	default:
	}
	// The group is the program's own (Setpgid): its id is the program's.
	_ = syscall.Kill(-p.cmd.Process.Pid, sig)
}

// stop ends the program gracefully, once: its input is closed, then its
// group gets SIGTERM after closeGrace and SIGKILL killGrace later (once
// the program exited, what is left of its group goes as sweep has it). It
// returns at once; done is closed when the program and its group are
// gone.
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
	case p.cmd.ProcessState != nil && !p.cmd.ProcessState.Success():
		msg += ": " + p.cmd.ProcessState.String()
	case p.waitErr != nil && !errors.Is(p.waitErr, exec.ErrWaitDelay):
		msg += ": " + p.waitErr.Error()
	}
	return &chatproto.Error{Code: code, Message: msg, Stderr: p.stderr.String()}
}

// noSession is what Claude Code writes to its standard error when it is
// to resume a session it does not have.
const noSession = "No conversation found with session ID"

// startError says why a run did not start: the program's end, as
// CodeNotFound when it had no such session to resume.
func (p *proc) startError(resume bool) *chatproto.Error {
	e := p.exitError(chatproto.CodeStartFailed)
	if resume && strings.Contains(e.Stderr, noSession) {
		e.Code = chatproto.CodeNotFound
		e.Message = "claude: no such session; " + e.Message
	}
	return e
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
