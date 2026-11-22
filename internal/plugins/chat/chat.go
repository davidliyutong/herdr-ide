// Package chat is the core's side of the chat plugin: conversations with
// coding agents that a machine's chat host runs headless
// (internal/chatproto), relayed to the pages over one WebSocket per page
// (wire.go, ws.go) and through the machine side
// (internal/agent/plugin/chat), whose open action gives a stream to the
// host's socket. Its settings are in the section "chat", per machine, and
// reach each machine's host as chatproto.HostSettings (HostSettings); its
// switch is plugins.chat.enabled (plugin.Settings).
//
// The core watches a machine's chat host (watch.go) while the machine is
// connected, the plugin is on and the host is in use: it keeps the states
// of the machine's chats, sends them to every page (Broadcast, StatesData),
// tells the pages' notifications when a chat becomes blocked or done
// (machines.Manager.PublishAgent) and configures the host with the
// machine's settings. A change (a POST or DELETE route, which the core
// takes only from a writable client with a checked origin) and a page's
// subscription start the machine's host when none serves (a read-only
// core's do not); a GET route, the watch and a read-only core never do,
// and the watch lets a host go that has nothing to watch, so a machine
// whose chats nobody uses runs no host. Before a request that may start an
// agent, the core gives the host the machine's settings unless that host
// process took them already (prepare, ensureConfigured).
package chat

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/chatproto"
	"herdr-ide/internal/plugin"
)

// ID names the plugin on every side.
const ID = "chat"

// Bounds of what a route takes.
const (
	// maxBody is the longest body of POST new.
	maxBody = 64 << 10
	// maxPath is the longest directory a route takes.
	maxPath = 4096
	// maxCursor is the longest cursor of a session listing.
	maxCursor = 4096
)

// Plugin is the chat plugin.
type Plugin struct {
	// hostMu guards host, open and ready, which Start sets (tests set open
	// and ready before).
	hostMu sync.RWMutex
	host   plugin.Host
	open   opener
	ready  func() []string
	now    func() time.Time
	// linger is how long the core keeps watching a host whose chats run no
	// agent and that nothing of the core used; tick how often the watches
	// are looked at; retry the first wait after a watch failed, again the
	// wait after a watch's stream ended.
	linger, tick, retry, again time.Duration

	mu sync.Mutex
	// machines are the watches and what they read, by machine id.
	machines map[string]*watched
	// pages are the pages' WebSockets; inUse counts their subscriptions by
	// machine.
	pages map[*page]struct{}
	inUse map[string]int
	// conns counts the connections open to each machine's chat host
	// (acquire).
	conns map[string]connCount
	// on: the plugin was on at the last step.
	on   bool
	wake chan struct{}
}

// New returns the plugin.
func New() *Plugin {
	return &Plugin{
		now:      time.Now,
		linger:   2 * time.Minute,
		tick:     5 * time.Second,
		retry:    5 * time.Second,
		again:    time.Second,
		machines: map[string]*watched{},
		pages:    map[*page]struct{}{},
		inUse:    map[string]int{},
		conns:    map[string]connCount{},
		wake:     make(chan struct{}, 1),
	}
}

func (p *Plugin) ID() string { return ID }

// bind takes the core the plugin serves, when Start has not.
func (p *Plugin) bind(h plugin.Host) {
	p.hostMu.Lock()
	defer p.hostMu.Unlock()
	if p.host == nil {
		p.host = h
	}
}

func (p *Plugin) getHost() plugin.Host {
	p.hostMu.RLock()
	defer p.hostMu.RUnlock()
	return p.host
}

func (p *Plugin) opener() opener {
	p.hostMu.RLock()
	defer p.hostMu.RUnlock()
	if p.open != nil {
		return p.open
	}
	if p.host != nil {
		return openVia(p.host)
	}
	return nil
}

