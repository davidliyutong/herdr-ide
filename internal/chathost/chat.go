//go:build unix

package chathost

import (
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

const (
	// titleRunes is the longest title a chat takes from a prompt, and
	// agentTitleRunes the longest it takes from its agent or a client.
	titleRunes      = 80
	agentTitleRunes = 200
	// stateBytes is the most bytes of the JSON of each of what an adapter
	// states of a chat (its configuration options, slash commands, usage,
	// capabilities): with it, the list of all chats fits a line, and the
	// journal's rows stay small beside the events its bounds count.
	stateBytes = 64 << 10
	// maxQueued is the most queued messages a chat follows (the adapters
	// queue far fewer).
	maxQueued = 256
	// maxPending is the number of permissions and questions that may wait
	// in a chat; an agent that asks more is answered that they were
	// cancelled.
	maxPending = 64
	// maxAnswerBytes is the most bytes of a question's answers.
	maxAnswerBytes = 64 << 10
	// catchUpEvery is how often attaching brings what a handed off
	// session did in a terminal into the log (it may run the agent to ask).
	catchUpEvery = 10 * time.Second
	// maxClientIDs is how many of a chat's last prompts a prompt with the
	// page's id of one of them is known by: it was taken already, and is
	// not sent again (a page that did not get the ack sends it again).
	maxClientIDs = 256
)

// chat is a conversation: its journal's row, its agent session while one
// runs, the permissions and questions that wait, and the connections
// attached to it.
type chat struct {
	h *host

	mu sync.Mutex
	r  row
	// rest is the state of the chat while no agent runs or starts:
	// sleeping, closed or failed.
	rest string
	// first is the lowest sequence number still stored, r.Seq+1 when none
	// is.
	first   uint64
	subs    map[*subscriber]struct{}
	deleted bool
	stopped bool // the host stopped: nothing more is stored
	// brokenLog: the journal did not take an event of the chat, which
	// fails (journalFailed); cleared once it takes one again.
	brokenLog bool

	sess chatadapter.Session
	// gen numbers the chat's agents: a session or a start of an earlier
	// one is no longer heard.
	gen      uint64
	starting bool
	start    *start
	held     bool // a prompt waits for the start
	turn     bool // a turn runs
	pending  map[string]*pending
	// queued are the messages the adapter queued (EventQueued) and did not
	// tell taken or cancelled yet, by id; next: a turn ended while some
	// waited, and the next turn, which takes them, is to start: the chat
	// works meanwhile (until nextTimer gives up on it).
	queued    map[string]bool
	next      bool
	nextTaken bool // a message the next turn takes was taken
	nextTimer *time.Timer

	idleSince time.Time // since when the chat is idle
	idleTimer *time.Timer

	infoDirty bool // the adapter changed what the chat states
	infoTimer *time.Timer
	lastState chatproto.ChatState // what the watchers were told last
	dropped   map[string]bool     // the kinds of the adapter's events left out, logged once

	catchMu  sync.Mutex // one History of the session at a time
	caughtUp time.Time  // when an attach last brought a handed off session's turns in

	// clients are the page's ids of the chat's last prompts its log has
	// (EventUser, EventQueued), clientOrder them the oldest first; sending
	// are the prompts being taken, by the page's id.
	clients     map[string]bool
	clientOrder []string
	sending     map[string]*sending

	// mode is the value of the chat's mode option its agent stated last,
	// modeGen the agent's (gen) that stated it; denying: an agent of gen
	// denying is being taken out of a full access it took by itself.
	mode    string
	modeGen uint64
	denying uint64
	// untrustedGen is the agent (gen) whose start told that it runs
	// without the project's own settings.
	untrustedGen uint64
}

// sending is a prompt being taken: a prompt with the same page's id waits
// for its answer instead of being sent again.
type sending struct {
	done chan struct{}
	err  *chatproto.Error
}

// start is a start of a chat's agent.
type start struct {
	gen    uint64
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{} // closed when it ended
	err    *chatproto.Error
}

// pending is a permission or a question that waits for the user.
type pending struct {
	n         uint64
	id        string
	question  bool
	options   []string             // a permission's optionIds
	questions []chatproto.Question // a question's
	done      chan answer
}

// answer is how a permission or a question was answered: the user's
// answer, cancelled, or an error when the chat's agent ended.
type answer struct {
	perm chatadapter.PermissionAnswer
	q    chatadapter.QuestionAnswer
	err  error
}

// pendingCount orders what waits, the oldest first.
var pendingCount atomic.Uint64

func newChat(h *host, r row) *chat {
	return &chat{h: h, r: r, subs: map[*subscriber]struct{}{}, pending: map[string]*pending{}, dropped: map[string]bool{},
		queued: map[string]bool{}, clients: map[string]bool{}, sending: map[string]*sending{}}
}

// tookClient notes the page's id of a prompt the log has now. The caller
// holds c.mu.
func (c *chat) tookClient(id string) {
	if id == "" || c.clients[id] {
		return
	}
	c.clients[id] = true
	c.clientOrder = append(c.clientOrder, id)
	if len(c.clientOrder) > maxClientIDs {
		delete(c.clients, c.clientOrder[0])
		c.clientOrder = slices.Delete(c.clientOrder, 0, 1)
	}
}

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// snapshot is the chat as it is now. The caller holds c.mu.
func (c *chat) snapshot() *chatproto.Chat {
	c.r.Status = chatproto.StatusOf(c.r.State, c.r.TurnEnd, c.r.Seen)
	s := c.r.Chat
	s.Config = slices.Clone(s.Config)
	s.Commands = slices.Clone(s.Commands)
	if s.Usage != nil {
		u := *s.Usage
		u.Limits = slices.Clone(u.Limits)
		s.Usage = &u
	}
	return &s
}

// view is snapshot for a caller that does not hold c.mu.
func (c *chat) view() chatproto.Chat {
	c.mu.Lock()
	defer c.mu.Unlock()
	return *c.snapshot()
}

// row is the journal's row of the chat. The caller holds c.mu.
func (c *chat) row() row {
	r := c.r
	r.Chat = *c.snapshot()
	return r
}

// save stores the chat's row. The caller holds c.mu.
func (c *chat) save() {
	if c.deleted {
		return
	}
	if err := c.h.j.saveChat(c.row()); err != nil {
		c.h.logf("chat %s: save: %v", c.r.ID, err)
	}
}

// notify tells the watchers the chat's state when it changed. The caller
// holds c.mu.
func (c *chat) notify() {
	if c.deleted {
		return
	}
	c.r.Status = chatproto.StatusOf(c.r.State, c.r.TurnEnd, c.r.Seen)
	st := c.r.StateOf()
	last := c.lastState
	last.Seq, last.Updated = st.Seq, st.Updated
	if last == st {
		return
	}
	c.lastState = st
	c.h.broadcast(st)
}

// emit stores an event, numbered, and hands it to the attached
// connections; one that fell too far behind is disconnected. It reports
// whether the event was stored as it is (its strings cut, maybe): false
// when it was left out, replaced by a notice that it was too large (fit),
// or not stored at all. An event the journal does not take is told to
// nobody, and fails the chat (journalFailed): its log has no hole. The
// agent's standard error of an event's Error (and of an EventInfo's
// chat's) goes to the connections attached now, never into the journal.
// The caller holds c.mu.
func (c *chat) emit(ev chatproto.Event) bool {
	if c.deleted {
		return false
	}
	t := now()
	ev.Seq, ev.Live = c.r.Seq+1, false
	if ev.At.IsZero() {
		ev.At = t
	}
	ev.Error = capStderr(ev.Error)
	if ev.T == chatproto.EventInfo {
		ev.Chat = c.snapshot()
		ev.Chat.Seq, ev.Chat.Updated = ev.Seq, t
		ev.Chat.Error = capStderr(ev.Chat.Error)
	}
	st, b := fit(ev.Redacted())
	if b == nil {
		c.h.logf("chat %s: an event %s that is no JSON was left out", c.r.ID, ev.T)
		return false
	}
	r := c.r
	r.Seq, r.Updated = ev.Seq, t
	if st.Item != "" && st.Parent == "" {
		r.HistoryAfter = st.Item
	}
	if st.T == chatproto.EventTurn && (st.State == chatproto.TurnEnd || st.State == chatproto.TurnError) {
		r.TurnEnd = ev.Seq
	}
	r.Bytes += int64(len(b))
	if err := c.h.j.appendEvent(r, stored{seq: st.Seq, t: st.T, item: st.Item, at: st.At, line: b}); err != nil {
		c.h.logf("chat %s: store event %d: %v", c.r.ID, ev.Seq, err)
		c.journalFailed(err)
		return false
	}
	c.brokenLog = false
	c.r.Seq, c.r.Updated, c.r.HistoryAfter, c.r.TurnEnd, c.r.Bytes = r.Seq, r.Updated, r.HistoryAfter, r.TurnEnd, r.Bytes
	if st.T == chatproto.EventUser || st.T == chatproto.EventQueued {
		c.tookClient(st.ClientID)
	}
	out := b
	if st.T == ev.T && hasStderr(ev) {
		if l := line(ev); l != nil && len(l) <= chatproto.MaxLine {
			out = l
		}
	}
	c.fanOut(append(out, '\n'))
	if max := c.h.settings.Load().MaxChatBytes; c.r.Bytes > max {
		c.trim(max - max/8)
	}
	c.h.wrote(len(b))
	return st.T == ev.T
}

// journalFailed fails the chat whose event the journal did not take: its
// agent ends, and what comes is not stored in a log with a hole. A prompt
// starts the chat again, once the journal takes events. The caller holds
// c.mu.
func (c *chat) journalFailed(err error) {
	if c.brokenLog || c.stopped {
		return
	}
	c.brokenLog = true
	e := perr(chatproto.CodeFailed, "the chat's log could not be written: "+err.Error())
	// Not under the caller's lock, which may be in the middle of a change
	// of the chat; not one of h.wg's, as the caller may be a timer's.
	go func() {
		c.mu.Lock()
		if c.deleted || c.stopped {
			c.mu.Unlock()
			return
		}
		c.h.logf("chat %s: failed: %s", c.r.ID, e.Message)
		sess := c.stopAgent(chatproto.StateFailed, e, e)
		c.notify()
		c.mu.Unlock()
		c.h.endSession(sess, false)
		c.h.pokeQuiet()
	}()
}

// capStderr is e with at most chatproto.MaxStderr bytes of the agent's
// standard error, its end; e itself when it has no more.
func capStderr(e *chatproto.Error) *chatproto.Error {
	if e == nil || len(e.Stderr) <= chatproto.MaxStderr {
		return e
	}
	c := *e
	s := e.Stderr[len(e.Stderr)-chatproto.MaxStderr:]
	for len(s) > 0 && !utf8.RuneStart(s[0]) {
		s = s[1:]
	}
	c.Stderr = s
	return &c
}

// hasStderr tells whether ev carries an agent's standard error.
func hasStderr(ev chatproto.Event) bool {
	return (ev.Error != nil && ev.Error.Stderr != "") || (ev.Chat != nil && ev.Chat.Error != nil && ev.Chat.Error.Stderr != "")
}

// live hands a streaming increment to the attached connections. The caller
// holds c.mu.
func (c *chat) live(ev chatproto.Event) {
	if c.deleted || len(c.subs) == 0 {
		return
	}
	ev.Seq, ev.Live = 0, true
	b, err := chatproto.Line(ev)
	if err != nil || len(b) > chatproto.MaxLine+1 {
		return
	}
	c.fanOut(b)
}

func (c *chat) fanOut(b []byte) {
	for s := range c.subs {
		if !s.push(b) {
			c.h.logf("chat %s: a connection fell behind and was closed", c.r.ID)
			delete(c.subs, s)
		}
	}
}

// trim drops the chat's oldest events until they take at most keep bytes.
// The caller holds c.mu.
func (c *chat) trim(keep int64) {
	deleted, first, err := c.h.j.trim(c.r.ID, c.r.Bytes, keep)
	c.r.Bytes = max(c.r.Bytes-deleted, 0)
	if err != nil {
		c.h.logf("chat %s: trim: %v", c.r.ID, err)
	}
	c.first = first
	if first == 0 {
		c.first = c.r.Seq + 1
	}
}

// setState changes the chat's state and says so. The caller holds c.mu.
func (c *chat) setState(state string) {
	if c.r.State == state || c.deleted {
		return
	}
	c.r.State = state
	if state != chatproto.StateFailed {
		c.r.Error = nil
	}
	ev := chatproto.Event{T: chatproto.EventState, State: state}
	if state == chatproto.StateFailed {
		ev.Error = c.r.Error
	}
	if state == chatproto.StateIdle {
		c.idleSince = time.Now()
	}
	c.emit(ev)
	c.armIdle()
	c.save()
	c.notify()
	c.h.pokeQuiet()
}

// settle gives the chat the state its agent, turn and what waits make.
// The caller holds c.mu.
func (c *chat) settle() {
	state := c.rest
	switch {
	case c.starting:
		state = chatproto.StateStarting
	case c.sess != nil && len(c.pending) > 0:
		state = chatproto.StateWaiting
	case c.sess != nil && (c.turn || c.next):
		state = chatproto.StateWorking
	case c.sess != nil:
		state = chatproto.StateIdle
	}
	if state == "" {
		state = chatproto.StateSleeping
	}
	c.setState(state)
}

// busy tells whether a turn runs, is to start with what was queued, or
// waits for the user. The caller holds c.mu.
func (c *chat) busy() bool { return c.turn || c.next || len(c.pending) > 0 }

// awaitNext has the chat work between the end of a turn and the start of
// the next one, which takes the messages queued meanwhile: no idle stop,
// no room made of it, no handoff. An adapter that does not start it
// within the host's call timeout is not waited for any longer. The caller
// holds c.mu.
func (c *chat) awaitNext() {
	c.endNext()
	if len(c.queued) == 0 || c.sess == nil {
		return
	}
	c.next = true
	gen := c.gen
	c.nextTimer = time.AfterFunc(c.h.o.callTimeout, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.gen != gen || !c.next || c.deleted {
			return
		}
		c.h.logf("chat %s: no turn took the %d queued messages", c.r.ID, len(c.queued))
		c.endNext()
		c.settle()
		c.notify()
	})
}

