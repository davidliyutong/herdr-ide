// Package codex is the chat host's adapter for Codex (chatadapter name
// "codex"): it drives `codex app-server --listen stdio://`, protocol v2
// with experimentalApi, one app-server process per chat, and maps its
// threads, turns and items to chatproto events.
//
// The wire is newline-delimited JSON-RPC without the jsonrpc member. Our
// requests are numbered from 1; the app-server numbers its own requests
// from 0, so a line with a method is its request (or notification), never
// an answer. Requests the adapter does not serve are answered "method not
// found"; notifications it has no mapping for are passed over and counted.
//
// What the adapter guarantees beyond chatadapter's rules:
//
//   - Threads start and resume with sandbox "read-only", approval policy
//     "on-request" and the user as reviewer; each turn carries the chat's
//     mode as policies: default asks before edits and commands (untrusted,
//     workspace-write: the one combination where Codex 0.171 asks for a
//     file write and a command alike instead of refusing them),
//     acceptEdits writes the working directory (on-request,
//     workspace-write), plan
//     plans (collaboration mode plan, read-only), full asks for nothing
//     (never, danger-full-access). Model and effort go with every turn:
//     thread/start takes no effort.
//   - Approvals map to accept, acceptForSession, decline and cancel; never
//     to the execpolicy or network amendments Codex offers, which it saves.
//   - Images go as data URLs, never as local files (an item keeps only a
//     local image's path).
//   - Codex does not stop a command of a turn it interrupted: when one still
//     runs interruptGrace after the interrupt, the app-server is ended
//     gracefully and started again on the thread, which ends it.
//   - A plan (plan mode's plan item) is approved through a permission of
//     kind plan before its turn ends; approved, the next turn carries it
//     out ("Implement the plan.") in the mode chosen.
package codex

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"veldr/internal/agentkinds"
	"veldr/internal/agentproto"
	"veldr/internal/brand"
	"veldr/internal/chatadapter"
	"veldr/internal/chatproto"
)

// clientName is the client's name Codex records as its threads'
// originator; clientTitle its display name.
const (
	clientName  = brand.Slug
	clientTitle = brand.Name
)

func init() { chatadapter.Register(agentkinds.AdapterCodex, &Adapter{}) }

// Adapter is the Codex adapter.
type Adapter struct {
	mu   sync.Mutex
	live map[*session]struct{}
}

func (a *Adapter) add(s *session) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.live == nil {
		a.live = map[*session]struct{}{}
	}
	a.live[s] = struct{}{}
}

func (a *Adapter) forget(s *session) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.live, s)
}

// liveConn is the app-server of a running session, to ask what does not
// need a process of its own (thread lists, turns); nil for none.
func (a *Adapter) liveConn() *conn {
	a.mu.Lock()
	defer a.mu.Unlock()
	for s := range a.live {
		s.mu.Lock()
		c, ok := s.c, !s.ended && !s.closing && !s.restarting && s.thread != ""
		s.mu.Unlock()
		if ok && c != nil && !isClosed(c.closed) {
			return c
		}
	}
	return nil
}

// Start starts an app-server and a thread on it, or takes Resume's.
func (a *Adapter) Start(ctx context.Context, p chatadapter.StartParams, sink chatadapter.Sink) (chatadapter.Session, error) {
	sctx, cancel := context.WithCancel(context.Background())
	s := &session{
		ad: a, p: p, sink: sink, log: p.Logger, m: mapper{cwd: p.Cwd},
		ctx: sctx, cancel: cancel, sem: make(chan struct{}, 1),
		items: map[string]*openItem{}, children: map[string]child{}, pending: map[string]*pending{},
		limits: map[string][]chatproto.Limit{}, done: make(chan struct{}),
	}
	if err := s.connect(ctx, p.Resume, true); err != nil {
		s.mu.Lock()
		s.closing = true
		c := s.c
		s.mu.Unlock()
		if c != nil {
			c.proc.end()
			<-s.done
		} else {
			s.finish(nil)
		}
		return nil, err
	}
	a.add(s)
	s.mu.Lock()
	ended := s.ended
	update := s.chatUpdate()
	s.mu.Unlock()
	if ended {
		a.forget(s)
	}
	sink.Update(update)
	return s, nil
}

// probeHandler is a process that only answers questions: it is told
// nothing worth keeping, and is asked nothing it would answer.
type probeHandler struct{}

func (probeHandler) notify(string, json.RawMessage, time.Time) {}
func (probeHandler) request(r *serverRequest)                  { refuse(r) }

// client is an app-server to ask: a running session's, else one started
// for the question, which done ends.
func (a *Adapter) client(ctx context.Context, argv, env []string, cwd string, logger *log.Logger) (c *conn, done func(), err error) {
	if c := a.liveConn(); c != nil {
		return c, func() {}, nil
	}
	return a.probe(ctx, argv, env, cwd, logger)
}

