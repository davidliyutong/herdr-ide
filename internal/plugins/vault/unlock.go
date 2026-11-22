package vault

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"time"

	"herdr-ide/internal/plugin"
	vaultstore "herdr-ide/internal/vault"
)

// Unlocks by an authenticator: a locked vault's key comes back from the
// unlock entry of an authenticator that wraps it (internal/vault's
// unlock.go), within vault.passphraseDays of the last passphrase.
//
//   - The desktop app (Touch ID with a Secure Enclave key, Windows Hello):
//     its shell reads the nonce's unlock entries (handleProofPurpose),
//     prompts the user, and seals what makes its entry's key-encryption key
//     (the Secure Enclave's ECDH secret or the Hello key's signature, with
//     the shell's own secret) for the core with the key of its launch: a
//     relay (plugin.Call.DesktopRelay), bound to its purpose, the nonce and
//     the entry. The page carries it and cannot read it; the core takes it
//     only from the desktop client.
//   - A WebAuthn credential with PRF: the page brings the credential's PRF
//     output for its entry's salt, with the credential's assertion of the
//     nonce, which the core verifies against the guard the key opens before
//     it installs the key. An output that opens the wrap with a signature
//     that does not hold means the output leaked (audited prf_signature).
//
// A session an unlock opens is marked as a proof's: what guards the vault
// takes the passphrase.

// unlockBody is an unlock as a page sends it in POST session.
type unlockBody struct {
	Nonce string `json:"nonce"`
	// ID and Relay are the desktop app's: the entry it used and what its
	// shell sealed for the core (base64url).
	ID    string `json:"id"`
	Relay string `json:"relay"`
	// PRF and Assertion are a WebAuthn credential's: its PRF output for the
	// entry's salt, and its assertion of the nonce (base64url).
	PRF *struct {
		Credential string `json:"credential"`
		Output     string `json:"output"`
	} `json:"prf"`
	Assertion *proofBody `json:"assertion"`
}

// b64u is binary data that a relay's JSON carries as base64url. It is
// decoded from the relay's own bytes, which are wiped after, never through
// a Go string, which could not be.
type b64u []byte

func (b *b64u) UnmarshalJSON(data []byte) error {
	if len(data) < 2 || data[0] != '"' || data[len(data)-1] != '"' {
		return errProof
	}
	src := bytes.TrimRight(data[1:len(data)-1], "=")
	out := make([]byte, base64.RawURLEncoding.DecodedLen(len(src)))
	n, err := base64.RawURLEncoding.Decode(out, src)
	if err != nil {
		clear(out)
		return errProof
	}
	*b = out[:n]
	return nil
}

// sessionRelay is what the desktop shell seals for an unlock.
type sessionRelay struct {
	Z           b64u `json:"z"`
	Signature   b64u `json:"signature"`
	ShellSecret b64u `json:"shellSecret"`
	// Invalidated: the install's key is gone (its fingerprints changed, the
	// Hello key was removed), so its entry can never open again.
	Invalidated bool `json:"invalidated"`
}

func (r *sessionRelay) wipe() { clear(r.Z); clear(r.Signature); clear(r.ShellSecret) }

// registerRelay is what the desktop shell seals for its unlock entry as
// the desktop authenticator is added.
type registerRelay struct {
	Kind        string `json:"kind"`
	Install     string `json:"install"`
	SEPub       b64u   `json:"sePub"`
	Blob        b64u   `json:"blob"`
	KeyName     string `json:"keyName"`
	PublicKey   b64u   `json:"publicKey"`
	Signature   b64u   `json:"signature"`
	ShellSecret b64u   `json:"shellSecret"`
}

func (r *registerRelay) wipe() { clear(r.Signature); clear(r.ShellSecret) }

// relayAD is a relay's additional data: its purpose (session, register),
// the nonce and the entry ("" for register).
func relayAD(purpose, nonce, id string) []byte {
	return []byte("vault-relay\n" + purpose + "\n" + nonce + "\n" + id)
}

