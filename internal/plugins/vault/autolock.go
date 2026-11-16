package vault

import (
	"net/http"
	"time"

	"herdr-ide/internal/plugin"
)

// The auto-lock (vault.autoLock, minutes, 0: never; 60 by default): the
// vault locks after that long without use, as Lock does (every session
// ends). The panel shows when it will and may set another time for this
// unlock (POST autolock), which holds until the vault locks. A use is an
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
	p.clearLockFor()
	p.keyMu.Unlock()
	h.Audit(nil, "vault.locked", map[string]any{"reason": "idle", "minutes": after.Minutes()})
	changed(h)
}

// MaxAutoLock bounds the time a page sets for the auto-lock, as the
// setting's range does.
const MaxAutoLock = 1440 * time.Minute

// clearLockFor drops the time a page set: the next unlock follows the
// setting again.
func (p *Plugin) clearLockFor() {
	p.mu.Lock()
	p.lockFor, p.lockForSet = 0, false
	p.mu.Unlock()
}

// autoLockState is what the pages show of the auto-lock: its time in
// seconds (0: never), whether a page set it for this unlock (custom), the
// setting's time (setting), and while the vault is unlocked and locks at
// all, when it will if unused (lockAt).
func (p *Plugin) autoLockState(h plugin.Host, locked bool) map[string]any {
	after := p.autoLockAfter(h)
	p.mu.Lock()
	last, custom := p.lastUse, p.lockForSet
	p.mu.Unlock()
	st := map[string]any{"after": after.Seconds(), "custom": custom, "setting": p.autoLockSetting(h).Seconds()}
	if !locked && after > 0 && !last.IsZero() {
		st["lockAt"] = last.Add(after).UTC().Format(time.RFC3339)
	}
	return st
}

// handleAutoLock sets the auto-lock's time for this unlock: {"minutes": n}
// (0: never, at most a day), or {"minutes": null} for the setting's. It
// passes the gate, so it counts as a use: the countdown starts again.
func (p *Plugin) handleAutoLock(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Minutes *float64 `json:"minutes"`
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
	st := s.Status()
	plugin.WriteJSON(w, http.StatusOK, p.autoLockState(c.Host, st.Locked || st.Setup))
}
