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
	// SettingRunTimeout and SettingRunMaxTimeout: run_with_env's default
	// and longest timeout, in seconds; SettingRunOutput: the KiB of
	// output it returns.
	SettingRunTimeout    = "vault.runTimeout"
	SettingRunMaxTimeout = "vault.runMaxTimeout"
	SettingRunOutput     = "vault.runOutput"
)

// Defaults of what the settings change.
const (
	DefaultAutoLock      = 0
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
		Sections: []settings.Section{{ID: ID, Order: 67}},
		Defs: []settings.Def{
			num(SettingApprovalTimeout, DefaultTimeout.Seconds(), 10, 600, "", 10),
			num(SettingAutoLock, DefaultAutoLock, 0, 1440, "", 20),
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
// locks it.
func (p *Plugin) autoLockAfter(h plugin.Host) time.Duration {
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
