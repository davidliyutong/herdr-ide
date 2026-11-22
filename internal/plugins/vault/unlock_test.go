package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/argon2"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
	vaultstore "herdr-ide/internal/vault"
)

// testShell is the desktop app's shell of the tests: the key of its launch
// (which the core opens relays and checks MACs with, as internal/server
// does), its install, its Secure Enclave key or Windows Hello key (a
// deterministic signature), and its own secret.
type testShell struct {
	verifyKey string
	install   string
	hello     bool
	se        *ecdh.PrivateKey
	helloKey  []byte
	secret    []byte
}

func newShell(t *testing.T, verifyKey, install string, hello bool) *testShell {
	t.Helper()
	se, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sh := &testShell{verifyKey: verifyKey, install: install, hello: hello, se: se, helloKey: make([]byte, 32), secret: make([]byte, 32)}
	rand.Read(sh.helloKey)
	rand.Read(sh.secret)
	return sh
}

func (sh *testShell) relayKey() []byte {
	k, err := hkdf.Key(sha256.New, []byte(sh.verifyKey), nil, "vault-relay v1", 32)
	if err != nil {
		panic(err)
	}
	return k
}

// open is the core's DesktopRelay for this launch.
func (sh *testShell) open(ad, relay []byte) ([]byte, error) {
	block, _ := aes.NewCipher(sh.relayKey())
	g, _ := cipher.NewGCM(block)
	if len(relay) < 28 {
		return nil, errors.New("short")
	}
	return g.Open(nil, relay[:12], relay[12:], ad)
}

// verify is the core's DesktopProof for this launch.
func (sh *testShell) verify(msg, mac []byte) bool {
	m := hmac.New(sha256.New, []byte(sh.verifyKey))
	m.Write(msg)
	return hmac.Equal(m.Sum(nil), mac)
}

func (sh *testShell) mac(nonce string, pu purpose) string {
	m := hmac.New(sha256.New, []byte(sh.verifyKey))
	m.Write(proofMessage(nonce, pu))
	return hex.EncodeToString(m.Sum(nil))
}

// seal seals v for the core as the shell does: iv ‖ ciphertext ‖ tag.
func (sh *testShell) seal(t *testing.T, ad string, v any) string {
	t.Helper()
	plain, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := aes.NewCipher(sh.relayKey())
	g, _ := cipher.NewGCM(block)
	iv := make([]byte, 12)
	rand.Read(iv)
	return enc(g.Seal(iv, iv, plain, []byte(ad)))
}

func (sh *testShell) signature(challenge []byte) []byte {
	m := hmac.New(sha512.New, sh.helloKey)
	m.Write(challenge)
	return m.Sum(nil)
}

// client is a desktop client of this launch.
func (sh *testShell) client(p *Plugin, h *fakeHost) *client {
	c := newClient(p, h)
	c.origin = "http://127.0.0.1:7781"
	c.kind, c.desktop, c.relay = plugin.Desktop, sh.verify, sh.open
	return c
}

// registration is the relay of this install's key for a register nonce
// whose challenge (for Hello) is challenge.
func (sh *testShell) registration(t *testing.T, nonce string, challenge []byte) string {
	t.Helper()
	ad := "vault-relay\nregister\n" + nonce + "\n"
	if sh.hello {
		return sh.seal(t, ad, map[string]any{"kind": "hello", "install": sh.install, "keyName": vaultstore.HelloKeyName(sh.install),
			"publicKey": enc([]byte("rsa public key")), "signature": enc(sh.signature(challenge)), "shellSecret": enc(sh.secret)})
	}
	return sh.seal(t, ad, map[string]any{"kind": "enclave", "install": sh.install, "sePub": enc(sh.se.PublicKey().Bytes()),
		"blob": enc([]byte("blob of " + sh.install)), "shellSecret": enc(sh.secret)})
}

// enroll adds the desktop authenticator, or this install's entry, in c's
// session of the passphrase.
func (sh *testShell) enroll(t *testing.T, c *client) map[string]any {
	t.Helper()
	nonce, _ := c.nonce(t, `{"for":"register"}`)
	code, pu := c.do("GET", "/api/p/vault/proof/"+nonce, "")
	reg, _ := pu["register"].(map[string]any)
	challenge := b64(reg["challenge"].(string))
	if code != 200 || len(challenge) != 32 {
		t.Fatalf("purpose of a registration: %d %v", code, pu)
	}
	body := map[string]string{"kind": "desktop", "label": "Touch ID", "passphrase": pass, "nonce": nonce,
		"mac": sh.mac(nonce, purpose{For: ForRegister}), "relay": sh.registration(t, nonce, challenge)}
	code, out := c.do("POST", "/api/p/vault/authenticators", mustJSON(body))
	if code != 200 {
		t.Fatalf("enroll %d %v", code, out)
	}
	return out
}

// entry is what the shell gets for a locked session's nonce: its install's
// unlock entry.
func (sh *testShell) entry(t *testing.T, c *client, nonce string) map[string]any {
	t.Helper()
	code, pu := c.do("GET", "/api/p/vault/proof/"+nonce, "")
	if code != 200 {
		t.Fatalf("purpose %d %v", code, pu)
	}
	list, _ := pu["unlock"].([]any)
	for _, x := range list {
		if e := x.(map[string]any); e["install"] == sh.install {
			return e
		}
	}
	t.Fatalf("no entry of %s in %v", sh.install, pu)
	return nil
}

