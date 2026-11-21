// Package vault is the variable vault plugin's core side: the encrypted
// store of internal/vault behind routes for the UI (/api/p/vault/…), and
// the requests of the MCP servers on machines (agentproto.OpVault), which
// read variables a machine is allowed to, or that the user approves in the
// UI. Values reach a browser only through reveal, a writing route.
//
// One gate stands before everything that reads a value or lets one be
// read, for every caller, the core host's own programs included: a
// machine's MCP server gets a value only for a variable that lists it, or
// with the user's approval (or for an app the user exempted on it with the
// passphrase); and the UI's approvals, reveals and changes need a vault
// session, which a page gets only by giving the vault's passphrase or an
// authenticator's proof (proof.go), so a program that calls the core's API
// on the core host cannot approve its own request or read a value. The
// core holds the key for a while after the passphrase (autolock.go).
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
	// DefaultTimeout is how long a request waits for the user's answer by
	// default (vault.approvalTimeout); none counts as deny.
	DefaultTimeout = 60 * time.Second
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
	// SessionIdle and SessionMax bound a vault session by default
	// (vault.sessionIdle, vault.sessionMax): unused for SessionIdle, or
	// SessionMax after it began, it ends.
	SessionIdle = 30 * time.Minute
	SessionMax  = 12 * time.Hour
	// lockCheckEvery is how often the auto-lock looks at the setting while
	// the vault is unlocked, so a change of it counts within a minute.
	lockCheckEvery = time.Minute
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
	// What else ends a wait (ask): nobody answered in time, the requester
	// went away, too many requests wait.
	answerTimeout = "timeout"
	answerGone    = "gone"
	answerBusy    = "busy"
)

// Plugin is the vault plugin.
type Plugin struct {
	// Path is the vault's file; "" puts it beside the settings file
	// (vault.json, vault-<instance>.json).
	Path string
	// Timeout of an approval; 0 takes the setting (DefaultTimeout).
	Timeout time.Duration

	// fileWork is held while an export file's key is derived (transfer.go).
	fileWork sync.Mutex

	// keyMu makes installing or dropping the key one step with the sessions
	// that go with it: an unlock and the session it opens, a lock and the
	// end of every session, a new passphrase and its session. A lock asked
	// for while a passphrase is checked waits for the check (the store's
	// lock does too), so it is never undone by it.
	keyMu sync.Mutex

	mu      sync.Mutex
	store   *vaultstore.Store
	pending map[string]*Request
	// proofs are the nonces waiting for an authenticator's proof
	// (proof.go); they end with the sessions.
	proofs   map[string]*pendingProof
	proofSeq uint64
	// alog is the access log (accesslog.go), opened at its first use.
	alog *accessLog
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
	// mono replaces the monotonic clock (tests): how long the process has
	// run, not counting the computer's sleep.
	mono func() time.Duration
	// noisyEvery and changedEvery replace noisyAuditEvery and changedEvery
	// (tests).
	noisyEvery, changedEvery time.Duration
	// keyStep runs inside keyMu before a passphrase check opens a session
	// and after a new passphrase is set, before its session (tests: a lock
	// asked for there).
	keyStep func()
	// lastUse is the vault's last use (touch), lockTimer the auto-lock's
	// timer while the vault is unlocked; lockAfter and lockCheck replace
	// the setting and lockCheckEvery (tests).
	lastUse              stamp
	lockTimer            *time.Timer
	lockAfter, lockCheck time.Duration
	// lockFor replaces vault.autoLock until the vault locks, once a page
	// set the countdown (lockForSet; 0: never).
	lockFor    time.Duration
	lockForSet bool
	// lockCap is vault.autoLock's time when the vault was unlocked
	// (lockCapSet; 0: never): the setting, which programs change without
	// the gate, shortens the current unlock's time but does not lengthen
	// it.
	lockCap    time.Duration
	lockCapSet bool
	// keyAt is when the passphrase was last given while the core holds the
	// key, which it holds for vault.passphraseHours from then, at most for
	// keyCap (the setting's time then: keyCapSet); keyHold replaces the
	// setting (tests). See autolock.go.
	keyAt     stamp
	keyCap    time.Duration
	keyCapSet bool
	keyHold   time.Duration
}

