package vault

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"herdr-ide/internal/plugin"
	vaultstore "herdr-ide/internal/vault"
	"herdr-ide/internal/webauthn"
)

// Proofs: an authenticator's word, in the passphrase's stead, that the user
// is there. The vault must be unlocked (the authenticators are sealed with
// its key): a proof opens a session of an unlocked vault, or answers one
// request, but holds no key. A locked vault is unlocked by an
// authenticator that keeps the key wrapped in its unlock entry (unlock.go),
// within vault.passphraseDays of the last passphrase.
//
// A proof answers a nonce the core issued for one purpose: to open a
// session, to give one request one answer, or to add an authenticator. It
// is used once and lives two minutes; a nonce issued while the vault is
// locked is good only for an unlock, one issued while it is unlocked never
// for one, and every nonce ends with a lock. Two kinds of authenticator
// make one:
//
//   - a WebAuthn credential (a browser's platform authenticator or a
//     security key) signs the nonce as its challenge, with the user
//     verified; the core checks the signature with the key it stored and
//     that the page that asked is the one the credential was added from.
//     A credential is the browser's for a host name, whatever the port, so
//     its origin is kept and compared, and only an origin the core vouches
//     for takes part (plugin.Call.TrustedOrigin): the user's biometrics
//     on a page another program serves on localhost prove nothing here;
//   - the desktop app's shell, after a prompt of the system the user
//     answered (Touch ID, Windows Hello), signs the nonce and its purpose
//     with the key of its launch (plugin.Call.DesktopProof). The shell asks
//     the core what a nonce is for (handleProofPurpose) and shows that in
//     the prompt, so a page cannot ask for one thing and show another.
//
// A session a proof or an unlock by an authenticator opened is marked: it
// answers requests and changes and shows variables, but what guards the
// vault (the authenticators, the rule to verify each Allow, the exempt
// apps, imports and exports) takes a session the passphrase opened.

// The purposes of a proof.
const (
	ForSession  = "session"
	ForAnswer   = "answer"
	ForRegister = "register"
	// ForReveal and ForChange are for one variable (purpose.Request is its
	// name), where every Allow is verified: showing its value to the page,
	// and widening who may read it.
	ForReveal = "reveal"
	ForChange = "change"
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
	// and that answer; for a reveal or a change Request is the variable.
	Request string `json:"request,omitempty"`
	Answer  string `json:"answer,omitempty"`
}