// desktopUnlocks reports whether this call may bring the desktop shell's
// relay.
func desktopUnlocks(c *plugin.Call) bool {
	return c.Client == plugin.Desktop && c.DesktopRelay != nil
}

// desktopKind reports whether an unlock entry is the desktop app's.
func desktopKind(kind string) bool {
	return kind == vaultstore.UnlockEnclave || kind == vaultstore.UnlockHello
}

// unlockState is what the list says of unlocking without the passphrase:
// the ways this client has (the desktop app's entries for the desktop
// client, which tells its own install's apart; a prf entry of this very
// origin), and when the passphrase's window ends by its hint in the clear
// (due, "" for none), which the core does not trust for an unlock. No ids,
// labels or times of authenticators.
func (p *Plugin) unlockState(c *plugin.Call, s *vaultstore.Store) map[string]any {
	origin, rpID := originOf(c)
	ways := []string{}
	add := func(way string) {
		for _, w := range ways {
			if w == way {
				return
			}
		}
		ways = append(ways, way)
	}
	for _, e := range s.UnlockEntries() {
		switch {
		case desktopKind(e.Kind) && desktopUnlocks(c):
			add(e.Kind)
		case e.Kind == vaultstore.UnlockPRF && origin != "" && e.PRF.Origin == origin && e.PRF.RPID == rpID:
			add(e.Kind)
		}
	}
	due := ""
	if t := s.PassphraseDue(); !t.IsZero() {
		due = t.UTC().Format(time.RFC3339)
	}
	return map[string]any{"ways": ways, "due": due}
}

// desktopEntries are the desktop app's unlock entries as its shell needs
// them to unlock: the install each is for and what its key needs (an
// enclave key's blob and the core's ephemeral public key; a Hello key's
// name and the challenge it signs).
func desktopEntries(s *vaultstore.Store) []map[string]any {
	out := []map[string]any{}
	for _, e := range s.UnlockEntries() {
		switch {
		case e.Kind == vaultstore.UnlockEnclave && e.Enclave != nil:
			out = append(out, map[string]any{"id": e.ID, "kind": e.Kind, "install": e.Enclave.Install,
				"enclave": map[string]string{"blob": enc(e.Enclave.Blob), "ephPub": enc(e.Enclave.EphPub)}})
		case e.Kind == vaultstore.UnlockHello && e.Hello != nil:
			out = append(out, map[string]any{"id": e.ID, "kind": e.Kind, "install": e.Hello.Install,
				"hello": map[string]string{"keyName": e.Hello.KeyName, "challenge": enc(e.Hello.Challenge)}})
		}
	}
	return out
}

// sessionByUnlock unlocks a locked vault with an authenticator's unlock
// entry and opens a session marked as a proof's. The check, the unlock and
// the session are one step for a lock (keyMu), as the passphrase's are,
// and are slowed down with the passphrase's checks: an unlock whose key the
// store refused (ErrUnlockFailed: the wrap or the authenticator's assertion
// did not hold) counts as a wrong passphrase, so this route guesses no
// faster. What guesses nothing (a nonce expired or of another purpose, a
// vault already unlocked, a relay that does not open, an entry that is
// gone) is refused without counting.
func (p *Plugin) sessionByUnlock(c *plugin.Call, w http.ResponseWriter, r *http.Request, s *vaultstore.Store, ub *unlockBody) {
	if p.slowDown(w) {
		return
	}
	p.keyMu.Lock()
	epoch := p.currentEpoch()
	if p.keyStep != nil {
		p.keyStep()
	}
	wasLocked := s.Status().Locked
	res := p.unlockWith(c, s, ub)
	if errors.Is(res.err, vaultstore.ErrUnlockOrphan) && res.removed == "" {
		res.removed = "orphan" // the store removed it
	}
	err := res.err
	p.tried(err == nil, errors.Is(err, vaultstore.ErrUnlockFailed))
	tok := ""
	if err == nil {
		if wasLocked {
			p.unlocked(c.Host, res.window.AutoLock)
		}
		if tok = p.newSession(c.Host, epoch, true); tok == "" {
			err = vaultstore.ErrLocked
		}
	}
	p.keyMu.Unlock()
	if res.removed != "" {
		auditRemoved(c, r, res.id, res.kind, res.removed)
	}
	if res.reason != "" {
		// The wrap opened: the authenticator's secret is right but its
		// assertion is not, so the secret left the authenticator.
		c.Host.Audit(r, "denied.vault_proof", map[string]any{"route": r.Method + " " + r.URL.Path, "kind": res.kind, "reason": res.reason})
	}
	fields := map[string]any{"ok": err == nil}
	if res.kind != "" {
		fields["kind"] = res.kind
	}
	c.Host.Audit(r, "vault.unlocked", fields)
	if err != nil {
		if errors.Is(err, vaultstore.ErrUnlockStale) {
			changed(c.Host) // an entry went
		}
		if errors.Is(err, errProof) {
			plugin.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "vault_proof", "message": "the unlock does not hold; the vault's passphrase works"})
			return
		}
		fail(w, err)
		return
	}
	p.touch(c.Host)
	changed(c.Host)
	idle, _ := p.sessionLimits(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"session": tok, "proof": true, "idle": idle.Seconds(), "status": s.Status()})
}

