// Package gui shows windows of programs running on machines in the
// browser: it prepares each remote machine's virtual display through the
// agent, keeps the list of windows, and routes frames and input between the
// agent and the browser windows viewing them (see
// docs/features/14-gui-windows.md).
package gui

import (
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/settings"
)

// Settings.
const (
	SettingGUI   = "gui.enabled"
	SettingGPU   = "gui.gpu"
	SettingVideo = "gui.video"

	GPUVglrun = "vglrun"
	GPUAll    = "all"
)

// onOff reads the on/off values of earlier versions.
func onOff(v any) (any, bool) {
	switch v {
	case "on":
		return true, true
	case "off":
		return false, true
	}
	return nil, false
}

// Settings are the GUI settings that can be changed at runtime, also per
// remote machine, with the flags and file keys of earlier versions.
var Settings = settings.Module{
	Sections: []settings.Section{{ID: "gui", Order: 70, Advanced: true}},
	Defs: []settings.Def{
		{
			Key: SettingGUI, Type: settings.TypeBool, Default: true, Scope: settings.ScopeRemoteMachine, Section: "gui", Order: 10,
			Flag:  "gui",
			Usage: "show windows of programs on remote Linux machines: new panes get a virtual display (DISPLAY), Xvfb is fetched in user space when missing; true or false (on or off); also per machine in the UI",
		},
		{
			Key: SettingGPU, Type: settings.TypeEnum, Default: GPUVglrun, Enum: []string{GPUVglrun, GPUAll},
			Scope: settings.ScopeRemoteMachine, Section: "gui", Order: 20,
			Flag:  "gui-gpu",
			Usage: "OpenGL on machines with VirtualGL: vglrun (programs started with vglrun render on the GPU) or all (every program in new panes runs under VirtualGL); also per machine in the UI",
		},
		{
			Key: SettingVideo, Type: settings.TypeBool, Default: true, Scope: settings.ScopeRemoteMachine, Section: "gui", Order: 30,
			Flag:  "gui-video",
			Usage: "send program windows that keep changing as video (H.264 on NVIDIA, Intel or AMD GPUs, else VP8 on the CPU) to browsers that decode it, encoded on the machine by the encoder the core brings; pictures otherwise (false: always pictures); also per machine in the UI",
		},
	},
	Migrations: []settings.Migration{
		{From: "gui", To: SettingGUI, Convert: onOff},
		{From: "gui-gpu", To: SettingGPU, Convert: settings.Renamed},
		{From: "gui-video", To: SettingVideo, Convert: onOff},
	},
}

// Phases of a machine's display; the UI translates them.
const (
	PhaseOff         = "off"
	PhaseLocal       = "local" // windows open on the user's own screen
	PhaseUnsupported = "unsupported"
	PhaseUnavailable = "unavailable" // no Xvfb and none can be fetched
	PhaseInstalling  = "installing"
	PhaseStarting    = "starting"
	PhaseReady       = "ready"
	PhaseError       = "error"
	// PhaseNotRunning: read-only mode, which only shows a display that runs.
	PhaseNotRunning = "not_running"
	// PhaseDisconnected: the machine is disabled, reconnecting, failing or
	// removed; a display there keeps running until idle, and the next
	// connection prepares it again.
	PhaseDisconnected = "disconnected"
)

// State is what browsers see for one machine.
type State struct {
	Machine string                 `json:"m"`
	Phase   string                 `json:"phase"`
	Error   string                 `json:"error,omitempty"`
	GPU     bool                   `json:"gpu,omitempty"`
	Windows []agentproto.GUIWindow `json:"windows"`
}
