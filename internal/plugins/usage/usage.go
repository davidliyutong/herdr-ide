// Package usage is the core's side of the AI usage plugin: a scheduler that
// asks the connected machines' agents for the limits of the AI
// subscriptions signed in there (internal/agent/plugin/usage), merges the
// accounts seen on several machines, keeps their history for their pace,
// fires the alerts, polls the providers' status pages, and serves the
// result to the UIs (GET /api/p/usage, /ws plugin messages). The web UI's side is
// web/src/plugins/usage; docs/features/29-ai-usage.md has the design.
package usage

import (
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
	"herdr-ide/internal/usage"
)

// ID is the plugin's id.
const ID = "usage"

// Settings of the plugin.
const (
	SettingRefresh        = "usage.refresh"
	SettingRefreshOpen    = "usage.refreshOpen"
	SettingRefreshWorking = "usage.refreshWorking"
	SettingRefreshIdle    = "usage.refreshIdle"
	SettingCostRefresh    = "usage.costRefresh"
	SettingStatusBar      = "usage.statusBar"
	SettingAlerts         = "usage.alerts"
	SettingThresholds     = "usage.thresholds"
	SettingCodexHomes     = "usage.codexHomes"
	SettingClaudeKeychain = "usage.claudeKeychain"
	SettingKimiRefresh    = "usage.kimiRefresh"
	SettingPrices         = "usage.prices"
)

// providerSetting is the switch of a provider.
func providerSetting(p string) string { return "usage.providers." + p }

// providerGroup is the settings group of a provider: usageClaude,
// usageCodex, ...
func providerGroup(p string) string { return "usage" + strings.ToUpper(p[:1]) + p[1:] }

// Refresh modes: manual, every n minutes, or adaptive.
const (
	RefreshManual   = "manual"
	RefreshAdaptive = "adaptive"
)

var refreshModes = []string{RefreshManual, "1", "2", "5", "15", "30", "60", RefreshAdaptive}

// Cadence is the adaptive mode's: while a panel is open, while a coding
// agent works, otherwise.
type Cadence struct{ Open, Working, Idle time.Duration }

// DefaultCadence asks every 5 minutes while a panel is open, every 10
// while an agent works, else every 30.
var DefaultCadence = Cadence{Open: 5 * time.Minute, Working: 10 * time.Minute, Idle: 30 * time.Minute}

// Groups of the settings that are no provider's: how often to read, the
// status bar and alerts, the spend's prices. The Settings page shows them,
// then the list of providers, each of whose groups is a page of its own
// (web/src/plugins/usage/SettingsPage.tsx).
const (
	groupRefresh = "usageRefresh"
	groupAlerts  = "usageAlerts"
	groupSpend   = "usageSpend"
)