// unlockResult is how an unlock went: the entry's id and kind, the window
// sealed with the passphrase, why a wrap that opened was refused (reason),
// why the entry was removed (removed: a reason of vault.unlock_removed),
// and the error: errProof for what guesses nothing (a nonce, a client or a
// relay that does not hold), the store's ErrUnlockFailed for a key that
// does not open or verify, ErrUnlockStale for an entry or authenticator
// that is gone, ErrPassphraseDue outside the window.
type unlockResult struct {
	id, kind, reason, removed string
	window                    vaultstore.Window
	err                       error
}

// Reasons of vault.unlock_removed, the audit of an unlock entry the plugin
// removes.
const (
	// removedInvalidated: the desktop shell says its install's key is gone.
	removedInvalidated = "invalidated"
	// removedStale: a newer entry of the same install replaced it, or a new
	// passphrase ended it.
	removedStale = "stale"
	// removedOrphan: its authenticator is no longer in the guard.
	removedOrphan = "orphan"
	// removedWrap: what the desktop shell relayed did not open its wrap.
	removedWrap = "wrap"
)

// auditRemoved audits the removal of unlock entry id of kind.
func auditRemoved(c *plugin.Call, r *http.Request, id, kind, reason string) {
	c.Host.Audit(r, "vault.unlock_removed", map[string]any{"id": id, "kind": kind, "reason": reason})
}

// auditRemovedSince audits, with reason, every unlock entry of before that
// s no longer has.
func auditRemovedSince(c *plugin.Call, r *http.Request, s *vaultstore.Store, before []vaultstore.UnlockEntry, reason string) {
	after := s.UnlockEntries()
	for _, e := range before {
		if !slices.ContainsFunc(after, func(o vaultstore.UnlockEntry) bool { return o.ID == e.ID }) {
			auditRemoved(c, r, e.ID, e.Kind, reason)
		}
	}
}

// removeEntry removes the entry of res, which can never open again, for
// reason: the unlock answers ErrUnlockStale.
func removeEntry(c *plugin.Call, s *vaultstore.Store, res *unlockResult, reason string) {
	res.err = vaultstore.ErrUnlockStale
	if err := s.RemoveUnlock(res.id); err != nil {
		if !errors.Is(err, vaultstore.ErrNotFound) {
			c.Host.Logger().Printf("vault: removing unlock entry %s: %v", res.id, err)
		}
		return
	}
	res.removed = reason
}

