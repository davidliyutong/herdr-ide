// Package agents is the core's side of the agents plugin: coding agents in
// terminals shown as their conversations, read from the sessions'
// transcripts on the machines (internal/agent/plugin/agents). Its routes,
// both a machine's:
//
//   - GET /api/m/{id}/p/agents/tail?s=<kind>~<session>~<from>[~b]&…&wait=<ms>:
//     a page of each of 1 to agentproto.MaxTailRefs transcripts
//     (agentproto.TailReply), each s a ref (agentproto.TranscriptRef: the
//     agent's kind, its session id, the cursor as a decimal number, and
//     "~b" for a page before it); with wait (0 to 15000), the machine
//     waits that long for a transcript to grow when none has anything new.
//     At most MaxWaiting of them wait on a machine at once, and at most
//     MaxWaitingPerClient of one client (the address it connects from),
//     so that one client's long polls do not take the others' places: a
//     request beyond either is read at once (wait 0), and when nothing is
//     new its answer is held on the core for up to overflowPause (no
//     longer than its wait), which takes nothing of the machine, before
//     the page asks again. Beyond MaxInFlight reads of a machine at once
//     a request is answered 429 busy;
//   - GET /api/m/{id}/p/agents/resolve?kind=&session=&cwd=: whether a
//     session's transcript exists and ran in the directory cwd
//     (agentproto.ResolveReply); at most MaxResolving run at once per
//     machine (more: 429 busy), each a search of the machine's session
//     directories for an id it does not know.
//
// Everything a request names is checked here before the machine is asked
// (400 bad_request), and the machine checks it again. The request to the
// machine ends with the HTTP request. Both routes only read: a read-only
// core answers them, and they are not audited, as the file explorer's
// reads are not. The plugin has no settings of its own; its switch is
// plugins.agents.enabled (plugin.Settings), and while it is off the core
// answers its routes 404 plugin_disabled without running them.
package agents

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"strconv"
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

// The machine side's actions.
const (
	actionTail    = "tail"
	actionResolve = "resolve"
)

const (
	// MaxInFlight bounds the tail requests a machine serves at once,
	// waiting or not; more are answered 429 busy.
	MaxInFlight = 16
	// MaxWaiting bounds the tail requests that wait on a machine at once,
	// MaxWaitingPerClient those of one client; a request beyond either is
	// served without its wait.
	MaxWaiting          = 6
	MaxWaitingPerClient = 2
	// MaxResolving bounds the resolves a machine serves at once; more are
	// answered 429 busy.
	MaxResolving = 8
	// MaxWaitMS is the longest wait a tail asks for, in milliseconds
	// (agentproto.MaxTailWait).
	MaxWaitMS = int(agentproto.MaxTailWait / time.Millisecond)
	// MaxCwd bounds the directory of a resolve, in bytes.
	MaxCwd = 4096
	// maxRef bounds one ref of the query: a kind, a session id, a cursor
	// and the back mark.
	maxRef = 128
	// tailTimeout bounds a machine's reading of a tail's pages, besides
	// the wait it was asked for; resolveTimeout a resolve.
	tailTimeout    = 30 * time.Second
	resolveTimeout = 15 * time.Second
)

// overflowPause is how long the core holds the answer of a tail served
// without its wait (over MaxWaiting or MaxWaitingPerClient) when nothing
// is new, at most that wait: a page asks again as soon as it is answered,
// and would otherwise ask the machine again and again. A variable for
// tests.
var overflowPause = time.Second

// counts are requests under way by key.
type counts[K comparable] map[K]int

// take counts one more request of k; false, and nothing counted, when k
// has limit of them already.
func (c counts[K]) take(k K, limit int) bool {
	if c[k] >= limit {
		return false
	}
	c[k]++
	return true
}

func (c counts[K]) give(k K) {
	if c[k]--; c[k] <= 0 {
		delete(c, k)
	}
}

// clientKey is a client of a machine.
type clientKey struct{ machine, client string }

// Plugin is the agents plugin.
type Plugin struct {
	mu sync.Mutex
	// inFlight counts the tail requests under way per machine, waiting
	// the tails that wait on it, clients those per machine and client, and
	// resolving the resolves.
	inFlight, waiting, resolving counts[string]
	clients                      counts[clientKey]
	// call runs an action of a machine's agent; tests replace it.
	call func(ctx context.Context, mc *machines.Machine, action string, params, out any) error
}

// New returns the plugin.
func New() *Plugin {
	return &Plugin{inFlight: counts[string]{}, waiting: counts[string]{}, resolving: counts[string]{}, clients: counts[clientKey]{}}
}

func (p *Plugin) ID() string { return ID }