type session struct {
	started, used stamp
	// proof: an authenticator's proof opened it, not the passphrase
	// (proof.go); such a session does not change what guards the vault.
	proof bool
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
	ID       string   `json:"id"`
	M        string   `json:"m"`
	Tool     string   `json:"tool"`
	Names    []string `json:"names"`
	Client   string   `json:"client,omitempty"`
	Terminal string   `json:"terminal,omitempty"`
	Cwd      string   `json:"cwd,omitempty"`
	// Process is the process that asked and its parents, as the machine's
	// agent saw them.
	Process []agentproto.VaultProcess `json:"process,omitempty"`
	Created time.Time                 `json:"created"`
	Expires time.Time                 `json:"expires"`

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

// openError is why the vault is not there: unavailable (the core keeps no
// settings file to keep it beside), or the store's code for a file that
// does not open (version: of another version; invalid: damaged or edited;
// failed: not readable). It is opened again at the next use, so a file
// moved away or put back is taken then.
type openError struct{ code, msg string }

func (e *openError) Error() string { return e.code + ": " + e.msg }

var errUnavailable = &openError{code: "unavailable", msg: "the vault has no file (the core keeps no settings)"}

// vaultPath is the vault's file: Path, or beside the settings file; ""
// when the core keeps none.
func (p *Plugin) vaultPath(h plugin.Host) string {
	if p.Path != "" {
		return p.Path
	}
	if st := h.Settings(); st != nil && st.Path() != "" {
		sp := st.Path()
		return filepath.Join(filepath.Dir(sp), strings.Replace(filepath.Base(sp), "settings", "vault", 1))
	}
	return ""
}

// accessLog returns the access log, beside the vault's file (in memory
// only without one).
func (p *Plugin) accessLog(h plugin.Host) *accessLog {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.alog == nil {
		p.alog = newAccessLog(accessLogPath(p.vaultPath(h)), h.Logger())
	}
	return p.alog
}

// open returns the store, opened at the first use, having forgotten its
// key once the key's hold is over (expire): every route and request starts
// here, so none uses a key the core should no longer hold.
func (p *Plugin) open(h plugin.Host) (*vaultstore.Store, error) {
	s, err := p.openStore(h)
	if err == nil {
		p.expire(h, s)
	}
	return s, err
}

func (p *Plugin) openStore(h plugin.Host) (*vaultstore.Store, error) {
	path := p.vaultPath(h)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.store != nil {
		return p.store, nil
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

// Routes are the UI's.
func (p *Plugin) Routes() []plugin.Route {
	return []plugin.Route{
		{Method: "GET", Path: "", Handler: p.handleList},
		{Method: "PUT", Path: "vars/{name}", Mutating: true, Audit: "set", Handler: p.gated(p.handleSet)},
		{Method: "DELETE", Path: "vars/{name}", Mutating: true, Audit: "delete", Handler: p.gated(p.handleDelete)},
		{Method: "POST", Path: "vars/{name}/reveal", Mutating: true, Audit: "reveal", Handler: p.gated(p.handleReveal)},
		{Method: "POST", Path: "export", Mutating: true, Audit: "export", Handler: p.gatedPassphrase(p.handleExport)},
		{Method: "POST", Path: "import/preview", Mutating: true, Audit: "import_preview", Handler: p.gatedPassphrase(p.handleImportPreview)},
		{Method: "POST", Path: "import", Mutating: true, Audit: "import", Handler: p.gatedPassphrase(p.handleImport)},
		{Method: "POST", Path: "session", Mutating: true, Audit: "session", Handler: p.handleSession},
		{Method: "DELETE", Path: "session", Mutating: true, Audit: "session_end", Handler: p.handleEndSession},
		{Method: "POST", Path: "passphrase", Mutating: true, Audit: "passphrase", Handler: p.handlePassphrase},
		{Method: "POST", Path: "lock", Mutating: true, Audit: "lock", Handler: p.handleLock},
		{Method: "POST", Path: "autolock", Mutating: true, Audit: "autolock", Handler: p.gatedPassphrase(p.handleAutoLock)},
		{Method: "POST", Path: "proof", Mutating: true, Audit: "proof", Handler: p.handleProof},
		{Method: "GET", Path: "proof/{nonce}", Handler: p.handleProofPurpose},
		{Method: "POST", Path: "authenticators", Mutating: true, Audit: "authenticator_add", Handler: p.gatedPassphrase(p.handleAddAuthenticator)},
		{Method: "DELETE", Path: "authenticators/{id}", Mutating: true, Audit: "authenticator_delete", Handler: p.gatedPassphrase(p.handleDeleteAuthenticator)},
		{Method: "POST", Path: "guard", Mutating: true, Audit: "guard", Handler: p.gatedPassphrase(p.handleGuard)},
		{Method: "POST", Path: "exempt", Mutating: true, Audit: "exempt_add", Handler: p.gatedPassphrase(p.handleAddExempt)},
		{Method: "DELETE", Path: "exempt/{id}", Mutating: true, Audit: "exempt_delete", Handler: p.gatedPassphrase(p.handleDeleteExempt)},
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
	case "too_large":
		status = http.StatusRequestEntityTooLarge
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
	idle, _ := p.sessionLimits(c.Host)
	st := s.Status()
	open, byProof := p.sessionKind(c.Host, r, false)
	autoLock := p.autoLockState(c.Host, s)
	if !open {
		// When the vault was last used and when the key goes are a
		// session's to see.
		delete(autoLock, "lockAt")
		delete(autoLock, "keyUntil")
	}
	plugin.WriteJSON(w, http.StatusOK, map[string]any{
		"status": st, "variables": s.List(), "session": open, "sessionProof": open && byProof, "idle": idle.Seconds(),
		"autoLock": autoLock,
		// What guards the vault beside the passphrase (proof.go): all of it
		// with a session, without one what offering biometrics needs; none
		// while the core does not hold the key.
		"guard": p.guardState(c, s, open),
	})
}

func (p *Plugin) clock() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}

// A stamp is a moment by two clocks: the wall clock (without Go's
// monotonic reading), which goes on while the computer sleeps, and the
// monotonic clock, which macOS and Linux stop while it sleeps but which is
// never set back. The vault's time limits (the key's hold, the automatic
// lock, sessions, nonces) count by the one that says longer.
type stamp struct {
	wall time.Time
	mono time.Duration
}

// monoStart is the monotonic clock's origin.
var monoStart = time.Now()

// at is now as a stamp.
func (p *Plugin) at() stamp {
	mono := time.Since(monoStart)
	if p.mono != nil {
		mono = p.mono()
	}
	return stamp{wall: p.clock().Round(0), mono: mono}
}

func (s stamp) zero() bool { return s.wall.IsZero() }

// since is how long before now s was, by the clock that says longer: the
// computer's sleep counts (the wall clock), and a wall clock set back does
// not lengthen anything (the monotonic clock).
func (s stamp) since(now stamp) time.Duration {
	return max(now.wall.Sub(s.wall), now.mono-s.mono)
}

// sessionOf reports whether the request carries a session that is open;
// use marks it used.
func (p *Plugin) sessionOf(h plugin.Host, r *http.Request, use bool) bool {
	open, _ := p.sessionKind(h, r, use)
	return open
}

// sessionKind is sessionOf, and whether a proof opened the session
// rather than the passphrase.
func (p *Plugin) sessionKind(h plugin.Host, r *http.Request, use bool) (open, byProof bool) {
	tok := r.Header.Get(SessionHeader)
	if tok == "" {
		return false, false
	}
	idle, most := p.sessionLimits(h)
	p.mu.Lock()
	ss, ok := p.sessions[tok]
	now := p.at()
	if !ok || ss.used.since(now) > idle || ss.started.since(now) > most {
		delete(p.sessions, tok)
		p.mu.Unlock()
		return false, false
	}
	if use {
		ss.used = now
	}
	byProof = ss.proof
	p.mu.Unlock()
	if use {
		p.touch(h)
	}
	return true, byProof
}

// gated refuses a request without an open session (401 vault_session):
// the gate before the UI's changes and reveals. The key's hold is looked at
// first (open), so a session its end ended does not pass, also on the first
// request after the computer slept past it.
func (p *Plugin) gated(h func(*plugin.Call, http.ResponseWriter, *http.Request)) func(*plugin.Call, http.ResponseWriter, *http.Request) {
	return func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
		p.open(c.Host)
		if !p.sessionOf(c.Host, r, true) {
			refuseSession(c, w, r)
			return
		}
		h(c, w, r)
	}
}

// gatedPassphrase is gated for what guards the vault itself (its
// authenticators, the rule to verify each Allow, the automatic lock) and
// for values in bulk (imports, exports): the session must be one the
// passphrase opened (401 vault_passphrase for one a proof opened).
func (p *Plugin) gatedPassphrase(h func(*plugin.Call, http.ResponseWriter, *http.Request)) func(*plugin.Call, http.ResponseWriter, *http.Request) {
	return func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
		p.open(c.Host) // the key's hold first, as gated
		if open, byProof := p.sessionKind(c.Host, r, true); !open || byProof {
			refusePassphraseSession(c, w, r, open)
			return
		}
		h(c, w, r)
	}
}

// refusePassphraseSession refuses a request that needs a session the
// passphrase opened: without any session as refuseSession does.
func refusePassphraseSession(c *plugin.Call, w http.ResponseWriter, r *http.Request, open bool) {
	if !open {
		refuseSession(c, w, r)
		return
	}
	c.Host.Audit(r, "denied.vault_passphrase", map[string]any{"route": r.Method + " " + r.URL.Path})
	plugin.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "vault_passphrase", "message": "this needs a session opened with the vault's passphrase"})
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
// byProof marks a session an authenticator's proof opened.
func (p *Plugin) newSession(h plugin.Host, epoch uint64, byProof bool) string {
	b := make([]byte, 32)
	rand.Read(b)
	tok := hex.EncodeToString(b)
	now := p.at()
	idle, most := p.sessionLimits(h)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.epoch != epoch {
		return ""
	}
	if p.sessions == nil {
		p.sessions = map[string]*session{}
	}
	for k, ss := range p.sessions {
		if ss.used.since(now) > idle || ss.started.since(now) > most {
			delete(p.sessions, k)
		}
	}
	if len(p.sessions) >= MaxSessions {
		oldest := ""
		for k, ss := range p.sessions {
			if oldest == "" || ss.started.since(now) > p.sessions[oldest].started.since(now) {
				oldest = k
			}
		}
		delete(p.sessions, oldest)
	}
	p.sessions[tok] = &session{started: now, used: now, proof: byProof}
	return tok
}

