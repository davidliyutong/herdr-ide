//go:build unix

package acp

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"slices"
	"strings"
	"sync"
	"time"

	rpc "herdr-ide/internal/acp"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

const (
	// maxQueue is the most messages that wait for a running turn.
	maxQueue = 16
	// maxPending is the most permissions of a session that wait for the
	// user; an agent that asks more is answered that they were cancelled.
	maxPending = 64
	// maxUnknown is the most kinds of unknown updates and requests a
	// session logs (once each).
	maxUnknown = 64
	// titleRunes is the longest title a chat takes from its agent.
	titleRunes = 200
)

// session is an agent process running one session of a chat.
type session struct {
	kind   string
	log    *log.Logger
	sink   chatadapter.Sink
	proc   *process
	conn   *rpc.Conn
	out    *outbox
	t      timing
	client chatadapter.ClientInfo
	meta   json.RawMessage // the Chat spec's _meta of session/new

	// ctx ends when the session does: the requests of the agent that wait
	// for the user return then.
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{} // closed once the process is gone and the host has every event

	mu        sync.Mutex
	id        string
	caps      rpc.AgentCapabilities
	it        *items
	turn      *turn
	queue     []queued
	replaying bool // session/load replays what the chat's log has
	closing   bool
	ended     bool
	err       error
	pending   int
	config    []chatproto.ConfigOption
	legacy    string // the id of the option made of the agent's session modes; "" for none
	commands  []chatproto.SlashCommand
	sizes     map[string]int64 // context windows by model id
	sawUsage  bool             // the agent sent a usage_update
	sawCost   bool             // ... with its cost
	unknown   map[string]bool
}

// turn is a prompt turn that runs.
type turn struct {
	// ctx ends with the turn, or when it is cancelled: the permissions it
	// asks return then.
	ctx    context.Context
	cancel context.CancelFunc
	// sent is closed once the prompt was written (or could not be): a
	// session/cancel goes after it, or the agent would not know the turn
	// it cancels.
	sent chan struct{}
}

// queued is a message that waits for the running turn to end.
type queued struct {
	message  string
	clientID string
	content  []json.RawMessage
}

// timing are a session's times, shorter in tests.
type timing struct {
	initialize, session, load, call time.Duration
	// grace is how long an agent whose input closed may take to exit
	// before it gets SIGTERM, term how long after that before SIGKILL.
	grace, term time.Duration
	// drain is how long the output of an agent that exited is read on.
	drain time.Duration
}

var defaultTiming = timing{
	initialize: 60 * time.Second, session: 60 * time.Second, load: 2 * time.Minute, call: 30 * time.Second,
	grace: 2 * time.Second, term: 3 * time.Second, drain: 2 * time.Second,
}

func newSession(kind string, logger *log.Logger, sink chatadapter.Sink, t timing) *session {
	ctx, cancel := context.WithCancel(context.Background())
	s := &session{
		kind: kind, log: logger, sink: sink, out: newOutbox(), t: t,
		ctx: ctx, cancel: cancel, done: make(chan struct{}),
		unknown: map[string]bool{},
	}
	s.it = newItems(itemPrefix(), true, func(ev chatproto.Event, _ string) { s.emit(ev) })
	return s
}

func (s *session) logf(format string, args ...any) {
	s.log.Printf("acp %s: "+format, append([]any{s.kind}, args...)...)
}

// once logs what the session passes over, once for each kind. The caller
// holds s.mu.
func (s *session) once(what string) {
	if s.unknown[what] || len(s.unknown) >= maxUnknown {
		return
	}
	s.unknown[what] = true
	s.logf("passed over %s", what)
}

// emit hands an event to the host. The caller holds s.mu.
func (s *session) emit(ev chatproto.Event) {
	s.out.push(func() { s.sink.Event(ev) })
}

// change changes what the chat states. The caller holds s.mu; fn must take
// copies of what it sets.
func (s *session) change(fn func(c *chatproto.Chat)) {
	s.out.push(func() { s.sink.Update(fn) })
}

