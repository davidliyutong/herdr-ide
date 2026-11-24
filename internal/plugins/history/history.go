// Package history is the core's side of the terminal history plugin:
// snapshots of the terminals' output that a machine writes to its own disk
// while the setting history.capture is on for it, shown after the
// terminal core started again (internal/agent/plugin/history). A scheduler
// asks each connected machine whose setting is on for a capture every
// history.interval seconds, and for a clear when it no longer keeps
// snapshots (the setting or the plugin turned off, also while the core was
// down) until one succeeds; routes list a machine's snapshots, read one,
// remove them, and give a terminal that took another's place the other's
// snapshot.
// Its settings are in the section "history"; its switch is
// plugins.history.enabled (plugin.Settings).
package history

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"veldr/internal/agentproto"
	"veldr/internal/machines"
	"veldr/internal/plugin"
	"veldr/internal/settings"
)

// ID names the plugin on every side.
const ID = "history"

// The plugin's settings (section "history"). Each bounds what a machine
// keeps on its disk, so each can differ per machine.
const (
	// SettingCapture: the machine writes snapshots of its terminals'
	// output. Off by default: the output can hold secrets.
	SettingCapture = "history.capture"
	// SettingInterval: seconds between two snapshots of a terminal.
	SettingInterval = "history.interval"
	// SettingLines: the most lines a terminal's snapshot keeps.
	SettingLines = "history.lines"
	// SettingMaxTerminals: the most terminals a machine keeps snapshots of.
	SettingMaxTerminals = "history.maxTerminals"
	// SettingMaxTotalMB: the most megabytes the snapshots of a machine take.
	SettingMaxTotalMB = "history.maxTotalMB"
	// SettingDays: the days a snapshot is kept.
	SettingDays = "history.days"
)

// Bounds of the settings: the machine's hard limits
// (agentproto.History*), which it enforces whatever it is asked.
const (
	MinInterval, MaxInterval         = 10, 600
	MinLines, MaxLines               = 100, 10000
	MinTerminals, MaxTerminals       = 1, 128
	MinTotalMB, MaxTotalMB           = 1, 512
	MinDays, MaxDays                 = 1, 30
	defaultInterval, defaultLines    = 30, 2000
	defaultTerminals, defaultTotalMB = 32, 64
	defaultDays                      = 7
)

func number(key string, def, min, max float64, step float64, order int) settings.Def {
	lo, hi := settings.Range(min, max)
	return settings.Def{Key: key, Type: settings.TypeNumber, Default: def, Min: lo, Max: hi, Integer: true, Step: step,
		Scope: settings.ScopeMachine, Section: ID, Order: order}
}

// Settings is the plugin's settings module (internal/registry).
var Settings = settings.Module{
	Sections: []settings.Section{{ID: ID, Order: 71, Plugin: ID}},
	Defs: []settings.Def{
		{Key: SettingCapture, Type: settings.TypeBool, Default: false, Scope: settings.ScopeMachine, Section: ID, Order: 10,
			Flag:  "history-capture",
			Usage: "keep snapshots of the terminals' output on each machine's disk (in the agent's data directory there), to show what a terminal held after its terminal core started again; the output can hold secrets such as keys and passwords printed in a terminal; true or false; also per machine in the UI"},
		number(SettingInterval, defaultInterval, MinInterval, MaxInterval, 10, 20),
		number(SettingLines, defaultLines, MinLines, MaxLines, 100, 30),
		number(SettingMaxTerminals, defaultTerminals, MinTerminals, MaxTerminals, 1, 40),
		number(SettingMaxTotalMB, defaultTotalMB, MinTotalMB, MaxTotalMB, 1, 50),
		number(SettingDays, defaultDays, MinDays, MaxDays, 1, 60),
	},
}

// Time limits of the routes' requests to a machine.
const (
	listTimeout = 15 * time.Second
	readTimeout = 30 * time.Second
	// clearTimeout is longer than a capture, which a clear and an adopt
	// wait for on the machine.
	clearTimeout = 45 * time.Second
)

// ID names the plugin.
func (p *Plugin) ID() string { return ID }

// Routes of the plugin, all a machine's:
//
//   - GET  /api/m/{id}/p/history: the snapshots
//     (agentproto.HistoryListResult);
//   - GET  /api/m/{id}/p/history/read?terminal=&generation=: one
//     generation's bytes as an application/octet-stream attachment under
//     the sandboxing CSP, described by the headers X-History-Pid,
//     X-History-At (ms since the epoch), X-History-Cols, X-History-Rows
//     and X-History-Lines;
//   - DELETE /api/m/{id}/p/history[?terminal=]: removes one terminal's
//     snapshots, or all ({removed});
//   - POST /api/m/{id}/p/history/adopt?from=&to=: terminal to, which took
//     the place of terminal from (the terminal core gave the pane a new
//     address), gets the newest generation of from's snapshots as its
//     previous one unless it has a later one, and from's snapshots go
//     ({adopted}); to must be a terminal of the machine's terminal core.
//
// The clear and the adopt change the machine's files: refused in read-only
// mode, audited as history.clear and history.adopt.
func (p *Plugin) Routes() []plugin.Route {
	return []plugin.Route{
		{Method: http.MethodGet, Path: "", Machine: true, Handler: p.getList},
		{Method: http.MethodGet, Path: "read", Machine: true, Handler: p.getRead},
		{Method: http.MethodDelete, Path: "", Machine: true, Mutating: true, Audit: "clear", Handler: p.deleteSnapshots},
		{Method: http.MethodPost, Path: "adopt", Machine: true, Mutating: true, Audit: "adopt", Handler: p.postAdopt},
	}
}

