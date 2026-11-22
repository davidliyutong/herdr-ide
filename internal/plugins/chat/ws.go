package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"

	"herdr-ide/internal/chatproto"
	"herdr-ide/internal/plugin"
)

// backlogMessages and backlogBytes are how far a page may fall behind the
// messages it is sent before it is disconnected; one message of any size
// is taken when nothing waits (variables for the tests).
var (
	backlogMessages = 8192
	backlogBytes    = 32 << 20
)

// Bounds of a page's WebSocket.
const (
	// pageWriteTimeout is how long a page has to take one message, and
	// closeGrace how long one that fell behind has to take the close.
	pageWriteTimeout = 30 * time.Second
	closeGrace       = time.Second
	// subCommands is how many commands of a subscription may wait to be
	// written to its host connection, and maxPending how many may wait
	// for their answer.
	subCommands = 16
	maxPending  = 64
)

// page is a page's WebSocket: its subscriptions and the messages it is
// sent.
type page struct {
	p    *Plugin
	host plugin.Host
	// req is the upgrade request: who the page is, for the audit log.
	req    *http.Request
	ws     *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc

	mu   sync.Mutex
	subs map[string]*sub
	// out are the messages to send, outBytes their size; closing: send
	// what is there, then close with closeCode; closed: nothing more is
	// sent.
	out       [][]byte
	outBytes  int
	closing   bool
	closed    bool
	closeCode websocket.StatusCode
	closeWhy  string
	wake      chan struct{}
}

// serveWS serves a page's WebSocket (GET /api/p/chat/ws). The core's guards
// checked the request's host and origin as for every route.
func (p *Plugin) serveWS(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	p.bind(c.Host)
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The core's guard verified Origin.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionContextTakeover,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(MaxClientMessage)
	ctx, cancel := context.WithCancel(context.Background())
	pg := &page{p: p, host: c.Host, req: r, ws: ws, ctx: ctx, cancel: cancel, subs: map[string]*sub{}, wake: make(chan struct{}, 1)}
	p.mu.Lock()
	p.pages[pg] = struct{}{}
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.pages, pg)
		p.mu.Unlock()
		pg.shut()
		ws.CloseNow()
	}()
	go pg.writeLoop()
	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var m ClientMessage
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.Op {
		case OpAttach:
			pg.attach(&m)
		case OpDetach:
			pg.detach(m.Sub)
		case OpCommand:
			pg.command(&m)
		}
	}
}

// shut ends the page: nothing more is sent, every subscription ends.
func (pg *page) shut() {
	pg.mu.Lock()
	pg.closed = true
	pg.out, pg.outBytes = nil, 0
	subs := pg.subs
	pg.subs = map[string]*sub{}
	for _, s := range subs {
		s.gone = true
	}
	pg.mu.Unlock()
	for _, s := range subs {
		s.cancel()
	}
	pg.cancel()
}

// closePages tells each page's subscriptions that they ended with code
// (none for ""), then closes the pages: the plugin was turned off, the core
// stops.
func (p *Plugin) closePages(code string) {
	p.mu.Lock()
	pages := make([]*page, 0, len(p.pages))
	for pg := range p.pages {
		pages = append(pages, pg)
	}
	p.mu.Unlock()
	for _, pg := range pages {
		pg.finish(code)
	}
}

// finish ends every subscription with code (telling none for ""), sends
// what is queued and closes the WebSocket.
func (pg *page) finish(code string) {
	pg.mu.Lock()
	subs := pg.subs
	pg.subs = map[string]*sub{}
	for id, s := range subs {
		s.gone = true
		if code != "" {
			pg.enqueueLocked(mustJSON(ServerMessage{T: TDetached, Sub: id, Error: &chatproto.Error{Code: code, Message: "the chat plugin is off"}}))
		}
	}
	why := code
	if why == "" {
		why = "the core stops"
	}
	pg.closeLocked(websocket.StatusGoingAway, why)
	pg.mu.Unlock()
	for _, s := range subs {
		s.cancel()
	}
}

