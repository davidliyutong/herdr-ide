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
	// list calls and busy refusals (the ones in between are counted in
	// the next record).
	noisyAuditEvery = time.Minute
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
	// Keys keeps the master key: the OS keychain (New), a map in tests.
	Keys vaultstore.KeyStore
	// Path is the vault's file; "" puts it beside the settings file
	// (vault.json, vault-<instance>.json).
	Path string
	// Timeout of an approval; 0 is DefaultTimeout.
	Timeout time.Duration

	mu      sync.Mutex
	store   *vaultstore.Store
	pending map[string]*Request
	log     []Access
	// noisy are the last audit records of list calls and busy refusals,
	// by machine and result, with the calls not recorded since.
	noisy map[string]*noisyAudit
	// sessions are the pages' vault sessions by token; fails and waitUntil
	// slow down guessing the passphrase.
	sessions  map[string]*session
	fails     int
	waitUntil time.Time
	now       func() time.Time
}

type session struct {
	started, used time.Time
}

type noisyAudit struct {
	last       time.Time
	suppressed int
}

// New returns the plugin with the OS keychain.
func New() *Plugin { return &Plugin{Keys: vaultstore.OSKeyStore{}} }

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
	// Count is how many identical list calls or busy refusals in a row
	// this record stands for (1 when absent).
	Count int `json:"count,omitempty"`
}

var errUnavailable = &plugin.Error{Code: "unavailable", Message: "the vault has no file (the core keeps no settings)"}

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
	s, err := vaultstore.Open(path, p.Keys, filepath.Base(path))
	if err != nil {
		h.Logger().Printf("vault: %v", err)
		return nil, &plugin.Error{Code: "unavailable", Message: err.Error()}
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
		{Method: "POST", Path: "vars/{name}/rename", Mutating: true, Audit: "rename", Handler: p.gated(p.handleRename)},
		{Method: "POST", Path: "session", Mutating: true, Audit: "session", Handler: p.handleSession},
		{Method: "DELETE", Path: "session", Mutating: true, Audit: "session_end", Handler: p.handleEndSession},
		{Method: "POST", Path: "passphrase", Mutating: true, Audit: "passphrase", Handler: p.handlePassphrase},
		{Method: "POST", Path: "lock", Mutating: true, Audit: "lock", Handler: p.handleLock},
		{Method: "GET", Path: "requests", Handler: p.handleRequests},
		{Method: "POST", Path: "requests/{id}", Mutating: true, Audit: "answer", Handler: p.handleAnswer},
		{Method: "GET", Path: "log", Handler: p.handleLog},
	}
}

// fail answers with the store's error code.
func fail(w http.ResponseWriter, err error) {
	var pe *plugin.Error
	if errors.As(err, &pe) {
		if pe.Code == "unavailable" {
			plugin.WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": pe.Code, "message": pe.Message})
			return
		}
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
	case "vault_locked", "key_missing", "keychain_unavailable", "no_passphrase", "has_passphrase":
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
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"status": s.Status(), "variables": s.List(), "session": p.sessionOf(r)})
}

func (p *Plugin) clock() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}

// sessionOf reports whether the request carries a session that is open,
// and marks it used.
func (p *Plugin) sessionOf(r *http.Request) bool {
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
	ss.used = now
	return true
}

// gated refuses a request without an open session (401 vault_session):
// the gate before the UI's changes and reveals.
func (p *Plugin) gated(h func(*plugin.Call, http.ResponseWriter, *http.Request)) func(*plugin.Call, http.ResponseWriter, *http.Request) {
	return func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
		if !p.sessionOf(r) {
			plugin.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "vault_session", "message": "the vault's passphrase is needed (a vault session)"})
			return
		}
		h(c, w, r)
	}
}

// newSession opens a session and returns its token; the oldest goes when
// there are MaxSessions.
func (p *Plugin) newSession() string {
	b := make([]byte, 32)
	rand.Read(b)
	tok := hex.EncodeToString(b)
	now := p.clock()
	p.mu.Lock()
	defer p.mu.Unlock()
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

// endSessions ends every session (the vault was locked).
func (p *Plugin) endSessions() {
	p.mu.Lock()
	p.sessions = nil
	p.mu.Unlock()
}

// backoff is how long a passphrase must wait after wrong ones; zero when
// it may be tried now.
func (p *Plugin) backoff() time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()
	return max(0, p.waitUntil.Sub(p.clock()))
}