type pendingProof struct {
	purpose
	challenge []byte
	issued    stamp
	seq       uint64
	// locked: issued while the vault was locked, for an unlock only.
	locked bool
	// prfSalt and register are a registration's: the salt a new WebAuthn
	// credential's PRF is evaluated with, and the challenge the desktop
	// app's Windows Hello key signs (32 random bytes each).
	prfSalt, register []byte
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

// errProof is a proof that does not hold (401 vault_proof); errCounter is
// a WebAuthn assertion that verifies but whose counter did not grow.
var (
	errProof   = errors.New("the proof does not hold")
	errCounter = fmt.Errorf("%w: the counter did not grow", errProof)
)

// enc is base64url without padding, as WebAuthn and the relays have it.
var enc = base64.RawURLEncoding.EncodeToString

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

// issueProof makes a nonce for pu, issued while the vault is locked or
// not, with keyMu held (so no lock or unlock comes between the vault's
// state and the nonce).
func (p *Plugin) issueProof(pu purpose, locked bool) (string, *pendingProof) {
	challenge := make([]byte, 32)
	rand.Read(challenge)
	nonce := base64.RawURLEncoding.EncodeToString(challenge)
	pp := &pendingProof{purpose: pu, challenge: challenge, locked: locked}
	if pu.For == ForRegister {
		pp.prfSalt, pp.register = make([]byte, 32), make([]byte, 32)
		rand.Read(pp.prfSalt)
		rand.Read(pp.register)
	}
	now := p.at()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.proofs == nil {
		p.proofs = map[string]*pendingProof{}
	}
	oldest := ""
	for k, pp := range p.proofs {
		if pp.issued.since(now) > proofTTL {
			delete(p.proofs, k)
			continue
		}
		if oldest == "" {
			oldest = k
			continue
		}
		d, od := pp.issued.since(now), p.proofs[oldest].issued.since(now)
		if d > od || (d == od && pp.seq < p.proofs[oldest].seq) {
			oldest = k
		}
	}
	if len(p.proofs) >= MaxProofs {
		delete(p.proofs, oldest)
	}
	p.proofSeq++
	pp.issued, pp.seq = now, p.proofSeq
	p.proofs[nonce] = pp
	return nonce, pp
}

// takeProof ends a nonce and returns it when it was issued for want, while
// the vault was locked as locked says, and is not too old: a nonce is good
// for one try.
func (p *Plugin) takeProof(nonce string, want purpose, locked bool) (*pendingProof, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pp, ok := p.proofs[nonce]
	if !ok {
		return nil, false
	}
	delete(p.proofs, nonce)
	if pp.issued.since(p.at()) > proofTTL || pp.purpose != want || pp.locked != locked {
		return nil, false
	}
	return pp, true
}

// peekProof is a nonce that still waits (its fields are not changed once
// it is issued).
func (p *Plugin) peekProof(nonce string) (*pendingProof, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pp, ok := p.proofs[nonce]
	if !ok || pp.issued.since(p.at()) > proofTTL {
		return nil, false
	}
	return pp, true
}

// originOf is the origin of the call's page when the core vouches for it,
// and the host name a WebAuthn credential of that page is for; "" for any
// other origin: a credential is neither added nor taken there.
func originOf(c *plugin.Call) (origin, rpID string) {
	u, err := url.Parse(c.TrustedOrigin)
	if c.TrustedOrigin == "" || err != nil || u.Hostname() == "" {
		return "", ""
	}
	return c.TrustedOrigin, strings.ToLower(u.Hostname())
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
	pp, ok := p.takeProof(pb.Nonce, want, false)
	if !ok {
		return "", errProof
	}
	challenge := pp.challenge
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
	origin, rpID := originOf(c)
	cred := b64(pb.Credential)
	if origin == "" || len(cred) == 0 {
		return "", errProof
	}
	for _, a := range g.Authenticators {
		// The credential of this very page: the same origin, not only the
		// same host name.
		if a.Kind != vaultstore.KindWebAuthn || a.Origin != origin || a.RPID != rpID || !bytes.Equal(a.Credential, cred) {
			continue
		}
		count, err := verifyAssertion(a, pb, challenge)
		if err != nil {
			return "", errProof
		}
		return vaultstore.KindWebAuthn, p.usedAuthenticator(s, a.ID, now, &count)
	}
	return "", errProof
}

// verifyAssertion checks a WebAuthn assertion of credential a for
// challenge, with its origin and RP id, and returns the counter it signed.
// A counter that does not grow is a copy of the authenticator (errCounter);
// those that do not count always say 0.
func verifyAssertion(a vaultstore.Authenticator, pb *proofBody, challenge []byte) (uint32, error) {
	key, err := webauthn.ParsePublicKey(a.Algorithm, a.PublicKey)
	if err != nil {
		return 0, errProof
	}
	count, err := webauthn.VerifyAssertion(key, b64(pb.ClientDataJSON), b64(pb.AuthenticatorData), b64(pb.Signature),
		webauthn.Expect{Challenge: challenge, Origin: a.Origin, RPID: a.RPID})
	if err != nil {
		return 0, errProof
	}
	if (count != 0 || a.SignCount != 0) && count <= a.SignCount {
		return 0, errCounter
	}
	return count, nil
}

// usedAuthenticator records an authenticator's use (and its counter); one
// that is gone proves nothing.
func (p *Plugin) usedAuthenticator(s *vaultstore.Store, id string, at time.Time, count *uint32) error {
	err := s.RecordProof(id, at, count)
	if errors.Is(err, vaultstore.ErrNotFound) {
		return errProof
	}
	return err
}

// fresh is the user's word for one action, sent with it: an
// authenticator's proof made for the action, or the vault's passphrase
// again. Where every Allow is verified it is what an action needs; a
// session is then not enough.
type fresh struct {
	Proof      *proofBody `json:"proof"`
	Passphrase string     `json:"passphrase"`
}

// verified checks what f brings for want. given says whether it brought
// anything; ok whether that holds. What does not hold is answered here (a
// refused proof, a wrong passphrase, slowed down as every check), so the
// caller only returns.
func (p *Plugin) verified(c *plugin.Call, w http.ResponseWriter, r *http.Request, s *vaultstore.Store, f fresh, want purpose) (given, ok bool) {
	switch {
	case f.Proof != nil:
		kind, err := p.checkProof(c, r, s, f.Proof, want)
		if err != nil {
			refuseProof(c, w, r, err, want)
			return true, false
		}
		c.Host.Audit(r, "vault.proved", map[string]any{"ok": true, "for": want.For, "kind": kind})
		p.touch(c.Host)
		return true, true
	case f.Passphrase != "":
		if st := s.Status(); st.Mode != vaultstore.ModePassphrase || st.Locked {
			fail(w, vaultstore.ErrLocked)
			return true, false
		}
		if p.slowDown(w) {
			return true, false
		}
		err := p.verifyPassphrase(c.Host, s, f.Passphrase)
		p.tried(err == nil, errors.Is(err, vaultstore.ErrPassphrase))
		if err != nil {
			fail(w, err)
			return true, false
		}
		p.touch(c.Host)
		return true, true
	}
	return false, false
}

// verifyPassphrase checks a passphrase brought with a request, which
// starts the passphrase's window again (an unlocked vault's), sealing the
// current unlock's auto-lock time with it.
func (p *Plugin) verifyPassphrase(h plugin.Host, s *vaultstore.Store, passphrase string) error {
	w := p.window(h, p.autoLockAfter(h))
	return s.Verify(passphrase, &w)
}

// strict reports whether every Allow is verified: the guard's rule, and a
// guard that does not open (a file changed outside), which cannot say that
// the rule is off. A locked vault has no rule to ask: nothing is allowed
// from it anyway.
func strict(s *vaultstore.Store) bool {
	g, err := s.Guard()
	if err != nil {
		return !errors.Is(err, vaultstore.ErrLocked) && !errors.Is(err, vaultstore.ErrNoPassphrase)
	}
	return g.VerifyEachAllow
}

// needFresh answers an action that, where every Allow is verified, came
// without a proof or the passphrase.
func needFresh(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	c.Host.Audit(r, "denied.vault_proof", map[string]any{"route": r.Method + " " + r.URL.Path})
	plugin.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "vault_proof", "message": "every Allow is verified: an authenticator's proof or the vault's passphrase is needed"})
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
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Label string `json:"label"`
	// Origin is the page a WebAuthn credential proves for.
	Origin   string    `json:"origin,omitempty"`
	RPID     string    `json:"rpId,omitempty"`
	Created  time.Time `json:"created"`
	LastUsed time.Time `json:"lastUsed,omitzero"`
	// Unlock: it keeps the key wrapped in an unlock entry, so it unlocks a
	// locked vault too; without one (a credential without PRF, added
	// before) it only approves.
	Unlock bool `json:"unlock"`
}

