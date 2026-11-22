package codex

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

// The timings of a session; variables for the tests.
var (
	// startTimeout bounds starting the app-server and its thread, whatever
	// Start's context allows.
	startTimeout = 60 * time.Second
	// interruptGrace is how long a command may still run after the turn
	// was interrupted (Codex does not stop it) before the app-server is
	// started again, which ends it.
	interruptGrace = 2 * time.Second
	// usageEvery is how often a turn's usage reaches the host at most; the
	// end of a turn sends it in any case.
	usageEvery = 5 * time.Second
)

// implementPlan is the prompt that has an approved plan carried out, as
// Codex's own client words it.
const implementPlan = "Implement the plan."

// The answers of a permission the host shows for Codex, which has none of
// its own.
var permissionOptions = []chatproto.PermissionOption{
	{OptionID: chatadapter.OptionAllowOnce, Name: "Allow", Kind: chatproto.AllowOnce},
	{OptionID: chatadapter.OptionAllowSession, Name: "Allow for this session", Kind: chatproto.AllowAlways},
	{OptionID: chatadapter.OptionRejectOnce, Name: "Reject", Kind: chatproto.RejectOnce},
}

// planOptions are the answers of a plan's approval: carry it out asking
// before changes, or making edits without asking, or keep planning.
var planOptions = []chatproto.PermissionOption{
	{OptionID: chatadapter.PlanOption(chatproto.ModeDefault), Name: "Approve", Kind: chatproto.AllowOnce},
	{OptionID: chatadapter.PlanOption(chatproto.ModeAcceptEdits), Name: "Approve and accept edits", Kind: chatproto.AllowOnce},
	{OptionID: chatadapter.OptionRejectOnce, Name: "Keep planning", Kind: chatproto.RejectOnce},
}

// message is a prompt the session queued or steered into a running turn.
type message struct {
	p chatadapter.PromptParams
}

// openItem is a tool call of an item that started and did not complete.
type openItem struct {
	it     *item
	thread string
	parent string
	// last is the stored state of its tool call.
	last json.RawMessage
	// shown: the log has it in progress (not cancelled at its turn's end).
	shown bool
}

// child is a subagent's thread: the tool call that started it.
type child struct {
	call   string
	parent string
	state  obj
}

// pending is a request of the app-server that waits for the user.
type pending struct {
	ctx      context.Context
	cancel   context.CancelFunc
	resolved atomic.Bool
}

// planAsk is a plan's approval being asked, after the end of the turn
// that made the plan (the host cancels what was asked before a turn's
// end).
type planAsk struct {
	cancel context.CancelFunc
	done   chan struct{}
	// superseded: a prompt came instead of an answer (or the session
	// ended); the plan is not carried out.
	superseded bool
}

// session is a chat's Codex thread on an app-server process.
type session struct {
	ad   *Adapter
	p    chatadapter.StartParams
	sink chatadapter.Sink
	log  *log.Logger
	m    mapper

	ctx    context.Context // ends with the session
	cancel context.CancelFunc

	// sem is held by what starts or steers a turn, compacts, or starts
	// the app-server again.
	sem chan struct{}

	mu       sync.Mutex
	c        *conn
	thread   string
	models   models
	st       settings
	version  string
	turn     string // the running turn's id, once known
	active   bool   // a turn runs (or was asked for)
	compact  bool   // the running turn compacts
	prompt   string // the clientUserMessageId of the turn's prompt
	skipUser bool   // the turn's first user message is its prompt, which the host told
	steers   []message
	queue    []message
	items    map[string]*openItem
	children map[string]child
	plan     struct{ id, text string }
	ask      *planAsk
	pending  map[string]*pending
	usage    chatproto.Usage
	limits   map[string][]chatproto.Limit
	dirty    bool
	flushed  time.Time
	lastErr  *turnError

	restarting, closing, ended bool
	done                       chan struct{}
	err                        error
}

func newID() string {
	var b [8]byte
	rand.Read(b[:])
	return "m" + hex.EncodeToString(b[:])
}

func (s *session) logf(format string, args ...any) {
	if s.log != nil {
		s.log.Printf("codex: "+format, args...)
	}
}

func (s *session) acquire(ctx context.Context) bool {
	select {
	case s.sem <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	}
}

func (s *session) release() { <-s.sem }

func (s *session) emit(evs ...chatproto.Event) {
	for _, ev := range evs {
		if ev.At.IsZero() {
			ev.At = time.Now()
		}
		s.sink.Event(ev)
	}
}

// ---- the app-server ----

// sessionHandler takes what one app-server process of the session sends;
// a process the session replaced is no longer heard.
type sessionHandler struct {
	s *session
	c *conn
}

func (h *sessionHandler) notify(method string, params json.RawMessage, at time.Time) {
	h.s.notify(h.c, method, params, at)
}

func (h *sessionHandler) request(r *serverRequest) { h.s.request(h.c, r) }

// connect starts an app-server and takes the session's thread on it: a
// new one (resume ""), or resume's. first is the session's start: the
// models and the settings are found then.
func (s *session) connect(ctx context.Context, resume string, first bool) error {
	ctx, cancel := context.WithTimeout(ctx, startTimeout)
	defer cancel()
	proc, err := startProcess(s.p.Argv, s.p.Cwd, s.p.Env)
	if err != nil {
		return &chatproto.Error{Code: chatproto.CodeStartFailed, Message: err.Error()}
	}
	c := newConn(proc, func(c *conn) handler { return &sessionHandler{s, c} }, s.log)
	s.mu.Lock()
	s.c = c
	s.mu.Unlock()
	go s.watch(c)
	version, err := initialize(ctx, c, s.p.Client)
	if err != nil {
		return startError(c, err)
	}
	var ms models
	if first {
		ms = listModels(ctx, c, s.log)
		if err := checkAccount(ctx, c); err != nil {
			return err
		}
	}
	s.mu.Lock()
	model := s.st.model
	s.mu.Unlock()
	if first {
		model = s.p.Options.Model
		if model != "" && len(ms) > 0 && ms.find(model) == nil {
			s.logf("the model %q is not offered; the thread's own is used", model)
			model = ""
		}
	}
	method := mThreadStart
	if resume != "" {
		method = mThreadResume
	}
	var res threadResult
	if err := c.call(ctx, method, threadParams(resume, s.p.Cwd, model), &res); err != nil {
		return startError(c, err)
	}
	if res.Thread.ID == "" {
		return &chatproto.Error{Code: chatproto.CodeStartFailed, Message: method + " answered no thread"}
	}
	s.mu.Lock()
	if first {
		s.thread = res.Thread.ID
	} else if res.Thread.ID != s.thread {
		s.logf("thread/resume of %s answered the thread %s", s.thread, res.Thread.ID)
	}
	s.version = version
	if first {
		s.models = ms
		s.st.model = model
		if s.st.model == "" {
			s.st.model = res.Model
		}
		thread := ""
		if res.ReasoningEffort != nil {
			thread = *res.ReasoningEffort
		}
		s.st.effort = ms.effortFor(s.st.model, s.p.Options.Effort, thread)
		s.st.mode = s.p.Options.Mode
		if !slices.Contains(chatproto.Modes, s.st.mode) {
			s.st.mode = s.p.Settings.DefaultMode
		}
		if !slices.Contains(chatproto.Modes, s.st.mode) {
			s.st.mode = chatproto.ModeDefault
		}
	}
	s.mu.Unlock()
	return nil
}

