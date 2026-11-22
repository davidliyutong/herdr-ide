//go:build unix

package sessions

import (
	"context"
	"testing"
	"time"
)

// ClaudeRunning finds the running process whose record names a session:
// not one that is gone, not one whose start is not the record's (its pid
// reused), not one the caller skips.
func TestClaudeRunning(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	start := e.now.Add(-time.Hour)
	e.record("", 100, sid(1), "/w", start)
	e.record("", 200, sid(2), "/w", start)
	e.record("", 300, sid(3), "/w", start)
	e.procs[100] = fakeProc{start: start}
	e.procs[200] = fakeProc{start: start.Add(10 * time.Minute)} // another process of the pid
	// 300 is gone.
	if pid, ok := e.r.ClaudeRunning(ctx, sid(1), nil); !ok || pid != 100 {
		t.Errorf("a running session: %d %v", pid, ok)
	}
	for _, id := range []string{sid(2), sid(3), sid(4), "../x"} {
		if pid, ok := e.r.ClaudeRunning(ctx, id, nil); ok {
			t.Errorf("%s runs in %d", id, pid)
		}
	}
	if _, ok := e.r.ClaudeRunning(ctx, sid(1), func(pid int) bool { return pid == 100 }); ok {
		t.Error("a skipped process counts")
	}
}