// tried records a passphrase's outcome: wrong ones in a row past failFree
// make the next wait twice as long, up to maxBackoff.
func (p *Plugin) tried(ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
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

// slowDown answers 429 while wrong passphrases must wait; true when it did.
func (p *Plugin) slowDown(w http.ResponseWriter) bool {
	d := p.backoff()
	if d <= 0 {
		return false
	}
	w.Header().Set("Retry-After", strconv.Itoa(int(d.Seconds())+1))
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
	if err := s.Set(r.PathValue("name"), u); err != nil {
		if errors.Is(err, vaultstore.ErrLocked) {
			changed(c.Host) // a first value may have chosen passphrase mode
		}
		fail(w, err)
		return
	}
	changed(c.Host)
	i, _ := s.Get(r.PathValue("name"))
	// What changed, never the value: who may read it without asking.
	c.Host.Audit(r, "vault.saved", map[string]any{
		"name": i.Name, "machines": i.Machines, "inject_only": i.InjectOnly, "value_changed": u.Value != nil,
	})
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
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleRename gives a variable another name ({"to": name}); its
// machines, flags and value stay. Audited with both names.
func (p *Plugin) handleRename(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	var body struct {
		To string `json:"to"`
	}
	if err := plugin.ReadJSON(r, 4096, &body); err != nil {
		fail(w, err)
		return
	}
	from := r.PathValue("name")
	if err := s.Rename(from, body.To); err != nil {
		fail(w, err)
		return
	}
	c.Host.Audit(r, "vault.renamed", map[string]any{"name": from, "to": body.To})
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
	if p.slowDown(w) {
		return
	}
	if st := s.Status(); st.Mode != vaultstore.ModePassphrase || st.Setup {
		fail(w, vaultstore.ErrNoPassphrase)
		return
	}
	err = s.Unlock(body.Passphrase)
	p.tried(err == nil)
	c.Host.Audit(r, "vault.unlocked", map[string]any{"ok": err == nil})
	if err != nil {
		fail(w, err)
		return
	}
	tok := p.newSession()
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

// handlePassphrase sets the vault's first passphrase ({passphrase}; also
// converting a keychain vault of an earlier version), or changes it
// ({old, passphrase}); either opens a session.
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
	mode := s.Status().Mode
	if change {
		err = s.ChangePassphrase(*body.Old, body.Passphrase)
		if err == nil || errors.Is(err, vaultstore.ErrPassphrase) {
			p.tried(err == nil)
		}
	} else {
		err = s.SetPassphrase(body.Passphrase)
	}
	c.Host.Audit(r, "vault.passphrase_set", map[string]any{"ok": err == nil, "change": change, "from": mode})
	if err != nil {
		fail(w, err)
		return
	}
	// Sessions of the old passphrase end with it.
	p.endSessions()
	tok := p.newSession()
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"session": tok, "idle": SessionIdle.Seconds(), "status": s.Status()})
}

func (p *Plugin) handleLock(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	s.Lock()
	p.endSessions()
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

// Answer answers a pending request; the first answer wins, later ones
// and answers after the request expired find no request. True means the
// requesters get this answer.
func (p *Plugin) Answer(id, answer string) bool {
	return p.answerRequest(id, answer) != nil
}

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
		if !p.sessionOf(r) {
			plugin.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "vault_session", "message": "the vault's passphrase is needed (a vault session)"})
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

// noisy results are list calls and busy refusals: a program can repeat
// them at will, so they are coalesced in the log, rate-limited in the
// audit log and do not make the pages reload.
func noisy(result string) bool { return result == "listed" || result == "busy" }

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
		key := rec.M + "\x00" + rec.Result
		if p.noisy == nil {
			p.noisy = map[string]*noisyAudit{}
		}
		na := p.noisy[key]
		switch {
		case na == nil:
			p.noisy[key] = &noisyAudit{last: rec.Time}
		case rec.Time.Sub(na.last) < noisyAuditEvery:
			na.suppressed++
			audit = false
		default:
			if na.suppressed > 0 {
				fields["suppressed"] = na.suppressed
			}
			na.last, na.suppressed = rec.Time, 0
		}
	}
	p.mu.Unlock()
	if audit {
		h.Audit(nil, "vault.access", fields)
	}
	if !quiet {
		changed(h)
	}
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
