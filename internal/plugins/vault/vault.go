// Package vault is the variable vault plugin's core side: the encrypted
// store of internal/vault behind routes for the UI (/api/p/vault/…), and
// the requests of the MCP servers on machines (agentproto.OpVault), which
// read variables a machine is allowed to, or that the user approves in the
// UI. Values reach a browser only through reveal, a writing route.
//
// One gate stands before everything that reads a value or lets one be
// read, for every caller, the core host's own programs included: a
// machine's MCP server gets a value only for a variable that lists it, or
// with the user's approval; and the UI's approvals, reveals and changes
// need a vault session, which a page gets only by giving the vault's
// passphrase (session), so a program that calls the core's API on the
// core host cannot approve its own request or read a value.
// docs/features/30-variable-vault.md has the design.
package vault

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
	vaultstore "herdr-ide/internal/vault"
)

// ID is the plugin's id.
const ID = "vault"

// Bounds of what the plugin keeps in memory.
const (
	// DefaultTimeout is how long a request waits for the user's answer;
	// none counts as deny.
	DefaultTimeout = 60 * time.Second
	// MaxLog is how many accesses the log keeps (in memory only).
	MaxLog = 500
	// MaxPending is how many requests may wait for an answer at once, and
	// MaxPendingPerMachine how many of one machine; more are refused as
	// busy, so one machine cannot crowd out the others' prompts.
	MaxPending           = 32
	MaxPendingPerMachine = 4
	// noisyAuditEvery is how often the audit log records a machine's
	// list calls and refusals of one kind (the ones in between are counted
	// in the next record, written at the latest when the minute is over).
	noisyAuditEvery = time.Minute
	// changedEvery is how often access records make the pages load the
	// vault again: at most once in a while, the last change included.
	changedEvery = time.Second
	// MaxNames is how many variables one request may name.
	MaxNames = 64
	// SessionIdle and SessionMax bound a vault session: unused for
	// SessionIdle, or SessionMax after it began, it ends.
	SessionIdle = 30 * time.Minute
	SessionMax  = 12 * time.Hour
	// MaxSessions is how many sessions may be open at once (the oldest
	// goes).
	MaxSessions = 32
	// SessionHeader carries a page's session.
	SessionHeader = "X-Vault-Session"
	// failFree is how many wrong passphrases in a row cost no wait; each
	// one after doubles the wait, up to maxBackoff.
	failFree   = 3
	maxBackoff = 5 * time.Minute
)

// Answers to a request.
const (
	AnswerOnce   = "once"
	AnswerAlways = "always"
	AnswerDeny   = "deny"
)

// Plugin is the vault plugin.
type Plugin struct {
	// Path is the vault's file; "" puts it beside the settings file
	// (vault.json, vault-<instance>.json).
	Path string
	// Timeout of an approval; 0 is DefaultTimeout.
	Timeout time.Duration

	// keyMu makes installing or dropping the key one step with the sessions
	// that go with it: an unlock and the session it opens, a lock and the
	// end of every session, a new passphrase and its session. A lock asked
	// for while a passphrase is checked waits for the check (the store's
	// lock does too), so it is never undone by it.
	keyMu sync.Mutex

	mu      sync.Mutex
	store   *vaultstore.Store
	pending map[string]*Request
	log     []Access
	// noisy are the last audit records of list calls and refusals, by
	// machine and result, with the calls not recorded since.
	noisy map[string]*noisyAudit
	// changedAt is when access records last made the pages reload, and
	// changedLater whether one more reload is due at the end of the while.
	changedAt    time.Time
	changedLater bool
	// sessions are the pages' vault sessions by token; epoch is bumped
	// when they all end (a lock, a new passphrase), so a session opened by
	// a check that crossed it is not taken. fails, waitUntil and guessing
	// slow down guessing the passphrase: one check at a time.
	sessions  map[string]*session
	epoch     uint64
	fails     int
	waitUntil time.Time
	guessing  bool
	now       func() time.Time
	// noisyEvery and changedEvery replace noisyAuditEvery and changedEvery
	// (tests).
	noisyEvery, changedEvery time.Duration
	// keyStep runs inside keyMu before a passphrase check opens a session
	// and after a new passphrase is set, before its session (tests: a lock
	// asked for there).
	keyStep func()
}