// answer is the relay of an unlock with entry e for nonce: the Secure
// Enclave's ECDH secret with the core's ephemeral key, or the Hello key's
// signature of the entry's challenge, with the shell's secret.
func (sh *testShell) answer(t *testing.T, nonce string, e map[string]any) string {
	t.Helper()
	ad := "vault-relay\nsession\n" + nonce + "\n" + e["id"].(string)
	if sh.hello {
		challenge := b64(e["hello"].(map[string]any)["challenge"].(string))
		return sh.seal(t, ad, map[string]any{"signature": enc(sh.signature(challenge)), "shellSecret": enc(sh.secret)})
	}
	eph, err := ecdh.P256().NewPublicKey(b64(e["enclave"].(map[string]any)["ephPub"].(string)))
	if err != nil {
		t.Fatal(err)
	}
	z, _ := sh.se.ECDH(eph)
	return sh.seal(t, ad, map[string]any{"z": enc(z), "shellSecret": enc(sh.secret)})
}

// unlock unlocks the locked vault as the app does: a nonce, its entry, the
// prompt (answer) and POST session.
func (sh *testShell) unlock(t *testing.T, c *client) (int, map[string]any) {
	t.Helper()
	nonce, out := c.nonce(t, `{"for":"session"}`)
	if out["desktop"] != true {
		t.Fatalf("the app cannot unlock: %v", out)
	}
	e := sh.entry(t, c, nonce)
	return c.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"unlock": map[string]string{"nonce": nonce, "id": e["id"].(string), "relay": sh.answer(t, nonce, e)}}))
}

const launchKey = "01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da"

// failures is how many wrong guesses in a row the plugin counts.
func failures(p *Plugin) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.fails
}

// removedAudit is the audit record of an unlock entry's removal.
func removedAudit(id, kind, reason string) string {
	return `vault.unlock_removed {"id":"` + id + `","kind":"` + kind + `","reason":"` + reason + `"}`
}

// The desktop app unlocks a locked vault with its install's key (a Secure
// Enclave key behind Touch ID, a Windows Hello key): only the desktop
// client, with a relay sealed for this very nonce, purpose and entry, once;
// the session is a proof's. A relay that is refused guesses nothing and
// does not count as a wrong passphrase.
func TestDesktopUnlock(t *testing.T) {
	for _, kind := range []string{vaultstore.UnlockEnclave, vaultstore.UnlockHello} {
		t.Run(kind, func(t *testing.T) {
			p, h, s := newTest(t)
			s.Set("KEY", vaultstore.Update{Value: str("v"), Machines: &[]string{"m1"}})
			sh := newShell(t, launchKey, "install-0123456789ab", kind == vaultstore.UnlockHello)
			c := sh.client(p, h)
			c.session(t)
			out := sh.enroll(t, c)
			a := out["guard"].(map[string]any)["authenticators"].([]any)[0].(map[string]any)
			if a["kind"] != "desktop" || a["unlock"] != true {
				t.Fatalf("enrolled %v", a)
			}
			if es := s.UnlockEntries(); len(es) != 1 || es[0].Kind != kind || es[0].Authenticator != a["id"] {
				t.Fatalf("entries %+v", es)
			}
			if strings.Contains(h.auditLog(), enc(sh.secret)) {
				t.Errorf("audit %s", h.auditLog())
			}
			c.do("POST", "/api/p/vault/lock", "")
			c.tok = ""
			// The list offers it to the desktop client only, without ids.
			_, list := c.do("GET", "/api/p/vault", "")
			if u := list["unlock"].(map[string]any); mustJSON(u["ways"]) != `["`+kind+`"]` || u["due"] == "" || strings.Contains(mustJSON(list), s.UnlockEntries()[0].ID) {
				t.Errorf("list %v", list)
			}
			browser := newClient(p, h)
			browser.relay = sh.open
			if _, list := browser.do("GET", "/api/p/vault", ""); mustJSON(list["unlock"].(map[string]any)["ways"]) != `[]` {
				t.Errorf("a browser's ways %v", list["unlock"])
			}
			// The purpose names the entry and what its key needs, no secret.
			nonce, _ := c.nonce(t, `{"for":"session"}`)
			e := sh.entry(t, c, nonce)
			if e["kind"] != kind || len(e) != 4 {
				t.Errorf("entry %v", e)
			}
			if code, _ := browser.do("GET", "/api/p/vault/proof/"+nonce, ""); code != 404 {
				t.Errorf("a browser reads the entries: %d", code)
			}
			relay := sh.answer(t, nonce, e)
			try := func(cl *client, nonce, id, relay string) (int, map[string]any) {
				return cl.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"unlock": map[string]string{"nonce": nonce, "id": id, "relay": relay}}))
			}
			refused := func(what string, code int, out map[string]any) {
				t.Helper()
				if code != 401 || out["error"] != "vault_proof" || !s.Status().Locked {
					t.Errorf("%s: %d %v, locked %v", what, code, out, s.Status().Locked)
				}
				if n := failures(p); n != 0 {
					t.Errorf("%s: counted as %d wrong passphrases", what, n)
				}
			}
			// From a browser, the relay is none (and the nonce is used up).
			code, out := try(browser, nonce, e["id"].(string), relay)
			refused("a browser's relay", code, out)
			// For another nonce, another entry, another purpose.
			nonce, _ = c.nonce(t, `{"for":"session"}`)
			other, _ := c.nonce(t, `{"for":"session"}`)
			code, out = try(c, other, e["id"].(string), relay)
			refused("a relay of another nonce", code, out)
			e = sh.entry(t, c, nonce)
			register := sh.seal(t, "vault-relay\nregister\n"+nonce+"\n", map[string]string{"z": enc(make([]byte, 32)), "shellSecret": enc(sh.secret)})
			code, out = try(c, nonce, e["id"].(string), register)
			refused("a relay of another purpose", code, out)
			nonce, _ = c.nonce(t, `{"for":"session"}`)
			e = sh.entry(t, c, nonce)
			forged := map[string]any{"id": e["id"], "enclave": e["enclave"], "hello": e["hello"]}
			forged["id"] = strings.Repeat("A", 22)
			code, out = try(c, nonce, e["id"].(string), sh.answer(t, nonce, forged))
			refused("a relay of another entry", code, out)
			// Sealed with another launch's key: not the shell's.
			nonce, _ = c.nonce(t, `{"for":"session"}`)
			e = sh.entry(t, c, nonce)
			foreign := newShell(t, strings.Repeat("ab", 32), sh.install, sh.hello)
			code, out = try(c, nonce, e["id"].(string), foreign.answer(t, nonce, e))
			refused("a relay of another launch", code, out)
			if len(s.UnlockEntries()) != 1 {
				t.Fatalf("a refused relay removed the entry: %+v", s.UnlockEntries())
			}

			// Its own answer unlocks the vault, once.
			nonce, _ = c.nonce(t, `{"for":"session"}`)
			e = sh.entry(t, c, nonce)
			relay = sh.answer(t, nonce, e)
			code, out = try(c, nonce, e["id"].(string), relay)
			if code != 200 || out["proof"] != true || s.Status().Locked {
				t.Fatalf("unlock %d %v", code, out)
			}
			if !strings.Contains(h.auditLog(), `vault.unlocked {"kind":"`+kind+`","ok":true}`) {
				t.Errorf("audit %s", h.auditLog())
			}
			if strings.Contains(h.auditLog(), relay) || strings.Contains(h.auditLog(), enc(sh.secret)) {
				t.Errorf("a secret in the audit: %s", h.auditLog())
			}
			if r := p.Handle(t.Context(), h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}}); !r.OK {
				t.Errorf("a machine after the unlock: %+v", r)
			}
			c.tok = out["session"].(string)
			if code, _ := try(c, nonce, e["id"].(string), relay); code != 401 || failures(p) != 0 {
				t.Errorf("a relay replayed: %d, %d wrong", code, failures(p))
			}
			// A proof's session: what guards the vault takes the passphrase.
			if code, out := c.do("POST", "/api/p/vault/guard", `{"verifyEachAllow":true}`); code != 401 || out["error"] != "vault_passphrase" {
				t.Errorf("guard in an unlock's session: %d %v", code, out)
			}
			if code, _ := c.do("POST", "/api/p/vault/vars/KEY/reveal", ""); code != 200 {
				t.Errorf("reveal in an unlock's session: %d", code)
			}
		})
	}
}