// Routes of the plugin:
//
//   - GET    /api/m/{id}/p/chat/agents: which agent kinds with a chat the
//     machine can start ({agents: []chatproto.AgentStatus}), from a chat
//     host that serves (not_running otherwise); refused on a read-only
//     core (read_only), as the host asks the agents' programs;
//   - POST   /api/m/{id}/p/chat/agents: the same, starting the host when
//     none serves, audited as chat.agents;
//   - GET    /api/m/{id}/p/chat/chats: its chats, closed ones included
//     ({chats: []chatproto.Chat}), from a chat host that serves
//     (not_running otherwise);
//   - POST   /api/m/{id}/p/chat/sessions?kind=&cwd=&cursor=: the sessions
//     an agent kept for a directory ({sessions, nextCursor}); a change as
//     listing them may run the agent (Codex, ACP agents), audited as
//     chat.sessions;
//   - POST   /api/m/{id}/p/chat/new: a new chat from the body {kind, cwd,
//     resume?, import?, options?{model, effort, mode}} ({chat}), audited
//     as chat.new;
//   - POST   /api/m/{id}/p/chat/close?chat=: ends a chat's agent and keeps
//     the chat ({}), audited as chat.close;
//   - DELETE /api/m/{id}/p/chat/chat?chat=: forgets a chat and its log
//     ({}), audited as chat.delete;
//   - POST   /api/m/{id}/p/chat/seen?chat=&seq=: the user saw the chat up
//     to seq, which ends its done status for every page ({}), audited as
//     chat.seen;
//   - POST   /api/m/{id}/p/chat/handoff?chat=: ends the chat's agent so
//     that its session goes on in a terminal ({}), refused while a turn
//     runs (busy), audited as chat.handoff;
//   - POST   /api/m/{id}/p/chat/trust?cwd=: trusts a directory and those
//     below it on the machine: agents started there load the project's
//     own settings ({}), audited as chat.trust;
//   - POST   /api/m/{id}/p/chat/untrust?cwd=: takes back the trust that
//     covers a directory, its own and that of the directories above it
//     ({}), audited as chat.untrust;
//   - GET    /api/p/chat/states: the chats' states of every machine as the
//     core last read them (StatesSnapshot);
//   - GET    /api/p/chat/ws: the page's WebSocket (wire.go).
//
// Errors are {error: code, message}: the chat host's codes
// (chatproto.Code*), the machine's (offline, transport, not_running,
// upgrading, no_terminal_core, start_failed), the core's too_many (more
// connections to the machine's host than maxHostConns) and timeout. A
// GET never starts the machine's chat host (not_running when none
// serves); a change does, but a read-only core's, which takes none. A
// read-only core also leaves out what only a reader who may change a chat
// sees (chatproto.Chat.Redacted), here and on the WebSocket.
func (p *Plugin) Routes() []plugin.Route {
	return []plugin.Route{
		{Method: http.MethodGet, Path: "agents", Machine: true, Handler: p.getAgents},
		{Method: http.MethodPost, Path: "agents", Machine: true, Mutating: true, Audit: "agents", Handler: p.postAgents},
		{Method: http.MethodGet, Path: "chats", Machine: true, Handler: p.getChats},
		{Method: http.MethodPost, Path: "sessions", Machine: true, Mutating: true, Audit: "sessions", Handler: p.postSessions},
		{Method: http.MethodPost, Path: "new", Machine: true, Mutating: true, Audit: "new", Handler: p.postNew},
		{Method: http.MethodPost, Path: "close", Machine: true, Mutating: true, Audit: "close", Handler: p.postClose},
		{Method: http.MethodDelete, Path: "chat", Machine: true, Mutating: true, Audit: "delete", Handler: p.deleteChat},
		{Method: http.MethodPost, Path: "seen", Machine: true, Mutating: true, Audit: "seen", Handler: p.postSeen},
		{Method: http.MethodPost, Path: "handoff", Machine: true, Mutating: true, Audit: "handoff", Handler: p.postHandoff},
		{Method: http.MethodPost, Path: "trust", Machine: true, Mutating: true, Audit: "trust", Handler: p.postTrust},
		{Method: http.MethodPost, Path: "untrust", Machine: true, Mutating: true, Audit: "untrust", Handler: p.postUntrust},
		{Method: http.MethodGet, Path: "states", Handler: p.getStates},
		{Method: http.MethodGet, Path: "ws", Handler: p.serveWS},
	}
}

