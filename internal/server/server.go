// Package server exposes the web UI, the WebSocket protocol and the HTTP
// endpoints (files, code-server proxy) of the herdr-ide core.
package server

import (
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
	"herdr-ide/internal/codeserver"
	"herdr-ide/internal/gui"
	"herdr-ide/internal/keybindings"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/settings"
)

// Options configures the server.
type Options struct {
	// AllowedOrigins are extra browser origins (scheme://host[:port]) allowed
	// to use the API, typically the reverse proxy's public origin.
	AllowedOrigins []string
	// Static serves the built web UI; nil disables static serving.
	Static fs.FS
	Logger *log.Logger
	// ControlDir holds ssh control sockets, which keep an interactive
	// login for the connections that follow (handleAuth). Empty where ssh
	// shares no connections (Windows): there is no login in the UI then.
	ControlDir string
	// CodeServer provisions code-server on machines.
	CodeServer *codeserver.Manager
	// CodeServerIdle stops code-server after this long without VS Code
	// connections; 0 keeps it running while the agent lives.
	CodeServerIdle time.Duration
	// ReadOnly allows watching only (see SECURITY.md).
	ReadOnly bool
	// ProxySecret, when set, must be sent by the reverse proxy in
	// ProxySecretHeader on requests that do not come from loopback.
	ProxySecret string
	// Audit receives JSON lines of security-relevant events.
	Audit io.Writer
	// UserHeader names the header with the authenticated user (audit log).
	UserHeader string
	// HC returns the gzip-compressed herdr-core executable this build
	// carries for a platform and the SHA-256 of the executable; nil or an
	// error leaves machines with the herdr-core they have.
	HC func(goos, goarch string) (gz []byte, digest string, err error)
	// Settings are the settings of the core and the UIs; nil disables them.
	Settings *settings.Store
	// Keybindings are the UIs' keybindings; nil disables them.
	Keybindings *keybindings.Store
}

// Server is the HTTP front of the core.
type Server struct {
	opts    Options
	mg      *machines.Manager
	logger  *log.Logger
	origins map[string]bool
	hosts   map[string]bool
	csProxy *codeServerProxy
	cs      *codeserver.Manager
	bridge  *bridgeHub
	// downloads the pages follow in their downloads panel
	downloads downloadsHub
	gui       *gui.Manager
	// displayEnv is the environment of a machine's virtual display that new
	// terminals get (gui.Manager.PaneEnv; tests replace it).
	displayEnv func(*machines.Machine) map[string]string
	// home is the core host user's home directory, whose ~/.ssh/config the
	// Add Machine dialog lists (os.UserHomeDir; tests replace it).
	home func() (string, error)

	clientsMu sync.Mutex
	clients   map[*wsClient]bool

	term termHub

	audit *auditor
}

// New creates a server for the machine manager.
func New(mg *machines.Manager, opts Options) *Server {
	s := &Server{opts: opts, mg: mg, logger: opts.Logger, origins: map[string]bool{}, hosts: map[string]bool{},
		cs: opts.CodeServer, clients: map[*wsClient]bool{}, home: os.UserHomeDir}
	s.term = termHub{s: s, backends: map[string]*termBackend{}}
	if s.cs == nil {
		s.cs = codeserver.New(opts.Logger)
	}
	s.bridge = newBridgeHub(s)
	s.audit = &auditor{header: opts.UserHeader}
	if opts.Audit != nil {
		s.audit.enc = json.NewEncoder(opts.Audit)
	}
	mg.SetStreamHandler(s.handleAgentStream)
	for _, o := range opts.AllowedOrigins {
		u, err := url.Parse(strings.TrimRight(o, "/"))
		if err != nil || u.Host == "" {
			s.logger.Printf("ignoring invalid --allowed-origin %q", o)
			continue
		}
		s.origins[strings.ToLower(u.Scheme+"://"+u.Host)] = true
		s.hosts[strings.ToLower(u.Hostname())] = true
	}
	s.csProxy = newCodeServerProxy(s)
	s.initGUI()
	s.displayEnv = s.gui.PaneEnv
	s.initSettings()
	// A machine that connects (again) ends the wait of its terminal backend.
	var readyMu sync.Mutex
	ready := map[string]bool{}
	mg.Subscribe(func(st machines.State) {
		now := st.Status == machines.StatusReady
		readyMu.Lock()
		prev := ready[st.ID]
		ready[st.ID] = now
		readyMu.Unlock()
		if now && !prev {
			s.term.wakeUp(st.ID)
		}
	}, func(machines.AgentEvent) {})
	return s
}

