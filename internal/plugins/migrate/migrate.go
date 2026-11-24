// Package migrate is the core's side of the migrate plugin: a namespace a
// previous product name left on a machine (brand.LegacySlugs), whose
// terminal core may still run its terminals, and what the UI moves from it
// into this namespace (internal/agent/plugin/migrate,
// docs/features/11-naming-and-renames.md). Routes, a machine's:
//
//   - GET  /api/m/{id}/p/migrate/status: agentproto.MigrateStatus.
//   - GET  /api/m/{id}/p/migrate/scan: agentproto.MigrateScan, the previous
//     layout and its live terminals.
//   - POST /api/m/{id}/p/migrate/release (agentproto.MigrateRelease): writes
//     the previous layout without what the UI moved and ends the moved
//     terminals; 409 conflict when the layout changed since it was read.
//   - POST /api/m/{id}/p/migrate/stop: stops the previous terminal core.
//   - POST /api/m/{id}/p/migrate/remove: removes the previous namespace's
//     files once nothing of it runs.
//
// The reads are allowed read-only; the others are refused read-only and
// audited as migrate.<action>.
package migrate

import (
	"context"
	"errors"
	"net/http"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
)

// ID names the plugin on every side.
const ID = "migrate"

// timeout bounds a machine's answer.
const timeout = 60 * time.Second

// Plugin is the migrate plugin.
type Plugin struct {
	// call runs an action of a machine's agent; tests replace it.
	call func(ctx context.Context, mc *machines.Machine, action string, params, out any) error
}

// New returns the plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) ID() string { return ID }

// Routes of the plugin.
func (p *Plugin) Routes() []plugin.Route {
	return []plugin.Route{
		{Method: http.MethodGet, Path: "status", Machine: true, Handler: p.get(agentproto.MigrateActionStatus, func() any { return &agentproto.MigrateStatus{} })},
		{Method: http.MethodGet, Path: "scan", Machine: true, Handler: p.get(agentproto.MigrateActionScan, func() any { return &agentproto.MigrateScan{} })},
		{Method: http.MethodPost, Path: "release", Machine: true, Mutating: true, Audit: "release", Handler: p.postRelease},
		{Method: http.MethodPost, Path: "stop", Machine: true, Mutating: true, Audit: "stop", Handler: p.post(agentproto.MigrateActionStop)},
		{Method: http.MethodPost, Path: "remove", Machine: true, Mutating: true, Audit: "remove", Handler: p.post(agentproto.MigrateActionRemove)},
	}
}

// request runs an action of mc's agent and decodes its result into out.
func (p *Plugin) request(ctx context.Context, mc *machines.Machine, action string, params, out any) error {
	if mc == nil {
		return plugin.ErrOffline
	}
	if p.call != nil {
		return p.call(ctx, mc, action, params, out)
	}
	return plugin.Request(ctx, mc, ID, action, params, out)
}

func writeError(w http.ResponseWriter, err error) {
	var pe *plugin.Error
	switch {
	case errors.As(err, &pe) && pe.Code == "conflict":
		plugin.WriteJSON(w, http.StatusConflict, map[string]string{"error": pe.Code, "message": pe.Message})
	case errors.As(err, &pe):
		plugin.WriteError(w, err)
	case errors.Is(err, context.DeadlineExceeded):
		plugin.WriteJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "timeout", "message": "the machine did not answer in time"})
	default:
		plugin.WriteJSON(w, http.StatusBadGateway, map[string]string{"error": "bad_reply", "message": "the machine's answer was not understood"})
	}
}

func (p *Plugin) get(action string, out func() any) func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	return func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		res := out()
		if err := p.request(ctx, c.Machine, action, nil, res); err != nil {
			writeError(w, err)
			return
		}
		plugin.WriteJSON(w, http.StatusOK, res)
	}
}

func (p *Plugin) post(action string) func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	return func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		if err := p.request(ctx, c.Machine, action, nil, nil); err != nil {
			writeError(w, err)
			return
		}
		plugin.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func (p *Plugin) postRelease(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	var req agentproto.MigrateRelease
	if err := plugin.ReadJSON(r, agentproto.MaxMigrateLayout+64<<10, &req); err != nil {
		plugin.WriteError(w, err)
		return
	}
	if len(req.Layout) == 0 || len(req.Layout) > agentproto.MaxMigrateLayout || len(req.Terminals) > 4096 {
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "layout: the previous layout; terminals: their addresses"})
		return
	}
	c.AuditField("terminals", req.Terminals)
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	if err := p.request(ctx, c.Machine, agentproto.MigrateActionRelease, req, nil); err != nil {
		writeError(w, err)
		return
	}
	plugin.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
