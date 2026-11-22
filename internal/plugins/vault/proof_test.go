package vault

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/plugin"
	vaultstore "herdr-ide/internal/vault"
	"herdr-ide/internal/webauthn"
)

const testOrigin = "http://localhost:7780"

// testAuthenticator is a WebAuthn authenticator of the tests: a P-256 key
// with a credential id and a counter, and the secret of its PRF.
type testAuthenticator struct {
	key   *ecdsa.PrivateKey
	id    []byte
	count uint32
	prf   []byte
}

func newAuthenticator(t *testing.T) *testAuthenticator {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id, secret := make([]byte, 16), make([]byte, 32)
	rand.Read(id)
	rand.Read(secret)
	return &testAuthenticator{key: key, id: id, prf: secret}
}

// output is the authenticator's PRF output for salt, as WebAuthn's prf
// extension gives it (an HMAC of the salt with a secret of the credential).
func (a *testAuthenticator) output(salt []byte) []byte {
	m := hmac.New(sha256.New, a.prf)
	m.Write(salt)
	return m.Sum(nil)
}

func (a *testAuthenticator) spki(t *testing.T) string {
	t.Helper()
	b, err := x509.MarshalPKIXPublicKey(&a.key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return enc(b)
}

func clientData(typ, nonce, origin string) []byte {
	b, _ := json.Marshal(map[string]any{"type": typ, "challenge": nonce, "origin": origin, "crossOrigin": false})
	return b
}

// authData is authenticator data for the host of origin: the user present
// and verified, the counter, and with attested the credential's id.
func (a *testAuthenticator) authData(origin string, attested bool) []byte {
	host := strings.TrimPrefix(origin, "http://")
	host = strings.Split(strings.TrimPrefix(host, "https://"), ":")[0]
	h := sha256.Sum256([]byte(host))
	flags := byte(0x01 | 0x04)
	if attested {
		flags |= 0x40
	}
	out := append(h[:], flags)
	out = binary.BigEndian.AppendUint32(out, a.count)
	if attested {
		out = append(out, make([]byte, 16)...)
		out = binary.BigEndian.AppendUint16(out, uint16(len(a.id)))
		out = append(out, a.id...)
	}
	return out
}

// assertion signs nonce as a page of origin would have it signed.
func (a *testAuthenticator) assertion(t *testing.T, nonce, origin string) map[string]string {
	t.Helper()
	a.count++
	cd := clientData("webauthn.get", nonce, origin)
	ad := a.authData(origin, false)
	h := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte{}, ad...), h[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, a.key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return map[string]string{"nonce": nonce, "credential": enc(a.id), "clientDataJSON": enc(cd), "authenticatorData": enc(ad), "signature": enc(sig)}
}

func (c *client) nonce(t *testing.T, body string) (string, map[string]any) {
	t.Helper()
	code, out := c.do("POST", "/api/p/vault/proof", body)
	if code != 200 {
		t.Fatalf("proof %s: %d %v", body, code, out)
	}
	return out["nonce"].(string), out
}

// register adds a as an authenticator of the page's origin, with its PRF
// output for the nonce's salt.
func (c *client) register(t *testing.T, a *testAuthenticator) {
	t.Helper()
	nonce, out := c.nonce(t, `{"for":"register"}`)
	salt := b64(out["prfSalt"].(string))
	if len(salt) != 32 {
		t.Fatalf("prf salt %v", out)
	}
	body := map[string]any{
		"kind": "webauthn", "label": "Touch ID", "passphrase": pass, "nonce": nonce,
		"clientDataJSON": enc(clientData("webauthn.create", nonce, c.origin)), "authenticatorData": enc(a.authData(c.origin, true)),
		"publicKey": a.spki(t), "alg": webauthn.ES256, "assertion": a.assertion(t, nonce, c.origin), "prf": enc(a.output(salt)),
	}
	if code, out := c.do("POST", "/api/p/vault/authenticators", mustJSON(body)); code != 200 {
		t.Fatalf("register %d %v", code, out)
	}
}

// An authenticator added in a session of the passphrase proves the user in
// its stead: its proof opens a session, which changes variables but not
// what guards the vault; a proof is good once, for its purpose, from its
// page's origin, while its nonce lives and the vault is unlocked. A proof
// holds no key: a lock forgets the key, and no proof unlocks the vault.
func TestProofOpensASession(t *testing.T) {
	p, h, s := newTest(t)
	now := time.Now()
	p.now = func() time.Time { return now }
	c := newClient(p, h)
	c.origin = testOrigin
	a := newAuthenticator(t)

	// Adding one needs a session, and the passphrase again.
	if code, out := c.do("POST", "/api/p/vault/proof", `{"for":"register"}`); code != 401 || out["error"] != "vault_session" {
		t.Fatalf("a nonce to register without a session: %d %v", code, out)
	}
	c.session(t)
	nonce, _ := c.nonce(t, `{"for":"register"}`)
	bad := map[string]any{
		"kind": "webauthn", "passphrase": "wrong horse", "nonce": nonce,
		"clientDataJSON": enc(clientData("webauthn.create", nonce, c.origin)), "authenticatorData": enc(a.authData(c.origin, true)),
		"publicKey": a.spki(t), "alg": webauthn.ES256, "assertion": a.assertion(t, nonce, c.origin), "prf": enc(make([]byte, 32)),
	}
	if code, out := c.do("POST", "/api/p/vault/authenticators", mustJSON(bad)); code != 403 || out["error"] != "wrong_passphrase" {
		t.Fatalf("a wrong passphrase: %d %v", code, out)
	}
	p.tried(true, false)
	// A key that is not the authenticator's is refused: the assertion does
	// not verify with it.
	other := newAuthenticator(t)
	nonce, _ = c.nonce(t, `{"for":"register"}`)
	bad["passphrase"], bad["nonce"], bad["publicKey"] = pass, nonce, other.spki(t)
	bad["clientDataJSON"], bad["assertion"] = enc(clientData("webauthn.create", nonce, c.origin)), a.assertion(t, nonce, c.origin)
	if code, out := c.do("POST", "/api/p/vault/authenticators", mustJSON(bad)); code != 401 || out["error"] != "vault_proof" {
		t.Fatalf("another key: %d %v", code, out)
	}
	// Not from a page the core does not vouch for.
	c.untrusted = true
	nonce, _ = c.nonce(t, `{"for":"register"}`)
	bad["nonce"], bad["publicKey"] = nonce, a.spki(t)
	bad["clientDataJSON"], bad["assertion"] = enc(clientData("webauthn.create", nonce, c.origin)), a.assertion(t, nonce, c.origin)
	if code, out := c.do("POST", "/api/p/vault/authenticators", mustJSON(bad)); code != 400 || out["error"] != "webauthn_origin" {
		t.Fatalf("an origin not vouched for: %d %v", code, out)
	}
	c.untrusted = false
	c.register(t, a)
	_, list := c.do("GET", "/api/p/vault", "")
	guard := list["guard"].(map[string]any)
	auths := guard["authenticators"].([]any)
	if a0 := auths[0].(map[string]any); len(auths) != 1 || a0["rpId"] != "localhost" || a0["origin"] != testOrigin || a0["label"] != "Touch ID" || guard["webauthn"] != true {
		t.Fatalf("guard %v", guard)
	}
	// Neither the page nor the file gets the key in the clear.
	if b, _ := json.Marshal(list); strings.Contains(string(b), "publicKey") || strings.Contains(string(b), a.spki(t)) {
		t.Fatalf("the list carries the key: %s", b)
	}
	if b, _ := os.ReadFile(p.Path); strings.Contains(string(b), "Touch ID") || !strings.Contains(string(b), `"guard"`) {
		t.Fatalf("the file: %s", b)
	}

	// Its proof opens a session.
	c.tok = ""
	nonce, out := c.nonce(t, `{"for":"session"}`)
	if creds := out["credentials"].([]any); len(creds) != 1 || creds[0] != enc(a.id) || out["rpId"] != "localhost" {
		t.Fatalf("proof options %v", out)
	}
	proof := a.assertion(t, nonce, c.origin)
	code, out := c.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"proof": proof}))
	if code != 200 || out["proof"] != true {
		t.Fatalf("session by proof %d %v", code, out)
	}
	c.tok = out["session"].(string)
	if _, list := c.do("GET", "/api/p/vault", ""); list["session"] != true || list["sessionProof"] != true {
		t.Fatalf("list %v", list)
	}
	// The same proof again is none.
	if code, out := c.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"proof": proof})); code != 401 || out["error"] != "vault_proof" {
		t.Fatalf("a proof used twice: %d %v", code, out)
	}
	// The session changes and shows variables...
	if code, out := c.do("PUT", "/api/p/vault/vars/KEY", `{"value":"v","machines":["m1"]}`); code != 200 {
		t.Fatalf("set %d %v", code, out)
	}
	if code, _ := c.do("POST", "/api/p/vault/vars/KEY/reveal", ""); code != 200 {
		t.Fatalf("reveal %d", code)
	}
	// ...but not what guards the vault, nor values in bulk.
	for path, body := range map[string]string{
		"/api/p/vault/guard":          `{"verifyEachAllow":false}`,
		"/api/p/vault/authenticators": `{"kind":"webauthn"}`, "/api/p/vault/proof": `{"for":"register"}`,
		"/api/p/vault/export": `{"passphrase":"x","filePassphrase":"long enough"}`, "/api/p/vault/import/preview": `{}`,
		"/api/p/vault/exempt": `{"app":"claude","machines":["m1"]}`,
	} {
		if code, out := c.do("POST", path, body); code != 401 || out["error"] != "vault_passphrase" {
			t.Errorf("%s in a session of a proof: %d %v", path, code, out)
		}
	}
	for _, path := range []string{"/api/p/vault/authenticators/x", "/api/p/vault/exempt/x"} {
		if code, out := c.do("DELETE", path, ""); code != 401 || out["error"] != "vault_passphrase" {
			t.Errorf("%s in a session of a proof: %d %v", path, code, out)
		}
	}
	if !strings.Contains(h.auditLog(), `vault.proved {"for":"session","kind":"webauthn","ok":true}`) || !strings.Contains(h.auditLog(), "denied.vault_passphrase") {
		t.Errorf("audit %s", h.auditLog())
	}

	refused := func(what string, body any) {
		t.Helper()
		if code, out := c.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"proof": body})); code != 401 || out["error"] != "vault_proof" {
			t.Errorf("%s: %d %v", what, code, out)
		}
	}
	// A nonce of another purpose.
	nonce, _ = c.nonce(t, `{"for":"session"}`)
	go func() {
		p.Handle(context.Background(), h, "m9", agentproto.VaultRequest{Tool: "env", Names: []string{"KEY"}})
	}()
	req := (<-h.sent)["request"].(*Request)
	other2, _ := c.nonce(t, mustJSON(map[string]string{"for": "answer", "request": req.ID, "answer": "once"}))
	refused("a nonce issued for an answer", a.assertion(t, other2, c.origin))
	c.do("POST", "/api/p/vault/requests/"+req.ID, `{"answer":"deny"}`)
	// Signed for another origin, by another key, with a counter that does
	// not grow, after the nonce's time.
	refused("another origin", a.assertion(t, nonce, "http://evil.example"))
	nonce, _ = c.nonce(t, `{"for":"session"}`)
	forged := other.assertion(t, nonce, c.origin)
	forged["credential"] = enc(a.id)
	refused("another key", forged)
	nonce, _ = c.nonce(t, `{"for":"session"}`)
	last := a.count
	a.count = 0
	refused("a counter that went back", a.assertion(t, nonce, c.origin))
	a.count = last
	nonce, _ = c.nonce(t, `{"for":"session"}`)
	now = now.Add(proofTTL + time.Second)
	refused("an old nonce", a.assertion(t, nonce, c.origin))
	// From a page of another host the credential is not offered, and its
	// proof does not hold there.
	c.origin = "http://127.0.0.1:7780"
	nonce, out = c.nonce(t, `{"for":"session"}`)
	if len(out["credentials"].([]any)) != 0 {
		t.Errorf("credentials of another host %v", out)
	}
	refused("the page of another host", a.assertion(t, nonce, c.origin))
	// A credential is the browser's for "localhost" on every port, so a
	// page another program serves there can have the nonce signed. Its
	// origin is not the credential's: the core does not vouch for it and
	// offers nothing there...
	c.origin, c.untrusted = "http://localhost:3000", true
	nonce, out = c.nonce(t, `{"for":"session"}`)
	if len(out["credentials"].([]any)) != 0 {
		t.Errorf("credentials offered to another port's page: %v", out)
	}
	refused("a page on another port", a.assertion(t, nonce, c.origin))
	if _, list := c.do("GET", "/api/p/vault", ""); list["guard"].(map[string]any)["webauthn"] != false {
		t.Errorf("an origin not vouched for may add credentials: %v", list["guard"])
	}
	// ...and a program that posts that page's assertion as the UI's own
	// request is refused by what the browser signed: the page's origin.
	c.origin, c.untrusted = testOrigin, false
	nonce, _ = c.nonce(t, `{"for":"session"}`)
	refused("another port's assertion posted as the UI's", a.assertion(t, nonce, "http://localhost:3000"))

	// A lock forgets the key: the vault is locked (machines get nothing,
	// every session and nonce ends), and a proof, which holds no key, does
	// not unlock it.
	nonce, _ = c.nonce(t, `{"for":"session"}`)
	if code, out := c.do("POST", "/api/p/vault/lock", ""); code != 200 || out["locked"] != true {
		t.Fatalf("lock %d %v", code, out)
	}
	if _, err := s.Guard(); !errors.Is(err, vaultstore.ErrLocked) {
		t.Errorf("the store kept its key: %v", err)
	}
	if code, _ := c.do("PUT", "/api/p/vault/vars/KEY", `{"value":"x"}`); code != 401 {
		t.Errorf("a session outlived the lock: %d", code)
	}
	if r := p.Handle(context.Background(), h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}}); r.Code != "vault_locked" {
		t.Errorf("a machine reads a locked vault: %+v", r)
	}
	if code, out := c.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"proof": a.assertion(t, nonce, c.origin)})); code != 409 || out["error"] != "vault_locked" {
		t.Errorf("a proof of a nonce issued before the lock: %d %v", code, out)
	}
	if _, list := c.do("GET", "/api/p/vault", ""); list["guard"] != nil || list["status"].(map[string]any)["locked"] != true {
		t.Errorf("a locked vault: %v", list)
	}
	// A nonce of the locked vault is for an unlock; a proof with it is none.
	locked, _ := c.nonce(t, `{"for":"session"}`)
	if code, out := c.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"proof": a.assertion(t, locked, c.origin)})); code != 409 || out["error"] != "vault_locked" || !s.Status().Locked {
		t.Errorf("a proof of a locked vault: %d %v", code, out)
	}
	// The passphrase unlocks it; the nonces issued while it was locked end.
	locked, _ = c.nonce(t, `{"for":"session"}`)
	c.session(t)
	c.tok = ""
	if code, out := c.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"proof": a.assertion(t, locked, c.origin)})); code != 401 || out["error"] != "vault_proof" {
		t.Errorf("a nonce of the locked vault after the unlock: %d %v", code, out)
	}

	// A new passphrase ends the authenticators.
	c.tok = ""
	if code, out := c.do("POST", "/api/p/vault/passphrase", mustJSON(map[string]string{"old": pass, "passphrase": "another horse"})); code != 200 {
		t.Fatalf("passphrase %d %v", code, out)
	}
	if g, err := s.Guard(); err != nil || len(g.Authenticators) != 0 {
		t.Errorf("after a new passphrase: %+v %v", g, err)
	}
}