// endNext stops waiting for the next turn. The caller holds c.mu, and
// settles the chat's state after.
func (c *chat) endNext() {
	c.next, c.nextTaken = false, false
	if c.nextTimer != nil {
		c.nextTimer.Stop()
		c.nextTimer = nil
	}
}

// armIdle has an idle chat's agent ended once the chat was idle for the
// settings' IdleStopMinutes. The caller holds c.mu.
func (c *chat) armIdle() {
	if c.idleTimer != nil {
		c.idleTimer.Stop()
		c.idleTimer = nil
	}
	if c.deleted || c.sess == nil || c.r.State != chatproto.StateIdle {
		return
	}
	wait := time.Duration(c.h.settings.Load().IdleStopMinutes)*c.h.o.minute - time.Since(c.idleSince)
	gen, since := c.gen, c.idleSince
	c.idleTimer = time.AfterFunc(max(wait, 0), func() {
		c.mu.Lock()
		if c.gen != gen || c.sess == nil || c.r.State != chatproto.StateIdle || !c.idleSince.Equal(since) {
			c.mu.Unlock()
			return
		}
		c.h.logf("chat %s: its agent stopped, idle for %d minutes", c.r.ID, c.h.settings.Load().IdleStopMinutes)
		sess := c.stopAgent(chatproto.StateSleeping, nil, nil)
		c.mu.Unlock()
		c.h.endSession(sess, false)
	})
}