// startError is why a start failed: the app-server's own error, or its end
// with what it wrote to its standard error.
func startError(c *conn, err error) error {
	var ce *chatproto.Error
	if errors.As(err, &ce) {
		return ce
	}
	if errors.Is(err, errClosed) {
		return &chatproto.Error{Code: chatproto.CodeStartFailed, Message: "the app-server ended", Stderr: c.proc.tail.String()}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return &chatproto.Error{Code: chatproto.CodeStartFailed, Message: "the app-server did not answer in time", Stderr: c.proc.tail.String()}
	}
	return callError(err)
}

// callError is an error of a request as the host's: Codex's answers about
// threads that are not there are CodeNotFound.
func callError(err error) error {
	var re *rpcError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &re):
		code := chatproto.CodeFailed
		for _, p := range []string{"no rollout found", "thread not found", "thread not loaded", "invalid thread id"} {
			if strings.HasPrefix(re.Message, p) {
				code = chatproto.CodeNotFound
			}
		}
		return &chatproto.Error{Code: code, Message: re.Message}
	case errors.Is(err, errClosed):
		return &chatproto.Error{Code: chatproto.CodeEnded, Message: "the app-server is gone"}
	}
	return err
}

// initialize is the handshake; it answers the app-server's version (from
// its user agent, "<client>/<version> (...)").
func initialize(ctx context.Context, c *conn, client chatadapter.ClientInfo) (string, error) {
	name, version := client.Name, client.Version
	if name == "" {
		name = clientTitle
	}
	if version == "" {
		version = "0"
	}
	var res initializeResult
	err := c.call(ctx, mInitialize, map[string]any{
		"clientInfo": map[string]any{"name": clientName, "title": name, "version": version},
		// requestAttestation is required: we have none to give.
		"capabilities": map[string]any{"experimentalApi": true, "requestAttestation": false},
	}, &res)
	if err != nil {
		return "", err
	}
	if err := c.notifyServer(mInitialized); err != nil {
		return "", errClosed
	}
	return agentVersion(res.UserAgent), nil
}

// agentVersion is the version a user agent "<name>/<version> (...)" states.
func agentVersion(ua string) string {
	_, rest, ok := strings.Cut(ua, "/")
	if !ok {
		return ""
	}
	v, _, _ := strings.Cut(rest, " ")
	return cutText(v, 64)
}

// listModels are the models model/list offers (the hidden ones left out);
// none when it fails.
func listModels(ctx context.Context, c *conn, logger *log.Logger) models {
	var out models
	cursor := ""
	for range 10 {
		p := map[string]any{"limit": 100, "includeHidden": false}
		if cursor != "" {
			p["cursor"] = cursor
		}
		var res modelListResult
		if err := c.call(ctx, mModelList, p, &res); err != nil {
			if logger != nil {
				logger.Printf("codex: model/list: %v", err)
			}
			return out
		}
		for _, m := range res.Data {
			if !m.Hidden && m.slug() != "" {
				out = append(out, m)
			}
		}
		if res.NextCursor == nil || *res.NextCursor == "" {
			break
		}
		cursor = *res.NextCursor
	}
	return out
}

// checkAccount refuses a start without a sign-in Codex needs.
func checkAccount(ctx context.Context, c *conn) error {
	var res accountReadResult
	if err := c.call(ctx, mAccountRead, map[string]any{"refreshToken": false}, &res); err != nil {
		return nil
	}
	if res.RequiresOpenaiAuth && (len(res.Account) == 0 || string(res.Account) == "null") {
		return &chatproto.Error{Code: chatproto.CodeAuthRequired, Message: "Codex is not signed in"}
	}
	return nil
}

// watch ends the session when its app-server ends, unless the session
// replaced it.
func (s *session) watch(c *conn) {
	<-c.closed
	<-c.proc.exited
	s.mu.Lock()
	if c != s.c || s.restarting {
		s.mu.Unlock()
		return
	}
	closing := s.closing
	s.mu.Unlock()
	var err error
	if !closing {
		msg := "the app-server ended"
		if c.proc.waitErr != nil {
			msg += ": " + c.proc.waitErr.Error()
		}
		err = &chatproto.Error{Code: chatproto.CodeEnded, Message: msg, Stderr: c.proc.tail.String()}
	}
	s.finish(err)
}

// finish ends the session: what waits is cancelled, a running turn ends
// (cancelled after Close, with the error otherwise).
func (s *session) finish(err error) {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return
	}
	s.ended = true
	s.err = err
	var evs []chatproto.Event
	turn := s.turn
	open := s.active
	if a := s.ask; a != nil {
		a.superseded = true
		a.cancel()
	}
	s.ask = nil
	if open {
		if err == nil {
			evs = append(evs, chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnEnd, StopReason: "cancelled", Item: turn})
		} else {
			evs = append(evs, chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnError, Error: asProtoError(err), Item: turn})
		}
	}
	for _, m := range s.steers {
		// Steered into the turn, which had them (as a turn's end tells).
		evs = append(evs, queuedEvent(m.p, chatproto.QueuedTaken, false))
	}
	for _, m := range s.queue {
		evs = append(evs, queuedEvent(m.p, chatproto.QueuedCancelled, false))
	}
	s.steers, s.queue, s.active, s.turn = nil, nil, false, ""
	pend := s.takePending()
	s.mu.Unlock()
	for _, p := range pend {
		p.cancel()
	}
	s.cancel()
	s.emit(evs...)
	close(s.done)
	s.ad.forget(s)
}

func asProtoError(err error) *chatproto.Error {
	var ce *chatproto.Error
	if errors.As(err, &ce) {
		return ce
	}
	return &chatproto.Error{Code: chatproto.CodeFailed, Message: err.Error()}
}