type session struct {
	started, used time.Time
}

// noisyAudit is the audit state of a machine's calls with one result: when
// it was last written, the calls since that were not, the last of them (to
// write when the while is over) and the timer that writes it, with its
// number (a timer stopped too late finds another number and does nothing).
type noisyAudit struct {
	last       time.Time
	suppressed int
	pending    map[string]any
	flush      *time.Timer
	flushSeq   int
}

// New returns the plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) ID() string { return ID }

// Request is an MCP server's request that waits for the user's answer.
type Request struct {
	ID       string    `json:"id"`
	M        string    `json:"m"`
	Tool     string    `json:"tool"`
	Names    []string  `json:"names"`
	Client   string    `json:"client,omitempty"`
	Terminal string    `json:"terminal,omitempty"`
	Cwd      string    `json:"cwd,omitempty"`
	Created  time.Time `json:"created"`
	Expires  time.Time `json:"expires"`

	// Guarded by the plugin's mu: the requesters waiting for this request
	// (identical requests share one prompt), its answer once resolved
	// (done is then closed), and whether the pages were told.
	waiters   int
	answer    string
	done      chan struct{}
	announced bool
}

// same reports whether r asks for what m asks with tool for names.
func (r *Request) same(m, tool string, names []string) bool {
	if r.M != m || r.Tool != tool || len(r.Names) != len(names) {
		return false
	}
	for _, n := range names {
		if !slices.Contains(r.Names, n) {
			return false
		}
	}
	return true
}

// Access is a record of the access log: names only, never values.
type Access struct {
	Time     time.Time `json:"time"`
	M        string    `json:"m"`
	Tool     string    `json:"tool"`
	Names    []string  `json:"names,omitempty"`
	Client   string    `json:"client,omitempty"`
	Terminal string    `json:"terminal,omitempty"`
	// Result: allowed (by the machines of the variables), approved
	// (once), approved_always, listed, or the error's code (denied,
	// busy…).
	Result string `json:"result"`
	// Count is how many identical list calls or refusals in a row this
	// record stands for (1 when absent).
	Count int `json:"count,omitempty"`
}

// openError is why the vault is not there: unavailable (the core keeps no
// settings file to keep it beside), or the store's code for a file that
// does not open (version: of another version; invalid: damaged or edited;
// failed: not readable). It is opened again at the next use, so a file
// moved away or put back is taken then.
type openError struct{ code, msg string }

func (e *openError) Error() string { return e.code + ": " + e.msg }

var errUnavailable = &openError{code: "unavailable", msg: "the vault has no file (the core keeps no settings)"}

// open returns the store, opened at the first use.
func (p *Plugin) open(h plugin.Host) (*vaultstore.Store, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.store != nil {
		return p.store, nil
	}
	path := p.Path
	if path == "" {
		if st := h.Settings(); st != nil && st.Path() != "" {
			sp := st.Path()
			path = filepath.Join(filepath.Dir(sp), strings.Replace(filepath.Base(sp), "settings", "vault", 1))
		}
	}
	if path == "" {
		return nil, errUnavailable
	}
	s, err := vaultstore.Open(path)
	if err != nil {
		h.Logger().Printf("vault: %v", err)
		return nil, &openError{code: vaultstore.Code(err), msg: err.Error()}
	}
	p.store = s
	return s, nil
}

func (p *Plugin) timeout() time.Duration {
	if p.Timeout > 0 {
		return p.Timeout
	}
	return DefaultTimeout
}

// Routes are the UI's.
func (p *Plugin) Routes() []plugin.Route {
	return []plugin.Route{
		{Method: "GET", Path: "", Handler: p.handleList},
		{Method: "PUT", Path: "vars/{name}", Mutating: true, Audit: "set", Handler: p.gated(p.handleSet)},
		{Method: "DELETE", Path: "vars/{name}", Mutating: true, Audit: "delete", Handler: p.gated(p.handleDelete)},
		{Method: "POST", Path: "vars/{name}/reveal", Mutating: true, Audit: "reveal", Handler: p.gated(p.handleReveal)},
		{Method: "POST", Path: "session", Mutating: true, Audit: "session", Handler: p.handleSession},
		{Method: "DELETE", Path: "session", Mutating: true, Audit: "session_end", Handler: p.handleEndSession},
		{Method: "POST", Path: "passphrase", Mutating: true, Audit: "passphrase", Handler: p.handlePassphrase},
		{Method: "POST", Path: "lock", Mutating: true, Audit: "lock", Handler: p.handleLock},
		{Method: "GET", Path: "requests", Handler: p.handleRequests},
		{Method: "POST", Path: "requests/{id}", Mutating: true, Audit: "answer", Handler: p.handleAnswer},
		{Method: "GET", Path: "log", Handler: p.handleLog},
	}
}