// Unlocks whose key the store refuses (a PRF output that does not open its
// wrap) are slowed down as wrong passphrases are: a program does not guess
// faster by them. What guesses nothing (a nonce unknown, a relay that does
// not open or is of another purpose, an unlock of a vault already
// unlocked, a page the core does not vouch for) is refused without
// counting.
func TestFailedUnlocksAreSlowedDown(t *testing.T) {
	p, h, s := newTest(t)
	c := newClient(p, h)
	c.origin = testOrigin
	c.session(t)
	a := newAuthenticator(t)
	c.register(t, a)
	sh := newShell(t, launchKey, "install-0123456789ab", false)
	d := sh.client(p, h)
	d.tok = c.tok
	sh.enroll(t, d)
	unlockPRF := func(n string, output []byte) (int, map[string]any) {
		assertion := a.assertion(t, n, c.origin)
		delete(assertion, "nonce")
		return c.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"unlock": map[string]any{
			"nonce": n, "prf": map[string]string{"credential": enc(a.id), "output": enc(output)}, "assertion": assertion}}))
	}
	unlockDesktop := func(n, id, relay string) (int, map[string]any) {
		return d.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"unlock": map[string]string{"nonce": n, "id": id, "relay": relay}}))
	}
	notCounted := func(what string, code int, out map[string]any) {
		t.Helper()
		if code != 401 || out["error"] != "vault_proof" || failures(p) != 0 {
			t.Errorf("%s: %d %v, %d wrong", what, code, out, failures(p))
		}
	}
	// Unlocked: a nonce is for a proof, never an unlock.
	for i := 0; i <= failFree; i++ {
		n, _ := c.nonce(t, `{"for":"session"}`)
		code, out := unlockPRF(n, a.output([]byte("any")))
		notCounted("an unlock of an unlocked vault", code, out)
	}
	c.do("POST", "/api/p/vault/lock", "")
	c.tok, d.tok = "", ""
	stranger := newShell(t, strings.Repeat("cd", 32), sh.install, false)
	for i := 0; i <= failFree; i++ {
		n, _ := d.nonce(t, `{"for":"session"}`)
		e := sh.entry(t, d, n)
		code, out := unlockDesktop("unknown", e["id"].(string), sh.answer(t, n, e))
		notCounted("an unknown nonce", code, out)
		n, _ = d.nonce(t, `{"for":"session"}`)
		e = sh.entry(t, d, n)
		code, out = unlockDesktop(n, e["id"].(string), stranger.answer(t, n, e))
		notCounted("a relay that does not open", code, out)
		n, _ = d.nonce(t, `{"for":"session"}`)
		e = sh.entry(t, d, n)
		register := sh.seal(t, "vault-relay\nregister\n"+n+"\n", map[string]string{"z": enc(make([]byte, 32)), "shellSecret": enc(sh.secret)})
		code, out = unlockDesktop(n, e["id"].(string), register)
		notCounted("a relay of another purpose", code, out)
		n, out = c.nonce(t, `{"for":"session"}`)
		salt := b64(out["prf"].(map[string]any)[enc(a.id)].(string))
		c.untrusted = true
		code, out = unlockPRF(n, a.output(salt))
		c.untrusted = false
		notCounted("a page not vouched for", code, out)
	}
	if !s.Status().Locked || len(s.UnlockEntries()) != 2 {
		t.Fatalf("locked %v, entries %+v", s.Status().Locked, s.UnlockEntries())
	}
	// Outputs that do not open count.
	for i := 0; i <= failFree; i++ {
		n, _ := c.nonce(t, `{"for":"session"}`)
		if code, out := unlockPRF(n, a.output([]byte("another salt"))); code != 401 || out["error"] != "vault_proof" {
			t.Fatalf("try %d: %d %v", i, code, out)
		}
	}
	if n := failures(p); n != failFree+1 {
		t.Errorf("counted %d wrong, want %d", n, failFree+1)
	}
	if code, out := sh.unlock(t, d); code != 429 || out["error"] != "wait" || !s.Status().Locked {
		t.Errorf("after %d failed unlocks: %d %v", failFree+1, code, out)
	}
	if code, out := c.do("POST", "/api/p/vault/session", mustJSON(map[string]string{"passphrase": pass})); code != 429 {
		t.Errorf("the passphrase after failed unlocks: %d %v", code, out)
	}
}

