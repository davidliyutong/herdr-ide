package vault

import (
	"time"

	"veldr/internal/plugin"
	vaultstore "veldr/internal/vault"
)

// The automatic lock.
//
// A lock, by Lock or after vault.autoLock minutes without use, always
// forgets the key: every session and nonce ends, and the passphrase or an
// authenticator's unlock entry (proof.go, internal/vault's unlock.go) gives
// the key back. A use is an unlock, a page's action through the gate (a
// change, a reveal, an approval, an export or import) and a value released
// to a machine; lists and refusals are not. While the vault is unlocked a
// timer runs: it fires when the vault would lock, or every lockCheckEvery
// at the latest, so a change of the setting counts within a minute.
//
// The setting is changed without the gate, so a change while the vault is
// unlocked shortens the time but does not lengthen it (capLock): an unlock
// with the passphrase takes the setting's time then as its most; an unlock
// by an authenticator takes the shorter of the setting's and the one sealed
// with the passphrase's window, which a program that changes the setting
// cannot lengthen either.

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

// lockStore locks the vault, with keyMu held: the store forgets the key,
// every session and nonce ends, and the unlock's cap goes with it, so the
// next unlock follows the setting again.
func (p *Plugin) lockStore(s *vaultstore.Store) {
	s.Lock()
	p.endSessions()
	p.mu.Lock()
	p.lockCap, p.lockCapSet = 0, false
	p.mu.Unlock()
}

// autoLock is the timer's look: it locks the vault if it went unused for
// the auto-lock's time, and otherwise looks again later; a locked vault
// needs no timer until it is unlocked.
func (p *Plugin) autoLock(h plugin.Host) {
	p.mu.Lock()
	p.lockTimer = nil
	s := p.store
	p.mu.Unlock()
	if s == nil || s.Status().Locked {
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
		wait := time.Duration(0)
		if after > 0 {
			wait = after - idle()
		}
		p.armAutoLock(h, wait)
		return
	}
	// As a lock does: after a check that runs, with every session; a use
	// meanwhile keeps it unlocked.
	p.keyMu.Lock()
	if idle() < after || s.Status().Locked {
		p.keyMu.Unlock()
		if !s.Status().Locked {
			p.armAutoLock(h, after-idle())
		}
		return
	}
	p.lockStore(s)
	p.keyMu.Unlock()
	h.Audit(nil, "vault.locked", map[string]any{"reason": "idle", "minutes": after.Minutes()})
	changed(h)
}

// capLock sets the most this unlock lasts without use: the setting's time
// as the passphrase unlocks the vault (sealed 0: no further cap), and for an
// unlock by an authenticator the shorter of it and sealed, the auto-lock
// time sealed with the passphrase's window. Programs of the core host
// change settings without the gate, so a longer time, or never, counts
// from the next unlock with the passphrase.
func (p *Plugin) capLock(h plugin.Host, sealed time.Duration) {
	d := shorter(p.autoLockSetting(h), sealed)
	p.mu.Lock()
	p.lockCap, p.lockCapSet = d, true
	p.mu.Unlock()
}

// autoLockState is what the pages show of the auto-lock: its time in
// seconds (0: never), the setting's time (setting) and, while the vault is
// unlocked and locks at all, when it will if unused (lockAt).
func (p *Plugin) autoLockState(h plugin.Host, s *vaultstore.Store) map[string]any {
	after := p.autoLockAfter(h)
	st := s.Status()
	now := p.at()
	p.mu.Lock()
	last := p.lastUse
	p.mu.Unlock()
	out := map[string]any{"after": after.Seconds(), "setting": p.autoLockSetting(h).Seconds()}
	if !st.Locked && !st.Setup && after > 0 && !last.zero() {
		out["lockAt"] = now.wall.Add(after - last.since(now)).UTC().Format(time.RFC3339)
	}
	return out
}