// guardState is what guards the vault as the page of this call sees it;
// nil while the vault is locked. Without a session (full false) it says
// only what a page needs to offer biometrics: the kinds of authenticator
// this page can prove with (the desktop app's prompt for the desktop
// client, a WebAuthn credential added from this very origin), never their
// ids, labels, origins or use, nor the rule or the exempt apps, which would
// tell a program what name to take. The credentials' ids, which WebAuthn
// needs, come with each nonce (handleProof) and only for the origin the
// core vouches for.
func (p *Plugin) guardState(c *plugin.Call, s *vaultstore.Store, full bool) map[string]any {
	g, err := s.Guard()
	if err != nil {
		return nil
	}
	origin, _ := originOf(c)
	if !full {
		ways := []map[string]string{}
		desktop, webauthn := false, false
		for _, a := range g.Authenticators {
			switch {
			case a.Kind == vaultstore.KindDesktop && desktopCan(c) && !desktop:
				desktop = true
				ways = append(ways, map[string]string{"kind": a.Kind})
			case a.Kind == vaultstore.KindWebAuthn && origin != "" && a.Origin == origin && !webauthn:
				webauthn = true
				ways = append(ways, map[string]string{"kind": a.Kind, "origin": origin})
			}
		}
		return map[string]any{"authenticators": ways, "desktop": desktopCan(c), "webauthn": origin != ""}
	}
	wraps := map[string]bool{}
	for _, e := range s.UnlockEntries() {
		wraps[e.Authenticator] = true
	}
	list := []authenticatorInfo{}
	for _, a := range g.Authenticators {
		list = append(list, authenticatorInfo{ID: a.ID, Kind: a.Kind, Label: a.Label, Origin: a.Origin, RPID: a.RPID, Created: a.Created, LastUsed: a.LastUsed, Unlock: wraps[a.ID]})
	}
	exempt := g.Exempt
	if exempt == nil {
		exempt = []vaultstore.Exemption{}
	}
	return map[string]any{
		"full": true, "authenticators": list, "verifyEachAllow": g.VerifyEachAllow, "exempt": exempt,
		// Whether the app this page runs in can prompt the user itself,
		// and whether this page's origin is one a WebAuthn credential can
		// be added for and used from.
		"desktop": desktopCan(c), "webauthn": origin != "",
	}
}

