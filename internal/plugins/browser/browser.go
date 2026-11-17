// Package browser is the core side of the browser plugin
// (docs/features/32-browser-and-ports.md): port forwards. A forward makes a
// service that listens on a machine's loopback interface reachable on the
// core host's, as ssh -L does: the core listens on a loopback port and
// carries each connection to the machine through its agent (the plugin's
// dial action), so a page of the UI on the core's host can show the
// service in a browser pane under http://localhost:<port>.
//
// A forwarded service is another site than the UI: it gets a port of its
// own, hence an origin of its own, which the core's Origin guard refuses
// (internal/server). The listeners are on loopback only and exist only
// while a forward does; nothing listens on the machines.
package browser

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"herdr-ide/internal/loopback"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
)

// ID names the plugin.
const ID = "browser"

const (
	// MaxForwards bounds the forwards of a core.
	MaxForwards = 32
	// maxConns bounds a forward's connections at a time.
	maxConns = 128
	// SettingIdle is how many minutes a forward stays unused before it
	// ends (0: until it is stopped). A use is a connection accepted, bytes
	// carried, or a client asking for the forward; a connection that only
	// stays open is none.
	SettingIdle = "browser.forwardIdle"
	// SettingLinks is where a link of a terminal opens: in a browser pane
	// or outside the app. The web UI reads it.
	SettingLinks = "browser.openLinks"
	// DefaultIdle is SettingIdle's default.
	DefaultIdle = 30
	// reapEvery is how often idle forwards are looked for.
	reapEvery = 30 * time.Second
	// useEvery is how often at most the bytes a forward carries are noted
	// as a use of it.
	useEvery = time.Second
	// acceptPauseMin and acceptPauseMax bound the pause before a listener
	// accepts again after a temporary failure; it doubles from one to the
	// other, as net/http's does.
	acceptPauseMin = 5 * time.Millisecond
	acceptPauseMax = time.Second
)

// Settings is the plugin's settings module (internal/registry).
var Settings = func() settings.Module {
	mn, mx := settings.Range(0, 1440)
	return settings.Module{
		Sections: []settings.Section{{ID: ID, Order: 65, Plugin: ID}},
		Defs: []settings.Def{
			{Key: SettingLinks, Type: settings.TypeEnum, Default: "pane", Enum: []string{"pane", "external"},
				Scope: settings.ScopeApp, Section: ID, Order: 10},
			{Key: SettingIdle, Type: settings.TypeNumber, Default: float64(DefaultIdle), Min: mn, Max: mx, Integer: true,
				Scope: settings.ScopeApp, Section: ID, Order: 20},
		},
	}
}()

// Forward is a forward as clients see it: Port on machine M is reachable
// on the core host's loopback port Local.
type Forward struct {
	M           string    `json:"m"`
	Port        int       `json:"port"`
	Local       int       `json:"local"`
	Created     time.Time `json:"created"`
	Connections int       `json:"connections"`
}

type key struct {
	m    string
	port int
}

type forward struct {
	key
	local   int
	lns     []net.Listener
	created time.Time
	// used is when the forward was last used (use), in nanoseconds of
	// Unix time: read and written without the plugin's lock, since every
	// chunk of bytes carried looks at it.
	used  atomic.Int64
	conns int
	// ctx ends with the forward: its connections end with it.
	ctx    context.Context
	cancel context.CancelFunc
}

// use notes a use of the forward at now: a connection accepted, or a
// client asking for it.
func (f *forward) use(now time.Time) { f.used.Store(now.UnixNano()) }

// lastUse is when the forward was last used.
func (f *forward) lastUse() time.Time { return time.Unix(0, f.used.Load()) }

// Plugin is the browser plugin.
type Plugin struct {
	mu       sync.Mutex
	forwards map[key]*forward
	host     plugin.Host
	// ctx is the core's (Start); nil in a core that did not start plugins.
	ctx context.Context
	now func() time.Time
}

// New returns the plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) ID() string { return ID }

func (p *Plugin) clock() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}

// Start ends idle forwards while the core runs, and every forward when it
// stops.
func (p *Plugin) Start(ctx context.Context, h plugin.Host) {
	p.mu.Lock()
	p.host, p.ctx = h, ctx
	p.mu.Unlock()
	go func() {
		t := time.NewTicker(reapEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				p.closeWhere(func(*forward) bool { return true })
				return
			case <-t.C:
				p.reap(h)
			}
		}
	}()
}