// stateConfig states the session's configuration options, and the
// capabilities they make. The caller holds s.mu.
func (s *session) stateConfig() {
	cfg := cloneConfig(s.config)
	model, effort := optionOf(cfg, chatproto.CategoryModel) != nil, optionOf(cfg, chatproto.CategoryThoughtLevel) != nil
	s.change(func(c *chatproto.Chat) {
		c.Config = cfg
		c.Capabilities.Model, c.Capabilities.Effort = model, effort
	})
}

// setConfig takes the agent's configuration options, its session modes,
// or both: an agent without an option of category mode has its session
// modes as an option of the chat's own (legacyModeID), which
// session/set_mode sets. nil leaves what the session has. The caller holds
// s.mu.
func (s *session) setConfig(options, modes json.RawMessage) {
	var mode *chatproto.ConfigOption
	cfg := make([]chatproto.ConfigOption, 0, len(s.config))
	for _, o := range s.config {
		if s.legacy != "" && o.ID == s.legacy {
			mode = &o
			continue
		}
		cfg = append(cfg, o)
	}
	if present(options) {
		cfg = configOptions(options)
	}
	if present(modes) {
		if o, ok := modesOption(modes, ""); ok {
			mode = &o
		}
	}
	s.legacy = ""
	if mode != nil && optionOf(cfg, chatproto.CategoryMode) == nil {
		mode.ID = legacyModeID
		if optionByID(cfg, mode.ID) != nil {
			mode.ID = legacyModeIDAlt
		}
		cfg = append(cfg, *mode)
		s.legacy = mode.ID
	}
	markFull(cfg)
	s.config = cfg
	s.stateConfig()
}

// Notification takes a notification of the agent (rpc.Handler).
func (s *session) Notification(method string, params json.RawMessage) {
	defer s.out.throttle()
	s.mu.Lock()
	defer s.mu.Unlock()
	if method != rpc.MethodSessionUpdate {
		s.once("notification " + method)
		return
	}
	var n rpc.SessionNotification
	var head struct {
		Kind string `json:"sessionUpdate"`
	}
	if json.Unmarshal(params, &n) != nil || json.Unmarshal(n.Update, &head) != nil || head.Kind == "" {
		s.once("a malformed session/update")
		return
	}
	if s.ended || (s.id != "" && n.SessionID != s.id) {
		return
	}
	switch {
	case contentUpdate(head.Kind):
		if s.replaying {
			return // what the chat's log has
		}
		if head.Kind == updateUser {
			s.once("update " + head.Kind)
			return // the host states the user's prompts
		}
		s.it.update(head.Kind, n.Update)
	case head.Kind == updateCommands:
		cmds, ok := slashCommands(n.Update)
		if ok && !slices.Equal(cmds, s.commands) {
			s.commands = cmds
			cp := slices.Clone(cmds)
			s.change(func(c *chatproto.Chat) { c.Commands = cp })
		}
	case head.Kind == updateConfig:
		var u struct {
			ConfigOptions json.RawMessage `json:"configOptions"`
		}
		if json.Unmarshal(n.Update, &u) == nil && present(u.ConfigOptions) {
			s.setConfig(u.ConfigOptions, nil)
		}
	case head.Kind == updateMode:
		var u struct {
			CurrentModeID string `json:"currentModeId"`
		}
		if o := optionByID(s.config, s.legacy); s.legacy != "" && o != nil && json.Unmarshal(n.Update, &u) == nil && hasValue(o, u.CurrentModeID) {
			o.CurrentValue = u.CurrentModeID
			s.stateConfig()
		}
	case head.Kind == updateInfo:
		var u struct {
			Title *string `json:"title"`
		}
		if json.Unmarshal(n.Update, &u) == nil && u.Title != nil {
			if title := clip(strings.TrimSpace(*u.Title), titleRunes); title != "" {
				s.change(func(c *chatproto.Chat) { c.Title = title })
			}
		}
	case head.Kind == updateUsage:
		var u wireUsage
		if json.Unmarshal(n.Update, &u) != nil || u.Used == nil {
			s.once("a malformed usage_update")
			return
		}
		s.sawUsage = true
		used, size := *u.Used, int64(0)
		if u.Size != nil {
			size = *u.Size
		}
		var cost *chatproto.Cost
		if u.Cost != nil && u.Cost.Currency != "" {
			s.sawCost = true
			cost = &chatproto.Cost{Amount: u.Cost.Amount, Currency: u.Cost.Currency}
		}
		s.change(func(c *chatproto.Chat) {
			usage := cloneUsage(c.Usage)
			withContext(usage, used, size)
			if cost != nil {
				usage.Cost = cost
			}
			c.Usage = usage
		})
	default:
		s.once("update " + head.Kind)
	}
}