// Settings is the plugin's settings module (internal/registry).
var Settings = func() settings.Module {
	m := settings.Module{Sections: []settings.Section{{ID: "usage", Order: 68, Plugin: ID}}}
	m.Defs = append(m.Defs,
		settings.Def{Key: SettingRefresh, Type: settings.TypeEnum, Default: RefreshAdaptive, Enum: refreshModes,
			Scope: settings.ScopeApp, Section: "usage", Group: groupRefresh, Order: 10},
		minutes(SettingRefreshOpen, DefaultCadence.Open, 1, 60, 11),
		minutes(SettingRefreshWorking, DefaultCadence.Working, 1, 120, 12),
		minutes(SettingRefreshIdle, DefaultCadence.Idle, 5, 240, 13),
		// Read by the pages: how old the spend may get while the panel is
		// open, and the status bar item.
		settings.Def{Key: SettingCostRefresh, Type: settings.TypeNumber, Default: 15.0, Min: costMin, Max: costMax, Integer: true,
			Scope: settings.ScopeApp, Section: "usage", Group: groupRefresh, Order: 15},
		settings.Def{Key: SettingStatusBar, Type: settings.TypeBool, Default: true,
			Scope: settings.ScopeApp, Section: "usage", Group: groupAlerts, Order: 18},
		settings.Def{Key: SettingAlerts, Type: settings.TypeBool, Default: true,
			Scope: settings.ScopeApp, Section: "usage", Group: groupAlerts, Order: 19},
		settings.Def{Key: SettingThresholds, Type: settings.TypeList, Item: settings.TypeString, Default: []string{"80", "95"},
			Options: []string{"50", "80", "90", "95"}, Scope: settings.ScopeApp, Section: "usage", Group: groupAlerts, Order: 20, Validate: validThresholds},
		// The user's prices, for models the price table does not know yet
		// or prices it has wrong (usage.ParsePrices).
		settings.Def{Key: SettingPrices, Type: settings.TypeList, Item: settings.TypeString, Default: []string{},
			Scope: settings.ScopeApp, Section: "usage", Group: groupSpend, Order: 22, Validate: validPrices},
	)
	// One group per provider, in usage.Providers order: its switch, then
	// its own options.
	for i, p := range usage.Providers {
		g := providerGroup(p)
		o := 30 + 4*i
		m.Defs = append(m.Defs, settings.Def{Key: providerSetting(p), Type: settings.TypeBool, Default: true,
			Scope: settings.ScopeApp, Section: "usage", Group: g, Order: o})
		switch p {
		case usage.Claude:
			m.Defs = append(m.Defs, settings.Def{Key: SettingClaudeKeychain, Type: settings.TypeBool, Default: true,
				Scope: settings.ScopeApp, Section: "usage", Group: g, Order: o + 1})
		case usage.Codex:
			m.Defs = append(m.Defs, settings.Def{Key: SettingCodexHomes, Type: settings.TypeList, Item: settings.TypeString, Default: []string{},
				Scope: settings.ScopeApp, Section: "usage", Group: g, Order: o + 1})
		case usage.Kimi:
			m.Defs = append(m.Defs, settings.Def{Key: SettingKimiRefresh, Type: settings.TypeBool, Default: true,
				Scope: settings.ScopeApp, Section: "usage", Group: g, Order: o + 1})
		}
	}
	return m
}()

var costMin, costMax = settings.Range(1, 1440)

// minutes is a setting of the adaptive cadence, in whole minutes.
func minutes(key string, def time.Duration, lo, hi float64, order int) settings.Def {
	mn, mx := settings.Range(lo, hi)
	return settings.Def{Key: key, Type: settings.TypeNumber, Default: def.Minutes(), Min: mn, Max: mx, Integer: true,
		Scope: settings.ScopeApp, Section: "usage", Group: groupRefresh, Order: order}
}

// validThresholds accepts percentages from 1 to 100.
func validThresholds(v any) error {
	l, _ := v.([]string)
	if len(l) > 8 {
		return errors.New("at most 8 thresholds")
	}
	for _, s := range l {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > 100 {
			return errors.New("thresholds are whole percentages from 1 to 100")
		}
	}
	return nil
}

// validPrices accepts what usage.ParsePrices reads.
func validPrices(v any) error {
	l, _ := v.([]string)
	_, err := usage.ParsePrices(l)
	return err
}

// prices are the user's prices (usage.prices) and a key that tells them
// apart in the spend's cache.
func (p *Plugin) prices() (map[string]usage.Tier, string) {
	st := p.settings()
	if st == nil {
		return nil, ""
	}
	l, _ := st.GetFor(SettingPrices, "").([]string)
	own, err := usage.ParsePrices(l)
	if err != nil || len(own) == 0 {
		return nil, ""
	}
	return own, strings.Join(l, "\n")
}

// Routes of the plugin.
func (p *Plugin) Routes() []plugin.Route {
	return []plugin.Route{
		{Method: "GET", Path: "", Handler: p.getSnapshot},
		{Method: "GET", Path: "cost", Handler: p.getCost},
		{Method: "POST", Path: "refresh", Mutating: true, Audit: "refresh", Handler: p.postRefresh},
		{Method: "PUT", Path: "deepseek-key", Machine: true, Mutating: true, Audit: "deepseek_key", Handler: p.putDeepseekKey},
	}
}

// ID names the plugin.
func (p *Plugin) ID() string { return ID }