// chatKinds are the ids of the agent kinds with a chat.
var chatKinds = func() []string {
	var out []string
	for _, k := range agentkinds.ChatKinds() {
		out = append(out, k.ID)
	}
	return out
}()

// sessionID is the form of an agent's session id a route takes (the chat
// host's own check).
var sessionID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`)

// validCwd tells whether s is a clean absolute path of a machine (POSIX).
func validCwd(s string) bool {
	return s != "" && len(s) <= maxPath && strings.HasPrefix(s, "/") && path.Clean(s) == s &&
		utf8.ValidString(s) && !strings.ContainsRune(s, 0)
}

// validOption tells whether s may be the value of an option of a new chat.
func validOption(s string) bool {
	if len(s) > 256 || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// begin is what each route of a machine does first: the plugin bound to
// the core, the machine's id, or the answer that it has none.
func (p *Plugin) begin(c *plugin.Call, w http.ResponseWriter) (string, bool) {
	p.bind(c.Host)
	if c.Machine == nil {
		writeError(w, plugin.ErrOffline)
		return "", false
	}
	return c.Machine.ID(), true
}

// do runs one request of machine m's chat host within timeout (Plugin.request:
// start, agent).
func (p *Plugin) do(r *http.Request, m string, timeout time.Duration, req chatproto.Request, start, agent bool) (*rawResponse, error) {
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	return p.request(ctx, m, req, start, agent)
}

// auditText is a value of an audit record: at most maxAudit bytes of s.
func auditText(s string) string {
	if len(s) <= maxAudit {
		return s
	}
	cut := maxAudit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

// maxAudit is the most bytes of a value an audit record takes from a
// request.
const maxAudit = 256

func (p *Plugin) getAgents(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	if c.Host != nil && c.Host.ReadOnly() {
		// The host asks the agents' programs: nothing a reader starts.
		p.bind(c.Host)
		writeError(w, &chatproto.Error{Code: CodeReadOnly, Message: "read-only mode"})
		return
	}
	p.agents(c, w, r, false)
}

func (p *Plugin) postAgents(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	p.agents(c, w, r, true)
}

// agents answers which kinds the machine can start; start starts its host.
func (p *Plugin) agents(c *plugin.Call, w http.ResponseWriter, r *http.Request, start bool) {
	m, ok := p.begin(c, w)
	if !ok {
		return
	}
	res, err := p.do(r, m, shortTimeout, chatproto.Request{Op: chatproto.OpAgents, Kinds: chatKinds}, start, false)
	if err != nil {
		writeError(w, err)
		return
	}
	out := make([]chatproto.AgentStatus, 0, len(res.Agents))
	for _, a := range res.Agents {
		if slices.Contains(chatKinds, a.Kind) {
			out = append(out, a)
		}
	}
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"agents": out})
}

func (p *Plugin) getChats(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	m, ok := p.begin(c, w)
	if !ok {
		return
	}
	res, err := p.do(r, m, shortTimeout, chatproto.Request{Op: chatproto.OpChats}, false, false)
	if err != nil {
		writeError(w, err)
		return
	}
	chats := res.Chats
	if chats == nil {
		chats = []chatproto.Chat{}
	}
	if c.Host != nil && c.Host.ReadOnly() {
		for i := range chats {
			chats[i] = chats[i].Redacted()
		}
	}
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"chats": chats})
}

func (p *Plugin) postSessions(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	m, ok := p.begin(c, w)
	if !ok {
		return
	}
	q := r.URL.Query()
	kind, cwd, cursor := q.Get("kind"), q.Get("cwd"), q.Get("cursor")
	if !slices.Contains(chatKinds, kind) {
		badRequest(w, "kind: an agent kind with a chat")
		return
	}
	c.AuditField("kind", kind)
	if !validCwd(cwd) {
		badRequest(w, "cwd: a clean absolute path")
		return
	}
	c.AuditField("cwd", auditText(cwd))
	if len(cursor) > maxCursor {
		badRequest(w, "cursor: too long")
		return
	}
	res, err := p.do(r, m, sessionsTimeout, chatproto.Request{Op: chatproto.OpSessions, Kind: kind, Cwd: cwd, Cursor: cursor}, true, true)
	if err != nil {
		writeError(w, err)
		return
	}
	sessions := res.Sessions
	if sessions == nil {
		sessions = []chatproto.Session{}
	}
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"sessions": sessions, "nextCursor": res.NextCursor})
}

// newBody is the body of POST new.
type newBody struct {
	Kind    string             `json:"kind"`
	Cwd     string             `json:"cwd"`
	Resume  string             `json:"resume,omitempty"`
	Import  bool               `json:"import,omitempty"`
	Options *chatproto.Options `json:"options,omitempty"`
}

func (p *Plugin) postNew(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	m, ok := p.begin(c, w)
	if !ok {
		return
	}
	var b newBody
	if err := plugin.ReadJSON(r, maxBody, &b); err != nil {
		badRequest(w, "the body: {kind, cwd, resume?, import?, options?}")
		return
	}
	if !slices.Contains(chatKinds, b.Kind) {
		badRequest(w, "kind: an agent kind with a chat")
		return
	}
	c.AuditField("kind", b.Kind)
	switch {
	case !validCwd(b.Cwd):
		badRequest(w, "cwd: a clean absolute path")
		return
	case b.Resume != "" && !sessionID.MatchString(b.Resume):
		badRequest(w, "resume: a session id")
		return
	case b.Import && b.Resume == "":
		badRequest(w, "import needs a session to resume")
		return
	}
	if o := b.Options; o != nil && (!validOption(o.Model) || !validOption(o.Effort) || (o.Mode != "" && !slices.Contains(chatproto.Modes, o.Mode))) {
		badRequest(w, "options: model, effort and a mode")
		return
	}
	c.AuditField("cwd", auditText(b.Cwd))
	if b.Resume != "" {
		c.AuditField("resume", b.Resume)
		c.AuditField("import", b.Import)
	}
	if b.Options != nil && b.Options.Mode != "" {
		c.AuditField("mode", b.Options.Mode)
	}
	res, err := p.do(r, m, shortTimeout, chatproto.Request{Op: chatproto.OpNew, Kind: b.Kind, Cwd: b.Cwd, Resume: b.Resume,
		Import: b.Import, Options: b.Options}, true, true)
	if err != nil {
		writeError(w, err)
		return
	}
	var id struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(res.Chat, &id) != nil || !chatproto.ValidChatID(id.ID) {
		writeError(w, errProtocol("the chat host's answer has no chat"))
		return
	}
	c.AuditField("chat", id.ID)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"chat": res.Chat})
}

// chatParam is the route's ?chat=, audited, or false once the answer said
// it is none.
func chatParam(c *plugin.Call, w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.URL.Query().Get("chat")
	if !chatproto.ValidChatID(id) {
		badRequest(w, "chat: a chat's id")
		return "", false
	}
	c.AuditField("chat", id)
	return id, true
}

// simple runs a request on a chat that answers nothing but OK.
func (p *Plugin) simple(c *plugin.Call, w http.ResponseWriter, r *http.Request, op string) {
	m, ok := p.begin(c, w)
	if !ok {
		return
	}
	id, ok := chatParam(c, w, r)
	if !ok {
		return
	}
	if _, err := p.do(r, m, shortTimeout, chatproto.Request{Op: op, Chat: id}, true, false); err != nil {
		writeError(w, err)
		return
	}
	plugin.WriteJSON(w, http.StatusOK, struct{}{})
}

func (p *Plugin) postClose(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	p.simple(c, w, r, chatproto.OpClose)
}

func (p *Plugin) deleteChat(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	p.simple(c, w, r, chatproto.OpDelete)
}

func (p *Plugin) postSeen(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	m, ok := p.begin(c, w)
	if !ok {
		return
	}
	id, ok := chatParam(c, w, r)
	if !ok {
		return
	}
	seq, err := strconv.ParseUint(r.URL.Query().Get("seq"), 10, 64)
	if err != nil {
		badRequest(w, "seq: a sequence number")
		return
	}
	c.AuditField("seq", seq)
	if _, err := p.do(r, m, shortTimeout, chatproto.Request{Op: chatproto.OpSeen, Chat: id, Seq: seq}, true, false); err != nil {
		writeError(w, err)
		return
	}
	plugin.WriteJSON(w, http.StatusOK, struct{}{})
}

func (p *Plugin) postHandoff(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	m, ok := p.begin(c, w)
	if !ok {
		return
	}
	id, ok := chatParam(c, w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), handoffTimeout)
	defer cancel()
	if err := p.handoff(ctx, m, id); err != nil {
		writeError(w, err)
		return
	}
	plugin.WriteJSON(w, http.StatusOK, struct{}{})
}

func (p *Plugin) postTrust(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	p.folderTrust(c, w, r, chatproto.OpTrust)
}

func (p *Plugin) postUntrust(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	p.folderTrust(c, w, r, chatproto.OpUntrust)
}

// folderTrust asks the machine's chat host to trust the directory ?cwd=,
// or to take its trust back (op), audited with the directory.
func (p *Plugin) folderTrust(c *plugin.Call, w http.ResponseWriter, r *http.Request, op string) {
	m, ok := p.begin(c, w)
	if !ok {
		return
	}
	cwd := r.URL.Query().Get("cwd")
	if !validCwd(cwd) {
		badRequest(w, "cwd: a clean absolute path")
		return
	}
	c.AuditField("cwd", auditText(cwd))
	if _, err := p.do(r, m, shortTimeout, chatproto.Request{Op: op, Cwd: cwd}, true, false); err != nil {
		writeError(w, err)
		return
	}
	plugin.WriteJSON(w, http.StatusOK, struct{}{})
}

// handoffID is the id of the one command of a handoff's connection.
const handoffID = "handoff"

// handoff attaches to a chat without its log, sends it OpHandoff and waits
// for the answer. Its attach may catch the chat up with what its session
// did meanwhile, which runs the agent: the host takes the machine's
// settings first.
func (p *Plugin) handoff(ctx context.Context, m, chat string) error {
	start := p.mayStart()
	p.prepare(ctx, m, start)
	c, err := p.dial(ctx, m, start, false)
	if err != nil {
		return err
	}
	defer c.Close()
	p.used(m)
	p.ensureConfigured(ctx, m, c)
	if _, err := c.send(ctx, chatproto.Request{Op: chatproto.OpAttach, Chat: chat, From: math.MaxUint64}); err != nil {
		return err
	}
	if err := writeLine(c.conn, chatproto.Command{Op: chatproto.OpHandoff, ID: handoffID}); err != nil {
		return transportError(ctx, err)
	}
	for {
		line, err := chatproto.ReadLine(c.r)
		if err == chatproto.ErrTooLarge {
			return errProtocol("a line longer than the protocol takes")
		}
		if err != nil {
			return transportError(ctx, err)
		}
		var head eventHead
		if json.Unmarshal(line, &head) != nil || head.T != chatproto.EventAck || head.ID != handoffID {
			continue
		}
		if head.Error != nil {
			return head.Error
		}
		return nil
	}
}

// eventHead is what the core reads of an event line it relays.
type eventHead struct {
	T     string           `json:"t"`
	ID    string           `json:"id"`
	Error *chatproto.Error `json:"error"`
}

func (p *Plugin) getStates(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	p.bind(c.Host)
	plugin.WriteJSON(w, http.StatusOK, p.Snapshot())
}