// emitInfo stores the chat as it is now (EventInfo) and its row. The
// caller holds c.mu.
func (c *chat) emitInfo() {
	c.infoDirty = false
	if c.infoTimer != nil {
		c.infoTimer.Stop()
		c.infoTimer = nil
	}
	c.emit(chatproto.Event{T: chatproto.EventInfo})
	c.save()
	c.notify()
}

// recover makes a chat whose agent ran when the last host ended sleep:
// the permissions and questions that waited are cancelled, its turn ended
// in an error. The caller holds c.mu.
func (c *chat) recover() {
	evs, err := c.h.j.eventsOf(c.r.ID, chatproto.EventPermission, chatproto.EventQuestion,
		chatproto.EventPermissionDone, chatproto.EventQuestionDone)
	if err != nil {
		c.h.logf("chat %s: recover: %v", c.r.ID, err)
	}
	open := map[string]string{}
	var order []string
	for _, ev := range evs {
		switch ev.T {
		case chatproto.EventPermission, chatproto.EventQuestion:
			if _, ok := open[ev.ID]; !ok {
				order = append(order, ev.ID)
			}
			open[ev.ID] = ev.T
		default:
			delete(open, ev.ID)
		}
	}
	for _, id := range order {
		switch open[id] {
		case chatproto.EventPermission:
			c.emit(chatproto.Event{T: chatproto.EventPermissionDone, ID: id, By: chatproto.ByEnded,
				Outcome: &chatproto.Outcome{Outcome: chatproto.OutcomeCancelled}})
		case chatproto.EventQuestion:
			c.emit(chatproto.Event{T: chatproto.EventQuestionDone, ID: id, By: chatproto.ByEnded})
		}
	}
	if c.r.State == chatproto.StateWorking || c.r.State == chatproto.StateWaiting {
		c.emit(chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnError,
			Error: perr(chatproto.CodeEnded, "the chat host ended")})
	}
	c.rest = chatproto.StateSleeping
	if c.r.SessionID == "" {
		c.rest = chatproto.StateFailed
		c.r.Error = perr(chatproto.CodeEnded, "the chat host ended before the session existed")
	}
	c.settle()
}

// beginStart marks the chat as starting an agent, and returns the start.
// The caller holds c.mu.
func (c *chat) beginStart() *start {
	c.gen++
	ctx, cancel := context.WithCancel(c.h.ctx)
	st := &start{gen: c.gen, ctx: ctx, cancel: cancel, done: make(chan struct{})}
	c.starting, c.start = true, st
	c.settle()
	return st
}

// stopAgent lets go of the chat's agent, or of its start: what waits is
// cancelled, a running turn ends in turnErr, and the chat is in rest (with
// e for StateFailed). It returns the session for the caller to end
// (host.endSession) without c.mu. The caller holds c.mu.
func (c *chat) stopAgent(rest string, e, turnErr *chatproto.Error) chatadapter.Session {
	e, turnErr = capStderr(e), capStderr(turnErr)
	c.gen++
	if c.start != nil {
		c.start.cancel()
		c.start = nil
	}
	c.starting = false
	c.endNext()
	clear(c.queued)
	c.cancelPending(chatproto.ByEnded, errEnded)
	if c.turn {
		c.turn = false
		if turnErr == nil {
			turnErr = errEnded
		}
		c.emit(chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnError, Error: turnErr})
	}
	sess := c.sess
	c.sess = nil
	c.rest = rest
	if rest == chatproto.StateFailed {
		c.r.Error = e
		if c.r.State == chatproto.StateFailed {
			// Failed again: the state is the same, the error is told.
			c.emit(chatproto.Event{T: chatproto.EventState, State: chatproto.StateFailed, Error: e})
			c.save()
		}
	}
	c.settle()
	return sess
}

// untrustedNotice is the method of the notice that an agent started
// without the project's own settings (agentproto.NoticeUntrustedFolder).
var untrustedNotice = agentproto.NoticeMethod(agentproto.NoticeUntrustedFolder)

// errEnded is what waits when the chat's agent ends.
var errEnded = perr(chatproto.CodeEnded, "the chat's agent ended")

// launch starts the chat's agent, a new session or resume's, and returns
// when the chat's agent runs or the start failed.
func (c *chat) launch(st *start, resume string) {
	defer close(st.done)
	sess, e := c.startAgent(st, resume)
	// Asked before c.mu is taken: no Session method is called with it
	// held, for an adapter may call the Sink with its own lock held.
	id := ""
	if sess != nil {
		id = sess.ID()
	}
	e = capStderr(e)
	c.mu.Lock()
	if c.gen != st.gen || c.deleted {
		c.mu.Unlock()
		st.err = perr(chatproto.CodeEnded, "the chat's start was cancelled")
		if sess != nil {
			// A host that stops waits for it (launch is one of h.wg's):
			// the agent does not outlive the host.
			c.h.endLate(sess)
		}
		return
	}
	st.cancel()
	c.starting, c.start = false, nil
	if e != nil {
		st.err = e
		c.h.logf("chat %s: did not start: %s", c.r.ID, e.Error())
		c.rest = chatproto.StateFailed
		c.r.Error = e
		if c.r.State == chatproto.StateFailed {
			c.emit(chatproto.Event{T: chatproto.EventState, State: chatproto.StateFailed, Error: e})
		}
		c.settle()
		c.save()
		c.notify()
		c.mu.Unlock()
		c.h.pokeQuiet()
		return
	}
	c.sess = sess
	if id != "" && sessionID.MatchString(id) {
		c.r.SessionID = id
	}
	if c.untrustedGen != st.gen {
		// It started in a trusted folder: the next start without the
		// project's settings is told again.
		c.r.UntrustedTold = false
	}
	c.r.HandedOff, c.r.Closed, c.r.Error = false, time.Time{}, nil
	c.rest = chatproto.StateSleeping
	c.emitInfo()
	c.settle()
	gen := c.gen
	c.mu.Unlock()
	c.h.wg.Go(func() { c.watchSession(sess, gen) })
	c.h.pokeQuiet()
}

// startAgent resolves the chat's agent and has its adapter start it.
func (c *chat) startAgent(st *start, resume string) (chatadapter.Session, *chatproto.Error) {
	h := c.h
	c.mu.Lock()
	kind, cwd, id, opts, config := c.r.Kind, c.r.Cwd, c.r.ID, c.r.Options, c.r.Config
	c.mu.Unlock()
	spec, a, e := h.spec(kind)
	if e != nil {
		return nil, e
	}
	if e := checkCwd(cwd); e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(st.ctx, h.o.startTimeout)
	defer cancel()
	env := agentEnv(h.env.get(ctx), spec.Env, cwd)
	path, ok := lookPath(spec.Argv[0], env)
	if !ok {
		return nil, perr(chatproto.CodeNotFound, spec.Argv[0]+" is not in the user's PATH")
	}
	if !h.makeRoom(c) {
		return nil, perr(chatproto.CodeTooMany, "as many agents as the settings allow work, wait or start")
	}
	settings := *h.settings.Load()
	if opts.Mode == "" {
		opts.Mode = settings.DefaultMode
	}
	if !settings.AllowFull && fullMode(config, opts.Mode) {
		c.fullAccessOff(st, opts.Mode)
		opts.Mode = chatproto.ModeDefault
	}
	p := chatadapter.StartParams{
		Kind: kind, Argv: append([]string{path}, spec.Argv[1:]...), Env: env, Cwd: cwd, Resume: resume,
		NewSessionMeta: spec.NewSessionMeta, Options: opts, Trusted: h.trusted(cwd), Client: clientInfo(), Settings: settings,
		Logger: log.New(h.logger.Writer(), h.logger.Prefix()+"chat "+id+": ", h.logger.Flags()),
	}
	if resume == "" {
		p.SessionID = newUUID()
	}
	sess, err := a.Start(ctx, p, &sink{c: c, gen: st.gen})
	switch {
	case err != nil:
		if ctx.Err() != nil && st.ctx.Err() == nil {
			return nil, perr(chatproto.CodeStartFailed, "the agent did not start in time")
		}
		return nil, errorOf(err)
	case sess == nil:
		return nil, perr(chatproto.CodeStartFailed, "the adapter made no session")
	}
	return sess, nil
}