// A proof made for a request and an answer allows that request without a
// session; where every Allow is verified a session is not enough, and the
// rule is the passphrase's to change.
func TestProofAllowsARequest(t *testing.T) {
	p, h, s := newTest(t)
	p.Timeout = 5 * time.Second
	c := newClient(p, h)
	c.origin = testOrigin
	c.session(t)
	if code, _ := c.do("PUT", "/api/p/vault/vars/KEY", `{"value":"s3cret","machines":["m1"]}`); code != 200 {
		t.Fatal(code)
	}
	a := newAuthenticator(t)
	c.register(t, a)
	ask := func() (*Request, chan agentproto.VaultResponse) {
		ch := make(chan agentproto.VaultResponse, 1)
		go func() {
			ch <- p.Handle(context.Background(), h, "m2", agentproto.VaultRequest{Tool: "env", Names: []string{"KEY"}})
		}()
		return (<-h.sent)["request"].(*Request), ch
	}
	answer := func(req *Request, body any) (int, map[string]any) {
		return c.do("POST", "/api/p/vault/requests/"+req.ID, mustJSON(body))
	}
	tok := c.tok
	c.tok = ""

	req, ch := ask()
	// A nonce is for a request that waits, and for once or always.
	if code, _ := c.do("POST", "/api/p/vault/proof", `{"for":"answer","request":"nope","answer":"once"}`); code != 404 {
		t.Errorf("a nonce for no request: %d", code)
	}
	if code, _ := c.do("POST", "/api/p/vault/proof", mustJSON(map[string]string{"for": "answer", "request": req.ID, "answer": "deny"})); code != 400 {
		t.Errorf("a nonce to deny: %d", code)
	}
	// A proof made for once does not allow always.
	nonce, _ := c.nonce(t, mustJSON(map[string]string{"for": "answer", "request": req.ID, "answer": "once"}))
	if code, out := answer(req, map[string]any{"answer": "always", "proof": a.assertion(t, nonce, c.origin)}); code != 401 || out["error"] != "vault_proof" {
		t.Fatalf("a proof for another answer: %d %v", code, out)
	}
	nonce, _ = c.nonce(t, mustJSON(map[string]string{"for": "answer", "request": req.ID, "answer": "once"}))
	if code, out := answer(req, map[string]any{"answer": "once", "proof": a.assertion(t, nonce, c.origin)}); code != 200 {
		t.Fatalf("allowed by a proof: %d %v", code, out)
	}
	if r := <-ch; !r.OK {
		t.Fatalf("the requester: %+v", r)
	}
	if !strings.Contains(h.auditLog(), `vault.proved {"for":"answer","kind":"webauthn","ok":true}`) {
		t.Errorf("audit %s", h.auditLog())
	}

	// Every Allow verified: a session of the passphrase sets the rule...
	c.tok = tok
	if code, out := c.do("POST", "/api/p/vault/guard", `{"verifyEachAllow":true}`); code != 200 || out["guard"].(map[string]any)["verifyEachAllow"] != true {
		t.Fatalf("guard %d %v", code, out)
	}
	// ...and then no session allows, the passphrase's included.
	req, ch = ask()
	if code, out := answer(req, map[string]any{"answer": "once"}); code != 401 || out["error"] != "vault_proof" {
		t.Fatalf("a session where every Allow is verified: %d %v", code, out)
	}
	if code, out := answer(req, map[string]any{"answer": "once", "passphrase": "wrong horse"}); code != 403 || out["error"] != "wrong_passphrase" {
		t.Fatalf("a wrong passphrase: %d %v", code, out)
	}
	p.tried(true, false)
	if code, out := answer(req, map[string]any{"answer": "once", "passphrase": pass}); code != 200 {
		t.Fatalf("the passphrase again: %d %v", code, out)
	}
	<-ch
	// Denying needs nothing.
	c.tok = ""
	req, ch = ask()
	if code, _ := answer(req, map[string]any{"answer": "deny"}); code != 200 {
		t.Fatalf("deny %d", code)
	}
	<-ch
	// The rule outlives a new passphrase; the authenticators do not.
	if err := s.ChangePassphrase(pass, "another horse", testWindow); err != nil {
		t.Fatal(err)
	}
	if g, err := s.Guard(); err != nil || !g.VerifyEachAllow || len(g.Authenticators) != 0 {
		t.Errorf("after a new passphrase: %+v %v", g, err)
	}
}