// getSnapshot answers with the current snapshot; ?watch=1 (the open panel,
// every minute) counts the panel open for the adaptive refresh
// (usage.refreshOpen).
func (p *Plugin) getSnapshot(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("watch") == "1" {
		p.watch()
	}
	plugin.WriteJSON(w, http.StatusOK, p.Snapshot())
}

// postRefresh asks for a poll: at once, or when minRefreshGap since the
// last one has passed ({"queued": true, "at": Unix seconds}).
func (p *Plugin) postRefresh(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	at := p.Refresh()
	plugin.WriteJSON(w, http.StatusAccepted, map[string]any{"queued": true, "at": at.Unix()})
}

// getCost answers with the cost of the machines' logs: ?days= (1–90,
// default 30), &tz= (the user's offset east of UTC in minutes).
func (p *Plugin) getCost(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	days, err := strconv.Atoi(q.Get("days"))
	if err != nil || days < 1 {
		days = 30
	}
	days = min(days, 90)
	tz, _ := strconv.Atoi(q.Get("tz"))
	if tz < -14*60 || tz > 14*60 {
		tz = 0
	}
	plugin.WriteJSON(w, http.StatusOK, p.cost(r.Context(), days, tz))
}

// putDeepseekKey writes the DeepSeek key file on a machine ({"key"}; ""
// removes it). The key is not audited or returned.
func (p *Plugin) putDeepseekKey(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key string `json:"key"`
	}
	if err := plugin.ReadJSON(r, 4096, &body); err != nil {
		plugin.WriteError(w, err)
		return
	}
	if err := p.call(r.Context(), c.Machine.ID(), "setDeepseekKey", body, nil); err != nil {
		plugin.WriteError(w, err)
		return
	}
	p.Refresh()
	plugin.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// options are what the agents get from the settings. A read-only core
// (--read-only) changes nothing on machines: it never has an agent renew
// Kimi Code's sign-in, which rewrites its credentials file there.
func (p *Plugin) options() usage.Options {
	o := p.settingsOptions()
	if h := p.getHost(); h != nil && h.ReadOnly() {
		o.KimiRefresh = false
	}
	return o
}

func (p *Plugin) settingsOptions() usage.Options {
	o := usage.Options{ClaudeKeychain: true, KimiRefresh: true}
	st := p.settings()
	if st == nil {
		return o
	}
	for _, pr := range usage.Providers {
		if st.Bool(providerSetting(pr), "") {
			o.Providers = append(o.Providers, pr)
		}
	}
	if len(o.Providers) == 0 {
		o.Providers = []string{"none"}
	}
	o.CodexHomes, _ = st.GetFor(SettingCodexHomes, "").([]string)
	o.ClaudeKeychain = st.Bool(SettingClaudeKeychain, "")
	o.KimiRefresh = st.Bool(SettingKimiRefresh, "")
	return o
}

func (p *Plugin) refreshMode() string {
	if st := p.settings(); st != nil {
		if m := st.String(SettingRefresh, ""); slices.Contains(refreshModes, m) {
			return m
		}
	}
	return RefreshAdaptive
}

// cadence is the adaptive mode's from the settings.
func (p *Plugin) cadence() Cadence {
	c := DefaultCadence
	st := p.settings()
	if st == nil {
		return c
	}
	get := func(key string, d *time.Duration) {
		if n, ok := st.GetFor(key, "").(float64); ok && n >= 1 {
			*d = time.Duration(n) * time.Minute
		}
	}
	get(SettingRefreshOpen, &c.Open)
	get(SettingRefreshWorking, &c.Working)
	get(SettingRefreshIdle, &c.Idle)
	return c
}

// Interval is how often the scheduler asks in mode: none (0) for manual;
// adaptive asks at c's cadences: while a panel is open, while a coding
// agent works, otherwise (the shortest that applies).
func Interval(mode string, watching, working bool, c Cadence) time.Duration {
	switch mode {
	case RefreshManual:
		return 0
	case RefreshAdaptive, "":
		iv := c.Idle
		if working {
			iv = min(iv, c.Working)
		}
		if watching {
			iv = min(iv, c.Open)
		}
		return iv
	}
	n, err := strconv.Atoi(mode)
	if err != nil || n <= 0 {
		return 30 * time.Minute
	}
	return time.Duration(n) * time.Minute
}