// fullMode tells whether mode gives the agent full access: ModeFull, or a
// value of the chat's mode option its adapter marked Full.
func fullMode(config []chatproto.ConfigOption, mode string) bool {
	if mode == chatproto.ModeFull {
		return true
	}
	for _, o := range config {
		if o.Category != chatproto.CategoryMode {
			continue
		}
		for _, v := range o.Options {
			if v.Value == mode && v.Full {
				return true
			}
		}
	}
	return false
}

// fullAccessOff takes full access from a chat whose agent starts while
// the settings no longer allow it: its mode is the default from now on,
// which a notice tells.
func (c *chat) fullAccessOff(st *start, mode string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen != st.gen || c.deleted {
		return
	}
	c.h.logf("chat %s: full access is not allowed: it starts in the default mode", c.r.ID)
	c.r.Options.Mode = chatproto.ModeDefault
	c.emit(chatproto.Event{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeFullAccessOff),
		Params: line(map[string]string{"mode": mode})})
	c.save()
}

// revokeFull ends the agent of a chat that runs or starts in a mode of
// full access the settings no longer allow, and starts it again, its
// session resumed, in the default mode, which the notice full_access_off
// tells. It returns the session for the caller to end (host.endSession)
// without c.mu. The caller holds c.mu.
func (c *chat) revokeFull() chatadapter.Session {
	if c.deleted || c.stopped || (c.sess == nil && !c.starting) {
		return nil
	}
	full := c.r.Options.Mode
	if !fullMode(c.r.Config, full) {
		full = ""
		if o := modeOption(c.r.Config); o != nil && fullMode(c.r.Config, o.CurrentValue) {
			full = o.CurrentValue
		}
	}
	if full == "" {
		return nil
	}
	c.h.logf("chat %s: full access was turned off: its agent starts again in the default mode", c.r.ID)
	sess := c.stopAgent(chatproto.StateSleeping, nil, perr(chatproto.CodeNotAllowed, "full access was turned off"))
	c.r.Options.Mode = chatproto.ModeDefault
	c.emit(chatproto.Event{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeFullAccessOff),
		Params: line(map[string]string{"mode": full})})
	c.save()
	if !c.h.stopping.Load() {
		st := c.beginStart()
		session := c.r.SessionID
		if c.r.Fresh {
			session = ""
		}
		c.h.wg.Go(func() { c.launch(st, session) })
	}
	c.notify()
	return sess
}

// watchSession waits for the end of a session: one the host did not end
// leaves the chat failed (its error) or, ended without one, sleeping.
func (c *chat) watchSession(sess chatadapter.Session, gen uint64) {
	<-sess.Done()
	err := sess.Err() // before c.mu, as every Session method
	c.mu.Lock()
	if c.gen != gen || c.sess != sess {
		c.mu.Unlock()
		return
	}
	rest, e := chatproto.StateSleeping, (*chatproto.Error)(nil)
	if err != nil {
		rest = chatproto.StateFailed
		if !errors.As(err, &e) {
			e = perr(chatproto.CodeEnded, err.Error())
		}
	}
	c.h.logf("chat %s: its agent ended (%v)", c.r.ID, e.WithoutStderr())
	c.stopAgent(rest, e, perr(chatproto.CodeEnded, "the agent ended"))
	c.mu.Unlock()
	c.h.pokeQuiet()
}

// The ways of history.
const (
	// importAll brings the session's whole conversation (a new chat's
	// import).
	importAll = iota
	// catchUpStart brings what the session did in a terminal after the
	// log's last item, as the chat's agent starts.
	catchUpStart
	// catchUpAttach does it for an attach, while no agent runs or starts.
	catchUpAttach
)

// history brings a session's conversation from its adapter into the log:
// all of it, or for a catch-up what came after the log's last item
// (row.HistoryAfter), read once c.catchMu is held, which the caller holds:
// a catch-up never brings in what an earlier one brought. A catch-up of a
// chat no longer handed off, or one of an attach while an agent runs or
// starts, brings nothing. What it brings counts as seen. A failure is
// stored as an error notice, but for a catch-up that finds no such item or
// session (CodeNotFound): the session goes on without it, as the log has
// it, and the host logs why.
func (c *chat) history(ctx context.Context, session string, way int) {
	h := c.h
	c.mu.Lock()
	kind, cwd, after := c.r.Kind, c.r.Cwd, ""
	if way != importAll {
		after = c.r.HistoryAfter
		if !c.r.HandedOff || c.deleted || c.sess != nil || (way == catchUpAttach && c.starting) {
			c.mu.Unlock()
			return
		}
	}
	c.mu.Unlock()
	spec, a, e := h.spec(kind)
	if e != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, h.o.startTimeout)
	defer cancel()
	env := agentEnv(h.env.get(ctx), spec.Env, cwd)
	var argv []string // none for an agent not in the PATH: an adapter that reads files needs none
	if path, ok := lookPath(spec.Argv[0], env); ok {
		argv = append([]string{path}, spec.Argv[1:]...)
	}
	n := 0
	err := a.History(ctx, chatadapter.HistoryParams{Kind: kind, Argv: argv, Env: env,
		Cwd: cwd, SessionID: session, After: after, Logger: h.logger}, func(ev chatproto.Event) {
		if ev.Live {
			return
		}
		switch ev.T {
		case chatproto.EventAck, chatproto.EventState, chatproto.EventInfo:
			return
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.deleted || ctx.Err() != nil {
			return
		}
		c.emit(ev)
		c.r.Seen = c.r.Seq
		n++
	})
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil && !c.deleted {
		e := errorOf(err)
		if way != importAll && e.Code == chatproto.CodeNotFound {
			h.logf("chat %s: no catch-up of %s after %s: %s", c.r.ID, session, clip(after, 64), e.Error())
			if n > 0 {
				c.save()
				c.notify()
			}
			return
		}
		h.logf("chat %s: history of %s: %s", c.r.ID, session, e.Error())
		c.emit(chatproto.Event{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeError),
			Params: line(map[string]string{"message": e.Message, "code": e.Code})})
		c.r.Seen = c.r.Seq
	}
	if n > 0 || err != nil {
		c.save()
		c.notify()
	}
}

// catchUpLater brings what a handed off chat's session did in a terminal
// into the log, unless that runs already or ran less than catchUpEvery
// ago.
func (c *chat) catchUpLater() {
	c.mu.Lock()
	ok := c.r.HandedOff && c.sess == nil && !c.starting && !c.deleted && c.r.SessionID != "" && time.Since(c.caughtUp) >= catchUpEvery
	session := c.r.SessionID
	if ok {
		c.caughtUp = time.Now()
	}
	c.mu.Unlock()
	if !ok || !c.catchMu.TryLock() {
		return
	}
	c.h.wg.Go(func() {
		defer c.catchMu.Unlock()
		c.history(c.h.ctx, session, catchUpAttach)
	})
}

// subscribe attaches a connection: its head is the answer, then the stored
// events after from, then every event from now on. It is false for a chat
// that is no more.
func (c *chat) subscribe(s *subscriber, from uint64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.deleted {
		return false
	}
	b, err := chatproto.Line(chatproto.Response{OK: true, Chat: c.snapshot(), First: c.first})
	if err != nil {
		return false
	}
	s.head = [][]byte{b}
	if from < c.r.Seq {
		s.replay = &replay{j: c.h.j, chat: c.r.ID, after: from, upTo: c.r.Seq}
	}
	c.subs[s] = struct{}{}
	return true
}

// unsubscribe detaches a connection.
func (c *chat) unsubscribe(s *subscriber) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.subs, s)
}

