// Package server exposes the web UI, the WebSocket protocol and the HTTP
// endpoints (files, code-server proxy) of the herdr-ide core.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
	"herdr-ide/internal/codeserver"
	"herdr-ide/internal/gui"
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
	// ControlDir holds ssh control sockets (used by interactive auth).
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
	// Settings are the core settings the UI can change; nil disables them.
	Settings *settings.Store
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
	gui     *gui.Manager

	clientsMu sync.Mutex
	clients   map[*wsClient]bool

	surf surfaces

	audit *auditor
}

// New creates a server for the machine manager.
func New(mg *machines.Manager, opts Options) *Server {
	s := &Server{opts: opts, mg: mg, logger: opts.Logger, origins: map[string]bool{}, hosts: map[string]bool{},
		cs: opts.CodeServer, clients: map[*wsClient]bool{}}
	s.surf.sessions = map[string]*surfSession{}
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
	mg.Subscribe(func(st machines.State) {
		if st.Status == machines.StatusReady || st.Status == machines.StatusDegraded {
			s.wakeSurface(st.ID)
		}
	}, func(machines.AgentEvent) {})
	return s
}

// Handler returns the root handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", s.handleWS)
	mux.HandleFunc("GET /api/config", s.handleConfig)
	mux.HandleFunc("GET /api/settings", s.handleSettings)
	mux.HandleFunc("PUT /api/settings", s.writable(s.handleSetSetting))
	mux.HandleFunc("GET /api/machines", s.handleMachines)
	mux.HandleFunc("GET /api/keymap", s.handleKeymap)
	mux.HandleFunc("PUT /api/m/{id}/enabled", s.writable(s.handleMachineEnabled))
	mux.HandleFunc("GET /api/m/{id}/auth", s.writable(s.handleAuth))
	mux.HandleFunc("POST /api/m/{id}/bridge", s.writable(s.handleBridge))
	mux.HandleFunc("GET /api/m/{id}/file", s.handleFile)
	mux.HandleFunc("POST /api/m/{id}/upload", s.writable(s.handleUpload))
	mux.HandleFunc("GET /api/m/{id}/list", s.handleList)
	mux.HandleFunc("GET /api/m/{id}/code/status", s.handleCodeStatus)
	mux.HandleFunc("POST /api/m/{id}/code/start", s.writable(s.handleCodeStart))
	mux.HandleFunc("POST /api/m/{id}/code/stop", s.handleCodeStop)
	mux.HandleFunc("/m/{id}/code", func(w http.ResponseWriter, r *http.Request) {
		u := *r.URL
		u.Path += "/"
		http.Redirect(w, r, u.String(), http.StatusFound)
	})
	mux.Handle("/m/{id}/code/", s.writable(s.csProxy.ServeHTTP))
	mux.HandleFunc("GET /m/{id}/gui/{win}", s.handleGUIPage)
	mux.HandleFunc("GET /m/{id}/gui/{win}/ws", s.handleGUIWS)
	mux.HandleFunc("POST /m/{id}/gui/{win}/close", s.writable(s.handleGUIClose))
	mux.HandleFunc("POST /api/m/{id}/gui/enable", s.writable(s.handleGUIEnable))
	mux.HandleFunc("GET /api/m/{id}/herdr", s.handleHerdrStatus)
	mux.HandleFunc("POST /api/m/{id}/herdr/{action}", s.writable(s.handleHerdrAction))
	mux.HandleFunc("GET /api/m/{id}/herdr/remote", s.writable(s.handleHerdrRemote))
	if s.opts.Static != nil {
		mux.Handle("/", spaHandler(s.opts.Static))
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

// handleSettings lists the core settings with their definitions, so the UI
// renders the form without knowing them in advance.
func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	list := []settings.Entry{}
	if s.opts.Settings != nil {
		list = s.opts.Settings.List()
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": list, "read_only": s.opts.ReadOnly})
}

// handleSetSetting changes one setting. Errors are codes the UI translates.
func (s *Server) handleSetSetting(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key   string `json:"key"`
		Value string `json:"value"`
		// Machine sets that machine's own value of a per-machine setting.
		Machine string `json:"machine"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid", "detail": err.Error()})
		return
	}
	if s.opts.Settings == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown"})
		return
	}
	if req.Machine != "" {
		mc := s.mg.Get(req.Machine)
		if mc == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown"})
			return
		}
		for _, e := range s.opts.Settings.List() {
			if e.Key == req.Key && e.PerMachine == settings.ScopeRemote && mc.Local() {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid", "detail": req.Key + " applies to remote machines only"})
				return
			}
		}
	}
	err := s.opts.Settings.SetFor(req.Key, req.Machine, req.Value)
	switch {
	case err == nil:
		s.audit.log(r, "settings.set", map[string]any{"key": req.Key, "value": req.Value, "machine": req.Machine})
		writeJSON(w, http.StatusOK, map[string]any{"settings": s.opts.Settings.List()})
	case errors.Is(err, settings.ErrUnknown):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown"})
	case errors.Is(err, settings.ErrLocked):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "locked"})
	case errors.Is(err, settings.ErrInvalid):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid", "detail": err.Error()})
	default:
		s.logger.Printf("saving settings: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "save", "detail": err.Error()})
	}
}

func (s *Server) handleMachines(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.mg.States())
}

// handleMachineEnabled enables or disables a machine ({"enabled": bool}):
// saved in the core's own file over herdr's catalog, applied at once. The
// reply is the machine's state.
func (s *Server) handleMachineEnabled(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&body); err != nil || body.Enabled == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid"})
		return
	}
	event := "machine.disable"
	if *body.Enabled {
		event = "machine.enable"
	}
	ev := map[string]any{"machine": mc.ID()}
	if err := s.mg.SetEnabled(mc.ID(), *body.Enabled); err != nil {
		ev["error"] = err.Error()
		s.audit.log(r, event, ev)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "save", "detail": err.Error()})
		return
	}
	s.audit.log(r, event, ev)
	writeJSON(w, http.StatusOK, mc.State())
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
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
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
		w.Header().Set("Content-Security-Policy", appCSP)
		if strings.HasPrefix(p, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}
