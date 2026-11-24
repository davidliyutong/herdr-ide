package chat

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"veldr/internal/chatproto"
	"veldr/internal/plugin"
)

// The machine side's action and its parameters (internal/agent/plugin/chat).
const (
	actionOpen = "open"
	// codeNotRunning is the machine's answer to an open that may not start
	// the chat host (openParams.Start false) when none serves.
	codeNotRunning = "not_running"
)

// openParams are the parameters of the open action: Start false asks for a
// connection only to a chat host that serves already.
type openParams struct {
	Start bool `json:"start"`
}

// Time limits of the requests to a machine's chat host: the open covers
// the machine starting the host (up to 15 s), each request what its
// answer waits for on the host.
const (
	helloTimeout    = 10 * time.Second
	writeTimeout    = 30 * time.Second
	shortTimeout    = 45 * time.Second
	sessionsTimeout = 2 * time.Minute
	handoffTimeout  = time.Minute
	// attachTimeout bounds an attach until the host's answer.
	attachTimeout = 45 * time.Second
)

// opener opens a stream to machine m's chat host through its agent: the
// connection after the machine's reply, the host's Hello first. Without
// start, only to a host that serves already (else codeNotRunning). The
// stream is closed when ctx ends.
type opener func(ctx context.Context, m string, start bool) (net.Conn, error)

// openVia is the opener of the core: the machine side's open action.
func openVia(h plugin.Host) opener {
	return func(ctx context.Context, m string, start bool) (net.Conn, error) {
		mc := h.Machines().Get(m)
		if mc == nil {
			return nil, plugin.ErrOffline
		}
		var params any
		if !start {
			params = openParams{Start: false}
		}
		conn, _, err := plugin.Open(ctx, mc, ID, actionOpen, params)
		return conn, err
	}
}

// hostConn is a connection to a machine's chat host after its Hello.
type hostConn struct {
	conn net.Conn
	r    *bufio.Reader
	info chatproto.HostInfo
	stop func() bool
	// release gives its slot of the machine's connections back, once.
	release func()
}

func (c *hostConn) Close() error {
	c.stop()
	c.release()
	return c.conn.Close()
}

// hostID names the process of a chat host by its hello: another process
// (a host started again, another build's) has another.
func hostID(info chatproto.HostInfo) string {
	return info.Version + "/" + strconv.Itoa(info.PID)
}

// The bounds of the connections the core has open to one machine's chat
// host, the pages' subscriptions and every request's together: at most
// maxHostConns, of which the last reservedConns only for the watch and
// the configures (variables for the tests).
var (
	maxHostConns  = 128
	reservedConns = 8
)

// errTooManyConns refuses a connection beyond maxHostConns.
var errTooManyConns = &chatproto.Error{Code: chatproto.CodeTooMany, Message: "too many connections to the machine's chat host"}

// acquire takes a slot of machine m's connections: of the first
// maxHostConns-reservedConns of them that every connection may take, or
// (reserved) of all of them; the function gives it back, once.
func (p *Plugin) acquire(m string, reserved bool) (func(), error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := p.conns[m]
	if n.all >= maxHostConns || (!reserved && n.open >= maxHostConns-reservedConns) {
		return nil, errTooManyConns
	}
	n.all++
	if !reserved {
		n.open++
	}
	p.conns[m] = n
	var once sync.Once
	return func() {
		once.Do(func() {
			p.mu.Lock()
			n := p.conns[m]
			n.all--
			if !reserved {
				n.open--
			}
			if n.all <= 0 {
				delete(p.conns, m)
			} else {
				p.conns[m] = n
			}
			p.mu.Unlock()
		})
	}, nil
}

// connCount is how many connections the core has open to a machine's chat
// host: all, and those that are not the watch's or a configure's (open).
type connCount struct {
	all, open int
}

// errProtocol is the error of a host that does not speak chatproto.Proto,
// or says something that is not of the protocol.
func errProtocol(msg string) *chatproto.Error {
	return &chatproto.Error{Code: chatproto.CodeProtocol, Message: msg}
}

// dial connects to machine m's chat host and reads its Hello; the
// connection is closed when ctx ends. It takes one of the machine's
// connection slots (acquire; reserved: the watch's and the configures'),
// refused with too_many when none is left.
func (p *Plugin) dial(ctx context.Context, m string, start, reserved bool) (*hostConn, error) {
	open := p.opener()
	if open == nil {
		return nil, plugin.ErrOffline
	}
	release, err := p.acquire(m, reserved)
	if err != nil {
		return nil, err
	}
	conn, err := open(ctx, m, start)
	if err != nil {
		release()
		return nil, err
	}
	c := &hostConn{conn: conn, r: bufio.NewReaderSize(conn, 64<<10), stop: context.AfterFunc(ctx, func() { conn.Close() }), release: release}
	conn.SetReadDeadline(time.Now().Add(helloTimeout))
	line, err := chatproto.ReadLine(c.r)
	conn.SetReadDeadline(time.Time{})
	if err != nil {
		c.Close()
		return nil, transportError(ctx, err)
	}
	var hello chatproto.Hello
	if err := json.Unmarshal(line, &hello); err != nil {
		c.Close()
		return nil, errProtocol("the chat host's first line is no hello")
	}
	if hello.Host.Proto != chatproto.Proto {
		c.Close()
		return nil, errProtocol("the chat host speaks another version of the protocol")
	}
	c.info = hello.Host
	return c, nil
}