// takePending empties the requests that wait; s.mu is held.
func (s *session) takePending() []*pending {
	var out []*pending
	for k, p := range s.pending {
		out = append(out, p)
		delete(s.pending, k)
	}
	return out
}

// restart ends the app-server and starts another on the session's
// thread: Codex does not stop the command of a turn it interrupted, the
// end of its process does.
func (s *session) restart() {
	if !s.acquire(s.ctx) {
		return
	}
	defer s.release()
	s.mu.Lock()
	if s.ended || s.closing || s.active || !s.commandRuns() {
		s.mu.Unlock()
		return
	}
	s.restarting = true
	old, thread := s.c, s.thread
	var evs []chatproto.Event
	for _, id := range s.itemIDs() {
		if oi := s.items[id]; oi.shown {
			evs = append(evs, s.cancelledEvent(id, oi))
		}
		delete(s.items, id)
	}
	pend := s.takePending()
	s.mu.Unlock()
	for _, p := range pend {
		p.cancel()
	}
	s.emit(evs...)
	s.logf("starting the app-server again: a command of the interrupted turn still runs")
	old.proc.end()
	s.mu.Lock()
	closing := s.closing
	s.mu.Unlock()
	var err error
	if !closing {
		err = s.connect(s.ctx, thread, false)
	}
	s.mu.Lock()
	s.restarting = false
	closing = s.closing
	c := s.c
	s.mu.Unlock()
	switch {
	case closing:
		if c != old {
			c.proc.end()
		}
		s.finish(nil)
	case err != nil:
		if c != old {
			go c.proc.end()
		}
		s.finish(err)
	default:
		s.mu.Lock()
		mode := s.st.mode
		s.mu.Unlock()
		s.emit(noticeEvent(agentproto.NoticeRestarted, "", obj{"mode": mode}, time.Now()))
	}
}

// itemIDs are the ids of the open items, sorted; s.mu is held.
func (s *session) itemIDs() []string {
	ids := make([]string, 0, len(s.items))
	for id := range s.items {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

// commandRuns tells whether a command started and did not complete; s.mu
// is held.
func (s *session) commandRuns() bool {
	for _, oi := range s.items {
		if oi.it.Type == itemCommand {
			return true
		}
	}
	return false
}

// ---- chatadapter.Session ----

func (s *session) ID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.thread
}

func (s *session) Done() <-chan struct{} { return s.done }

// PID is the app-server's process id, the leader of its process group (the
// host kills the group when it must end at once); 0 before it started.
func (s *session) PID() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.c == nil {
		return 0
	}
	return s.c.proc.pid
}

func (s *session) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

var errEnded = &chatproto.Error{Code: chatproto.CodeEnded, Message: "the session ended"}

// isCompact tells a prompt that is the slash command /compact.
func isCompact(content []json.RawMessage) bool {
	if len(content) != 1 {
		return false
	}
	var b struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	return json.Unmarshal(content[0], &b) == nil && b.Type == "text" && strings.TrimSpace(b.Text) == "/compact"
}

// Prompt starts a turn; while one runs, it steers the message into it
// (turn/steer), or queues it for the turn's end where the turn takes no
// steering (a compaction); a prompt while a plan waits for its approval
// keeps planning with it. A prompt that starts a turn is the host's to
// tell (EventUser) when it recorded it, else told here before the turn
// starts; one sent while a turn runs or a permission waits is told here:
// EventQueued queued, then taken once the agent took it (the user's
// message from then on), or cancelled.
func (s *session) Prompt(ctx context.Context, p chatadapter.PromptParams) error {
	if isCompact(p.Content) {
		return s.Compact(ctx)
	}
	input, err := toUserInput(p.Content)
	if err != nil {
		return err
	}
	if p.Message == "" {
		p.Message = newID()
	}
	if !s.acquire(ctx) {
		return ctx.Err()
	}
	defer s.release()
	s.mu.Lock()
	if s.ended || s.closing {
		s.mu.Unlock()
		return errEnded
	}
	if a := s.ask; a != nil {
		// The host saw a permission waiting: the message is told as
		// queued and taken.
		a.superseded = true
		s.mu.Unlock()
		a.cancel()
		select {
		case <-a.done:
		case <-ctx.Done():
			return ctx.Err()
		}
		if p.Recorded {
			// The host stored the message's EventUser, and stores the
			// turn's error.
			return s.startTurn(ctx, input, p.Message)
		}
		s.emit(queuedEvent(p, chatproto.QueuedWaiting, true), queuedEvent(p, chatproto.QueuedTaken, false))
		return s.startTold(ctx, input, p.Message)
	}
	switch {
	case !s.active && p.Recorded:
		s.mu.Unlock()
		return s.startTurn(ctx, input, p.Message)
	case !s.active:
		// The host saw a turn run, which ended meanwhile: the message
		// starts the next, told here.
		s.mu.Unlock()
		s.emit(userEvent(p))
		return s.startTold(ctx, input, p.Message)
	case s.turn == "" || s.compact:
		s.queue = append(s.queue, message{p})
		s.mu.Unlock()
		s.emit(queuedEvent(p, chatproto.QueuedWaiting, true))
		return nil
	}
	c, thread, turn := s.c, s.thread, s.turn
	s.mu.Unlock()
	s.emit(queuedEvent(p, chatproto.QueuedWaiting, true))
	s.mu.Lock()
	s.steers = append(s.steers, message{p})
	s.mu.Unlock()
	var res struct {
		TurnID string `json:"turnId"`
	}
	err = c.call(ctx, mTurnSteer, map[string]any{"threadId": thread, "expectedTurnId": turn, "clientUserMessageId": p.Message, "input": input}, &res)
	if err == nil {
		return nil
	}
	s.mu.Lock()
	taken := !slices.ContainsFunc(s.steers, func(m message) bool { return m.p.Message == p.Message })
	s.steers = slices.DeleteFunc(s.steers, func(m message) bool { return m.p.Message == p.Message })
	var re *rpcError
	switch {
	case taken:
		// The turn ended meanwhile and told it taken.
		s.mu.Unlock()
		return nil
	case errors.As(err, &re) && strings.HasPrefix(re.Message, "no active turn"):
		// The turn ended before the message reached it: it starts the
		// next, which this session told as its message.
		s.mu.Unlock()
		s.emit(queuedEvent(p, chatproto.QueuedTaken, false))
		return s.startTold(ctx, input, p.Message)
	case errors.As(err, &re) && s.active:
		// The turn takes no steering: the message waits for its end.
		s.queue = append(s.queue, message{p})
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	s.emit(queuedEvent(p, chatproto.QueuedCancelled, false))
	return callError(err)
}

func queuedEvent(p chatadapter.PromptParams, state string, content bool) chatproto.Event {
	ev := chatproto.Event{T: chatproto.EventQueued, At: time.Now(), Message: p.Message, ClientID: p.ClientID, State: state}
	if content {
		ev.Content = p.Content
	}
	return ev
}

func userEvent(p chatadapter.PromptParams) chatproto.Event {
	return chatproto.Event{T: chatproto.EventUser, At: time.Now(), Content: p.Content, ClientID: p.ClientID}
}

// startTurn sends turn/start; s.sem is held.
func (s *session) startTurn(ctx context.Context, input []userInput, clientMessage string) error {
	s.mu.Lock()
	if s.ended || s.closing {
		s.mu.Unlock()
		return errEnded
	}
	params := turnParams(s.thread, s.p.Cwd, clientMessage, input, s.st)
	s.active, s.turn, s.compact = true, "", false
	s.prompt, s.skipUser = clientMessage, true
	c := s.c
	s.mu.Unlock()
	var res turnResult
	err := c.call(ctx, mTurnStart, params, &res)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		s.active, s.prompt, s.skipUser = false, "", false
		return callError(err)
	}
	if s.active && s.turn == "" {
		s.turn = res.Turn.ID
	}
	return nil
}