// probe is an app-server started to answer questions, which done ends.
func (a *Adapter) probe(ctx context.Context, argv, env []string, cwd string, logger *log.Logger) (c *conn, done func(), err error) {
	// The directory is a parameter of the questions: a process for them
	// runs anywhere, in it while it is there.
	if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
		cwd = "/"
	}
	proc, err := startProcess(argv, cwd, env)
	if err != nil {
		return nil, nil, &chatproto.Error{Code: chatproto.CodeStartFailed, Message: err.Error()}
	}
	c = newConn(proc, func(*conn) handler { return probeHandler{} }, logger)
	ictx, cancel := context.WithTimeout(ctx, startTimeout)
	defer cancel()
	if _, err := initialize(ictx, c, chatadapter.ClientInfo{Name: clientTitle, Version: agentproto.Version}); err != nil {
		proc.end()
		return nil, nil, startError(c, err)
	}
	return c, proc.end, nil
}

// sessionsPage is how many threads a page of Sessions lists.
const sessionsPage = 50

// Sessions lists the threads of a directory, the most recent first
// (thread/list), the subagents' left out.
func (a *Adapter) Sessions(ctx context.Context, p chatadapter.SessionsParams) ([]chatproto.Session, string, error) {
	c, done, err := a.client(ctx, p.Argv, p.Env, p.Cwd, p.Logger)
	if err != nil {
		return nil, "", err
	}
	defer done()
	params := map[string]any{"cwd": p.Cwd, "limit": sessionsPage}
	if p.Cursor != "" {
		params["cursor"] = p.Cursor
	}
	var res threadListResult
	err = c.call(ctx, mThreadList, params, &res)
	if errors.Is(err, errClosed) {
		// The session whose app-server was asked ended meanwhile.
		done()
		if c, done, err = a.probe(ctx, p.Argv, p.Env, p.Cwd, p.Logger); err != nil {
			return nil, "", err
		}
		defer done()
		err = c.call(ctx, mThreadList, params, &res)
	}
	if err != nil {
		return nil, "", callError(err)
	}
	var out []chatproto.Session
	for _, t := range res.Data {
		if t.ID == "" || t.Ephemeral || (t.ParentThreadID != nil && *t.ParentThreadID != "") {
			continue
		}
		title := t.Preview
		if t.Name != nil && *t.Name != "" {
			title = *t.Name
		}
		title, _, _ = strings.Cut(strings.TrimSpace(title), "\n")
		s := chatproto.Session{SessionID: t.ID, Cwd: t.Cwd, Title: cutText(title, maxSessionTitle)}
		if s.Cwd == "" {
			s.Cwd = p.Cwd
		}
		if t.UpdatedAt > 0 {
			s.UpdatedAt = time.Unix(t.UpdatedAt, 0).UTC()
		}
		out = append(out, s)
	}
	next := ""
	if res.NextCursor != nil {
		next = *res.NextCursor
	}
	return out, next, nil
}

// The bounds of a History.
const (
	// historyPage is how many turns a page of thread/turns/list holds.
	historyPage = 20
	// historyPages bounds the pages read.
	historyPages = 500
)

// History emits the settled turns of a thread (thread/turns/list with
// every item), mapped as a live session maps them; after p.After (an item
// or a turn id an earlier History or the session emitted) only what came
// after it. A turn still running is left for a later History. Subagents'
// own threads are not read: their tool calls are. The whole thread starts
// with an info event of the thread's name, when it has one (threadName).
func (a *Adapter) History(ctx context.Context, p chatadapter.HistoryParams, emit func(chatproto.Event)) error {
	c, done, err := a.client(ctx, p.Argv, p.Env, p.Cwd, p.Logger)
	if err != nil {
		return err
	}
	defer done()
	h := history{m: mapper{cwd: p.Cwd}, emit: emit}
	if p.After == "" {
		if name := threadName(ctx, c, p.SessionID, p.Logger); name != "" {
			emit(chatproto.Event{T: chatproto.EventInfo, Chat: &chatproto.Chat{Title: name}})
		}
		return h.forward(ctx, c, p.SessionID)
	}
	return h.since(ctx, c, p.SessionID, p.After, p.Logger)
}