// transportError is the error of a connection to a chat host that broke:
// the deadline's when ctx ended.
func transportError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return &plugin.Error{Code: "transport", Message: err.Error()}
}

// writeLine writes v as a line within writeTimeout.
func writeLine(conn net.Conn, v any) error {
	b, err := chatproto.Line(v)
	if err != nil {
		return err
	}
	if len(b) > chatproto.MaxLine+1 {
		return &chatproto.Error{Code: chatproto.CodeTooLarge, Message: "a line longer than the protocol takes"}
	}
	conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	_, err = conn.Write(b)
	conn.SetWriteDeadline(time.Time{})
	return err
}

// rawResponse is a chatproto.Response whose chat stays as the host wrote
// it.
type rawResponse struct {
	chatproto.Response
	Chat json.RawMessage `json:"chat,omitempty"`
}

// send writes req and reads the host's answer: its error when it refused.
func (c *hostConn) send(ctx context.Context, req chatproto.Request) (*rawResponse, error) {
	if err := writeLine(c.conn, req); err != nil {
		var pe *chatproto.Error
		if errors.As(err, &pe) {
			return nil, pe
		}
		return nil, transportError(ctx, err)
	}
	line, err := chatproto.ReadLine(c.r)
	if err != nil {
		return nil, transportError(ctx, err)
	}
	var res rawResponse
	if err := json.Unmarshal(line, &res); err != nil {
		return nil, errProtocol("the chat host's answer is not of the protocol")
	}
	if res.Error != nil {
		return nil, res.Error
	}
	if !res.OK {
		return nil, errProtocol("the chat host's answer is neither OK nor an error")
	}
	return &res, nil
}

// mayStart tells whether the core's requests start a machine's chat host
// when none serves: not a read-only core's, which reads what runs.
func (p *Plugin) mayStart() bool {
	h := p.getHost()
	return h == nil || !h.ReadOnly()
}

// request sends one request to machine m's chat host and returns its
// answer; with start, it starts the host when none serves (and the core
// may, mayStart), else it answers not_running then. A request that may
// start an agent (agent) goes to a host that took the machine's settings
// (prepare, ensureConfigured). A request that reached the host counts as
// a use of it (Plugin.used).
func (p *Plugin) request(ctx context.Context, m string, req chatproto.Request, start, agent bool) (*rawResponse, error) {
	start = start && p.mayStart()
	if agent {
		p.prepare(ctx, m, start)
	}
	c, err := p.dial(ctx, m, start, false)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	p.used(m)
	if agent {
		p.ensureConfigured(ctx, m, c)
	}
	return c.send(ctx, req)
}

// codeOf is an error's code: the host's, the machine's, timeout, or failed.
func codeOf(err error) string {
	var ce *chatproto.Error
	var pe *plugin.Error
	switch {
	case err == nil:
		return ""
	case errors.As(err, &ce):
		return ce.Code
	case errors.As(err, &pe):
		return pe.Code
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	}
	return chatproto.CodeFailed
}

// protoError is err as the protocol's error, for the page.
func protoError(err error) *chatproto.Error {
	var ce *chatproto.Error
	var pe *plugin.Error
	switch {
	case errors.As(err, &ce):
		return ce
	case errors.As(err, &pe):
		return &chatproto.Error{Code: pe.Code, Message: pe.Message}
	case errors.Is(err, context.DeadlineExceeded):
		return &chatproto.Error{Code: "timeout", Message: "the machine did not answer in time"}
	}
	return &chatproto.Error{Code: chatproto.CodeFailed, Message: err.Error()}
}

// statusOf is the HTTP status of an error code.
func statusOf(code string) int {
	switch code {
	case "":
		return http.StatusOK
	case chatproto.CodeBadRequest:
		return http.StatusBadRequest
	case chatproto.CodeUnknownChat, chatproto.CodeNotFound:
		return http.StatusNotFound
	case chatproto.CodeBusy, chatproto.CodeTooMany, chatproto.CodeInTerminal, chatproto.CodeHandedOff,
		chatproto.CodeSleeping, "offline", codeNotRunning:
		return http.StatusConflict
	case chatproto.CodeTooLarge:
		return http.StatusRequestEntityTooLarge
	case CodeReadOnly, chatproto.CodeNotAllowed, chatproto.CodeUnsafeFolder:
		return http.StatusForbidden
	case chatproto.CodeUnsupported, chatproto.CodeAuthRequired:
		return http.StatusUnprocessableEntity
	case "timeout":
		return http.StatusGatewayTimeout
	case "upgrading", "no_terminal_core":
		// The machine's host makes way for another build, or its
		// terminal core does not run: later.
		return http.StatusServiceUnavailable
	}
	// The agent or the machine failed: start_failed, protocol, ended,
	// failed, transport and the machine's own codes.
	return http.StatusBadGateway
}

// writeError answers a request that failed with its code and message.
func writeError(w http.ResponseWriter, err error) {
	e := protoError(err)
	plugin.WriteJSON(w, statusOf(e.Code), map[string]string{"error": e.Code, "message": e.Message})
}

func badRequest(w http.ResponseWriter, msg string) {
	plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": chatproto.CodeBadRequest, "message": msg})
}