// fail answers with the store's error code; a vault that does not open is
// 503 with its reason's code.
func fail(w http.ResponseWriter, err error) {
	var oe *openError
	if errors.As(err, &oe) {
		plugin.WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": oe.code, "message": oe.msg})
		return
	}
	var pe *plugin.Error
	if errors.As(err, &pe) {
		plugin.WriteError(w, err)
		return
	}
	code := vaultstore.Code(err)
	status := http.StatusBadRequest
	switch code {
	case "not_found":
		status = http.StatusNotFound
	case "exists":
		status = http.StatusConflict
	case "vault_locked", "no_passphrase", "has_passphrase":
		status = http.StatusConflict
	case "wrong_passphrase":
		status = http.StatusForbidden
	case "failed":
		status = http.StatusInternalServerError
	}
	plugin.WriteJSON(w, status, map[string]string{"error": code, "message": err.Error()})
}

// changed tells the pages to load the vault again.
func changed(h plugin.Host) { h.Broadcast(ID, "", map[string]any{"type": "changed"}) }

func (p *Plugin) handleList(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	// Whether the page's session is open, without counting as its use: only
	// what passes the gate keeps a session from ending idle.
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"status": s.Status(), "variables": s.List(), "session": p.sessionOf(r, false)})
}

func (p *Plugin) clock() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}

// sessionOf reports whether the request carries a session that is open;
// use marks it used.
func (p *Plugin) sessionOf(r *http.Request, use bool) bool {
	tok := r.Header.Get(SessionHeader)
	if tok == "" {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	ss, ok := p.sessions[tok]
	now := p.clock()
	if !ok || now.Sub(ss.used) > SessionIdle || now.Sub(ss.started) > SessionMax {
		delete(p.sessions, tok)
		return false
	}
	if use {
		ss.used = now
	}
	return true
}

// gated refuses a request without an open session (401 vault_session):
// the gate before the UI's changes and reveals.
func (p *Plugin) gated(h func(*plugin.Call, http.ResponseWriter, *http.Request)) func(*plugin.Call, http.ResponseWriter, *http.Request) {
	return func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
		if !p.sessionOf(r, true) {
			refuseSession(c, w, r)
			return
		}
		h(c, w, r)
	}
}

// refuseSession answers 401 vault_session and audits the refusal.
func refuseSession(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	c.Host.Audit(r, "denied.vault_session", map[string]any{"route": r.Method + " " + r.URL.Path})
	plugin.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "vault_session", "message": "the vault's passphrase is needed (a vault session)"})
}

// currentEpoch is the sessions' epoch, taken before a passphrase check.
func (p *Plugin) currentEpoch() uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.epoch
}

// newSession opens a session and returns its token, unless the sessions
// ended since epoch (then ""); the oldest goes when there are MaxSessions.
func (p *Plugin) newSession(epoch uint64) string {
	b := make([]byte, 32)
	rand.Read(b)
	tok := hex.EncodeToString(b)
	now := p.clock()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.epoch != epoch {
		return ""
	}
	if p.sessions == nil {
		p.sessions = map[string]*session{}
	}
	for k, ss := range p.sessions {
		if now.Sub(ss.used) > SessionIdle || now.Sub(ss.started) > SessionMax {
			delete(p.sessions, k)
		}
	}
	if len(p.sessions) >= MaxSessions {
		oldest := ""
		for k, ss := range p.sessions {
			if oldest == "" || ss.started.Before(p.sessions[oldest].started) {
				oldest = k
			}
		}
		delete(p.sessions, oldest)
	}
	p.sessions[tok] = &session{started: now, used: now}
	return tok
}

// endSessions ends every session (the vault was locked, the passphrase
// changed) and returns the new epoch.
func (p *Plugin) endSessions() uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sessions = nil
	p.epoch++
	return p.epoch
}