// endSessions ends every session (the vault was locked, the passphrase
// changed) and returns the new epoch.
func (p *Plugin) endSessions() uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sessions = nil
	p.proofs = nil
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
	var body struct {
		vaultstore.Update
		fresh
	}
	if err := plugin.ReadJSON(r, vaultstore.MaxValue*8, &body); err != nil {
		plugin.WriteError(w, err)
		return
	}
	u := body.Update
	from := r.PathValue("name")
	// Where every Allow is verified, letting more machines read a variable
	// without asking, or the model see one that was only injected, is an
	// Allow: it needs the user's word for it, as allowing a request does.
	if cur, exists := s.Get(from); exists && widens(cur, u) && strict(s) {
		if given, ok := p.verified(c, w, r, s, body.fresh, purpose{For: ForChange, Request: from}); !given {
			needFresh(c, w, r)
			return
		} else if !ok {
			return
		}
	}
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

// widens reports whether a change lets a variable's value go where it did
// not: to a machine that had to ask, or to the model's reach when it was
// inject-only.
func widens(cur vaultstore.Info, u vaultstore.Update) bool {
	if u.InjectOnly != nil && cur.InjectOnly && !*u.InjectOnly {
		return true
	}
	if u.Machines != nil {
		for _, m := range *u.Machines {
			if !cur.Allows(m) {
				return true
			}
		}
	}
	return false
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
	name := r.PathValue("name")
	// Where every Allow is verified a value shown to the page is one too:
	// the request brings a proof made for this variable, or the passphrase.
	if strict(s) {
		var f fresh
		if r.ContentLength != 0 {
			if err := plugin.ReadJSON(r, 64<<10, &f); err != nil {
				plugin.WriteError(w, err)
				return
			}
		}
		if given, ok := p.verified(c, w, r, s, f, purpose{For: ForReveal, Request: name}); !given {
			needFresh(c, w, r)
			return
		} else if !ok {
			return
		}
	}
	v, err := s.Value(name)
	if err != nil {
		fail(w, err)
		return
	}
	// The value leaves only once its record is written.
	if err := p.record(c.Host, r, "vault.revealed", pageAccess(r, "reveal", []string{name}, ResultRevealed)); err != nil {
		failLog(w)
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
		Passphrase string     `json:"passphrase"`
		Proof      *proofBody `json:"proof"`
	}
	if err := plugin.ReadJSON(r, 64<<10, &body); err != nil {
		plugin.WriteError(w, err)
		return
	}
	if st := s.Status(); st.Mode != vaultstore.ModePassphrase {
		fail(w, vaultstore.ErrNoPassphrase)
		return
	}
	if body.Proof != nil {
		p.sessionByProof(c, w, r, s, body.Proof)
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
	wasLocked := s.Status().Locked
	err = s.Unlock(body.Passphrase)
	p.tried(err == nil, errors.Is(err, vaultstore.ErrPassphrase))
	tok := ""
	if err == nil && wasLocked {
		p.capLock(c.Host)
	}
	if err == nil {
		// The passphrase given: the core holds the key for the setting's
		// time from now.
		p.keyFrom(c.Host)
	}
	if err == nil {
		if tok = p.newSession(c.Host, epoch, false); tok == "" {
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
	p.touch(c.Host)
	changed(c.Host)
	idle, _ := p.sessionLimits(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"session": tok, "idle": idle.Seconds(), "status": s.Status()})
}

// sessionByProof opens a session for an authenticator's proof made for it
// (proof.go). A vault locked while the core holds its key (suspended) is
// unlocked by it within the key's hold; one whose key the core forgot is
// refused, since a proof holds no key.
func (p *Plugin) sessionByProof(c *plugin.Call, w http.ResponseWriter, r *http.Request, s *vaultstore.Store, pb *proofBody) {
	want := purpose{For: ForSession}
	// As with the passphrase, the check, the unlock and the session it
	// opens are one step for a lock.
	p.keyMu.Lock()
	epoch := p.currentEpoch()
	var kind string
	err := error(vaultstore.ErrLocked)
	// The hold may have ended since the last look (open): a key the core
	// should have forgotten unlocks nothing.
	if s.Held() && p.keyLeft(c.Host) > 0 {
		kind, err = p.checkProof(c, r, s, pb, want)
	}
	resumed := false
	if err == nil && s.Status().Locked {
		resumed = true
		err = s.Resume()
	}
	tok := ""
	if err == nil {
		if tok = p.newSession(c.Host, epoch, true); tok == "" {
			err = vaultstore.ErrLocked
		}
	}
	p.keyMu.Unlock()
	if err != nil {
		refuseProof(c, w, r, err, want)
		return
	}
	c.Host.Audit(r, "vault.proved", map[string]any{"ok": true, "for": want.For, "kind": kind})
	if resumed {
		c.Host.Audit(r, "vault.unlocked", map[string]any{"ok": true, "kind": kind})
	}
	p.touch(c.Host)
	changed(c.Host)
	idle, _ := p.sessionLimits(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"session": tok, "proof": true, "idle": idle.Seconds(), "status": s.Status()})
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
		tok = p.newSession(c.Host, p.endSessions(), false)
		// A new key, set with the passphrase, unlocks as an unlock does.
		p.capLock(c.Host)
		p.keyFrom(c.Host)
	}
	p.keyMu.Unlock()
	c.Host.Audit(r, "vault.passphrase_set", map[string]any{"ok": err == nil, "change": change})
	if err != nil {
		fail(w, err)
		return
	}
	p.touch(c.Host)
	changed(c.Host)
	idle, _ := p.sessionLimits(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"session": tok, "idle": idle.Seconds(), "status": s.Status()})
}

