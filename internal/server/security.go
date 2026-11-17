package server

import (
	"crypto/subtle"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"herdr-ide/internal/brand"
	"herdr-ide/internal/plugin"
)

// Security model (see SECURITY.md): the core has no login of its own. It
// trusts whoever can reach it, so it listens on loopback behind an
// authenticating reverse proxy. The guards here limit the damage of a
// misconfiguration and of hostile web pages:
//
//   - Host/Origin allowlist (DNS rebinding, cross-site WebSocket hijacking);
//   - optional proxy secret header for requests not from loopback;
//   - the method allowlist of /api/v1/term (term.go): clients reach the
//     terminal core's terminals and documents, never its machines, files
//     or server;
//   - read-only mode;
//   - CSP and framing headers on our pages;
//   - an audit log of security-relevant actions.

// ProxySecretHeader carries the shared secret from the reverse proxy.
const ProxySecretHeader = "X-" + brand.Name + "-Proxy-Secret"

// defaultUserHeaders identify the authenticated user for the audit log when
// --user-header is not set.
var defaultUserHeaders = []string{"Tailscale-User-Login", "X-Forwarded-User", "X-Auth-Request-User", "Remote-User", "X-Forwarded-Email"}

func isLoopbackAddr(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// sameHost reports whether r comes from a program of the core's own host
// that talks to the loopback address directly: a loopback peer, a loopback
// Host, and no proxy in between (a proxy on the same host keeps the public
// Host or adds X-Forwarded-For).
func sameHost(r *http.Request) bool {
	return isLoopbackAddr(r.RemoteAddr) && isLoopbackHost(hostOnly(r.Host)) && r.Header.Get("X-Forwarded-For") == ""
}

// proxySecretOK reports whether r carries the proxy secret, or needs none: a
// browser on this host talking to the loopback address directly.
func (s *Server) proxySecretOK(r *http.Request) bool {
	if s.opts.ProxySecret == "" {
		return true
	}
	if sameHost(r) {
		return true
	}
	got := r.Header.Get(ProxySecretHeader)
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.opts.ProxySecret)) == 1
}

// appCSP is the policy of the UI shell for r. 'unsafe-inline' styles are
// needed by React inline styles; scripts come only from our origin.
// 'wasm-unsafe-eval' lets the page compile WebAssembly (the terminal
// emulator, served from our origin, and the small module that hands it the
// page's callbacks); it does not allow eval or inline scripts.
//
// Frames are the UI's own (VS Code's windows) and, for the browser pane,
// pages of other ports under the loopback name the UI is not served from
// (frameSources): a port forwarded from a machine, a service of the
// computer. Those are other origins, which the frame keeps apart from the
// UI, and the guard refuses their requests to the core (originAllowed).
func (s *Server) appCSP(r *http.Request) string {
	frames := "'self'"
	// The desktop app shows its browser panes in webviews, which this
	// policy does not govern: its page frames nothing but the UI's own.
	if s.clientOf(r) != plugin.Desktop {
		frames += frameSources(r.Host)
	}
	return "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; " +
		"frame-src " + frames + "; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'"
}

// frameSources is what a page served under host (a Host header) may frame
// beside itself: the http pages of the other loopback name than its own,
// under any port. Cookies ignore ports, so a frame under the UI's own name
// would share the cookies of the UI's host, also a frame that went there
// by itself: the policy names the other name only, as the page does when
// it loads one (otherHost in web/src/plugins/browser/api.ts). Any other
// host (a reverse proxy's name, [::1]) frames no loopback page: its
// localhost is not known to be the core's.
func frameSources(host string) string {
	switch strings.ToLower(hostOnly(host)) {
	case "localhost":
		return " http://127.0.0.1:*"
	case "127.0.0.1":
		return " http://localhost:*"
	}
	return ""
}

func securityHeaders(h http.Header) {
	h.Set("X-Content-Type-Options", "nosniff")
	// Same-origin requests keep their Origin (a POST under no-referrer would
	// carry "Origin: null", which the guard refuses); other sites get no
	// referrer.
	h.Set("Referrer-Policy", "same-origin")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
}

// auditor writes JSON lines; nil writer disables it.
type auditor struct {
	mu     sync.Mutex
	enc    *json.Encoder
	header string
}

func (a *auditor) user(r *http.Request) string {
	if r == nil {
		return ""
	}
	if a.header != "" {
		return r.Header.Get(a.header)
	}
	for _, h := range defaultUserHeaders {
		if v := r.Header.Get(h); v != "" {
			return v
		}
	}
	return ""
}

func (a *auditor) log(r *http.Request, event string, fields map[string]any) {
	if a == nil || a.enc == nil {
		return
	}
	rec := map[string]any{"time": time.Now().UTC().Format(time.RFC3339Nano), "event": event}
	if r != nil {
		rec["remote"] = r.RemoteAddr
		if f := r.Header.Get("X-Forwarded-For"); f != "" {
			rec["forwarded_for"] = f
		}
		if u := a.user(r); u != "" {
			rec["user"] = u
		}
	}
	for k, v := range fields {
		rec[k] = v
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_ = a.enc.Encode(rec)
}
