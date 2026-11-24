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
	SettingGUI     = "gui.enabled"
	SettingDisplay = "gui.display"
	SettingGPU     = "gui.gpu"
	SettingGPUPick = "gui.gpuPick"
	SettingVideo   = "gui.video"

	// DisplayAuto: the GPU display where the machine can run it.
	DisplayAuto = agentproto.GUIDisplayAuto
	DisplayXvfb = agentproto.GUIXvfb

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
			Key: SettingDisplay, Type: settings.TypeEnum, Default: DisplayAuto, Enum: []string{DisplayAuto, DisplayXvfb},
			Scope: settings.ScopeRemoteMachine, Section: "gui", Order: 15,
			Flag:  "gui-display",
			Usage: "the virtual display: auto (Xwayland drawing with a GPU where the machine has one and an Xwayland, so that OpenGL and Vulkan programs render on the GPU; Xvfb elsewhere) or xvfb (always Xvfb); a display changes kind while no program uses it; also per machine in the UI",
		},
		{
			Key: SettingGPU, Type: settings.TypeEnum, Default: GPUVglrun, Enum: []string{GPUVglrun, GPUAll},
			Scope: settings.ScopeRemoteMachine, Section: "gui", Order: 20,
			Flag:  "gui-gpu",
			Usage: "OpenGL on machines with VirtualGL: vglrun (programs started with vglrun render on the GPU) or all (every program in new panes runs under VirtualGL); also per machine in the UI",
		},
		{
			Key: SettingGPUPick, Type: settings.TypeBool, Default: false, Scope: settings.ScopeRemoteMachine, Section: "gui", Order: 25,
			Flag:  "gui-gpu-pick",
			Usage: "on machines with several NVIDIA GPUs, preload a library into the programs of new panes that leaves a program started with CUDA_VISIBLE_DEVICES only the GPUs it names (indices are rewritten to count among those), so that a Vulkan program can show its window from the chosen GPU instead of only from the driver's first one; true or false; also per machine in the UI",
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
	// PhaseElsewhere: another core shows the machine's windows; tried
	// again every elsewhereRetry.
	PhaseElsewhere = "elsewhere"
	// PhaseNotRunning: read-only mode, which only shows a display that runs.
	PhaseNotRunning = "not_running"
	// PhaseDisconnected: the machine is disabled, reconnecting, failing or
	// removed; a display there keeps running until idle, and the next
	// connection prepares it again.
	PhaseDisconnected = "disconnected"
)

// State is what browsers see for one machine.
type State struct {
	Machine string `json:"m"`
	Phase   string `json:"phase"`
	Error   string `json:"error,omitempty"`
	// GPU: VirtualGL works on the machine (vglrun renders on the GPU).
	GPU bool `json:"gpu,omitempty"`
	// Display is the kind of the display that is ready ("xvfb",
	// "xwayland").
	Display string `json:"display,omitempty"`
	// VulkanGPU is, on a machine with several NVIDIA GPUs, the one (as
	// nvidia-smi counts them) that windows of Vulkan programs come from;
	// Pick tells that new panes get the library that makes it the one a
	// program's CUDA_VISIBLE_DEVICES names.
	VulkanGPU *int                   `json:"vulkan_gpu,omitempty"`
	Pick      bool                   `json:"pick,omitempty"`
	Windows   []agentproto.GUIWindow `json:"windows"`
}
