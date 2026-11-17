package vault

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"herdr-ide/internal/plugin"
	vaultstore "herdr-ide/internal/vault"
	"herdr-ide/internal/webauthn"
)

// Proofs: an authenticator's word, in the passphrase's stead, that the user
// is there. The vault must be unlocked (its authenticators are sealed with
// the key), so a proof never unlocks it; after a start or a lock the
// passphrase is needed once.
//
// A proof answers a nonce the core issued for one purpose: to open a
// session, to give one request one answer, or to add an authenticator. It
// is used once and lives two minutes. Two kinds of authenticator make one:
//
//   - a WebAuthn credential (a browser's platform authenticator or a
//     security key) signs the nonce as its challenge, with the user
//     verified; the core checks the signature with the key it stored, the
//     page's origin and the host name the credential is for;
//   - the desktop app's shell, after a prompt of the system the user
//     answered (Touch ID, Windows Hello), signs the nonce and its purpose
//     with the key of its launch (plugin.Call.DesktopProof). The shell asks
//     the core what a nonce is for (handleProofPurpose) and shows that in
//     the prompt, so a page cannot ask for one thing and show another.
//
// A session a proof opened is marked: it answers requests and changes and
// shows variables, but what guards the vault (the authenticators, the rule
// to verify each Allow, the automatic lock, imports and exports) takes a
// session the passphrase opened.

// The purposes of a proof.
const (
	ForSession  = "session"
	ForAnswer   = "answer"
	ForRegister = "register"
)

const (
	// proofTTL is how long a nonce may be answered.
	proofTTL = 2 * time.Minute
	// MaxProofs bounds the nonces waiting for their proof; the oldest
	// gives way.
	MaxProofs = 32
	// maxLabel bounds an authenticator's name.
	maxLabel = 64
)

// purpose is what a nonce's proof is good for.
type purpose struct {
	For string `json:"for"`
	// Request and Answer: the request a proof for an answer is made for,
	// and that answer.
	Request string `json:"request,omitempty"`
	Answer  string `json:"answer,omitempty"`
}

type pendingProof struct {
	purpose
	challenge []byte
	issued    time.Time
}

// proofBody is a proof as a page sends it.
type proofBody struct {
	Nonce string `json:"nonce"`
	// MAC is the desktop shell's, hex.
	MAC string `json:"mac,omitempty"`
	// The rest is a WebAuthn assertion, base64url: the credential's id and
	// the three parts of the authenticator's response.
	Credential        string `json:"credential,omitempty"`
	ClientDataJSON    string `json:"clientDataJSON,omitempty"`
	AuthenticatorData string `json:"authenticatorData,omitempty"`
	Signature         string `json:"signature,omitempty"`
}

// errProof is a proof that does not hold (401 vault_proof).
var errProof = errors.New("the proof does not hold")

func b64(s string) []byte {
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
	if err != nil {
		return nil
	}
	return b
}

// proofMessage is what the desktop shell signs: the nonce with its
// purpose, so a MAC made for one purpose is none for another.
func proofMessage(nonce string, pu purpose) []byte {
	return []byte("vault-proof\n" + nonce + "\n" + pu.For + "\n" + pu.Request + "\n" + pu.Answer)
}

// issueProof makes a nonce for pu.
func (p *Plugin) issueProof(pu purpose) string {
	challenge := make([]byte, 32)
	rand.Read(challenge)
	nonce := base64.RawURLEncoding.EncodeToString(challenge)
	now := p.clock()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.proofs == nil {
		p.proofs = map[string]*pendingProof{}
	}
	oldest := ""
	for k, pp := range p.proofs {
		if now.Sub(pp.issued) > proofTTL {
			delete(p.proofs, k)
			continue
		}
		if oldest == "" || pp.issued.Before(p.proofs[oldest].issued) {
			oldest = k
		}
	}
	if len(p.proofs) >= MaxProofs {
		delete(p.proofs, oldest)
	}
	p.proofs[nonce] = &pendingProof{purpose: pu, challenge: challenge, issued: now}
	return nonce
}

// takeProof ends a nonce and returns its challenge when it was issued for
// want and is not too old: a nonce is good for one try.
func (p *Plugin) takeProof(nonce string, want purpose) ([]byte, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pp, ok := p.proofs[nonce]
	if !ok {
		return nil, false
	}
	delete(p.proofs, nonce)
	if p.clock().Sub(pp.issued) > proofTTL || pp.purpose != want {
		return nil, false
	}
	return pp.challenge, true
}

