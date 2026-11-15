// Package vault is the variable vault plugin's core side: the encrypted
// store of internal/vault behind routes for the UI (/api/p/vault/…), and
// the requests of the MCP servers on machines (agentproto.OpVault), which
// read variables a machine is allowed to, or that the user approves in the
// UI. Values reach a browser only through reveal, a writing route.
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
	// MaxPending is how many requests may wait for an answer at once;
	// more are denied.
	MaxPending = 32
	// MaxNames is how many variables one request may name.
	MaxNames = 64
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
	answer   chan string
}

// Access is a record of the access log: names only, never values.
type Access struct {
	Time     time.Time `json:"time"`
	M        string    `json:"m"`
	Tool     string    `json:"tool"`
	Names    []string  `json:"names,omitempty"`
	Client   string    `json:"client,omitempty"`
	Terminal string    `json:"terminal,omitempty"`
	// Result: allowed (by the machines of the variables), approved,
	// denied, timeout, or the error's code.
	Result string `json:"result"`
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
		{Method: "PUT", Path: "vars/{name}", Mutating: true, Audit: "set", Handler: p.handleSet},
		{Method: "DELETE", Path: "vars/{name}", Mutating: true, Audit: "delete", Handler: p.handleDelete},
		{Method: "POST", Path: "vars/{name}/reveal", Mutating: true, Audit: "reveal", Handler: p.handleReveal},
		{Method: "POST", Path: "unlock", Mutating: true, Audit: "unlock", Handler: p.handleUnlock},
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
	case "vault_locked", "key_missing", "keychain_unavailable":
		status = http.StatusConflict
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
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"status": s.Status(), "variables": s.List()})
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

func (p *Plugin) handleUnlock(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
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
	err = s.Unlock(body.Passphrase)
	c.Host.Audit(r, "vault.unlocked", map[string]any{"ok": err == nil})
	if err != nil {
		fail(w, err)
		return
	}
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, s.Status())
}

func (p *Plugin) handleLock(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	s.Lock()
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
// find no request.
func (p *Plugin) Answer(id, answer string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	req, ok := p.pending[id]
	if !ok {
		return false
	}
	delete(p.pending, id)
	req.answer <- answer
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
	case AnswerOnce, AnswerAlways, AnswerDeny:
	default:
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "answer is once, always or deny"})
		return
	}
	if !p.Answer(r.PathValue("id"), body.Answer) {
		plugin.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "no such request (answered or expired)"})
		return
	}
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

func (p *Plugin) record(h plugin.Host, rec Access) {
	p.mu.Lock()
	p.log = append(p.log, rec)
	if len(p.log) > MaxLog {
		p.log = slices.Delete(p.log, 0, len(p.log)-MaxLog)
	}
	p.mu.Unlock()
	h.Audit(nil, "vault.access", map[string]any{
		"machine": rec.M, "tool": rec.Tool, "names": rec.Names, "client": rec.Client, "terminal": rec.Terminal, "result": rec.Result,
	})
	changed(h)
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
			rec.Result = "approved"
			for _, n := range ask {
				if err := s.Allow(n, m); err != nil {
					h.Logger().Printf("vault: allowing %s on %s: %v", n, m, err)
				}
			}
		case "timeout":
			return failure("denied", "nobody approved the request within the time allowed")
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
// timeout or the requester's going away.
func (p *Plugin) ask(ctx context.Context, h plugin.Host, m string, req agentproto.VaultRequest, names []string) string {
	idb := make([]byte, 12)
	rand.Read(idb)
	now := time.Now().UTC()
	r := &Request{
		ID: hex.EncodeToString(idb), M: m, Tool: req.Tool, Names: names,
		Client: clip(req.Client, 64), Terminal: clip(req.Terminal, 64), Cwd: clip(req.Cwd, 1024),
		Created: now, Expires: now.Add(p.timeout()), answer: make(chan string, 1),
	}
	p.mu.Lock()
	if len(p.pending) >= MaxPending {
		p.mu.Unlock()
		return AnswerDeny
	}
	if p.pending == nil {
		p.pending = map[string]*Request{}
	}
	p.pending[r.ID] = r
	p.mu.Unlock()
	h.Broadcast(ID, m, map[string]any{"type": "request", "request": r})
	t := time.NewTimer(p.timeout())
	defer t.Stop()
	answer := "timeout"
	select {
	case answer = <-r.answer:
	case <-t.C:
	case <-ctx.Done():
		answer = AnswerDeny
	}
	p.mu.Lock()
	delete(p.pending, r.ID)
	p.mu.Unlock()
	h.Broadcast(ID, m, map[string]any{"type": "resolved", "id": r.ID, "answer": answer})
	return answer
}