// handleLock locks the vault and ends every session: it suspends a vault
// with an authenticator, whose key the core keeps for a proof to unlock it
// within the key's hold, and forgets the key of any other, or with
// {"forget": true}, after which only the passphrase unlocks it.
func (p *Plugin) handleLock(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	var body struct {
		Forget bool `json:"forget"`
	}
	if r.ContentLength != 0 {
		if err := plugin.ReadJSON(r, 1<<10, &body); err != nil {
			plugin.WriteError(w, err)
			return
		}
	}
	// After a check that runs, never between its key and its session.
	p.keyMu.Lock()
	held := s.Held()
	forgot := p.lockStore(s, body.Forget)
	p.keyMu.Unlock()
	if held {
		c.AuditField("keyHeld", !forgot)
	}
	if held && !forgot {
		p.armAutoLock(c.Host, p.keyLeft(c.Host)) // the hold's end is still due
	}
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
		// A proof made for this request and answer, or the passphrase
		// again: either stands for a session, and one of them is needed
		// where every Allow is verified.
		fresh
	}
	if err := plugin.ReadJSON(r, 64<<10, &body); err != nil {
		plugin.WriteError(w, err)
		return
	}
	id := r.PathValue("id")
	switch body.Answer {
	case AnswerOnce, AnswerAlways:
		// Letting a value out is the user's, behind the gate; denying
		// needs no proof.
		if !p.mayAllow(c, w, r, id, body.Answer, body.fresh) {
			return
		}
	case AnswerDeny:
	default:
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "answer is once, always or deny"})
		return
	}
	req := p.answerRequest(id, body.Answer)
	if req == nil {
		plugin.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "no such request (answered or expired)"})
		return
	}
	c.Host.Audit(r, "vault.answered", map[string]any{
		"id": req.ID, "machine": req.M, "tool": req.Tool, "names": req.Names, "answer": body.Answer,
	})
	plugin.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// mayAllow reports whether the request may allow request id (answer once