// peekProof is the purpose of a nonce that still waits.
func (p *Plugin) peekProof(nonce string) (purpose, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pp, ok := p.proofs[nonce]
	if !ok || p.clock().Sub(pp.issued) > proofTTL {
		return purpose{}, false
	}
	return pp.purpose, true
}

// originOf is the request's origin and the host name a WebAuthn credential
// of its page is for ("" without an Origin header: no page sent it).
func originOf(r *http.Request) (origin, rpID string) {
	origin = r.Header.Get("Origin")
	u, err := url.Parse(origin)
	if origin == "" || err != nil || u.Hostname() == "" {
		return "", ""
	}
	return origin, strings.ToLower(u.Hostname())
}

// desktopCan reports whether this call may bring the desktop shell's proof.
func desktopCan(c *plugin.Call) bool {
	return c.Client == plugin.Desktop && c.DesktopProof != nil
}

// checkProof checks pb as a proof for want and returns the kind of
// authenticator that made it. The vault must be unlocked (ErrLocked);
// anything else that fails is errProof. A proof that holds marks its
// authenticator used.
func (p *Plugin) checkProof(c *plugin.Call, r *http.Request, s *vaultstore.Store, pb *proofBody, want purpose) (string, error) {
	challenge, ok := p.takeProof(pb.Nonce, want)
	if !ok {
		return "", errProof
	}
	g, err := s.Guard()
	if err != nil {
		return "", err
	}
	now := p.clock().UTC()
	if pb.MAC != "" {
		mac, err := hex.DecodeString(pb.MAC)
		if err != nil || !desktopCan(c) || !c.DesktopProof(proofMessage(pb.Nonce, want), mac) {
			return "", errProof
		}
		id := ""
		for _, a := range g.Authenticators {
			if a.Kind == vaultstore.KindDesktop {
				id = a.ID
			}
		}
		if id == "" {
			return "", errProof
		}
		return vaultstore.KindDesktop, p.usedAuthenticator(s, id, now, nil)
	}
	origin, rpID := originOf(r)
	cred := b64(pb.Credential)
	if origin == "" || len(cred) == 0 {
		return "", errProof
	}
	for _, a := range g.Authenticators {
		if a.Kind != vaultstore.KindWebAuthn || a.RPID != rpID || !bytes.Equal(a.Credential, cred) {
			continue
		}
		key, err := webauthn.ParsePublicKey(a.Algorithm, a.PublicKey)
		if err != nil {
			return "", errProof
		}
		count, err := webauthn.VerifyAssertion(key, b64(pb.ClientDataJSON), b64(pb.AuthenticatorData), b64(pb.Signature),
			webauthn.Expect{Challenge: challenge, Origin: origin, RPID: rpID})
		// A counter that does not grow is a copy of the authenticator;
		// those that do not count always say 0.
		if err != nil || ((count != 0 || a.SignCount != 0) && count <= a.SignCount) {
			return "", errProof
		}
		return vaultstore.KindWebAuthn, p.usedAuthenticator(s, a.ID, now, &count)
	}
	return "", errProof
}

// usedAuthenticator records an authenticator's use (and its counter).
func (p *Plugin) usedAuthenticator(s *vaultstore.Store, id string, at time.Time, count *uint32) error {
	return s.UpdateGuard(func(g *vaultstore.Guard) error {
		for i := range g.Authenticators {
			if a := &g.Authenticators[i]; a.ID == id {
				a.LastUsed = at
				if count != nil {
					a.SignCount = *count
				}
				return nil
			}
		}
		return errProof
	})
}

// refuseProof answers a proof that does not hold; a locked vault says so.
func refuseProof(c *plugin.Call, w http.ResponseWriter, r *http.Request, err error, pu purpose) {
	c.Host.Audit(r, "vault.proved", map[string]any{"ok": false, "for": pu.For})
	if !errors.Is(err, errProof) {
		fail(w, err)
		return
	}
	plugin.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "vault_proof", "message": "the proof does not hold; the vault's passphrase works"})
}

// authenticatorInfo is an authenticator as pages see it: no key.
type authenticatorInfo struct {
	ID       string    `json:"id"`
	Kind     string    `json:"kind"`
	Label    string    `json:"label"`
	RPID     string    `json:"rpId,omitempty"`
	Created  time.Time `json:"created"`
	LastUsed time.Time `json:"lastUsed,omitzero"`
}

