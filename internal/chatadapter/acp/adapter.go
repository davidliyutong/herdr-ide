//go:build unix

// Package acp is the chat host's adapter for the agents that speak the
// Agent Client Protocol (internal/acp) on their standard input and output:
// Kimi Code (`kimi acp`) and Grok (`grok agent --no-leader stdio`), the
// kinds whose Chat spec names agentkinds.AdapterACP. It registers itself
// under that name.
//
// A chat's agent runs as one process with one session: a new one
// (session/new, with the Chat spec's _meta), or the chat's earlier one
// taken up by its id: session/resume, which replays nothing, where the
// agent has it, else session/load, whose replay the adapter drops (the
// chat's log has it). The client states neither the fs nor the terminal
// capability and answers every other request of the agent with "method
// not found"; a permission's options that allow or reject for good are not
// offered (an agent may keep them in its own settings). The protocol has a
// turn per prompt: a prompt while a turn runs waits in the adapter and is
// sent when the turn ends.
//
// Sessions and History ask an agent process of their own (a probe), which
// ends once it answered: session/list, and session/load, whose replay is an
// import's events. A replay is the agent's own account of the session:
// what it injected into the user's messages, merged or left out (Kimi
// Code's leaves images out, merges a cancelled prompt with the next, and
// numbers tool calls anew), so an import starts with a notice that it is
// one.
package acp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"path"
	"slices"
	"sync"
	"time"

	rpc "herdr-ide/internal/acp"
	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

func init() { chatadapter.Register(agentkinds.AdapterACP, &Adapter{t: defaultTiming}) }

// maxSessions is the most sessions a page of Sessions lists.
const maxSessions = 1000

// historyBytes is the most of an import held before it is handed on: the
// events of a turn wait for its end, so that a tool call is stored once,
// with its last state, unless a turn is longer than this.
const historyBytes = 32 << 20

// Adapter is the ACP adapter.
type Adapter struct{ t timing }