// reap ends the forwards unused for the setting's minutes, and all of them
// while the plugin is off. A forward's open connections do not keep it:
// one that carried nothing for that long ends with it, so a program that
// holds a connection open cannot keep a way into the machine.
func (p *Plugin) reap(h plugin.Host) {
	idle := time.Duration(DefaultIdle) * time.Minute
	off := false
	if st := h.Settings(); st != nil {
		if n, ok := st.Get(SettingIdle).(float64); ok {
			idle = time.Duration(n) * time.Minute
		}
		off = !plugin.Enabled(st, p)
	}
	now := p.clock()
	p.closeWhere(func(f *forward) bool {
		return off || (idle > 0 && now.Sub(f.lastUse()) > idle)
	})
}

// ForgetMachine ends the forwards of a machine the user removed.
func (p *Plugin) ForgetMachine(h plugin.Host, id string) {
	p.closeWhere(func(f *forward) bool { return f.m == id })
}

// closeWhere ends the forwards match picks (called with p.mu held for it)
// and returns how many.
func (p *Plugin) closeWhere(match func(*forward) bool) int {
	p.mu.Lock()
	var gone []*forward
	for k, f := range p.forwards {
		if match(f) {
			gone = append(gone, f)
			delete(p.forwards, k)
		}
	}
	p.mu.Unlock()
	for _, f := range gone {
		f.cancel()
		for _, ln := range f.lns {
			ln.Close()
		}
	}
	return len(gone)
}

// List returns the forwards, by machine and port.
func (p *Plugin) List() []Forward {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]Forward, 0, len(p.forwards))
	for _, f := range p.forwards {
		out = append(out, f.public())
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].M != out[j].M {
			return out[i].M < out[j].M
		}
		return out[i].Port < out[j].Port
	})
	return out
}

func (f *forward) public() Forward {
	return Forward{M: f.m, Port: f.port, Local: f.local, Created: f.created, Connections: f.conns}
}

// listenLoopback listens on the core host's loopback interface, on port
// pref when it is free (so the page's address is the one the service
// expects), else on one the system picks. The same port is taken on ::1,
// where "localhost" may lead first: a port whose ::1 side another program
// holds, or that cannot be taken for any other reason, is not used, since
// a browser could then reach another program in the forward's stead. Only
// a host without IPv6 loopback listens on 127.0.0.1 alone (loopback.Other).
func listenLoopback(pref int) ([]net.Listener, int, error) {
	try := func(port int) ([]net.Listener, int, error) {
		l4, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			return nil, 0, err
		}
		local := l4.Addr().(*net.TCPAddr).Port
		l6, owned, err := loopback.Other(l4)
		switch {
		case l6 != nil:
			return []net.Listener{l4, l6}, local, nil
		case owned:
			return []net.Listener{l4}, local, nil
		}
		l4.Close()
		if err == nil {
			err = errors.New("the other loopback address of the port is not this program's")
		}
		return nil, 0, err
	}
	// Ports below 1024 are the system's to give.
	if pref >= 1024 {
		if lns, local, err := try(pref); err == nil {
			return lns, local, nil
		}
	}
	var err error
	for range 5 {
		var lns []net.Listener
		var local int
		if lns, local, err = try(0); err == nil {
			return lns, local, nil
		}
	}
	return nil, 0, err
}

// ensure returns the forward of port on machine m, making it if there is
// none yet; it counts as a use of the forward.
func (p *Plugin) ensure(h plugin.Host, m string, port int) (Forward, error) {
	k := key{m, port}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.clock()
	if f := p.forwards[k]; f != nil {
		f.use(now)
		return f.public(), nil
	}
	if len(p.forwards) >= MaxForwards {
		return Forward{}, &plugin.Error{Code: "too_many", Message: "at most " + strconv.Itoa(MaxForwards) + " forwards"}
	}
	lns, local, err := listenLoopback(port)
	if err != nil {
		return Forward{}, &plugin.Error{Code: "listen", Message: err.Error()}
	}
	parent := p.ctx
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	f := &forward{key: k, local: local, lns: lns, created: now.UTC(), ctx: ctx, cancel: cancel}
	f.use(now)
	if p.forwards == nil {
		p.forwards = map[key]*forward{}
	}
	p.forwards[k] = f
	for _, ln := range lns {
		go p.serve(h, f, ln)
	}
	return f.public(), nil
}