// guardState is what guards the vault as the page of this call sees it;
// nil while the vault is locked.
func (p *Plugin) guardState(c *plugin.Call, s *vaultstore.Store) map[string]any {
	g, err := s.Guard()
	if err != nil {
		return nil
	}
	list := []authenticatorInfo{}
	for _, a := range g.Authenticators {
		list = append(list, authenticatorInfo{ID: a.ID, Kind: a.Kind, Label: a.Label, RPID: a.RPID, Created: a.Created, LastUsed: a.LastUsed})
	}
	return map[string]any{
		"authenticators": list, "verifyEachAllow": g.VerifyEachAllow,
		// Whether the app this page runs in can prompt the user itself.
		"desktop": desktopCan(c),
	}
}

// handleProof issues a nonce: {for: session} or {for: answer, request,
// answer} for a pending request, and {for: register}, which a session the
// passphrase opened asks for. The answer names the WebAuthn credentials of
// the page's host and whether the desktop app's authenticator is on.
func (p *Plugin) handleProof(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	var pu purpose
	if err := plugin.ReadJSON(r, 4<<10, &pu); err != nil {
		plugin.WriteError(w, err)
		return
	}
	switch pu.For {
	case ForSession:
		pu = purpose{For: ForSession}
	case ForAnswer:
		if pu.Answer != AnswerOnce && pu.Answer != AnswerAlways {
			plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "answer is once or always"})
			return
		}
		p.mu.Lock()
		_, pending := p.pending[pu.Request]
		p.mu.Unlock()
		if !pending {
			plugin.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "no such request (answered or expired)"})
			return
		}
	case ForRegister:
		if open, byProof := p.sessionKind(c.Host, r, true); !open || byProof {
			refusePassphraseSession(c, w, r, open)
			return
		}
		pu = purpose{For: ForRegister}
	default:
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "for is session, answer or register"})
		return
	}
	g, err := s.Guard()
	if err != nil {
		fail(w, err)
		return
	}
	_, rpID := originOf(r)
	creds := []string{}
	desktop := false
	for _, a := range g.Authenticators {
		switch {
		case a.Kind == vaultstore.KindWebAuthn && rpID != "" && a.RPID == rpID:
			creds = append(creds, base64.RawURLEncoding.EncodeToString(a.Credential))
		case a.Kind == vaultstore.KindDesktop:
			desktop = desktopCan(c)
		}
	}
	plugin.WriteJSON(w, http.StatusOK, map[string]any{
		"nonce": p.issueProof(pu), "rpId": rpID, "credentials": creds, "desktop": desktop, "ttl": proofTTL.Seconds(),
	})
}

// handleProofPurpose tells the desktop app's shell what a nonce is for,
// with the request it would answer: the shell shows that in the system's
// prompt, whatever the page said. Only the desktop app gets it.
func (p *Plugin) handleProofPurpose(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	pu, ok := p.peekProof(r.PathValue("nonce"))
	if !ok || !desktopCan(c) {
		plugin.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "no such nonce"})
		return
	}
	out := map[string]any{"for": pu.For, "answer": pu.Answer}
	if pu.For == ForAnswer {
		p.mu.Lock()
		req, pending := p.pending[pu.Request]
		p.mu.Unlock()
		if !pending {
			plugin.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "no such request (answered or expired)"})
			return
		}
		label := req.M
		if mg := c.Host.Machines(); mg != nil {
			if mc := mg.Get(req.M); mc != nil {
				label = mc.Label()
			}
		}
		out["request"] = map[string]any{"id": req.ID, "machine": label, "tool": req.Tool, "names": req.Names}
	}
	plugin.WriteJSON(w, http.StatusOK, out)
}