// Request serves a request of the agent (rpc.Handler): a permission, which
// waits for the user's answer, the turn's cancel or the session's end;
// every other method is one this client does not serve.
func (s *session) Request(ctx context.Context, method string, params json.RawMessage) (any, error) {
	if method != rpc.MethodSessionRequestPermission {
		s.mu.Lock()
		s.once("request " + method)
		s.mu.Unlock()
		return nil, rpc.ErrMethodNotFound
	}
	var req rpc.PermissionRequest
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, &rpc.Error{Code: rpc.CodeInvalidParams, Message: "Invalid params"}
	}
	var h toolHead
	json.Unmarshal(req.ToolCall, &h)

	s.mu.Lock()
	if s.ended || s.pending >= maxPending {
		s.mu.Unlock()
		return rpc.PermissionCancelled(), nil
	}
	s.pending++
	toolCall := s.it.toolCall(req.ToolCall)
	kind := s.it.toolKind(h.ID)
	var tk struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(req.ToolCall, &tk) == nil && tk.Kind != "" {
		kind = tk.Kind
	}
	tctx := s.ctx
	if s.turn != nil {
		tctx = s.turn.ctx
	}
	mark := s.out.mark()
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.pending--
		s.mu.Unlock()
	}()

	options := permissionOptions(req.Options)
	if len(options) == 0 {
		return rpc.PermissionCancelled(), nil
	}
	wctx, stop := context.WithCancel(tctx)
	defer stop()
	defer context.AfterFunc(ctx, stop)()
	// The host has what came before the request first: the tool call.
	s.out.reached(wctx, mark)
	if wctx.Err() != nil {
		return rpc.PermissionCancelled(), nil
	}
	ans, err := s.sink.Permission(wctx, chatadapter.PermissionRequest{
		Kind: permissionKind(kind), ToolCall: toolCall, Options: options,
	})
	if err != nil || ans.Cancelled || !slices.ContainsFunc(options, func(o chatproto.PermissionOption) bool { return o.OptionID == ans.Option }) {
		return rpc.PermissionCancelled(), nil
	}
	return rpc.PermissionSelected(ans.Option), nil
}

// permissionOptions are the agent's options of a permission that the user
// is offered: not those that allow or reject for good, which an agent may
// keep in its own settings.
func permissionOptions(opts []rpc.PermissionOption) []chatproto.PermissionOption {
	out := []chatproto.PermissionOption{}
	for _, o := range opts {
		switch o.Kind {
		case rpc.PermissionAllowOnce, rpc.PermissionRejectOnce:
			if o.OptionID != "" {
				out = append(out, chatproto.PermissionOption{OptionID: o.OptionID, Name: clip(o.Name, maxName), Kind: string(o.Kind)})
			}
		}
	}
	return out
}

// permissionKind is the kind of a permission for a tool call of an ACP
// tool kind.
func permissionKind(toolKind string) string {
	switch toolKind {
	case "execute":
		return chatproto.PermissionCommand
	case "edit", "delete", "move":
		return chatproto.PermissionFile
	}
	return chatproto.PermissionTool
}

// PID is the agent's process id, which is the id of its process group: a
// host that ends every agent at once signals the group.
func (s *session) PID() int { return s.proc.pgid }

// ID is the agent's id of the session.
func (s *session) ID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.id
}