// startTold starts a turn whose message this session told the host
// (EventUser, or EventQueued taken): a turn that does not start ends in an
// error the log keeps, as the host does for the messages it told. s.sem is
// held.
func (s *session) startTold(ctx context.Context, input []userInput, clientMessage string) error {
	err := s.startTurn(ctx, input, clientMessage)
	if err != nil {
		s.emit(chatproto.Event{T: chatproto.EventTurn, At: time.Now(), State: chatproto.TurnError, Error: asProtoError(err)})
	}
	return err
}

// sendQueued starts a turn with the messages that waited for the last
// one's end.
func (s *session) sendQueued(queue []message) {
	// Never sent once the session ends: its end told the queue it had
	// then, not these.
	unsent := func() {
		var evs []chatproto.Event
		for _, m := range queue {
			evs = append(evs, queuedEvent(m.p, chatproto.QueuedCancelled, false))
		}
		s.emit(evs...)
	}
	if !s.acquire(s.ctx) {
		unsent()
		return
	}
	defer s.release()
	s.mu.Lock()
	switch {
	case s.ended || s.closing:
		s.mu.Unlock()
		unsent()
		return
	case s.active:
		s.queue = append(queue, s.queue...)
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	var input []userInput
	var evs []chatproto.Event
	for _, m := range queue {
		in, err := toUserInput(m.p.Content)
		if err != nil {
			evs = append(evs, queuedEvent(m.p, chatproto.QueuedCancelled, false))
			continue
		}
		input = append(input, in...)
		evs = append(evs, queuedEvent(m.p, chatproto.QueuedTaken, false))
	}
	s.emit(evs...)
	if len(input) == 0 {
		return
	}
	if err := s.startTurn(s.ctx, input, queue[0].p.Message); err != nil {
		s.logf("sending the queued messages: %v", err)
		s.emit(noticeEvent(agentproto.NoticeError, "", obj{"message": err.Error()}, time.Now()))
	}
}

// Cancel interrupts the running turn; the permissions and questions that
// wait and the queued messages go with it. A command the turn started
// still runs after the interrupt: the app-server is started again if one
// does interruptGrace later.
func (s *session) Cancel(ctx context.Context) error {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return nil
	}
	ask := s.ask
	queue := s.queue
	s.queue = nil
	pend := s.takePending()
	active := s.active
	s.mu.Unlock()
	var evs []chatproto.Event
	for _, m := range queue {
		evs = append(evs, queuedEvent(m.p, chatproto.QueuedCancelled, false))
	}
	s.emit(evs...)
	for _, p := range pend {
		p.cancel()
	}
	if ask != nil {
		ask.cancel()
	}
	if !active {
		return nil
	}
	// The turn's id comes with turn/start's answer (or turn/started, for
	// a compaction).
	turn, c, thread, err := s.runningTurn(ctx)
	if err != nil || turn == "" {
		return err
	}
	err = c.call(ctx, mTurnInterrupt, map[string]any{"threadId": thread, "turnId": turn}, nil)
	time.AfterFunc(interruptGrace, func() {
		s.mu.Lock()
		runs := !s.ended && !s.closing && s.commandRuns()
		s.mu.Unlock()
		if runs {
			s.restart()
		}
	})
	return callError(err)
}

