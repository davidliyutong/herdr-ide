// Package monitor is the core's side of the System Monitor & Task Manager
// plugin (docs/features/34-system-monitor.md): routes below
// /api/m/{id}/p/monitor/ that forward live metrics, process snapshots, and
// audited process signals to the machine side (internal/agent/plugin/monitor).
package monitor

import (
	"net/http"
	"strings"
	"time"

	"herdr-ide/internal/plugin"
)

const (
	// ID names the plugin on every side.
	ID = "monitor"

	readTimeout    = 10 * time.Second
	processTimeout = 15 * time.Second
	signalTimeout  = 10 * time.Second
	maxSignalBody  = 4 << 10
)

// Plugin is the System Monitor & Task Manager plugin.
type Plugin struct{}

// New returns the plugin.
func New() Plugin { return Plugin{} }

func (Plugin) ID() string { return ID }

func (Plugin) Routes() []plugin.Route {
	return []plugin.Route{
		{Method: http.MethodGet, Path: "metrics", Machine: true, Handler: handleMetrics},
		{Method: http.MethodGet, Path: "processes", Machine: true, Handler: handleProcesses},
		{Method: http.MethodPost, Path: "signal", Machine: true, Mutating: true, Audit: "signal", Handler: handleSignal},
	}
}

func handleMetrics(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	plugin.ForwardJSON(c, w, r, ID, "metrics", nil, readTimeout)
}

func handleProcesses(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	plugin.ForwardJSON(c, w, r, ID, "processes", nil, processTimeout)
}

type signalReq struct {
	PID    int    `json:"pid"`
	Signal string `json:"signal"`
}

func handleSignal(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	var req signalReq
	if err := plugin.ReadJSON(r, maxSignalBody, &req); err != nil {
		plugin.WriteError(w, err)
		return
	}
	req.Signal = strings.ToUpper(strings.TrimSpace(req.Signal))
	if req.Signal == "" {
		req.Signal = "TERM"
	}
	c.AuditField("pid", req.PID)
	c.AuditField("signal", req.Signal)
	if req.PID <= 1 {
		plugin.WriteError(w, &plugin.Error{Code: "invalid_pid", Message: "invalid pid"})
		return
	}
	plugin.ForwardJSON(c, w, r, ID, "signal", req, signalTimeout)
}