// usable is why the session takes no command; nil when it does. The caller
// holds s.mu.
func (s *session) usable() error {
	if s.ended || s.closing {
		return &chatproto.Error{Code: chatproto.CodeEnded, Message: "the agent is gone"}
	}
	return nil
}

// Prompt starts a turn with the user's message, or queues it while one
// runs: the protocol has a turn per prompt, and the message is sent once
// the turn ended (EventQueued waiting, then taken). A message that starts
// a turn the host did not record is told here (EventUser).
func (s *session) Prompt(ctx context.Context, p chatadapter.PromptParams) error {
	if err := s.checkContent(p.Content); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.usable(); err != nil {
		return err
	}
	if s.turn != nil || len(s.queue) > 0 {
		if len(s.queue) >= maxQueue {
			return &chatproto.Error{Code: chatproto.CodeBusy, Message: "too many messages wait for the turn"}
		}
		q := queued{message: p.Message, clientID: p.ClientID, content: slices.Clone(p.Content)}
		s.queue = append(s.queue, q)
		s.emit(chatproto.Event{T: chatproto.EventQueued, State: chatproto.QueuedWaiting, Message: q.message, ClientID: q.clientID, Content: q.content})
		return nil
	}
	var user *chatproto.Event
	if !p.Recorded {
		// The host saw a turn run, which ended meanwhile.
		user = &chatproto.Event{T: chatproto.EventUser, ClientID: p.ClientID, Content: slices.Clone(p.Content)}
	}
	s.startTurn(slices.Clone(p.Content), user)
	return nil
}

// checkContent refuses content blocks the agent did not say it takes.
func (s *session) checkContent(content []json.RawMessage) error {
	s.mu.Lock()
	pc := s.caps.PromptCapabilities
	s.mu.Unlock()
	if len(content) == 0 {
		return &chatproto.Error{Code: chatproto.CodeBadRequest, Message: "a prompt without content"}
	}
	for _, b := range content {
		var h struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(b, &h) != nil {
			return &chatproto.Error{Code: chatproto.CodeBadRequest, Message: "a content block that is no object"}
		}
		ok := true
		switch h.Type {
		case "text", "resource_link":
		case "image":
			ok = pc.Image
		case "audio":
			ok = pc.Audio
		case "resource":
			ok = pc.EmbeddedContext
		default:
			return &chatproto.Error{Code: chatproto.CodeBadRequest, Message: "a content block of an unknown type"}
		}
		if !ok {
			return &chatproto.Error{Code: chatproto.CodeUnsupported, Message: "the agent takes no " + h.Type + " blocks"}
		}
	}
	return nil
}

// startTurn sends a prompt as a turn, after the prompt's EventUser when
// user is not nil. The caller holds s.mu, and no turn runs.
func (s *session) startTurn(content []json.RawMessage, user *chatproto.Event) {
	s.it.endTurn() // what the agent said between turns
	if user != nil {
		s.emit(*user)
	}
	ctx, cancel := context.WithCancel(s.ctx)
	t := &turn{ctx: ctx, cancel: cancel, sent: make(chan struct{})}
	s.turn = t
	s.emit(chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnStart})
	id := s.id
	go s.runTurn(t, id, content)
}

// runTurn waits for the agent's end of a turn, then sends the next queued
// message.
func (s *session) runTurn(t *turn, id string, content []json.RawMessage) {
	res := &rpc.PromptResult{}
	p, err := s.conn.GoPrompt(s.ctx, rpc.PromptParams{SessionID: id, Prompt: content})
	close(t.sent)
	if err == nil {
		err = p.Wait(s.ctx, res)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.turn != t || errors.Is(err, rpc.ErrClosed) || s.ctx.Err() != nil {
		return // the session's end ends the turn
	}
	s.it.endTurn()
	s.turn = nil
	t.cancel()
	if err != nil {
		s.emit(chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnError, Error: callError(err)})
	} else {
		s.emit(chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnEnd, StopReason: string(res.StopReason)})
		s.turnUsage(res)
	}
	if len(s.queue) > 0 && !s.closing {
		q := s.queue[0]
		s.queue = s.queue[1:]
		s.emit(chatproto.Event{T: chatproto.EventQueued, State: chatproto.QueuedTaken, Message: q.message, ClientID: q.clientID, Content: q.content})
		s.startTurn(q.content, nil)
	}
}