// route is a pattern of the server's mux and its handler.
type route struct {
	pattern string
	handler http.HandlerFunc
}

// routes are every pattern the server answers (Handler registers exactly
// these; the tests walk them to check the guards of each).
func (s *Server) routes() []route {
	rs := []route{
		{"GET /ws", s.handleWS},
		{"GET /api/v1/term", s.handleTermWS},
		{"GET /api/config", s.handleConfig},
		{"GET /api/settings", s.handleSettings},
		{"PUT /api/settings", s.writable(s.handleSetSetting)},
		{"DELETE /api/settings", s.writable(s.handleResetSetting)},
		{"GET /api/keybindings", s.handleKeybindings},
		{"PUT /api/keybindings", s.writable(s.handleSetKeybindings)},
		{"GET /api/machines", s.handleMachines},
		{"POST /api/machines", s.writable(s.handleMachineAdd)},
		{"GET /api/ssh/hosts", s.writable(s.handleSSHHosts)},
		{"DELETE /api/m/{id}", s.writable(s.handleMachineRemove)},
		{"PUT /api/m/{id}/label", s.writable(s.handleMachineRename)},
		{"PUT /api/m/{id}/enabled", s.writable(s.handleMachineEnabled)},
		{"GET /api/m/{id}/hc", s.handleHCStatus},
		{"POST /api/m/{id}/hc/{action}", s.writable(s.handleHCAction)},
		{"GET /api/m/{id}/privacy", s.handlePrivacy},
		{"GET /api/m/{id}/auth", s.writable(s.handleAuth)},
		{"POST /api/m/{id}/bridge", s.writable(s.handleBridge)},
		{"GET /api/m/{id}/file", s.handleFile},
		{"GET /api/m/{id}/download", s.handleDownload},
		{"POST /api/m/{id}/upload", s.writable(s.handleUpload)},
		{"GET /api/m/{id}/list", s.handleList},
		{"GET /api/m/{id}/code/status", s.handleCodeStatus},
		{"POST /api/m/{id}/code/start", s.writable(s.handleCodeStart)},
		{"POST /api/m/{id}/code/stop", s.handleCodeStop},
		{"/m/{id}/code", func(w http.ResponseWriter, r *http.Request) {
			u := *r.URL
			u.Path += "/"
			http.Redirect(w, r, u.String(), http.StatusFound)
		}},
		{"/m/{id}/code/", s.writable(s.csProxy.ServeHTTP)},
		{"GET /m/{id}/gui/{win}", s.handleGUIPage},
		{"GET /m/{id}/gui/{win}/ws", s.handleGUIWS},
		{"POST /m/{id}/gui/{win}/close", s.writable(s.handleGUIClose)},
		{"POST /api/m/{id}/gui/enable", s.writable(s.handleGUIEnable)},
		{"GET /api/gui", s.handleGUIStates},
	}
	if s.opts.Static != nil {
		rs = append(rs,
			route{"/", spaHandler(s.opts.Static).ServeHTTP})
	}
	return rs
}

// Handler returns the root handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	for _, rt := range s.routes() {
		mux.HandleFunc(rt.pattern, rt.handler)
	}
	return s.guard(mux)
}

func isLoopbackHost(h string) bool {
	h = strings.ToLower(h)
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return strings.Trim(h, "[]")
	}
	return strings.Trim(hostport, "[]")
}