// An entry the shell's relay does not open is dead: the relay is the
// shell's (sealed with the launch's key) and made by its install's key just
// now, as after a re-enrollment that made the Hello key or the shell's
// secret again and that the core then refused. It is removed (409
// unlock_stale, audited), without counting as a wrong passphrase, and the
// passphrase sets biometrics up again.
func TestDeadDesktopEntry(t *testing.T) {
	for _, kind := range []string{vaultstore.UnlockEnclave, vaultstore.UnlockHello} {
		t.Run(kind, func(t *testing.T) {
			p, h, s := newTest(t)
			sh := newShell(t, launchKey, "install-0123456789ab", kind == vaultstore.UnlockHello)
			c := sh.client(p, h)
			c.session(t)
			sh.enroll(t, c)
			first := s.UnlockEntries()[0]
			// Enrolled again from the same install: the entry is replaced.
			sh.enroll(t, c)
			if es := s.UnlockEntries(); len(es) != 1 || es[0].ID == first.ID {
				t.Fatalf("entries after enrolling again: %+v", es)
			}
			if !strings.Contains(h.auditLog(), removedAudit(first.ID, kind, "stale")) {
				t.Errorf("replaced entry not audited: %s", h.auditLog())
			}
			old := s.UnlockEntries()[0]
			// Enrolling again with a new key and secret, refused by the core.
			rand.Read(sh.secret)
			rand.Read(sh.helloKey)
			nonce, _ := c.nonce(t, `{"for":"register"}`)
			_, pu := c.do("GET", "/api/p/vault/proof/"+nonce, "")
			challenge := b64(pu["register"].(map[string]any)["challenge"].(string))
			body := map[string]string{"kind": "desktop", "label": "Touch ID", "passphrase": "wrong horse", "nonce": nonce,
				"mac": sh.mac(nonce, purpose{For: ForRegister}), "relay": sh.registration(t, nonce, challenge)}
			if code, out := c.do("POST", "/api/p/vault/authenticators", mustJSON(body)); code != 403 {
				t.Fatalf("a refused enrollment: %d %v", code, out)
			}
			p.tried(true, false) // the wrong passphrase counted
			c.do("POST", "/api/p/vault/lock", "")
			c.tok = ""
			code, out := sh.unlock(t, c)
			if code != 409 || out["error"] != "unlock_stale" || !s.Status().Locked || len(s.UnlockEntries()) != 0 {
				t.Fatalf("a dead entry: %d %v, entries %+v", code, out, s.UnlockEntries())
			}
			if n := failures(p); n != 0 {
				t.Errorf("a dead entry counted as %d wrong passphrases", n)
			}
			if !strings.Contains(h.auditLog(), removedAudit(old.ID, kind, "wrap")) {
				t.Errorf("removal not audited: %s", h.auditLog())
			}
			if _, list := c.do("GET", "/api/p/vault", ""); mustJSON(list["unlock"].(map[string]any)["ways"]) != `[]` {
				t.Errorf("ways %v", list["unlock"])
			}
			// The passphrase, then biometrics again.
			c.session(t)
			sh.enroll(t, c)
			c.do("POST", "/api/p/vault/lock", "")
			c.tok = ""
			if code, out := sh.unlock(t, c); code != 200 || s.Status().Locked {
				t.Errorf("enrolled again: %d %v", code, out)
			}
		})
	}
}

// The shell's word that its key is gone (fingerprints changed, the Hello
// key removed) ends the entry: 409 unlock_stale, the entry removed; the
// desktop authenticator stays to approve with.
func TestDesktopUnlockInvalidated(t *testing.T) {
	p, h, s := newTest(t)
	sh := newShell(t, launchKey, "install-0123456789ab", false)
	c := sh.client(p, h)
	c.session(t)
	sh.enroll(t, c)
	c.do("POST", "/api/p/vault/lock", "")
	nonce, _ := c.nonce(t, `{"for":"session"}`)
	e := sh.entry(t, c, nonce)
	relay := sh.seal(t, "vault-relay\nsession\n"+nonce+"\n"+e["id"].(string), map[string]bool{"invalidated": true})
	code, out := c.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"unlock": map[string]string{"nonce": nonce, "id": e["id"].(string), "relay": relay}}))
	if code != 409 || out["error"] != "unlock_stale" || len(s.UnlockEntries()) != 0 || !s.Status().Locked {
		t.Fatalf("invalidated: %d %v, entries %d", code, out, len(s.UnlockEntries()))
	}
	if !strings.Contains(h.auditLog(), removedAudit(e["id"].(string), vaultstore.UnlockEnclave, "invalidated")) || failures(p) != 0 {
		t.Errorf("audit %s, %d wrong", h.auditLog(), failures(p))
	}
	if _, list := c.do("GET", "/api/p/vault", ""); mustJSON(list["unlock"].(map[string]any)["ways"]) != `[]` {
		t.Errorf("ways %v", list["unlock"])
	}
	if _, out := c.nonce(t, `{"for":"session"}`); out["desktop"] != false {
		t.Errorf("offered without an entry: %v", out)
	}
	c.session(t)
	_, list := c.do("GET", "/api/p/vault", "")
	a := list["guard"].(map[string]any)["authenticators"].([]any)
	if len(a) != 1 || a[0].(map[string]any)["unlock"] != false {
		t.Errorf("the authenticator after its entry went: %v", a)
	}
}