// or always), having answered it otherwise: with a proof made for this
// request and answer, with the passphrase again, or with a session, unless
// every Allow is verified (then a session is not enough: a program driving
// the page's session cannot allow).
func (p *Plugin) mayAllow(c *plugin.Call, w http.ResponseWriter, r *http.Request, id, answer string, f fresh) bool {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return false
	}
	if given, ok := p.verified(c, w, r, s, f, purpose{For: ForAnswer, Request: id, Answer: answer}); given {
		return ok
	}
	if strict(s) {
		needFresh(c, w, r)
		return false
	}
	if !p.sessionOf(c.Host, r, true) {
		refuseSession(c, w, r)
		return false
	}
	return true
}

// Log returns the access log, newest first (none before the first use).
func (p *Plugin) Log() []Access {
	p.mu.Lock()
	l := p.alog
	p.mu.Unlock()
	if l == nil {
		return []Access{}
	}
	return l.list()
}

func (p *Plugin) handleLog(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"log": p.accessLog(c.Host).list()})
}

// failLog answers a release whose record could not be written: the value
// does not leave.
func failLog(w http.ResponseWriter) {
	plugin.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": ResultLogFailed, "message": "the access could not be recorded, so the value was not released"})
}

// pageAccess is the record of values a page takes (a reveal, an export):
// its connection's address and browser.
func pageAccess(r *http.Request, tool string, names []string, result string) Access {
	remote := r.RemoteAddr
	if f := r.Header.Get("X-Forwarded-For"); f != "" {
		remote = clip(f, 256) + " via " + remote
	}
	return Access{Time: time.Now().UTC(), Tool: tool, Names: names, Remote: remote, UserAgent: clip(r.UserAgent(), 256), Result: result}
}

