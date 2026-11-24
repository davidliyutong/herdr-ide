//go:build unix

package agent

import (
	"context"
	"path"
	"slices"
	"time"

	"veldr/internal/agent/detect"
	"veldr/internal/agent/sessions"
	"veldr/internal/agentkinds"
)

// The session each agent uses (DetectEvent.Session), found while the core
// asks for it (Header.Sessions) and only for the agents whose transcripts
// are read (agentkinds.Kind.Transcript). Beside follow, with its
// lifetime, a goroutine asks the detector's sessions.Resolver once the
// agent's startup grace is over; while nothing is found it asks again after
// 1, 2, 4 and 8 s, then on every status change, whenever the files Resolve
// reads change (Stamp) and every 30 s; once a session is found it checks
// Stamp every 2 s (Claude Code: /clear rewrites the record of its process)
// or 5 s (Codex: a new rollout) and asks again only when the stamp, the
// process or its command line changed. Stamp and Resolve read files, /proc
// on Linux and the process table on macOS; they start no program.
//
// A change of the session is an event of its own with the agent's current
// status, and every event of the agent carries the session last found, so
// an event changes either the status or the session: the core tells a new
// session from news that way.

// sessionResolver finds the sessions of agents (*sessions.Resolver).
type sessionResolver interface {
	Resolve(ctx context.Context, kind string, p sessions.Proc) (sessions.Found, bool)
	Stamp(kind string, p sessions.Proc, last sessions.Found) string
}

// newResolver makes the resolver of a detect stream opened with
// Header.Sessions (tests replace it).
var newResolver = func(home string, peers func(kind, cwd string) int) sessionResolver {
	return &sessions.Resolver{Home: home, Peers: peers}
}

const (
	// sessionRetry is the wait after the first Resolve that finds nothing;
	// it doubles for each of sessionRetries tries.
	sessionRetry   = time.Second
	sessionRetries = 4
	// sessionRecheck: after those tries, an agent without a session is
	// resolved again this often (besides status and stamp changes).
	sessionRecheck = 30 * time.Second
	// sessionResolveTimeout bounds one Resolve.
	sessionResolveTimeout = 10 * time.Second
	// How often the stamp of an agent's session is checked.
	claudeStampPoll = 2 * time.Second
	codexStampPoll  = 5 * time.Second
)

// hasSessions reports whether the detector finds the sessions of kind's
// agents: those whose transcripts have a parser.
func hasSessions(kind string) bool {
	k, ok := agentkinds.ByID(kind)
	return ok && k.Transcript != ""
}

// stampPoll is how often the stamp of a kind's session is checked.
func stampPoll(kind string) time.Duration {
	if k, _ := agentkinds.ByID(kind); k.Transcript == "codex" {
		return codexStampPoll
	}
	return claudeStampPoll
}

// retryDelay is the wait after the fails-th Resolve in a row that found
// nothing: 1, 2, 4, 8 s, then sessionRecheck.
func retryDelay(fails int) time.Duration {
	if fails >= 1 && fails <= sessionRetries {
		return sessionRetry << (fails - 1)
	}
	return sessionRecheck
}