// agentLocked is the chat's running session, or why a command that needs
// one is refused. The caller holds c.mu.
func (c *chat) agentLocked() (chatadapter.Session, *chatproto.Error) {
	switch {
	case c.deleted:
		return nil, perr(chatproto.CodeUnknownChat, "no such chat")
	case c.starting:
		return nil, perr(chatproto.CodeBusy, "the chat is starting")
	case c.sess == nil && c.r.HandedOff:
		return nil, perr(chatproto.CodeHandedOff, "the session went on in a terminal")
	case c.sess == nil:
		return nil, perr(chatproto.CodeSleeping, "the chat's agent does not run")
	}
	return c.sess, nil
}

// call runs a call of the agent with the host's call timeout.
func (c *chat) call(f func(ctx context.Context) error) *chatproto.Error {
	ctx, cancel := context.WithTimeout(c.h.ctx, c.h.o.callTimeout)
	defer cancel()
	return errorOf(f(ctx))
}

// prompt takes a message of the user: a new turn on an idle chat, after
// the agent's start on a chat that has none (its session resumed, and what
// it did in a terminal brought in first), else queued for the agent. A
// prompt with the page's id (ClientID) of one of the chat's last
// maxClientIDs prompts its log has is that one sent again by a page that
// did not get its answer: it is answered OK and not sent again; one with
// the id of a prompt being taken gets that one's answer.
func (c *chat) prompt(cmd chatproto.Command) (e *chatproto.Error) {
	images, e := checkContent(cmd.Content)
	if e != nil {
		return e
	}
	if len(cmd.ClientID) > 256 {
		return perr(chatproto.CodeBadRequest, "clientId too long")
	}
	msg := newID("m")
	checked := false
	c.mu.Lock()
	if id := cmd.ClientID; id != "" && !c.deleted {
		if c.clients[id] {
			c.mu.Unlock()
			c.h.logf("chat %s: a prompt it took already came again", c.r.ID)
			return nil
		}
		if f := c.sending[id]; f != nil {
			c.mu.Unlock()
			<-f.done
			return f.err
		}
		f := &sending{done: make(chan struct{})}
		c.sending[id] = f
		defer func() {
			c.mu.Lock()
			delete(c.sending, id)
			c.mu.Unlock()
			f.err = e
			close(f.done)
		}()
	}
	for {
		switch {
		case c.deleted:
			c.mu.Unlock()
			return perr(chatproto.CodeUnknownChat, "no such chat")
		case c.sess != nil && images && !c.r.Capabilities.Images:
			c.mu.Unlock()
			return perr(chatproto.CodeUnsupported, "the agent takes no images")
		case c.sess != nil && c.busy():
			// Queued: the adapter tells it (EventQueued), or, when the
			// turn ended meanwhile, stores its EventUser itself.
			sess := c.sess
			c.mu.Unlock()
			return c.call(func(ctx context.Context) error {
				return sess.Prompt(ctx, chatadapter.PromptParams{Content: cmd.Content, Message: msg, ClientID: cmd.ClientID})
			})
		case c.sess != nil:
			return c.startTurn(cmd, msg)
		case c.held:
			c.mu.Unlock()
			return perr(chatproto.CodeBusy, "the chat is starting")
		case c.starting:
			st := c.start
			c.held = true
			c.mu.Unlock()
			<-st.done
			c.mu.Lock()
			c.held = false
			if c.sess == nil && !c.starting {
				c.mu.Unlock()
				if st.err != nil {
					return st.err
				}
				return errEnded
			}
		default:
			if c.h.stopping.Load() {
				c.mu.Unlock()
				return perr(chatproto.CodeEnded, "the host stops")
			}
			handedOff, session := c.r.HandedOff, c.r.SessionID
			if c.r.Fresh {
				// The agent may not have kept a session that never had a
				// turn: a new one is made.
				session = ""
			}
			if session != "" && !checked {
				// Not while another process runs the session (a
				// terminal's): the chat stays as it is.
				checked = true
				kind, cwd := c.r.Kind, c.r.Cwd
				c.mu.Unlock()
				e := c.h.inTerminal(kind, cwd, session)
				c.mu.Lock()
				if e != nil {
					c.mu.Unlock()
					return e
				}
				continue
			}
			st := c.beginStart()
			c.held = true
			c.mu.Unlock()
			if handedOff && session != "" {
				c.catchMu.Lock()
				c.history(st.ctx, session, catchUpStart)
				c.catchMu.Unlock()
			}
			c.launch(st, session)
			c.mu.Lock()
			c.held = false
			if c.sess == nil && !c.starting {
				c.mu.Unlock()
				if st.err != nil {
					return st.err
				}
				return errEnded
			}
		}
	}
}

// startTurn starts a turn of an idle chat with a message, its EventUser
// stored (PromptParams.Recorded). The caller holds c.mu, which startTurn
// unlocks.
func (c *chat) startTurn(cmd chatproto.Command, msg string) *chatproto.Error {
	titled := false
	if c.r.Title == "" {
		if t := promptTitle(cmd.Content); t != "" {
			c.r.Title, titled = t, true
		}
	}
	c.emit(chatproto.Event{T: chatproto.EventUser, Content: cmd.Content, ClientID: cmd.ClientID})
	c.turn = true
	c.settle()
	if titled {
		c.emitInfo()
	}
	sess, gen := c.sess, c.gen
	c.mu.Unlock()
	e := c.call(func(ctx context.Context) error {
		return sess.Prompt(ctx, chatadapter.PromptParams{Content: cmd.Content, Message: msg, ClientID: cmd.ClientID, Recorded: true})
	})
	if e != nil {
		c.mu.Lock()
		if c.gen == gen && c.turn {
			c.turn = false
			c.cancelPending(chatproto.ByEnded, nil)
			c.emit(chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnError, Error: e})
			c.settle()
			c.notify()
		}
		c.mu.Unlock()
	}
	return e
}

// checkContent checks a prompt's content blocks: text, image (at most
// chatproto.MaxImage bytes, base64) and resource_link, at most
// chatproto.MaxPrompt bytes in all. images tells whether there is one.
func checkContent(content []json.RawMessage) (images bool, e *chatproto.Error) {
	if len(content) == 0 {
		return false, perr(chatproto.CodeBadRequest, "a prompt without content")
	}
	size := 0
	for _, b := range content {
		size += len(b)
	}
	if size > chatproto.MaxPrompt {
		return false, perr(chatproto.CodeTooLarge, "a prompt of more than 8 MiB")
	}
	for _, b := range content {
		var block struct {
			Type     string  `json:"type"`
			Text     *string `json:"text"`
			MimeType string  `json:"mimeType"`
			Data     string  `json:"data"`
			URI      string  `json:"uri"`
		}
		if json.Unmarshal(b, &block) != nil {
			return false, perr(chatproto.CodeBadRequest, "content is not an array of content blocks")
		}
		switch block.Type {
		case "text":
			if block.Text == nil {
				return false, perr(chatproto.CodeBadRequest, "a text block without text")
			}
		case "image":
			images = true
			if !strings.HasPrefix(block.MimeType, "image/") {
				return false, perr(chatproto.CodeBadRequest, "an image block without an image type")
			}
			if base64.StdEncoding.DecodedLen(len(block.Data)) > chatproto.MaxImage+2 {
				return false, perr(chatproto.CodeTooLarge, "an image of more than 5 MiB")
			}
			data, err := base64.StdEncoding.DecodeString(block.Data)
			if err != nil || len(data) == 0 {
				return false, perr(chatproto.CodeBadRequest, "an image block's data is not base64")
			}
			if len(data) > chatproto.MaxImage {
				return false, perr(chatproto.CodeTooLarge, "an image of more than 5 MiB")
			}
		case "resource_link":
			if block.URI == "" {
				return false, perr(chatproto.CodeBadRequest, "a resource link without a uri")
			}
		default:
			return false, perr(chatproto.CodeBadRequest, "a content block of another type than text, image or resource_link")
		}
	}
	return images, nil
}

// promptTitle is the title a prompt gives a chat: the first line of its
// first text block that has one.
func promptTitle(content []json.RawMessage) string {
	for _, raw := range content {
		var b struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &b) != nil || b.Type != "text" {
			continue
		}
		for l := range strings.SplitSeq(b.Text, "\n") {
			if l = strings.TrimSpace(l); l != "" {
				return clip(l, titleRunes)
			}
		}
	}
	return ""
}