// unlockWith checks ub and unlocks the vault with its entry; called with
// keyMu held.
func (p *Plugin) unlockWith(c *plugin.Call, s *vaultstore.Store, ub *unlockBody) (res unlockResult) {
	if ub.PRF != nil {
		res.kind = vaultstore.UnlockPRF
	}
	pp, ok := p.takeProof(ub.Nonce, purpose{For: ForSession}, true)
	if !ok || !s.Status().Locked {
		res.err = errProof
		return res
	}
	days := p.passphraseDays(c.Host)
	if ub.PRF != nil {
		return p.unlockPRF(c, s, ub, pp, days)
	}
	if !desktopUnlocks(c) {
		res.err = errProof
		return res
	}
	var entry *vaultstore.UnlockEntry
	for _, e := range s.UnlockEntries() {
		if e.ID == ub.ID {
			entry = &e
			break
		}
	}
	if entry == nil {
		res.err = vaultstore.ErrUnlockStale
		return res
	}
	if !desktopKind(entry.Kind) {
		res.err = errProof
		return res
	}
	res.id, res.kind = entry.ID, entry.Kind
	relay := b64(ub.Relay)
	if len(relay) == 0 {
		res.err = errProof
		return res
	}
	plain, err := c.DesktopRelay(relayAD(ForSession, ub.Nonce, entry.ID), relay)
	defer clear(plain)
	if err != nil {
		res.err = errProof
		return res
	}
	var sr sessionRelay
	defer sr.wipe()
	if json.Unmarshal(plain, &sr) != nil {
		res.err = errProof
		return res
	}
	if sr.Invalidated {
		// The shell's word that the install's key can never open the entry
		// again: it goes.
		removeEntry(c, s, &res, removedInvalidated)
		return res
	}
	var kek []byte
	switch {
	case entry.Kind == vaultstore.UnlockEnclave && entry.Enclave != nil && len(sr.Z) == 32 && len(sr.ShellSecret) == 32:
		kek = vaultstore.EnclaveKEK(sr.Z, sr.ShellSecret, entry.Enclave.EphPub, entry.Enclave.SEPub)
	case entry.Kind == vaultstore.UnlockHello && entry.Hello != nil && len(sr.Signature) > 0 && len(sr.Signature) <= 1024 && len(sr.ShellSecret) == 32:
		kek = vaultstore.HelloKEK(sr.Signature, sr.ShellSecret, entry.Hello.Challenge)
	default:
		res.err = errProof
		return res
	}
	// The relay is its proof: the store checks the rest (the wrap, the
	// check, the authenticator in the guard, the window).
	res.window, res.err = s.UnlockWith(entry.ID, kek, days, nil)
	if errors.Is(res.err, vaultstore.ErrUnlockWrap) {
		// The relay opened, so what it carries is the shell's, made by its
		// install's key just now; a wrap that does not open with it never
		// will (an enrollment that made the key or the shell's secret again
		// and that the core then refused leaves such an entry). It goes, and
		// it is no guess: only the shell, with the launch's key, relays.
		removeEntry(c, s, &res, removedWrap)
	}
	return res
}

// unlockPRF unlocks with a WebAuthn credential's PRF output: its entry for
// this very origin, and its assertion of the nonce verified with the key
// the guard keeps, with a counter that grows, before the key is installed.
func (p *Plugin) unlockPRF(c *plugin.Call, s *vaultstore.Store, ub *unlockBody, pp *pendingProof, days int) (res unlockResult) {
	res.kind = vaultstore.UnlockPRF
	origin, rpID := originOf(c)
	cred := b64(ub.PRF.Credential)
	output := b64(ub.PRF.Output)
	defer clear(output)
	if origin == "" || len(cred) == 0 || len(output) != 32 || ub.Assertion == nil || !bytes.Equal(b64(ub.Assertion.Credential), cred) {
		res.err = errProof
		return res
	}
	var entry *vaultstore.UnlockEntry
	for _, e := range s.UnlockEntries() {
		if e.Kind == vaultstore.UnlockPRF && e.PRF != nil && e.PRF.Origin == origin && e.PRF.RPID == rpID && bytes.Equal(e.PRF.Credential, cred) {
			entry = &e
			break
		}
	}
	if entry == nil {
		res.err = vaultstore.ErrUnlockStale
		return res
	}
	res.id = entry.ID
	kek := vaultstore.PRFKEK(output, entry.PRF.Salt)
	// The store calls verify only once the output opened the wrap and the
	// key its guard, with the entry's credential in it; it holds the store's
	// lock, so it calls nothing of the store.
	verify := func(_ vaultstore.Guard, a vaultstore.Authenticator) (*uint32, error) {
		count, err := verifyAssertion(a, ub.Assertion, pp.challenge)
		switch {
		case errors.Is(err, errCounter):
			res.reason = "prf_counter"
			return nil, err
		case err != nil:
			res.reason = "prf_signature"
			return nil, err
		}
		return &count, nil
	}
	res.window, res.err = s.UnlockWith(entry.ID, kek, days, verify)
	return res
}