// A WebAuthn credential with PRF unlocks a locked vault of its own origin:
// its PRF output opens the wrap, and its assertion of the nonce is verified
// with the stored key, its counter growing, before the key is installed. An
// output that opens the wrap with an assertion that does not hold is
// audited: the output leaked.
func TestPRFUnlock(t *testing.T) {
	p, h, s := newTest(t)
	c := newClient(p, h)
	c.origin = testOrigin
	c.session(t)
	a := newAuthenticator(t)
	c.register(t, a)
	c.do("POST", "/api/p/vault/lock", "")
	c.tok = ""
	nonce := func() (string, []byte) {
		t.Helper()
		n, out := c.nonce(t, `{"for":"session"}`)
		salts, _ := out["prf"].(map[string]any)
		if creds := out["credentials"].([]any); len(creds) != 1 || creds[0] != enc(a.id) || len(salts) != 1 || out["desktop"] != false {
			t.Fatalf("a locked vault's nonce: %v", out)
		}
		return n, b64(salts[enc(a.id)].(string))
	}
	try := func(n string, output []byte, assertion map[string]string) (int, map[string]any) {
		delete(assertion, "nonce")
		return c.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"unlock": map[string]any{
			"nonce": n, "prf": map[string]string{"credential": enc(a.id), "output": enc(output)}, "assertion": assertion}}))
	}
	refused := func(what string, code int, out map[string]any) {
		t.Helper()
		if code != 401 || out["error"] != "vault_proof" || !s.Status().Locked {
			t.Errorf("%s: %d %v", what, code, out)
		}
		p.tried(true, false)
	}
	// Another output does not open the wrap: no leak to audit.
	n, salt := nonce()
	code, out := try(n, a.output([]byte("another salt")), a.assertion(t, n, c.origin))
	refused("another output", code, out)
	if strings.Contains(h.auditLog(), "prf_signature") {
		t.Errorf("audit %s", h.auditLog())
	}
	// The output with another key's assertion: refused, and audited.
	n, salt = nonce()
	other := newAuthenticator(t)
	forged := other.assertion(t, n, c.origin)
	forged["credential"] = enc(a.id)
	code, out = try(n, a.output(salt), forged)
	refused("another key's assertion", code, out)
	if !strings.Contains(h.auditLog(), `denied.vault_proof {"kind":"prf","reason":"prf_signature","route":"POST /api/p/vault/session"}`) {
		t.Errorf("audit %s", h.auditLog())
	}
	// An assertion of another nonce.
	n, salt = nonce()
	n2, _ := nonce()
	code, out = try(n, a.output(salt), a.assertion(t, n2, c.origin))
	refused("an assertion of another nonce", code, out)
	// A counter that does not grow: a copy of the authenticator.
	n, salt = nonce()
	last := a.count
	a.count = 0
	code, out = try(n, a.output(salt), a.assertion(t, n, c.origin))
	refused("a counter that went back", code, out)
	a.count = last
	if !strings.Contains(h.auditLog(), `"reason":"prf_counter"`) {
		t.Errorf("audit %s", h.auditLog())
	}
	// From a page the core does not vouch for, or of another port: no guess.
	n, salt = nonce()
	c.untrusted = true
	code, out = try(n, a.output(salt), a.assertion(t, n, c.origin))
	c.untrusted = false
	if failures(p) != 0 {
		t.Errorf("an origin not vouched for counted")
	}
	refused("an origin not vouched for", code, out)
	// An unknown credential has no entry.
	n, salt = nonce()
	code, out = c.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"unlock": map[string]any{
		"nonce": n, "prf": map[string]string{"credential": enc(other.id), "output": enc(a.output(salt))}, "assertion": other.assertion(t, n, c.origin)}}))
	if code != 409 || out["error"] != "unlock_stale" {
		t.Errorf("an unknown credential: %d %v", code, out)
	}
	p.tried(true, false)
	// Its own: unlocked, the counter recorded.
	n, salt = nonce()
	code, out = try(n, a.output(salt), a.assertion(t, n, c.origin))
	if code != 200 || out["proof"] != true || s.Status().Locked {
		t.Fatalf("unlock %d %v", code, out)
	}
	if g, _ := s.Guard(); g.Authenticators[0].SignCount != a.count {
		t.Errorf("counter %d, want %d", g.Authenticators[0].SignCount, a.count)
	}
	if !strings.Contains(h.auditLog(), `vault.unlocked {"kind":"prf","ok":true}`) || strings.Contains(h.auditLog(), enc(a.output(salt))) {
		t.Errorf("audit %s", h.auditLog())
	}
	// Unlocked, a nonce is for a proof, never an unlock.
	n, _ = c.nonce(t, `{"for":"session"}`)
	if code, out := try(n, a.output(salt), a.assertion(t, n, c.origin)); code != 401 {
		t.Errorf("an unlock of an unlocked vault: %d %v", code, out)
	}
}