// The desktop app's shell proves the user with the key of its launch: only
// for the desktop client, only once turned on with the passphrase, and it
// learns from the core what a nonce is for.
func TestDesktopProof(t *testing.T) {
	p, h, _ := newTest(t)
	p.Timeout = 5 * time.Second
	c := newClient(p, h)
	c.origin = "http://127.0.0.1:7781"
	key := []byte("the-key-of-this-launch")
	sign := func(nonce string, pu purpose) string {
		m := hmac.New(sha256.New, key)
		m.Write(proofMessage(nonce, pu))
		return hex.EncodeToString(m.Sum(nil))
	}
	verify := func(msg, mac []byte) bool {
		m := hmac.New(sha256.New, key)
		m.Write(msg)
		return hmac.Equal(m.Sum(nil), mac)
	}
	sh := newShell(t, string(key), "install-0123456789ab", false)
	c.kind, c.desktop, c.relay = plugin.Desktop, verify, sh.open
	c.session(t)
	if code, _ := c.do("PUT", "/api/p/vault/vars/KEY", `{"value":"s3cret","machines":["m1"]}`); code != 200 {
		t.Fatal(code)
	}
	session := purpose{For: ForSession}
	try := func(nonce, mac string) (int, map[string]any) {
		return c.do("POST", "/api/p/vault/session", mustJSON(map[string]any{"proof": map[string]string{"nonce": nonce, "mac": mac}}))
	}
	// Not before it is turned on.
	nonce, out := c.nonce(t, `{"for":"session"}`)
	if out["desktop"] != false {
		t.Errorf("offered before it is on: %v", out)
	}
	if code, _ := try(nonce, sign(nonce, session)); code != 401 {
		t.Fatalf("before it is on: %d", code)
	}
	// Turning it on takes the passphrase, the shell's proof and its relay of
	// the install's key.
	register := purpose{For: ForRegister}
	nonce, _ = c.nonce(t, `{"for":"register"}`)
	if code, out := c.do("POST", "/api/p/vault/authenticators", mustJSON(map[string]string{"kind": "desktop", "passphrase": pass, "nonce": nonce, "mac": sign(nonce, session)})); code != 401 {
		t.Fatalf("a MAC of another purpose: %d %v", code, out)
	}
	nonce, _ = c.nonce(t, `{"for":"register"}`)
	if code, out := c.do("POST", "/api/p/vault/authenticators", mustJSON(map[string]string{"kind": "desktop", "label": "Touch ID", "passphrase": pass, "nonce": nonce, "mac": sign(nonce, register), "relay": sh.registration(t, nonce, nil)})); code != 200 {
		t.Fatalf("turning it on: %d %v", code, out)
	}
	c.tok = ""
	nonce, out = c.nonce(t, `{"for":"session"}`)
	if out["desktop"] != true {
		t.Errorf("not offered: %v", out)
	}
	// The shell learns what the nonce is for; a browser does not.
	if code, pu := c.do("GET", "/api/p/vault/proof/"+nonce, ""); code != 200 || pu["for"] != "session" {
		t.Errorf("purpose %d %v", code, pu)
	}
	c.kind = plugin.Browser
	if code, _ := c.do("GET", "/api/p/vault/proof/"+nonce, ""); code != 404 {
		t.Errorf("a browser reading a purpose: %d", code)
	}
	// A browser with the shell's MAC proves nothing.
	if code, _ := try(nonce, sign(nonce, session)); code != 401 {
		t.Fatalf("a browser with the MAC: %d", code)
	}
	c.kind = plugin.Desktop
	nonce, _ = c.nonce(t, `{"for":"session"}`)
	if code, _ := try(nonce, sign(nonce, purpose{For: ForAnswer, Request: "x", Answer: "once"})); code != 401 {
		t.Fatalf("a MAC of another purpose: %d", code)
	}
	nonce, _ = c.nonce(t, `{"for":"session"}`)
	code, out := try(nonce, sign(nonce, session))
	if code != 200 || out["proof"] != true {
		t.Fatalf("the shell's proof: %d %v", code, out)
	}
	// For an answer the purpose names the request, as the prompt shows it.
	ch := make(chan agentproto.VaultResponse, 1)
	go func() {
		ch <- p.Handle(context.Background(), h, "m2", agentproto.VaultRequest{Tool: "env", Names: []string{"KEY"}})
	}()
	req := (<-h.sent)["request"].(*Request)
	answer := purpose{For: ForAnswer, Request: req.ID, Answer: "once"}
	nonce, _ = c.nonce(t, mustJSON(answer))
	_, pu := c.do("GET", "/api/p/vault/proof/"+nonce, "")
	if r, _ := pu["request"].(map[string]any); r == nil || r["machine"] != "m2" || r["tool"] != "env" || pu["answer"] != "once" {
		t.Errorf("purpose of an answer: %v", pu)
	}
	if code, out := c.do("POST", "/api/p/vault/requests/"+req.ID, mustJSON(map[string]any{"answer": "once", "proof": map[string]string{"nonce": nonce, "mac": sign(nonce, answer)}})); code != 200 {
		t.Fatalf("allowed by the shell: %d %v", code, out)
	}
	if r := <-ch; !r.OK {
		t.Fatalf("the requester: %+v", r)
	}
	// A core without the shell's key takes none.
	c.desktop, c.relay = nil, nil
	nonce, out = c.nonce(t, `{"for":"session"}`)
	if out["desktop"] != false {
		t.Errorf("offered without a key: %v", out)
	}
	if code, _ := try(nonce, sign(nonce, session)); code != 401 {
		t.Fatalf("without a key: %d", code)
	}
}