// handleProof issues a nonce: {for: session} or {for: answer, request,
// answer} for a pending request, {for: reveal|change, request} for a
// variable, and {for: register}, which a session the passphrase opened
// asks for. The answer names the WebAuthn credentials of the page's origin
// and whether the desktop app can prove here. While the vault is locked
// only a session's nonce is issued, for an unlock: it names the
// credentials that unlock it with their PRF salts, and whether the
// desktop app has an unlock entry.
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
	case ForReveal, ForChange:
		if _, ok := s.Get(pu.Request); !ok {
			plugin.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "no such variable"})
			return
		}
		pu = purpose{For: pu.For, Request: pu.Request}
	default:
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "for is session, answer, register, reveal or change"})
		return
	}
	origin, rpID := originOf(c)
	creds := []string{}
	// The vault's state and the nonce come together: no lock or unlock
	// comes between them.
	p.keyMu.Lock()
	defer p.keyMu.Unlock()
	if st := s.Status(); pu.For == ForSession && st.Mode == vaultstore.ModePassphrase && st.Locked {
		salts := map[string]string{}
		desktop := false
		for _, e := range s.UnlockEntries() {
			switch {
			case e.Kind == vaultstore.UnlockPRF && origin != "" && e.PRF.Origin == origin && e.PRF.RPID == rpID:
				id := enc(e.PRF.Credential)
				creds = append(creds, id)
				salts[id] = enc(e.PRF.Salt)
			case e.Kind == vaultstore.UnlockEnclave || e.Kind == vaultstore.UnlockHello:
				desktop = desktopUnlocks(c)
			}
		}
		nonce, _ := p.issueProof(pu, true)
		plugin.WriteJSON(w, http.StatusOK, map[string]any{
			"nonce": nonce, "rpId": rpID, "credentials": creds, "desktop": desktop, "ttl": proofTTL.Seconds(), "prf": salts,
		})
		return
	}
	g, err := s.Guard()
	if err != nil {
		fail(w, err)
		return
	}
	desktop := false
	for _, a := range g.Authenticators {
		switch {
		case a.Kind == vaultstore.KindWebAuthn && origin != "" && a.Origin == origin:
			creds = append(creds, enc(a.Credential))
		case a.Kind == vaultstore.KindDesktop:
			desktop = desktopCan(c)
		}
	}
	nonce, pp := p.issueProof(pu, false)
	out := map[string]any{"nonce": nonce, "rpId": rpID, "credentials": creds, "desktop": desktop, "ttl": proofTTL.Seconds()}
	if pu.For == ForRegister {
		out["prfSalt"] = enc(pp.prfSalt)
	}
	plugin.WriteJSON(w, http.StatusOK, out)
}

