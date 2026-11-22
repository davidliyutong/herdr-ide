// Package agents is the core's side of the agents plugin: the sessions of
// the coding agents in the machines' terminals (internal/agent/plugin/agents).
// While the plugin is on, the core asks each machine's detect stream for
// the session each agent terminal runs (internal/server). Its route, a
// machine's:
//
//   - GET /api/m/{id}/p/agents/resolve?kind=&session=&cwd=: whether a
//     session's transcript exists and ran in the directory cwd
//     (agentproto.ResolveReply); at most MaxResolving run at once per
//     machine (more: 429 busy), each a search of the machine's session
//     directories for an id it does not know.
//
// Everything a request names is checked here before the machine is asked
// (400 bad_request), and the machine checks it again. The request to the
// machine ends with the HTTP request. The route only reads: a read-only
// core answers it, and it is not audited, as the file explorer's reads
// are not. The plugin has no settings of its own; its switch is
// plugins.agents.enabled (plugin.Settings), and while it is off the core
// answers its route 404 plugin_disabled without running it.
package agents

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
)

// ID names the plugin on every side.
const ID = "agents"

// actionResolve is the machine side's action.
const actionResolve = "resolve"

const (
	// MaxResolving bounds the resolves a machine serves at once; more are
	// answered 429 busy.
	MaxResolving = 8
	// MaxCwd bounds the directory of a resolve, in bytes.
	MaxCwd = 4096
	// resolveTimeout bounds a machine's answer to a resolve.
	resolveTimeout = 15 * time.Second
)

// counts are requests under way by machine.
type counts map[string]int

// take counts one more request of k; false, and nothing counted, when k
// has limit of them already.
func (c counts) take(k string, limit int) bool {
	if c[k] >= limit {
		return false
	}
	c[k]++
	return true
}

func (c counts) give(k string) {
	if c[k]--; c[k] <= 0 {
		delete(c, k)
	}
}

// Plugin is the agents plugin.
type Plugin struct {
	mu sync.Mutex
	// resolving counts the resolves under way per machine.
	resolving counts
	// call runs an action of a machine's agent; tests replace it.
	call func(ctx context.Context, mc *machines.Machine, action string, params, out any) error
}

// New returns the plugin.
func New() *Plugin {
	return &Plugin{resolving: counts{}}
}

func (p *Plugin) ID() string { return ID }

// Routes of the plugin.
func (p *Plugin) Routes() []plugin.Route {
	return []plugin.Route{
		{Method: http.MethodGet, Path: "resolve", Machine: true, Handler: p.getResolve},
	}
}

// request runs an action of mc's agent and decodes its result into out.
func (p *Plugin) request(ctx context.Context, mc *machines.Machine, action string, params, out any) error {
	if mc == nil {
		return plugin.ErrOffline
	}
	if p.call != nil {
		return p.call(ctx, mc, action, params, out)
	}
	return plugin.Request(ctx, mc, ID, action, params, out)
}

func busy(w http.ResponseWriter, msg string) {
	plugin.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "busy", "message": msg})
}

func badRequest(w http.ResponseWriter, msg string) {
	plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": msg})
}

// transcriptKind reports whether kind is an agent whose transcripts are
// read (agentkinds.Kind.Transcript).
func transcriptKind(kind string) bool {
	k, ok := agentkinds.ByID(kind)
	return ok && k.Transcript != ""
}

// validCwd reports whether s can be the directory of a resolve: an
// absolute POSIX path of at most MaxCwd bytes of UTF-8 without NUL. The
// machine only compares it with the directory a transcript records.
func validCwd(s string) bool {
	return s != "" && len(s) <= MaxCwd && s[0] == '/' && utf8.ValidString(s) && !strings.ContainsRune(s, 0)
}

// getResolve answers whether a session is one to resume in a directory.
func (p *Plugin) getResolve(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	kind, session, cwd := q.Get("kind"), q.Get("session"), q.Get("cwd")
	if !transcriptKind(kind) || !agentkinds.ValidSessionID(session) || !validCwd(cwd) {
		badRequest(w, "kind: an agent with transcripts; session: its session id; cwd: an absolute directory")
		return
	}
	if c.Machine == nil {
		plugin.WriteError(w, plugin.ErrOffline)
		return
	}
	m := c.Machine.ID()
	p.mu.Lock()
	ok := p.resolving.take(m, MaxResolving)
	p.mu.Unlock()
	if !ok {
		busy(w, "too many resolves of the machine's sessions at once")
		return
	}
	defer func() {
		p.mu.Lock()
		p.resolving.give(m)
		p.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(r.Context(), resolveTimeout)
	defer cancel()
	// Decoded into the answer's struct: nothing else a machine answered
	// reaches the page.
	var out agentproto.ResolveReply
	if err := p.request(ctx, c.Machine, actionResolve, agentproto.ResolveRequest{Kind: kind, Session: session, Cwd: cwd}, &out); err != nil {
		plugin.WriteError(w, err)
		return
	}
	plugin.WriteJSON(w, http.StatusOK, out)
}
