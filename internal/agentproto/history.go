package agentproto

import (
	"regexp"
)

// The terminal history plugin's actions (internal/agent/plugin/history):
// snapshots of the terminals' output, with their styles, that a machine
// keeps in its data directory while the core asks it to capture, so that a
// page can show what a terminal held before its program was replaced by a
// new shell. A terminal's snapshot has a current generation and at most
// one previous one: the current one of the program that ran before.

// The plugin's actions.
const (
	// HistoryCapture snapshots the live terminals of the instance's
	// terminal core (HistoryCaptureParams, HistoryCaptureResult).
	HistoryCapture = "capture"
	// HistoryList lists the snapshots (HistoryListResult).
	HistoryList = "list"
	// HistoryRead returns one generation's bytes (HistoryReadParams,
	// HistoryData).
	HistoryRead = "read"
	// HistoryClear removes one terminal's snapshots or all of them
	// (HistoryClearParams, HistoryClearResult).
	HistoryClear = "clear"
	// HistoryAdopt gives a terminal that took the place of another one (a
	// new address for the same pane) the newest snapshot of the one it
	// replaced as its previous generation, and removes the replaced one's
	// snapshots (HistoryAdoptParams, HistoryAdoptResult).
	HistoryAdopt = "adopt"
)

// The generations of a terminal's snapshot (HistoryReadParams.Generation).
const (
	HistoryCurrent  = "current"
	HistoryPrevious = "previous"
)

// Hard limits of the snapshots. The machine clamps what the core asks for
// to them, whatever the core's settings say.
const (
	// History lines above the screen in one snapshot.
	HistoryMinLines, HistoryMaxLines = 100, 10000
	// Terminals with snapshots; one with two generations counts once.
	HistoryMinTerminals, HistoryMaxTerminals = 1, 128
	// Bytes all snapshots of a machine take.
	HistoryMinTotalBytes, HistoryMaxTotalBytes int64 = 1 << 20, 512 << 20
	// Days a snapshot is kept.
	HistoryMinDays, HistoryMaxDays = 1, 30
	// HistoryMaxBytes bounds one generation of one terminal.
	HistoryMaxBytes = 2 << 20
	// HistoryMaxErrors bounds HistoryCaptureResult.Errors.
	HistoryMaxErrors = 32
)

// HistoryCaptureParams are the core's settings for one machine's capture;
// the machine clamps each to its hard limit.
type HistoryCaptureParams struct {
	// Lines of history above the screen per snapshot.
	Lines int `json:"lines"`
	// MaxTerminals and MaxTotalBytes bound what the machine keeps: the
	// terminals captured longest ago go first.
	MaxTerminals  int   `json:"maxTerminals"`
	MaxTotalBytes int64 `json:"maxTotalBytes"`
	// Days a snapshot is kept.
	Days int `json:"days"`
}

// HistoryCaptureResult counts what one capture did, terminal by terminal:
// one terminal failing does not stop the others.
type HistoryCaptureResult struct {
	// Captured terminals got a new current snapshot; Skipped ones were
	// unchanged since their last snapshot, or ended meanwhile; Failed ones
	// could not be captured (Errors says why).
	Captured int `json:"captured"`
	Skipped  int `json:"skipped"`
	Failed   int `json:"failed"`
	// Evicted terminals lost their snapshots to make room (MaxTerminals,
	// MaxTotalBytes); Removed ones lost them because they were too old,
	// their terminal finished or is gone.
	Evicted int `json:"evicted"`
	Removed int `json:"removed"`
	// Bytes the snapshots take after the capture.
	Bytes int64 `json:"bytes"`
	// Busy: another capture of the same data directory was running (a
	// second core of the instance), and this one did nothing.
	Busy bool `json:"busy,omitempty"`
	// Errors are the codes of failed terminals by address (at most
	// HistoryMaxErrors): too_large, no_paint, incomplete, repainted (the
	// terminal core replaced the paint by one without history, also after
	// attaching again), probe, attach, limit, write, timeout (the capture's
	// time ran out before the terminal was reached or read).
	Errors map[string]string `json:"errors,omitempty"`
}