// AgentOps: the MCP servers' requests.
func (p *Plugin) AgentOps() []agentproto.Op { return []agentproto.Op{agentproto.OpVault} }

// ServeAgent answers one MCP server request relayed by mc's agent.
func (p *Plugin) ServeAgent(h plugin.Host, mc *machines.Machine, conn net.Conn, hdr agentproto.Header) {
	defer conn.Close()
	if err := agentproto.WriteLine(conn, agentproto.Reply{OK: true}); err != nil {
		return
	}
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	var req agentproto.VaultRequest
	if err := agentproto.ReadLine(conn, &req); err != nil {
		return
	}
	// Who asked, as the agent saw it (never what the request says).
	req.Process = hdr.Process
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
	rec := Access{
		Time: time.Now().UTC(), M: m, Tool: clip(req.Tool, 16), Names: names,
		Client: clip(req.Client, 64), Terminal: clip(req.Terminal, 64), Cwd: clip(req.Cwd, 1024), Process: clipProcess(req.Process),
	}
	resp, result := p.handle(ctx, h, m, req, &rec)
	rec.Result = result
	// Values leave only once their record is written.
	if err := p.record(h, nil, "vault.access", rec); err != nil {
		return failure(ResultLogFailed, "the access could not be recorded, so the values were not released")
	}
	if released(result) {
		p.touch(h)
		if req.Tool == agentproto.VaultEnv {
			resp.Run = runLimits(h)
		}
	}
	return resp
}