// itemPrefix starts the ids of a session's items: random, so that those of
// the processes a chat runs one after the other differ.
var itemPrefix = func() string {
	var b [4]byte
	rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func logger(l *log.Logger) *log.Logger {
	if l == nil {
		return log.New(io.Discard, "", 0)
	}
	return l
}

// checkRun refuses a command or a directory that is not what the host
// promises.
func checkRun(argv []string, cwd string) error {
	if len(argv) == 0 || !path.IsAbs(argv[0]) || !path.IsAbs(cwd) {
		return &chatproto.Error{Code: chatproto.CodeBadRequest, Message: "the agent's command or directory is no absolute path"}
	}
	return nil
}

// Start runs the agent and makes or takes up its session.
func (a *Adapter) Start(ctx context.Context, p chatadapter.StartParams, sink chatadapter.Sink) (chatadapter.Session, error) {
	if err := checkRun(p.Argv, p.Cwd); err != nil {
		return nil, err
	}
	s := newSession(p.Kind, logger(p.Logger), sink, a.t)
	proc, err := startProcess(p.Argv, p.Cwd, p.Env)
	if err != nil {
		s.out.close()
		return nil, &chatproto.Error{Code: chatproto.CodeStartFailed, Message: err.Error()}
	}
	s.proc = proc
	s.conn = rpc.NewConn(proc.stdout, proc.stdin, s)
	go s.watch()
	if err := s.open(ctx, p); err != nil {
		s.mu.Lock()
		s.closing = true
		s.mu.Unlock()
		proc.stop(a.t.grace, a.t.term)
		<-s.done
		e := startError(ctx, err)
		e.Stderr = proc.stderr()
		if e.Code == chatproto.CodeStartFailed && e.Message == "" {
			e.Message = "the agent exited before its session existed"
			if st := proc.status(); st != "" {
				e.Message += " (" + st + ")"
			}
		}
		return nil, e
	}
	return s, nil
}

// open speaks the protocol up to the session, and sets what the chat
// starts with.
func (s *session) open(ctx context.Context, p chatadapter.StartParams) error {
	ictx, cancel := context.WithTimeout(ctx, s.t.initialize)
	init, err := s.conn.Initialize(ictx, rpc.Implementation{Name: p.Client.Name, Version: p.Client.Version})
	cancel()
	if err != nil {
		if errors.Is(err, rpc.ErrProtocolVersion) && init != nil {
			return &chatproto.Error{Code: chatproto.CodeProtocol, Message: fmt.Sprintf(
				"the agent speaks version %d of the Agent Client Protocol, this host version %d", init.ProtocolVersion, rpc.ProtocolVersion)}
		}
		return err
	}
	caps := init.AgentCapabilities
	s.mu.Lock()
	s.caps = caps
	s.mu.Unlock()

	var options, modes, models json.RawMessage
	id := p.Resume
	meta := p.NewSessionMeta
	if !present(meta) {
		meta = nil
	}
	switch {
	case p.Resume == "":
		sctx, cancel := context.WithTimeout(ctx, s.t.session)
		res, err := s.conn.NewSession(sctx, rpc.NewSessionParams{Cwd: p.Cwd, Meta: meta})
		cancel()
		if err != nil {
			return err
		}
		id, options, modes, models = res.SessionID, res.ConfigOptions, res.Modes, res.Models
	case bool(caps.SessionCapabilities.Resume):
		s.mu.Lock()
		s.id = id
		s.mu.Unlock()
		sctx, cancel := context.WithTimeout(ctx, s.t.session)
		res, err := s.conn.ResumeSession(sctx, rpc.LoadSessionParams{SessionID: id, Cwd: p.Cwd, Meta: meta})
		cancel()
		if err != nil {
			return err
		}
		options, modes, models = res.ConfigOptions, res.Modes, res.Models
	case caps.LoadSession:
		// The agent replays the session before it answers: the chat's log
		// has all of it.
		s.mu.Lock()
		s.id, s.replaying = id, true
		s.mu.Unlock()
		lctx, cancel := context.WithTimeout(ctx, s.t.load)
		res, err := s.conn.LoadSession(lctx, rpc.LoadSessionParams{SessionID: id, Cwd: p.Cwd, Meta: meta})
		cancel()
		s.mu.Lock()
		s.replaying = false
		s.mu.Unlock()
		if err != nil {
			return err
		}
		options, modes, models = res.ConfigOptions, res.Modes, res.Models
	default:
		return &chatproto.Error{Code: chatproto.CodeUnsupported, Message: "the agent cannot take up a session"}
	}

	version := init.AgentInfo.Version
	if version == "" {
		var m struct {
			AgentVersion string `json:"agentVersion"`
		}
		json.Unmarshal(init.Meta, &m)
		version = m.AgentVersion
	}
	version = clip(version, maxName)
	chatCaps := chatproto.Capabilities{Images: caps.PromptCapabilities.Image, Queue: true, CancelQueued: true}
	s.mu.Lock()
	s.id = id
	s.sizes = contextSizes(models)
	s.change(func(c *chatproto.Chat) {
		c.SessionID, c.AgentVersion, c.Capabilities = id, version, chatCaps
	})
	s.setConfig(options, modes)
	s.mu.Unlock()
	s.applyOptions(ctx, p.Options)
	return nil
}

// applyOptions sets what the chat starts with: the model, the effort and
// the mode, each when the agent has it and it is not already set. A value
// the agent does not offer is left (the host checks what it was asked).
func (s *session) applyOptions(ctx context.Context, o chatproto.Options) {
	type want struct{ category, value string }
	for _, w := range []want{{chatproto.CategoryModel, o.Model}, {chatproto.CategoryThoughtLevel, o.Effort}, {chatproto.CategoryMode, o.Mode}} {
		if w.value == "" {
			continue
		}
		s.mu.Lock()
		opt := optionOf(s.config, w.category)
		var id, value, current string
		var legacy bool
		if opt != nil {
			id, current, legacy = opt.ID, opt.CurrentValue, opt.ID == s.legacy
			value = w.value
			if w.category == chatproto.CategoryMode {
				value = modeValue(opt, w.value)
			} else if !hasValue(opt, value) {
				value = ""
			}
		}
		session := s.id
		s.mu.Unlock()
		if opt == nil || value == "" {
			s.logf("no %s %q to start with", w.category, w.value)
			continue
		}
		if value == current {
			continue
		}
		if err := s.set(ctx, session, id, value, legacy); err != nil {
			s.logf("setting %s to %q: %v", id, value, err)
		}
	}
}

// startError is the error of an agent that did not get to a session.
func startError(ctx context.Context, err error) *chatproto.Error {
	var ce *chatproto.Error
	var e *rpc.Error
	switch {
	case errors.As(err, &ce):
		c := *ce
		return &c
	case errors.As(err, &e) && e.Code == rpc.CodeAuthRequired:
		return &chatproto.Error{Code: chatproto.CodeAuthRequired, Message: e.Message}
	case errors.As(err, &e):
		return &chatproto.Error{Code: chatproto.CodeStartFailed, Message: e.Message}
	case errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded):
		return &chatproto.Error{Code: chatproto.CodeStartFailed, Message: "the agent did not start in time"}
	case ctx.Err() != nil || errors.Is(err, context.Canceled):
		return &chatproto.Error{Code: chatproto.CodeEnded, Message: "the start was called off"}
	case errors.Is(err, rpc.ErrClosed):
		return &chatproto.Error{Code: chatproto.CodeStartFailed}
	}
	return &chatproto.Error{Code: chatproto.CodeStartFailed, Message: err.Error()}
}