// threadName is the name a thread was given (by the user, or by Codex),
// read with thread/list restricted to the thread's id: not its preview,
// which is its first prompt. "" for none, or when it cannot be read.
func threadName(ctx context.Context, c *conn, thread string, logger *log.Logger) string {
	var res threadListResult
	err := c.call(ctx, mThreadList, map[string]any{"includedThreadIds": []string{thread}, "limit": 1}, &res)
	if err != nil {
		if logger != nil {
			logger.Printf("codex: the name of thread %s: %v", thread, err)
		}
		return ""
	}
	for _, t := range res.Data {
		if t.ID == thread && t.Name != nil {
			name, _, _ := strings.Cut(strings.TrimSpace(*t.Name), "\n")
			return cutText(strings.TrimSpace(name), maxSessionTitle)
		}
	}
	return ""
}

type history struct {
	m    mapper
	emit func(chatproto.Event)
}

func turnsPage(ctx context.Context, c *conn, thread, direction, cursor string) (*turnsListResult, error) {
	params := map[string]any{"threadId": thread, "limit": historyPage, "sortDirection": direction, "itemsView": "full"}
	if cursor != "" {
		params["cursor"] = cursor
	}
	var res turnsListResult
	if err := c.call(ctx, mThreadTurnsList, params, &res); err != nil {
		return nil, callError(err)
	}
	return &res, nil
}

// forward emits every settled turn, oldest first.
func (h history) forward(ctx context.Context, c *conn, thread string) error {
	cursor := ""
	for range historyPages {
		res, err := turnsPage(ctx, c, thread, "asc", cursor)
		if err != nil {
			return err
		}
		for i := range res.Data {
			if res.Data[i].Status == turnInProgress {
				return nil
			}
			h.turn(&res.Data[i], "")
		}
		if res.NextCursor == nil || *res.NextCursor == "" {
			return nil
		}
		cursor = *res.NextCursor
	}
	return nil
}

// since emits what came after the turn or the item after: the turns are
// read newest first until the one that has it.
func (h history) since(ctx context.Context, c *conn, thread, after string, logger *log.Logger) error {
	var later []turnInfo
	cursor := ""
	for range historyPages {
		res, err := turnsPage(ctx, c, thread, "desc", cursor)
		if err != nil {
			return err
		}
		for _, t := range res.Data {
			if t.ID == after {
				h.replay(later, "")
				return nil
			}
			if hasItem(&t, after) {
				h.replay(append(later, t), after)
				return nil
			}
			later = append(later, t)
		}
		if res.NextCursor == nil || *res.NextCursor == "" {
			break
		}
		cursor = *res.NextCursor
	}
	if logger != nil {
		logger.Printf("codex: history of %s: %q is not in the thread; nothing emitted", thread, cutText(after, 64))
	}
	return nil
}

// replay emits turns read newest first, oldest first; the oldest from
// after its item after when after is not "".
func (h history) replay(newestFirst []turnInfo, after string) {
	for i := len(newestFirst) - 1; i >= 0; i-- {
		t := &newestFirst[i]
		if t.Status == turnInProgress {
			return
		}
		from := ""
		if i == len(newestFirst)-1 {
			from = after
		}
		h.turn(t, from)
	}
}

func hasItem(t *turnInfo, id string) bool {
	for _, raw := range t.Items {
		var it struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(raw, &it) == nil && it.ID == id {
			return true
		}
	}
	return false
}

// turn emits a turn: its start, its items (those after the item after,
// when after is not ""), its end.
func (h history) turn(t *turnInfo, after string) {
	at := time.Time{}
	if t.StartedAt != nil {
		at = time.Unix(*t.StartedAt, 0).UTC()
	}
	if after == "" {
		h.emit(chatproto.Event{T: chatproto.EventTurn, At: at, State: chatproto.TurnStart, Item: t.ID})
	}
	skipping := after != ""
	spawns := map[string]obj{}
	for _, rawItem := range t.Items {
		var it item
		if json.Unmarshal(rawItem, &it) != nil || it.ID == "" {
			continue
		}
		if skipping {
			skipping = it.ID != after
			continue
		}
		at = itemTime(&it, at)
		switch it.Type {
		case itemUserMessage:
			h.emit(chatproto.Event{T: chatproto.EventUser, At: at, Item: it.ID, Content: userContent(it.Content)})
			continue
		case itemSubAgent:
			switch it.Kind {
			case subAgentStarted:
				u := subAgentCall(&it, toolCompleted)
				spawns[it.AgentThreadID] = u
				h.emit(updateEvent(it.ID, "", false, u, at))
			case subAgentStopped:
				if u, ok := spawns[it.AgentThreadID]; ok {
					u = cancelledCall(u)
					h.emit(updateEvent(u["toolCallId"].(string), "", false, u, at))
				}
			}
			continue
		}
		evs, _ := h.m.itemEvents(&it, true, "", at)
		for _, ev := range evs {
			h.emit(ev)
		}
	}
	end := at
	if t.CompletedAt != nil {
		end = time.Unix(*t.CompletedAt, 0).UTC()
	}
	h.emit(turnEnd(t, nil, end))
}
