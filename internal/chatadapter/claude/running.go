//go:build unix

package claude

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"veldr/internal/agentkinds"
	"veldr/internal/chatadapter"
	"veldr/internal/chatproto"
)

// own are the programs this process started (by pid) that have not exited:
// their records of the sessions they run are the host's own, not a
// terminal's.
var own sync.Map

// ownProgram tells whether pid is a program this process started.
func ownProgram(pid int) bool {
	_, ok := own.Load(pid)
	return ok
}

// InTerminal tells that another Claude Code than the host's own runs the
// session (chatadapter.Running): one whose record (<claude dir>/sessions/
// <pid>.json) names it, of a process that runs and started when the record
// says.
func (Adapter) InTerminal(ctx context.Context, p chatadapter.HistoryParams) error {
	return inTerminal(ctx, p.Env, p.SessionID)
}

func inTerminal(ctx context.Context, env []string, id string) error {
	if !agentkinds.ValidSessionID(id) {
		return nil
	}
	if pid, ok := resolver(env).ClaudeRunning(ctx, id, ownProgram); ok {
		return &chatproto.Error{Code: chatproto.CodeInTerminal,
			Message: "claude: the session runs in another Claude Code (process " + strconv.Itoa(pid) + ")"}
	}
	return nil
}

// titleDelays are when after a turn's end the session's title is read
// from its transcript: Claude Code writes the title it makes of the
// conversation (ai-title) there, not on its output, and may write it after
// the turn.
var titleDelays = []time.Duration{0, 5 * time.Second}

// readTitle states the session's title its transcript has (the user's own,
// custom-title, before the one Claude Code made, ai-title) when it is
// another than the one stated last. It runs without the session's locks.
func (s *session) readTitle() {
	s.mu.Lock()
	gone := s.ended || s.closing
	s.mu.Unlock()
	if gone {
		return
	}
	f, err := resolver(s.p.Env).Locate(agentkinds.AdapterClaude, s.id)
	if err != nil {
		return
	}
	d, ok := describe(f.Path)
	title := strings.TrimSpace(d.agentTitle)
	if !ok || title == "" {
		return
	}
	s.mu.Lock()
	changed := title != s.title && !s.ended
	s.title = title
	s.mu.Unlock()
	if changed {
		s.sink.Update(func(c *chatproto.Chat) { c.Title = title })
	}
}

// titleSoon reads the session's title after a turn's end (titleDelays).
// mu held.
func (s *session) titleSoon() {
	for _, d := range titleDelays {
		time.AfterFunc(d, s.readTitle)
	}
}