// request runs an action of mc's agent.
func (p *Plugin) request(ctx context.Context, mc *machines.Machine, action string, params, out any) error {
	if mc == nil {
		return plugin.ErrOffline
	}
	if call := p.caller(); call != nil {
		return call(ctx, mc.ID(), action, params, out)
	}
	return plugin.Request(ctx, mc, ID, action, params, out)
}

func badRequest(w http.ResponseWriter, msg string) {
	plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": msg})
}

// writeError answers a failed request to the machine: the machine's code
// and its wording (fixed, without the machine's paths), else a fixed one.
func writeError(w http.ResponseWriter, err error) {
	var pe *plugin.Error
	switch {
	case errors.As(err, &pe):
		plugin.WriteError(w, err)
	case errors.Is(err, context.DeadlineExceeded):
		plugin.WriteJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "timeout", "message": "the machine did not answer in time"})
	default:
		plugin.WriteJSON(w, http.StatusBadGateway, map[string]string{"error": "bad_reply", "message": "the machine's answer was not understood"})
	}
}

// getList answers with the machine's snapshots.
func (p *Plugin) getList(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), listTimeout)
	defer cancel()
	var res agentproto.HistoryListResult
	if err := p.request(ctx, c.Machine, agentproto.HistoryList, nil, &res); err != nil {
		writeError(w, err)
		return
	}
	out := make([]agentproto.HistoryEntry, 0, len(res.Terminals))
	for _, e := range res.Terminals {
		if agentproto.ValidHistoryTerminal(e.Terminal) {
			out = append(out, e)
		}
	}
	res.Terminals = out
	plugin.WriteJSON(w, http.StatusOK, res)
}

// getRead answers with one generation's bytes, which a page replays in a
// terminal emulator as they are.
func (p *Plugin) getRead(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	term, gen := q.Get("terminal"), q.Get("generation")
	if !agentproto.ValidHistoryTerminal(term) || !agentproto.ValidHistoryGeneration(gen) {
		badRequest(w, "a terminal and a generation (current or previous)")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), readTimeout)
	defer cancel()
	var d agentproto.HistoryData
	if err := p.request(ctx, c.Machine, agentproto.HistoryRead, agentproto.HistoryReadParams{Terminal: term, Generation: gen}, &d); err != nil {
		writeError(w, err)
		return
	}
	if len(d.Data) > agentproto.HistoryMaxBytes || d.Terminal != term || d.Generation != gen {
		plugin.WriteJSON(w, http.StatusBadGateway, map[string]string{"error": "bad_reply", "message": "the machine's snapshot is not the one asked for"})
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.Itoa(len(d.Data)))
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	// The bytes are a terminal's output: never a document of the UI's
	// origin, also when the route is opened in a tab.
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Content-Disposition", "attachment")
	h.Set("X-History-Pid", strconv.Itoa(d.PID))
	h.Set("X-History-At", strconv.FormatInt(d.At, 10))
	h.Set("X-History-Cols", strconv.Itoa(d.Cols))
	h.Set("X-History-Rows", strconv.Itoa(d.Rows))
	h.Set("X-History-Lines", strconv.Itoa(d.Lines))
	w.WriteHeader(http.StatusOK)
	w.Write(d.Data)
}

// deleteSnapshots removes one terminal's snapshots (?terminal=) or all of
// the machine's.
func (p *Plugin) deleteSnapshots(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	term := r.URL.Query().Get("terminal")
	if term != "" && !agentproto.ValidHistoryTerminal(term) {
		badRequest(w, "a terminal's address")
		return
	}
	if term != "" {
		c.AuditField("terminal", term)
	}
	ctx, cancel := context.WithTimeout(r.Context(), clearTimeout)
	defer cancel()
	var res agentproto.HistoryClearResult
	if err := p.request(ctx, c.Machine, agentproto.HistoryClear, agentproto.HistoryClearParams{Terminal: term}, &res); err != nil {
		writeError(w, err)
		return
	}
	c.AuditField("removed", res.Removed)
	plugin.WriteJSON(w, http.StatusOK, res)
}

// postAdopt gives terminal ?to= the newest snapshot of terminal ?from=,
// whose place it took, as its previous generation.
func (p *Plugin) postAdopt(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	params := agentproto.HistoryAdoptParams{From: q.Get("from"), To: q.Get("to")}
	if !agentproto.ValidHistoryAdopt(params) {
		badRequest(w, "from and to: two terminals' addresses")
		return
	}
	c.AuditField("from", params.From)
	c.AuditField("to", params.To)
	ctx, cancel := context.WithTimeout(r.Context(), clearTimeout)
	defer cancel()
	var res agentproto.HistoryAdoptResult
	if err := p.request(ctx, c.Machine, agentproto.HistoryAdopt, params, &res); err != nil {
		writeError(w, err)
		return
	}
	c.AuditField("adopted", res.Adopted)
	plugin.WriteJSON(w, http.StatusOK, res)
}