// handleProofPurpose tells the desktop app's shell what a nonce is for,
// with the request it would answer: the shell shows that in the system's
// prompt, whatever the page said. Only the desktop app gets it. For a
// session's nonce issued while the vault is locked it names the desktop
// app's unlock entries (unlock: the shell uses its own install's), for a
// registration the challenge its Windows Hello key signs (register).
func (p *Plugin) handleProofPurpose(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	pp, ok := p.peekProof(r.PathValue("nonce"))
	if !ok || !desktopCan(c) {
		plugin.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "no such nonce"})
		return
	}
	pu := pp.purpose
	out := map[string]any{"for": pu.For, "answer": pu.Answer}
	if pu.For == ForReveal || pu.For == ForChange {
		out["name"] = pu.Request
	}
	if pu.For == ForAnswer {
		p.mu.Lock()
		req, pending := p.pending[pu.Request]
		p.mu.Unlock()
		if !pending {
			plugin.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "no such request (answered or expired)"})
			return
		}
		// The label is the user's name for the machine, which programs
		// can change; the target (an ssh machine's address) is beside it.
		label, target := req.M, ""
		if mg := c.Host.Machines(); mg != nil {
			if mc := mg.Get(req.M); mc != nil {
				label, target = mc.Label(), mc.Target()
			}
		}
		out["request"] = map[string]any{"id": req.ID, "machine": label, "target": target, "tool": req.Tool, "names": req.Names}
	}
	if pu.For == ForSession && pp.locked {
		s, err := p.open(c.Host)
		if err != nil {
			fail(w, err)
			return
		}
		out["unlock"] = desktopEntries(s)
	}
	if pu.For == ForRegister {
		out["register"] = map[string]string{"challenge": enc(pp.register)}
	}
	plugin.WriteJSON(w, http.StatusOK, out)
}