// At most MaxProofs nonces wait; the oldest gives way.
func TestProofNoncesAreBounded(t *testing.T) {
	p, h, _ := newTest(t)
	c := newClient(p, h)
	c.session(t)
	first, _ := c.nonce(t, `{"for":"session"}`)
	for range MaxProofs {
		c.nonce(t, `{"for":"session"}`)
	}
	p.mu.Lock()
	n, kept := len(p.proofs), p.proofs[first] != nil
	p.mu.Unlock()
	if n != MaxProofs || kept {
		t.Errorf("%d nonces, the first kept: %v", n, kept)
	}
}

// Where every Allow is verified, what lets a value out another way needs
// the user's word too: showing it to the page, and letting more machines
// read it or the model see it. Ending the rule takes the passphrase.
func TestVerifyEveryAllowCoversValuesAndGrants(t *testing.T) {
	p, h, _ := newTest(t)
	c := newClient(p, h)
	c.origin = testOrigin
	c.session(t)
	if code, _ := c.do("PUT", "/api/p/vault/vars/KEY", `{"value":"s3cret","machines":["m1"],"injectOnly":true}`); code != 200 {
		t.Fatal(code)
	}
	if code, _ := c.do("PUT", "/api/p/vault/vars/OTHER", `{"value":"x","machines":[]}`); code != 200 {
		t.Fatal(code)
	}
	a := newAuthenticator(t)
	c.register(t, a)
	if code, _ := c.do("POST", "/api/p/vault/guard", `{"verifyEachAllow":true}`); code != 200 {
		t.Fatal(code)
	}
	needs := func(what string, code int, out map[string]any) {
		t.Helper()
		if code != 401 || out["error"] != "vault_proof" {
			t.Errorf("%s: %d %v", what, code, out)
		}
	}
	proof := func(purpose map[string]string) map[string]string {
		t.Helper()
		nonce, _ := c.nonce(t, mustJSON(purpose))
		return a.assertion(t, nonce, c.origin)
	}
	// Showing a value: the session is not enough, nor a proof for another
	// variable or purpose.
	code, out := c.do("POST", "/api/p/vault/vars/KEY/reveal", "")
	needs("a reveal with a session", code, out)
	code, out = c.do("POST", "/api/p/vault/vars/KEY/reveal", mustJSON(map[string]any{"proof": proof(map[string]string{"for": "reveal", "request": "OTHER"})}))
	needs("a proof for another variable", code, out)
	code, out = c.do("POST", "/api/p/vault/vars/KEY/reveal", mustJSON(map[string]any{"proof": proof(map[string]string{"for": "change", "request": "KEY"})}))
	needs("a proof for another purpose", code, out)
	if code, out := c.do("POST", "/api/p/vault/vars/KEY/reveal", mustJSON(map[string]any{"proof": proof(map[string]string{"for": "reveal", "request": "KEY"})})); code != 200 || out["value"] != "s3cret" {
		t.Errorf("a reveal with its proof: %d %v", code, out)
	}
	if code, out := c.do("POST", "/api/p/vault/vars/KEY/reveal", mustJSON(map[string]string{"passphrase": pass})); code != 200 || out["value"] != "s3cret" {
		t.Errorf("a reveal with the passphrase: %d %v", code, out)
	}
	if code, _ := c.do("POST", "/api/p/vault/proof", `{"for":"reveal","request":"NOPE"}`); code != 404 {
		t.Errorf("a nonce for no variable: %d", code)
	}
	// Letting another machine read, every machine, or the model see it.
	for what, body := range map[string]string{
		"another machine": `{"machines":["m1","m2"]}`, "every machine": `{"machines":["*"]}`, "no longer inject-only": `{"injectOnly":false}`,
	} {
		code, out := c.do("PUT", "/api/p/vault/vars/KEY", body)
		needs(what+" with a session", code, out)
	}
	if i, _ := p.store.Get("KEY"); len(i.Machines) != 1 || !i.InjectOnly {
		t.Fatalf("changed by refused requests: %+v", i)
	}
	if code, out := c.do("PUT", "/api/p/vault/vars/KEY", mustJSON(map[string]any{"machines": []string{"m1", "m2"}, "proof": proof(map[string]string{"for": "change", "request": "KEY"})})); code != 200 {
		t.Errorf("a grant with its proof: %d %v", code, out)
	}
	// What narrows or leaves the readers needs only the session, and so
	// does a new variable, whose value the page brings itself.
	for what, body := range map[string]string{
		"fewer machines": `{"machines":["m1"]}`, "a description": `{"description":"d"}`, "a new value": `{"value":"n3w"}`, "inject-only": `{"injectOnly":true}`,
	} {
		if code, out := c.do("PUT", "/api/p/vault/vars/KEY", body); code != 200 {
			t.Errorf("%s: %d %v", what, code, out)
		}
	}
	if code, out := c.do("PUT", "/api/p/vault/vars/NEW", `{"value":"v","machines":["*"]}`); code != 200 {
		t.Errorf("a new variable: %d %v", code, out)
	}
	// The rule ends with the passphrase, not with the session that set it.
	if code, out := c.do("POST", "/api/p/vault/guard", `{"verifyEachAllow":false}`); code != 403 || out["error"] != "wrong_passphrase" {
		t.Errorf("ending the rule with a session: %d %v", code, out)
	}
	if code, out := c.do("POST", "/api/p/vault/guard", `{"verifyEachAllow":false,"passphrase":"wrong horse"}`); code != 403 {
		t.Errorf("a wrong passphrase: %d %v", code, out)
	}
	p.tried(true, false)
	if g, _ := p.store.Guard(); !g.VerifyEachAllow {
		t.Fatal("the rule ended without the passphrase")
	}
	if code, out := c.do("POST", "/api/p/vault/guard", mustJSON(map[string]any{"verifyEachAllow": false, "passphrase": pass})); code != 200 {
		t.Fatalf("ending the rule with the passphrase: %d %v", code, out)
	}
	// Without the rule a session shows values and grants as before.
	if code, _ := c.do("POST", "/api/p/vault/vars/KEY/reveal", ""); code != 200 {
		t.Errorf("a reveal without the rule: %d", code)
	}
	if code, _ := c.do("PUT", "/api/p/vault/vars/KEY", `{"machines":["*"]}`); code != 200 {
		t.Errorf("a grant without the rule: %d", code)
	}
	if !strings.Contains(h.auditLog(), "denied.vault_proof") {
		t.Errorf("audit %s", h.auditLog())
	}
}

