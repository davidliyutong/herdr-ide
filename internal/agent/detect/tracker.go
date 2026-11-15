package detect

import "time"

// Timing of the state machine, herdr's (src/pane/agent_detection.rs).
const (
	// StartupGrace: after an agent appears, its screen is still the shell's
	// or its splash, so it is not read.
	StartupGrace = 3 * time.Second
	// A change from working to idle without visible idle chrome is held
	// until IdleConfirmations more reads (IdleRecheck apart) agree, or for
	// at most IdleCap: a spinner between two frames reads as idle.
	IdleRecheck       = 100 * time.Millisecond
	IdleConfirmations = 3
	IdleCap           = 700 * time.Millisecond
	// Poll is how often a terminal with new output is read.
	Poll = 300 * time.Millisecond
)

// Tracker follows the state of one agent in one terminal and tells which
// status to report: working, blocked, idle, done (a turn that ended:
// working or blocked became idle) or unknown (just started, or a screen
// the manifest knows nothing about). Use it from one goroutine.
type Tracker struct {
	manifest *Manifest
	// state is the last state accepted (idle, working, blocked, unknown);
	// status what was reported.
	state, status string
	graceUntil    time.Time
	// pendingSince is when a working → idle change was first seen.
	pendingSince time.Time
	confirmed    int
	// reported: the program reports its own status (OSC 7501), which
	// takes precedence over the screen.
	reported bool
}

// NewTracker starts following an agent that appeared at now; m is its
// manifest, nil when there is none (its status stays unknown unless the
// program reports one).
func NewTracker(m *Manifest, now time.Time) *Tracker {
	return &Tracker{manifest: m, state: Unknown, status: Unknown, graceUntil: now.Add(StartupGrace)}
}

// Status is the status last reported.
func (t *Tracker) Status() string { return t.status }

// Pending reports whether a working → idle change waits for confirmation,
// so the screen is read again after IdleRecheck without new output.
func (t *Tracker) Pending() bool { return !t.pendingSince.IsZero() }

// InGrace reports whether the screen is not read yet.
func (t *Tracker) InGrace(now time.Time) bool { return now.Before(t.graceUntil) }

// GraceLeft is how long the startup grace lasts from now.
func (t *Tracker) GraceLeft(now time.Time) time.Duration { return max(t.graceUntil.Sub(now), 0) }

// SelfReported reports whether the program's own status is in effect.
func (t *Tracker) SelfReported() bool { return t.reported }

// accept moves to state and returns the status to report, and whether it
// changed.
func (t *Tracker) accept(state string) (string, bool) {
	prev := t.state
	t.state = state
	status := state
	if state == Idle && (prev == Working || prev == Blocked) {
		status = Done
	} else if state == Idle && t.status == Done {
		status = Done // still the turn that ended
	}
	if status == t.status {
		return status, false
	}
	t.status = status
	return status, true
}

// Report applies the status the program reported itself through herdr-core
// (OSC 7501: idle, working, blocked, done or error; "" when it cleared
// it). While one is in effect the screen is not read; it changes at once,
// without the confirmation the screen needs.
func (t *Tracker) Report(state string) (string, bool) {
	t.pendingSince, t.confirmed = time.Time{}, 0
	switch state {
	case "":
		t.reported = false
		return t.status, false
	case Done:
		t.reported = true
		if t.state == Idle && t.status == Done {
			return t.status, false
		}
		// The program says its turn ended.
		t.state = Working
		return t.accept(Idle)
	case "error":
		t.reported = true
		return t.accept(Blocked)
	case Idle, Working, Blocked:
		t.reported = true
		return t.accept(state)
	}
	t.reported = true
	return t.accept(Unknown)
}

// Observe evaluates a read of the screen at now and returns the status to
// report and whether it changed.
func (t *Tracker) Observe(now time.Time, in Input) (string, bool) {
	if t.reported || t.manifest == nil || t.InGrace(now) {
		return t.status, false
	}
	r := t.manifest.Evaluate(in)
	if r.Skip {
		t.pendingSince, t.confirmed = time.Time{}, 0
		return t.status, false
	}
	if t.state == Working && r.State == Idle && !r.VisibleIdle && !r.VisibleBlocker {
		switch {
		case t.pendingSince.IsZero():
			t.pendingSince, t.confirmed = now, 0
			return t.status, false
		case now.Sub(t.pendingSince) < IdleCap:
			if t.confirmed++; t.confirmed < IdleConfirmations {
				return t.status, false
			}
		}
	}
	t.pendingSince, t.confirmed = time.Time{}, 0
	return t.accept(r.State)
}

// Exit is what to report when the agent leaves the terminal's foreground:
// a turn it was in the middle of ended (done), else nothing.
func (t *Tracker) Exit() (string, bool) {
	if t.state == Working || t.state == Blocked {
		return t.accept(Idle)
	}
	return t.status, false
}