// handleAddAuthenticator adds an authenticator ({kind, label, passphrase,
// nonce, …}) in a session the passphrase opened, with the passphrase again
// and the proof of a nonce issued for it:
//   - webauthn: what navigator.credentials.create() answered for the nonce
//     (clientDataJSON, authenticatorData, publicKey as
//     SubjectPublicKeyInfo, alg), and an assertion the new credential made
//     of the same nonce, which shows that the key stored is the
//     authenticator's;
//   - desktop: the shell's MAC of the nonce, so the system's prompt was
//     answered once before it stands in for the passphrase.
func (p *Plugin) handleAddAuthenticator(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	var body struct {
		Kind       string `json:"kind"`
		Label      string `json:"label"`
		Passphrase string `json:"passphrase"`
		Nonce      string `json:"nonce"`
		MAC        string `json:"mac"`

		ClientDataJSON    string     `json:"clientDataJSON"`
		AuthenticatorData string     `json:"authenticatorData"`
		PublicKey         string     `json:"publicKey"`
		Algorithm         int        `json:"alg"`
		Assertion         *proofBody `json:"assertion"`
	}
	if err := plugin.ReadJSON(r, 64<<10, &body); err != nil {
		plugin.WriteError(w, err)
		return
	}
	label := strings.TrimSpace(body.Label)
	if len([]rune(label)) > maxLabel || (body.Kind != vaultstore.KindWebAuthn && body.Kind != vaultstore.KindDesktop) {
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "kind is webauthn or desktop, with a label of at most 64 characters"})
		return
	}
	c.AuditField("kind", body.Kind)
	if p.slowDown(w) {
		return
	}
	err = s.Verify(body.Passphrase)
	p.tried(err == nil, errors.Is(err, vaultstore.ErrPassphrase))
	if err != nil {
		fail(w, err)
		return
	}
	want := purpose{For: ForRegister}
	challenge, ok := p.takeProof(body.Nonce, want)
	if !ok {
		refuseProof(c, w, r, errProof, want)
		return
	}
	idBytes := make([]byte, 8)
	rand.Read(idBytes)
	a := vaultstore.Authenticator{ID: hex.EncodeToString(idBytes), Kind: body.Kind, Label: label, Created: p.clock().UTC()}
	switch body.Kind {
	case vaultstore.KindDesktop:
		mac, err := hex.DecodeString(body.MAC)
		if err != nil || !desktopCan(c) || !c.DesktopProof(proofMessage(body.Nonce, want), mac) {
			refuseProof(c, w, r, errProof, want)
			return
		}
	case vaultstore.KindWebAuthn:
		origin, rpID := originOf(r)
		e := webauthn.Expect{Challenge: challenge, Origin: origin, RPID: rpID}
		spki := b64(body.PublicKey)
		cred, err := webauthn.VerifyRegistration(b64(body.ClientDataJSON), b64(body.AuthenticatorData), e)
		if err != nil || body.Assertion == nil || !bytes.Equal(b64(body.Assertion.Credential), cred) {
			refuseProof(c, w, r, errProof, want)
			return
		}
		key, err := webauthn.ParsePublicKey(body.Algorithm, spki)
		if err != nil {
			refuseProof(c, w, r, errProof, want)
			return
		}
		count, err := webauthn.VerifyAssertion(key, b64(body.Assertion.ClientDataJSON), b64(body.Assertion.AuthenticatorData), b64(body.Assertion.Signature), e)
		if err != nil {
			refuseProof(c, w, r, errProof, want)
			return
		}
		a.RPID, a.Credential, a.Algorithm, a.PublicKey, a.SignCount = rpID, cred, body.Algorithm, spki, count
	}
	err = s.UpdateGuard(func(g *vaultstore.Guard) error {
		kept := g.Authenticators[:0]
		for _, o := range g.Authenticators {
			// One desktop authenticator, and a credential once.
			same := o.Kind == a.Kind && (a.Kind == vaultstore.KindDesktop || (o.RPID == a.RPID && bytes.Equal(o.Credential, a.Credential)))
			if !same {
				kept = append(kept, o)
			}
		}
		g.Authenticators = append(kept, a)
		return nil
	})
	if err != nil {
		fail(w, err)
		return
	}
	c.AuditField("authenticator", a.ID)
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"guard": p.guardState(c, s)})
}

func (p *Plugin) handleDeleteAuthenticator(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	id := r.PathValue("id")
	found := false
	err = s.UpdateGuard(func(g *vaultstore.Guard) error {
		kept := g.Authenticators[:0]
		for _, o := range g.Authenticators {
			if o.ID == id {
				found = true
				continue
			}
			kept = append(kept, o)
		}
		g.Authenticators = kept
		return nil
	})
	if err != nil {
		fail(w, err)
		return
	}
	if !found {
		plugin.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "no such authenticator"})
		return
	}
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"guard": p.guardState(c, s)})
}

// handleGuard sets the rule that every Allow needs a proof made for it
// ({verifyEachAllow}).
func (p *Plugin) handleGuard(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	var body struct {
		VerifyEachAllow *bool `json:"verifyEachAllow"`
	}
	if err := plugin.ReadJSON(r, 4<<10, &body); err != nil {
		plugin.WriteError(w, err)
		return
	}
	if body.VerifyEachAllow == nil {
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "verifyEachAllow is true or false"})
		return
	}
	c.AuditField("verifyEachAllow", *body.VerifyEachAllow)
	if err := s.UpdateGuard(func(g *vaultstore.Guard) error { g.VerifyEachAllow = *body.VerifyEachAllow; return nil }); err != nil {
		fail(w, err)
		return
	}
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"guard": p.guardState(c, s)})
}