// beginGuess reserves the one passphrase check that may run: false (with
// the wait, possibly zero while another check runs) when it may not now.
func (p *Plugin) beginGuess() (bool, time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if d := p.waitUntil.Sub(p.clock()); d > 0 {
		return false, d
	}
	if p.guessing {
		return false, 0
	}
	p.guessing = true
	return true, 0
}

// tried ends a check begun with beginGuess with its outcome (wrong: a
// wrong passphrase; other failures count as neither): wrong ones in a row
// past failFree make the next wait twice as long, up to maxBackoff.
func (p *Plugin) tried(ok, wrong bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.guessing = false
	if !ok && !wrong {
		return
	}
	if ok {
		p.fails, p.waitUntil = 0, time.Time{}
		return
	}
	p.fails++
	if p.fails > failFree {
		d := min(maxBackoff, time.Second<<min(p.fails-failFree-1, 16))
		p.waitUntil = p.clock().Add(d)
	}
}

// slowDown reserves a passphrase check, or answers 429: wait while wrong
// passphrases must wait, busy while another check runs; true when it
// answered.
func (p *Plugin) slowDown(w http.ResponseWriter) bool {
	ok, d := p.beginGuess()
	if ok {
		return false
	}
	w.Header().Set("Retry-After", strconv.Itoa(int(d.Seconds())+1))
	if d <= 0 {
		plugin.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "busy", "message": "another passphrase is being checked; try again in a moment"})
		return true
	}
	plugin.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "wait", "message": "too many wrong passphrases; try again later"})
	return true
}

func (p *Plugin) handleSet(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	var u vaultstore.Update
	if err := plugin.ReadJSON(r, vaultstore.MaxValue*8, &u); err != nil {
		plugin.WriteError(w, err)
		return
	}
	from := r.PathValue("name")
	if err := s.Set(from, u); err != nil {
		if errors.Is(err, vaultstore.ErrLocked) {
			changed(c.Host) // pages that took it for unlocked learn otherwise
		}
		fail(w, err)
		return
	}
	changed(c.Host)
	name := from
	if u.To != nil {
		name = *u.To
	}
	i, _ := s.Get(name)
	// What changed, never the value: who may read it without asking, and
	// the name it had when it was renamed.
	fields := map[string]any{
		"name": i.Name, "machines": i.Machines, "inject_only": i.InjectOnly, "value_changed": u.Value != nil,
	}
	if name != from {
		fields["from"] = from
	}
	c.Host.Audit(r, "vault.saved", fields)
	plugin.WriteJSON(w, http.StatusOK, i)
}

func (p *Plugin) handleDelete(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	if err := s.Delete(r.PathValue("name")); err != nil {
		fail(w, err)
		return
	}
	c.Host.Audit(r, "vault.deleted", map[string]any{"name": r.PathValue("name")})
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleReveal is the only way a value reaches a browser: a writing route,
// refused read-only and audited with the variable's name.
func (p *Plugin) handleReveal(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	v, err := s.Value(r.PathValue("name"))
	if err != nil {
		fail(w, err)
		return
	}
	c.Host.Audit(r, "vault.revealed", map[string]any{"name": r.PathValue("name")})
	plugin.WriteJSON(w, http.StatusOK, map[string]string{"value": v})
}

// handleSession opens a vault session for the passphrase ({passphrase}),
// unlocking the vault: the page's proof that the user is there. Wrong
// passphrases in a row are slowed down (429 wait).
func (p *Plugin) handleSession(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	var body struct {
		Passphrase string `json:"passphrase"`
	}
	if err := plugin.ReadJSON(r, 64<<10, &body); err != nil {
		plugin.WriteError(w, err)
		return
	}
	if st := s.Status(); st.Mode != vaultstore.ModePassphrase {
		fail(w, vaultstore.ErrNoPassphrase)
		return
	}
	if p.slowDown(w) {
		return
	}
	// The key and the session it opens come together: a lock waits for
	// both, and so ends the session too.
	p.keyMu.Lock()
	epoch := p.currentEpoch()
	if p.keyStep != nil {
		p.keyStep()
	}
	err = s.Unlock(body.Passphrase)
	p.tried(err == nil, errors.Is(err, vaultstore.ErrPassphrase))
	tok := ""
	if err == nil {
		if tok = p.newSession(epoch); tok == "" {
			// The sessions ended while the check ran, which keyMu leaves
			// to a lock or a new passphrase after it.
			err = vaultstore.ErrLocked
		}
	}
	p.keyMu.Unlock()
	c.Host.Audit(r, "vault.unlocked", map[string]any{"ok": err == nil})
	if err != nil {
		fail(w, err)
		return
	}
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"session": tok, "idle": SessionIdle.Seconds(), "status": s.Status()})
}