// turnUsage takes what an answer's _meta tells of the turn (Grok's): the
// context in use, when the agent sends no usage_update, and the turn's
// cost, added to the session's, when it sends no cost. The caller holds
// s.mu.
func (s *session) turnUsage(res *rpc.PromptResult) {
	var m turnMeta
	if !present(res.Meta) || json.Unmarshal(res.Meta, &m) != nil {
		return
	}
	setContext := !s.sawUsage && m.TotalTokens > 0
	used, size := m.TotalTokens, s.sizes[m.ModelID]
	cost := 0.0
	if !s.sawCost && m.Usage.CostUsdTicks > 0 {
		cost = float64(m.Usage.CostUsdTicks) * usdPerTick
	}
	if !setContext && cost == 0 {
		return
	}
	s.change(func(c *chatproto.Chat) {
		usage := cloneUsage(c.Usage)
		if setContext {
			withContext(usage, used, size)
		}
		if cost > 0 {
			if usage.Cost == nil || usage.Cost.Currency != "USD" {
				usage.Cost = &chatproto.Cost{Currency: "USD"}
			}
			usage.Cost.Amount += cost
		}
		c.Usage = usage
	})
}

// Cancel cancels the running turn: the agent is told, the permissions it
// asks are answered as cancelled, and the queued messages are withdrawn.
func (s *session) Cancel(ctx context.Context) error {
	s.mu.Lock()
	if err := s.usable(); err != nil {
		s.mu.Unlock()
		return err
	}
	s.dropQueue()
	t, id := s.turn, s.id
	if t != nil {
		t.cancel()
	}
	s.mu.Unlock()
	if t == nil {
		return nil
	}
	select {
	case <-t.sent:
	case <-ctx.Done():
		return callError(ctx.Err())
	}
	if err := s.conn.Cancel(id); err != nil {
		return callError(err)
	}
	return nil
}

// dropQueue withdraws every queued message. The caller holds s.mu.
func (s *session) dropQueue() {
	for _, q := range s.queue {
		s.emit(chatproto.Event{T: chatproto.EventQueued, State: chatproto.QueuedCancelled, Message: q.message, ClientID: q.clientID})
	}
	s.queue = nil
}

// CancelQueued withdraws a queued message.
func (s *session) CancelQueued(ctx context.Context, message string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.usable(); err != nil {
		return err
	}
	i := slices.IndexFunc(s.queue, func(q queued) bool { return q.message == message })
	if i < 0 {
		return &chatproto.Error{Code: chatproto.CodeNotFound, Message: "no such message waits"}
	}
	q := s.queue[i]
	s.queue = slices.Delete(s.queue, i, i+1)
	s.emit(chatproto.Event{T: chatproto.EventQueued, State: chatproto.QueuedCancelled, Message: q.message, ClientID: q.clientID})
	return nil
}

// SetConfig sets a configuration option: through session/set_mode for the
// option made of the agent's session modes, else
// session/set_config_option.
func (s *session) SetConfig(ctx context.Context, id, value string) error {
	s.mu.Lock()
	if err := s.usable(); err != nil {
		s.mu.Unlock()
		return err
	}
	o := optionByID(s.config, id)
	if o == nil {
		s.mu.Unlock()
		return &chatproto.Error{Code: chatproto.CodeBadRequest, Message: "the chat has no such option"}
	}
	if !hasValue(o, value) {
		s.mu.Unlock()
		return &chatproto.Error{Code: chatproto.CodeBadRequest, Message: "not a value of the option"}
	}
	legacy, session := id == s.legacy, s.id
	s.mu.Unlock()
	return s.set(ctx, session, id, value, legacy)
}