// closeLocked closes the page once what is queued was sent. pg.mu is held.
func (pg *page) closeLocked(code websocket.StatusCode, why string) {
	if pg.closing || pg.closed {
		return
	}
	pg.closing, pg.closeCode, pg.closeWhy = true, code, why
	pg.signal()
}

func (pg *page) signal() {
	select {
	case pg.wake <- struct{}{}:
	default:
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// send queues a message for the page.
func (pg *page) send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	pg.mu.Lock()
	pg.enqueueLocked(b)
	pg.mu.Unlock()
}

// enqueueLocked queues b, or disconnects a page that fell too far behind.
// pg.mu is held.
func (pg *page) enqueueLocked(b []byte) {
	if pg.closed || pg.closing {
		return
	}
	if len(pg.out) >= backlogMessages || (len(pg.out) > 0 && pg.outBytes+len(b) > backlogBytes) {
		// The page is behind: what it missed it reads again when it
		// attaches anew. A write that waits for it is not waited for.
		pg.out, pg.outBytes, pg.closed = nil, 0, true
		pg.signal()
		go func() {
			// The close frame waits behind a write the page does not take
			// for a second at most: the page's end aborts that write.
			stop := time.AfterFunc(closeGrace, pg.cancel)
			pg.ws.Close(websocket.StatusTryAgainLater, "too slow")
			stop.Stop()
			pg.cancel()
		}()
		return
	}
	pg.out = append(pg.out, b)
	pg.outBytes += len(b)
	pg.signal()
}

// writeLoop sends the page its messages in order, each within
// pageWriteTimeout, until the page ends.
func (pg *page) writeLoop() {
	defer pg.cancel()
	for {
		pg.mu.Lock()
		for len(pg.out) == 0 && !pg.closing && !pg.closed {
			pg.mu.Unlock()
			select {
			case <-pg.wake:
			case <-pg.ctx.Done():
				return
			}
			pg.mu.Lock()
		}
		if pg.closed {
			pg.mu.Unlock()
			return
		}
		if len(pg.out) == 0 {
			code, why := pg.closeCode, pg.closeWhy
			pg.closed = true
			pg.mu.Unlock()
			pg.ws.Close(code, why)
			return
		}
		b := pg.out[0]
		pg.out[0] = nil
		pg.out = pg.out[1:]
		pg.outBytes -= len(b)
		pg.mu.Unlock()
		ctx, cancel := context.WithTimeout(pg.ctx, pageWriteTimeout)
		err := pg.ws.Write(ctx, websocket.MessageText, b)
		cancel()
		if err != nil {
			return
		}
	}
}

// sub is a page's subscription to a chat: a connection of its own to the
// chat host, which carries the chat's events and the page's commands.
type sub struct {
	pg      *page
	id      string
	m, chat string
	from    uint64
	ctx     context.Context
	cancel  context.CancelFunc
	// cmds are the command lines to write to the host.
	cmds chan []byte
	// gone: the page no longer has the subscription (detached, closed):
	// nothing more is sent of it. Guarded by pg.mu.
	gone bool

	mu sync.Mutex
	// pending are the commands written or to be written, by the core's
	// id; next numbers them; ended: the subscription ended, commands are
	// refused.
	pending map[string]pendingCmd
	next    uint64
	ended   bool
}

// pendingCmd is a command that waits for its answer.
type pendingCmd struct {
	// id is the page's id of the command.
	id string
	// audit is the record to write once it is answered; nil for none.
	audit *auditRec
}

// auditRec is a command's audit record.
type auditRec struct {
	event  string
	fields map[string]any
}

func (pg *page) attach(m *ClientMessage) {
	if m.Sub == "" || len(m.Sub) > MaxPageID {
		return
	}
	refuse := func(code, msg string) {
		pg.send(ServerMessage{T: TDetached, Sub: m.Sub, Error: &chatproto.Error{Code: code, Message: msg}})
	}
	if m.M == "" || len(m.M) > MaxPageID || !chatproto.ValidChatID(m.Chat) {
		refuse(chatproto.CodeBadRequest, "attach names a machine and a chat")
		return
	}
	pg.mu.Lock()
	if pg.closed || pg.closing {
		pg.mu.Unlock()
		return
	}
	// Attaching under an id the page has replaces that subscription.
	var old *sub
	if o := pg.subs[m.Sub]; o != nil {
		old = o
		o.gone = true
		delete(pg.subs, m.Sub)
	}
	perMachine := 0
	for _, s := range pg.subs {
		if s.m == m.M {
			perMachine++
		}
	}
	if len(pg.subs) >= MaxSubs || perMachine >= MaxSubsPerMachine {
		pg.mu.Unlock()
		if old != nil {
			old.cancel()
		}
		refuse(CodeTooMany, "the page has as many subscriptions as it may")
		return
	}
	ctx, cancel := context.WithCancel(pg.ctx)
	s := &sub{pg: pg, id: m.Sub, m: m.M, chat: m.Chat, from: m.From, ctx: ctx, cancel: cancel,
		cmds: make(chan []byte, subCommands), pending: map[string]pendingCmd{}}
	pg.subs[m.Sub] = s
	pg.mu.Unlock()
	if old != nil {
		old.cancel()
	}
	pg.p.inUseAdd(s.m, 1)
	go s.run()
}

func (pg *page) detach(id string) {
	pg.mu.Lock()
	s := pg.subs[id]
	if s != nil {
		s.gone = true
		delete(pg.subs, id)
	}
	pg.mu.Unlock()
	if s == nil {
		if id != "" && len(id) <= MaxPageID {
			pg.send(ServerMessage{T: TDetached, Sub: id, Error: &chatproto.Error{Code: CodeUnknownSub, Message: "no such subscription"}})
		}
		return
	}
	s.cancel()
}

// commandOps are the operations a page may send.
var commandOps = map[string]bool{
	chatproto.OpPrompt: true, chatproto.OpCancel: true, chatproto.OpPermission: true, chatproto.OpAnswer: true,
	chatproto.OpSetConfig: true, chatproto.OpCancelQueued: true, chatproto.OpCompact: true, chatproto.OpRename: true,
	chatproto.OpHandoff: true,
}

// ack answers a page's command.
func (pg *page) ack(id string, e *chatproto.Error) {
	pg.send(ServerMessage{T: TAck, ID: id, Error: e})
}

func (pg *page) command(m *ClientMessage) {
	if m.ID == "" || len(m.ID) > MaxPageID {
		return
	}
	if m.Cmd == nil || !commandOps[m.Cmd.Op] {
		pg.ack(m.ID, &chatproto.Error{Code: chatproto.CodeBadRequest, Message: "no command of the protocol"})
		return
	}
	cmd := *m.Cmd
	rec := auditOf(m.M, m.Chat, cmd)
	if pg.host != nil && pg.host.ReadOnly() {
		e := &chatproto.Error{Code: CodeReadOnly, Message: "read-only mode"}
		if rec == nil {
			rec = &auditRec{event: ID + "." + cmd.Op, fields: map[string]any{"plugin": ID, "machine": m.M, "chat": m.Chat}}
		}
		pg.audit(rec, e)
		pg.ack(m.ID, e)
		return
	}
	pg.mu.Lock()
	var s *sub
	for _, c := range pg.subs {
		if c.m == m.M && c.chat == m.Chat {
			s = c
			break
		}
	}
	pg.mu.Unlock()
	if s == nil {
		pg.ack(m.ID, &chatproto.Error{Code: CodeNotAttached, Message: "the page has no subscription to the chat"})
		return
	}
	if e := s.submit(m.ID, cmd, rec); e != nil {
		pg.audit(rec, e)
		pg.ack(m.ID, e)
	}
}

// auditOf is the audit record of a command that changes what an agent may
// do or where its session goes: a permission's answer, a question's (not
// what was answered), a configuration option set (the mode among them),
// a handoff; nil for the others, a prompt's text never.
func auditOf(m, chat string, cmd chatproto.Command) *auditRec {
	fields := map[string]any{"plugin": ID, "machine": m, "chat": chat}
	switch cmd.Op {
	case chatproto.OpPermission:
		fields["request"] = cmd.Request
		if cmd.Cancelled {
			fields["cancelled"] = true
		} else {
			fields["option"] = cmd.Option
		}
	case chatproto.OpAnswer:
		fields["request"] = cmd.Request
		if cmd.Cancelled {
			fields["cancelled"] = true
		} else {
			fields["questions"] = len(cmd.Answers)
		}
	case chatproto.OpSetConfig:
		fields["config"], fields["value"] = cmd.Config, cmd.Value
	case chatproto.OpHandoff:
	default:
		return nil
	}
	return &auditRec{event: ID + "." + cmd.Op, fields: fields}
}

// audit writes a command's record with how it ended (e nil: done).
func (pg *page) audit(rec *auditRec, e *chatproto.Error) {
	if rec == nil || pg.host == nil {
		return
	}
	code := ""
	if e != nil {
		code = e.Code
	}
	fields := make(map[string]any, len(rec.fields)+2)
	for k, v := range rec.fields {
		fields[k] = v
	}
	fields["status"] = statusOf(code)
	if code != "" {
		fields["error"] = code
	}
	pg.host.Audit(pg.req, rec.event, fields)
}

// submit queues a command for the host under an id of the core's; the
// error refuses it at once.
func (s *sub) submit(id string, cmd chatproto.Command, rec *auditRec) *chatproto.Error {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.ended:
		return &chatproto.Error{Code: CodeNotAttached, Message: "the subscription ended"}
	case len(s.pending) >= maxPending:
		return &chatproto.Error{Code: chatproto.CodeBusy, Message: "too many commands wait for their answer"}
	}
	s.next++
	cmd.ID = "k" + strconv.FormatUint(s.next, 10)
	line, err := chatproto.Line(cmd)
	if err != nil {
		return &chatproto.Error{Code: chatproto.CodeBadRequest, Message: "the command does not encode"}
	}
	if len(line) > chatproto.MaxLine+1 {
		return &chatproto.Error{Code: chatproto.CodeTooLarge, Message: "a command longer than the protocol takes"}
	}
	select {
	case s.cmds <- line:
	default:
		return &chatproto.Error{Code: chatproto.CodeBusy, Message: "too many commands wait to be sent"}
	}
	s.pending[cmd.ID] = pendingCmd{id: id, audit: rec}
	return nil
}

