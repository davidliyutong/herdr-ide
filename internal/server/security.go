package server

import (
	"crypto/subtle"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"webherdr/internal/brand"
	"webherdr/internal/machines"
)

// Security model (see SECURITY.md): the core has no login of its own. It
// trusts whoever can reach it, so it listens on loopback behind an
// authenticating reverse proxy. The guards here limit the damage of a
// misconfiguration and of hostile web pages:
//
//   - Host/Origin allowlist (DNS rebinding, cross-site WebSocket hijacking);
//   - optional proxy secret header for requests not from loopback;
//   - herdr API method allowlist (the UI cannot stop servers, install
//     integrations or link plugins);
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

// proxySecretOK reports whether r carries the proxy secret, or needs none: a
// browser on this host talking to the loopback address directly.
func (s *Server) proxySecretOK(r *http.Request) bool {
	if s.opts.ProxySecret == "" {
		return true
	}
	if isLoopbackAddr(r.RemoteAddr) && isLoopbackHost(hostOnly(r.Host)) && r.Header.Get("X-Forwarded-For") == "" {
		return true
	}
	got := r.Header.Get(ProxySecretHeader)
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.opts.ProxySecret)) == 1
}

// apiAllowed decides which herdr methods browsers may call. Everything the
// UI needs is allowed; server administration, integrations, plugin
// installation and raw event streams are not.
func (s *Server) apiAllowed(method string) bool {
	if s.opts.ReadOnly {
		return machines.IsReadOnlyMethod(method)
	}
	switch method {
	case "session.snapshot", "plugin.list", "plugin.action.list", "plugin.action.invoke", "notification.show":
		return true
	}
	for _, p := range []string{"workspace.", "tab.", "pane.", "agent.", "layout.", "worktree."} {
		if strings.HasPrefix(method, p) {
			return true
		}
	}
	return false
}

// appCSP applies to the UI shell. 'unsafe-inline' styles are needed by
// xterm.js and React inline styles; scripts come only from our origin.
const appCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; " +
	"frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'"

func securityHeaders(h http.Header) {
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
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