// Routes of the plugin.
func (p *Plugin) Routes() []plugin.Route {
	return []plugin.Route{
		{Method: http.MethodGet, Path: "tail", Machine: true, Handler: p.getTail},
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

// clientOf is the client a request comes from, for the share of a
// machine's waiting tails it may take: the address it connects from,
// without the port (a browser opens several connections, and a page's
// requests take any of them). Behind a proxy every client is the proxy:
// X-Forwarded-For is the client's own word, and would let one client take
// every share.
func clientOf(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// acquireTail takes a place of machine m's for a tail of client, and one
// to wait on the machine when the tail waits and both m and client have
// one left (waits). ok is false when m serves MaxInFlight tails already.
// release gives back what was taken, once however often it is called.
func (p *Plugin) acquireTail(m, client string, wait bool) (release func(), waits, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.inFlight.take(m, MaxInFlight) {
		return nil, false, false
	}
	k := clientKey{m, client}
	if wait && p.waiting[m] < MaxWaiting && p.clients[k] < MaxWaitingPerClient {
		p.waiting[m]++
		p.clients[k]++
		waits = true
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			p.mu.Lock()
			defer p.mu.Unlock()
			p.inFlight.give(m)
			if waits {
				p.waiting.give(m)
				p.clients.give(k)
			}
		})
	}, waits, true
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

// parseRef reads one ref of a tail's query: <kind>~<session>~<from>, and
// ~b after them for a page before the cursor.
func parseRef(s string) (agentproto.TranscriptRef, bool) {
	if len(s) > maxRef {
		return agentproto.TranscriptRef{}, false
	}
	parts := strings.Split(s, "~")
	if len(parts) < 3 || len(parts) > 4 || len(parts) == 4 && parts[3] != "b" {
		return agentproto.TranscriptRef{}, false
	}
	if !transcriptKind(parts[0]) || !agentkinds.ValidSessionID(parts[1]) {
		return agentproto.TranscriptRef{}, false
	}
	from, err := strconv.ParseUint(parts[2], 10, 64)
	if err != nil {
		return agentproto.TranscriptRef{}, false
	}
	return agentproto.TranscriptRef{Kind: parts[0], Session: parts[1], From: from, Back: len(parts) == 4}, true
}

// parseTail reads a tail's query: its refs and its wait in milliseconds.
func parseTail(q url.Values) ([]agentproto.TranscriptRef, int, bool) {
	ss := q["s"]
	if len(ss) == 0 || len(ss) > agentproto.MaxTailRefs {
		return nil, 0, false
	}
	refs := make([]agentproto.TranscriptRef, len(ss))
	for i, s := range ss {
		ref, ok := parseRef(s)
		if !ok {
			return nil, 0, false
		}
		refs[i] = ref
	}
	wait := 0
	if ws := q["wait"]; len(ws) > 1 {
		return nil, 0, false
	} else if len(ws) == 1 {
		n, err := strconv.ParseUint(ws[0], 10, 32)
		if err != nil || n > uint64(MaxWaitMS) {
			return nil, 0, false
		}
		wait = int(n)
	}
	return refs, wait, true
}

// validCwd reports whether s can be the directory of a resolve: an
// absolute POSIX path of at most MaxCwd bytes of UTF-8 without NUL. The
// machine only compares it with the directory a transcript records.
func validCwd(s string) bool {
	return s != "" && len(s) <= MaxCwd && s[0] == '/' && utf8.ValidString(s) && !strings.ContainsRune(s, 0)
}

// getTail answers with a page of each transcript the query names.
func (p *Plugin) getTail(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	refs, wait, ok := parseTail(r.URL.Query())
	if !ok {
		badRequest(w, "s: 1 to 8 refs <kind>~<session>~<from>[~b]; wait: 0 to 15000 milliseconds")
		return
	}
	if c.Machine == nil {
		plugin.WriteError(w, plugin.ErrOffline)
		return
	}
	m := c.Machine.ID()
	release, waits, ok := p.acquireTail(m, clientOf(r), wait > 0)
	if !ok {
		busy(w, "too many reads of the machine's transcripts at once")
		return
	}
	defer release()
	asked := wait
	if !waits {
		wait = 0
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(wait)*time.Millisecond+tailTimeout)
	defer cancel()
	var out agentproto.TailReply
	if err := p.request(ctx, c.Machine, actionTail, agentproto.TailRequest{Refs: refs, WaitMS: wait}, &out); err != nil {
		plugin.WriteError(w, err)
		return
	}
	if !answers(refs, out.Tails) {
		plugin.WriteJSON(w, http.StatusBadGateway, map[string]string{"error": "bad_reply", "message": "the machine's pages are not the ones asked for"})
		return
	}
	if wait < asked && !news(refs, out.Tails) {
		// Served without its wait, with nothing new: held here, holding
		// nothing of the machine's.
		release()
		t := time.NewTimer(min(overflowPause, time.Duration(asked)*time.Millisecond))
		select {
		case <-t.C:
		case <-r.Context().Done():
			t.Stop()
			return
		}
	}
	plugin.WriteJSON(w, http.StatusOK, out)
}

// news reports whether tails answer a tail at once, as the machine tells
// (internal/agent/plugin/agents): a page has events, a forward read moved
// its cursor or stopped at a limit, or a page before a cursor was read.
func news(refs []agentproto.TranscriptRef, tails []agentproto.TranscriptTail) bool {
	for i, t := range tails {
		ref := refs[i]
		if len(t.Events) > 0 || !ref.Back && (t.Next != ref.From || t.More) || ref.Back && ref.From != 0 {
			return true
		}
	}
	return false
}

// answers reports whether tails are the pages of refs, in their order.
func answers(refs []agentproto.TranscriptRef, tails []agentproto.TranscriptTail) bool {
	if len(tails) != len(refs) {
		return false
	}
	for i, t := range tails {
		if t.Kind != refs[i].Kind || t.Session != refs[i].Session {
			return false
		}
	}
	return true
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