func (p *Plugin) handleEndSession(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	if tok := r.Header.Get(SessionHeader); tok != "" {
		p.mu.Lock()
		delete(p.sessions, tok)
		p.mu.Unlock()
	}
	plugin.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handlePassphrase sets a new vault's passphrase ({passphrase}), or
// changes it ({old, passphrase}); either opens a session. The first
// passphrase needs no session: the vault has no values yet, and when it
// was set shows in the panel.
func (p *Plugin) handlePassphrase(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	var body struct {
		Old        *string `json:"old"`
		Passphrase string  `json:"passphrase"`
	}
	if err := plugin.ReadJSON(r, 64<<10, &body); err != nil {
		plugin.WriteError(w, err)
		return
	}
	change := body.Old != nil
	if change && p.slowDown(w) {
		return
	}
	// The new key, the end of the old passphrase's sessions and the new
	// session come together: a lock waits for them, and so ends it too.
	p.keyMu.Lock()
	if change {
		err = s.ChangePassphrase(*body.Old, body.Passphrase)
		p.tried(err == nil, errors.Is(err, vaultstore.ErrPassphrase))
	} else {
		err = s.SetPassphrase(body.Passphrase)
	}
	tok := ""
	if err == nil {
		if p.keyStep != nil {
			p.keyStep()
		}
		tok = p.newSession(p.endSessions())
	}
	p.keyMu.Unlock()
	c.Host.Audit(r, "vault.passphrase_set", map[string]any{"ok": err == nil, "change": change})
	if err != nil {
		fail(w, err)
		return
	}
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"session": tok, "idle": SessionIdle.Seconds(), "status": s.Status()})
}

func (p *Plugin) handleLock(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	// After a check that runs, never between its key and its session.
	p.keyMu.Lock()
	s.Lock()
	p.endSessions()
	p.keyMu.Unlock()
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, s.Status())
}

// Pending returns the requests that wait for an answer.
func (p *Plugin) Pending() []*Request {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]*Request, 0, len(p.pending))
	for _, r := range p.pending {
		out = append(out, r)
	}
	slices.SortFunc(out, func(a, b *Request) int { return a.Created.Compare(b.Created) })
	return out
}

func (p *Plugin) handleRequests(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"requests": p.Pending()})
}

// answerRequest answers a pending request and returns it; the first answer
// wins, later ones and answers after the request expired find none (nil),
// so a request returned is one whose requesters get this answer.
func (p *Plugin) answerRequest(id, answer string) *Request {
	p.mu.Lock()
	defer p.mu.Unlock()
	req, ok := p.pending[id]
	if !ok || !p.resolve(req, answer) {
		return nil
	}
	return req
}

// resolve gives req its answer unless it has one; called with p.mu held.
func (p *Plugin) resolve(req *Request, answer string) bool {
	if req.answer != "" {
		return false
	}
	req.answer = answer
	delete(p.pending, req.ID)
	close(req.done)
	return true
}

func (p *Plugin) handleAnswer(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Answer string `json:"answer"`
	}
	if err := plugin.ReadJSON(r, 4<<10, &body); err != nil {
		plugin.WriteError(w, err)
		return
	}
	switch body.Answer {
	case AnswerOnce, AnswerAlways:
		// Letting a value out is the user's, behind the gate; denying
		// needs no proof.
		if !p.sessionOf(r, true) {
			refuseSession(c, w, r)
			return
		}
	case AnswerDeny:
	default:
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "answer is once, always or deny"})
		return
	}
	req := p.answerRequest(r.PathValue("id"), body.Answer)
	if req == nil {
		plugin.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "no such request (answered or expired)"})
		return
	}
	c.Host.Audit(r, "vault.answered", map[string]any{
		"id": req.ID, "machine": req.M, "tool": req.Tool, "names": req.Names, "answer": body.Answer,
	})
	plugin.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// Log returns the access log, newest first.