// appOf is the app of a request's process chain: the name of the process
// that started the one connected to vault.sock (the CLI that runs the MCP
// server), as the machine's kernel names it; "" without one, and for a
// name longer than an app exempted can be (macOS keeps 16 bytes): cut, it
// would be the app of every name it begins.
func appOf(ps []agentproto.VaultProcess) string {
	if len(ps) < 2 || len(ps[1].Name) > vaultstore.MaxApp {
		return ""
	}
	return ps[1].Name
}

// clipProcess bounds a process chain an agent reported.
func clipProcess(ps []agentproto.VaultProcess) []agentproto.VaultProcess {
	if len(ps) == 0 {
		return nil
	}
	out := make([]agentproto.VaultProcess, 0, min(len(ps), agentproto.MaxVaultProcesses))
	for _, x := range ps[:min(len(ps), agentproto.MaxVaultProcesses)] {
		out = append(out, agentproto.VaultProcess{Pid: x.Pid, Name: clip(x.Name, 64)})
	}
	return out
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func (p *Plugin) noisyAuditEvery() time.Duration {
	if p.noisyEvery > 0 {
		return p.noisyEvery
	}
	return noisyAuditEvery
}

// record writes rec to the access log and to the audit log as event (r:
// a page's request). A record that lets values out is written to the
// access log's file and flushed first; when that fails it is recorded as
// log_failed, and the error says the values must not leave. List calls
// and refusals are coalesced and rate-limited (noisy); nothing else is.
func (p *Plugin) record(h plugin.Host, r *http.Request, event string, rec Access) error {
	quiet := noisy(rec.Result)
	kept, err := p.accessLog(h).add(rec, quiet, released(rec.Result))
	fields := accessFields(kept)
	audit := true
	if quiet {
		p.mu.Lock()
		audit = p.auditNoisy(h, kept.M+"\x00"+kept.Result, kept.Time, fields)
		p.mu.Unlock()
	}
	if audit {
		h.Audit(r, event, fields)
	}
	if !quiet {
		p.changedThrottled(h)
	}
	return err
}

// accessFields are an access's fields in the audit log: names, never
// values.
func accessFields(a Access) map[string]any {
	f := map[string]any{"tool": a.Tool, "names": a.Names, "result": a.Result}
	for k, v := range map[string]string{"machine": a.M, "client": a.Client, "terminal": a.Terminal, "cwd": a.Cwd, "user_agent": a.UserAgent} {
		if v != "" {
			f[k] = v
		}
	}
	if len(a.Process) > 0 {
		f["process"] = a.Process
	}
	return f
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

// handle answers req and says what the access log records: the result
// (refused: the response's code) and, in rec, the names deduplicated.
func (p *Plugin) handle(ctx context.Context, h plugin.Host, m string, req agentproto.VaultRequest, rec *Access) (agentproto.VaultResponse, string) {
	refuse := func(code, msg string) (agentproto.VaultResponse, string) { return failure(code, msg), code }
	s, err := p.open(h)
	if err != nil {
		return refuse("unavailable", err.Error())
	}
	// The app that asked, as the machine's kernel names it: an exempt one
	// reads without asking while the vault is unlocked.
	exempt := s.Exempt(m, appOf(req.Process))
	if req.Tool == agentproto.VaultList {
		vars := []agentproto.VaultVariable{}
		for _, i := range s.List() {
			vars = append(vars, agentproto.VaultVariable{Name: i.Name, Description: i.Description, InjectOnly: i.InjectOnly, Approval: !i.Allows(m) && !exempt})
		}
		return agentproto.VaultResponse{OK: true, Variables: vars}, ResultListed
	}
	switch req.Tool {
	case agentproto.VaultGet:
		if len(req.Names) != 1 {
			return refuse("bad_request", "get takes one name")
		}
	case agentproto.VaultEnv:
		if len(req.Names) == 0 || len(req.Names) > MaxNames {
			return refuse("bad_request", "env takes 1 to 64 names")
		}
	default:
		return refuse("bad_request", "unknown tool")
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
			return refuse("not_found", "no variable "+n)
		}
		if req.Tool == agentproto.VaultGet && i.InjectOnly {
			return refuse("inject_only", n+" can only be injected into a command (run_with_env)")
		}
		if !i.Allows(m) {
			ask = append(ask, n)
		}
	}
	if s.Status().Locked {
		return refuse("vault_locked", "the vault is locked; unlock it in the UI")
	}
	result := ResultAllowed
	if len(ask) > 0 && exempt {
		result = ResultExempted
	} else if len(ask) > 0 {
		answer := p.ask(ctx, h, m, req, ask)
		switch answer {
		case AnswerOnce:
			result = ResultApproved
		case AnswerAlways:
			result = ResultApprovedAlways
			for _, n := range ask {
				if err := s.Allow(n, m); err != nil {
					h.Logger().Printf("vault: allowing %s on %s: %v", n, m, err)
				}
			}
		case answerTimeout:
			return failure("denied", "nobody approved the request within the time allowed"), ResultExpired
		case answerGone:
			return failure("denied", "the request was cancelled"), ResultCancelled
		case answerBusy:
			return refuse("busy", "too many requests of this machine wait for an answer; answer them or try again later")
		default:
			return refuse(ResultDenied, "the user denied the request")
		}
	}
	values := map[string]string{}
	for _, n := range names {
		v, err := s.Value(n)
		if err != nil {
			return refuse(vaultstore.Code(err), err.Error())
		}
		values[n] = v
	}
	return agentproto.VaultResponse{OK: true, Values: values}, result
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
			return answerBusy
		}
		idb := make([]byte, 12)
		rand.Read(idb)
		now := time.Now().UTC()
		r = &Request{
			ID: hex.EncodeToString(idb), M: m, Tool: req.Tool, Names: names,
			Client: clip(req.Client, 64), Terminal: clip(req.Terminal, 64), Cwd: clip(req.Cwd, 1024),
			Process: clipProcess(req.Process), Created: now, Expires: now.Add(p.timeout(h)), done: make(chan struct{}),
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
		p.resolve(r, answerTimeout)
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
	if gone && (answer == "" || answer == AnswerDeny) {
		// This requester left: others may still wait for the request, or it
		// was the last and so denied it.
		return answerGone
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
	}
	// Its exemptions went too.
	changed(h)
}