// writeWindow puts a passphrase's window that began at into the vault's
// file, sealed with the passphrase's key as the store seals it, and has the
// plugin open the file again (the store's clock cannot be moved).
func writeWindow(t *testing.T, p *Plugin, h *fakeHost, at time.Time, days int, autoLock time.Duration) *vaultstore.Store {
	t.Helper()
	raw, err := os.ReadFile(p.Path)
	if err != nil {
		t.Fatal(err)
	}
	var f map[string]json.RawMessage
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	var kdf vaultstore.KDF
	json.Unmarshal(f["kdf"], &kdf)
	key := argon2.IDKey([]byte(pass), kdf.Salt, kdf.Time, kdf.Memory, kdf.Threads, 32)
	plain, _ := json.Marshal(map[string]any{"at": at.UTC().Truncate(time.Second), "days": days, "autoLock": int64(autoLock / time.Second)})
	block, _ := aes.NewCipher(key)
	g, _ := cipher.NewGCM(block)
	nonce := make([]byte, 12)
	rand.Read(nonce)
	sealed, _ := json.Marshal(vaultstore.Sealed{Nonce: nonce, Ciphertext: g.Seal(nil, nonce, plain, []byte("#passphraseAt"))})
	f["passphraseAt"] = sealed
	f["passphraseHint"], _ = json.Marshal(at.AddDate(0, 0, days).UTC().Format(time.RFC3339))
	out, _ := json.Marshal(f)
	if err := os.WriteFile(p.Path, out, 0o600); err != nil {
		t.Fatal(err)
	}
	p.mu.Lock()
	p.store = nil
	p.mu.Unlock()
	s, err := p.open(h)
	if err != nil {
		t.Fatal(err)
	}
	s.KDF = testKDF
	return s
}

// An authenticator unlocks only within vault.passphraseDays of the last
// passphrase (403 passphrase_due outside it, after which the passphrase
// works); Lock with forget ends the window at once, also while locked.
func TestPassphraseDue(t *testing.T) {
	p, h, _ := newTest(t)
	withSettings(t, h, map[string]float64{SettingPassphraseDays: 14})
	sh := newShell(t, launchKey, "install-0123456789ab", false)
	c := sh.client(p, h)
	c.session(t)
	sh.enroll(t, c)
	due := func(code int, out map[string]any, s *vaultstore.Store) {
		t.Helper()
		if code != 403 || out["error"] != "passphrase_due" || !s.Status().Locked {
			t.Errorf("due: %d %v", code, out)
		}
		p.tried(true, false)
	}
	// Ended 14 days after the passphrase.
	s := writeWindow(t, p, h, time.Now().AddDate(0, 0, -14).Add(-time.Minute), 14, time.Hour)
	code, out := sh.unlock(t, c)
	due(code, out, s)
	// Within it, but not within a smaller setting now.
	s = writeWindow(t, p, h, time.Now().AddDate(0, 0, -3), 14, time.Hour)
	withSettings(t, h, map[string]float64{SettingPassphraseDays: 2})
	code, out = sh.unlock(t, c)
	due(code, out, s)
	// A larger setting does not lengthen the sealed one.
	s = writeWindow(t, p, h, time.Now().AddDate(0, 0, -3), 2, time.Hour)
	withSettings(t, h, map[string]float64{SettingPassphraseDays: 90})
	code, out = sh.unlock(t, c)
	due(code, out, s)
	withSettings(t, h, map[string]float64{SettingPassphraseDays: 14})
	s = writeWindow(t, p, h, time.Now().AddDate(0, 0, -3), 14, time.Hour)
	if code, out := sh.unlock(t, c); code != 200 || s.Status().Locked {
		t.Fatalf("within the window: %d %v", code, out)
	}
	// Lock with forget ends it, also while locked.
	c.tok = ""
	c.do("POST", "/api/p/vault/lock", "")
	if code, out := c.do("POST", "/api/p/vault/lock", `{"forget":true}`); code != 200 || out["locked"] != true {
		t.Fatalf("forget while locked: %d %v", code, out)
	}
	if _, list := c.do("GET", "/api/p/vault", ""); list["unlock"].(map[string]any)["due"] != "" {
		t.Errorf("due after forget: %v", list["unlock"])
	}
	code, out = sh.unlock(t, c)
	due(code, out, s)
	// The passphrase opens the window again.
	c.session(t)
	c.do("POST", "/api/p/vault/lock", "")
	if code, out := sh.unlock(t, c); code != 200 {
		t.Errorf("after the passphrase: %d %v", code, out)
	}
}

// After an unlock by an authenticator the auto-lock is the setting's time,
// at most the one sealed with the passphrase's window: a program that set
// the setting longer, or to never, before the unlock gets no longer, nor by
// a change after it.
func TestAutoLockAfterAnUnlockByAnAuthenticator(t *testing.T) {
	p, h, s := newTest(t)
	h.st = settings.New("", Settings)
	set := func(minutes float64) {
		t.Helper()
		if err := h.st.Set(SettingAutoLock, "", minutes); err != nil {
			t.Fatal(err)
		}
	}
	sh := newShell(t, launchKey, "install-0123456789ab", false)
	c := sh.client(p, h)
	set(30)
	c.do("POST", "/api/p/vault/lock", "")
	c.session(t) // the window seals 30 minutes
	sh.enroll(t, c)
	c.do("POST", "/api/p/vault/lock", "")
	set(0)
	if code, out := sh.unlock(t, c); code != 200 || s.Status().Locked {
		t.Fatalf("unlock %d %v", code, out)
	}
	if got := p.autoLockAfter(h); got != 30*time.Minute {
		t.Errorf("never, set before the unlock: %v", got)
	}
	set(600)
	if got := p.autoLockAfter(h); got != 30*time.Minute {
		t.Errorf("longer, set after the unlock: %v", got)
	}
	set(10)
	if got := p.autoLockAfter(h); got != 10*time.Minute {
		t.Errorf("shorter: %v", got)
	}
	c.do("POST", "/api/p/vault/lock", "")
	if code, _ := sh.unlock(t, c); code != 200 || p.autoLockAfter(h) != 10*time.Minute {
		t.Errorf("a shorter setting at the unlock: %d %v", code, p.autoLockAfter(h))
	}
	// Sealed never: the setting's time.
	set(0)
	c.session(t)
	c.do("POST", "/api/p/vault/lock", "")
	c.session(t) // the window seals never
	c.do("POST", "/api/p/vault/lock", "")
	set(15)
	if code, _ := sh.unlock(t, c); code != 200 || p.autoLockAfter(h) != 15*time.Minute {
		t.Errorf("sealed never: %d %v", code, p.autoLockAfter(h))
	}
}