// clip is s cut to n characters, its control characters spaces.
func clip(s string, n int) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, strings.ToValidUTF8(s, "�"))
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// cancelTurn cancels the turn: what waits is answered as cancelled, and
// the agent is told.
func (c *chat) cancelTurn() *chatproto.Error {
	c.mu.Lock()
	sess, e := c.agentLocked()
	if e != nil {
		c.mu.Unlock()
		return e
	}
	// The queued messages go with the turn: no turn takes them.
	next := c.next
	clear(c.queued)
	c.endNext()
	if !c.turn && !next && len(c.pending) == 0 {
		c.mu.Unlock()
		return nil
	}
	c.cancelPending(chatproto.ByCancel, nil)
	c.settle()
	c.mu.Unlock()
	return c.call(sess.Cancel)
}

// ask has a permission or a question wait for the user. It returns the
// answer: the user's, cancelled (the turn's cancel or end, ctx's end, too
// many waiting), or an error when the chat's agent ended.
func (c *chat) ask(ctx context.Context, gen uint64, p *pending, ev chatproto.Event) answer {
	c.mu.Lock()
	if c.gen != gen || c.deleted || (c.sess == nil && !c.starting) {
		c.mu.Unlock()
		return cancelled(p, errEnded)
	}
	// An agent that asks is in a turn of the session: it keeps it.
	c.r.Fresh = false
	if len(c.pending) >= maxPending {
		c.mu.Unlock()
		c.h.logf("chat %s: more than %d permissions and questions wait: one more was cancelled", c.r.ID, maxPending)
		return cancelled(p, nil)
	}
	p.n, p.done = pendingCount.Add(1), make(chan answer, 1)
	prefix := "p"
	if p.question {
		prefix = "q"
	}
	p.id = newID(prefix)
	ev.ID = p.id
	c.pending[p.id] = p
	if !c.emit(ev) {
		// Nobody can answer what the log does not have as it is: too
		// large (a notice says it was left out), or not stored.
		delete(c.pending, p.id)
		c.mu.Unlock()
		c.h.logf("chat %s: a %s that could not be stored was cancelled", c.r.ID, ev.T)
		return cancelled(p, nil)
	}
	c.settle()
	c.mu.Unlock()
	select {
	case a := <-p.done:
		return a
	case <-ctx.Done():
		c.mu.Lock()
		if c.pending[p.id] == p {
			c.resolve(p, cancelled(p, ctx.Err()), chatproto.ByCancel)
			c.settle()
		}
		c.mu.Unlock()
		return <-p.done
	}
}

func cancelled(p *pending, err error) answer {
	return answer{perm: chatadapter.PermissionAnswer{Cancelled: true}, q: chatadapter.QuestionAnswer{Cancelled: true}, err: err}
}

// resolve answers what waits and says so. The caller holds c.mu, and
// settles the chat's state after.
func (c *chat) resolve(p *pending, a answer, by string) {
	delete(c.pending, p.id)
	if p.question {
		ev := chatproto.Event{T: chatproto.EventQuestionDone, ID: p.id, By: by}
		if !a.q.Cancelled {
			ev.Answers = masked(p.questions, a.q.Answers)
		}
		c.emit(ev)
	} else {
		out := &chatproto.Outcome{Outcome: chatproto.OutcomeCancelled}
		if !a.perm.Cancelled {
			out = &chatproto.Outcome{Outcome: chatproto.OutcomeSelected, OptionID: a.perm.Option}
		}
		c.emit(chatproto.Event{T: chatproto.EventPermissionDone, ID: p.id, By: by, Outcome: out})
	}
	p.done <- a
}

// masked are answers as they are stored: those to a secret question each
// replaced by secretMask.
func masked(qs []chatproto.Question, answers map[string][]string) map[string][]string {
	out := make(map[string][]string, len(answers))
	for id, vs := range answers {
		if slices.ContainsFunc(qs, func(q chatproto.Question) bool { return q.ID == id && q.Secret }) {
			mask := make([]string, len(vs))
			for i := range mask {
				mask[i] = secretMask
			}
			vs = mask
		}
		out[id] = vs
	}
	return out
}

// cancelPending answers everything that waits as cancelled, the oldest
// first, with err for the adapter. The caller holds c.mu.
func (c *chat) cancelPending(by string, err error) {
	waiting := make([]*pending, 0, len(c.pending))
	for _, p := range c.pending {
		waiting = append(waiting, p)
	}
	sort.Slice(waiting, func(i, j int) bool { return waiting[i].n < waiting[j].n })
	for _, p := range waiting {
		c.resolve(p, cancelled(p, err), by)
	}
}

// answerPermission gives a permission the user's answer: the first one
// counts.
func (c *chat) answerPermission(cmd chatproto.Command) *chatproto.Error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.deleted {
		return perr(chatproto.CodeUnknownChat, "no such chat")
	}
	p := c.pending[cmd.Request]
	if p == nil || p.question {
		return perr(chatproto.CodeNotFound, "no such permission waits")
	}
	a := answer{perm: chatadapter.PermissionAnswer{Cancelled: true}}
	if !cmd.Cancelled {
		if !slices.Contains(p.options, cmd.Option) {
			return perr(chatproto.CodeBadRequest, "not an option of the permission")
		}
		a.perm = chatadapter.PermissionAnswer{Option: cmd.Option}
	}
	c.resolve(p, a, chatproto.ByUser)
	c.settle()
	return nil
}

// answerQuestion gives a question the user's answers, or skips it: the
// first answer counts.
func (c *chat) answerQuestion(cmd chatproto.Command) *chatproto.Error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.deleted {
		return perr(chatproto.CodeUnknownChat, "no such chat")
	}
	p := c.pending[cmd.Request]
	if p == nil || !p.question {
		return perr(chatproto.CodeNotFound, "no such question waits")
	}
	a := answer{q: chatadapter.QuestionAnswer{Cancelled: true}}
	if !cmd.Cancelled {
		if e := checkAnswers(p.questions, cmd.Answers); e != nil {
			return e
		}
		a.q = chatadapter.QuestionAnswer{Answers: cmd.Answers}
	}
	c.resolve(p, a, chatproto.ByUser)
	c.settle()
	return nil
}

// checkAnswers checks answers to questions: each names a question, its
// options by label, or the user's own words where the question allows
// them, one for a question that is not multiple choice.
func checkAnswers(qs []chatproto.Question, answers map[string][]string) *chatproto.Error {
	if len(answers) == 0 {
		return perr(chatproto.CodeBadRequest, "no answers")
	}
	size := 0
	for id, vs := range answers {
		i := slices.IndexFunc(qs, func(q chatproto.Question) bool { return q.ID == id })
		if i < 0 {
			return perr(chatproto.CodeBadRequest, "an answer to no question of it")
		}
		q := qs[i]
		if len(vs) == 0 || (!q.MultiSelect && len(vs) > 1) {
			return perr(chatproto.CodeBadRequest, "not as many answers as the question takes")
		}
		for _, v := range vs {
			size += len(v)
			known := slices.ContainsFunc(q.Options, func(o chatproto.QuestionOption) bool { return o.Label == v })
			if v == "" || !utf8.ValidString(v) || (!known && !q.AllowOther) {
				return perr(chatproto.CodeBadRequest, "not an option of the question")
			}
		}
	}
	if size > maxAnswerBytes {
		return perr(chatproto.CodeTooLarge, "answers of more than 64 KiB")
	}
	return nil
}