// handleAddAuthenticator adds an authenticator ({kind, label, passphrase,
// nonce, …}) in a session the passphrase opened, with the passphrase again
// and the proof of a nonce issued for it, and wraps the key for it in an
// unlock entry:
//   - webauthn: what navigator.credentials.create() answered for the nonce
//     (clientDataJSON, authenticatorData, publicKey as
//     SubjectPublicKeyInfo, alg), and an assertion the new credential made
//     of the same nonce, which shows that the key stored is the
//     authenticator's, with its PRF output for the nonce's prfSalt (prf),
//     which the key is wrapped under; a credential without PRF is refused
//     (400 prf_required);
//   - desktop: the shell's MAC of the nonce, so the system's prompt was
//     answered once before it stands in for the passphrase, and its relay
//     (unlock.go) with this install's Secure Enclave or Windows Hello key.
//     There is one desktop authenticator: another install adds its unlock
//     entry to it; a new one needs the relay (400 bad_request).
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
		Relay      string `json:"relay"`

		ClientDataJSON    string     `json:"clientDataJSON"`
		AuthenticatorData string     `json:"authenticatorData"`
		PublicKey         string     `json:"publicKey"`
		Algorithm         int        `json:"alg"`
		Assertion         *proofBody `json:"assertion"`
		PRF               string     `json:"prf"`
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
	var prfOutput []byte
	if body.Kind == vaultstore.KindWebAuthn {
		if body.PRF == "" {
			plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "prf_required", "message": "the credential's PRF output is needed: a credential without PRF cannot unlock the vault"})
			return
		}
		if prfOutput = b64(body.PRF); len(prfOutput) != 32 {
			plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "prf is 32 bytes, base64url"})
			return
		}
		defer clear(prfOutput)
	}
	if p.slowDown(w) {
		return
	}
	err = p.verifyPassphrase(c.Host, s, body.Passphrase)
	p.tried(err == nil, errors.Is(err, vaultstore.ErrPassphrase))
	if err != nil {
		fail(w, err)
		return
	}
	want := purpose{For: ForRegister}
	pp, ok := p.takeProof(body.Nonce, want, false)
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
		p.addDesktop(c, w, r, s, a, body.Nonce, body.Relay, pp)
		return
	case vaultstore.KindWebAuthn:
		origin, rpID := originOf(c)
		if origin == "" {
			plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "webauthn_origin", "message": "a WebAuthn credential is added from the UI's own address by name: http://localhost on the core's port, or the reverse proxy's"})
			return
		}
		e := webauthn.Expect{Challenge: pp.challenge, Origin: origin, RPID: rpID}
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
		a.Origin, a.RPID, a.Credential, a.Algorithm, a.PublicKey, a.SignCount = origin, rpID, cred, body.Algorithm, spki, count
	}
	// The authenticator and its entry are one step for a lock (keyMu): a
	// lock between them would leave the authenticator without its entry,
	// and the drop of it undone by the lock too.
	p.keyMu.Lock()
	before := s.UnlockEntries()
	err = s.UpdateGuard(func(g *vaultstore.Guard) error {
		// A credential once: added again, it replaces itself (and its
		// unlock entry goes with the one it replaces).
		g.Authenticators = slices.DeleteFunc(g.Authenticators, func(o vaultstore.Authenticator) bool {
			return o.Kind == a.Kind && o.Origin == a.Origin && bytes.Equal(o.Credential, a.Credential)
		})
		g.Authenticators = append(g.Authenticators, a)
		return nil
	})
	if err == nil {
		if p.addStep != nil {
			p.addStep()
		}
		if _, err = s.AddPRF(a.ID, a.Origin, a.RPID, a.Credential, pp.prfSalt, prfOutput); err != nil {
			// Without its unlock entry it is not added.
			p.dropAuthenticator(c.Host, s, a.ID)
		}
	}
	p.keyMu.Unlock()
	// The entry of the credential it replaced went with it, also when its
	// own could not be made.
	auditRemovedSince(c, r, s, before, removedOrphan)
	if err != nil {
		fail(w, err)
		return
	}
	c.AuditField("authenticator", a.ID)
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"guard": p.guardState(c, s, true)})
}

// dropAuthenticator removes an authenticator just added whose unlock entry
// could not be made; called with keyMu held, as its add.
func (p *Plugin) dropAuthenticator(h plugin.Host, s *vaultstore.Store, id string) {
	err := s.UpdateGuard(func(g *vaultstore.Guard) error {
		g.Authenticators = slices.DeleteFunc(g.Authenticators, func(o vaultstore.Authenticator) bool { return o.ID == id })
		return nil
	})
	if err != nil {
		h.Logger().Printf("vault: removing authenticator %s: %v", id, err)
	}
}

// handleDeleteAuthenticator removes an authenticator; its unlock entries go
// in the same write (the store's UpdateGuard), so it unlocks nothing after.
func (p *Plugin) handleDeleteAuthenticator(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	id := r.PathValue("id")
	found := false
	before := s.UnlockEntries()
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
	auditRemovedSince(c, r, s, before, removedOrphan)
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"guard": p.guardState(c, s, true)})
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
		VerifyEachAllow *bool  `json:"verifyEachAllow"`
		Passphrase      string `json:"passphrase"`
	}
	if err := plugin.ReadJSON(r, 64<<10, &body); err != nil {
		plugin.WriteError(w, err)
		return
	}
	if body.VerifyEachAllow == nil {
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "verifyEachAllow is true or false"})
		return
	}
	c.AuditField("verifyEachAllow", *body.VerifyEachAllow)
	// Turning the rule off takes the passphrase with the request: the
	// page's session, which a program driving the page has too, would
	// otherwise end the rule that stands against such a program.
	if !*body.VerifyEachAllow && strict(s) {
		if given, ok := p.verified(c, w, r, s, fresh{Passphrase: body.Passphrase}, purpose{}); !given {
			plugin.WriteJSON(w, http.StatusForbidden, map[string]string{"error": "wrong_passphrase", "message": "the vault's passphrase is needed to end the rule"})
			return
		} else if !ok {
			return
		}
	}
	if err := s.UpdateGuard(func(g *vaultstore.Guard) error { g.VerifyEachAllow = *body.VerifyEachAllow; return nil }); err != nil {
		fail(w, err)
		return
	}
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"guard": p.guardState(c, s, true)})
}