// Registering an authenticator wraps the key for it: a WebAuthn credential
// brings its PRF output (400 prf_required without it), the desktop app its
// relay (a new desktop authenticator without it is refused); another
// install adds its entry to the one desktop authenticator; removing an
// authenticator removes its entries.
func TestRegistrationWrapsTheKey(t *testing.T) {
	p, h, s := newTest(t)
	c := newClient(p, h)
	c.origin = testOrigin
	c.session(t)
	a := newAuthenticator(t)
	nonce, out := c.nonce(t, `{"for":"register"}`)
	if len(b64(out["prfSalt"].(string))) != 32 {
		t.Fatalf("no prf salt: %v", out)
	}
	body := map[string]any{
		"kind": "webauthn", "label": "Key", "passphrase": pass, "nonce": nonce,
		"clientDataJSON": enc(clientData("webauthn.create", nonce, c.origin)), "authenticatorData": enc(a.authData(c.origin, true)),
		"publicKey": a.spki(t), "alg": 0, "assertion": a.assertion(t, nonce, c.origin),
	}
	if code, out := c.do("POST", "/api/p/vault/authenticators", mustJSON(body)); code != 400 || out["error"] != "prf_required" {
		t.Errorf("without prf: %d %v", code, out)
	}
	body["prf"] = enc([]byte("short"))
	if code, out := c.do("POST", "/api/p/vault/authenticators", mustJSON(body)); code != 400 || out["error"] != "bad_request" {
		t.Errorf("a short prf: %d %v", code, out)
	}
	if g, _ := s.Guard(); len(g.Authenticators) != 0 || len(s.UnlockEntries()) != 0 {
		t.Fatalf("added: %+v", g)
	}
	c.register(t, a)
	if es := s.UnlockEntries(); len(es) != 1 || es[0].Kind != vaultstore.UnlockPRF || es[0].PRF.Origin != testOrigin {
		t.Fatalf("entries %+v", es)
	}

	// The desktop app: not without its relay, nor with one of another nonce.
	sh := newShell(t, launchKey, "install-0123456789ab", false)
	d := sh.client(p, h)
	d.tok = c.tok
	nonce, _ = d.nonce(t, `{"for":"register"}`)
	reg := map[string]string{"kind": "desktop", "label": "Touch ID", "passphrase": pass, "nonce": nonce, "mac": sh.mac(nonce, purpose{For: ForRegister})}
	if code, out := d.do("POST", "/api/p/vault/authenticators", mustJSON(reg)); code != 400 || out["error"] != "bad_request" {
		t.Errorf("without a relay: %d %v", code, out)
	}
	nonce, _ = d.nonce(t, `{"for":"register"}`)
	reg["nonce"], reg["mac"], reg["relay"] = nonce, sh.mac(nonce, purpose{For: ForRegister}), sh.registration(t, "another", nil)
	if code, out := d.do("POST", "/api/p/vault/authenticators", mustJSON(reg)); code != 401 || out["error"] != "vault_proof" {
		t.Errorf("a relay of another nonce: %d %v", code, out)
	}
	// A Hello key's name that is not its install's.
	nonce, _ = d.nonce(t, `{"for":"register"}`)
	reg["nonce"], reg["mac"] = nonce, sh.mac(nonce, purpose{For: ForRegister})
	reg["relay"] = sh.seal(t, "vault-relay\nregister\n"+nonce+"\n", map[string]any{"kind": "hello", "install": sh.install, "keyName": "other",
		"publicKey": enc([]byte("k")), "signature": enc([]byte("s")), "shellSecret": enc(sh.secret)})
	if code, out := d.do("POST", "/api/p/vault/authenticators", mustJSON(reg)); code != 400 || out["error"] != "invalid" {
		t.Errorf("another key name: %d %v", code, out)
	}
	if g, _ := s.Guard(); len(g.Authenticators) != 1 {
		t.Fatalf("added: %+v", g.Authenticators)
	}
	// Two installs: one authenticator, two entries.
	sh.enroll(t, d)
	second := newShell(t, launchKey, "install-zyxwvutsrq98", true)
	out = second.enroll(t, d)
	g, _ := s.Guard()
	if len(g.Authenticators) != 2 || len(s.UnlockEntries()) != 3 {
		t.Fatalf("two installs: %+v, %d entries", g.Authenticators, len(s.UnlockEntries()))
	}
	// Without a relay, the one there is stays.
	nonce, _ = d.nonce(t, `{"for":"register"}`)
	if code, out := d.do("POST", "/api/p/vault/authenticators", mustJSON(map[string]string{"kind": "desktop", "label": "Hello", "passphrase": pass, "nonce": nonce, "mac": sh.mac(nonce, purpose{For: ForRegister})})); code != 200 || len(s.UnlockEntries()) != 3 {
		t.Errorf("again without a relay: %d %v", code, out)
	}
	// Removing the desktop authenticator removes both of its entries.
	desktopEntries := slices.DeleteFunc(s.UnlockEntries(), func(e vaultstore.UnlockEntry) bool { return e.Kind == vaultstore.UnlockPRF })
	var desktop string
	for _, x := range out["guard"].(map[string]any)["authenticators"].([]any) {
		if x.(map[string]any)["kind"] == "desktop" {
			desktop = x.(map[string]any)["id"].(string)
		}
	}
	if code, _ := d.do("DELETE", "/api/p/vault/authenticators/"+desktop, ""); code != 200 {
		t.Fatal(code)
	}
	if es := s.UnlockEntries(); len(es) != 1 || es[0].Kind != vaultstore.UnlockPRF {
		t.Errorf("after removing the desktop authenticator: %+v", es)
	}
	for _, e := range desktopEntries {
		if !strings.Contains(h.auditLog(), removedAudit(e.ID, e.Kind, "orphan")) {
			t.Errorf("removal of %s not audited: %s", e.ID, h.auditLog())
		}
	}
	// And the credential's.
	g, _ = s.Guard()
	if code, _ := c.do("DELETE", "/api/p/vault/authenticators/"+g.Authenticators[0].ID, ""); code != 200 || len(s.UnlockEntries()) != 0 {
		t.Errorf("after removing the credential: %d %d entries", code, len(s.UnlockEntries()))
	}
	// A new passphrase ends every entry.
	sh.enroll(t, d)
	ended := s.UnlockEntries()[0]
	if code, _ := c.do("POST", "/api/p/vault/passphrase", mustJSON(map[string]string{"old": pass, "passphrase": "another horse"})); code != 200 || len(s.UnlockEntries()) != 0 {
		t.Errorf("after a new passphrase: %d entries", len(s.UnlockEntries()))
	}
	if !strings.Contains(h.auditLog(), removedAudit(ended.ID, ended.Kind, "stale")) {
		t.Errorf("entries a new passphrase ended not audited: %s", h.auditLog())
	}
}