// setConfig sets a configuration option of the chat to one of its values.
func (c *chat) setConfig(id, value string) *chatproto.Error {
	c.mu.Lock()
	sess, e := c.agentLocked()
	if e != nil {
		c.mu.Unlock()
		return e
	}
	i := slices.IndexFunc(c.r.Config, func(o chatproto.ConfigOption) bool { return o.ID == id })
	if i < 0 {
		c.mu.Unlock()
		return perr(chatproto.CodeBadRequest, "no such configuration option")
	}
	v := slices.IndexFunc(c.r.Config[i].Options, func(v chatproto.ConfigValue) bool { return v.Value == value })
	if v < 0 {
		c.mu.Unlock()
		return perr(chatproto.CodeBadRequest, "not a value of the option")
	}
	if (c.r.Config[i].Options[v].Full || (c.r.Config[i].Category == chatproto.CategoryMode && value == chatproto.ModeFull)) &&
		!c.h.settings.Load().AllowFull {
		c.mu.Unlock()
		return perr(chatproto.CodeNotAllowed, "full access is not allowed on this machine")
	}
	category, gen := c.r.Config[i].Category, c.gen
	c.mu.Unlock()
	if e := c.call(func(ctx context.Context) error { return sess.SetConfig(ctx, id, value) }); e != nil {
		return e
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen != gen {
		return nil
	}
	config := slices.Clone(c.r.Config)
	if i := slices.IndexFunc(config, func(o chatproto.ConfigOption) bool { return o.ID == id }); i >= 0 {
		config[i].CurrentValue = value
	}
	c.r.Config = config
	// The agent starts again with what was set last.
	switch category {
	case chatproto.CategoryModel:
		c.r.Options.Model = value
	case chatproto.CategoryThoughtLevel:
		c.r.Options.Effort = value
	case chatproto.CategoryMode:
		// The agent's own modes too: an adapter takes its own values.
		c.r.Options.Mode = value
	}
	c.emitInfo()
	return nil
}

// cancelQueued withdraws a queued message.
func (c *chat) cancelQueued(message string) *chatproto.Error {
	if message == "" || len(message) > 64 {
		return perr(chatproto.CodeBadRequest, "no such message")
	}
	c.mu.Lock()
	sess, e := c.agentLocked()
	c.mu.Unlock()
	if e != nil {
		return e
	}
	return c.call(func(ctx context.Context) error { return sess.CancelQueued(ctx, message) })
}

// compact compacts the conversation's context.
func (c *chat) compact() *chatproto.Error {
	c.mu.Lock()
	sess, e := c.agentLocked()
	can := c.r.Capabilities.Compact
	c.mu.Unlock()
	switch {
	case e != nil:
		return e
	case !can:
		return perr(chatproto.CodeUnsupported, "the agent does not compact")
	}
	return c.call(sess.Compact)
}

// rename sets the chat's title.
func (c *chat) rename(title string) *chatproto.Error {
	title = strings.TrimSpace(clip(title, agentTitleRunes))
	if title == "" {
		return perr(chatproto.CodeBadRequest, "an empty title")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.deleted {
		return perr(chatproto.CodeUnknownChat, "no such chat")
	}
	c.r.Title, c.r.Renamed = title, true
	c.emitInfo()
	return nil
}

// handoff ends the chat's agent for its session to go on in a terminal,
// and returns once the agent is gone. Refused while a turn runs.
func (c *chat) handoff() *chatproto.Error {
	c.mu.Lock()
	if c.deleted {
		c.mu.Unlock()
		return perr(chatproto.CodeUnknownChat, "no such chat")
	}
	if c.starting || c.held || c.busy() {
		c.mu.Unlock()
		return perr(chatproto.CodeBusy, "a turn runs")
	}
	if c.r.SessionID == "" || c.r.Fresh {
		// A session without a turn may not be kept by the agent: no
		// terminal could take it up.
		c.mu.Unlock()
		return perr(chatproto.CodeNotFound, "the chat has no session with a turn")
	}
	sess := c.stopAgent(chatproto.StateSleeping, nil, nil)
	c.r.HandedOff, c.r.Closed = true, time.Time{}
	c.emit(chatproto.Event{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeHandedOff)})
	c.emitInfo()
	c.mu.Unlock()
	c.h.endSession(sess, true)
	return nil
}

// agentEvent takes an event of the chat's adapter. Live increments of an
// item go to the attached connections; the others are stored. The host's own events
// (acks, states, infos, permissions and questions, which the adapter asks
// through the Sink) are left out, and so is a turn event of no state the
// protocol knows.
func (c *chat) agentEvent(gen uint64, ev chatproto.Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen != gen || c.deleted {
		return
	}
	if ev.Live {
		// An increment belongs to an item, which its stored event replaces.
		if ev.Item == "" {
			c.dropEvent("live " + ev.T + " without an item")
			return
		}
		c.live(ev)
		return
	}
	switch ev.T {
	case chatproto.EventUpdate, chatproto.EventUser, chatproto.EventNotice:
		if ev.T == chatproto.EventUpdate {
			// The agent answered: it keeps the session.
			c.r.Fresh = false
		}
		if ev.T == chatproto.EventNotice && ev.Method == untrustedNotice {
			// Told once, until an agent of the chat starts in a trusted
			// folder.
			c.untrustedGen = gen
			if c.r.UntrustedTold {
				return
			}
			c.r.UntrustedTold = true
			c.emit(ev)
			c.save()
			return
		}
		c.emit(ev)
	case chatproto.EventQueued:
		c.followQueued(ev)
		c.emit(ev)
		if c.next && len(c.queued) == 0 && !c.nextTaken {
			// Every message that waited was withdrawn: no turn comes.
			c.endNext()
			c.settle()
			c.notify()
		}
	case chatproto.EventTurn:
		switch ev.State {
		case chatproto.TurnStart:
			c.turn = true
			c.endNext()
			c.emit(ev)
		case chatproto.TurnEnd, chatproto.TurnError:
			// What waits was asked before the end: it is cancelled, and
			// the end is the turn's last event.
			c.cancelPending(chatproto.ByEnded, nil)
			c.turn = false
			if ev.State == chatproto.TurnEnd {
				c.r.Fresh = false
			}
			c.emit(ev)
			c.awaitNext()
		default:
			c.dropEvent(ev.T + ":" + ev.State)
			return
		}
		c.settle()
		c.notify()
	default:
		c.dropEvent(ev.T)
	}
}

// followQueued follows the messages the adapter queued: waiting until it
// tells them taken or cancelled. The caller holds c.mu.
func (c *chat) followQueued(ev chatproto.Event) {
	if ev.Message == "" {
		return
	}
	switch ev.State {
	case chatproto.QueuedWaiting:
		if len(c.queued) < maxQueued {
			c.queued[ev.Message] = true
		}
	case chatproto.QueuedTaken, chatproto.QueuedCancelled:
		if ev.State == chatproto.QueuedTaken && c.next {
			c.nextTaken = true
		}
		delete(c.queued, ev.Message)
	}
}

// dropEvent logs, once for each kind, that an adapter's event was left out.
// The caller holds c.mu.
func (c *chat) dropEvent(kind string) {
	if !c.dropped[kind] && len(c.dropped) < 64 {
		c.dropped[kind] = true
		c.h.logf("chat %s: the adapter's events %q are left out", c.r.ID, kind)
	}
}

// update takes what the chat's adapter states of the chat: its title
// (the agent's own title of the session, unless the user named the chat),
// session id, configuration options, slash commands, usage, capabilities
// and agent version; the other members are the host's. A member whose
// JSON is longer than stateBytes is left as it was. The clients are told
// soon, the changes of a moment together.
//
// A mode the agent changes to by itself (the mode a plan's approval goes
// on in, an agent's own switch) after the first one it stated is the
// chat's mode from then on: its agent starts again in it. A mode of full
// access the agent takes while the settings do not allow it is taken
// back (denyFull).
func (c *chat) update(gen uint64, fn func(*chatproto.Chat)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen != gen || c.deleted || c.stopped {
		return
	}
	cp := *c.snapshot()
	fn(&cp)
	if t := strings.TrimSpace(clip(cp.Title, agentTitleRunes)); t != "" && !c.r.Renamed {
		c.r.Title = t
	}
	if cp.SessionID != c.r.SessionID && sessionID.MatchString(cp.SessionID) {
		c.r.SessionID = cp.SessionID
	}
	if fits(cp.Config) {
		c.r.Config = cp.Config
		if o := modeOption(c.r.Config); o != nil && o.CurrentValue != "" {
			id, value := o.ID, o.CurrentValue
			if c.modeGen == gen && value != c.mode && validOption(value) {
				// Stored with the EventInfo of this change.
				c.h.logf("chat %s: its agent changed its mode to %q", c.r.ID, clip(value, 64))
				c.r.Options.Mode = value
			}
			prev := c.mode
			c.mode, c.modeGen = value, gen
			if fullMode(c.r.Config, value) && !c.h.settings.Load().AllowFull && c.denying != gen {
				c.denying = gen
				back := safeMode(o, prev, c.r.Options.Mode)
				c.h.wg.Go(func() { c.denyFull(gen, id, value, back) })
			}
		}
	}
	if fits(cp.Commands) {
		c.r.Commands = cp.Commands
	}
	if fits(cp.Usage) {
		c.r.Usage = cp.Usage
	}
	c.r.Capabilities = cp.Capabilities
	if len(cp.AgentVersion) <= 256 {
		c.r.AgentVersion = clip(cp.AgentVersion, 256)
	}
	c.infoDirty = true
	if c.infoTimer == nil {
		c.infoTimer = time.AfterFunc(c.h.o.infoDelay, func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			c.infoTimer = nil
			if c.infoDirty && !c.deleted {
				c.emitInfo()
			}
		})
	}
	c.notify()
}

