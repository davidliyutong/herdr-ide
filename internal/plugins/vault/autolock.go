package vault

import (
	"time"

	"herdr-ide/internal/plugin"
)

// The auto-lock (vault.autoLock, minutes, 0: never): the vault locks after
// that long without use, as Lock does (every session ends). A use is an
// unlock, a page's action through the gate (a change, a reveal, an
// approval, an export or import) and a value released to a machine; lists
// and refusals are not. While the vault is unlocked a timer runs: it fires
// when the vault would lock, or every lockCheckEvery at the latest, so a
// change of the setting counts within a minute.

// touch notes a use of the vault and keeps the auto-lock's timer running.
func (p *Plugin) touch(h plugin.Host) {
	p.mu.Lock()
	p.lastUse = p.clock()
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

// autoLock locks the vault if it went unused for the setting's time, and
// otherwise looks again later; a locked vault needs no timer until it is
// unlocked.
func (p *Plugin) autoLock(h plugin.Host) {
	p.mu.Lock()
	p.lockTimer = nil
	s := p.store
	p.mu.Unlock()
	if s == nil {
		return
	}
	if st := s.Status(); st.Locked || st.Setup {
		return
	}
	after := p.autoLockAfter(h)
	idle := func() time.Duration {
		p.mu.Lock()
		defer p.mu.Unlock()
		return p.clock().Sub(p.lastUse)
	}
	if after <= 0 || idle() < after {
		p.armAutoLock(h, after-idle())
		return
	}
	// As a lock does: after a passphrase check that runs, with every
	// session; a use meanwhile keeps it unlocked.
	p.keyMu.Lock()
	if idle() < after {
		p.keyMu.Unlock()
		p.armAutoLock(h, after-idle())
		return
	}
	s.Lock()
	p.endSessions()
	p.keyMu.Unlock()
	h.Audit(nil, "vault.locked", map[string]any{"reason": "idle", "minutes": after.Minutes()})
	changed(h)
}