// set sets an option the agent has to one of its values.
func (s *session) set(ctx context.Context, session, id, value string, legacy bool) error {
	ctx, cancel := context.WithTimeout(ctx, s.t.call)
	defer cancel()
	if legacy {
		if err := s.conn.SetMode(ctx, rpc.SetModeParams{SessionID: session, ModeID: value}); err != nil {
			return callError(err)
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if o := optionByID(s.config, id); o != nil && !s.ended {
			o.CurrentValue = value
			s.stateConfig()
		}
		return nil
	}
	res, err := s.conn.SetConfigOption(ctx, rpc.SetConfigOptionParams{SessionID: session, ConfigID: id, Value: value})
	if err != nil {
		return callError(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return nil
	}
	if present(res.ConfigOptions) {
		s.setConfig(res.ConfigOptions, nil)
	} else if o := optionByID(s.config, id); o != nil {
		o.CurrentValue = value
		s.stateConfig()
	}
	return nil
}

// Compact: the protocol has no way to; an agent's own command (/compact)
// is a prompt.
func (s *session) Compact(ctx context.Context) error {
	return &chatproto.Error{Code: chatproto.CodeUnsupported, Message: "the agent compacts by its own command only"}
}

// Close ends the agent gracefully: its input closes, SIGTERM follows after
// a grace period and SIGKILL after another one. It returns once the agent
// is gone or ctx ends.
func (s *session) Close(ctx context.Context) error {
	s.mu.Lock()
	s.closing = true
	s.mu.Unlock()
	s.proc.stop(s.t.grace, s.t.term)
	select {
	case <-s.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Done is closed when the agent process ended, and the host had every
// event of the session.
func (s *session) Done() <-chan struct{} { return s.done }

// Err is why the session ended: nil after Close.
func (s *session) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

// watch waits for the agent's end: its output closing, or its process
// exiting while a program it started still holds the output.
func (s *session) watch() {
	select {
	case <-s.conn.Done():
	case <-s.proc.exited:
		wait(s.conn.Done(), s.t.drain)
	}
	s.proc.stop(s.t.grace, s.t.term)
	s.conn.Close()
	<-s.proc.stopped
	s.finish()
}

// finish ends the session once its process is gone: a turn that ran ends
// with an error, the queued messages are withdrawn, and what waits for the
// user returns.
func (s *session) finish() {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return
	}
	s.ended = true
	if !s.closing {
		e := &chatproto.Error{Code: chatproto.CodeEnded, Message: "the agent exited", Stderr: s.proc.stderr()}
		if st := s.proc.status(); st != "" {
			e.Message += " (" + st + ")"
		}
		s.err = e
	}
	if t := s.turn; t != nil {
		s.it.endTurn()
		s.turn = nil
		t.cancel()
		e := &chatproto.Error{Code: chatproto.CodeEnded, Message: "the agent is gone"}
		s.emit(chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnError, Error: e})
	} else {
		s.it.endTurn()
	}
	s.dropQueue()
	s.mu.Unlock()
	s.cancel()
	s.out.close()
	<-s.out.done
	close(s.done)
}

// callError is the error of a command or a turn, from the error of the
// call to the agent.
func callError(err error) *chatproto.Error {
	var e *rpc.Error
	switch {
	case errors.Is(err, rpc.ErrClosed):
		return &chatproto.Error{Code: chatproto.CodeEnded, Message: "the agent is gone"}
	case errors.As(err, &e) && e.Code == rpc.CodeAuthRequired:
		return &chatproto.Error{Code: chatproto.CodeAuthRequired, Message: e.Message}
	case errors.Is(err, rpc.ErrMethodNotFound):
		return &chatproto.Error{Code: chatproto.CodeUnsupported, Message: "the agent does not know the method"}
	case errors.As(err, &e):
		return &chatproto.Error{Code: chatproto.CodeFailed, Message: e.Message}
	case errors.Is(err, context.DeadlineExceeded):
		return &chatproto.Error{Code: chatproto.CodeFailed, Message: "the agent did not answer in time"}
	case errors.Is(err, context.Canceled):
		return &chatproto.Error{Code: chatproto.CodeEnded, Message: "the session ends"}
	}
	return &chatproto.Error{Code: chatproto.CodeFailed, Message: err.Error()}
}