// run attaches to the chat and relays its events until the subscription
// or the connection ends.
func (s *sub) run() {
	pg := s.pg
	e := s.relay()
	s.cancel()
	s.mu.Lock()
	s.ended = true
	pending := s.pending
	s.pending = nil
	s.mu.Unlock()
	pg.mu.Lock()
	gone := s.gone
	if !gone && pg.subs[s.id] == s {
		delete(pg.subs, s.id)
	}
	pg.mu.Unlock()
	if e == nil {
		if pg.p.isReady(s.m) {
			e = &chatproto.Error{Code: CodeLost, Message: "the connection to the chat host ended"}
		} else {
			e = &chatproto.Error{Code: "offline", Message: "machine not connected"}
		}
	}
	if !gone {
		pg.send(ServerMessage{T: TDetached, Sub: s.id, Error: e})
	}
	ackErr := e
	if gone {
		ackErr = &chatproto.Error{Code: CodeNotAttached, Message: "the page detached the subscription"}
	}
	for _, c := range pending {
		pg.audit(c.audit, ackErr)
		pg.ack(c.id, ackErr)
	}
	pg.p.inUseAdd(s.m, -1)
}

// relay attaches and relays; it returns why the subscription ended, nil
// when the connection to the host ended (or the page ended it).
func (s *sub) relay() *chatproto.Error {
	pg := s.pg
	// The connection lives with the subscription; the machine's reply
	// comes within transport.ReplyTimeout, the host's hello within
	// helloTimeout, its answer within attachTimeout.
	c, err := pg.p.dial(s.ctx, s.m, pg.p.mayStart())
	if err != nil {
		if s.ctx.Err() != nil {
			return nil
		}
		return protoError(err)
	}
	defer c.Close()
	pg.p.used(s.m)
	// A reader who may not change the chat starts nothing on the machine:
	// no catch-up of what its session did in a terminal.
	readOnly := pg.host != nil && pg.host.ReadOnly()
	timer := time.AfterFunc(attachTimeout, func() { c.conn.Close() })
	res, err := c.send(s.ctx, chatproto.Request{Op: chatproto.OpAttach, Chat: s.chat, From: s.from, NoCatchUp: readOnly})
	timedOut := !timer.Stop()
	if err != nil {
		if s.ctx.Err() != nil {
			return nil
		}
		if timedOut {
			return protoError(context.DeadlineExceeded)
		}
		return protoError(err)
	}
	chat := res.Chat
	if readOnly {
		chat = redactChat(chat)
	}
	pg.mu.Lock()
	if !s.gone {
		pg.enqueueLocked(mustJSON(attachedMsg{T: TAttached, Sub: s.id, Chat: chat, First: res.First}))
	}
	pg.mu.Unlock()
	go s.write(c.conn)
	prefix := append(append([]byte(`{"t":"event","sub":`), mustJSON(s.id)...), `,"ev":`...)
	for {
		line, err := chatproto.ReadLine(c.r)
		if err != nil {
			return nil
		}
		var head eventHead
		if len(line) == 0 || line[0] != '{' || json.Unmarshal(line, &head) != nil {
			continue
		}
		if head.T == chatproto.EventAck {
			s.acked(head.ID, head.Error)
			continue
		}
		if readOnly {
			if line = redactEvent(line); line == nil {
				continue
			}
		}
		msg := make([]byte, 0, len(prefix)+len(line)+1)
		msg = append(append(append(msg, prefix...), line...), '}')
		pg.mu.Lock()
		if !s.gone {
			pg.enqueueLocked(msg)
		}
		pg.mu.Unlock()
	}
}