// modeOption is the chat's mode option; nil when it has none.
func modeOption(config []chatproto.ConfigOption) *chatproto.ConfigOption {
	for i := range config {
		if config[i].Category == chatproto.CategoryMode {
			return &config[i]
		}
	}
	return nil
}

// safeMode is the value of a mode option to take an agent out of a full
// access it took by itself: the mode it had before (prev), the chat's
// mode (want), the default mode, or the first of its values that gives
// no full access; "" when it has none.
func safeMode(o *chatproto.ConfigOption, prev, want string) string {
	ok := func(v string) bool {
		return v != "" && v != chatproto.ModeFull &&
			slices.ContainsFunc(o.Options, func(x chatproto.ConfigValue) bool { return x.Value == v && !x.Full })
	}
	for _, v := range []string{prev, want, chatproto.ModeDefault, "ask"} {
		if ok(v) {
			return v
		}
	}
	for _, x := range o.Options {
		if ok(x.Value) {
			return x.Value
		}
	}
	return ""
}

// denyFull takes an agent (gen) out of a mode of full access it took by
// itself while the settings do not allow it: its mode option id is set
// back to back; when that cannot be, the agent is ended and the chat
// fails (CodeNotAllowed). The chat's mode is back's (or the default) from
// then on, which the notice full_access_off tells.
func (c *chat) denyFull(gen uint64, id, value, back string) {
	c.mu.Lock()
	if st := c.start; c.sess == nil && st != nil && st.gen == gen {
		// Stated while it starts: once it runs, unless the start set
		// another mode.
		c.mu.Unlock()
		<-st.done
		c.mu.Lock()
	}
	sess := c.sess
	o := modeOption(c.r.Config)
	switch {
	case c.gen != gen || sess == nil || c.deleted:
		c.mu.Unlock()
		return
	case o == nil || !fullMode(c.r.Config, o.CurrentValue):
		c.denying = 0
		c.mu.Unlock()
		return
	}
	value = o.CurrentValue
	c.mu.Unlock()
	c.h.logf("chat %s: its agent took the mode %q of full access, which this machine does not allow", c.r.ID, clip(value, 64))
	var e *chatproto.Error
	if back == "" {
		e = perr(chatproto.CodeNotAllowed, "the agent has no mode without full access")
	} else {
		e = c.call(func(ctx context.Context) error { return sess.SetConfig(ctx, id, back) })
	}
	c.mu.Lock()
	if c.gen != gen || c.deleted {
		c.mu.Unlock()
		return
	}
	c.r.Options.Mode = cmp.Or(back, chatproto.ModeDefault)
	c.emit(chatproto.Event{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeFullAccessOff),
		Params: line(map[string]string{"mode": value})})
	if e == nil {
		if o := modeOption(c.r.Config); o != nil && o.ID == id {
			config := slices.Clone(c.r.Config)
			modeOption(config).CurrentValue = back
			c.r.Config = config
			c.mode = back
		}
		c.denying = 0
		c.emitInfo()
		c.mu.Unlock()
		return
	}
	c.h.logf("chat %s: its agent stays in full access (%s): it is ended", c.r.ID, e.Error())
	fail := perr(chatproto.CodeNotAllowed, "the agent took full access, which this machine does not allow")
	sess = c.stopAgent(chatproto.StateFailed, fail, fail)
	c.save()
	c.notify()
	c.mu.Unlock()
	c.h.endSession(sess, false)
}

// fits tells whether v's JSON is at most stateBytes.
func fits(v any) bool {
	b := line(v)
	return b != nil && len(b) <= stateBytes
}

// sink is where a chat's adapter reports, for one of its agents.
type sink struct {
	c   *chat
	gen uint64
}

func (s *sink) Event(ev chatproto.Event) { s.c.agentEvent(s.gen, ev) }

func (s *sink) Update(fn func(c *chatproto.Chat)) { s.c.update(s.gen, fn) }

func (s *sink) Permission(ctx context.Context, r chatadapter.PermissionRequest) (chatadapter.PermissionAnswer, error) {
	p := &pending{}
	options := make([]chatproto.PermissionOption, 0, len(r.Options))
	for _, o := range r.Options {
		if o.OptionID == "" || slices.Contains(p.options, o.OptionID) {
			continue
		}
		p.options = append(p.options, o.OptionID)
		options = append(options, o)
	}
	if len(options) == 0 {
		return chatadapter.PermissionAnswer{Cancelled: true}, nil
	}
	kind := r.Kind
	if kind == "" {
		kind = chatproto.PermissionOther
	}
	a := s.c.ask(ctx, s.gen, p, chatproto.Event{T: chatproto.EventPermission, Kind: kind, ToolCall: r.ToolCall,
		Options: options, Parent: r.Parent})
	return a.perm, a.err
}

// Question asks the user. A question without an id, or with the id of one
// before it, is asked under an id of the host's: the answers come back to
// the adapter under the ids it gave (the first answer of those of one id).
func (s *sink) Question(ctx context.Context, r chatadapter.QuestionRequest) (chatadapter.QuestionAnswer, error) {
	qs := slices.Clone(r.Questions)
	if len(qs) == 0 {
		return chatadapter.QuestionAnswer{Cancelled: true}, nil
	}
	// The adapter's ids that stay: each one's first.
	used := make(map[string]bool, len(qs))
	keep := make([]bool, len(qs))
	for i, q := range qs {
		if q.ID != "" && !used[q.ID] {
			used[q.ID], keep[i] = true, true
		}
	}
	ids := make(map[string]string, len(qs)) // the host's id → the adapter's
	for i := range qs {
		id := qs[i].ID
		if !keep[i] {
			n := i + 1
			for used["q"+strconv.Itoa(n)] {
				n++
			}
			qs[i].ID = "q" + strconv.Itoa(n)
			used[qs[i].ID] = true
		}
		ids[qs[i].ID] = id
	}
	p := &pending{question: true, questions: qs}
	a := s.c.ask(ctx, s.gen, p, chatproto.Event{T: chatproto.EventQuestion, Questions: qs, ToolCall: r.ToolCall, Parent: r.Parent})
	if len(a.q.Answers) > 0 {
		answers := make(map[string][]string, len(a.q.Answers))
		for _, q := range qs {
			vs, ok := a.q.Answers[q.ID]
			if _, had := answers[ids[q.ID]]; ok && !had {
				answers[ids[q.ID]] = vs
			}
		}
		a.q.Answers = answers
	}
	return a.q, a.err
}
