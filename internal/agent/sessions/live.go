//go:build unix

package sessions

import (
	"context"
	"path"
	"strconv"
	"strings"

	"herdr-ide/internal/agentkinds"
)

// ClaudeRunning is a running process of Claude Code that has session id
// open, as its record tells (<claude dir>/sessions/<pid>.json in one of
// the user's configuration directories, ClaudeDirs): a record of the
// user's own, of a process that runs and started when the record says
// (readRecord), that names id. skip passes over processes the caller knows
// (its own children). It reports the process's id; false when none is
// found.
func (r *Resolver) ClaudeRunning(ctx context.Context, id string, skip func(pid int) bool) (int, bool) {
	if !agentkinds.ValidSessionID(id) {
		return 0, false
	}
	n := 0
	for _, d := range r.ClaudeDirs() {
		sdir := path.Join(d, "sessions")
		for _, e := range readDir(sdir, maxEntries) {
			stem, ok := strings.CutSuffix(e.Name(), ".json")
			if !ok || !e.Type().IsRegular() {
				continue
			}
			pid, err := strconv.Atoi(stem)
			if err != nil || pid <= 0 || strconv.Itoa(pid) != stem || (skip != nil && skip(pid)) {
				continue
			}
			if n >= maxClaims || ctx.Err() != nil {
				return 0, false
			}
			n++
			if _, alive := r.startOf(pid); !alive {
				continue
			}
			if got, ok := r.readRecord(path.Join(sdir, e.Name()), pid); ok && got == id {
				return pid, true
			}
		}
	}
	return 0, false
}
