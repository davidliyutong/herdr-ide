package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"

	"herdr-ide/internal/brand"
	"herdr-ide/internal/plugin"
)

// Which client a request comes from (SECURITY.md): the desktop app's
// windows or a browser. VS Code's windows run on the UI's origin, where
// their scripts can do whatever the page can, so each kind of client has
// its own switch for them (plugin.BrowserRisk), and the core applies the
// requesting client's.
//
// The desktop app proves itself with a token of its launch: 32 random
// bytes it hands the core it starts on stdin (--parent-stdio's hello,
// never in an environment that terminals, agents or code-server could
// inherit) and sets as an HttpOnly, SameSite=Strict, host-only session
// cookie for the core's origin in its own Electron session before it
// loads the page, so every request of its windows carries it, VS Code's
// frames, workers and WebSockets included. Page scripts cannot read an
// HttpOnly cookie, browsers never get it, and the proxy removes it from
// what reaches code-server. Anything else is a browser: no token
// configured, no cookie, or a wrong one.

// DesktopCookie names the cookie that carries the desktop app's token.
const DesktopCookie = brand.Slug + "-desktop"

// clientOf tells which kind of client r comes from: the desktop app when
// one of its cookies named DesktopCookie holds this launch's token
// (compared in constant time), else a browser.
func (s *Server) clientOf(r *http.Request) plugin.Client {
	token := s.opts.DesktopToken
	if token == "" {
		return plugin.Browser
	}
	desktop := false
	// A script may add cookies of the same name (for another path, which
	// come first); any that holds the token proves the desktop app.
	for _, c := range r.CookiesNamed(DesktopCookie) {
		if subtle.ConstantTimeCompare([]byte(c.Value), []byte(token)) == 1 {
			desktop = true
		}
	}
	if desktop {
		return plugin.Desktop
	}
	return plugin.Browser
}

// desktopProof checks MACs of the desktop app's shell (plugin.Call): HMAC
// with SHA-256 and the key of this launch, which the shell's main process
// keeps to itself and uses only after a prompt of the system the user
// answered. Nil without a key.
func (s *Server) desktopProof() func(msg, mac []byte) bool {
	key := s.opts.DesktopVerifyKey
	if key == "" {
		return nil
	}
	return func(msg, mac []byte) bool {
		h := hmac.New(sha256.New, []byte(key))
		h.Write(msg)
		return hmac.Equal(h.Sum(nil), mac)
	}
}

// stripSetDesktopCookie removes from h (a response of code-server) every
// Set-Cookie that names the desktop app's cookie, which would replace or
// shadow the token of its launch; the others stay.
func stripSetDesktopCookie(h http.Header) {
	lines := h.Values("Set-Cookie")
	var kept []string
	for _, line := range lines {
		name, _, _ := strings.Cut(line, "=")
		if strings.TrimSpace(name) != DesktopCookie {
			kept = append(kept, line)
		}
	}
	if len(kept) == len(lines) {
		return
	}
	h.Del("Set-Cookie")
	for _, line := range kept {
		h.Add("Set-Cookie", line)
	}
}

// stripDesktopCookie removes the desktop app's cookie from the Cookie
// headers of h (a request forwarded to code-server), keeping the others.
func stripDesktopCookie(h http.Header) {
	lines := h.Values("Cookie")
	if len(lines) == 0 {
		return
	}
	var kept []string
	for _, line := range lines {
		for _, part := range strings.Split(line, ";") {
			name, _, _ := strings.Cut(strings.TrimSpace(part), "=")
			if strings.TrimSpace(part) == "" || strings.TrimSpace(name) == DesktopCookie {
				continue
			}
			kept = append(kept, strings.TrimSpace(part))
		}
	}
	h.Del("Cookie")
	if len(kept) > 0 {
		h.Set("Cookie", strings.Join(kept, "; "))
	}
}
