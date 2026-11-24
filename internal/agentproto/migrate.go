package agentproto

import "encoding/json"

// The migrate plugin (internal/plugins/migrate, internal/agent/plugin/migrate):
// a namespace of a previous product name on a machine (brand.LegacySlugs),
// whose terminals, layout and files the user moves into this one at their
// own pace, while the previous version may still run.

// MigrateStatus is what a machine has of a previous name's namespace.
type MigrateStatus struct {
	// Slug is the previous name; "" when the machine has no namespace of one.
	Slug string `json:"slug,omitempty"`
	// Dir is its data directory (~/.<slug>[-<instance>]).
	Dir string `json:"dir,omitempty"`
	// Running: its terminal core answers; Version is that core's.
	Running bool   `json:"running,omitempty"`
	Version string `json:"version,omitempty"`
	// Node: a node of the previous version answers, so one of its UIs is
	// connected to the machine.
	Node bool `json:"node,omitempty"`
	// Terminals counts its live terminals (the product's own left out).
	Terminals int `json:"terminals"`
}

// MigrateScan is the previous namespace's layout and terminals.
type MigrateScan struct {
	MigrateStatus
	// Layout is its layout document as its clients wrote it (null for
	// none), at LayoutVersion.
	Layout        json.RawMessage   `json:"layout"`
	LayoutVersion int64             `json:"layout_version"`
	Terminals     []MigrateTerminal `json:"terminal_list"`
}

// MigrateTerminal is a live terminal of the previous namespace.
type MigrateTerminal struct {
	Address string `json:"address"`
	// Cwd is its foreground program's directory, else the terminal's.
	Cwd string `json:"cwd,omitempty"`
	// Program is the foreground program's name when it is not the
	// terminal's own program (its shell): what ends when the terminal is
	// moved.
	Program string `json:"program,omitempty"`
	// Agent is the coding agent kind the foreground program is
	// (agentkinds), and Session the session it runs when the machine
	// found it from the process (never a guess).
	Agent   string `json:"agent,omitempty"`
	Session string `json:"session,omitempty"`
	Title   string `json:"title,omitempty"`
}

// MigrateRelease gives terminals and the layout's parts that were moved
// up: the layout written at the version it was read (else code conflict,
// and nothing changes), then the terminals ended.
type MigrateRelease struct {
	Layout    json.RawMessage `json:"layout"`
	Version   int64           `json:"version"`
	Terminals []string        `json:"terminals"`
}

// Actions of the migrate plugin.
const (
	MigrateActionStatus  = "status"
	MigrateActionScan    = "scan"
	MigrateActionRelease = "release"
	MigrateActionStop    = "stop"
	MigrateActionRemove  = "remove"
)

// MaxMigrateLayout bounds the layout document a release writes.
const MaxMigrateLayout = 4 << 20