// stderrKey is how a member Stderr of an Error starts in JSON.
var stderrKey = []byte(`"stderr"`)

// redactChat is a chat's JSON without what only a reader who may change it
// sees (chatproto.Chat.Redacted).
func redactChat(raw json.RawMessage) json.RawMessage {
	if !bytes.Contains(raw, stderrKey) {
		return raw
	}
	var c chatproto.Chat
	if json.Unmarshal(raw, &c) != nil {
		return nil
	}
	b, err := json.Marshal(c.Redacted())
	if err != nil {
		return nil
	}
	return b
}

// redactEvent is an event's line without what only a reader who may change
// the chat sees (chatproto.Event.Redacted); nil when it cannot tell.
func redactEvent(line []byte) []byte {
	if !bytes.Contains(line, stderrKey) {
		return line
	}
	var ev chatproto.Event
	if json.Unmarshal(line, &ev) != nil {
		return nil
	}
	b, err := chatproto.Line(ev.Redacted())
	if err != nil {
		return nil
	}
	return bytes.TrimSuffix(b, []byte("\n"))
}

// attachedMsg is TAttached with the chat as the host wrote it.
type attachedMsg struct {
	T     string          `json:"t"`
	Sub   string          `json:"sub"`
	Chat  json.RawMessage `json:"chat,omitempty"`
	First uint64          `json:"first,omitempty"`
}

// write sends the subscription's commands to the host in order until it
// ends.
func (s *sub) write(conn net.Conn) {
	for {
		select {
		case <-s.ctx.Done():
			return
		case line := <-s.cmds:
			conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			_, err := conn.Write(line)
			conn.SetWriteDeadline(time.Time{})
			if err != nil {
				conn.Close()
				return
			}
		}
	}
}

// acked relays the host's answer to a command.
func (s *sub) acked(id string, e *chatproto.Error) {
	s.mu.Lock()
	c, ok := s.pending[id]
	delete(s.pending, id)
	s.mu.Unlock()
	if !ok {
		return
	}
	s.pg.audit(c.audit, e)
	s.pg.ack(c.id, e)
}