// Without a session the list says only what offering biometrics needs: the
// kinds of authenticator this page can prove with, and the ways it can
// unlock a locked vault, not their ids, labels or use, nor the rule, the
// exempt apps or when the vault locks; the nonce names the credentials,
// for the origin the core vouches for.
func TestListWithoutASession(t *testing.T) {
	p, h, _ := newTest(t)
	withMachines(h, "mac")
	c := newClient(p, h)
	c.origin = testOrigin
	c.session(t)
	a := newAuthenticator(t)
	c.register(t, a)
	if code, out := c.do("POST", "/api/p/vault/exempt", mustJSON(map[string]any{"app": "claude", "machines": []string{"m1"}, "passphrase": pass})); code != 200 {
		t.Fatalf("exempt %d %v", code, out)
	}
	if code, _ := c.do("POST", "/api/p/vault/guard", `{"verifyEachAllow":true}`); code != 200 {
		t.Fatal(code)
	}
	_, full := c.do("GET", "/api/p/vault", "")
	g := full["guard"].(map[string]any)
	auths := g["authenticators"].([]any)
	if g["full"] != true || len(g["exempt"].([]any)) != 1 || g["verifyEachAllow"] != true || auths[0].(map[string]any)["label"] != "Touch ID" {
		t.Fatalf("with a session: %v", g)
	}
	if al := full["autoLock"].(map[string]any); al["lockAt"] == nil || al["keyUntil"] != nil || al["custom"] != nil {
		t.Errorf("auto-lock with a session: %v", al)
	}
	if auths[0].(map[string]any)["unlock"] != true {
		t.Errorf("a credential with PRF does not unlock: %v", auths[0])
	}
	bare := func() map[string]any {
		t.Helper()
		_, out := c.do("GET", "/api/p/vault", "")
		b, _ := json.Marshal(out)
		for _, hidden := range []string{"claude", "Touch ID", enc(a.id), auths[0].(map[string]any)["id"].(string), "verifyEachAllow", "exempt", "keyUntil", "lockAt", "lastUsed"} {
			if strings.Contains(string(b), hidden) {
				t.Errorf("without a session the list shows %q: %s", hidden, b)
			}
		}
		return out["guard"].(map[string]any)
	}
	tok := c.tok
	c.tok = ""
	g = bare()
	if ways := g["authenticators"].([]any); len(ways) != 1 || len(ways[0].(map[string]any)) != 2 || ways[0].(map[string]any)["kind"] != "webauthn" || ways[0].(map[string]any)["origin"] != testOrigin || g["webauthn"] != true {
		t.Errorf("without a session: %v", g)
	}
	// The nonce names the credential, which WebAuthn needs.
	if _, out := c.nonce(t, `{"for":"session"}`); len(out["credentials"].([]any)) != 1 || out["credentials"].([]any)[0] != enc(a.id) {
		t.Errorf("the nonce: %v", out)
	}
	// From an origin the core does not vouch for, nothing to prove with.
	c.untrusted = true
	if g = bare(); len(g["authenticators"].([]any)) != 0 || g["webauthn"] != false {
		t.Errorf("an origin not vouched for: %v", g)
	}
	c.untrusted = false
	// Locked, no guard: only the ways to unlock and when the passphrase is
	// due, a hint.
	c.tok = tok
	c.do("POST", "/api/p/vault/lock", "")
	c.tok = ""
	_, out := c.do("GET", "/api/p/vault", "")
	b, _ := json.Marshal(out)
	for _, hidden := range []string{"claude", "Touch ID", enc(a.id), auths[0].(map[string]any)["id"].(string), "lastUsed", "lockAt"} {
		if strings.Contains(string(b), hidden) {
			t.Errorf("a locked vault's list shows %q: %s", hidden, b)
		}
	}
	u := out["unlock"].(map[string]any)
	due, err := time.Parse(time.RFC3339, u["due"].(string))
	if out["guard"] != nil || mustJSON(u["ways"]) != `["prf"]` || err != nil || due.Before(time.Now().AddDate(0, 0, DefaultPassphraseDays-1)) {
		t.Errorf("a locked vault: %s", b)
	}
	// Not for another origin.
	c.untrusted = true
	if _, out := c.do("GET", "/api/p/vault", ""); mustJSON(out["unlock"].(map[string]any)["ways"]) != `[]` {
		t.Errorf("ways of an origin not vouched for: %v", out["unlock"])
	}
}
