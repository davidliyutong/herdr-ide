//go:build unix

package chathost

import (
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
	// capabilities): with it, the list of all chats fits a line.
	stateBytes = 256 << 10
	// maxPending is the number of permissions and questions that may wait
	// in a chat; an agent that asks more is answered that they were
	// cancelled.
	maxPending = 64
	// maxAnswerBytes is the most bytes of a question's answers.
	maxAnswerBytes = 64 << 10
	// catchUpEvery is how often attaching brings what a handed off
	// session did in a terminal into the log (it may run the agent to ask).
	catchUpEvery = 10 * time.Second
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

	sess chatadapter.Session
	// gen numbers the chat's agents: a session or a start of an earlier
	// one is no longer heard.
	gen      uint64
	starting bool
	start    *start
	held     bool // a prompt waits for the start
	turn     bool // a turn runs
	pending  map[string]*pending

	idleSince time.Time // since when the chat is idle
	idleTimer *time.Timer

	infoDirty bool // the adapter changed what the chat states
	infoTimer *time.Timer
	lastState chatproto.ChatState // what the watchers were told last
	dropped   map[string]bool     // the kinds of the adapter's events left out, logged once

	catchMu  sync.Mutex // one History of the session at a time
	caughtUp time.Time  // when an attach last brought a handed off session's turns in
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
	return &chat{h: h, r: r, subs: map[*subscriber]struct{}{}, pending: map[string]*pending{}, dropped: map[string]bool{}}
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
// connections; one that fell too far behind is disconnected. The caller
// holds c.mu.
func (c *chat) emit(ev chatproto.Event) {
	if c.deleted {
		return
	}
	t := now()
	ev.Seq, ev.Live = c.r.Seq+1, false
	if ev.At.IsZero() {
		ev.At = t
	}
	if ev.T == chatproto.EventInfo {
		ev.Chat = c.snapshot()
		ev.Chat.Seq, ev.Chat.Updated = ev.Seq, t
	}
	ev, b := fit(ev)
	if b == nil {
		c.h.logf("chat %s: an event %s that is no JSON was left out", c.r.ID, ev.T)
		return
	}
	c.r.Seq, c.r.Updated = ev.Seq, t
	if ev.Item != "" && ev.Parent == "" {
		c.r.HistoryAfter = ev.Item
	}
	if ev.T == chatproto.EventTurn && (ev.State == chatproto.TurnEnd || ev.State == chatproto.TurnError) {
		c.r.TurnEnd = ev.Seq
	}
	c.r.Bytes += int64(len(b))
	if err := c.h.j.appendEvent(c.r, stored{seq: ev.Seq, t: ev.T, item: ev.Item, at: ev.At, line: b}); err != nil {
		c.h.logf("chat %s: store event %d: %v", c.r.ID, ev.Seq, err)
	}
	c.fanOut(append(b, '\n'))
	if max := c.h.settings.Load().MaxChatBytes; c.r.Bytes > max {
		c.trim(max - max/8)
	}
	c.h.wrote(len(b))
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
	case c.sess != nil && c.turn:
		state = chatproto.StateWorking
	case c.sess != nil:
		state = chatproto.StateIdle
	}
	if state == "" {
		state = chatproto.StateSleeping
	}
	c.setState(state)
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
	c.gen++
	if c.start != nil {
		c.start.cancel()
		c.start = nil
	}
	c.starting = false
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
	c.mu.Lock()
	if c.gen != st.gen || c.deleted {
		c.mu.Unlock()
		st.err = perr(chatproto.CodeEnded, "the chat's start was cancelled")
		if sess != nil {
			c.h.endSession(sess, false)
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
	kind, cwd, id, opts := c.r.Kind, c.r.Cwd, c.r.ID, c.r.Options
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
	p := chatadapter.StartParams{
		Kind: kind, Argv: append([]string{path}, spec.Argv[1:]...), Env: env, Cwd: cwd, Resume: resume,
		NewSessionMeta: spec.NewSessionMeta, Options: opts, Client: clientInfo(), Settings: settings,
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
	c.h.logf("chat %s: its agent ended (%v)", c.r.ID, err)
	c.stopAgent(rest, e, perr(chatproto.CodeEnded, "the agent ended"))
	c.mu.Unlock()
	c.h.pokeQuiet()
}

// history brings a session's conversation from its adapter into the log,
// after the item after ("" for all of it). What it brings counts as seen.
// A failure is stored as an error notice, but for a catch-up (after not
// "") that finds no such item or session (CodeNotFound): the session goes
// on without it, as the log has it, and the host logs why.
func (c *chat) history(ctx context.Context, session, after string) {
	h := c.h
	c.mu.Lock()
	kind, cwd := c.r.Kind, c.r.Cwd
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
		if after != "" && e.Code == chatproto.CodeNotFound {
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
	session, after := c.r.SessionID, c.r.HistoryAfter
	if ok {
		c.caughtUp = time.Now()
	}
	c.mu.Unlock()
	if !ok || !c.catchMu.TryLock() {
		return
	}
	c.h.wg.Go(func() {
		defer c.catchMu.Unlock()
		c.history(c.h.ctx, session, after)
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
// it did in a terminal brought in first), else queued for the agent.
func (c *chat) prompt(cmd chatproto.Command) *chatproto.Error {
	images, e := checkContent(cmd.Content)
	if e != nil {
		return e
	}
	if len(cmd.ClientID) > 256 {
		return perr(chatproto.CodeBadRequest, "clientId too long")
	}
	msg := newID("m")
	c.mu.Lock()
	for {
		switch {
		case c.deleted:
			c.mu.Unlock()
			return perr(chatproto.CodeUnknownChat, "no such chat")
		case c.sess != nil && images && !c.r.Capabilities.Images:
			c.mu.Unlock()
			return perr(chatproto.CodeUnsupported, "the agent takes no images")
		case c.sess != nil && (c.turn || len(c.pending) > 0):
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
			st := c.beginStart()
			c.held = true
			handedOff, session, after := c.r.HandedOff, c.r.SessionID, c.r.HistoryAfter
			c.mu.Unlock()
			if handedOff && session != "" {
				c.catchMu.Lock()
				c.history(st.ctx, session, after)
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
	if !c.turn && len(c.pending) == 0 {
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
	c.emit(ev)
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
	if !slices.ContainsFunc(c.r.Config[i].Options, func(v chatproto.ConfigValue) bool { return v.Value == value }) {
		c.mu.Unlock()
		return perr(chatproto.CodeBadRequest, "not a value of the option")
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
		if slices.Contains(chatproto.Modes, value) {
			c.r.Options.Mode = value
		}
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
	c.r.Title = title
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
	if c.starting || c.held || c.turn || len(c.pending) > 0 {
		c.mu.Unlock()
		return perr(chatproto.CodeBusy, "a turn runs")
	}
	if c.r.SessionID == "" {
		c.mu.Unlock()
		return perr(chatproto.CodeNotFound, "the chat has no session")
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
	case chatproto.EventUpdate, chatproto.EventUser, chatproto.EventQueued, chatproto.EventNotice:
		c.emit(ev)
	case chatproto.EventTurn:
		switch ev.State {
		case chatproto.TurnStart:
			c.turn = true
			c.emit(ev)
		case chatproto.TurnEnd, chatproto.TurnError:
			// What waits was asked before the end: it is cancelled, and
			// the end is the turn's last event.
			c.cancelPending(chatproto.ByEnded, nil)
			c.turn = false
			c.emit(ev)
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

// dropEvent logs, once for each kind, that an adapter's event was left out.
// The caller holds c.mu.
func (c *chat) dropEvent(kind string) {
	if !c.dropped[kind] && len(c.dropped) < 64 {
		c.dropped[kind] = true
		c.h.logf("chat %s: the adapter's events %q are left out", c.r.ID, kind)
	}
}

// update takes what the chat's adapter states of the chat: its title,
// session id, configuration options, slash commands, usage, capabilities
// and agent version; the other members are the host's. A member whose
// JSON is longer than stateBytes is left as it was. The clients are told
// soon, the changes of a moment together.
func (c *chat) update(gen uint64, fn func(*chatproto.Chat)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen != gen || c.deleted || c.stopped {
		return
	}
	cp := *c.snapshot()
	fn(&cp)
	if t := strings.TrimSpace(clip(cp.Title, agentTitleRunes)); t != "" {
		c.r.Title = t
	}
	if cp.SessionID != c.r.SessionID && sessionID.MatchString(cp.SessionID) {
		c.r.SessionID = cp.SessionID
	}
	if fits(cp.Config) {
		c.r.Config = cp.Config
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

func (s *sink) Question(ctx context.Context, r chatadapter.QuestionRequest) (chatadapter.QuestionAnswer, error) {
	qs := slices.Clone(r.Questions)
	if len(qs) == 0 {
		return chatadapter.QuestionAnswer{Cancelled: true}, nil
	}
	seen := map[string]bool{}
	for i := range qs {
		if qs[i].ID == "" || seen[qs[i].ID] {
			qs[i].ID = "q" + strconv.Itoa(i+1)
		}
		seen[qs[i].ID] = true
	}
	p := &pending{question: true, questions: qs}
	a := s.c.ask(ctx, s.gen, p, chatproto.Event{T: chatproto.EventQuestion, Questions: qs, ToolCall: r.ToolCall, Parent: r.Parent})
	return a.q, a.err
}