// addDesktop adds the desktop authenticator a, whose shell's MAC of nonce
// holds, or its unlock entry for another install of the app to the one
// there is: relay is the shell's (registerRelay), sealed for the register
// purpose and nonce; the Hello key signs the nonce's challenge. Without a
// relay only a desktop authenticator there already is kept (its label
// changed); a new one needs it.
func (p *Plugin) addDesktop(c *plugin.Call, w http.ResponseWriter, r *http.Request, s *vaultstore.Store, a vaultstore.Authenticator, nonce, relay string, pp *pendingProof) {
	var reg registerRelay
	defer reg.wipe()
	if relay != "" {
		raw := b64(relay)
		if !desktopUnlocks(c) || len(raw) == 0 {
			refuseProof(c, w, r, errProof, pp.purpose)
			return
		}
		plain, err := c.DesktopRelay(relayAD(ForRegister, nonce, ""), raw)
		defer clear(plain)
		if err != nil {
			refuseProof(c, w, r, errProof, pp.purpose)
			return
		}
		if json.Unmarshal(plain, &reg) != nil || !vaultstore.ValidInstall(reg.Install) ||
			(reg.Kind != vaultstore.UnlockEnclave && reg.Kind != vaultstore.UnlockHello) ||
			(reg.Kind == vaultstore.UnlockHello && reg.KeyName != vaultstore.HelloKeyName(reg.Install)) {
			plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid", "message": "the desktop app's unlock key is not one the core takes"})
			return
		}
	}
	id, made := "", false
	errNeedRelay := errors.New("a new desktop authenticator needs its unlock key")
	// The authenticator and its entry are one step for a lock (keyMu): a
	// lock between them would leave the authenticator without its entry,
	// and the drop of a new one undone by the lock too.
	p.keyMu.Lock()
	before := s.UnlockEntries()
	err := s.UpdateGuard(func(g *vaultstore.Guard) error {
		for i := range g.Authenticators {
			if g.Authenticators[i].Kind == vaultstore.KindDesktop {
				id = g.Authenticators[i].ID
				if a.Label != "" {
					g.Authenticators[i].Label = a.Label
				}
				return nil
			}
		}
		if relay == "" {
			return errNeedRelay
		}
		g.Authenticators = append(g.Authenticators, a)
		id, made = a.ID, true
		return nil
	})
	if err == nil && relay != "" {
		if p.addStep != nil {
			p.addStep()
		}
		switch reg.Kind {
		case vaultstore.UnlockEnclave:
			_, err = s.AddEnclave(id, reg.Install, reg.Blob, reg.SEPub, reg.ShellSecret)
		case vaultstore.UnlockHello:
			_, err = s.AddHello(id, reg.Install, reg.KeyName, pp.register, reg.PublicKey, reg.Signature, reg.ShellSecret)
		}
		if err != nil && made {
			p.dropAuthenticator(c.Host, s, id)
		}
	}
	p.keyMu.Unlock()
	if errors.Is(err, errNeedRelay) {
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "the desktop app's unlock key (relay) is needed"})
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	// The entry this install had, replaced by the new one.
	auditRemovedSince(c, r, s, before, removedStale)
	if relay != "" {
		c.AuditField("unlock", reg.Kind)
		c.AuditField("install", reg.Install)
	}
	c.AuditField("authenticator", id)
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"guard": p.guardState(c, s, true)})
}