// temporary reports whether a failed Accept may succeed when tried again:
// the process or the system is out of descriptors for now, a connection
// ended before it was accepted, or a deadline passed.
func temporary(err error) bool {
	if errors.Is(err, syscall.EMFILE) || errors.Is(err, syscall.ENFILE) || errors.Is(err, syscall.ECONNABORTED) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// serve carries the connections of one listener to the machine, until the
// listener is closed (the forward ended). A temporary failure to accept is
// tried again after a pause that grows; any other ends the forward, which
// would else stay listed with a listener nobody serves.
func (p *Plugin) serve(h plugin.Host, f *forward, ln net.Listener) {
	var pause time.Duration
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) || f.ctx.Err() != nil {
				return
			}
			if temporary(err) {
				pause = min(max(2*pause, acceptPauseMin), acceptPauseMax)
				select {
				case <-time.After(pause):
					continue
				case <-f.ctx.Done():
					return
				}
			}
			if p.closeWhere(func(x *forward) bool { return x == f }) > 0 {
				h.Logger().Printf("browser: the forward of port %d of %s ended: %v", f.port, f.m, err)
			}
			return
		}
		pause = 0
		p.mu.Lock()
		if f.conns >= maxConns {
			p.mu.Unlock()
			c.Close()
			continue
		}
		f.conns++
		f.use(p.clock())
		p.mu.Unlock()
		go func() {
			defer func() {
				p.mu.Lock()
				f.conns--
				p.mu.Unlock()
			}()
			p.carry(h, f, c)
		}()
	}
}

// carrying is a connection's writer that notes the bytes going through it
// as a use of its forward, at most every useEvery: a clock reading and a
// comparison for a chunk.
type carrying struct {
	io.Writer
	p *Plugin
	f *forward
}

func (w carrying) Write(b []byte) (int, error) {
	if now := w.p.clock().UnixNano(); now-w.f.used.Load() >= int64(useEvery) {
		w.f.used.Store(now)
	}
	return w.Writer.Write(b)
}

// carry connects c to the forward's port on its machine and copies both
// ways until either side ends, or the forward does.
func (p *Plugin) carry(h plugin.Host, f *forward, c net.Conn) {
	defer c.Close()
	mc := h.Machines().Get(f.m)
	if mc == nil {
		return
	}
	st, _, err := plugin.Open(f.ctx, mc, ID, "dial", map[string]int{"port": f.port})
	if err != nil {
		return
	}
	defer st.Close()
	done := make(chan struct{})
	go func() {
		io.Copy(carrying{st, p, f}, c)
		st.Close()
		c.Close()
		close(done)
	}()
	io.Copy(carrying{c, p, f}, st)
	c.Close()
	st.Close()
	<-done
}

// Routes are the UI's.
func (p *Plugin) Routes() []plugin.Route {
	return []plugin.Route{
		{Method: "GET", Path: "forwards", Handler: p.handleList},
		{Method: "POST", Path: "forwards", Machine: true, Mutating: true, Audit: "forward", Handler: p.handleForward},
		{Method: "DELETE", Path: "forwards/{port}", Machine: true, Mutating: true, Audit: "forward_stop", Handler: p.handleStop},
		{Method: "GET", Path: "listening", Machine: true, Handler: p.handleListening},
	}
}

// handleList lists the forwards, and says whether this client can use
// them: they listen on the core host's loopback, which is the client's
// localhost only when the client is on that host.
func (p *Plugin) handleList(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"forwards": p.List(), "available": c.SameHost})
}

// handleForward makes (or finds) the forward of {port} on the machine. A
// client that is not on the core's host gets none (403 forward_local_only):
// its localhost is another computer. The local machine needs none.
func (p *Plugin) handleForward(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Port int `json:"port"`
	}
	if err := plugin.ReadJSON(r, 4<<10, &body); err != nil {
		plugin.WriteError(w, err)
		return
	}
	c.AuditField("port", body.Port)
	switch {
	case !c.SameHost:
		plugin.WriteJSON(w, http.StatusForbidden, map[string]string{"error": "forward_local_only", "message": "forwards listen on the core's host: open the UI on that host"})
	case c.Machine.Local():
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "local_machine", "message": "the local machine's ports need no forward"})
	case body.Port < 1 || body.Port > 65535:
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "port is 1 to 65535"})
	default:
		f, err := p.ensure(c.Host, c.Machine.ID(), body.Port)
		if err != nil {
			plugin.WriteError(w, err)
			return
		}
		c.AuditField("local", f.Local)
		plugin.WriteJSON(w, http.StatusOK, f)
	}
}

func (p *Plugin) handleStop(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	port, err := strconv.Atoi(r.PathValue("port"))
	if err != nil {
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "port is a number"})
		return
	}
	k := key{c.Machine.ID(), port}
	if p.closeWhere(func(f *forward) bool { return f.key == k }) == 0 {
		plugin.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "no such forward"})
		return
	}
	plugin.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleListening lists the TCP ports the user's programs listen on, on
// the machine's loopback or every address: what a forward could reach.
func (p *Plugin) handleListening(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	var out struct {
		Ports []struct {
			Port    int    `json:"port"`
			Process string `json:"process,omitempty"`
		} `json:"ports"`
	}
	if err := plugin.Request(ctx, c.Machine, ID, "listening", nil, &out); err != nil {
		plugin.WriteError(w, err)
		return
	}
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"ports": append(out.Ports[:0:0], out.Ports...)})
}