// A lock asked for while an authenticator's unlock runs comes after it and
// its session: the vault ends locked with no session open; any order of
// an unlock and a lock ends consistent, and a locked vault's store holds
// no key.
func TestLockDuringAnUnlock(t *testing.T) {
	p, h, s := newTest(t)
	sh := newShell(t, launchKey, "install-0123456789ab", false)
	c := sh.client(p, h)
	c.session(t)
	sh.enroll(t, c)
	consistent := func(what string) {
		t.Helper()
		p.mu.Lock()
		open := len(p.sessions)
		p.mu.Unlock()
		_, err := s.Guard()
		if locked := s.Status().Locked; locked != (open == 0) || locked != errors.Is(err, vaultstore.ErrLocked) {
			t.Errorf("%s: locked %v with %d sessions, guard %v", what, locked, open, err)
		}
	}
	c.do("POST", "/api/p/vault/lock", "")
	var lockDone chan struct{}
	p.keyStep = func() {
		lockDone = make(chan struct{})
		go func() {
			newClient(p, h).do("POST", "/api/p/vault/lock", "")
			close(lockDone)
		}()
		select {
		case <-lockDone:
		case <-time.After(50 * time.Millisecond): // it waits for the unlock
		}
	}
	code, _ := sh.unlock(t, c)
	p.keyStep = nil
	<-lockDone
	if code != 200 {
		t.Errorf("unlock %d", code)
	}
	consistent("unlock")
	if !s.Status().Locked {
		t.Error("the lock asked for during the unlock was undone")
	}
	for i := 0; i < 20; i++ {
		nonce, _ := c.nonce(t, `{"for":"session"}`)
		var e map[string]any
		var relay string
		if s.Status().Locked {
			e = sh.entry(t, c, nonce)
			relay = sh.answer(t, nonce, e)
		}
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			if e != nil {
				c.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"unlock": map[string]string{"nonce": nonce, "id": e["id"].(string), "relay": relay}}))
			}
		}()
		go func() {
			defer wg.Done()
			time.Sleep(time.Duration(i%5) * time.Millisecond)
			c.do("POST", "/api/p/vault/lock", "")
		}()
		wg.Wait()
		consistent("race " + strconv.Itoa(i))
		p.tried(true, false)
	}
}

// Adding an authenticator and its unlock entry is one step for a lock: a
// lock asked for between the guard's write and the entry's comes after
// both, so the authenticator is never left without its entry (nor its drop
// undone by the lock).
func TestLockDuringAnAdd(t *testing.T) {
	for _, kind := range []string{vaultstore.KindWebAuthn, vaultstore.KindDesktop} {
		t.Run(kind, func(t *testing.T) {
			p, h, s := newTest(t)
			sh := newShell(t, launchKey, "install-0123456789ab", false)
			c := sh.client(p, h)
			c.origin = testOrigin
			c.session(t)
			var lockDone chan struct{}
			p.addStep = func() {
				lockDone = make(chan struct{})
				go func() {
					newClient(p, h).do("POST", "/api/p/vault/lock", "")
					close(lockDone)
				}()
				select {
				case <-lockDone:
				case <-time.After(50 * time.Millisecond): // it waits for the add
				}
			}
			if kind == vaultstore.KindWebAuthn {
				c.kind = plugin.Browser
				c.register(t, newAuthenticator(t))
			} else {
				sh.enroll(t, c)
			}
			p.addStep = nil
			<-lockDone
			if !s.Status().Locked {
				t.Error("the lock asked for during the add was undone")
			}
			c.session(t)
			g, _ := s.Guard()
			es := s.UnlockEntries()
			if len(g.Authenticators) != 1 || len(es) != 1 || es[0].Authenticator != g.Authenticators[0].ID {
				t.Errorf("authenticators %+v, entries %+v", g.Authenticators, es)
			}
		})
	}
}

// A failure to keep the key in locked memory is 503 memory: the core's
// limit of locked memory is too small, not the request.
func TestMemoryError(t *testing.T) {
	w := httptest.NewRecorder()
	fail(w, errors.Join(vaultstore.ErrMemory, errors.New("mlock")))
	var out map[string]string
	json.Unmarshal(w.Body.Bytes(), &out)
	if w.Code != 503 || out["error"] != "memory" {
		t.Errorf("%d %v", w.Code, out)
	}
}