// probe is an agent process that answers a question (Sessions, History)
// and ends.
type probe struct {
	proc *process
	conn *rpc.Conn
	t    timing
}

// probeHandler takes a probe's notifications; the agent's requests get
// nothing but a cancelled permission and "method not found".
type probeHandler struct {
	notify func(method string, params json.RawMessage)
}

func (h probeHandler) Notification(method string, params json.RawMessage) {
	if h.notify != nil {
		h.notify(method, params)
	}
}

func (h probeHandler) Request(ctx context.Context, method string, params json.RawMessage) (any, error) {
	if method == rpc.MethodSessionRequestPermission {
		return rpc.PermissionCancelled(), nil
	}
	return nil, rpc.ErrMethodNotFound
}

// startProbe runs the agent and initializes it.
func (a *Adapter) startProbe(ctx context.Context, argv, env []string, cwd string, h rpc.Handler) (*probe, *rpc.InitializeResult, error) {
	if err := checkRun(argv, cwd); err != nil {
		return nil, nil, err
	}
	proc, err := startProcess(argv, cwd, env)
	if err != nil {
		return nil, nil, &chatproto.Error{Code: chatproto.CodeStartFailed, Message: err.Error()}
	}
	p := &probe{proc: proc, conn: rpc.NewConn(proc.stdout, proc.stdin, h), t: a.t}
	ictx, cancel := context.WithTimeout(ctx, a.t.initialize)
	defer cancel()
	init, err := p.conn.Initialize(ictx, rpc.Implementation{Name: brand.Name, Version: agentproto.Version})
	if err != nil {
		p.end()
		if errors.Is(err, rpc.ErrProtocolVersion) {
			return nil, nil, &chatproto.Error{Code: chatproto.CodeProtocol, Message: err.Error()}
		}
		e := startError(ctx, err)
		e.Stderr = proc.stderr()
		return nil, nil, e
	}
	return p, init, nil
}

// end ends the probe's agent gracefully and returns once it is gone.
func (p *probe) end() {
	p.proc.stop(p.t.grace, p.t.term)
	<-p.proc.stopped
	p.conn.Close()
}

// Sessions lists the sessions the agent kept for a directory
// (session/list).
func (a *Adapter) Sessions(ctx context.Context, p chatadapter.SessionsParams) ([]chatproto.Session, string, error) {
	pr, init, err := a.startProbe(ctx, p.Argv, p.Env, p.Cwd, probeHandler{})
	if err != nil {
		return nil, "", err
	}
	defer pr.end()
	if !bool(init.AgentCapabilities.SessionCapabilities.List) {
		return nil, "", &chatproto.Error{Code: chatproto.CodeUnsupported, Message: "the agent cannot list its sessions"}
	}
	lctx, cancel := context.WithTimeout(ctx, a.t.session)
	defer cancel()
	res, err := pr.conn.ListSessions(lctx, rpc.ListSessionsParams{Cwd: p.Cwd, Cursor: p.Cursor})
	if err != nil {
		return nil, "", callError(err)
	}
	out := []chatproto.Session{}
	for _, si := range res.Sessions {
		if si.SessionID == "" || len(out) == maxSessions {
			continue
		}
		at, _ := time.Parse(time.RFC3339Nano, si.UpdatedAt)
		out = append(out, chatproto.Session{SessionID: si.SessionID, Cwd: si.Cwd, Title: clip(si.Title, titleRunes), UpdatedAt: at})
	}
	slices.SortStableFunc(out, func(x, y chatproto.Session) int { return y.UpdatedAt.Compare(x.UpdatedAt) })
	return out, res.NextCursor, nil
}

