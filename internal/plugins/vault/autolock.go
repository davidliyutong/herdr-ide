package vault

import (
	"net/http"
	"time"

	"herdr-ide/internal/plugin"
	vaultstore "herdr-ide/internal/vault"
)

// The key's hold and the automatic lock.
//
// The passphrase gives the core the key, which the core then holds in its
// memory for vault.passphraseHours (24 by default) from the last time the
// passphrase was given (an unlock, a session opened with it, a new
// passphrase). A lock in that time, by Lock or after vault.autoLock minutes
// without use, suspends a vault that has an authenticator: every session
// ends and nothing is read or sealed, but the key stays, so that the
// authenticator's proof unlocks the vault again (sessionByProof). A vault
// without one, or a Lock that asks to forget, forgets the key: only the
// passphrase unlocks it. Once the hold is over the key is forgotten,
// whatever the vault's state.
//
// The panel shows when the vault locks and may set another time for this
// unlock (POST autolock), which holds until the vault locks. A use is an
// unlock, a page's action through the gate (a change, a reveal, an
// approval, an export or import) and a value released to a machine; lists
// and refusals are not. While the core holds the key a timer runs: it
// fires when the vault would lock or the hold end, or every lockCheckEvery
// at the latest, so a change of the settings counts within a minute; every
// route also looks at the hold first (open).

// touch notes a use of the vault and keeps the auto-lock's timer running.
func (p *Plugin) touch(h plugin.Host) {
	p.mu.Lock()
	p.lastUse = p.at()
	armed := p.lockTimer != nil
	p.mu.Unlock()
	if !armed {
		p.armAutoLock(h, 0)
	}
}

func (p *Plugin) lockCheckEvery() time.Duration {
	if p.lockCheck > 0 {
		return p.lockCheck
	}
	return lockCheckEvery
}