// followSession finds and follows the session of w's agent in terminal
// addr while tracker is the agent's (until ctx ends, which w.stop and the
// end of the stream do). wake receives the agent's status and process
// changes.
func (d *detector) followSession(ctx context.Context, addr string, w *watched, tracker *detect.Tracker, wake <-chan struct{}) {
	d.mu.Lock()
	kind := w.agent
	grace := tracker.GraceLeft(d.now())
	d.mu.Unlock()
	select {
	case <-ctx.Done():
		return
	case <-d.after(grace):
	}
	poll := stampPoll(kind)
	var (
		last  sessions.Found // the session of proc, as last found
		proc  sessions.Proc  // the process Resolve last ran for
		stamp string         // the stamp taken before that Resolve
		fails int            // Resolves in a row that found nothing
		due   time.Time      // when, while nothing is found, Resolve runs again
		force = true
	)
	for {
		p, ok := d.procOf(w, tracker)
		if !ok {
			return
		}
		if !sameProc(p, proc) {
			// Another process: its tries start over.
			force, fails = true, 0
		} else if last.ID == "" && !d.now().Before(due) {
			force = true
		}
		// The stamp is taken before Resolve reads: a change while it reads
		// shows in the next stamp.
		s := d.resolver.Stamp(kind, p, last)
		if s != stamp {
			force = true
		}
		if force {
			stamp = s
			found, ok := d.resolve(ctx, addr, kind, p)
			if ctx.Err() != nil {
				return
			}
			if ok {
				fails = 0
			} else {
				fails++
				due = d.now().Add(retryDelay(fails))
				if sameProc(p, proc) {
					// The same process keeps the session it was found to
					// have (its record may be being rewritten).
					found = last
				}
			}
			proc, last = p, found
			if !d.setSession(addr, w, tracker, found) {
				return
			}
			force = false
		}
		wait := poll
		if last.ID == "" {
			left := max(due.Sub(d.now()), 0)
			if fails <= sessionRetries {
				wait = left
			} else {
				wait = min(wait, left)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-wake:
			// While nothing is found, a status change may come with the
			// session (Codex makes it at the first prompt); otherwise the
			// process and the stamp are checked.
			force = last.ID == ""
		case <-d.after(wait):
		}
	}
}

// sameProc reports whether a and b are the same process with the same
// command line.
func sameProc(a, b sessions.Proc) bool {
	return a.PID == b.PID && slices.Equal(a.Argv, b.Argv)
}

// procOf is the foreground process of w's terminal, false once tracker's
// agent left it.
func (d *detector) procOf(w *watched, tracker *detect.Tracker) (sessions.Proc, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if w.tracker != tracker || !watchable(&w.rec) {
		return sessions.Proc{}, false
	}
	fg := w.rec.Foreground
	return sessions.Proc{PID: fg.PID, Argv: slices.Clone(fg.Argv), Cwd: fg.Cwd}, true
}

// setSession records the session found for tracker's agent in terminal
// addr and, when it changed, sends the agent's event with its current
// status; false once the agent left.
func (d *detector) setSession(addr string, w *watched, tracker *detect.Tracker, found sessions.Found) bool {
	d.mu.Lock()
	if w.tracker != tracker {
		d.mu.Unlock()
		return false
	}
	if w.session != found {
		w.session = found
		d.emitLocked(w.eventLocked(addr, tracker.Status()))
	}
	d.mu.Unlock()
	d.flush()
	return true
}

// resolve runs Resolve for the agent of kind in terminal addr, one at a
// time and within sessionResolveTimeout. A session that is not a session id
// with a source counts as none.
func (d *detector) resolve(ctx context.Context, addr, kind string, p sessions.Proc) (sessions.Found, bool) {
	d.resolveMu.Lock()
	defer d.resolveMu.Unlock()
	d.resolving = addr
	defer func() { d.resolving = "" }()
	ctx, cancel := context.WithTimeout(ctx, sessionResolveTimeout)
	defer cancel()
	found, ok := d.resolver.Resolve(ctx, kind, p)
	if !ok || !agentkinds.ValidSessionID(found.ID) || found.Source == "" {
		return sessions.Found{}, false
	}
	return found, true
}

// peers is the resolver's Peers: how many other terminals than the one
// resolved for run an agent of kind in directory cwd. Resolve calls it
// from the goroutine that holds d.resolveMu, which keeps d.resolving.
func (d *detector) peers(kind, cwd string) int {
	self := d.resolving
	d.mu.Lock()
	defer d.mu.Unlock()
	n := 0
	for addr, w := range d.terms {
		if addr == self || w.agent != kind || !watchable(&w.rec) {
			continue
		}
		if c := w.rec.Foreground.Cwd; c != "" && cwd != "" && path.Clean(c) == path.Clean(cwd) {
			n++
		}
	}
	return n
}