func (p *Plugin) Log() []Access {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := append([]Access{}, p.log...)
	slices.Reverse(out)
	return out
}

func (p *Plugin) handleLog(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"log": p.Log()})
}

// AgentOps: the MCP servers' requests.
func (p *Plugin) AgentOps() []agentproto.Op { return []agentproto.Op{agentproto.OpVault} }

// ServeAgent answers one MCP server request relayed by mc's agent.
func (p *Plugin) ServeAgent(h plugin.Host, mc *machines.Machine, conn net.Conn, _ agentproto.Header) {
	defer conn.Close()
	if err := agentproto.WriteLine(conn, agentproto.Reply{OK: true}); err != nil {
		return
	}
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	var req agentproto.VaultRequest
	if err := agentproto.ReadLine(conn, &req); err != nil {
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	// The MCP server going away (its stream closed) ends a wait for an
	// answer: nothing writes to the stream before the response.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		var b [1]byte
		conn.Read(b[:])
		cancel()
	}()
	resp := p.Handle(ctx, h, mc.ID(), req)
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	agentproto.WriteLine(conn, resp)
}

func failure(code, msg string) agentproto.VaultResponse {
	return agentproto.VaultResponse{Code: code, Error: msg}
}

// Handle answers req from machine m: the list, or the values of
// variables m is allowed to read or the user approves.
func (p *Plugin) Handle(ctx context.Context, h plugin.Host, m string, req agentproto.VaultRequest) agentproto.VaultResponse {
	// What the requester sent is recorded within bounds until checked.
	var names []string
	for i, n := range req.Names {
		if i == MaxNames {
			break
		}
		names = append(names, clip(n, vaultstore.MaxName))
	}
	rec := Access{Time: time.Now().UTC(), M: m, Tool: clip(req.Tool, 16), Names: names, Client: clip(req.Client, 64), Terminal: clip(req.Terminal, 64)}
	resp := p.handle(ctx, h, m, req, &rec)
	if resp.OK && rec.Result == "" {
		rec.Result = "allowed"
	} else if !resp.OK {
		rec.Result = resp.Code
	}
	p.record(h, rec)
	return resp
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// noisy results are list calls and refusals (busy, not_found,
// vault_locked, inject_only, bad_request…): a program can repeat them at
// will, so they are coalesced in the log, rate-limited in the audit log
// and do not make the pages reload. What lets a value out (allowed,
// approved, approved_always) or is the user's answer (denied) is recorded
// every time.
func noisy(result string) bool {
	switch result {
	case "allowed", "approved", "approved_always", "denied":
		return false
	}
	return true
}

func (p *Plugin) noisyAuditEvery() time.Duration {
	if p.noisyEvery > 0 {
		return p.noisyEvery
	}
	return noisyAuditEvery
}

func (p *Plugin) record(h plugin.Host, rec Access) {
	quiet := noisy(rec.Result)
	fields := map[string]any{
		"machine": rec.M, "tool": rec.Tool, "names": rec.Names, "client": rec.Client, "terminal": rec.Terminal, "result": rec.Result,
	}
	audit := true
	p.mu.Lock()
	if n := len(p.log); quiet && n > 0 && sameCall(p.log[n-1], rec) {
		last := &p.log[n-1]
		last.Time = rec.Time
		last.Count = max(last.Count, 1) + 1
	} else {
		p.log = append(p.log, rec)
		if len(p.log) > MaxLog {
			p.log = slices.Delete(p.log, 0, len(p.log)-MaxLog)
		}
	}
	if quiet {
		audit = p.auditNoisy(h, rec.M+"\x00"+rec.Result, rec.Time, fields)
	}
	p.mu.Unlock()
	if audit {
		h.Audit(nil, "vault.access", fields)
	}
	if !quiet {
		p.changedThrottled(h)
	}
}

// auditNoisy decides whether a noisy record of key (machine and result) is
// written now: the first one, and then one a while (noisyAuditEvery), with
// the number not written since (suppressed). Those in between wait: the
// last of them is written with that number when the while is over, so a
// burst that ends is recorded too. Called with p.mu held.
func (p *Plugin) auditNoisy(h plugin.Host, key string, at time.Time, fields map[string]any) bool {
	if p.noisy == nil {
		p.noisy = map[string]*noisyAudit{}
	}
	every := p.noisyAuditEvery()
	na := p.noisy[key]
	switch {
	case na == nil:
		p.noisy[key] = &noisyAudit{last: at}
		return true
	case at.Sub(na.last) < every:
		na.suppressed++
		na.pending = fields
		if na.flush == nil {
			na.flushSeq++
			seq := na.flushSeq
			na.flush = time.AfterFunc(every-at.Sub(na.last), func() { p.flushNoisy(h, key, seq) })
		}
		return false
	}
	if na.flush != nil {
		na.flush.Stop()
		na.flush = nil
		na.flushSeq++
	}
	if na.suppressed > 0 {
		fields["suppressed"] = na.suppressed
	}
	na.last, na.suppressed, na.pending = at, 0, nil
	return true
}

// flushNoisy writes the last noisy record of key not written, with the
// number of those before it that were not either; seq is the timer's.
func (p *Plugin) flushNoisy(h plugin.Host, key string, seq int) {
	p.mu.Lock()
	na := p.noisy[key]
	if na == nil || na.flushSeq != seq {
		p.mu.Unlock()
		return
	}
	na.flush = nil
	if na.pending == nil {
		p.mu.Unlock()
		return
	}
	fields := na.pending
	if na.suppressed > 1 {
		fields["suppressed"] = na.suppressed - 1
	}
	na.last, na.suppressed, na.pending = time.Now().UTC(), 0, nil
	p.mu.Unlock()
	h.Audit(nil, "vault.access", fields)
}

// changedThrottled tells the pages to load the vault again after an access
// record, at most once a while (changedEvery): a record within it is told
// at its end, with the others of that while.
func (p *Plugin) changedThrottled(h plugin.Host) {
	every := changedEvery
	if p.changedEvery > 0 {
		every = p.changedEvery
	}
	now := time.Now()
	p.mu.Lock()
	if wait := every - now.Sub(p.changedAt); wait > 0 {
		later := !p.changedLater
		p.changedLater = true
		p.mu.Unlock()
		if later {
			time.AfterFunc(wait, func() {
				p.mu.Lock()
				p.changedAt, p.changedLater = time.Now(), false
				p.mu.Unlock()
				changed(h)
			})
		}
		return
	}
	p.changedAt = now
	p.mu.Unlock()
	changed(h)
}

// sameCall reports whether b repeats a's call (machine, tool, names,
// client, terminal, result).
func sameCall(a, b Access) bool {
	return a.M == b.M && a.Tool == b.Tool && a.Client == b.Client && a.Terminal == b.Terminal &&
		a.Result == b.Result && slices.Equal(a.Names, b.Names)
}

func (p *Plugin) handle(ctx context.Context, h plugin.Host, m string, req agentproto.VaultRequest, rec *Access) agentproto.VaultResponse {
	s, err := p.open(h)
	if err != nil {
		return failure("unavailable", err.Error())
	}
	if req.Tool == agentproto.VaultList {
		rec.Result = "listed"
		vars := []agentproto.VaultVariable{}
		for _, i := range s.List() {
			vars = append(vars, agentproto.VaultVariable{Name: i.Name, Description: i.Description, InjectOnly: i.InjectOnly, Approval: !i.Allows(m)})
		}
		return agentproto.VaultResponse{OK: true, Variables: vars}
	}
	switch req.Tool {
	case agentproto.VaultGet:
		if len(req.Names) != 1 {
			return failure("bad_request", "get takes one name")
		}
	case agentproto.VaultEnv:
		if len(req.Names) == 0 || len(req.Names) > MaxNames {
			return failure("bad_request", "env takes 1 to 64 names")
		}
	default:
		return failure("bad_request", "unknown tool")
	}
	names := []string{}
	for _, n := range req.Names {
		if !slices.Contains(names, n) {
			names = append(names, n)
		}
	}
	req.Names, rec.Names = names, names
	var ask []string
	for _, n := range names {
		i, ok := s.Get(n)
		if !ok {
			return failure("not_found", "no variable "+n)
		}
		if req.Tool == agentproto.VaultGet && i.InjectOnly {
			return failure("inject_only", n+" can only be injected into a command (run_with_env)")
		}
		if !i.Allows(m) {
			ask = append(ask, n)
		}
	}
	if s.Status().Locked {
		return failure("vault_locked", "the vault is locked; unlock it in the UI")
	}
	if len(ask) > 0 {
		answer := p.ask(ctx, h, m, req, ask)
		switch answer {
		case AnswerOnce:
			rec.Result = "approved"
		case AnswerAlways:
			rec.Result = "approved_always"
			for _, n := range ask {
				if err := s.Allow(n, m); err != nil {
					h.Logger().Printf("vault: allowing %s on %s: %v", n, m, err)
				}
			}
		case "timeout":
			return failure("denied", "nobody approved the request within the time allowed")
		case "busy":
			return failure("busy", "too many requests of this machine wait for an answer; answer them or try again later")
		default:
			return failure("denied", "the user denied the request")
		}
	}
	values := map[string]string{}
	for _, n := range names {
		v, err := s.Value(n)
		if err != nil {
			return failure(vaultstore.Code(err), err.Error())
		}
		values[n] = v
	}
	return agentproto.VaultResponse{OK: true, Values: values}
}

// ask shows the request on every page and waits for the first answer, the
// timeout or the requester's going away. A request identical to one
// waiting (machine, tool, names) waits for that one's answer; more than
// MaxPendingPerMachine of a machine, or MaxPending in all, are "busy".
// Whichever of the answer, the timeout and the last requester's leaving
// comes first decides, under the lock, so a page's answer that was taken
// is the answer the requesters get.
func (p *Plugin) ask(ctx context.Context, h plugin.Host, m string, req agentproto.VaultRequest, names []string) string {
	p.mu.Lock()
	var r *Request
	for _, x := range p.pending {
		if x.same(m, req.Tool, names) {
			r = x
			break
		}
	}
	fresh := r == nil
	if fresh {
		mine := 0
		for _, x := range p.pending {
			if x.M == m {
				mine++
			}
		}
		if mine >= MaxPendingPerMachine || len(p.pending) >= MaxPending {
			p.mu.Unlock()
			return "busy"
		}
		idb := make([]byte, 12)
		rand.Read(idb)
		now := time.Now().UTC()
		r = &Request{
			ID: hex.EncodeToString(idb), M: m, Tool: req.Tool, Names: names,
			Client: clip(req.Client, 64), Terminal: clip(req.Terminal, 64), Cwd: clip(req.Cwd, 1024),
			Created: now, Expires: now.Add(p.timeout()), done: make(chan struct{}),
		}
		if p.pending == nil {
			p.pending = map[string]*Request{}
		}
		p.pending[r.ID] = r
	}
	r.waiters++
	p.mu.Unlock()
	if fresh {
		h.Broadcast(ID, m, map[string]any{"type": "request", "request": r})
	}
	t := time.NewTimer(time.Until(r.Expires))
	defer t.Stop()
	gone := false
	select {
	case <-r.done:
	case <-t.C:
		p.mu.Lock()
		p.resolve(r, "timeout")
		p.mu.Unlock()
	case <-ctx.Done():
		gone = true
		p.mu.Lock()
		r.waiters--
		if r.waiters == 0 {
			p.resolve(r, AnswerDeny)
		}
		p.mu.Unlock()
	}
	p.mu.Lock()
	answer := r.answer
	announce := answer != "" && !r.announced
	if announce {
		r.announced = true
	}
	p.mu.Unlock()
	if announce {
		h.Broadcast(ID, m, map[string]any{"type": "resolved", "id": r.ID, "answer": answer})
	}
	if gone && answer == "" {
		// Others still wait for the request; this requester left.
		return AnswerDeny
	}
	return answer
}

// ForgetMachine removes a removed machine from the variables' allowed
// machines (plugin.MachineForgetter): an id that comes back asks again.
func (p *Plugin) ForgetMachine(h plugin.Host, id string) {
	s, err := p.open(h)
	if err != nil {
		return
	}
	names, err := s.ForgetMachine(id)
	if err != nil {
		h.Logger().Printf("vault: forgetting machine %s: %v", id, err)
		return
	}
	if len(names) > 0 {
		h.Audit(nil, "vault.machine_forgotten", map[string]any{"machine": id, "names": names})
		changed(h)
	}
}