// armAutoLock starts the timer for wait (at most lockCheckEvery), unless
// one runs.
func (p *Plugin) armAutoLock(h plugin.Host, wait time.Duration) {
	every := p.lockCheckEvery()
	if wait <= 0 || wait > every {
		wait = every
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.lockTimer == nil {
		p.lockTimer = time.AfterFunc(wait, func() { p.autoLock(h) })
	}
}

// keyFrom begins the key's hold as the passphrase is given: from now, for
// the setting's time then at most (passphraseFor).
func (p *Plugin) keyFrom(h plugin.Host) {
	d := p.passphraseSetting(h)
	p.mu.Lock()
	p.keyAt, p.keyCap, p.keyCapSet = p.at(), d, true
	p.mu.Unlock()
}

// keyLeft is how long the core still holds the key, by the wall clock or
// the monotonic one, whichever has gone further (stamp): the computer's
// sleep counts. A hold that no passphrase began (a store unlocked another
// way) begins now.
func (p *Plugin) keyLeft(h plugin.Host) time.Duration {
	hold := p.passphraseFor(h)
	now := p.at()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.keyAt.zero() {
		p.keyAt = now
	}
	return hold - p.keyAt.since(now)
}

// expire forgets the key once its hold is over, as a Lock that forgets
// does (every session ends; only the passphrase unlocks the vault), and
// reports whether it did.
func (p *Plugin) expire(h plugin.Host, s *vaultstore.Store) bool {
	if !s.Held() || p.keyLeft(h) > 0 {
		return false
	}
	p.keyMu.Lock()
	// The passphrase given meanwhile began another hold.
	if !s.Held() || p.keyLeft(h) > 0 {
		p.keyMu.Unlock()
		return false
	}
	hold := p.passphraseFor(h)
	p.lockStore(s, true)
	p.keyMu.Unlock()
	h.Audit(nil, "vault.locked", map[string]any{"reason": "passphrase", "hours": hold.Hours(), "keyHeld": false})
	changed(h)
	return true
}

// hasAuthenticators reports whether a proof could unlock the vault again.
func hasAuthenticators(s *vaultstore.Store) bool {
	g, err := s.Guard()
	return err == nil && len(g.Authenticators) > 0
}

// lockStore locks the vault, with keyMu held: it suspends one that has an
// authenticator, whose key the core keeps for the rest of its hold, and
// forgets the key of one without (only the passphrase would open it) or
// when forget says so. Every session ends either way. It reports whether
// the key was forgotten.
func (p *Plugin) lockStore(s *vaultstore.Store, forget bool) bool {
	keep := !forget && s.Held() && hasAuthenticators(s)
	if keep {
		s.Suspend()
	} else {
		s.Lock()
	}
	p.endSessions()
	p.clearLockFor(!keep)
	return !keep
}

// autoLock is the timer's look: it forgets the key once its hold is over,
// locks the vault if it went unused for the auto-lock's time, and
// otherwise looks again later; a vault whose key the core does not hold
// needs no timer until it is unlocked.
func (p *Plugin) autoLock(h plugin.Host) {
	p.mu.Lock()
	p.lockTimer = nil
	s := p.store
	p.mu.Unlock()
	if s == nil || !s.Held() || p.expire(h, s) {
		return
	}
	left := p.keyLeft(h)
	if s.Status().Locked {
		// Suspended: the hold's end is what is due.
		p.armAutoLock(h, left)
		return
	}
	after := p.autoLockAfter(h)
	idle := func() time.Duration {
		now := p.at()
		p.mu.Lock()
		defer p.mu.Unlock()
		return p.lastUse.since(now)
	}
	if after <= 0 || idle() < after {
		wait := left
		if after > 0 {
			wait = min(wait, after-idle())
		}
		p.armAutoLock(h, wait)
		return
	}
	// As a lock does: after a passphrase check that runs, with every
	// session; a use meanwhile keeps it unlocked.
	p.keyMu.Lock()
	if idle() < after || s.Status().Locked {
		p.keyMu.Unlock()
		p.armAutoLock(h, min(left, after-idle()))
		return
	}
	forgot := p.lockStore(s, false)
	p.keyMu.Unlock()
	h.Audit(nil, "vault.locked", map[string]any{"reason": "idle", "minutes": after.Minutes(), "keyHeld": !forgot})
	changed(h)
	if !forgot {
		p.armAutoLock(h, left)
	}
}

// MaxAutoLock bounds the time a page sets for the auto-lock, as the
// setting's range does.
const MaxAutoLock = 1440 * time.Minute

// clearLockFor drops the time a page set, and with full (the key
// forgotten) the unlock's caps and the key's hold: the next unlock follows
// the settings again. A suspended vault keeps the caps its passphrase
// took, since a proof that unlocks it again is not the passphrase.
func (p *Plugin) clearLockFor(full bool) {
	p.mu.Lock()
	p.lockFor, p.lockForSet = 0, false
	if full {
		p.lockCap, p.lockCapSet = 0, false
		p.keyAt, p.keyCap, p.keyCapSet = stamp{}, 0, false
	}
	p.mu.Unlock()
}

// capLock notes the setting's time as the passphrase unlocks the vault: the
// most this unlock lasts without use, unless a page sets another time
// through the gate (handleAutoLock). Programs of the core host change
// settings without the gate, so a longer time, or never, counts from the
// next unlock, which the passphrase makes.
func (p *Plugin) capLock(h plugin.Host) {
	d := p.autoLockSetting(h)
	p.mu.Lock()
	p.lockCap, p.lockCapSet = d, true
	p.mu.Unlock()
}

// autoLockState is what the pages show of the auto-lock: its time in
// seconds (0: never), whether a page set it for this unlock (custom), the
// setting's time (setting), while the vault is unlocked and locks at all
// when it will if unused (lockAt), and while the core holds the key when it
// forgets it (keyUntil), after which only the passphrase unlocks the vault.
func (p *Plugin) autoLockState(h plugin.Host, s *vaultstore.Store) map[string]any {
	after := p.autoLockAfter(h)
	st := s.Status()
	held := s.Held()
	var left time.Duration
	if held {
		left = p.keyLeft(h)
	}
	now := p.at()
	p.mu.Lock()
	last, custom := p.lastUse, p.lockForSet
	p.mu.Unlock()
	out := map[string]any{"after": after.Seconds(), "custom": custom, "setting": p.autoLockSetting(h).Seconds()}
	if !st.Locked && !st.Setup && after > 0 && !last.zero() {
		out["lockAt"] = now.wall.Add(after - last.since(now)).UTC().Format(time.RFC3339)
	}
	if held {
		out["keyUntil"] = now.wall.Add(left).UTC().Format(time.RFC3339)
	}
	return out
}

// handleAutoLock sets the auto-lock's time for this unlock: {"minutes": n}
// (0: never, at most a day), or {"minutes": null} for the setting's (at
// most its time at the unlock). A time longer than the current one, or
// never, takes the passphrase again ({"passphrase"}): the session alone is
// what a program driving the page has too, and never keeps the vault
// unlocked until the key's hold ends. A shorter time takes the session. It
// passes the gate, so it counts as a use: the countdown starts again.
func (p *Plugin) handleAutoLock(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Minutes    *float64 `json:"minutes"`
		Passphrase string   `json:"passphrase"`
	}
	if err := plugin.ReadJSON(r, 1<<10, &body); err != nil {
		plugin.WriteError(w, err)
		return
	}
	d := time.Duration(0)
	if m := body.Minutes; m != nil {
		d = time.Duration(*m) * time.Minute
		if *m != float64(int(*m)) || d < 0 || d > MaxAutoLock {
			plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "minutes: 0 to 1440"})
			return
		}
	}
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	if s.Status().Locked {
		fail(w, vaultstore.ErrLocked)
		return
	}
	next := d
	if body.Minutes == nil {
		next = p.settingAfter(c.Host)
	}
	if cur := p.autoLockAfter(c.Host); cur > 0 && (next == 0 || next > cur) {
		if !p.passphraseAgain(c, w, r, s, body.Passphrase) {
			return
		}
	}
	p.mu.Lock()
	p.lockFor, p.lockForSet = d, body.Minutes != nil
	p.mu.Unlock()
	if body.Minutes != nil {
		c.AuditField("minutes", *body.Minutes)
	} else {
		c.AuditField("minutes", "setting")
	}
	p.touch(c.Host) // the timer runs with the new time
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, p.autoLockState(c.Host, s))
}