// runningTurn is the running turn's id, waited for while its start is
// still answered; "" when no turn runs.
func (s *session) runningTurn(ctx context.Context) (turn string, c *conn, thread string, err error) {
	for {
		s.mu.Lock()
		turn, c, thread = s.turn, s.c, s.thread
		active := s.active
		s.mu.Unlock()
		if turn != "" || !active {
			return turn, c, thread, nil
		}
		select {
		case <-ctx.Done():
			return "", nil, "", ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// CancelQueued withdraws a message that waits for the turn's end; one
// steered into the turn reached the agent already.
func (s *session) CancelQueued(ctx context.Context, msg string) error {
	s.mu.Lock()
	i := slices.IndexFunc(s.queue, func(m message) bool { return m.p.Message == msg })
	if i < 0 {
		s.mu.Unlock()
		return &chatproto.Error{Code: chatproto.CodeNotFound, Message: "no such queued message"}
	}
	m := s.queue[i]
	s.queue = slices.Delete(s.queue, i, i+1)
	s.mu.Unlock()
	s.emit(queuedEvent(m.p, chatproto.QueuedCancelled, false))
	return nil
}

// SetConfig sets the model, the effort or the permission mode of the
// turns to come: Codex takes them with each turn.
func (s *session) SetConfig(ctx context.Context, id, value string) error {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return errEnded
	}
	bad := func(msg string) error {
		s.mu.Unlock()
		return &chatproto.Error{Code: chatproto.CodeBadRequest, Message: msg}
	}
	switch id {
	case optModel:
		if s.models.find(value) == nil && value != s.st.model {
			return bad("no such model: " + cutText(value, 128))
		}
		s.st.model = value
		s.st.effort = s.models.effortFor(value, s.st.effort, "")
	case optEffort:
		if !hasEffort(s.models.efforts(s.st.model), value) {
			return bad("no such effort for the model: " + cutText(value, 64))
		}
		s.st.effort = value
	case optMode:
		if !slices.Contains(chatproto.Modes, value) {
			return bad("no such mode: " + cutText(value, 64))
		}
		s.st.mode = value
	default:
		return bad("no such option: " + cutText(id, 64))
	}
	update := s.chatUpdate()
	s.mu.Unlock()
	s.sink.Update(update)
	return nil
}

// chatUpdate is what the chat states of the session now; s.mu is held.
func (s *session) chatUpdate() func(*chatproto.Chat) {
	thread, version := s.thread, s.version
	config := s.models.configOptions(s.st)
	caps := s.models.capabilities(s.st)
	return func(c *chatproto.Chat) {
		c.SessionID = thread
		c.AgentVersion = version
		c.Config = config
		c.Commands = slices.Clone(commands)
		c.Capabilities = caps
	}
}

// Compact compacts the thread's context: Codex does it in a turn of its
// own.
func (s *session) Compact(ctx context.Context) error {
	if !s.acquire(ctx) {
		return ctx.Err()
	}
	defer s.release()
	s.mu.Lock()
	switch {
	case s.ended || s.closing:
		s.mu.Unlock()
		return errEnded
	case s.active || s.ask != nil:
		s.mu.Unlock()
		return &chatproto.Error{Code: chatproto.CodeBusy, Message: "a turn runs"}
	}
	s.active, s.turn, s.compact = true, "", true
	s.prompt, s.skipUser = "", false
	c, thread := s.c, s.thread
	s.mu.Unlock()
	err := c.call(ctx, mThreadCompactStart, map[string]any{"threadId": thread}, nil)
	if err != nil {
		s.mu.Lock()
		if s.turn == "" {
			s.active, s.compact = false, false
		}
		s.mu.Unlock()
	}
	return callError(err)
}

// Close ends the app-server gracefully: its input closed, SIGTERM and
// SIGKILL only after their waits.
func (s *session) Close(ctx context.Context) error {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return nil
	}
	s.closing = true
	c := s.c
	ask := s.ask
	s.mu.Unlock()
	if ask != nil {
		ask.cancel()
	}
	go c.proc.end()
	select {
	case <-s.done:
	case <-ctx.Done():
	}
	return nil
}

// ---- what the app-server sends ----

// current tells whether c is the session's app-server; s.mu is held.
func (s *session) current(c *conn) bool { return c == s.c && !s.ended }

// parentOf is the tool call of the subagent a thread is, "" for the
// session's own thread; a subagent's thread the session did not see start
// is its own parent.
func (s *session) parentOf(thread string) (parent string, main bool) {
	if thread == "" || thread == s.thread {
		return "", true
	}
	if ch, ok := s.children[thread]; ok {
		return ch.call, false
	}
	return thread, false
}

func (s *session) notify(c *conn, method string, params json.RawMessage, at time.Time) {
	var evs []chatproto.Event
	var after func()
	s.mu.Lock()
	if !s.current(c) {
		s.mu.Unlock()
		return
	}
	switch method {
	case "turn/started":
		var n turnNotification
		if json.Unmarshal(params, &n) == nil {
			if _, main := s.parentOf(n.ThreadID); main && n.Turn.ID != "" {
				s.active, s.turn = true, n.Turn.ID
				evs = append(evs, chatproto.Event{T: chatproto.EventTurn, At: at, State: chatproto.TurnStart, Item: n.Turn.ID})
			}
		}
	case "turn/completed":
		var n turnNotification
		if json.Unmarshal(params, &n) == nil {
			if _, main := s.parentOf(n.ThreadID); main {
				evs, after = s.turnCompleted(&n.Turn, at)
			}
		}
	case "item/started", "item/completed":
		evs = s.itemEvent(c, params, method == "item/completed", at)
	case "item/agentMessage/delta", "item/plan/delta", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/commandExecution/outputDelta":
		evs = s.delta(method, params, at)
	case "thread/tokenUsage/updated":
		var n tokenUsageNotification
		if json.Unmarshal(params, &n) == nil {
			if _, main := s.parentOf(n.ThreadID); main {
				s.usage.Used = n.TokenUsage.Last.TotalTokens
				if w := n.TokenUsage.ModelContextWindow; w != nil && *w > 0 {
					s.usage.Size = *w
				}
				s.usage.Percentage = 0
				if s.usage.Size > 0 {
					s.usage.Percentage = float64(s.usage.Used) * 100 / float64(s.usage.Size)
				}
				s.dirty = true
				after = s.flushUsage(false)
			}
		}
	case "account/rateLimits/updated":
		var n struct {
			RateLimits rateLimitSnapshot `json:"rateLimits"`
		}
		if json.Unmarshal(params, &n) == nil {
			s.rateLimits(&n.RateLimits)
			after = s.flushUsage(false)
		}
	case "thread/name/updated":
		var n struct {
			ThreadID   string  `json:"threadId"`
			ThreadName *string `json:"threadName"`
		}
		if json.Unmarshal(params, &n) == nil && n.ThreadID == s.thread && n.ThreadName != nil {
			name := cutText(*n.ThreadName, 512)
			evs = append(evs, updateEvent("", "", false, obj{"sessionUpdate": "session_info_update", "title": name}, at))
			after = func() { s.sink.Update(func(ch *chatproto.Chat) { ch.Title = name }) }
		}
	case "error":
		var n errorNotification
		if json.Unmarshal(params, &n) == nil {
			parent, main := s.parentOf(n.ThreadID)
			if n.WillRetry {
				evs = append(evs, noticeEvent(agentproto.NoticeError, parent, obj{"message": n.Error.Message, "willRetry": true}, at))
			} else if main {
				e := n.Error
				s.lastErr = &e
			} else {
				evs = append(evs, noticeEvent(agentproto.NoticeError, parent, obj{"message": n.Error.Message}, at))
			}
		}
	case "serverRequest/resolved":
		var n struct {
			RequestID json.RawMessage `json:"requestId"`
		}
		if json.Unmarshal(params, &n) == nil {
			if p, ok := s.pending[pendingKey(c, requestKey(n.RequestID))]; ok {
				p.resolved.Store(true)
				p.cancel()
			}
		}
	case "thread/started", "thread/status/changed", "thread/settings/updated", "thread/readState/changed",
		"thread/goal/cleared", "thread/goal/updated", "turn/diff/updated", "turn/moderationMetadata", "turn/plan/updated",
		"item/reasoning/textDelta", "item/fileChange/outputDelta", "item/fileChange/patchUpdated",
		"hook/started", "hook/completed", "mcpServer/startupStatus/updated", "configWarning", "warning",
		"deprecationNotice", "remoteControl/status/changed", "account/updated", "skills/changed", "thread/compacted":
		// Nothing the conversation shows: the items tell it.
	default:
		c.passedOver(method)
	}
	s.mu.Unlock()
	s.emit(evs...)
	if after != nil {
		after()
	}
}

// itemEvent maps an item/started or item/completed; s.mu is held.
func (s *session) itemEvent(c *conn, params json.RawMessage, completed bool, at time.Time) []chatproto.Event {
	var n itemNotification
	if json.Unmarshal(params, &n) != nil {
		c.passedOver("item (malformed)")
		return nil
	}
	var it item
	if err := json.Unmarshal(n.Item, &it); err != nil || it.ID == "" {
		var t struct {
			Type string `json:"type"`
		}
		json.Unmarshal(n.Item, &t)
		c.passedOver("item " + cutText(t.Type, 64))
		return nil
	}
	parent, main := s.parentOf(n.ThreadID)
	switch it.Type {
	case itemUserMessage:
		if !completed {
			return nil
		}
		return s.userMessage(&it, parent, main, at)
	case itemSubAgent:
		return s.subAgent(&it, parent, completed, at)
	case itemCollabTool:
		if it.Tool == "spawnAgent" {
			for _, t := range it.ReceiverThreadIDs {
				if _, ok := s.children[t]; !ok {
					s.children[t] = child{call: it.ID, parent: parent, state: collabCall(&it)}
				}
			}
		}
	case itemPlan:
		if completed && main {
			s.plan.id, s.plan.text = it.ID, it.Text
		}
	}
	evs, ok := s.m.itemEvents(&it, completed, parent, at)
	if !ok {
		c.passedOver("item " + cutText(it.Type, 64))
		return nil
	}
	if isTool(it.Type) && len(evs) == 1 {
		if completed {
			delete(s.items, it.ID)
		} else {
			s.items[it.ID] = &openItem{it: &it, thread: n.ThreadID, parent: parent, last: evs[0].Update, shown: true}
		}
	}
	return evs
}

func isTool(t string) bool {
	switch t {
	case itemCommand, itemFileChange, itemMCPToolCall, itemDynamicTool, itemCollabTool, itemWebSearch, itemImageView:
		return true
	}
	return false
}

// userMessage is a user message of the thread: the prompt of a turn the
// host started (the host told it), a message steered into the turn
// (taken), or one the session did not send (told as the user's).
func (s *session) userMessage(it *item, parent string, main bool, at time.Time) []chatproto.Event {
	at = itemTime(it, at)
	if !main {
		return []chatproto.Event{{T: chatproto.EventUser, At: at, Parent: parent, Item: it.ID, Content: userContent(it.Content)}}
	}
	cid := ""
	if it.ClientID != nil {
		cid = *it.ClientID
	}
	// A steered message taken is the user's message from then on (the
	// UIs make it one of its queued event).
	take := func(i int) []chatproto.Event {
		m := s.steers[i]
		s.steers = slices.Delete(s.steers, i, i+1)
		ev := queuedEvent(m.p, chatproto.QueuedTaken, false)
		ev.At = at
		return []chatproto.Event{ev}
	}
	switch {
	case cid != "" && cid == s.prompt, cid == "" && s.skipUser:
		s.prompt, s.skipUser = "", false
		return nil
	case cid != "":
		if i := slices.IndexFunc(s.steers, func(m message) bool { return m.p.Message == cid }); i >= 0 {
			return take(i)
		}
	}
	if s.skipUser {
		// Codex gave the prompt another client id.
		s.prompt, s.skipUser = "", false
		return nil
	}
	if len(s.steers) > 0 {
		return take(0)
	}
	return []chatproto.Event{{T: chatproto.EventUser, At: at, Item: it.ID, Content: userContent(it.Content)}}
}

// subAgent is a subagent's activity: its start is a tool call its thread's
// events belong to, which its end completes.
func (s *session) subAgent(it *item, parent string, completed bool, at time.Time) []chatproto.Event {
	at = itemTime(it, at)
	switch it.Kind {
	case subAgentStarted:
		if _, ok := s.children[it.AgentThreadID]; ok && completed {
			return nil
		}
		u := subAgentCall(it, toolInProgress)
		if it.AgentThreadID != "" {
			s.children[it.AgentThreadID] = child{call: it.ID, parent: parent, state: u}
		}
		return []chatproto.Event{updateEvent(it.ID, parent, false, u, at)}
	case subAgentCompleted, subAgentStopped:
		ch, ok := s.children[it.AgentThreadID]
		if !completed || !ok {
			return nil
		}
		u := cancelledCall(ch.state)
		u["status"] = toolCompleted
		if it.Kind == subAgentStopped {
			u["status"] = toolCancelled
		}
		return []chatproto.Event{updateEvent(ch.call, ch.parent, false, u, at)}
	}
	return nil
}

// delta maps a streamed increment to a live event; s.mu is held.
func (s *session) delta(method string, params json.RawMessage, at time.Time) []chatproto.Event {
	var d deltaNotification
	if json.Unmarshal(params, &d) != nil || d.ItemID == "" {
		return nil
	}
	parent, _ := s.parentOf(d.ThreadID)
	var u obj
	switch method {
	case "item/agentMessage/delta":
		u = chunk(agentMessageChunk, d.Delta, d.ItemID)
	case "item/plan/delta":
		u = chunk(agentMessageChunk, d.Delta, d.ItemID)
		setMeta(u, "plan", true)
	case "item/reasoning/summaryTextDelta":
		u = chunk(agentThoughtChunk, d.Delta, d.ItemID)
	case "item/reasoning/summaryPartAdded":
		if d.SummaryIndex == 0 {
			return nil
		}
		u = chunk(agentThoughtChunk, "\n\n", d.ItemID)
	case "item/commandExecution/outputDelta":
		if oi, ok := s.items[d.ItemID]; !ok || !oi.shown {
			return nil
		}
		u = obj{"sessionUpdate": "tool_call_update", "toolCallId": d.ItemID,
			"content": []any{obj{"type": "content", "content": textBlock(d.Delta)}}}
	}
	if d.Delta == "" && method != "item/reasoning/summaryPartAdded" {
		return nil
	}
	return []chatproto.Event{updateEvent(d.ItemID, parent, true, u, at)}
}

// cancelledEvent is the stored state of a tool call that will not
// complete; s.mu is held.
func (s *session) cancelledEvent(id string, oi *openItem) chatproto.Event {
	oi.shown = false
	var last obj
	json.Unmarshal(oi.last, &last)
	if last == nil {
		last = obj{"toolCallId": id}
	}
	return updateEvent(id, oi.parent, false, cancelledCall(last), time.Now())
}

// turnCompleted ends the session's turn; s.mu is held. A turn that made a
// plan in plan mode ends once the plan's approval is answered.
func (s *session) turnCompleted(t *turnInfo, at time.Time) (evs []chatproto.Event, after func()) {
	for _, m := range s.steers {
		// Steered into the turn, never shown as an item.
		evs = append(evs, queuedEvent(m.p, chatproto.QueuedTaken, false))
	}
	s.steers = nil
	if t.Status != turnCompleted {
		for _, id := range s.itemIDs() {
			if oi := s.items[id]; oi.shown {
				evs = append(evs, s.cancelledEvent(id, oi))
			}
		}
	}
	plan := s.plan
	s.plan.id, s.plan.text = "", ""
	queue := s.queue
	s.queue = nil
	lastErr := s.lastErr
	s.active, s.turn, s.compact, s.prompt, s.skipUser, s.lastErr = false, "", false, "", false, nil
	flush := s.flushUsage(true)
	evs = append(evs, turnEnd(t, lastErr, at))
	if t.Status == turnCompleted && plan.text != "" && s.st.mode == chatproto.ModePlan && len(queue) == 0 && !s.closing {
		// The turn ends first: its end cancels what was asked in it.
		ctx, cancel := context.WithCancel(s.ctx)
		a := &planAsk{cancel: cancel, done: make(chan struct{})}
		s.ask = a
		return evs, func() {
			flush()
			go s.askPlan(ctx, a, plan.id, plan.text)
		}
	}
	return evs, func() {
		flush()
		if len(queue) > 0 {
			if t.Status == turnInterrupted {
				var cancelled []chatproto.Event
				for _, m := range queue {
					cancelled = append(cancelled, queuedEvent(m.p, chatproto.QueuedCancelled, false))
				}
				s.emit(cancelled...)
				return
			}
			go s.sendQueued(queue)
		}
	}
}

// turnEnd is the event of a turn's end: interrupted is cancelled, failed
// an error.
func turnEnd(t *turnInfo, lastErr *turnError, at time.Time) chatproto.Event {
	switch t.Status {
	case turnInterrupted:
		return chatproto.Event{T: chatproto.EventTurn, At: at, State: chatproto.TurnEnd, StopReason: "cancelled", Item: t.ID}
	case turnFailed:
		e := t.Error
		if e == nil {
			e = lastErr
		}
		return chatproto.Event{T: chatproto.EventTurn, At: at, State: chatproto.TurnError, Error: turnErrorOf(e), Item: t.ID}
	}
	return chatproto.Event{T: chatproto.EventTurn, At: at, State: chatproto.TurnEnd, StopReason: "end_turn", Item: t.ID}
}

// askPlan asks to approve the plan of the turn that just ended. Approved,
// the plan is carried out in the mode chosen, in the next turn; refused,
// the chat goes on planning.
func (s *session) askPlan(ctx context.Context, a *planAsk, planID, text string) {
	tc := obj{"toolCallId": planID, "title": "Plan", "kind": "switch_mode", "status": toolPending,
		"content": []any{obj{"type": "content", "content": textBlock(text)}}, "rawInput": obj{"plan": text}}
	ans, err := s.sink.Permission(ctx, chatadapter.PermissionRequest{Kind: chatproto.PermissionPlan, ToolCall: raw(tc), Options: planOptions})
	a.cancel()
	s.mu.Lock()
	if s.ask == a {
		s.ask = nil
	}
	superseded := a.superseded
	s.mu.Unlock()
	close(a.done)
	if err != nil || ans.Cancelled || superseded {
		return
	}
	mode, ok := strings.CutPrefix(ans.Option, chatadapter.OptionPlanPrefix)
	if !ok || mode == chatproto.ModePlan || !slices.Contains(chatproto.Modes, mode) {
		return
	}
	if !s.acquire(s.ctx) {
		return
	}
	defer s.release()
	s.mu.Lock()
	if s.ended || s.closing || s.active || a.superseded {
		s.mu.Unlock()
		return
	}
	s.st.mode = mode
	update := s.chatUpdate()
	s.mu.Unlock()
	s.sink.Update(update)
	p := chatadapter.PromptParams{Content: []json.RawMessage{raw(textBlock(implementPlan))}}
	s.emit(userEvent(p))
	if err := s.startTurn(s.ctx, []userInput{{Type: "text", Text: implementPlan, TextElements: []string{}}}, ""); err != nil {
		s.logf("carrying out the plan: %v", err)
		s.emit(noticeEvent(agentproto.NoticeError, "", obj{"message": err.Error()}, time.Now()))
	}
}

// rateLimits takes a rolling update of the account's rate limits: a
// window it does not state keeps its last value; s.mu is held.
func (s *session) rateLimits(r *rateLimitSnapshot) {
	id := "codex"
	if r.LimitID != nil && *r.LimitID != "" {
		id = cutText(*r.LimitID, 64)
	}
	if _, ok := s.limits[id]; !ok && len(s.limits) >= 16 {
		return
	}
	old := s.limits[id]
	label := ""
	if r.LimitName != nil {
		label = cutText(*r.LimitName, 128)
	}
	var out []chatproto.Limit
	for i, w := range []*rateLimitWindow{r.Primary, r.Secondary} {
		lid := id + []string{".primary", ".secondary"}[i]
		if w == nil {
			if j := slices.IndexFunc(old, func(l chatproto.Limit) bool { return l.ID == lid }); j >= 0 {
				out = append(out, old[j])
			}
			continue
		}
		l := chatproto.Limit{ID: lid, Label: label, UsedPercent: w.UsedPercent}
		if w.ResetsAt != nil {
			l.ResetsAt = *w.ResetsAt
		}
		if w.WindowDurationMins != nil {
			l.WindowMinutes = *w.WindowDurationMins
		}
		out = append(out, l)
	}
	s.limits[id] = out
	s.dirty = true
}

// flushUsage is what sends the usage to the host, when it changed and the
// last went usageEvery ago or force; nil for nothing. s.mu is held.
func (s *session) flushUsage(force bool) func() {
	if !s.dirty || (!force && time.Since(s.flushed) < usageEvery) {
		if force {
			return func() {}
		}
		return nil
	}
	s.dirty = false
	s.flushed = time.Now()
	u := s.usage
	ids := make([]string, 0, len(s.limits))
	for id := range s.limits {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	for _, id := range ids {
		u.Limits = append(u.Limits, s.limits[id]...)
	}
	return func() { s.sink.Update(func(c *chatproto.Chat) { c.Usage = &u }) }
}

// ---- requests of the app-server ----

func pendingKey(c *conn, id string) string { return fmt.Sprintf("%p/%s", c, id) }

// request answers a request of the app-server: approvals and questions are
// the user's, the others are refused.
func (s *session) request(c *conn, r *serverRequest) {
	s.mu.Lock()
	ok := s.current(c)
	s.mu.Unlock()
	if !ok {
		refuse(r)
		return
	}
	switch r.method {
	case mCommandApproval, mFileChangeApproval, mRequestUserInput:
		// Registered before the next line is read: serverRequest/resolved
		// may follow at once.
		s.mu.Lock()
		p := s.addPending(c, r)
		s.mu.Unlock()
		switch r.method {
		case mCommandApproval:
			go s.askApproval(c, r, p, chatproto.PermissionCommand)
		case mFileChangeApproval:
			go s.askApproval(c, r, p, chatproto.PermissionFile)
		default:
			go s.askQuestions(c, r, p)
		}
	default:
		refuse(r)
	}
}

// refuse answers a request of the app-server without the user: approvals
// are cancelled, questions unanswered, MCP elicitations declined, extra
// permissions not granted, dynamic tools (the session registers none)
// failed; tokens and attestations (the session has none to give) and what
// the adapter does not know get "method not found".
func refuse(r *serverRequest) {
	switch r.method {
	case mCommandApproval, mFileChangeApproval:
		r.reply(obj{"decision": "cancel"})
	case mRequestUserInput:
		r.reply(obj{"answers": obj{}})
	case mMCPElicitation:
		r.reply(obj{"action": "decline", "content": nil, "_meta": nil})
	case mPermissionsApproval:
		r.reply(obj{"permissions": obj{}, "scope": "turn"})
	case mDynamicToolCall:
		r.reply(obj{"contentItems": []any{obj{"type": "inputText", "text": "This client has no such tool."}}, "success": false})
	default:
		r.fail(codeMethodNotFound, "method not found: "+cutText(r.method, 128))
	}
}

// addPending registers a request that waits for the user; s.mu is held.
func (s *session) addPending(c *conn, r *serverRequest) *pending {
	ctx, cancel := context.WithCancel(s.ctx)
	p := &pending{ctx: ctx, cancel: cancel}
	s.pending[pendingKey(c, r.key())] = p
	return p
}

func (s *session) dropPending(c *conn, r *serverRequest, p *pending) {
	s.mu.Lock()
	if s.pending[pendingKey(c, r.key())] == p {
		delete(s.pending, pendingKey(c, r.key()))
	}
	s.mu.Unlock()
	p.cancel()
}

// askApproval asks the user to allow a command or a change of files.
func (s *session) askApproval(c *conn, r *serverRequest, p *pending, kind string) {
	var cp commandApprovalParams
	var fp fileApprovalParams
	if kind == chatproto.PermissionCommand {
		json.Unmarshal(r.params, &cp)
	} else {
		json.Unmarshal(r.params, &fp)
		cp.ThreadID, cp.ItemID, cp.Reason = fp.ThreadID, fp.ItemID, fp.Reason
	}
	s.mu.Lock()
	parent, _ := s.parentOf(cp.ThreadID)
	oi := s.items[cp.ItemID]
	in := obj{}
	if cp.Reason != nil && *cp.Reason != "" {
		in["reason"] = *cp.Reason
	}
	var tc obj
	if kind == chatproto.PermissionCommand {
		command := ""
		if cp.Command != nil {
			command = *cp.Command
		}
		script := shellScript(command, cp.CommandActions)
		if script == "" && oi != nil {
			script = shellScript(oi.it.Command, oi.it.CommandActions)
		}
		tc = toolCall(cp.ItemID, script, "execute", toolPending)
		in["command"] = script
		if cp.Cwd != nil && *cp.Cwd != "" {
			in["cwd"] = *cp.Cwd
		}
		if len(cp.Network) > 0 && string(cp.Network) != "null" {
			in["network"] = cp.Network
		}
	} else {
		tc = toolCall(cp.ItemID, "", "edit", toolPending)
		if oi != nil {
			content, locs, titles := fileDiffs(oi.it.Changes, s.m)
			tc["title"] = cutText(strings.Join(titles, ", "), maxTitle)
			if len(content) > 0 {
				tc["content"], tc["locations"] = content, locs
			}
		}
		if fp.GrantRoot != nil && *fp.GrantRoot != "" {
			in["grantRoot"] = *fp.GrantRoot
		}
	}
	tc["rawInput"] = in
	s.mu.Unlock()
	ans, err := s.sink.Permission(p.ctx, chatadapter.PermissionRequest{Kind: kind, ToolCall: raw(tc), Options: permissionOptions, Parent: parent})
	s.dropPending(c, r, p)
	if p.resolved.Load() {
		return
	}
	decision := "cancel"
	if err == nil && !ans.Cancelled {
		switch ans.Option {
		case chatadapter.OptionAllowOnce:
			decision = "accept"
		case chatadapter.OptionAllowSession:
			// Never an execpolicy or network amendment: those are saved.
			decision = "acceptForSession"
		default:
			decision = "decline"
		}
	}
	r.reply(obj{"decision": decision})
}

// askQuestions asks the user the questions of request_user_input (plan
// mode's); skipped, they are answered with no answers. A question without
// options takes the user's own words, whatever its isOther says: it could
// not be answered otherwise.
func (s *session) askQuestions(c *conn, r *serverRequest, p *pending) {
	var up userInputParams
	json.Unmarshal(r.params, &up)
	var qs []chatproto.Question
	ids := map[string]bool{}
	for _, q := range up.Questions {
		cq := chatproto.Question{ID: q.ID, Header: q.Header, Question: q.Question, AllowOther: q.IsOther || len(q.Options) == 0, Secret: q.IsSecret}
		for _, o := range q.Options {
			cq.Options = append(cq.Options, chatproto.QuestionOption{Label: o.Label, Description: o.Description})
		}
		qs = append(qs, cq)
		ids[q.ID] = true
	}
	s.mu.Lock()
	parent, _ := s.parentOf(up.ThreadID)
	s.mu.Unlock()
	ans, err := s.sink.Question(p.ctx, chatadapter.QuestionRequest{Questions: qs, Parent: parent})
	s.dropPending(c, r, p)
	if p.resolved.Load() {
		return
	}
	answers := obj{}
	if err == nil && !ans.Cancelled {
		for id, a := range ans.Answers {
			if ids[id] {
				answers[id] = obj{"answers": a}
			}
		}
	}
	r.reply(obj{"answers": answers})
}