// handleAddExempt exempts an app on machines ({"app", "machines",
// "passphrase"}): its requests there read without asking while the vault is
// unlocked. It is a lasting grant across every variable, as adding an
// authenticator is, so it takes a session the passphrase opened and the
// passphrase again with the request: a session alone is what a program
// driving the page has too. The app's name is one the kernels keep whole
// and no shell or interpreter (CheckApp); the machines are this core's.
// Exempting one that is there already changes nothing.
func (p *Plugin) handleAddExempt(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	var body struct {
		App        string   `json:"app"`
		Machines   []string `json:"machines"`
		Passphrase string   `json:"passphrase"`
	}
	if err := plugin.ReadJSON(r, 16<<10, &body); err != nil {
		plugin.WriteError(w, err)
		return
	}
	if len(body.Machines) == 0 || len(body.Machines) > vaultstore.MaxExemptions {
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "1 to 64 machines"})
		return
	}
	if err := vaultstore.CheckApp(body.App); err != nil {
		fail(w, err)
		return
	}
	mg := c.Host.Machines()
	for _, m := range body.Machines {
		if m == "" || m == vaultstore.AllMachines || (mg != nil && mg.Get(m) == nil) {
			plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown_machine", "message": "no machine " + clip(m, 64)})
			return
		}
	}
	c.AuditField("app", body.App)
	c.AuditField("machines", body.Machines)
	if !p.passphraseAgain(c, w, r, s, body.Passphrase) {
		return
	}
	now := p.clock().UTC()
	err = s.UpdateGuard(func(g *vaultstore.Guard) error {
		for _, m := range body.Machines {
			if slices.ContainsFunc(g.Exempt, func(e vaultstore.Exemption) bool { return e.Machine == m && e.App == body.App }) {
				continue
			}
			idBytes := make([]byte, 8)
			rand.Read(idBytes)
			g.Exempt = append(g.Exempt, vaultstore.Exemption{ID: hex.EncodeToString(idBytes), Machine: m, App: body.App, Created: now})
		}
		return nil
	})
	if err != nil {
		fail(w, err)
		return
	}
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"guard": p.guardState(c, s, true)})
}

// passphraseAgain checks the vault's passphrase brought with a request that
// lets more out than its session may decide alone (an exemption), slowed
// down as every check. None is 403
// passphrase_required, a wrong one 403 wrong_passphrase; either is answered
// here, so the caller only returns on false.
func (p *Plugin) passphraseAgain(c *plugin.Call, w http.ResponseWriter, r *http.Request, s *vaultstore.Store, passphrase string) bool {
	given, ok := p.verified(c, w, r, s, fresh{Passphrase: passphrase}, purpose{})
	if !given {
		c.Host.Audit(r, "denied.passphrase_required", map[string]any{"route": r.Method + " " + r.URL.Path})
		plugin.WriteJSON(w, http.StatusForbidden, map[string]string{"error": "passphrase_required", "message": "this needs the vault's passphrase with the request"})
		return false
	}
	return ok
}

// handleDeleteExempt ends an exemption.
func (p *Plugin) handleDeleteExempt(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	id := r.PathValue("id")
	found := false
	err = s.UpdateGuard(func(g *vaultstore.Guard) error {
		g.Exempt = slices.DeleteFunc(g.Exempt, func(e vaultstore.Exemption) bool {
			if e.ID == id {
				found = true
				c.AuditField("app", e.App)
				c.AuditField("machine", e.Machine)
				return true
			}
			return false
		})
		return nil
	})
	if err != nil {
		fail(w, err)
		return
	}
	if !found {
		plugin.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "no such exemption"})
		return
	}
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"guard": p.guardState(c, s, true)})
}
