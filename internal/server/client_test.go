package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/registry"
	"herdr-ide/internal/settings"
)

// The core tells the page which kind of client it is, from the token of
// the request, in GET /api/settings (with the values of the switches) and
// GET /api/config.
func TestClientReported(t *testing.T) {
	token := strings.Repeat("Z9", 20)
	s := newTestServer()
	s.opts.Settings = settings.New("", registry.Settings()...)
	s.opts.DesktopToken = token
	h := s.Handler()
	client := func(path, cookie string) string {
		r := httptest.NewRequest("GET", path, nil)
		r.Host = "127.0.0.1:7780"
		if cookie != "" {
			r.Header.Set("Cookie", cookie)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		var j struct{ Client string }
		if err := json.Unmarshal(w.Body.Bytes(), &j); err != nil {
			t.Fatalf("%s: %v %s", path, err, w.Body)
		}
		return j.Client
	}
	for _, path := range []string{"/api/settings", "/api/config"} {
		if got := client(path, DesktopCookie+"="+token); got != "desktop" {
			t.Errorf("%s with the token: %q", path, got)
		}
		if got := client(path, ""); got != "browser" {
			t.Errorf("%s without: %q", path, got)
		}
		if got := client(path, DesktopCookie+"="+strings.ToLower(token)); got != "browser" {
			t.Errorf("%s with another token: %q", path, got)
		}
	}
}

// The desktop app's token stays in the core: the cookie that carries it is
// removed from requests forwarded to code-server, the others are kept.
func TestDesktopCookieNotForwarded(t *testing.T) {
	h := http.Header{}
	h.Add("Cookie", "a=1; "+DesktopCookie+"=secret; b=2")
	h.Add("Cookie", DesktopCookie+"=again")
	stripDesktopCookie(h)
	if got := h.Values("Cookie"); len(got) != 1 || got[0] != "a=1; b=2" {
		t.Fatalf("cookies %q", got)
	}
	h = http.Header{"Cookie": {DesktopCookie + "=secret"}}
	stripDesktopCookie(h)
	if _, ok := h["Cookie"]; ok {
		t.Fatalf("cookies %q", h.Values("Cookie"))
	}
	// A cookie whose name only begins like it stays.
	h = http.Header{"Cookie": {DesktopCookie + "-x=1"}}
	stripDesktopCookie(h)
	if h.Get("Cookie") != DesktopCookie+"-x=1" {
		t.Fatalf("cookies %q", h.Values("Cookie"))
	}

	s := newTestServer()
	s.opts.DesktopToken = strings.Repeat("t", 64)
	mc := machines.NewManager([]machines.Spec{{ID: "m", Label: "m", Kind: machines.KindSSH, Target: "m"}}, nil, log.New(io.Discard, "", 0)).Get("m")
	in := httptest.NewRequest("GET", "/m/m/code/static/x.js", nil)
	in.Host = "127.0.0.1:7781"
	in.Header.Set("Cookie", DesktopCookie+"="+s.opts.DesktopToken+"; vscode-tkn=1")
	in.Header.Set(ProxySecretHeader, "s")
	out := in.Clone(context.Background())
	s.csProxy.proxy(mc).Rewrite(&httputil.ProxyRequest{In: in, Out: out})
	if got := out.Header.Get("Cookie"); got != "vscode-tkn=1" {
		t.Fatalf("forwarded cookies %q", got)
	}
	if out.Header.Get(ProxySecretHeader) != "" || out.URL.Path != "/static/x.js" {
		t.Fatalf("forwarded %v %s", out.Header, out.URL)
	}

	// Nor does code-server's answer reach past VS Code's switch: it may
	// not widen a service worker's scope (to the UI's pages) nor set the
	// desktop app's cookie; its other cookies stay.
	resp := &http.Response{Header: http.Header{
		"Service-Worker-Allowed": {"/"},
		"Set-Cookie": {
			"vscode-tkn=1; Path=/",
			DesktopCookie + "=planted; Path=/; HttpOnly",
			" " + DesktopCookie + " =again",
			DesktopCookie + "-x=kept",
		},
	}}
	if err := s.csProxy.proxy(mc).ModifyResponse(resp); err != nil {
		t.Fatal(err)
	}
	if _, ok := resp.Header["Service-Worker-Allowed"]; ok {
		t.Fatalf("Service-Worker-Allowed passed: %q", resp.Header.Values("Service-Worker-Allowed"))
	}
	if got := resp.Header.Values("Set-Cookie"); len(got) != 2 || got[0] != "vscode-tkn=1; Path=/" || got[1] != DesktopCookie+"-x=kept" {
		t.Fatalf("cookies set %q", got)
	}
	if resp.Header.Get("X-Frame-Options") != "SAMEORIGIN" {
		t.Fatalf("X-Frame-Options %q", resp.Header.Get("X-Frame-Options"))
	}
}

// Messages of VS Code's windows reach only the pages for which VS Code is
// on: a browser whose switch is off gets nothing of VS Code's while the
// desktop app's is on, and the other way round.
func TestBridgeMessagesFollowTheClientsSwitch(t *testing.T) {
	st := settings.New("", registry.Settings()...)
	s := newTestServer()
	s.opts.Settings = st
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	page := func(c plugin.Client) *wsClient {
		w := &wsClient{s: s, ctx: ctx, cancel: cancel, send: make(chan []byte, 8), client: c}
		s.clients[w] = true
		return w
	}
	desktop, browser := page(plugin.Desktop), page(plugin.Browser)
	got := func(c *wsClient) bool {
		select {
		case <-c.send:
			return true
		default:
			return false
		}
	}
	send := func() { s.bridge.broadcast(map[string]any{"t": "bridge.send", "m": "m", "text": "@x"}) }
	send()
	if got(desktop) || got(browser) {
		t.Fatal("VS Code off: a page got its message")
	}
	st.Set("plugins.vscode.enabled", "", true)
	send()
	if !got(desktop) || got(browser) {
		t.Fatal("only the desktop app's switch on")
	}
	st.Set("plugins.vscode.enabled", "", false)
	st.Set("plugins.vscode.browser", "", true)
	send()
	if got(desktop) || !got(browser) {
		t.Fatal("only the browsers' switch on")
	}
	// Other messages reach every page.
	s.broadcast(map[string]any{"t": "machines"})
	if !got(desktop) || !got(browser) {
		t.Fatal("other messages")
	}
}

// The desktop shell's relays open with the key derived from the launch's
// verify key, for the additional data they were sealed with only: the
// vectors the shell's tests check too (design/testdata/vault-unlock).
func TestDesktopRelay(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "design", "testdata", "vault-unlock", "relay.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		VerifyKey string `json:"verifyKey"`
		RelayKey  string `json:"relayKey"`
		Relays    []struct {
			Purpose, Nonce, ID, AD, Plaintext, Relay string
		} `json:"relays"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	b64 := base64.RawURLEncoding
	key, err := relayKey(v.VerifyKey)
	if err != nil || b64.EncodeToString(key) != v.RelayKey {
		t.Fatalf("relay key %x %v, want %s", key, err, v.RelayKey)
	}
	s := newTestServer()
	if s.desktopRelay() != nil {
		t.Fatal("a relay opens without the shell's key")
	}
	s.opts.DesktopVerifyKey = v.VerifyKey
	open := s.desktopRelay()
	if len(v.Relays) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range v.Relays {
		relay, err := b64.DecodeString(c.Relay)
		if err != nil {
			t.Fatal(err)
		}
		ad := "vault-relay\n" + c.Purpose + "\n" + c.Nonce + "\n" + c.ID
		if ad != c.AD {
			t.Errorf("additional data %q, want %q", ad, c.AD)
		}
		plain, err := open([]byte(ad), relay)
		if err != nil || string(plain) != c.Plaintext {
			t.Errorf("%s %s: %q %v", c.Purpose, c.ID, plain, err)
		}
		// Not for another purpose, nonce or entry, nor changed.
		for _, other := range []string{
			"vault-relay\nregister\n" + c.Nonce + "\n" + c.ID,
			"vault-relay\nsession\n" + c.Nonce + "x\n" + c.ID,
			"vault-relay\n" + c.Purpose + "\n" + c.Nonce + "\nu9",
		} {
			if other == ad {
				continue
			}
			if _, err := open([]byte(other), relay); err == nil {
				t.Errorf("%q opened a relay for %q", other, ad)
			}
		}
		bad := append([]byte{}, relay...)
		bad[len(bad)-1] ^= 1
		if _, err := open([]byte(ad), bad); err == nil {
			t.Error("a changed relay opened")
		}
		if _, err := open([]byte(ad), relay[:27]); err == nil {
			t.Error("a short relay opened")
		}
	}
	// Another launch's key opens none.
	s.opts.DesktopVerifyKey = strings.Repeat("0", 64)
	c := v.Relays[0]
	relay, _ := b64.DecodeString(c.Relay)
	if _, err := s.desktopRelay()([]byte(c.AD), relay); err == nil {
		t.Error("another launch's key opened a relay")
	}
}
