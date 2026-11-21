package vault

import (
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
)

// Settings of the vault (section "vault"): how long things wait and last.
const (
	// SettingApprovalTimeout: seconds a request waits for an answer.
	SettingApprovalTimeout = "vault.approvalTimeout"
	// SettingSessionIdle and SettingSessionMax: a page's vault session
	// ends unused for that many minutes, or that many hours after it
	// began.
	SettingSessionIdle = "vault.sessionIdle"
	SettingSessionMax  = "vault.sessionMax"
	// SettingAutoLock: minutes without use after which the vault locks
	// (0: never).
	SettingAutoLock = "vault.autoLock"
	// SettingPassphraseHours: hours after the passphrase was last given
	// that the core holds the key; then it forgets it and only the
	// passphrase unlocks the vault again.
	SettingPassphraseHours = "vault.passphraseHours"
	// SettingRunTimeout and SettingRunMaxTimeout: run_with_env's default
	// and longest timeout, in seconds; SettingRunOutput: the KiB of
	// output it returns.
	SettingRunTimeout    = "vault.runTimeout"
	SettingRunMaxTimeout = "vault.runMaxTimeout"
	SettingRunOutput     = "vault.runOutput"
)

// Defaults of what the settings change.
const (
	DefaultAutoLock        = 60
	DefaultPassphraseHours = 24
	// MaxPassphraseHours bounds the setting: a program that sets it before
	// the user's next passphrase gets at most this long.
	MaxPassphraseHours   = 168
	DefaultRunTimeout    = 120 * time.Second
	DefaultRunMaxTimeout = 600 * time.Second
	DefaultRunOutput     = 64 << 10
)

// Settings is the vault's settings module (internal/registry).
var Settings = func() settings.Module {
	num := func(key string, def, lo, hi float64, group string, order int) settings.Def {
		mn, mx := settings.Range(lo, hi)
		return settings.Def{Key: key, Type: settings.TypeNumber, Default: def, Min: mn, Max: mx, Integer: true,
			Scope: settings.ScopeApp, Section: ID, Group: group, Order: order}
	}
	return settings.Module{
		// The plugin's own page in Settings, under the plugins.
		Sections: []settings.Section{{ID: ID, Order: 69, Plugin: ID}},
		Defs: []settings.Def{
			num(SettingApprovalTimeout, DefaultTimeout.Seconds(), 10, 600, "", 10),
			num(SettingAutoLock, DefaultAutoLock, 0, 1440, "", 20),
			num(SettingPassphraseHours, DefaultPassphraseHours, 1, MaxPassphraseHours, "", 25),
			num(SettingSessionIdle, SessionIdle.Minutes(), 1, 240, "vaultSessions", 30),
			num(SettingSessionMax, SessionMax.Hours(), 1, 24, "vaultSessions", 31),
			num(SettingRunTimeout, DefaultRunTimeout.Seconds(), 5, 3600, "vaultRun", 40),
			num(SettingRunMaxTimeout, DefaultRunMaxTimeout.Seconds(), 5, 3600, "vaultRun", 41),
			num(SettingRunOutput, DefaultRunOutput/1024, 4, 1024, "vaultRun", 42),
		},
	}
}()

// setting is a number setting's value, def without settings (or without
// the definition), kept within lo and hi.
func setting(h plugin.Host, key string, def, lo, hi float64) float64 {
	v := def
	if st := h.Settings(); st != nil {
		if n, ok := st.GetFor(key, "").(float64); ok {
			v = n
		}
	}
	return min(max(v, lo), hi)
}

// timeout is how long a request waits for the user's answer.
func (p *Plugin) timeout(h plugin.Host) time.Duration {
	if p.Timeout > 0 {
		return p.Timeout
	}
	return time.Duration(setting(h, SettingApprovalTimeout, DefaultTimeout.Seconds(), 10, 600)) * time.Second
}

// sessionLimits are how long a session lasts unused, and at most.
func (p *Plugin) sessionLimits(h plugin.Host) (idle, most time.Duration) {
	idle = time.Duration(setting(h, SettingSessionIdle, SessionIdle.Minutes(), 1, 240)) * time.Minute
	most = time.Duration(setting(h, SettingSessionMax, SessionMax.Hours(), 1, 24)) * time.Hour
	return idle, most
}

// autoLockAfter is how long the vault stays unlocked without use; 0 never
// locks it. The time a page set for this unlock (setLockFor) comes first;
// else the setting's, at most its time when the vault was unlocked
// (capLock).
func (p *Plugin) autoLockAfter(h plugin.Host) time.Duration {
	p.mu.Lock()
	set, d := p.lockForSet, p.lockFor
	capped, limit := p.lockCapSet, p.lockCap
	p.mu.Unlock()
	if set {
		return d
	}
	return p.cappedSetting(h, capped, limit)
}

// settingAfter is the auto-lock's time the setting gives this unlock: the
// setting's, at most its time when the passphrase unlocked the vault.
func (p *Plugin) settingAfter(h plugin.Host) time.Duration {
	p.mu.Lock()
	capped, limit := p.lockCapSet, p.lockCap
	p.mu.Unlock()
	return p.cappedSetting(h, capped, limit)
}

func (p *Plugin) cappedSetting(h plugin.Host, capped bool, limit time.Duration) time.Duration {
	after := p.autoLockSetting(h)
	if capped && limit > 0 && (after == 0 || after > limit) {
		return limit
	}
	return after
}

// passphraseFor is how long after the passphrase was last given the core
// holds the key: vault.passphraseHours, at most its value when the
// passphrase was given (keyFrom), so a setting changed without the gate
// shortens the current hold but does not lengthen it.
func (p *Plugin) passphraseFor(h plugin.Host) time.Duration {
	d := p.passphraseSetting(h)
	p.mu.Lock()
	capped, limit := p.keyCapSet, p.keyCap
	p.mu.Unlock()
	if capped && limit < d {
		return limit
	}
	return d
}

// passphraseSetting is the hold vault.passphraseHours sets.
func (p *Plugin) passphraseSetting(h plugin.Host) time.Duration {
	if p.keyHold > 0 {
		return p.keyHold
	}
	return time.Duration(setting(h, SettingPassphraseHours, DefaultPassphraseHours, 1, MaxPassphraseHours)) * time.Hour
}

// autoLockSetting is the auto-lock's time vault.autoLock sets.
func (p *Plugin) autoLockSetting(h plugin.Host) time.Duration {
	if p.lockAfter > 0 {
		return p.lockAfter
	}
	return time.Duration(setting(h, SettingAutoLock, DefaultAutoLock, 0, 1440)) * time.Minute
}

// runLimits are what run_with_env's commands may take, for the MCP
// server (agentproto.VaultRun).
func runLimits(h plugin.Host) *agentproto.VaultRun {
	return &agentproto.VaultRun{
		Timeout:    int(setting(h, SettingRunTimeout, DefaultRunTimeout.Seconds(), 5, 3600)),
		MaxTimeout: int(setting(h, SettingRunMaxTimeout, DefaultRunMaxTimeout.Seconds(), 5, 3600)),
		MaxOutput:  int(setting(h, SettingRunOutput, DefaultRunOutput/1024, 4, 1024)) << 10,
	}
}