// guard rejects requests whose Host or Origin is not expected. This blocks DNS
// rebinding and cross-site WebSocket hijacking; authentication itself is the
// reverse proxy's job (see security.go).
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		securityHeaders(w.Header())
		if !s.proxySecretOK(r) {
			s.audit.log(r, "denied.proxy_secret", map[string]any{"path": r.URL.Path})
			http.Error(w, brand.Slug+": missing or wrong "+ProxySecretHeader, http.StatusForbidden)
			return
		}
		host := strings.ToLower(hostOnly(r.Host))
		if !isLoopbackHost(host) && !s.hosts[host] {
			http.Error(w, brand.Slug+": host not allowed (add --allowed-origin)", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && !s.originAllowed(origin) {
			// Same-origin GETs of static assets never carry a foreign Origin;
			// anything that does is refused.
			http.Error(w, brand.Slug+": origin not allowed", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) originAllowed(origin string) bool {
	if origin == "null" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if isLoopbackHost(u.Hostname()) {
		return true
	}
	return s.origins[strings.ToLower(u.Scheme+"://"+u.Host)]
}

// broadcast sends a JSON message to every connected browser.
func (s *Server) broadcast(v any) {
	s.clientsMu.Lock()
	clients := make([]*wsClient, 0, len(s.clients))
	for c := range s.clients {
		clients = append(clients, c)
	}
	s.clientsMu.Unlock()
	for _, c := range clients {
		c.sendJSON(v)
	}
}

// maxIdle bounds the idle time a browser reports.
const maxIdle = 30 * 24 * time.Hour

// markActive records that the user used the page of c idle ago. Browsers
// report durations rather than times, so their clocks do not matter.
func (s *Server) markActive(c *wsClient, idle time.Duration) {
	idle = min(max(idle, 0), maxIdle)
	s.clientsMu.Lock()
	c.active = time.Now().Add(-idle)
	s.clientsMu.Unlock()
}

// soundClient returns the browser that plays notification sounds: the one
// used most recently, so that several open browsers do not all sound.
func (s *Server) soundClient() *wsClient {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	var best *wsClient
	for c := range s.clients {
		if best == nil || c.active.After(best.active) {
			best = c
		}
	}
	return best
}

// writable wraps handlers that change state; they are refused in read-only
// mode.
func (s *Server) writable(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.opts.ReadOnly {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "read-only mode"})
			return
		}
		h(w, r)
	}
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"name":      brand.Name,
		"slug":      brand.Slug,
		"version":   agentproto.Version,
		"read_only": s.opts.ReadOnly,
		"ssh_login": s.opts.ControlDir != "",
	})
}

// Run performs background maintenance until ctx ends: code-server instances
// without VS Code connections are stopped after CodeServerIdle.
func (s *Server) Run(ctx context.Context) {
	if s.opts.CodeServerIdle <= 0 {
		<-ctx.Done()
		return
	}
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		for _, id := range s.csProxy.idle(s.opts.CodeServerIdle) {
			mc := s.mg.Get(id)
			if mc == nil {
				continue
			}
			s.logger.Printf("stopping idle code-server on %s", mc.Label())
			sctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			if err := s.cs.Stop(sctx, mc); err != nil {
				s.logger.Printf("stop code-server on %s: %v", mc.Label(), err)
			}
			cancel()
			s.audit.log(nil, "code_server.idle_stop", map[string]any{"machine": id})
		}
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func spaHandler(fsys fs.FS) http.Handler {
	files := http.FileServer(http.FS(fsys))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := fs.Stat(fsys, "index.html"); err != nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			io.WriteString(w, brand.Slug+": the web UI is not built into this binary; run scripts/build.sh\n")
			return
		}
		// Every page served here, the app shell on any path among them,
		// gets the policy that keeps scripts on our origin and the page out
		// of other sites' frames.
		w.Header().Set("Content-Security-Policy", appCSP)
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "api" || strings.HasPrefix(p, "api/") {
			// An API path no route took is not a page of the UI.
			http.NotFound(w, r)
			return
		}
		if p == "" {
			p = "index.html"
		}
		if _, err := fs.Stat(fsys, p); err != nil {
			// Client-side routes fall back to the app shell.
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			w.Header().Set("Cache-Control", "no-cache")
			files.ServeHTTP(w, r2)
			return
		}
		if strings.HasPrefix(p, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}