// HistorySnapshot describes one generation of a terminal's snapshot.
type HistorySnapshot struct {
	// PID is the terminal's program the snapshot is of.
	PID int `json:"pid"`
	// At is when it was taken, in milliseconds since the epoch (as the
	// terminal core's records' times).
	At int64 `json:"at"`
	// Lines is the most history lines above the screen it holds.
	Lines int `json:"lines"`
	// Bytes is the size of its data.
	Bytes int64 `json:"bytes"`
	// Cols and Rows are the terminal's grid when it was taken.
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

// HistoryEntry is one terminal's snapshots: the fields of the current
// generation (At 0 when it has only a previous one), and the previous
// one when there is one.
type HistoryEntry struct {
	Terminal string `json:"terminal"`
	HistorySnapshot
	// Restored: the current generation shows that the terminal core itself
	// restored the screen of the program before above this one (its
	// restore_screen), so a page does not show the previous generation
	// there again. The machine decides it from the captured bytes: the
	// terminal core's records do not keep why a kept terminal's program
	// was replaced.
	Restored bool             `json:"restored,omitempty"`
	Previous *HistorySnapshot `json:"previous,omitempty"`
}

// HistoryListResult is the result of HistoryList.
type HistoryListResult struct {
	Terminals []HistoryEntry `json:"terminals"`
	// RestoreScreen: the user's herdr-core configuration has
	// restore_screen = true, with which the terminal core itself shows a
	// replaced program's last screen above the new shell.
	RestoreScreen bool `json:"restoreScreen"`
}

// HistoryReadParams name one generation of one terminal's snapshot.
type HistoryReadParams struct {
	Terminal   string `json:"terminal"`
	Generation string `json:"generation"`
}

// HistoryData is one generation's bytes: the terminal's first paint as the
// terminal core sent it to an observer (history lines with their styles,
// then the screen), without titles and without what followed the paint.
type HistoryData struct {
	Terminal   string `json:"terminal"`
	Generation string `json:"generation"`
	HistorySnapshot
	Data []byte `json:"data"`
}

// HistoryClearParams name the terminal whose snapshots go; "" for all.
type HistoryClearParams struct {
	Terminal string `json:"terminal,omitempty"`
}

// HistoryClearResult counts the terminals whose snapshots were removed.
type HistoryClearResult struct {
	Removed int `json:"removed"`
}

// HistoryAdoptParams name the terminal whose snapshots go (From) and the
// terminal of the machine's terminal core that took its place (To); both
// are ValidHistoryTerminal addresses, and not the same.
type HistoryAdoptParams struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// HistoryAdoptResult tells whether To got From's newest generation as its
// previous one: false when From had no snapshot, or To has a previous
// generation captured later.
type HistoryAdoptResult struct {
	Adopted bool `json:"adopted"`
}

// ValidHistoryAdopt reports whether p names two terminals to adopt between.
func ValidHistoryAdopt(p HistoryAdoptParams) bool {
	return ValidHistoryTerminal(p.From) && ValidHistoryTerminal(p.To) && p.From != p.To
}

var historyTerminal = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

// ValidHistoryTerminal reports whether s can name a terminal's snapshot: a
// terminal core's address as the web UI takes one (isAddress in
// web/src/term/layout.ts), up to 64 letters, digits, dashes and
// underscores starting with a letter or digit. It has no dot, so it is no
// hidden or relative name and never ends with the suffix of a previous
// generation's files (".prev"). The machine takes addresses from its
// terminal core's records and checks them with this too.
func ValidHistoryTerminal(s string) bool { return historyTerminal.MatchString(s) }

// ValidHistoryGeneration reports whether s names a generation.
func ValidHistoryGeneration(s string) bool { return s == HistoryCurrent || s == HistoryPrevious }