// History emits a session's earlier conversation from the agent's replay
// of it (session/load), after a notice that it is an import (none when
// p.After names where an earlier import ended). Items are numbered by
// their place in the replay, so that p.After finds where an earlier import
// of the session ended: what comes after the turn that holds it is
// emitted; nothing when the replay has no such item. emit is called from
// the probe's reader, one call at a time, all before History returns.
func (a *Adapter) History(ctx context.Context, p chatadapter.HistoryParams, emit func(chatproto.Event)) error {
	h := newHistory(p.After, emit)
	handler := probeHandler{notify: func(method string, params json.RawMessage) {
		var n rpc.SessionNotification
		var head struct {
			Kind string `json:"sessionUpdate"`
		}
		if method != rpc.MethodSessionUpdate || json.Unmarshal(params, &n) != nil || n.SessionID != p.SessionID ||
			json.Unmarshal(n.Update, &head) != nil || !contentUpdate(head.Kind) {
			return
		}
		h.update(head.Kind, n.Update)
	}}
	pr, init, err := a.startProbe(ctx, p.Argv, p.Env, p.Cwd, handler)
	if err != nil {
		return err
	}
	defer pr.end()
	if !init.AgentCapabilities.LoadSession {
		return &chatproto.Error{Code: chatproto.CodeUnsupported, Message: "the agent cannot load a session"}
	}
	if p.After == "" {
		emit(chatproto.Event{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeImported), Params: json.RawMessage(`{"lossy":true}`)})
	}
	lctx, cancel := context.WithTimeout(ctx, a.t.load)
	defer cancel()
	if _, err := pr.conn.LoadSession(lctx, rpc.LoadSessionParams{SessionID: p.SessionID, Cwd: p.Cwd}); err != nil {
		return callError(err)
	}
	if !h.finish() {
		logger(p.Logger).Printf("acp %s: the import's last item %q is not in the replay of %s: nothing imported", p.Kind, p.After, p.SessionID)
	}
	return nil
}

// history turns a session's replay into an import's events: a turn from
// each user message to the next, its items stored once each.
type history struct {
	mu     sync.Mutex
	it     *items
	emit   func(chatproto.Event)
	after  string
	found  bool // after was met
	skip   bool // ... and the rest of its turn is being passed over
	inTurn bool
	closed bool
	buf    []chatproto.Event
	tools  map[string]int // a tool call's event in buf
	bytes  int
}

func newHistory(after string, emit func(chatproto.Event)) *history {
	h := &history{emit: emit, after: after, tools: map[string]int{}}
	h.it = newItems("h", false, h.store)
	h.it.user = h.user
	return h
}

func (h *history) update(kind string, raw json.RawMessage) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.closed {
		h.it.update(kind, raw)
	}
}

// store holds an event of the turn; a tool call's replaces the one of the
// same call.
func (h *history) store(ev chatproto.Event, tool string) {
	size := len(ev.Update)
	if tool != "" {
		if i, ok := h.tools[tool]; ok {
			h.bytes += size - len(h.buf[i].Update)
			h.buf[i] = ev
			return
		}
		h.tools[tool] = len(h.buf)
	}
	h.buf = append(h.buf, ev)
	h.bytes += size
	if h.bytes > historyBytes {
		h.flush()
	}
}

// user starts a turn with a user's message.
func (h *history) user(content []json.RawMessage) {
	h.endTurn()
	if len(content) > 0 {
		h.deliver(chatproto.Event{T: chatproto.EventUser, Content: content})
	}
	h.deliver(chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnStart})
	h.inTurn = true
}

func (h *history) endTurn() {
	h.it.endTurn()
	if h.inTurn {
		h.buf = append(h.buf, chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnEnd, StopReason: string(rpc.StopEndTurn)})
		h.inTurn = false
	}
	h.flush()
}

func (h *history) flush() {
	for _, ev := range h.buf {
		h.deliver(ev)
	}
	h.buf, h.tools, h.bytes = nil, map[string]int{}, 0
}

// deliver hands an event on, but for what an earlier import has: up to
// after, and the rest of its turn.
func (h *history) deliver(ev chatproto.Event) {
	switch {
	case h.after != "" && !h.found:
		if ev.Item == h.after {
			h.found, h.skip = true, true
		}
		return
	case h.skip:
		if ev.T != chatproto.EventUser && !(ev.T == chatproto.EventTurn && ev.State == chatproto.TurnStart) {
			return
		}
		h.skip = false
	}
	h.emit(ev)
}

// finish ends the replay; false when after was not met.
func (h *history) finish() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.it.close()
	h.endTurn()
	h.closed = true
	return h.after == "" || h.found
}
